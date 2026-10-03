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
 *   06-round-seated.png  a round started from a seat: robots in the forward arc
 *   07-hit.png           a web fired at the nearest robot (aim assist), on impact
 *
 * Poses are IWER target-ray transforms (the emulator hangs grip and joints off
 * the ray). Quaternions are [x, y, z, w].
 *
 * Round 8 adds a second suite, the gauntlet blasters:
 *
 *   node scripts/headless-verify.mjs [url] [outDir] [hand|controller] gauntlet
 *
 * sets `globals.blasterMode` to BLASTER, WEB and HAND in turn and shoots each
 * (first person, side, front 3/4, left arm, hero close-up, left palm-up),
 * then a skin + paint-colour swap and a fired shot:
 *
 *   <mode>-<blaster|web|hand>-{1-first,2-side,3-front,4-left,5-hero,6-palmup}.png
 *   <mode>-skin-gold.png, <mode>-fire.png
 *
 * With ALIGN=1 a tracked hand aims along its own axis (WEB.handAimSource =
 * 'hand', set at runtime) — the emulator's pointer ray sits ~33 degrees above
 * the emulated hand, which a headset's shoulder-through-hand ray does not, so
 * this is the closer stand-in for how the bracer sits on a real forearm.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:8090/';
const outDir = process.argv[3] ?? 'verify-shots';
const inputMode = process.argv[4] ?? 'hand';
const suite = process.argv[5] ?? 'default';
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
// SwiftShader discards every uikit panel and glyph without this (see the file).
await page.addInitScript({
  path: new URL('./swiftshader-smoothstep-patch.js', import.meta.url).pathname,
});
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

// Let the round-8 enter-AR intro finish (~4 s of game time, ~8 s at headless
// frame rates) so the first shots show the title, not the logo burst. Phase 3
// = Finished; a missing IntroSystem (or INTRO.enabled false) passes at once.
await page.waitForFunction(
  () => {
    const s = window.__PB_WORLD.getSystems?.().find(
      (x) => x.constructor?.name === 'IntroSystem',
    );
    return !s || s.phase === 0 || s.phase === 3;
  },
  null,
  { timeout: 30000 },
).catch(() => console.warn('intro did not finish within 30 s'));

// IWSDK's pointer cursor eases with lerp(a, b, 30 * delta), which diverges
// once frames take > ~66 ms — i.e. always at SwiftShader's ~5 fps — and
// grows into a screen-filling white disc. Harmless at 72 Hz; hide it here.
await page.evaluate(() => {
  const w = window.__PB_WORLD;
  // material.visible, not object.visible: IWSDK rewrites the latter itself.
  for (const c of w.player.children) {
    if (c.isMesh && c.geometry?.type === 'CircleGeometry') c.material.visible = false;
  }
});

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

if (suite === 'gauntlet') {
  await runGauntletSuite();
  await browser.close();
  process.exit(0);
}

// Web ammo on, so the forearm hardware is visible. Sandbox firing is allowed
// in Idle, which is the phase we are in.
await page.evaluate(() => {
  const g = window.__PB_WORLD.globals;
  g.activeStyle.value = 1;
});

