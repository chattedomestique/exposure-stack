import { describe, it, expect } from 'vitest'
import { fuse } from './fusion.ts'
import { computeOffsets, shiftImage } from './align.ts'

const EQUAL_WEIGHTS = { contrast: 1, saturation: 1, exposure: 1 }

function constImage(w: number, h: number, v: number): Float32Array {
  return new Float32Array(w * h * 3).fill(v)
}

function gradientImage(w: number, h: number, mul = 1): Float32Array {
  const out = new Float32Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const g = ((x / w) * 0.6 + (y / h) * 0.3) * mul
      const i = (y * w + x) * 3
      out[i] = Math.min(1, g)
      out[i + 1] = Math.min(1, g * 0.9)
      out[i + 2] = Math.min(1, g * 1.1)
    }
  }
  return out
}

describe('fusion', () => {
  it('preserves a constant image (near-null case)', () => {
    const w = 16
    const h = 16
    const imgs = [constImage(w, h, 0.5), constImage(w, h, 0.5), constImage(w, h, 0.5)]
    const out = fuse(imgs, w, h, EQUAL_WEIGHTS)
    for (const v of out) expect(v).toBeCloseTo(0.5, 2)
  })

  it('always produces values in [0,1]', () => {
    const w = 24
    const h = 20
    const imgs = [gradientImage(w, h, 0.4), gradientImage(w, h, 1), gradientImage(w, h, 2)]
    const out = fuse(imgs, w, h, EQUAL_WEIGHTS)
    let min = Infinity
    let max = -Infinity
    for (const v of out) {
      if (v < min) min = v
      if (v > max) max = v
    }
    expect(min).toBeGreaterThanOrEqual(0)
    expect(max).toBeLessThanOrEqual(1)
  })
})

describe('alignment', () => {
  it('returns zero offsets for identical frames, reference in the middle', () => {
    const w = 48
    const h = 48
    const g = gradientImage(w, h)
    const offsets = computeOffsets([g, g.slice(), g.slice()], w, h)
    expect(offsets).toHaveLength(3)
    for (const o of offsets) {
      expect(o.x).toBe(0)
      expect(o.y).toBe(0)
    }
  })

  it('shiftImage translates content and replicates the edge', () => {
    const w = 4
    const h = 1
    const img = new Float32Array(w * h * 3)
    for (let x = 0; x < w; x++) img[x * 3] = x / 10 // distinct red per column
    const shifted = shiftImage(img, w, h, 1, 0)
    // column x samples source x-1, with the left edge replicated
    expect(shifted[0]).toBeCloseTo(0, 6) // out(0) = in(0)
    expect(shifted[3]).toBeCloseTo(0, 6) // out(1) = in(0)
    expect(shifted[6]).toBeCloseTo(0.1, 6) // out(2) = in(1)
    expect(shifted[9]).toBeCloseTo(0.2, 6) // out(3) = in(2)
  })

  it('shiftImage by zero returns the same array reference', () => {
    const img = new Float32Array(12)
    expect(shiftImage(img, 2, 2, 0, 0)).toBe(img)
  })
})
