// Generate three synthetic bracketed exposures of one scene for E2E testing.
// Scene: bright sky gradient + sun disc (highlights) over a dark foreground
// (shadows) — so a correct fusion must pull detail from all three frames.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scratch-test')
mkdirSync(OUT, { recursive: true })

const W = 480
const H = 360
const clamp = (x) => (x < 0 ? 0 : x > 255 ? 255 : x)

function scene(x, y) {
  // linear-ish scene radiance, 0..~2.5
  const ny = y / H
  let r, g, b
  // sky gradient (top) bright, ground (bottom) dark
  const sky = Math.max(0, 1 - ny * 1.4)
  const ground = ny > 0.6 ? 0.12 : 0
  r = 0.5 * sky + ground * 0.6
  g = 0.6 * sky + ground * 0.5
  b = 0.9 * sky + ground * 0.4
  // bright sun disc
  const dx = x - W * 0.72
  const dy = y - H * 0.28
  const d = Math.hypot(dx, dy)
  if (d < 46) {
    const s = 1 - d / 46
    r += 2.2 * s
    g += 2.1 * s
    b += 1.6 * s
  }
  // dark textured foreground detail
  if (ny > 0.62) {
    const t = (Math.sin(x * 0.14) + Math.sin(y * 0.2)) * 0.03
    r += 0.08 + t
    g += 0.07 + t
    b += 0.06 + t
  }
  return [r, g, b]
}

function encodePNG(size_w, size_h, raw) {
  const crc32 = (buf) => {
    let c = ~0
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i]
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return (~c) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([len, body, crc])
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size_w, 0)
  ihdr.writeUInt32BE(size_h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = size_w * 4
  const rows = Buffer.alloc((stride + 1) * size_h)
  for (let y = 0; y < size_h; y++) {
    rows[y * (stride + 1)] = 0
    raw.copy(rows, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = deflateSync(rows, { level: 6 })
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// exposure multipliers: under, mid, over
const brackets = [
  { name: 'under.png', ev: 0.3 },
  { name: 'mid.png', ev: 1.0 },
  { name: 'over.png', ev: 3.0 },
]

for (const bkt of brackets) {
  const raw = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [sr, sg, sb] = scene(x, y)
      // simple gamma-ish tonemap of exposed radiance
      const px = (c) => clamp(255 * Math.pow(Math.min(1, c * bkt.ev), 1 / 2.2))
      const i = (y * W + x) * 4
      raw[i] = px(sr)
      raw[i + 1] = px(sg)
      raw[i + 2] = px(sb)
      raw[i + 3] = 255
    }
  }
  writeFileSync(join(OUT, bkt.name), encodePNG(W, H, raw))
  console.log('wrote', bkt.name)
}
