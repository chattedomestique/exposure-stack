# Exposure Stack

A privacy-first Progressive Web App that merges three bracketed exposures
(under / standard / over) into one clean, detail-rich image — **entirely in your
browser**. Photos never leave your device.

## Why this stack (2026)

The obvious choice for in-browser exposure merging is **OpenCV.js**
(`cv.createMergeMertens`). In practice the prebuilt OpenCV.js distributions ship
**without the `photo` module**, so `MergeMertens` / `AlignMTB` simply aren't
there — and shipping a custom ~11 MB WASM build for two functions is a poor
trade for a lightweight PWA.

Instead, the merge engine is **hand-written TypeScript** implementing the two
algorithms that matter, with zero native dependencies:

- **Exposure fusion** — Mertens, Kautz & Van Reeth (2007). Each pixel of each
  frame is scored by *contrast*, *saturation* and *well-exposedness*, and the
  frames are blended across a **Laplacian pyramid** so detail fuses seamlessly at
  every scale with no halos or seams. No EXIF exposure times and no separate
  tone-mapping step are required — the output is display-ready.
- **Alignment** — Ward's **Median Threshold Bitmap** (2003), a fast,
  exposure-invariant registration that corrects small handheld shifts before
  fusing, coarse-to-fine over an image pyramid.

The result: the whole app is a **~45 KB** precache that installs, works fully
offline, and does every pixel of processing on-device.

WebGPU is now shipped in every major browser and is a natural future path for a
GPU tone-mapping/preview stage, but it has no off-the-shelf fusion library today,
so the CPU pyramid engine (in a Web Worker) is the robust choice for v1.

## Features

- Drag-and-drop or tap to load three exposures into labelled slots
- Optional MTB auto-alignment for handheld brackets
- Live tuning of the contrast / saturation / exposure weights
- Runs off the main thread in a Web Worker (UI stays responsive)
- Installable PWA, fully offline after first load
- Export the merge as PNG or JPEG
- 100% client-side — nothing is uploaded

## Getting started

```bash
npm install
npm run dev        # http://localhost:5173
```

Build and preview the production PWA:

```bash
npm run build
npm run preview
```

## How to use

1. Add three bracketed shots of the same scene — a dark one (protects
   highlights), a normal one, and a bright one (opens shadows).
2. Leave **Auto-align** on for handheld shots; turn it off for tripod shots.
3. Adjust the weight sliders if you want punchier contrast or richer colour.
4. Click **Merge exposures**, then download the result.

Inputs are worked at up to 2560 px on the long edge (see `MAX_EDGE` in
`src/main.ts`) to keep memory predictable on phones.

## Project layout

```
src/
  main.ts          UI, file handling, worker orchestration
  merge.worker.ts  pipeline: linearize -> align -> fuse -> ImageData
  fusion.ts        Mertens exposure fusion (pyramid blending)
  align.ts         Median Threshold Bitmap alignment
scripts/
  gen-icons.mjs           zero-dependency PWA icon generator
  gen-test-exposures.mjs  synthetic bracketed test scene
  e2e.mjs                 headless end-to-end merge test
```

## Testing

```bash
npm run test:fixtures   # generate synthetic brackets in scratch-test/
npm run build
npm run preview &        # serve the built app on :4173
npm run test:e2e         # drive the real merge in headless Chromium
```

The E2E test feeds three synthetic brackets through the real worker and asserts
the fusion recovers blown highlights and lifts crushed shadows.
