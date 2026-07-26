import './style.css'
import type { MergeOptions } from './merge.worker.ts'
import type { Offset } from './align.ts'

// Cap the working resolution so the Laplacian-pyramid fusion stays within the
// memory budget on phones (iOS Safari is especially tight). 2560px on the long
// edge yields a crisp, shareable image while keeping memory predictable.
const MAX_EDGE = 2560
// Resolution of the interactive alignment preview (fit to the reference frame).
const PREVIEW_EDGE = 760
// The middle (Standard) exposure is the fixed alignment reference.
const REF = 1

const SLOT_META = [
  { key: 'under', label: 'Underexposed', short: 'Under', hint: 'darkest — holds highlights' },
  { key: 'mid', label: 'Standard', short: 'Standard', hint: 'metered / neutral' },
  { key: 'over', label: 'Overexposed', short: 'Over', hint: 'brightest — opens shadows' },
] as const

interface Slot {
  file: File | null
  url: string | null // object URL for the thumbnail
  offset: Offset // pixel nudge in reference working-resolution pixels
  preview: ImageBitmap | null // small decode for the alignment overlay
}

const slots: Slot[] = SLOT_META.map(() => ({
  file: null,
  url: null,
  offset: { x: 0, y: 0 },
  preview: null,
}))

// Reference working dimensions (the grid every frame is aligned/fused on) and
// the preview dimensions derived from it. Set when previews are prepared.
let workW = 0
let workH = 0
let prevW = 0
let prevH = 0

// ---------- persisted settings ----------
type SaveFormat = 'image/jpeg' | 'image/png'
interface Settings {
  contrast: number
  saturation: number
  exposure: number
  mode: 'difference' | 'onion'
  grid: boolean
  format: SaveFormat
}
const DEFAULTS: Settings = {
  contrast: 1,
  saturation: 1,
  exposure: 1,
  mode: 'difference',
  grid: false,
  format: 'image/jpeg',
}
const SETTINGS_KEY = 'exposure-stack:settings'

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    /* corrupt or unavailable storage — fall back to defaults */
  }
  return { ...DEFAULTS }
}
const settings = loadSettings()

let saveTimer: number | undefined
function persist() {
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      /* storage full or blocked — non-fatal */
    }
  }, 300)
}

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
const wContrast = $<HTMLInputElement>('#w-contrast')
const wSaturation = $<HTMLInputElement>('#w-saturation')
const wExposure = $<HTMLInputElement>('#w-exposure')

// Alignment panel
const alignPanel = $<HTMLElement>('#align-panel')
const alignCanvas = $<HTMLCanvasElement>('#align-canvas')
const layerSeg = $<HTMLElement>('#layer-seg')
const offsetReadout = $<HTMLElement>('#offset-readout')
const modeDiffBtn = $<HTMLButtonElement>('#mode-diff')
const modeOnionBtn = $<HTMLButtonElement>('#mode-onion')
const gridToggle = $<HTMLInputElement>('#grid-toggle')
const autoAlignBtn = $<HTMLButtonElement>('#auto-align')
const resetOffsetBtn = $<HTMLButtonElement>('#reset-offset')
const dpad = $<HTMLElement>('#dpad')

let busy = false
let selectedLayer = 0 // which non-reference layer is being nudged (0 or 2)

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

function allFilled(): boolean {
  return slots.every((s) => s.file)
}

function updateMergeState() {
  mergeBtn.disabled = !(allFilled() && !busy)
}

