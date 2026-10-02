#!/usr/bin/env node
/**
 * Enter-AR intro stills (IntroSystem) for headless review.
 *
 *   npx vite --config vite.verify.config.ts --port 8094 --strictPort
 *   PW_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *     node tests/visual/intro-shots.mjs [url] [outDir]
 *
 * Enters the IWER session the way scripts/headless-verify.mjs does (controllers
 * parked low, out of the view), waits for the intro to start, then scrubs its
 * clock to fixed moments and screenshots each. Headless SwiftShader runs
 * ~5 fps, so real-time capture would be a lottery; scrubbing makes the stills
 * repeatable. The particle burst still advances on real frames.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:8094/';
const outDir = process.argv[3] ?? 'verify-shots/intro';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM ?? undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.IWER_DEVICE !== undefined, null, { timeout: 60000 });
await page.waitForFunction(() => window.__PB_WORLD !== undefined, null, { timeout: 120000 });
// Let the background logo texture stream in, as it would before a real ENTER AR.
await page.waitForTimeout(2500);

await page.evaluate(() => {
  const d = window.IWER_DEVICE;
  d.controlMode = 'programmatic';
  d.primaryInputMode = 'controller';
  d.grantOfferedSession();
  // Park both controllers low at the sides so nothing blocks the view.
  for (const [side, x] of [['left', -0.35], ['right', 0.35]]) {
    const c = d.controllers?.[side];
    if (c) c.position.set(x, 0.75, -0.1);
  }
});
await page.waitForFunction(() => window.__PB_WORLD.scene.getObjectByName('IntroRoot')?.visible, null, { timeout: 90000 });

const moments = [
  ['01-splat', 0.16],
  ['02-pop', 0.42],
  ['03-burst', 0.62],
  ['04-hold', 1.6],
  ['05-exit', 3.0],
];
for (const [name, t] of moments) {
  await page.evaluate((t) => {
    const sys = window.__PB_WORLD.getSystems().find((s) => 'exitAt' in s && 'logoAspect' in s);
    sys.t = t;
  }, t);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(outDir, `intro-${name}.png`) });
  console.log(name, t);
}
await browser.close();
