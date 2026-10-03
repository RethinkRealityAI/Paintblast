// Round 10: pure helpers for the Studio (Chill mode's activities).
// No IWSDK imports - unit-tested directly. StudioSystem and EaselSystem use them.

import { CanvasShape } from './types';

// ---- Stencil coverage ---------------------------------------------------------

/**
 * Sample an RGBA image's red channel (a white-on-black mask) into an `n x n`
 * inside/outside grid, nearest-neighbour at cell centres. Called once per
 * stencil at load, never per frame.
 *
 * @param out Receives 1 for inside, 0 outside. Length n*n, caller-owned.
 * @returns how many cells are inside.
 */
export function sampleMaskToGrid(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  n: number,
  threshold: number,
  out: Uint8Array,
): number {
  let inside = 0;
  for (let gy = 0; gy < n; gy++) {
    const py = Math.min(height - 1, Math.floor(((gy + 0.5) / n) * height));
    for (let gx = 0; gx < n; gx++) {
      const px = Math.min(width - 1, Math.floor(((gx + 0.5) / n) * width));
      const v = rgba[(py * width + px) * 4] >= threshold ? 1 : 0;
      out[gy * n + gx] = v;
      inside += v;
    }
  }
  return inside;
}

/**
 * The stencil's paint coverage: a fixed n x n grid over the square board,
 * a mask of which cells are inside the shape, and which have been painted.
 * Stamps are rasterised as discs; the inside/outside tallies update
 * incrementally, so scoring a stamp costs only the cells it touches.
 *
 * Allocates its two arrays once; `reset()` and `setMask()` reuse them.
 */
export class CoverageGrid {
  readonly n: number;
  readonly inside: Uint8Array;
  readonly painted: Uint8Array;
  private insideCount = 0;
  private paintedIn = 0;
  private paintedOut = 0;

  constructor(n: number) {
    this.n = Math.max(1, Math.floor(n));
    this.inside = new Uint8Array(this.n * this.n);
    this.painted = new Uint8Array(this.n * this.n);
  }

  /** Recount after `inside` was rewritten (e.g. by sampleMaskToGrid), and wipe paint. */
  setMask(): void {
    let c = 0;
    for (let i = 0; i < this.inside.length; i++) c += this.inside[i];
    this.insideCount = c;
    this.reset();
  }

  /** Clear the paint, keep the mask. */
  reset(): void {
    this.painted.fill(0);
    this.paintedIn = 0;
    this.paintedOut = 0;
  }

  /**
   * Paint a disc at board UV (u right, v DOWN, both 0..1) with radius `r` in
   * UV units. Off-board parts are clipped.
   */
  stamp(u: number, v: number, r: number): void {
    if (!Number.isFinite(u) || !Number.isFinite(v) || !(r > 0)) return;
    const n = this.n;
    const cx = u * n;
    const cy = v * n;
    const rr = r * n;
    const x0 = Math.max(0, Math.floor(cx - rr));
    const x1 = Math.min(n - 1, Math.ceil(cx + rr));
    const y0 = Math.max(0, Math.floor(cy - rr));
    const y1 = Math.min(n - 1, Math.ceil(cy + rr));
    const r2 = rr * rr;
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        if (dx * dx + dy * dy > r2) continue;
        const i = y * n + x;
        if (this.painted[i]) continue;
        this.painted[i] = 1;
        if (this.inside[i]) this.paintedIn++;
        else this.paintedOut++;
      }
    }
  }

  /** Cells inside the shape. */
  get insideCells(): number {
    return this.insideCount;
  }

  /** Fraction of the shape painted, 0..1. */
  get fill(): number {
    return this.insideCount > 0 ? this.paintedIn / this.insideCount : 0;
  }

  /** Paint outside the shape, as a fraction of the shape's own area (can exceed 1). */
  get spill(): number {
    return this.insideCount > 0 ? this.paintedOut / this.insideCount : 0;
  }
}

/** Score 0..1: coverage minus a penalty for spill. */
export function coverageScore(fill: number, spill: number, spillPenalty: number): number {
  const s = (Number.isFinite(fill) ? fill : 0) - spillPenalty * (Number.isFinite(spill) ? spill : 0);
  return s < 0 ? 0 : s > 1 ? 1 : s;
}

/** Stars (0..thresholds.length) for a score: one per threshold reached. */
export function starsFor(score: number, thresholds: readonly number[]): number {
  let stars = 0;
  for (const t of thresholds) if (score >= t) stars++;
  return stars;
}

/** Whole percent, clamped 0..100, for the HUD. */
export function percent(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}

/** The stencil's status line. ASCII (gotcha 24). */
export function stencilLine(label: string, fill: number, spill: number): string {
  return `${label}: ${percent(fill)}% filled, ${percent(spill)}% spill`;
}

// ---- Canvas placement -------------------------------------------------------------

