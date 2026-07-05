// Zero-dependency PNG icon generator. Renders the Exposure Stack brand mark
// (gradient rounded square + white inner outline on a dark ground) at the sizes
// the web manifest needs. Run: node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
mkdirSync(OUT, { recursive: true })

const BG = [0x0b, 0x0f, 0x17]
const A = [0x5b, 0x9d, 0xff] // accent
const B = [0x7c, 0x6c, 0xff] // accent-2
const WHITE = [0xff, 0xff, 0xff]

const mix = (c1, c2, t) => c1.map((v, i) => v + (c2[i] - v) * t)
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)

// Signed distance to a rounded rectangle centred at (cx,cy), half-extent (hx,hy).
function sdRoundRect(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r)
  const qy = Math.abs(py - cy) - (hy - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

function sample(x, y, S, markScale) {
  const c = S / 2
  const half = (S * markScale) / 2
  const r = half * 0.28
  // background
  let col = BG
  let a = 1

  // gradient rounded square (soft edge via SDF coverage)
  const dSq = sdRoundRect(x, y, c, c, half, half, r)
  const covSq = clamp01(0.5 - dSq)
  if (covSq > 0) {
    const t = clamp01((x - (c - half) + (y - (c - half))) / (2 * 2 * half))
    col = mix(col, mix(A, B, t), covSq)
  }

  // white inner outline
  const inHalf = half * 0.52
  const inR = inHalf * 0.34
  const stroke = Math.max(2, S * 0.02)
  const dIn = sdRoundRect(x, y, c, c, inHalf, inHalf, inR)
  const ring = clamp01(0.5 - Math.abs(dIn) + stroke / 2 - stroke / 2)
  const ringCov = clamp01(stroke / 2 - Math.abs(dIn) + 0.5)
  if (ringCov > 0) col = mix(col, WHITE, ringCov * 0.9)

  return [Math.round(col[0]), Math.round(col[1]), Math.round(col[2]), Math.round(a * 255)]
}

function render(size, markScale) {
  const SS = 2 // 2x2 supersampling for smooth edges
  const W = size
  const raw = Buffer.alloc(W * W * 4)
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / W * size
          const py = (y + (sy + 0.5) / SS) / W * size
          const [pr, pg, pb, pa] = sample(px, py, size, markScale)
          r += pr
          g += pg
          b += pb
          a += pa
        }
      }
      const n = SS * SS
      const i = (y * W + x) * 4
      raw[i] = r / n
      raw[i + 1] = g / n
      raw[i + 2] = b / n
      raw[i + 3] = a / n
    }
  }
  return raw
}

// ---- minimal PNG encoder (RGBA, filter 0) ----
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (~c) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}
function encodePNG(size, raw) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  // rows with filter byte 0 prefix
  const stride = size * 4
  const rows = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    rows[y * (stride + 1)] = 0
    raw.copy(rows, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = deflateSync(rows, { level: 9 })
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const targets = [
  { name: 'icon-192.png', size: 192, mark: 0.62 },
  { name: 'icon-512.png', size: 512, mark: 0.62 },
  { name: 'icon-512-maskable.png', size: 512, mark: 0.52 },
]
for (const t of targets) {
  const raw = render(t.size, t.mark)
  writeFileSync(join(OUT, t.name), encodePNG(t.size, raw))
  console.log('wrote', t.name)
}