// Status hint reflecting how many slots are filled. Called only on slot changes
// so it never overwrites a merge's progress/done/error message.
function updateCountHint() {
  if (busy) return
  const count = slots.filter((s) => s.file).length
  if (count === 0) setStatus('Add three bracketed exposures to begin.')
  else if (count < 3) setStatus(`${count} of 3 exposures added.`)
  else setStatus('Line them up below, then merge.', 'done')
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

// Assign a file to a slot without re-rendering (caller renders once). Changing
// any slot invalidates the alignment state, since offsets are tied to pixels.
function setSlot(index: number, file: File) {
  const slot = slots[index]
  if (slot.url) URL.revokeObjectURL(slot.url)
  slot.preview?.close()
  slot.file = file
  slot.url = URL.createObjectURL(file)
  slot.preview = null
  slot.offset = { x: 0, y: 0 }
}

function acceptFile(index: number, file: File) {
  if (!isProbablyImage(file)) {
    setStatus('That file is not an image.', 'error')
    return
  }
  setSlot(index, file)
  renderSlots()
  void refreshAlign()
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
      three.forEach((file, i) => setSlot(i, file)) // probe failed → selection order
    }
    renderSlots()
    setStatus(
      picked.length > 3
        ? 'Used the first 3 photos, sorted darkest → brightest.'
        : 'Sorted darkest → brightest.',
      'done',
    )
    await refreshAlign()
    return
  }

  for (const file of picked) {
    const idx = slots.findIndex((s) => !s.file)
    if (idx === -1) break
    setSlot(idx, file)
  }
  renderSlots()
  void refreshAlign()
}

function removeSlot(index: number) {
  const slot = slots[index]
  if (slot.url) URL.revokeObjectURL(slot.url)
  slot.preview?.close()
  slot.file = null
  slot.url = null
  slot.preview = null
  slot.offset = { x: 0, y: 0 }
  renderSlots()
  void refreshAlign()
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
        img.onerror = () => reject(new Error('Unsupported or corrupt image (try JPEG/PNG).'))
        img.src = url
      })
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

function drawToImageData(dec: Decoded, w: number, h: number): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not get a 2D drawing context.')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(dec.src, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h)
}

// Decode a file scaled to fit within `maxEdge` on its own aspect.
async function decodeToImageData(file: File, maxEdge: number): Promise<ImageData> {
  const dec = await decodeSource(file)
  try {
    const scale = Math.min(1, maxEdge / Math.max(dec.w, dec.h))
    return drawToImageData(dec, Math.max(1, Math.round(dec.w * scale)), Math.max(1, Math.round(dec.h * scale)))
  } finally {
    dec.close()
  }
}

// Cheap mean-luminance probe (tiny decode) used to auto-order a batch of picks.
async function meanBrightness(file: File): Promise<number> {
  const dec = await decodeSource(file)
  try {
    const data = drawToImageData(dec, 32, 32).data
    let sum = 0
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    }
    return sum / (data.length / 4)
  } finally {
    dec.close()
  }
}

// ---------- alignment preview ----------
// Prepare per-slot preview bitmaps, all resampled onto the reference frame's
// grid so they overlay pixel-for-pixel. Also derive the working (merge) and
// preview dimensions from the reference exposure.
async function preparePreviews(): Promise<void> {
  const ref = slots[REF].file
  if (!ref) return
  const refDec = await decodeSource(ref)
  try {
    const workScale = Math.min(1, MAX_EDGE / Math.max(refDec.w, refDec.h))
    workW = Math.max(1, Math.round(refDec.w * workScale))
    workH = Math.max(1, Math.round(refDec.h * workScale))
    const pScale = Math.min(1, PREVIEW_EDGE / Math.max(refDec.w, refDec.h))
    prevW = Math.max(1, Math.round(refDec.w * pScale))
    prevH = Math.max(1, Math.round(refDec.h * pScale))
  } finally {
    refDec.close()
  }

  for (const slot of slots) {
    if (!slot.file || slot.preview) continue
    const dec = await decodeSource(slot.file)
    try {
      const c = document.createElement('canvas')
      c.width = prevW
      c.height = prevH
      const ctx = c.getContext('2d')!
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(dec.src, 0, 0, prevW, prevH) // onto the reference grid
      slot.preview = await createImageBitmap(c)
    } finally {
      dec.close()
    }
  }
}

