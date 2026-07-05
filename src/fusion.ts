// Mertens–Kautz–Van Reeth exposure fusion, implemented from scratch.
//
// Given N images of the same scene at different exposures, we score every pixel
// of every image by three perceptual quality measures — contrast, saturation and
// well-exposedness — then blend the images using those scores as weights. A naive
// weighted average would produce seams and halos, so the blend is done across a
// Laplacian pyramid (the images) modulated by a Gaussian pyramid (the weights),
// which fuses detail at every spatial scale seamlessly.
//
// Reference: T. Mertens, J. Kautz, F. Van Reeth, "Exposure Fusion", 2007.

export interface FusionWeights {
  contrast: number
  saturation: number
  exposure: number
}

interface Plane {
  data: Float32Array
  w: number
  h: number
}

const EPS = 1e-12

// ---- separable 5-tap binomial blur (reflect border) ----
const K = [1, 4, 6, 4, 1]
const KSUM = 16

function reflect(i: number, n: number): number {
  if (i < 0) return -i - 1 < n ? -i - 1 : 0
  if (i >= n) return 2 * n - i - 1 >= 0 ? 2 * n - i - 1 : n - 1
  return i
}

function blur(src: Float32Array, w: number, h: number, ch: number): Float32Array {
  const tmp = new Float32Array(src.length)
  const out = new Float32Array(src.length)
  // horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < ch; c++) {
        let acc = 0
        for (let k = -2; k <= 2; k++) {
          acc += K[k + 2] * src[(row + reflect(x + k, w)) * ch + c]
        }
        tmp[(row + x) * ch + c] = acc / KSUM
      }
    }
  }
  // vertical
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < ch; c++) {
        let acc = 0
        for (let k = -2; k <= 2; k++) {
          acc += K[k + 2] * tmp[(reflect(y + k, h) * w + x) * ch + c]
        }
        out[(y * w + x) * ch + c] = acc / KSUM
      }
    }
  }
  return out
}

// REDUCE: blur then subsample by 2. Output size = ceil(dim / 2).
function reduce(src: Float32Array, w: number, h: number, ch: number): Plane {
  const b = blur(src, w, h, ch)
  const ow = Math.ceil(w / 2)
  const oh = Math.ceil(h / 2)
  const out = new Float32Array(ow * oh * ch)
  for (let oy = 0; oy < oh; oy++) {
    const sy = oy * 2
    for (let ox = 0; ox < ow; ox++) {
      const sx = ox * 2
      for (let c = 0; c < ch; c++) {
        out[(oy * ow + ox) * ch + c] = b[(sy * w + sx) * ch + c]
      }
    }
  }
  return { data: out, w: ow, h: oh }
}

// EXPAND: upsample (zero-insert) to target size then blur, scaled to conserve energy.
function expand(
  src: Float32Array,
  sw: number,
  sh: number,
  ch: number,
  tw: number,
  th: number,
): Float32Array {
  const up = new Float32Array(tw * th * ch)
  for (let sy = 0; sy < sh; sy++) {
    const ty = sy * 2
    if (ty >= th) break
    for (let sx = 0; sx < sw; sx++) {
      const tx = sx * 2
      if (tx >= tw) break
      for (let c = 0; c < ch; c++) {
        up[(ty * tw + tx) * ch + c] = src[(sy * sw + sx) * ch + c]
      }
    }
  }
  const blurred = blur(up, tw, th, ch)
  // Zero-insertion drops average energy by 4x for a 2D upsample; restore it.
  for (let i = 0; i < blurred.length; i++) blurred[i] *= 4
  return blurred
}

// Gaussian pyramid: [G0=src, G1, ...].
function gaussianPyramid(
  src: Float32Array,
  w: number,
  h: number,
  ch: number,
  levels: number,
): Plane[] {
  const pyr: Plane[] = [{ data: src, w, h }]
  for (let l = 1; l < levels; l++) {
    const prev = pyr[l - 1]
    pyr.push(reduce(prev.data, prev.w, prev.h, ch))
  }
  return pyr
}

// Laplacian pyramid derived from the Gaussian pyramid; top level is the residual.
function laplacianPyramid(gauss: Plane[], ch: number): Plane[] {
  const lap: Plane[] = []
  for (let l = 0; l < gauss.length - 1; l++) {
    const cur = gauss[l]
    const up = expand(gauss[l + 1].data, gauss[l + 1].w, gauss[l + 1].h, ch, cur.w, cur.h)
    const d = new Float32Array(cur.data.length)
    for (let i = 0; i < d.length; i++) d[i] = cur.data[i] - up[i]
    lap.push({ data: d, w: cur.w, h: cur.h })
  }
  lap.push(gauss[gauss.length - 1]) // residual
  return lap
}

