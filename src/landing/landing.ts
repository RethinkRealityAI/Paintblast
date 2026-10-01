// PaintBlast MR landing overlay.
//
// Deliberately framework-free and IWSDK-free: it renders instantly on page
// load (World.create takes seconds to boot Havok/assets), then main.ts hands
// it the World via bindWorld() to wire the ENTER AR button and auto-hide.
//
// The whole page is a paintable surface — every click stamps a tinted splat
// onto a full-viewport canvas, using the same splat masks the game uses.

import './landing.css';

/** Palette must visually match PALETTE_COLORS in src/types.ts. */
const PAINT_HEX = ['#ff6b6b', '#ffca57', '#48dbfb', '#4dcc85'] as const;
const SPLAT_MASKS = ['/textures/splat.png', '/landing/splat-a.png'] as const;

interface WorldLike {
  launchXR(): void;
}

export interface LandingHandle {
  /** Wire the ENTER AR button to a booted World. */
  bindWorld(world: WorldLike): void;
  /**
   * Show/hide the overlay. main.ts drives this from world.visibilityState
   * (it owns the real VisibilityState enum; this module stays IWSDK-free).
   */
  setVisible(visible: boolean): void;
}

export function initLanding(): LandingHandle {
  const root = document.getElementById('landing-root');
  if (!root) {
    // Landing markup missing (e.g. a stripped-down embed) — no-op handle.
    return { bindWorld: () => undefined, setVisible: () => undefined };
  }

  root.innerHTML = `
    <canvas id="pb-splat-canvas"></canvas>
    <div class="pb-page">
      <nav class="pb-nav">
        <span class="pb-wordmark">PAINTBLAST MR</span>
        <span class="pb-chip">Built on Meta Immersive Web SDK</span>
      </nav>

      <section class="pb-hero">
        <h1 class="pb-title">PAINTBLAST</h1>
        <p class="pb-tagline">Your room is the arena.</p>
        <p class="pb-sub">
          Rogue robots are loose in your space. Blast them with paint that
          sticks to your real walls and furniture &mdash; then switch to chill
          mode and just make art.
        </p>
        <div class="pb-cta-row">
          <button id="pb-enter" class="pb-btn pb-btn-primary">ENTER AR</button>
          <button id="pb-qr-toggle" class="pb-btn pb-btn-secondary">PLAY ON QUEST</button>
        </div>
        <div id="pb-qr-card" class="pb-qr-card">
          <img src="/landing/qr-play.png" alt="QR code for paintblast-mr.netlify.app" />
          <p>Glance at this code in passthrough on Quest 3 / 3S,<br/>tap Open Link, then press ENTER AR.</p>
        </div>
        <p class="pb-hint">Psst &mdash; click anywhere. Try the paint.</p>
      </section>

      <section class="pb-features">
        <div class="pb-card" style="--card-accent:#ff6b6b; --card-img:url('/landing/card-robots.png')">
          <div class="pb-card-body">
            <h3>Robot waves</h3>
            <p>Bots materialize around your actual room on a spawn ring. Pop them fast to build a combo multiplier.</p>
          </div>
        </div>
        <div class="pb-card" style="--card-accent:#ffca57; --card-img:url('/landing/card-paints.png')">
          <div class="pb-card-body">
            <h3>Four kinds of paint</h3>
            <p>Normal splats. Bouncy ricochets three times. Sticky welds to whatever it hits. Splash bursts into a nine-splat flower.</p>
          </div>
        </div>
        <div class="pb-card" style="--card-accent:#48dbfb; --card-img:url('/landing/card-room.png')">
          <div class="pb-card-body">
            <h3>It knows your room</h3>
            <p>Meta scene understanding turns your walls, desk, and couch into the playfield &mdash; paint sticks where it lands.</p>
          </div>
        </div>
        <div class="pb-card" style="--card-accent:#4dcc85; --card-img:url('/landing/card-chill.png')">
          <div class="pb-card-body">
            <h3>Chill mode</h3>
            <p>No timer, no robots. Throw paint, set up an easel, make a canvas painting, and save it as a PNG.</p>
          </div>
        </div>
      </section>

      <div class="pb-controls">
        <span><b>Trigger / pinch / thwip</b> fire</span>
        <span><b>Tap the wrist palette</b> switch paint &amp; webs</span>
        <span><b>A button</b> start round</span>
      </div>

      <p class="pb-footer">PaintBlast MR &middot; a RethinkReality experiment &middot; Quest 3 / 3S &middot; nothing to install</p>
    </div>
  `;

  const canvas = root.querySelector<HTMLCanvasElement>('#pb-splat-canvas')!;
  const page = root.querySelector<HTMLElement>('.pb-page')!;
  const enterBtn = root.querySelector<HTMLButtonElement>('#pb-enter')!;
  const qrToggle = root.querySelector<HTMLButtonElement>('#pb-qr-toggle')!;
  const qrCard = root.querySelector<HTMLElement>('#pb-qr-card')!;

  // ---- interactive splatter canvas -------------------------------------

  const ctx = canvas.getContext('2d');
  const masks: HTMLImageElement[] = SPLAT_MASKS.map((src) => {
    const img = new Image();
    img.src = src;
    return img;
  });
  // The masks are white splats on OPAQUE black — they carry no alpha channel,
  // so compositing tricks against their alpha keep the black box. Instead each
  // mask is converted once into an "alpha sprite": white pixels whose alpha IS
  // the mask's luminance. Colorizing is then a simple source-in fill.
  const alphaSprites: Array<HTMLCanvasElement | null> = masks.map(() => null);

  function alphaSpriteFor(maskIndex: number): HTMLCanvasElement | null {
    const cached = alphaSprites[maskIndex];
    if (cached) return cached;
    const mask = masks[maskIndex];
    if (!mask.complete || mask.naturalWidth === 0) return null;

    const sprite = document.createElement('canvas');
    sprite.width = mask.naturalWidth;
    sprite.height = mask.naturalHeight;
    const spriteCtx = sprite.getContext('2d', { willReadFrequently: true });
    if (!spriteCtx) return null;
    spriteCtx.drawImage(mask, 0, 0);
    const image = spriteCtx.getImageData(0, 0, sprite.width, sprite.height);
    const px = image.data;
    for (let i = 0; i < px.length; i += 4) {
      // Luminance → alpha; color flattened to white for tinting.
      const lum = Math.max(px[i], px[i + 1], px[i + 2]);
      px[i] = 255;
      px[i + 1] = 255;
      px[i + 2] = 255;
      px[i + 3] = lum;
    }
    spriteCtx.putImageData(image, 0, 0);
    alphaSprites[maskIndex] = sprite;
    return sprite;
  }

  // Offscreen scratch canvas used to tint the alpha sprite per splat.
  const tintCanvas = document.createElement('canvas');
  const tintCtx = tintCanvas.getContext('2d');

  function resizeCanvas() {
    canvas.width = root!.clientWidth;
    canvas.height = root!.clientHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  function stampSplat(x: number, y: number, size: number, hex: string) {
    if (!ctx || !tintCtx) return;
    const sprite = alphaSpriteFor(Math.floor(Math.random() * masks.length));
    if (!sprite) return;

    const s = Math.round(size);
    tintCanvas.width = s;
    tintCanvas.height = s;
    tintCtx.clearRect(0, 0, s, s);
    tintCtx.drawImage(sprite, 0, 0, s, s);
    tintCtx.globalCompositeOperation = 'source-in';
    tintCtx.fillStyle = hex;
    tintCtx.fillRect(0, 0, s, s);
    tintCtx.globalCompositeOperation = 'source-over';

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.random() * Math.PI * 2);
    ctx.globalAlpha = 0.82 + Math.random() * 0.18;
    // Quick two-step "pop": draw small, then full-size a frame later.
    ctx.drawImage(tintCanvas, -s * 0.35, -s * 0.35, s * 0.7, s * 0.7);
    requestAnimationFrame(() => {
      ctx.save();
      ctx.translate(x, y);
      ctx.globalAlpha = 0.92;
      ctx.drawImage(tintCanvas, -s / 2, -s / 2, s, s);
      ctx.restore();
    });
    ctx.restore();
  }

  page.addEventListener('pointerdown', (event) => {
    // Buttons, links, and cards handle their own clicks — don't paint on them.
    const target = event.target as HTMLElement;
    if (target.closest('button, a, img')) return;
    const hex = PAINT_HEX[Math.floor(Math.random() * PAINT_HEX.length)];
    stampSplat(event.clientX, event.clientY, 90 + Math.random() * 150, hex);
  });

  // A few decorative splats once the masks are ready, framing the hero.
  window.addEventListener('load', () => {
    const w = canvas.width;
    const h = canvas.height;
    const spots: Array<[number, number, number]> = [
      [w * 0.08, h * 0.2, 150],
      [w * 0.93, h * 0.3, 120],
      [w * 0.12, h * 0.82, 130],
      [w * 0.88, h * 0.78, 160],
    ];
    spots.forEach(([x, y, size], i) =>
      setTimeout(() => stampSplat(x, y, size, PAINT_HEX[i % PAINT_HEX.length]), 350 + i * 220),
    );
  });

  // ---- QR card / AR support ---------------------------------------------

  qrToggle.addEventListener('click', () => qrCard.classList.toggle('pb-open'));

  const xr = (navigator as Navigator & { xr?: { isSessionSupported(m: string): Promise<boolean> } }).xr;
  if (!xr) {
    enterBtn.style.display = 'none';
    qrCard.classList.add('pb-open');
  } else {
    xr.isSessionSupported('immersive-ar')
      .then((supported) => {
        if (!supported) {
          enterBtn.style.display = 'none';
          qrCard.classList.add('pb-open');
        }
      })
      .catch(() => undefined);
  }

  // ---- world hookup ------------------------------------------------------

  let boundWorld: WorldLike | undefined;

  enterBtn.addEventListener('click', () => {
    boundWorld?.launchXR();
  });

  // Disabled until the World is ready — the label still reads ENTER AR and
  // enables within a couple of seconds, which beats a dead click.
  enterBtn.disabled = true;

  return {
    bindWorld(world: WorldLike) {
      boundWorld = world;
      enterBtn.disabled = false;
    },
    setVisible(visible: boolean) {
      root.classList.toggle('pb-hidden', !visible);
    },
  };
}
