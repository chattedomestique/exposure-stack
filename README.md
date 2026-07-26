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

- **One-tap intake** — pick all three brackets at once; they're auto-sorted
  darkest → brightest into the under / standard / over slots
- **Manual pixel alignment** — an Align panel with a live **difference /
  onion-skin** preview lets you nudge each layer pixel-by-pixel (drag, on-screen
  d-pad, or arrow keys) until it registers. **Auto-align** computes MTB offsets
  you can then fine-tune by hand
- **Exposure fusion** with live contrast / saturation / exposure weight tuning
- Runs off the main thread in a Web Worker (UI stays responsive)
- **Save to Photos** via the native share sheet on iOS/Android (JPEG),
  with PNG/JPEG download fallback
- Installable PWA, fully offline after first load; settings persisted
- 100% client-side — nothing is uploaded

## Manual alignment

Auto-alignment can't always nail hand-held or slightly-rotated brackets, so the
Align panel puts registration in your hands:

- Select the **Under** or **Over** layer; the **Standard** exposure is the fixed
  reference.
- The preview overlays that layer on the reference. In **Difference** view,
  aligned areas go dark and misalignment shows up as bright doubled edges —
  nudge until it goes dark. **Onion** view shows a 50% blend instead.
- Nudge by dragging the preview, tapping the d-pad, or using the arrow keys
  (**Shift** = 10 px). The current offset is shown live.
- Offsets are applied in the merge with edge replication, so a shifted frame
  never bakes a transparent gap into the export (playbook N7). The grid and
  preview are editing aids only and never appear in the saved image (N8).

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

1. **Add photos** — pick your three brackets at once (dark protects highlights,
   normal, bright opens shadows). They sort themselves darkest → brightest.
2. In the **Align** panel, tap **Auto-align**, then fine-tune each layer with the
   arrows until the Difference preview goes dark.
3. Adjust the weight sliders for punchier contrast or richer colour.
4. **Merge exposures**, then **Save to Photos**.

Inputs are worked at up to 2560 px on the long edge (see `MAX_EDGE` in
`src/main.ts`) to keep memory predictable on phones.

## Project layout

```
src/
  main.ts          UI, intake, alignment panel, worker orchestration, persistence
  merge.worker.ts  pipeline: linearize -> apply offsets -> fuse -> ImageData
  fusion.ts        Mertens exposure fusion (pyramid blending) — pure engine
  align.ts         Median Threshold Bitmap offsets + integer shift — pure engine
  engine.test.ts   Vitest unit tests for the pure engine
scripts/
  gen-icons.mjs           zero-dependency PWA icon generator
  gen-test-exposures.mjs  synthetic bracketed test scene
  e2e.mjs                 headless end-to-end test (intake, align, merge)
```

The engine (`fusion.ts`, `align.ts`) is framework-free and DOM-free, so it is
unit-testable and reused unchanged on both the interactive and export paths.

## Testing

```bash
npm run lint            # ESLint
npm test                # Vitest — pure-engine unit tests
npm run build           # tsc --noEmit + Vite build

# End-to-end (headless Chromium):
npm run test:fixtures   # generate synthetic brackets in scratch-test/
npm run preview &        # serve the built app on :4173
npm run test:e2e         # drive intake, the align controls, and the real merge
```

CI runs `verify` (lint · typecheck · test · build) as a gate before `deploy`;
only `main` deploys to Pages.

## Conformance & deliberate deviations

Built against *The Personal PWA Playbook*. Deliberate deviations, with reasons:

- **Vanilla TS, flat `src/` layout** (not React + `engine/state/ui/features`).
  The playbook permits vanilla for a genuinely single-screen tool; the engine is
  still kept pure and DOM-free, which is the load-bearing part of that rule.
- **Dark theme only.** It's a photo tool — light chrome skews perceived colour.
  (The playbook lists this exact case as an acceptable deviation.)
- **`MAX_EDGE` = 2560 px** rather than ~2048, a deliberate quality/΅memory
  trade-off for the fixed-output merge.
- **Media not yet persisted to IndexedDB** — settings and nudges persist to
  `localStorage`; restoring the actual photos across a reload is a future step.
- **Manual mask/brush blending not built** — "manual blending" here means manual
  pixel *registration* feeding the Mertens blend, not region masking.
