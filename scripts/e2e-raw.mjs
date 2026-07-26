// RAW decode smoke test: feed a real camera DNG through the app and confirm it
// decodes (via LibRaw WASM) in a NON cross-origin-isolated context — the same
// environment GitHub Pages provides — then merges without error.
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
  console.log('crossOriginIsolated =', await page.evaluate(() => globalThis.crossOriginIsolated))

  // One RAW + two PNGs. The auto-sort probe decodes the DNG via LibRaw.
  const files = ['sample.dng', 'under.png', 'over.png'].map((f) => join(testDir, f))
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('#pick').click(),
  ])
  await chooser.setFiles(files)

  // Success = align panel appears; failure = an error status.
  await Promise.race([
    page.waitForSelector('#align-panel:not([hidden])', { timeout: 90000 }),
    page
      .waitForFunction(() => /failed|Could not|error/i.test(document.querySelector('#status')?.textContent || ''), { timeout: 90000 })
      .then(() => {
        throw new Error('error status while loading RAW')
      }),
  ])

  // Merge and confirm a real output comes out.
  await page.locator('#merge').click()
  await page.waitForSelector('#result:not([hidden])', { timeout: 90000 })
  const dims = await page.evaluate(() => {
    const c = document.querySelector('#output')
    return { w: c.width, h: c.height }
  })
  const status = (await page.locator('#status').textContent())?.trim()
  await page.screenshot({ path: join(testDir, 'raw-app.png'), fullPage: true })

  console.log('RAW MERGE:', JSON.stringify(dims), '| status:', status)
  if (dims.w < 100 || dims.h < 100) throw new Error(`implausible output ${JSON.stringify(dims)}`)
  if (!/Done/i.test(status || '')) throw new Error(`unexpected status: ${status}`)
  console.log('PASS: RAW (DNG) decoded and merged in a non-isolated context.')
} catch (err) {
  console.error('FAIL:', err.message)
  console.error('LOGS:\n' + logs.join('\n'))
  process.exitCode = 1
} finally {
  await browser.close()
}
