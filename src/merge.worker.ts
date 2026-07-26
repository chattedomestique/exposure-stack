/// <reference lib="webworker" />
// Runs the exposure-merge pipeline off the main thread:
//   ImageData[] -> linearize to float RGB -> apply per-image offsets -> Mertens
//   fuse -> back to ImageData.
// Also answers `autoAlign` requests by returning MTB offsets the UI can edit.
import { fuse, type FusionWeights } from './fusion.ts'
import { computeOffsets, shiftImage, type Offset } from './align.ts'

export interface MergeOptions extends FusionWeights {
  offsets: Offset[]
}

type InMessage =
  | { type: 'merge'; images: ImageData[]; options: MergeOptions }
  | { type: 'autoAlign'; images: ImageData[] }

type OutMessage =
  | { type: 'progress'; message: string }
  | { type: 'result'; image: ImageData }
  | { type: 'offsets'; offsets: Offset[] }
  | { type: 'error'; message: string }

const post = (msg: OutMessage, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(msg, transfer ?? [])

// Nearest-neighbour resample of interleaved RGB (used only when a frame's
// dimensions differ from the reference — normally they match).
function resampleRGB(
  src: Float32Array,
  sw: number,
  sh: number,
  tw: number,
  th: number,
): Float32Array {
  if (sw === tw && sh === th) return src
  const out = new Float32Array(tw * th * 3)
  for (let y = 0; y < th; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / th))
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / tw))
      const s = (sy * sw + sx) * 3
      const d = (y * tw + x) * 3
      out[d] = src[s]
      out[d + 1] = src[s + 1]
      out[d + 2] = src[s + 2]
    }
  }
  return out
}

function toFloatRGB(img: ImageData): Float32Array {
  const { data } = img
  const out = new Float32Array((data.length / 4) * 3)
  for (let p = 0, q = 0; p < data.length; p += 4, q += 3) {
    out[q] = data[p] / 255
    out[q + 1] = data[p + 1] / 255
    out[q + 2] = data[p + 2] / 255
  }
  return out
}

function toImageData(rgb: Float32Array, w: number, h: number): ImageData {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let q = 0, p = 0; q < rgb.length; q += 3, p += 4) {
    out[p] = Math.round(rgb[q] * 255)
    out[p + 1] = Math.round(rgb[q + 1] * 255)
    out[p + 2] = Math.round(rgb[q + 2] * 255)
    out[p + 3] = 255
  }
  return new ImageData(out, w, h)
}

// Common front of the pipeline: to float RGB, sized to the reference frame.
// The reference is the middle exposure, matching the alignment/offset grid.
function toReferenceFloats(images: ImageData[]): {
  floats: Float32Array[]
  w: number
  h: number
} {
  const ref = Math.floor(images.length / 2)
  const w = images[ref].width
  const h = images[ref].height
  const floats = images.map((img) =>
    resampleRGB(toFloatRGB(img), img.width, img.height, w, h),
  )
  return { floats, w, h }
}

self.onmessage = (e: MessageEvent<InMessage>) => {
  try {
    if (e.data.type === 'autoAlign') {
      const { floats, w, h } = toReferenceFloats(e.data.images)
      post({ type: 'offsets', offsets: computeOffsets(floats, w, h) })
      return
    }

    const { images, options } = e.data
    const { floats, w, h } = toReferenceFloats(images)

    // Apply the per-image offsets (auto + manual nudges) with edge replication,
    // so a shifted frame never introduces a transparent gap (playbook N7).
    const shifted = floats.map((img, i) => {
      const off = options.offsets[i]
      return off ? shiftImage(img, w, h, off.x, off.y) : img
    })

    post({ type: 'progress', message: 'Fusing exposures…' })
    const fused = fuse(shifted, w, h, options, (message) =>
      post({ type: 'progress', message }),
    )

    const out = toImageData(fused, w, h)
    post({ type: 'result', image: out }, [out.data.buffer])
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
