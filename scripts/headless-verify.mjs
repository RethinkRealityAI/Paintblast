#!/usr/bin/env node
/**
 * Headless visual verification for cloud sessions that have no IWER MCP relay.
 *
 * Usage:
 *   npx vite --config vite.verify.config.ts        # serves http://127.0.0.1:8090
 *   node scripts/headless-verify.mjs [url] [outDir] [inputMode]
 *
 * Boots the dev build in headless Chromium (SwiftShader WebGL), waits for the
 * IWER emulator (`window.IWER_DEVICE`) and the dev-only `window.__PB_WORLD`
 * hook from main.ts, enters the immersive session, switches to hand tracking
 * (or controllers), loads web ammo so the forearm shooters show, and
 * screenshots a fixed set of poses into outDir:
 *
 *   01-first-person.png  right arm extended forward, palm down, seen from the eyes
 *   02-side-view.png     the same arm from the side — is the shooter parallel to it?
 *   03-thwip-pose.png    wrist bent back (palm forward), from the side
 *   04-palm-up.png       left forearm supinated under the eyes: pads + palette
 *   05-aim-ray.png       a web fired from the right hand, mid-flight, from the side
 *
 * Poses are IWER target-ray transforms (the emulator hangs grip and joints off
 * the ray). Quaternions are [x, y, z, w].
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:8090/';
const outDir = process.argv[3] ?? 'verify-shots';
const inputMode = process.argv[4] ?? 'hand';
mkdirSync(outDir, { recursive: true });

const yaw = (deg) => {
  const h = (deg * Math.PI) / 360;
  return [0, Math.sin(h), 0, Math.cos(h)];
};
const pitch = (deg) => {
  const h = (deg * Math.PI) / 360;
  return [Math.sin(h), 0, 0, Math.cos(h)];
};
const roll = (deg) => {
  const h = (deg * Math.PI) / 360;
  return [0, 0, Math.sin(h), Math.cos(h)];
};
/** Hamilton product a * b, both [x, y, z, w]. */
const mul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM ?? undefined,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.IWER_DEVICE !== undefined, null, {
  timeout: 60000,
});
await page.waitForFunction(() => window.__PB_WORLD !== undefined, null, {
  timeout: 120000,
});

await page.evaluate((mode) => {
  const d = window.IWER_DEVICE;
  // 'programmatic' stops the DevUI's own rig from overwriting scripted poses
  // every frame — the same switch the MCP tools flip.
  d.controlMode = 'programmatic';
  d.primaryInputMode = mode;
  d.grantOfferedSession();
}, inputMode);
await page.waitForTimeout(3000);

// The emulator's hand meshes stream from a CDN that may be unreachable, so
// draw the tracked joints ourselves (skin-coloured dots) plus a forearm proxy:
// a 25 cm rod running straight back from the wrist joint along its +Z (the
// proximal axis), i.e. where the forearm is when the wrist is neutral.
await page.evaluate(() => {
  const w = window.__PB_WORLD;
  const T = window.__PB_THREE;
  const dotGeo = new T.SphereGeometry(0.007, 8, 6);
  const skin = new T.MeshBasicMaterial({ color: 0xe0ac8a });
  const armGeo = new T.CylinderGeometry(0.028, 0.034, 0.25, 12);
  armGeo.translate(0, 0.125, 0);
  armGeo.rotateX(Math.PI / 2);
  const armMat = new T.MeshBasicMaterial({
    color: 0xc98d6b,
    transparent: true,
    opacity: 0.55,
  });
  const rigs = {};
  for (const side of ['left', 'right']) {
    const dots = [];
    for (let i = 0; i < 25; i++) {
      const m = new T.Mesh(dotGeo, skin);
      w.scene.add(m);
      dots.push(m);
    }
    const arm = new T.Mesh(armGeo, armMat);
    w.scene.add(arm);
    rigs[side] = { dots, arm };
  }
  const tick = () => {
    for (const side of ['left', 'right']) {
      const adapter = w.input.visualAdapters.hand[side];
      const grip = w.player.gripSpaces[side];
      const tr = adapter?.jointTransforms;
      const rig = rigs[side];
      const show = !!tr && !!grip && w.input.isPrimary('hand', side);
      rig.arm.visible = show;
      for (const d of rig.dots) d.visible = show;
      if (!show) continue;
      grip.updateWorldMatrix(true, false);
      for (let i = 0; i < 25 && i * 16 + 15 < tr.length; i++) {
        const d = rig.dots[i];
        d.matrixAutoUpdate = false;
        d.matrix.fromArray(tr, i * 16).premultiply(grip.matrixWorld);
        d.matrixWorldNeedsUpdate = true;
      }
      // Joint 0 is the wrist in the runtime's (enum) order.
      rig.arm.matrixAutoUpdate = false;
      rig.arm.matrix.fromArray(tr, 0).premultiply(grip.matrixWorld);
      rig.arm.matrixWorldNeedsUpdate = true;
    }
    requestAnimationFrame(tick);
  };
  tick();
});