/** The slice of STUDIO the placement helpers read. */
export interface CanvasPlacementConfig {
  readonly canvasBelowEyes: number;
  readonly canvasMinCentre: number;
  readonly canvasMaxCentre: number;
  readonly wallBaseDist: number;
  readonly wallScaleMin: number;
  readonly wallScaleMax: number;
  readonly floatDistance: number;
}

/** Canvas centre height for a head at `headY` (clamped; non-finite -> 1.2 m clamped). */
export function canvasCentreHeight(headY: number, cfg: CanvasPlacementConfig): number {
  const y = Number.isFinite(headY) && headY > 0.3 ? headY - cfg.canvasBelowEyes : 1.2;
  return Math.min(cfg.canvasMaxCentre, Math.max(cfg.canvasMinCentre, y));
}

/** Board scale for a wall `dist` metres away: keeps its apparent size, clamped. */
export function wallCanvasScale(dist: number, cfg: CanvasPlacementConfig): number {
  if (!(dist > 0) || !(cfg.wallBaseDist > 0)) return cfg.wallScaleMin;
  return Math.min(cfg.wallScaleMax, Math.max(cfg.wallScaleMin, dist / cfg.wallBaseDist));
}

/** Where the canvas hangs, and how big. @see resolveCanvasPlacement */
export interface CanvasPlacement {
  /** true when it hangs on a real wall. */
  onWall: boolean;
  x: number;
  y: number;
  z: number;
  /** Yaw (about +Y) that turns the board's +Z face toward the player. */
  yaw: number;
  scale: number;
}

/**
 * The canvas's pose: on the wall hit when there is one (point + normal x
 * standoff, facing along the normal, grown with distance), else floating
 * `floatDistance` ahead of the head along its flattened forward, facing back.
 *
 * @param wallDist distance to the wall hit, or Infinity for none.
 * @param fx,fz head forward, flattened (need not be normalised).
 * @param nx,nz wall normal (toward the player), only read with a wall.
 */
export function resolveCanvasPlacement(
  headX: number,
  headY: number,
  headZ: number,
  fx: number,
  fz: number,
  wallDist: number,
  px: number,
  pz: number,
  nx: number,
  nz: number,
  standoff: number,
  cfg: CanvasPlacementConfig,
  out: CanvasPlacement,
): CanvasPlacement {
  const y = canvasCentreHeight(headY, cfg);
  out.y = y;
  if (Number.isFinite(wallDist)) {
    const nl = Math.hypot(nx, nz) || 1;
    out.onWall = true;
    out.x = px + (nx / nl) * standoff;
    out.z = pz + (nz / nl) * standoff;
    out.yaw = Math.atan2(nx / nl, nz / nl);
    out.scale = wallCanvasScale(wallDist, cfg);
    return out;
  }
  let len = Math.hypot(fx, fz);
  let ux = fx;
  let uz = fz;
  if (len < 1e-6) {
    ux = 0;
    uz = -1;
    len = 1;
  }
  ux /= len;
  uz /= len;
  out.onWall = false;
  out.x = headX + ux * cfg.floatDistance;
  out.z = headZ + uz * cfg.floatDistance;
  out.yaw = Math.atan2(-ux, -uz);
  out.scale = 1;
  return out;
}

/** The slice of EASEL/STUDIO board sizes {@link shapeBoard} reads. */
export interface ShapeBoardConfig {
  readonly boardWidth: number;
  readonly boardHeight: number;
  readonly canvasPxW: number;
  readonly canvasPxH: number;
  readonly squareBoardSize: number;
  readonly squareCanvasPx: number;
}

/** Board metres + painting pixels for a shape, metres multiplied by `scale`. */
export function shapeBoard(
  shape: number,
  scale: number,
  cfg: ShapeBoardConfig,
): { boardWidth: number; boardHeight: number; canvasPxW: number; canvasPxH: number } {
  const s = scale > 0 && Number.isFinite(scale) ? scale : 1;
  switch (shape) {
    case CanvasShape.Portrait:
      return {
        boardWidth: cfg.boardHeight * s,
        boardHeight: cfg.boardWidth * s,
        canvasPxW: cfg.canvasPxH,
        canvasPxH: cfg.canvasPxW,
      };
    case CanvasShape.Round:
    case CanvasShape.Square:
      return {
        boardWidth: cfg.squareBoardSize * s,
        boardHeight: cfg.squareBoardSize * s,
        canvasPxW: cfg.squareCanvasPx,
        canvasPxH: cfg.squareCanvasPx,
      };
    default:
      return {
        boardWidth: cfg.boardWidth * s,
        boardHeight: cfg.boardHeight * s,
        canvasPxW: cfg.canvasPxW,
        canvasPxH: cfg.canvasPxH,
      };
  }
}

/** Is board-local (lx, ly) on the painted surface? Round boards are a disc. */
export function onBoardSurface(
  shape: number,
  lx: number,
  ly: number,
  halfW: number,
  halfH: number,
): boolean {
  if (Math.abs(lx) > halfW || Math.abs(ly) > halfH) return false;
  if (shape !== CanvasShape.Round) return true;
  const r = Math.min(halfW, halfH);
  return lx * lx + ly * ly <= r * r;
}

