// Camera RAW support via LibRaw compiled to WebAssembly (libraw-wasm).
//
// No browser can decode camera RAW natively, so we lazily load LibRaw (a ~1.4 MB
// WASM module, imported only the first time a RAW file is seen) and demosaic to
// sRGB on-device. The heavy WASM stays out of the initial bundle.
//
// Critical for exposure bracketing: auto-brightness is DISABLED. LibRaw's default
// auto-bright stretches each frame's histogram to white, which would normalize
// the three brackets to the same brightness and leave the fusion nothing to do.
// We keep the camera white balance and the sRGB tone curve so the frames land in
// display space (what Mertens well-exposedness expects) while preserving their
// real relative exposures.

// Common camera RAW extensions (LibRaw supports 100+ formats).
const RAW_RE =
  /\.(dng|cr2|cr3|crw|nef|nrw|arw|srf|sr2|raf|orf|rw2|raw|pef|ptx|dcr|kdc|k25|x3f|mrw|3fr|mef|iiq|mos|erf|rwl|srw|gpr|nrf|fff|cap|braw)$/i

export function isRawFile(file: File): boolean {
  return RAW_RE.test(file.name)
}

// A space-joined accept list so the OS file picker actually offers RAW files
// (image/* alone hides many camera RAW types).
export const RAW_ACCEPT =
  'image/*,.dng,.cr2,.cr3,.crw,.nef,.nrw,.arw,.sr2,.raf,.orf,.rw2,.raw,.pef,.dcr,.x3f,.mrw,.3fr,.srw,.gpr'

// libraw-wasm is dynamically imported so it (and its WASM) load only on demand.
type LibRawClass = new () => {
  open(data: Uint8Array, settings: Record<string, unknown>): Promise<void>
  imageData(): Promise<{
    width: number
    height: number
    colors: number
    bits: number
    data: Uint8Array | Uint16Array
  }>
  dispose(): void
}

let libRawPromise: Promise<LibRawClass> | null = null
function getLibRaw(): Promise<LibRawClass> {
  if (!libRawPromise) {
    libRawPromise = import('libraw-wasm').then((m) => m.default as unknown as LibRawClass)
  }
  return libRawPromise
}

// Decode a RAW File to an sRGB ImageData at (half-resolution) native size.
export async function decodeRaw(file: File): Promise<ImageData> {
  const LibRaw = await getLibRaw()
  const raw = new LibRaw()
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    await raw.open(bytes, {
      halfSize: true, // 1/2 each dimension — ample for the 2560px working size, 4x faster
      useCameraWb: true, // natural colour from the camera's own white balance
      outputColor: 1, // sRGB
      outputBps: 8, // 8-bit output (our pipeline works in 8-bit)
      noAutoBright: true, // preserve the brackets' relative exposures (see header)
      userFlip: -1, // honour the RAW's recorded orientation
    })
    const img = await raw.imageData()
    return toImageData(img)
  } catch (err) {
    throw new Error(
      `Could not decode RAW file "${file.name}" — unsupported camera or corrupt file. (${
        err instanceof Error ? err.message : String(err)
      })`,
      { cause: err },
    )
  } finally {
    raw.dispose()
  }
}

function toImageData(img: {
  width: number
  height: number
  colors: number
  data: Uint8Array | Uint16Array
}): ImageData {
  const { width, height, colors, data } = img
  const n = width * height
  const out = new Uint8ClampedArray(n * 4)
  if (colors >= 3) {
    for (let p = 0, q = 0; q < out.length; p += colors, q += 4) {
      out[q] = data[p]
      out[q + 1] = data[p + 1]
      out[q + 2] = data[p + 2]
      out[q + 3] = 255
    }
  } else {
    // single-channel (rare) — replicate to grey
    for (let p = 0, q = 0; q < out.length; p += 1, q += 4) {
      out[q] = out[q + 1] = out[q + 2] = data[p]
      out[q + 3] = 255
    }
  }
  return new ImageData(out, width, height)
}
