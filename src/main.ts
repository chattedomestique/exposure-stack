import './style.css'
import type { MergeOptions } from './merge.worker.ts'

// Cap the working resolution so OpenCV's Laplacian-pyramid fusion stays within
// the WASM heap on phones. 2560px on the long edge yields a crisp, shareable
// image while keeping memory predictable.
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
function acceptFile(index: number, file: File) {
  if (!file.type.startsWith('image/')) {
    setStatus('That file is not an image.', 'error')
    return
  }
  const slot = slots[index]
  if (slot.url) URL.revokeObjectURL(slot.url)
  slot.file = file
  slot.url = URL.createObjectURL(file)
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

// ---------- decoding (orientation-correct + downscale) ----------
async function decodeToImageData(file: File): Promise<ImageData> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not get a 2D drawing context.')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return ctx.getImageData(0, 0, w, h)
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

// ---------- download ----------
function download(type: 'image/png' | 'image/jpeg') {
  const ext = type === 'image/png' ? 'png' : 'jpg'
  outputCanvas.toBlob(
    (blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `exposure-stack.${ext}`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
    type,
    type === 'image/jpeg' ? 0.92 : undefined,
  )
}

function resetAll() {
  slots.forEach((_, i) => removeSlot(i))
  resultEl.hidden = true
  setStatus('Add three bracketed exposures to begin.')
}

// ---------- wire up ----------
mergeBtn.addEventListener('click', doMerge)
resetBtn.addEventListener('click', resetAll)
downloadBtn.addEventListener('click', () => download('image/png'))
downloadJpgBtn.addEventListener('click', () => download('image/jpeg'))

renderSlots()