// ---- Target range ------------------------------------------------------------------

/** The slice of STUDIO the target spawner reads. */
export interface TargetArcConfig {
  readonly arcDeg: number;
  readonly minDist: number;
  readonly maxDist: number;
  readonly heightBelowEyes: number;
  readonly heightAboveEyes: number;
  readonly minHeight: number;
  readonly maxHeight: number;
}

/**
 * A spawn point in the seated forward arc. `ua, ud, uh` are uniform randoms
 * in [0, 1) (explicit so the mapping is testable): angle across the arc,
 * distance across the band, height across the band. `yaw0` is the head's
 * facing (radians, atan2(-fx, -fz) convention: 0 looks down -Z).
 *
 * @param out Receives [x, y, z].
 */
export function arcSpawnPoint(
  headX: number,
  headY: number,
  headZ: number,
  yaw0: number,
  ua: number,
  ud: number,
  uh: number,
  cfg: TargetArcConfig,
  out: Float32Array | number[],
): void {
  const half = ((cfg.arcDeg * Math.PI) / 180) / 2;
  const yaw = yaw0 + (ua * 2 - 1) * half;
  const dist = cfg.minDist + ud * (cfg.maxDist - cfg.minDist);
  const eye = Number.isFinite(headY) && headY > 0.3 ? headY : 1.2;
  const y = eye - cfg.heightBelowEyes + uh * (cfg.heightBelowEyes + cfg.heightAboveEyes);
  // yaw 0 looks down -Z: forward = (-sin, -cos).
  out[0] = headX - Math.sin(yaw) * dist;
  out[1] = Math.min(cfg.maxHeight, Math.max(cfg.minHeight, y));
  out[2] = headZ - Math.cos(yaw) * dist;
}

/** True when (x, y, z) is at least `minSpacing` from every live point in `points` (xyz-packed). */
export function spacedFrom(
  x: number,
  y: number,
  z: number,
  points: ArrayLike<number>,
  live: ArrayLike<number>,
  minSpacing: number,
): boolean {
  const m2 = minSpacing * minSpacing;
  for (let i = 0; i < live.length; i++) {
    if (!live[i]) continue;
    const dx = points[i * 3] - x;
    const dy = points[i * 3 + 1] - y;
    const dz = points[i * 3 + 2] - z;
    if (dx * dx + dy * dy + dz * dz < m2) return false;
  }
  return true;
}

/** Consecutive hits without a miss, and the best this session. */
export class StreakTracker {
  current = 0;
  best = 0;
  pops = 0;

  hit(): number {
    this.current++;
    this.pops++;
    if (this.current > this.best) this.best = this.current;
    return this.current;
  }

  miss(): void {
    this.current = 0;
  }

  reset(): void {
    this.current = 0;
    this.best = 0;
    this.pops = 0;
  }
}

/** The target range's status line. ASCII. */
export function targetsLine(streak: number, best: number, pops: number, hard: boolean): string {
  return `STREAK ${streak}  BEST ${best}  POPS ${pops}${hard ? '  HARD' : ''}`;
}

/** A vector inside a cone around unit (ax, ay, az): `u1, u2` uniform randoms. */
export function coneDirection(
  ax: number,
  ay: number,
  az: number,
  coneDeg: number,
  u1: number,
  u2: number,
  out: Float32Array | number[],
): void {
  // Orthonormal basis around a.
  let bx = Math.abs(ay) < 0.9 ? 0 : 1;
  let by = Math.abs(ay) < 0.9 ? 1 : 0;
  let bz = 0;
  // t = b x a, normalised; s = a x t.
  let tx = by * az - bz * ay;
  let ty = bz * ax - bx * az;
  let tz = bx * ay - by * ax;
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl;
  ty /= tl;
  tz /= tl;
  bx = ay * tz - az * ty;
  by = az * tx - ax * tz;
  bz = ax * ty - ay * tx;
  const cosMax = Math.cos((coneDeg * Math.PI) / 180);
  const cosT = 1 - u1 * (1 - cosMax);
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const phi = u2 * Math.PI * 2;
  const c = Math.cos(phi) * sinT;
  const s = Math.sin(phi) * sinT;
  out[0] = ax * cosT + tx * c + bx * s;
  out[1] = ay * cosT + ty * c + by * s;
  out[2] = az * cosT + tz * c + bz * s;
}

/** Distance along a ray from height `oy` with vertical component `dy` to the floor (y=0), or Infinity. */
export function floorHitDistance(oy: number, dy: number, maxDist: number): number {
  if (!(dy < -1e-3) || !(oy > 0)) return Number.POSITIVE_INFINITY;
  const t = -oy / dy;
  return t <= maxDist ? t : Number.POSITIVE_INFINITY;
}