// Show/prepare the alignment panel when all three are loaded; hide otherwise.
async function refreshAlign(): Promise<void> {
  if (!allFilled()) {
    alignPanel.hidden = true
    return
  }
  alignPanel.hidden = false
  setLayer(selectedLayer === REF ? 0 : selectedLayer)
  try {
    await preparePreviews()
  } catch (err) {
    setStatus(
      `Couldn't prepare alignment preview: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    )
    return
  }
  renderAlign()
  updateOffsetReadout()
}

function fitPreviewCanvas(): { scale: number; dw: number; dh: number } {
  // Fit the reference grid into the canvas's CSS box at devicePixelRatio.
  const cssW = alignCanvas.clientWidth || prevW
  const scaleToBox = Math.min(cssW / prevW, 1) // never upscale past preview res
  const dw = Math.round(prevW * scaleToBox)
  const dh = Math.round(prevH * scaleToBox)
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  alignCanvas.width = Math.round(dw * dpr)
  alignCanvas.height = Math.round(dh * dpr)
  alignCanvas.style.height = `${dh}px`
  return { scale: (dw * dpr) / prevW, dw: alignCanvas.width, dh: alignCanvas.height }
}

// Draw the reference exposure with the selected layer overlaid (difference or
// onion-skin), offset by the layer's nudge. This canvas is a pure editing aid —
// it is never exported (playbook N8), so the grid is safe to draw here.
function renderAlign() {
  const refBmp = slots[REF].preview
  const layer = slots[selectedLayer]
  if (!refBmp || !layer.preview || !prevW) return
  const { scale, dw, dh } = fitPreviewCanvas()
  const ctx = alignCanvas.getContext('2d')!
  ctx.clearRect(0, 0, dw, dh)
  ctx.imageSmoothingQuality = 'high'

  // reference
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.drawImage(refBmp, 0, 0, dw, dh)

  // selected layer, shifted. Offsets are in working px; convert to preview px.
  const px = (layer.offset.x * prevW) / workW
  const py = (layer.offset.y * prevH) / workH
  const ox = px * (dw / prevW)
  const oy = py * (dh / prevH)
  if (settings.mode === 'difference') {
    ctx.globalCompositeOperation = 'difference'
    ctx.globalAlpha = 1
  } else {
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 0.5
  }
  ctx.drawImage(layer.preview, ox, oy, dw, dh)

  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  if (settings.grid) drawGrid(ctx, dw, dh, scale)
}

function drawGrid(ctx: CanvasRenderingContext2D, dw: number, dh: number, scale: number) {
  ctx.save()
  ctx.strokeStyle = 'rgba(91,157,255,0.5)'
  ctx.lineWidth = Math.max(1, scale)
  for (let i = 1; i < 3; i++) {
    const x = (dw * i) / 3
    const y = (dh * i) / 3
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, dh)
    ctx.moveTo(0, y)
    ctx.lineTo(dw, y)
    ctx.stroke()
  }
  ctx.restore()
}

function updateOffsetReadout() {
  const o = slots[selectedLayer].offset
  const fmt = (n: number) => (n > 0 ? `+${n}` : `${n}`)
  offsetReadout.textContent = `X ${fmt(o.x)} · Y ${fmt(o.y)} px`
}

function nudge(dx: number, dy: number) {
  if (selectedLayer === REF || !workW) return
  const o = slots[selectedLayer].offset
  const lim = Math.round(workW * 0.5)
  const limY = Math.round(workH * 0.5)
  o.x = Math.max(-lim, Math.min(lim, o.x + dx))
  o.y = Math.max(-limY, Math.min(limY, o.y + dy))
  renderAlign()
  updateOffsetReadout()
}

function setLayer(i: number) {
  selectedLayer = i
  layerSeg.querySelectorAll<HTMLButtonElement>('[data-layer]').forEach((b) => {
    const on = Number(b.dataset.layer) === i
    b.setAttribute('aria-checked', String(on))
    b.classList.toggle('on', on)
  })
  updateOffsetReadout()
  renderAlign()
}

function setMode(mode: Settings['mode']) {
  settings.mode = mode
  modeDiffBtn.setAttribute('aria-checked', String(mode === 'difference'))
  modeDiffBtn.classList.toggle('on', mode === 'difference')
  modeOnionBtn.setAttribute('aria-checked', String(mode === 'onion'))
  modeOnionBtn.classList.toggle('on', mode === 'onion')
  persist()
  renderAlign()
}

// Drag on the preview to nudge the selected layer.
let dragging = false
let lastX = 0
let lastY = 0
let dragAccX = 0
let dragAccY = 0
alignCanvas.addEventListener('pointerdown', (e) => {
  if (selectedLayer === REF || !workW) return
  dragging = true
  lastX = e.clientX
  lastY = e.clientY
  dragAccX = 0
  dragAccY = 0
  alignCanvas.setPointerCapture(e.pointerId)
})
alignCanvas.addEventListener('pointermove', (e) => {
  if (!dragging) return
  const cssW = alignCanvas.clientWidth || prevW
  const perScreenPx = workW / cssW // working px per CSS px
  dragAccX += (e.clientX - lastX) * perScreenPx
  dragAccY += (e.clientY - lastY) * perScreenPx
  lastX = e.clientX
  lastY = e.clientY
  const stepX = Math.trunc(dragAccX)
  const stepY = Math.trunc(dragAccY)
  if (stepX || stepY) {
    dragAccX -= stepX
    dragAccY -= stepY
    nudge(stepX, stepY)
  }
})
const endDrag = () => {
  dragging = false
}
alignCanvas.addEventListener('pointerup', endDrag)
alignCanvas.addEventListener('pointercancel', endDrag)

// Keyboard nudging when the preview is focused (accessible, pixel-precise).
alignCanvas.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 10 : 1
  const moves: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  }
  const m = moves[e.key]
  if (m) {
    e.preventDefault()
    nudge(m[0], m[1])
  }
})

// D-pad and controls
dpad.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-nudge]') as HTMLButtonElement | null
  if (!btn) return
  const step = 1
  const map: Record<string, [number, number]> = {
    left: [-step, 0],
    right: [step, 0],
    up: [0, -step],
    down: [0, step],
  }
  const m = map[btn.dataset.nudge!]
  if (m) nudge(m[0], m[1])
})

layerSeg.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-layer]') as HTMLButtonElement | null
  if (btn) setLayer(Number(btn.dataset.layer))
})
modeDiffBtn.addEventListener('click', () => setMode('difference'))
modeOnionBtn.addEventListener('click', () => setMode('onion'))
gridToggle.addEventListener('change', () => {
  settings.grid = gridToggle.checked
  persist()
  renderAlign()
})
resetOffsetBtn.addEventListener('click', () => {
  slots[selectedLayer].offset = { x: 0, y: 0 }
  renderAlign()
  updateOffsetReadout()
})
window.addEventListener('resize', () => {
  if (!alignPanel.hidden) renderAlign()
})

// ---------- worker plumbing ----------
let worker: Worker | null = null
function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./merge.worker.ts', import.meta.url), { type: 'module' })
  return worker
}

// Auto-align: compute MTB offsets on the preview-resolution frames (fast, reuses
// the decoded previews) and scale them up to working pixels for the user to
// fine-tune.
async function autoAlign() {
  if (busy || !allFilled()) return
  try {
    await preparePreviews()
    const previews = slots.map((s) => bitmapToImageData(s.preview!))
    setStatus('Auto-aligning…', 'working')
    const offsets = await requestOffsets(previews)
    const ratioX = workW / prevW
    const ratioY = workH / prevH
    offsets.forEach((o, i) => {
      slots[i].offset = { x: Math.round(o.x * ratioX), y: Math.round(o.y * ratioY) }
    })
    renderAlign()
    updateOffsetReadout()
    setStatus('Auto-aligned. Fine-tune with the arrows, then merge.', 'done')
  } catch (err) {
    setStatus(`Auto-align failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

function bitmapToImageData(bmp: ImageBitmap): ImageData {
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0)
  return ctx.getImageData(0, 0, bmp.width, bmp.height)
}

function requestOffsets(images: ImageData[]): Promise<Offset[]> {
  const w = getWorker()
  return new Promise<Offset[]>((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'offsets') {
        w.removeEventListener('message', onMsg)
        resolve(e.data.offsets as Offset[])
      } else if (e.data?.type === 'error') {
        w.removeEventListener('message', onMsg)
        reject(new Error(e.data.message))
      }
    }
    w.addEventListener('message', onMsg)
    w.postMessage({ type: 'autoAlign', images }, images.map((i) => i.data.buffer))
  })
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
    w.postMessage({ type: 'merge', images, options }, images.map((i) => i.data.buffer))
  })
}