/** Quaternion [x,y,z,w] turning a camera (-Z forward, +Y up) at `from` toward `to`. */
function lookQ(from, to) {
  const f = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const fl = Math.hypot(...f);
  const z = f.map((v) => -v / fl);
  let x = [z[2], 0, -z[0]];
  const xl = Math.hypot(...x);
  x = x.map((v) => v / xl);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const [m00, m01, m02] = [x[0], y[0], z[0]];
  const [m10, m11, m12] = [x[1], y[1], z[1]];
  const [m20, m21, m22] = [x[2], y[2], z[2]];
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    return [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
}
function cam(from, to) {
  return { head: from, headQ: lookQ(from, to) };
}

/** Round 8: every blaster mode from six angles, then skins, colour and a shot. */
async function runGauntletSuite() {
  if (process.env.ALIGN) {
    await page.evaluate(async () => {
      // The same URL (HMR stamp included) the app imported, or this would be
      // a second, unrelated instance of the config module.
      const url =
        performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .find((n) => /\/src\/config\.ts/.test(n)) ?? '/src/config.ts';
      const m = await import(url);
      m.WEB.handAimSource = 'hand';
    });
  }
  const g = (fn, arg) => page.evaluate(fn, arg);
  const setMode = (m) => g((m) => { window.__PB_WORLD.globals.blasterMode.value = m; }, m);
  const ID = [0, 0, 0, 1];
  const armForward = { right: [0.18, 1.32, -0.55], rightQ: ID, left: [-0.35, 0.9, -0.1], leftQ: ID };
  const leftForward = { left: [-0.15, 1.3, -0.5], leftQ: ID, right: [0.35, 0.9, -0.1], rightQ: ID };
  const shots = [
    ['1-first', { head: [0.05, 1.55, 0.05], headQ: pitch(-25), ...armForward }],
    ['2-side', { ...cam([0.5, 1.4, -0.52], [0.18, 1.33, -0.6]), ...armForward }],
    ['3-front', { ...cam([0.4, 1.5, -0.86], [0.18, 1.33, -0.56]), ...armForward }],
    ['4-left', { ...cam([-0.46, 1.45, -0.48], [-0.15, 1.31, -0.56]), ...leftForward }],
    ['5-hero', { ...cam([0.45, 1.56, -0.42], [0.17, 1.33, -0.62]), ...armForward }],
    ['6-palmup', {
      head: [0, 1.6, 0.05], headQ: pitch(-55),
      left: [-0.05, 1.18, -0.32], leftQ: mul(yaw(-35), roll(180)),
      right: [0.35, 0.9, -0.1], rightQ: ID,
    }],
  ];
  const names = { 0: 'hand', 1: 'blaster', 2: 'web' };
  for (const m of [1, 2, 0]) {
    await setMode(m);
    await page.waitForTimeout(800);
    for (const [label, p] of shots) {
      await pose(p);
      await page.screenshot({ path: join(outDir, `${inputMode}-${names[m]}-${label}.png`) });
    }
  }
  // Skin + paint colour swap (GOLD RUSH, cyan paint), then a fired shot.
  await setMode(1);
  await g(() => {
    const gl = window.__PB_WORLD.globals;
    gl.blasterSkin.value = 4;
    gl.activeColor.value = [0.2, 0.85, 1.0, 1];
  });
  await pose(shots[4][1]);
  await page.screenshot({ path: join(outDir, `${inputMode}-skin-gold.png`) });
  await g(() => { window.__PB_WORLD.globals.blasterSkin.value = 0; });
  await pose(shots[1][1]);
  await g(() => {
    for (const s of window.__PB_WORLD.getSystems()) {
      if (s.constructor?.name === 'WebShooterSystem') s.fireGesture(1, performance.now() + 10000);
    }
  });
  await page.waitForTimeout(60);
  await page.screenshot({ path: join(outDir, `${inputMode}-fire.png`) });
  const info = await g(() => {
    const w = window.__PB_WORLD;
    const m = w.globals.gauntletMuzzles;
    const gs = w.getSystems().find((s) => s.constructor?.name === 'GauntletSystem');
    return { muzzlesValid: Array.from(m?.valid ?? []), deploy: gs ? Array.from(gs.debugDeploy) : null };
  });
  console.log(JSON.stringify({ outDir, inputMode, suite, ...info, errors: errors.slice(0, 20) }, null, 2));
}

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

// A round, from a seated eye height, looking straight ahead.
const seated = { head: [0, 1.2, 0], headQ: ID };
const parked = { left: leftParked, leftQ: ID, right: [0.35, 0.9, -0.1], rightQ: ID };
await pose({ ...seated, ...parked });
await page.evaluate(() => {
  for (const s of window.__PB_WORLD.getSystems()) {
    if (s.constructor?.name === 'GameStateSystem') s.startGame();
  }
});
await page.waitForTimeout(4500); // 3 s countdown + spawn
await page.screenshot({ path: join(outDir, '06-round-seated.png') });

// Aim the right hand roughly at the first live robot and fire a web.
const target = await page.evaluate(() => {
  const aim = window.__PB_WORLD.globals.aimTargets;
  for (let i = 0; i < aim.capacity; i++) {
    if (aim.active[i]) {
      return [aim.positions[i * 3], aim.positions[i * 3 + 1], aim.positions[i * 3 + 2]];
    }
  }
  return null;
});
if (target) {
  const hand = [0.18, 1.0, -0.3];
  const d = [target[0] - hand[0], target[1] - hand[1], target[2] - hand[2]];
  const len = Math.hypot(...d);
  const u = d.map((v) => v / len);
  // Quaternion turning -Z onto u: axis = (-Z) x u, angle = acos(-Z . u).
  const ax = [0 * u[2] - -1 * u[1], -1 * u[0] - 0 * u[2], 0];
  const cos = -u[2];
  const axLen = Math.hypot(...ax) || 1;
  const half = Math.acos(Math.max(-1, Math.min(1, cos))) / 2;
  const q = [
    (ax[0] / axLen) * Math.sin(half),
    (ax[1] / axLen) * Math.sin(half),
    (ax[2] / axLen) * Math.sin(half),
    Math.cos(half),
  ];
  await pose({ ...seated, left: leftParked, leftQ: ID, right: hand, rightQ: q });
  await page.evaluate(() => {
    for (const s of window.__PB_WORLD.getSystems()) {
      if (s.constructor?.name === 'WebShooterSystem') {
        s.fireGesture(1, performance.now() + 20000);
      }
    }
  });
  // Flight time at web speed to ~1-3 m is 0.1-0.3 s; catch the burst.
  await page.waitForTimeout(Math.round((len / 12) * 1000) + 60);
  await page.screenshot({ path: join(outDir, '07-hit.png') });
}

const alive = await page.evaluate(() => window.__PB_WORLD.globals.targetsAlive.value);
const score = await page.evaluate(() => window.__PB_WORLD.globals.score.value);
console.log(
  JSON.stringify(
    { outDir, inputMode, target, alive, score, errors: errors.slice(0, 20) },
    null,
    2,
  ),
);
await browser.close();
