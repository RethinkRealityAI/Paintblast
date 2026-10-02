#!/usr/bin/env node
/**
 * Landing-page screenshots for headless review (cloud sessions, no browser pane).
 *
 *   npx vite --config vite.verify.config.ts --port 8094 --strictPort
 *   PW_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *     node tests/visual/landing-shots.mjs [url] [outDir]
 *
 * Writes desktop (1440x900) and mobile (390x844) full-page shots, plus a
 * desktop viewport shot after a few simulated paint clicks. The landing
 * overlay is its own scroll container (#landing-root), so the full-page shot
 * first lets the document scroll instead.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:8094/landing-preview.html';
const outDir = process.argv[3] ?? 'verify-shots/landing';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM ?? undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

async function shoot(name, viewport, opts = {}) {
  const page = await browser.newPage({
    viewport,
    deviceScaleFactor: opts.dpr ?? 1,
    hasTouch: !!opts.touch,
    isMobile: !!opts.touch,
    reducedMotion: opts.reducedMotion ?? 'no-preference',
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(url, { waitUntil: 'load' });
  // Lazy images inside the overlay's own scroller load late headlessly; the
  // shot is about layout, so load them all up front.
  await page.evaluate(() => document.querySelectorAll('img[loading=lazy]').forEach((i) => (i.loading = 'eager')));
  await page.waitForTimeout(2200);

  if (opts.paint) {
    await page.mouse.move(viewport.width * 0.7, viewport.height * 0.55);
    for (const [fx, fy] of [[0.3, 0.7], [0.75, 0.62], [0.55, 0.85]]) {
      await page.mouse.click(viewport.width * fx, viewport.height * fy);
      await page.waitForTimeout(250);
    }
    await page.mouse.move(viewport.width * 0.42, viewport.height * 0.58);
    await page.waitForTimeout(1600);
    await page.screenshot({ path: join(outDir, `${name}-viewport.png`) });
  }

  if (opts.fullPage !== false) {
    // Reveal every section (IntersectionObserver only fires as you scroll).
    await page.evaluate(async () => {
      const root = document.getElementById('landing-root');
      for (let y = 0; y < root.scrollHeight; y += 400) {
        root.scrollTop = y;
        await new Promise((r) => setTimeout(r, 60));
      }
      root.scrollTop = 0;
    });
    await page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 15000 });
    await page.waitForTimeout(900);
    // Let the document scroll instead of the overlay, so fullPage sees it all
    // while 100vh sections keep their real viewport height.
    await page.addStyleTag({
      content: '#landing-root{position:relative!important;inset:auto!important;overflow:visible!important}',
    });
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(outDir, `${name}-full.png`), fullPage: true });
  }
  console.log(name, errors.length ? errors : 'no errors');
  await page.close();
}

await shoot('desktop', { width: 1440, height: 900 }, { paint: true });
await shoot('mobile', { width: 390, height: 844 }, { touch: true, dpr: 1 });
await browser.close();