// ---------- merge flow ----------
async function doMerge() {
  if (busy || !allFilled()) return
  busy = true
  updateMergeState()
  mergeBtn.disabled = true
  document.body.classList.add('busy')

  try {
    setStatus('Decoding photos…', 'working')
    const images = await Promise.all(
      slots.map((s) => decodeToImageData(s.file as File, MAX_EDGE)),
    )

    const options: MergeOptions = {
      contrast: Number(wContrast.value),
      saturation: Number(wSaturation.value),
      exposure: Number(wExposure.value),
      offsets: slots.map((s) => ({ ...s.offset })),
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
    setStatus(`Merge failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
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
// sheet ("Save Image to Photos"), the only reliable save on iOS Safari. Default
// to JPEG — a photo PNG is needlessly multi-MB (playbook N4).
async function saveResult() {
  try {
    const blob = await canvasToBlob('image/jpeg', 0.92)
    const file = new File([blob], 'exposure-stack.jpg', { type: 'image/jpeg' })
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Exposure Stack' })
      setStatus('✓ Saved', 'done')
      return
    }
    triggerDownload(blob, 'jpg')
    setStatus('✓ Saved', 'done')
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return // user dismissed the sheet
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

async function download(type: SaveFormat) {
  const ext = type === 'image/png' ? 'png' : 'jpg'
  const blob = await canvasToBlob(type, type === 'image/jpeg' ? 0.92 : undefined)
  triggerDownload(blob, ext)
}

function resetAll() {
  slots.forEach((_, i) => removeSlot(i))
  resultEl.hidden = true
  alignPanel.hidden = true
  setStatus('Add three bracketed exposures to begin.')
}

// ---------- sliders + init from settings ----------
function bindSlider(el: HTMLInputElement, key: 'contrast' | 'saturation' | 'exposure') {
  el.value = String(settings[key])
  el.addEventListener('input', () => {
    settings[key] = Number(el.value)
    persist()
  })
}

// ---------- wire up ----------
pickBtn.addEventListener('click', pickPhotos)
saveBtn.addEventListener('click', saveResult)
mergeBtn.addEventListener('click', doMerge)
resetBtn.addEventListener('click', resetAll)
autoAlignBtn.addEventListener('click', () => void autoAlign())
downloadBtn.addEventListener('click', () => void download('image/png'))
downloadJpgBtn.addEventListener('click', () => void download('image/jpeg'))

bindSlider(wContrast, 'contrast')
bindSlider(wSaturation, 'saturation')
bindSlider(wExposure, 'exposure')
gridToggle.checked = settings.grid
setMode(settings.mode)

// Save button label: share sheet vs plain download.
if (!navigator.canShare) saveBtn.textContent = 'Save JPEG'

renderSlots()