// Collapse a Laplacian pyramid back into an image.
function collapse(lap: Plane[], ch: number): Plane {
  let cur = lap[lap.length - 1]
  for (let l = lap.length - 2; l >= 0; l--) {
    const fine = lap[l]
    const up = expand(cur.data, cur.w, cur.h, ch, fine.w, fine.h)
    const d = new Float32Array(fine.data.length)
    for (let i = 0; i < d.length; i++) d[i] = fine.data[i] + up[i]
    cur = { data: d, w: fine.w, h: fine.h }
  }
  return cur
}

// ---- per-image quality measures -> normalized blend weights ----
function computeWeights(
  images: Float32Array[],
  w: number,
  h: number,
  weights: FusionWeights,
): Float32Array[] {
  const n = images.length
  const maps = images.map(() => new Float32Array(w * h))
  const sigma2 = 2 * 0.2 * 0.2 // well-exposedness Gaussian variance term

  for (let i = 0; i < n; i++) {
    const img = images[i]
    const wmap = maps[i]
    // grayscale for the contrast (Laplacian) measure
    const gray = new Float32Array(w * h)
    for (let p = 0; p < w * h; p++) {
      gray[p] = 0.299 * img[p * 3] + 0.587 * img[p * 3 + 1] + 0.114 * img[p * 3 + 2]
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        // contrast: |Laplacian| of grayscale
        const c =
          gray[reflect(y - 1, h) * w + x] +
          gray[reflect(y + 1, h) * w + x] +
          gray[y * w + reflect(x - 1, w)] +
          gray[y * w + reflect(x + 1, w)] -
          4 * gray[p]
        const contrast = Math.abs(c)

        const r = img[p * 3]
        const g = img[p * 3 + 1]
        const b = img[p * 3 + 2]
        // saturation: stddev across channels
        const mean = (r + g + b) / 3
        const sat = Math.sqrt(
          ((r - mean) ** 2 + (g - mean) ** 2 + (b - mean) ** 2) / 3,
        )
        // well-exposedness: product of per-channel Gaussians centred on 0.5
        const wexp =
          Math.exp(-((r - 0.5) ** 2) / sigma2) *
          Math.exp(-((g - 0.5) ** 2) / sigma2) *
          Math.exp(-((b - 0.5) ** 2) / sigma2)

        wmap[p] =
          Math.pow(contrast + EPS, weights.contrast) *
          Math.pow(sat + EPS, weights.saturation) *
          Math.pow(wexp + EPS, weights.exposure) +
          EPS
      }
    }
  }

  // normalize so weights sum to 1 across images at each pixel
  for (let p = 0; p < w * h; p++) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += maps[i][p]
    const inv = 1 / (sum + EPS)
    for (let i = 0; i < n; i++) maps[i][p] *= inv
  }
  return maps
}

export type Progress = (message: string) => void

// Fuse N same-size RGB images (interleaved Float32 in [0,1]) into one.
export function fuse(
  images: Float32Array[],
  w: number,
  h: number,
  weights: FusionWeights,
  onProgress?: Progress,
): Float32Array {
  const n = images.length
  const levels = Math.max(1, Math.min(9, Math.floor(Math.log2(Math.min(w, h)))))

  onProgress?.('Scoring exposures…')
  const weightMaps = computeWeights(images, w, h, weights)

  // Accumulate the blended Laplacian pyramid one image at a time to bound memory.
  const result: Plane[] = []
  for (let i = 0; i < n; i++) {
    onProgress?.(`Blending pyramid ${i + 1}/${n}…`)
    const imgGauss = gaussianPyramid(images[i], w, h, 3, levels)
    const imgLap = laplacianPyramid(imgGauss, 3)
    const wGauss = gaussianPyramid(weightMaps[i], w, h, 1, levels)

    for (let l = 0; l < levels; l++) {
      const lap = imgLap[l]
      const wl = wGauss[l]
      if (i === 0) {
        result.push({ data: new Float32Array(lap.data.length), w: lap.w, h: lap.h })
      }
      const acc = result[l].data
      const ld = lap.data
      const wd = wl.data
      for (let p = 0; p < wd.length; p++) {
        const weight = wd[p]
        const base = p * 3
        acc[base] += weight * ld[base]
        acc[base + 1] += weight * ld[base + 1]
        acc[base + 2] += weight * ld[base + 2]
      }
    }
  }

  onProgress?.('Reconstructing image…')
  const collapsed = collapse(result, 3)
  const out = collapsed.data
  for (let i = 0; i < out.length; i++) out[i] = out[i] < 0 ? 0 : out[i] > 1 ? 1 : out[i]
  return out
}