// Web ammo on, so the forearm hardware is visible. Sandbox firing is allowed
// in Idle, which is the phase we are in.
await page.evaluate(() => {
  const g = window.__PB_WORLD.globals;
  g.activeStyle.value = 1;
});

async function pose({ head, headQ, left, leftQ, right, rightQ }) {
  await page.evaluate(
    ({ head, headQ, left, leftQ, right, rightQ }) => {
      const d = window.IWER_DEVICE;
      const inputs = d.primaryInputMode === 'hand' ? d.hands : d.controllers;
      d.position.set(...head);
      d.quaternion.set(...headQ);
      inputs.left.position.set(...left);
      inputs.left.quaternion.set(...leftQ);
      inputs.right.position.set(...right);
      inputs.right.quaternion.set(...rightQ);
    },
    { head, headQ, left, leftQ, right, rightQ },
  );
  // Let several frames run so smoothing settles.
  await page.waitForTimeout(1500);
}

const ID = [0, 0, 0, 1];
const leftParked = [-0.35, 0.9, -0.1];
const armForward = {
  right: [0.18, 1.32, -0.55],
  rightQ: ID,
  left: leftParked,
  leftQ: ID,
};

await pose({ head: [0.05, 1.55, 0.05], headQ: pitch(-25), ...armForward });
await page.screenshot({ path: join(outDir, '01-first-person.png') });

// Camera off to the right of the arm, looking left (-X) at it.
const side = { head: [0.55, 1.36, -0.42], headQ: yaw(90) };
await pose({ ...side, ...armForward });
await page.screenshot({ path: join(outDir, '02-side-view.png') });

// Wrist bent back ~60 degrees: the web-shooter pose.
await pose({
  ...side,
  ...armForward,
  rightQ: pitch(60),
});
await page.screenshot({ path: join(outDir, '03-thwip-pose.png') });

// Left forearm palm-up under the eyes.
await pose({
  head: [0, 1.6, 0.05],
  headQ: pitch(-55),
  left: [-0.05, 1.18, -0.32],
  leftQ: mul(yaw(-35), roll(180)),
  right: [0.35, 0.9, -0.1],
  rightQ: ID,
});
await page.screenshot({ path: join(outDir, '04-palm-up.png') });

// Fire a web from the right hand, extended forward; catch it in flight.
await pose({ ...side, ...armForward });
await page.evaluate(() => {
  const w = window.__PB_WORLD;
  for (const s of w.getSystems?.() ?? []) {
    if (s.constructor?.name === 'WebShooterSystem') {
      s.fireGesture(1, performance.now() + 10000);
    }
  }
});
await page.waitForTimeout(120);
await page.screenshot({ path: join(outDir, '05-aim-ray.png') });

console.log(JSON.stringify({ outDir, inputMode, errors: errors.slice(0, 20) }, null, 2));
await browser.close();
