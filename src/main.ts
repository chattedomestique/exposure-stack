import './style.css'
import type { MergeOptions } from './merge.worker.ts'

// Cap the working resolution so the Laplacian-pyramid fusion stays within the
// memory budget on phones (iOS Safari is especially tight). 2560px on the long
// edge yields a crisp, shareable image while keeping memory predictable.
const MAX_EDGE = 2560

const SLOT_META = [
  { key: 'under', label: 'Underexposed', hint: 'darkest — holds highlights' },
  { key: 'mid', label: 'Standard', hint: 'metered / neutral' },
  { key: 'over', label: 'Overexposed', hint: 'brightest — opens shadows' },
] as const

interface Slot {
  file: File | null
  url: string | null
}

const slots: Slot[] = SLOT_META.map(() => ({ file: null, url: null }))

// ---------- element lookup ----------
const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel)
  if (!el) throw new Error(`Missing element: ${sel}`)
  return el
}

const slotsEl = $<HTMLElement>('#slots')
const statusEl = $<HTMLParagraphElement>('#status')
const mergeBtn = $<HTMLButtonElement>('#merge')
const resetBtn = $<HTMLButtonElement>('#reset')
const resultEl = $<HTMLElement>('#result')
const outputCanvas = $<HTMLCanvasElement>('#output')
const pickBtn = $<HTMLButtonElement>('#pick')
const saveBtn = $<HTMLButtonElement>('#save')
const downloadBtn = $<HTMLButtonElement>('#download')
const downloadJpgBtn = $<HTMLButtonElement>('#download-jpg')
const alignEl = $<HTMLInputElement>('#align')
const wContrast = $<HTMLInputElement>('#w-contrast')
const wSaturation = $<HTMLInputElement>('#w-saturation')
const wExposure = $<HTMLInputElement>('#w-exposure')

let busy = false

// ---------- status helpers ----------
type StatusKind = 'idle' | 'working' | 'error' | 'done'
function setStatus(message: string, kind: StatusKind = 'idle') {
  statusEl.textContent = message
  statusEl.className = 'status' + (kind === 'idle' ? '' : ` ${kind}`)
}

// ---------- slot rendering ----------
function renderSlots() {
  slotsEl.innerHTML = ''
  SLOT_META.forEach((meta, i) => {
    const slot = slots[i]
    const card = document.createElement('div')
    card.className = 'slot' + (slot.url ? ' filled' : '')
    card.dataset.index = String(i)
    card.setAttribute('role', 'button')
    card.setAttribute('tabindex', '0')
    card.setAttribute('aria-label', `${meta.label} exposure`)

    if (slot.url) {
      card.innerHTML = `
        <span class="badge">${meta.label}</span>
        <button class="remove" aria-label="Remove ${meta.label} exposure" title="Remove">×</button>
        <img src="${slot.url}" alt="${meta.label} exposure preview" />
      `
    } else {
      card.innerHTML = `
        <div class="placeholder">
          <div class="ph-icon">＋</div>
          <div class="ph-label">${meta.label}</div>
          <div class="ph-hint">${meta.hint}</div>
        </div>
      `
    }
    slotsEl.appendChild(card)
  })
  updateMergeState()
  updateCountHint()
}

function updateMergeState() {
  mergeBtn.disabled = !(slots.every((s) => s.file) && !busy)
}

// Status hint reflecting how many slots are filled. Called only on slot changes
// so it never overwrites a merge's progress/done/error message.
function updateCountHint() {
  if (busy) return
  const count = slots.filter((s) => s.file).length
  if (count === 0) setStatus('Add three bracketed exposures to begin.')
  else if (count < 3) setStatus(`${count} of 3 exposures added.`)
  else setStatus('Ready to merge.', 'done')
}

// ---------- file handling ----------
// iOS often reports an empty MIME type for HEIC, so accept empty types and known
// image extensions too, and let the decoder be the final arbiter.
function isProbablyImage(file: File): boolean {
  return (
    file.type.startsWith('image/') ||
    file.type === '' ||
    /\.(jpe?g|png|hei[cf]|webp|gif|tiff?|bmp|avif)$/i.test(file.name)
  )
}

// Assign a file to a slot without re-rendering (caller renders once).
function setSlot(index: number, file: File) {
  const slot = slots[index]
  if (slot.url) URL.revokeObjectURL(slot.url)
  slot.file = file
  slot.url = URL.createObjectURL(file)
}

function acceptFile(index: number, file: File) {
  if (!isProbablyImage(file)) {
    setStatus('That file is not an image.', 'error')
    return
  }
  setSlot(index, file)
  renderSlots()
}

