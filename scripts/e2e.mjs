// End-to-end smoke test: load the built app, feed three bracketed exposures,
// run the real OpenCV.js fusion in the worker, and verify a plausible result.
import { chromium } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const url = process.env.APP_URL || 'http://localhost:4173/'
const testDir = join(root, 'scratch-test')

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || chromium.executablePath(),
  args: ['--no-sandbox'],
})
const page = await browser.newPage()
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

try {
  await page.goto(url, { waitUntil: 'networkidle' })

  const files = ['under.png', 'mid.png', 'over.png'].map((f) => join(testDir, f))
  for (let i = 0; i < 3; i++) {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator(`.slot[data-index="${i}"]`).click(),
    ])
    await chooser.setFiles(files[i])
    await page.waitForSelector(`.slot[data-index="${i}"].filled`)
  }

  const mergeBtn = page.locator('#merge')
  await mergeBtn.waitFor({ state: 'visible' })
  if (await mergeBtn.isDisabled()) throw new Error('Merge button stayed disabled after 3 files')
  await mergeBtn.click()

  // Wait for the result canvas to appear (OpenCV load + fusion can take a bit).
  await page.waitForSelector('#result:not([hidden])', { timeout: 60000 })
  const status = await page.locator('#status').textContent()

  // Pull pixels from the output canvas and sanity-check the fusion.
  const stats = await page.evaluate(() => {
    const c = document.querySelector('#output')
    const ctx = c.getContext('2d')
    const { width, height } = c
    const d = ctx.getImageData(0, 0, width, height).data
    const lum = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
    const at = (fx, fy) => {
      const x = Math.round(fx * width)
      const y = Math.round(fy * height)
      return lum((y * width + x) * 4) / 255
    }
    let sum = 0
    for (let i = 0; i < d.length; i += 4) sum += lum(i)
    return {
      width,
      height,
      mean: sum / (d.length / 4) / 255,
      sun: at(0.72, 0.28), // should stay bright/defined (from under-exposure)
      foreground: at(0.5, 0.85), // should be lifted out of shadow (from over-exposure)
      sky: at(0.15, 0.15),
    }
  })

  await page.screenshot({ path: join(testDir, 'app-screenshot.png'), fullPage: true })
  // Also export just the merged canvas for inspection.
  const canvasPng = await page.evaluate(() =>
    document.querySelector('#output').toDataURL('image/png'),
  )
  const { writeFileSync } = await import('node:fs')
  writeFileSync(
    join(testDir, 'merged-output.png'),
    Buffer.from(canvasPng.split(',')[1], 'base64'),
  )

  console.log('STATUS:', status)
  console.log('STATS:', JSON.stringify(stats, null, 2))

  const problems = []
  if (stats.width < 100 || stats.height < 100) problems.push('output too small')
  if (stats.mean < 0.3 || stats.mean > 0.8) problems.push(`implausible mean ${stats.mean}`)
  // Over-exposed sky was ~blown white; fusion should recover it below pure white.
  if (stats.sky > 0.9) problems.push(`sky highlights not recovered (${stats.sky})`)
  // Under-exposed foreground was near-black; fusion should lift it out of shadow.
  if (stats.foreground < 0.2) problems.push(`foreground still crushed (${stats.foreground})`)
  if (!/Done/i.test(status || '')) problems.push(`unexpected status: ${status}`)

  if (problems.length) {
    console.error('FAIL:', problems.join('; '))
    console.error('LOGS:\n' + logs.join('\n'))
    process.exitCode = 1
  } else {
    console.log('PASS: highlights recovered, shadows lifted, clean status.')
  }
} catch (err) {
  console.error('ERROR:', err.message)
  console.error('LOGS:\n' + logs.join('\n'))
  process.exitCode = 1
} finally {
  await browser.close()
}
