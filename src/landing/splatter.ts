// Neon paint layer for the landing page.
//
// The page is a paintable surface: a click stamps a glowing splat, flings a
// few droplets and lets one to three drips run down from it. Splats live in
// PAGE coordinates (they scroll with the content, like paint on a wall) but are
// drawn onto a single viewport-sized canvas, so memory stays at one screen of
// pixels however long the page is. The canvas only redraws while something is
// animating or the page scrolled; at rest it costs nothing.
//
// Framework-free and IWSDK-free, like the rest of src/landing.

/** Neon art-direction palette (coral, amber, cyan, lime, violet). */
export const NEON_HEX = ['#ff4f81', '#ffd23f', '#48dbfb', '#b6ff3b', '#b84dff'] as const;

/** Alpha-channel splat masks (white, alpha = paint). Built from the game's masks. */
const MASK_URLS = ['/landing/mask-splat-1.webp', '/landing/mask-splat-2.webp'] as const;

/** Oldest splats are dropped past this many (they are cheap, but not free). */
const MAX_SPLATS = 90;
const MAX_DRIPS = 160;
const MAX_DROPLETS = 240;

/** Milliseconds of the splat "pop" (small, overshoot, settle). */
const POP_MS = 240;
/** Milliseconds a flung droplet takes to land. */
const DROPLET_MS = 170;

/**
 * Overshoot ease (easeOutBack). 0 → 0, 1 → 1, peaks a little above 1 on the
 * way. Pure; exported for tests.
 */
export function easeOutBack(t: number, overshoot = 1.70158): number {
  const x = Math.min(1, Math.max(0, t)) - 1;
  return 1 + (overshoot + 1) * x * x * x + overshoot * x * x;
}

/**
 * How far a drip has run after `ageMs`, in px: fast at first, slowing to a
 * stop at `maxLen` after `durationMs` (paint thickens as it runs). Pure;
 * exported for tests.
 */
export function dripLength(ageMs: number, maxLen: number, durationMs: number): number {
  if (ageMs <= 0 || maxLen <= 0) return 0;
  const t = Math.min(1, ageMs / Math.max(1, durationMs));
  // easeOutCubic
  const e = 1 - (1 - t) * (1 - t) * (1 - t);
  return maxLen * e;
}

interface Splat {
  x: number;
  y: number;
  size: number;
  rot: number;
  born: number;
  sprite: HTMLCanvasElement;
}

interface Drip {
  x: number;
  y: number;
  width: number;
  maxLen: number;
  duration: number;
  born: number;
  color: string;
}

interface Droplet {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  r: number;
  born: number;
  color: string;
}

export interface SplatterLayer {
  /** Stamp a splat at viewport coordinates (clientX/Y). */
  splatAtClient(clientX: number, clientY: number, size?: number, color?: string): void;
  /** Stamp a splat at page coordinates (relative to the scroll container's content). */
  splatAtPage(pageX: number, pageY: number, size?: number, color?: string): void;
  /** Stop/start redrawing (the page hides while immersive). */
  setActive(active: boolean): void;
  /** The colour the next splat will use (the reticle shows it). */
  nextColor(): string;
}

/**
 * @param canvas    a fixed, viewport-sized canvas above the content
 * @param scroller  the element that scrolls (its scrollTop is the page offset)
 */