// Add a batch of picked photos. When exactly three are chosen we auto-order them
// darkest -> brightest so the under/standard/over slots are filled correctly
// without the user sorting by hand. Fewer than three fill the empty slots in
// order. This is the primary iOS flow: one picker, one tap, done.
async function addPhotos(fileList: FileList | File[]) {
  const picked = Array.from(fileList).filter(isProbablyImage)
  if (picked.length === 0) {
    setStatus('No images found in that selection.', 'error')
    return
  }

  if (picked.length >= 3) {
    const three = picked.slice(0, 3)
    setStatus('Sorting by exposure…', 'working')
    try {
      const scored = await Promise.all(
        three.map(async (file) => ({ file, b: await meanBrightness(file) })),
      )
      scored.sort((a, b) => a.b - b.b) // darkest first
      scored.forEach((s, i) => setSlot(i, s.file))
    } catch {
      // If probing fails, fall back to selection order.
      three.forEach((file, i) => setSlot(i, file))
    }
    renderSlots()
    if (picked.length > 3) {
      setStatus('Used the first 3 photos, sorted darkest → brightest.', 'done')
    } else {
      setStatus('Sorted darkest → brightest. Ready to merge.', 'done')
    }
    return
  }

  // 1–2 photos: fill empty slots in order.
  for (const file of picked) {
    const idx = slots.findIndex((s) => !s.file)
    if (idx === -1) break
    setSlot(idx, file)
  }
  renderSlots()
}

function removeSlot(index: number) {
  const slot = slots[index]
  if (slot.url) URL.revokeObjectURL(slot.url)
  slot.file = null
  slot.url = null
  renderSlots()
}

function pickFile(index: number) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = () => {
    if (input.files && input.files[0]) acceptFile(index, input.files[0])
  }
  input.click()
}

// Multi-select picker — the primary flow. On iOS this opens the Photos sheet
// once and lets the user select all three brackets together.
function pickPhotos() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  input.onchange = () => {
    if (input.files && input.files.length) void addPhotos(input.files)
  }
  input.click()
}

// Delegated events on the slot container.
slotsEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement
  const card = target.closest('.slot') as HTMLElement | null
  if (!card) return
  const index = Number(card.dataset.index)
  if (target.classList.contains('remove')) {
    e.stopPropagation()
    removeSlot(index)
    return
  }
  if (!slots[index].file) pickFile(index)
})

slotsEl.addEventListener('keydown', (e) => {
  const card = (e.target as HTMLElement).closest('.slot') as HTMLElement | null
  if (!card) return
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    const index = Number(card.dataset.index)
    if (!slots[index].file) pickFile(index)
  }
})

// Drag & drop per card.
slotsEl.addEventListener('dragover', (e) => {
  const card = (e.target as HTMLElement).closest('.slot') as HTMLElement | null
  if (!card) return
  e.preventDefault()
  card.classList.add('dragover')
})
slotsEl.addEventListener('dragleave', (e) => {
  const card = (e.target as HTMLElement).closest('.slot') as HTMLElement | null
  card?.classList.remove('dragover')
})
slotsEl.addEventListener('drop', (e) => {
  const card = (e.target as HTMLElement).closest('.slot') as HTMLElement | null
  if (!card) return
  e.preventDefault()
  card.classList.remove('dragover')
  const index = Number(card.dataset.index)
  const file = e.dataTransfer?.files?.[0]
  if (file) acceptFile(index, file)
})

// ---------- decoding (orientation-correct + downscale, HEIC-safe) ----------
interface Decoded {
  src: CanvasImageSource
  w: number
  h: number
  close(): void
}

// Decode a File to something we can draw. Tries createImageBitmap first (fast,
// off-DOM), and falls back to an <img> element for formats it can't handle —
// notably HEIC/HEIF from iPhones, which Safari can render via <img> but not
// always via createImageBitmap.
async function decodeSource(file: File): Promise<Decoded> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    return { src: bitmap, w: bitmap.width, h: bitmap.height, close: () => bitmap.close() }
  } catch {
    const url = URL.createObjectURL(file)
    try {
      const img = new Image()
      img.decoding = 'async'
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () =>
          reject(new Error('Unsupported or corrupt image (try JPEG/PNG).'))
        img.src = url
      })
      // decode() ensures pixels are ready before we draw (Safari quirk).
      if (img.decode) await img.decode().catch(() => {})
      return {
        src: img,
        w: img.naturalWidth,
        h: img.naturalHeight,
        close: () => URL.revokeObjectURL(url),
      }
    } catch (err) {
      URL.revokeObjectURL(url)
      throw err
    }
  }
}

