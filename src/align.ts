// Median Threshold Bitmap (MTB) alignment — Greg Ward, "Fast, Robust Image
// Registration for Compositing High Dynamic Range Photographs from Handheld
// Exposures" (2003).
//
// MTB aligns differently-exposed frames without being fooled by the exposure
// difference itself: each frame is reduced to a 1-bit image thresholded at its
// own median brightness, which is (largely) exposure-invariant. Frames are then
// registered by searching for the integer pixel shift that minimizes the number
// of differing bits, coarse-to-fine over an image pyramid. An exclusion bitmap
// ignores pixels near the median where noise would dominate.

interface Bitmap {
  mtb: Uint8Array // 1 where luminance > median
  exclude: Uint8Array // 0 where luminance is within a noise band of the median
  w: number
  h: number
}

const NOISE = 4 / 255 // exclusion band around the median

function luminance(img: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  for (let p = 0; p < w * h; p++) {
    out[p] = 0.299 * img[p * 3] + 0.587 * img[p * 3 + 1] + 0.114 * img[p * 3 + 2]
  }
  return out
}

function median(values: Float32Array): number {
  // 256-bin histogram median — plenty precise for thresholding.
  const hist = new Uint32Array(256)
  for (let i = 0; i < values.length; i++) {
    let b = (values[i] * 255) | 0
    if (b < 0) b = 0
    else if (b > 255) b = 255
    hist[b]++
  }
  const half = values.length / 2
  let cum = 0
  for (let b = 0; b < 256; b++) {
    cum += hist[b]
    if (cum >= half) return b / 255
  }
  return 0.5
}

function toBitmap(lum: Float32Array, w: number, h: number): Bitmap {
  const med = median(lum)
  const mtb = new Uint8Array(w * h)
  const exclude = new Uint8Array(w * h)
  for (let p = 0; p < w * h; p++) {
    mtb[p] = lum[p] > med ? 1 : 0
    exclude[p] = Math.abs(lum[p] - med) > NOISE ? 1 : 0
  }
  return { mtb, exclude, w, h }
}

function halfLum(lum: Float32Array, w: number, h: number) {
  const ow = w >> 1
  const oh = h >> 1
  const out = new Float32Array(ow * oh)
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const sx = x * 2
      const sy = y * 2
      out[y * ow + x] =
        (lum[sy * w + sx] +
          lum[sy * w + sx + 1] +
          lum[(sy + 1) * w + sx] +
          lum[(sy + 1) * w + sx + 1]) /
        4
    }
  }
  return { data: out, w: ow, h: oh }
}

// Count mismatching, non-excluded bits when `b` is shifted by (dx,dy) onto `a`.
function shiftError(a: Bitmap, b: Bitmap, dx: number, dy: number): number {
  const { w, h } = a
  let err = 0
  for (let y = 0; y < h; y++) {
    const sy = y + dy
    if (sy < 0 || sy >= h) continue
    for (let x = 0; x < w; x++) {
      const sx = x + dx
      if (sx < 0 || sx >= w) continue
      const ai = y * w + x
      const bi = sy * w + sx
      if (a.exclude[ai] === 0 || b.exclude[bi] === 0) continue
      if (a.mtb[ai] !== b.mtb[bi]) err++
    }
  }
  return err
}

// Recursively find the shift that best aligns `b` onto reference `a`.
function getShift(
  refLum: Float32Array,
  imgLum: Float32Array,
  w: number,
  h: number,
  depth: number,
): [number, number] {
  let curDx = 0
  let curDy = 0
  if (depth > 0 && w > 8 && h > 8) {
    const ra = halfLum(refLum, w, h)
    const rb = halfLum(imgLum, w, h)
    const [px, py] = getShift(ra.data, rb.data, ra.w, ra.h, depth - 1)
    curDx = px * 2
    curDy = py * 2
  }

  const a = toBitmap(refLum, w, h)
  const b = toBitmap(imgLum, w, h)
  // Seed the search at the coarse prediction and only move off it on a STRICTLY
  // smaller error. This keeps ties anchored to the prediction (ultimately 0),
  // so smooth/low-texture regions can't drift the alignment.
  let best = shiftError(a, b, curDx, curDy)
  let bestDx = curDx
  let bestDy = curDy
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (ox === 0 && oy === 0) continue
      const err = shiftError(a, b, curDx + ox, curDy + oy)
      if (err < best) {
        best = err
        bestDx = curDx + ox
        bestDy = curDy + oy
      }
    }
  }
  return [bestDx, bestDy]
}

export interface Offset {
  x: number
  y: number
}

// Apply an integer shift to an interleaved RGB image, replicating the edge.
export function shiftImage(
  img: Float32Array,
  w: number,
  h: number,
  dx: number,
  dy: number,
): Float32Array {
  if (dx === 0 && dy === 0) return img
  const out = new Float32Array(img.length)
  for (let y = 0; y < h; y++) {
    let sy = y - dy
    sy = sy < 0 ? 0 : sy >= h ? h - 1 : sy
    for (let x = 0; x < w; x++) {
      let sx = x - dx
      sx = sx < 0 ? 0 : sx >= w ? w - 1 : sx
      const d = (y * w + x) * 3
      const s = (sy * w + sx) * 3
      out[d] = img[s]
      out[d + 1] = img[s + 1]
      out[d + 2] = img[s + 2]
    }
  }
  return out
}

// Compute the integer pixel offset that best aligns each image to the middle
// (reference) exposure. The reference itself gets {0,0}. These offsets can be
// applied directly, or shown in the UI for the user to fine-tune by hand.
export function computeOffsets(
  images: Float32Array[],
  w: number,
  h: number,
): Offset[] {
  const refIndex = Math.floor(images.length / 2)
  const refLum = luminance(images[refIndex], w, h)
  const maxDepth = Math.max(1, Math.min(6, Math.floor(Math.log2(Math.min(w, h))) - 3))

  return images.map((img, i) => {
    if (i === refIndex) return { x: 0, y: 0 }
    const lum = luminance(img, w, h)
    const [dx, dy] = getShift(refLum, lum, w, h, maxDepth)
    return { x: dx, y: dy }
  })
}