export function createSplatterLayer(
  canvas: HTMLCanvasElement,
  scroller: HTMLElement,
  reducedMotion: boolean,
): SplatterLayer {
  const ctx = canvas.getContext('2d');
  const splats: Splat[] = [];
  const drips: Drip[] = [];
  const droplets: Droplet[] = [];
  let colorIndex = Math.floor(Math.random() * NEON_HEX.length);
  let active = true;
  let frameQueued = false;
  let dpr = 1;

  const masks: HTMLImageElement[] = MASK_URLS.map((src) => {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    return img;
  });

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    queue();
  }

  /** Pre-tinted, pre-glowed sprite: the per-frame draw is one drawImage. */
  function buildSprite(size: number, color: string): HTMLCanvasElement | null {
    const loaded = masks.filter((m) => m.complete && m.naturalWidth > 0);
    if (loaded.length === 0) return null;
    const mask = loaded[Math.floor(Math.random() * loaded.length)];
    const pad = Math.round(size * 0.18);
    const px = Math.max(8, Math.round((size + pad * 2) * dpr));
    const inner = Math.round(size * dpr);
    const off = Math.round(pad * dpr);

    // Tint: mask → source-in fill.
    const tint = document.createElement('canvas');
    tint.width = inner;
    tint.height = inner;
    const tctx = tint.getContext('2d');
    if (!tctx) return null;
    tctx.drawImage(mask, 0, 0, inner, inner);
    tctx.globalCompositeOperation = 'source-in';
    tctx.fillStyle = color;
    tctx.fillRect(0, 0, inner, inner);

    // Glow + body + a wet highlight, baked once.
    const sprite = document.createElement('canvas');
    sprite.width = px;
    sprite.height = px;
    const sctx = sprite.getContext('2d');
    if (!sctx) return null;
    sctx.shadowColor = color;
    sctx.shadowBlur = size * 0.12 * dpr;
    sctx.drawImage(tint, off, off);
    sctx.shadowBlur = 0;
    sctx.globalAlpha = 0.95;
    sctx.drawImage(tint, off, off);
    // Gloss: a soft white sheen clipped to the paint, top-left lit.
    sctx.globalCompositeOperation = 'source-atop';
    const g = sctx.createRadialGradient(px * 0.38, px * 0.34, 0, px * 0.38, px * 0.34, px * 0.42);
    g.addColorStop(0, 'rgba(255,255,255,0.38)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    sctx.fillStyle = g;
    sctx.fillRect(0, 0, px, px);
    sctx.globalCompositeOperation = 'source-over';
    return sprite;
  }

  function nextColor(): string {
    return NEON_HEX[colorIndex % NEON_HEX.length];
  }

  function splatAtPage(pageX: number, pageY: number, size?: number, color?: string) {
    const s = size ?? 110 + Math.random() * 150;
    const c = color ?? nextColor();
    if (!color) colorIndex = (colorIndex + 1) % NEON_HEX.length;
    const sprite = buildSprite(s, c);
    if (!sprite) return;
    const now = performance.now();

    splats.push({ x: pageX, y: pageY, size: s, rot: Math.random() * Math.PI * 2, born: now, sprite });
    if (splats.length > MAX_SPLATS) splats.shift();

    // Flung droplets around the impact.
    const dropletCount = 5 + Math.floor(Math.random() * 6);
    for (let i = 0; i < dropletCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = s * (0.45 + Math.random() * 0.55);
      droplets.push({
        x0: pageX,
        y0: pageY,
        x1: pageX + Math.cos(a) * d,
        y1: pageY + Math.sin(a) * d,
        r: 2 + Math.random() * (s * 0.025),
        born: now,
        color: c,
      });
    }
    while (droplets.length > MAX_DROPLETS) droplets.shift();

    // Drips run from the lower half of the splat.
    const dripCount = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < dripCount; i++) {
      drips.push({
        x: pageX + (Math.random() - 0.5) * s * 0.5,
        y: pageY + s * (0.08 + Math.random() * 0.16),
        width: 3 + Math.random() * (s * 0.03),
        maxLen: s * (0.35 + Math.random() * 0.9),
        duration: 900 + Math.random() * 1300,
        born: now + 120 + Math.random() * 260,
        color: c,
      });
    }
    while (drips.length > MAX_DRIPS) drips.shift();

    queue();
  }

  function splatAtClient(clientX: number, clientY: number, size?: number, color?: string) {
    const rect = scroller.getBoundingClientRect();
    splatAtPage(clientX - rect.left, clientY - rect.top + scroller.scrollTop, size, color);
  }

  function queue() {
    if (frameQueued || !active) return;
    frameQueued = true;
    requestAnimationFrame(draw);
  }

  function draw(now: number) {
    frameQueued = false;
    if (!ctx || !active) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(dpr, 0, 0, dpr, 0, -scroller.scrollTop * dpr);

    const viewTop = scroller.scrollTop;
    const viewBottom = viewTop + h / dpr;
    let animating = false;

    for (const s of splats) {
      const half = s.size * 0.75;
      if (s.y + half < viewTop || s.y - half > viewBottom + 400) continue;
      const age = now - s.born;
      let k = 1;
      if (!reducedMotion && age < POP_MS) {
        k = 0.35 + 0.65 * easeOutBack(age / POP_MS, 2.4);
        animating = true;
      }
      const drawSize = (s.sprite.width / dpr) * k;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.drawImage(s.sprite, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
      ctx.restore();
    }

    for (const d of droplets) {
      const age = now - d.born;
      const t = reducedMotion ? 1 : Math.min(1, Math.max(0, age / DROPLET_MS));
      if (t < 1) animating = true;
      const e = 1 - (1 - t) * (1 - t);
      const x = d.x0 + (d.x1 - d.x0) * e;
      const y = d.y0 + (d.y1 - d.y0) * e;
      if (y < viewTop - 20 || y > viewBottom + 20) continue;
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.arc(x, y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.lineCap = 'round';
    for (const d of drips) {
      const age = now - d.born;
      if (age <= 0 && !reducedMotion) {
        animating = true;
        continue;
      }
      const len = reducedMotion ? d.maxLen : dripLength(age, d.maxLen, d.duration);
      if (!reducedMotion && age < d.duration) animating = true;
      if (d.y + len < viewTop || d.y > viewBottom) continue;
      // Tapering run: a wide stroke near the splat narrowing toward the bulb.
      ctx.strokeStyle = d.color;
      ctx.lineWidth = d.width;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x, d.y + len);
      ctx.stroke();
      // The bead at the end is fatter than the run.
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.arc(d.x, d.y + len, d.width * 0.85, 0, Math.PI * 2);
      ctx.fill();
      // Wet highlight down the left edge.
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = Math.max(1, d.width * 0.22);
      ctx.beginPath();
      ctx.moveTo(d.x - d.width * 0.22, d.y);
      ctx.lineTo(d.x - d.width * 0.22, d.y + len);
      ctx.stroke();
    }

    if (animating) queue();
  }

  resize();
  window.addEventListener('resize', resize);
  scroller.addEventListener('scroll', queue, { passive: true });
  // Splats queued before the masks decoded simply never drew; nothing to redo.
  masks.forEach((m) => m.addEventListener('load', queue));

  return {
    splatAtClient,
    splatAtPage,
    nextColor,
    setActive(next: boolean) {
      active = next;
      if (active) queue();
    },
  };
}