function drawScaled(dec: Decoded, maxEdge: number): ImageData {
  const scale = Math.min(1, maxEdge / Math.max(dec.w, dec.h))
  const w = Math.max(1, Math.round(dec.w * scale))
  const h = Math.max(1, Math.round(dec.h * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not get a 2D drawing context.')
  ctx.drawImage(dec.src, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h)
}

async function decodeToImageData(file: File): Promise<ImageData> {
  const dec = await decodeSource(file)
  try {
    return drawScaled(dec, MAX_EDGE)
  } finally {
    dec.close()
  }
}

// Cheap mean-luminance probe (tiny decode) used to auto-order a batch of picks
// from darkest to brightest.
async function meanBrightness(file: File): Promise<number> {
  const dec = await decodeSource(file)
  try {
    const data = drawScaled(dec, 32).data
    let sum = 0
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    }
    return sum / (data.length / 4)
  } finally {
    dec.close()
  }
}

// ---------- worker plumbing ----------
let worker: Worker | null = null

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./merge.worker.ts', import.meta.url), { type: 'module' })
  return worker
}

function runMerge(images: ImageData[], options: MergeOptions): Promise<ImageData> {
  const w = getWorker()
  return new Promise<ImageData>((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      const msg = e.data
      if (msg?.type === 'progress') {
        setStatus(msg.message, 'working')
      } else if (msg?.type === 'result') {
        w.removeEventListener('message', onMsg)
        resolve(msg.image as ImageData)
      } else if (msg?.type === 'error') {
        w.removeEventListener('message', onMsg)
        reject(new Error(msg.message))
      }
    }
    w.addEventListener('message', onMsg)
    // Transfer the pixel buffers so the main thread hands off ownership.
    w.postMessage({ type: 'merge', images, options }, images.map((i) => i.data.buffer))
  })
}

// ---------- merge flow ----------
async function doMerge() {
  if (busy || !slots.every((s) => s.file)) return
  busy = true
  updateMergeState()
  mergeBtn.disabled = true
  document.body.classList.add('busy')

  try {
    setStatus('Decoding photos…', 'working')
    const images = await Promise.all(slots.map((s) => decodeToImageData(s.file as File)))

    const options: MergeOptions = {
      align: alignEl.checked,
      contrast: Number(wContrast.value),
      saturation: Number(wSaturation.value),
      exposure: Number(wExposure.value),
    }

    const result = await runMerge(images, options)

    outputCanvas.width = result.width
    outputCanvas.height = result.height
    const ctx = outputCanvas.getContext('2d')
    if (!ctx) throw new Error('Could not draw the merged result.')
    ctx.putImageData(result, 0, 0)

    resultEl.hidden = false
    setStatus(`Done — merged at ${result.width}×${result.height}.`, 'done')
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  } catch (err) {
    console.error(err)
    setStatus(
      `Merge failed: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    )
  } finally {
    busy = false
    document.body.classList.remove('busy')
    updateMergeState()
  }
}

// ---------- save / download ----------
function canvasToBlob(type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    outputCanvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image.'))),
      type,
      quality,
    )
  })
}

// Save/share the result. On iOS/Android the Web Share API opens the native share
// sheet ("Save Image to Photos"), which is the only reliable way to save on iOS
// Safari — an <a download> just opens the image in a new tab there.
async function saveResult() {
  try {
    const blob = await canvasToBlob('image/png')
    const file = new File([blob], 'exposure-stack.png', { type: 'image/png' })
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Exposure Stack' })
      return
    }
    triggerDownload(blob, 'png')
  } catch (err) {
    // AbortError = user dismissed the share sheet; not an error worth showing.
    if (err instanceof Error && err.name === 'AbortError') return
    setStatus(`Could not save: ${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

function triggerDownload(blob: Blob, ext: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `exposure-stack.${ext}`
  a.rel = 'noopener'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function download(type: 'image/png' | 'image/jpeg') {
  const ext = type === 'image/png' ? 'png' : 'jpg'
  const blob = await canvasToBlob(type, type === 'image/jpeg' ? 0.92 : undefined)
  triggerDownload(blob, ext)
}

function resetAll() {
  slots.forEach((_, i) => removeSlot(i))
  resultEl.hidden = true
  setStatus('Add three bracketed exposures to begin.')
}

// ---------- wire up ----------
pickBtn.addEventListener('click', pickPhotos)
saveBtn.addEventListener('click', saveResult)
mergeBtn.addEventListener('click', doMerge)
resetBtn.addEventListener('click', resetAll)
downloadBtn.addEventListener('click', () => void download('image/png'))
downloadJpgBtn.addEventListener('click', () => void download('image/jpeg'))

// Expose the Save button label appropriately (share vs download).
if (!navigator.canShare) saveBtn.textContent = 'Save PNG'

renderSlots()
