import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { BALLS, EASEL, FIRE, STUDIO, WEB } from '../../src/config';
import {
  CoverageGrid,
  StreakTracker,
  arcSpawnPoint,
  canvasCentreHeight,
  coneDirection,
  coverageScore,
  floorHitDistance,
  onBoardSurface,
  percent,
  resolveCanvasPlacement,
  sampleMaskToGrid,
  shapeBoard,
  spacedFrom,
  starsFor,
  stencilLine,
  targetsLine,
  wallCanvasScale,
} from '../../src/studio';
import type { CanvasPlacement } from '../../src/studio';
import {
  CANVAS_SHAPE_CYCLE,
  CANVAS_SHAPE_LABELS,
  CanvasShape,
  GameEvent,
  STUDIO_ACTIVITY_ORDER,
  StudioActivity,
  isPrintableAscii,
  nextCanvasShape,
} from '../../src/types';

const BOARD_CFG = {
  boardWidth: EASEL.boardWidth,
  boardHeight: EASEL.boardHeight,
  canvasPxW: EASEL.canvasPxW,
  canvasPxH: EASEL.canvasPxH,
  squareBoardSize: STUDIO.squareBoardSize,
  squareCanvasPx: STUDIO.squareCanvasPx,
};

function placement(): CanvasPlacement {
  return { onWall: false, x: 0, y: 0, z: 0, yaw: 0, scale: 0 };
}

/** A grid whose left half is "inside". */
function halfGrid(n = 16): CoverageGrid {
  const g = new CoverageGrid(n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n / 2; x++) g.inside[y * n + x] = 1;
  g.setMask();
  return g;
}

describe('stencil coverage grid', () => {
  it('samples a white-on-black mask into inside cells', () => {
    // 4x4 RGBA image, left two columns white.
    const w = 4;
    const h = 4;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < 2; x++) rgba[(y * w + x) * 4] = 255;
    const out = new Uint8Array(4);
    const inside = sampleMaskToGrid(rgba, w, h, 2, 128, out);
    expect(inside).toBe(2);
    expect(Array.from(out)).toEqual([1, 0, 1, 0]);
  });

  it('counts fill inside the shape and spill outside it', () => {
    const g = halfGrid(16);
    expect(g.insideCells).toBe(128);
    expect(g.fill).toBe(0);
    g.stamp(0.25, 0.5, 0.2); // left half: fill only
    expect(g.fill).toBeGreaterThan(0);
    expect(g.spill).toBe(0);
    g.stamp(0.8, 0.5, 0.1); // right half: spill
    expect(g.spill).toBeGreaterThan(0);
  });

  it('never double counts a cell painted twice', () => {
    const g = halfGrid(16);
    g.stamp(0.25, 0.5, 0.2);
    const once = g.fill;
    g.stamp(0.25, 0.5, 0.2);
    expect(g.fill).toBe(once);
  });

  it('clips stamps off the board and ignores junk input', () => {
    const g = halfGrid(16);
    g.stamp(-2, -2, 0.1);
    g.stamp(Number.NaN, 0.5, 0.1);
    g.stamp(0.5, 0.5, 0);
    expect(g.fill).toBe(0);
    expect(g.spill).toBe(0);
    g.stamp(0, 0, 0.3); // corner, partly off-board
    expect(g.fill).toBeGreaterThan(0);
  });

  it('a full flood fills to 1 and spills the outside area', () => {
    const g = halfGrid(16);
    g.stamp(0.5, 0.5, 2);
    expect(g.fill).toBe(1);
    expect(g.spill).toBe(1); // outside area equals inside area here
  });

  it('reset keeps the mask, clears the paint', () => {
    const g = halfGrid(16);
    g.stamp(0.25, 0.5, 0.2);
    g.reset();
    expect(g.fill).toBe(0);
    expect(g.insideCells).toBe(128);
  });

  it('an empty mask scores nothing instead of dividing by zero', () => {
    const g = new CoverageGrid(8);
    g.setMask();
    g.stamp(0.5, 0.5, 1);
    expect(g.fill).toBe(0);
    expect(g.spill).toBe(0);
  });
});

describe('stencil scoring', () => {
  it('scores fill minus a spill penalty, clamped to 0..1', () => {
    expect(coverageScore(0.8, 0, 0.5)).toBeCloseTo(0.8);
    expect(coverageScore(0.8, 0.4, 0.5)).toBeCloseTo(0.6);
    expect(coverageScore(0.1, 2, 0.5)).toBe(0);
    expect(coverageScore(1.5, 0, 0.5)).toBe(1);
    expect(coverageScore(Number.NaN, 0, 0.5)).toBe(0);
  });

  it('earns one star per threshold', () => {
    const t = STUDIO.starThresholds;
    expect(starsFor(0, t)).toBe(0);
    expect(starsFor(t[0], t)).toBe(1);
    expect(starsFor(t[1], t)).toBe(2);
    expect(starsFor(t[2], t)).toBe(3);
    expect(starsFor(1, t)).toBe(3);
  });

  it('keeps the star thresholds ascending and reachable', () => {
    const t = STUDIO.starThresholds;
    expect(t.length).toBe(3);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);
    expect(t[2]).toBeLessThan(1);
    // A clean 90% fill earns 3 stars; flooding the whole board does not.
    expect(starsFor(coverageScore(0.9, 0.05, STUDIO.spillPenalty), t)).toBe(3);
    expect(starsFor(coverageScore(1, 1.6, STUDIO.spillPenalty), t)).toBeLessThan(2);
  });

  it('formats the stencil line in ASCII', () => {
    expect(percent(0.623)).toBe(62);
    expect(percent(2)).toBe(100);
    expect(percent(Number.NaN)).toBe(0);
    const line = stencilLine('STAR', 0.62, 0.04);
    expect(line).toBe('STAR: 62% filled, 4% spill');
    expect(isPrintableAscii(line)).toBe(true);
  });
});

describe('canvas placement', () => {
  it('hangs on the wall hit: standoff along the normal, facing back, grown with distance', () => {
    const out = resolveCanvasPlacement(0, 1.2, 0, 0, -1, 2.6, 0, -2.6, 0, 1, 0.06, STUDIO, placement());
    expect(out.onWall).toBe(true);
    expect(out.z).toBeCloseTo(-2.54);
    expect(out.x).toBeCloseTo(0);
    expect(out.yaw).toBeCloseTo(0); // +Z face toward the player at the origin
    expect(out.scale).toBeCloseTo(wallCanvasScale(2.6, STUDIO));
    expect(out.scale).toBeGreaterThan(1);
  });

  it('falls back to floating at a seated distance without a wall', () => {
    const out = resolveCanvasPlacement(
      1, 1.2, 1, 1, 0, Number.POSITIVE_INFINITY, 0, 0, 0, 0, 0.06, STUDIO, placement(),
    );
    expect(out.onWall).toBe(false);
    expect(out.x).toBeCloseTo(1 + STUDIO.floatDistance);
    expect(out.z).toBeCloseTo(1);
    expect(out.scale).toBe(1);
    // Facing back at the player: board +Z points along -forward (-X).
    expect(Math.sin(out.yaw)).toBeCloseTo(-1);
    expect(STUDIO.floatDistance).toBeGreaterThanOrEqual(1.2);
    expect(STUDIO.floatDistance).toBeLessThanOrEqual(1.5);
  });

  it('survives a degenerate forward vector', () => {
    const out = resolveCanvasPlacement(0, 1.2, 0, 0, 0, Number.POSITIVE_INFINITY, 0, 0, 0, 0, 0, STUDIO, placement());
    expect(out.z).toBeCloseTo(-STUDIO.floatDistance);
  });

  it('puts the canvas at the eyes, clamped for floor-seated and tall players', () => {
    expect(canvasCentreHeight(1.2, STUDIO)).toBeCloseTo(1.2 - STUDIO.canvasBelowEyes);
    expect(canvasCentreHeight(0.5, STUDIO)).toBe(STUDIO.canvasMinCentre);
    expect(canvasCentreHeight(2.5, STUDIO)).toBe(STUDIO.canvasMaxCentre);
    expect(canvasCentreHeight(Number.NaN, STUDIO)).toBeGreaterThanOrEqual(STUDIO.canvasMinCentre);
  });

  it('clamps the wall scale', () => {
    expect(wallCanvasScale(0.5, STUDIO)).toBe(STUDIO.wallScaleMin);
    expect(wallCanvasScale(50, STUDIO)).toBe(STUDIO.wallScaleMax);
    expect(wallCanvasScale(-1, STUDIO)).toBe(STUDIO.wallScaleMin);
  });

  it('keeps the canvas collider clear of the 6 cm wall collider box', () => {
    // Wall boxes are centred on the plane: 3 cm stands in front of it.
    expect(STUDIO.wallStandoff - EASEL.colliderDepth / 2).toBeGreaterThanOrEqual(0.03 - 1e-9);
    expect(STUDIO.wallMinDist).toBeLessThan(STUDIO.wallMaxDist);
  });

  it('the canvas collider is too thick to tunnel at 72 Hz (gotcha 22)', () => {
    const fastest = Math.max(FIRE.speed, FIRE.speed * WEB.webSpeedMult) / 72;
    expect(EASEL.colliderDepth + 2 * BALLS.radius).toBeGreaterThan(fastest);
    // A ball resting on the front face still matches the board.
    expect(EASEL.hitDepthTolerance).toBeGreaterThanOrEqual(EASEL.colliderDepth / 2 + BALLS.radius);
  });
});

describe('canvas shapes', () => {
  it('maps metres and pixels together for every shape', () => {
    for (const shape of [CanvasShape.Landscape, CanvasShape.Portrait, CanvasShape.Round, CanvasShape.Square]) {
      const d = shapeBoard(shape, 1, BOARD_CFG);
      expect(d.boardWidth / d.boardHeight).toBeCloseTo(d.canvasPxW / d.canvasPxH, 5);
    }
    const p = shapeBoard(CanvasShape.Portrait, 1, BOARD_CFG);
    expect(p.boardHeight).toBeGreaterThan(p.boardWidth);
  });

  it('scales metres, never pixels', () => {
    const a = shapeBoard(CanvasShape.Landscape, 1, BOARD_CFG);
    const b = shapeBoard(CanvasShape.Landscape, 2, BOARD_CFG);
    expect(b.boardWidth).toBeCloseTo(a.boardWidth * 2);
    expect(b.canvasPxW).toBe(a.canvasPxW);
    expect(shapeBoard(CanvasShape.Square, 0, BOARD_CFG).boardWidth).toBeCloseTo(STUDIO.squareBoardSize);
  });

  it('a round board only takes paint on its disc', () => {
    expect(onBoardSurface(CanvasShape.Round, 0, 0, 0.3, 0.3)).toBe(true);
    expect(onBoardSurface(CanvasShape.Round, 0.28, 0.28, 0.3, 0.3)).toBe(false);
    expect(onBoardSurface(CanvasShape.Square, 0.28, 0.28, 0.3, 0.3)).toBe(true);
    expect(onBoardSurface(CanvasShape.Landscape, 0.4, 0, 0.3, 0.3)).toBe(false);
  });

  it('SHAPE cycles landscape, portrait, round', () => {
    expect(CANVAS_SHAPE_CYCLE).toEqual([CanvasShape.Landscape, CanvasShape.Portrait, CanvasShape.Round]);
    expect(nextCanvasShape(CanvasShape.Landscape)).toBe(CanvasShape.Portrait);
    expect(nextCanvasShape(CanvasShape.Round)).toBe(CanvasShape.Landscape);
    expect(nextCanvasShape(CanvasShape.Square)).toBe(CanvasShape.Landscape);
    for (const label of Object.values(CANVAS_SHAPE_LABELS)) expect(isPrintableAscii(label)).toBe(true);
  });

  it('frame openings are plausible fractions', () => {
    for (const f of Object.values(STUDIO.frames)) {
      expect(f.innerW).toBeGreaterThan(0.6);
      expect(f.innerW).toBeLessThan(1);
      expect(f.innerH).toBeGreaterThan(0.6);
      expect(f.innerH).toBeLessThan(1);
      expect(Math.abs(f.offX)).toBeLessThan(0.05);
      expect(Math.abs(f.offY)).toBeLessThan(0.05);
    }
  });
});

describe('target range', () => {
  const out = new Float32Array(3);

  it('spawns inside the seated forward arc, distance and height bands', () => {
    for (const [ua, ud, uh] of [[0, 0, 0], [0.999, 0.999, 0.999], [0.5, 0.5, 0.5], [0.2, 0.7, 0.4]]) {
      arcSpawnPoint(0, 1.2, 0, 0, ua, ud, uh, STUDIO, out);
      const dist = Math.hypot(out[0], out[2]);
      expect(dist).toBeGreaterThanOrEqual(STUDIO.minDist - 1e-5);
      expect(dist).toBeLessThanOrEqual(STUDIO.maxDist + 1e-5);
      const angle = (Math.abs(Math.atan2(out[0], -out[2])) * 180) / Math.PI;
      expect(angle).toBeLessThanOrEqual(STUDIO.arcDeg / 2 + 1e-3);
      expect(out[2]).toBeLessThan(0); // in front (head faces -Z)
      expect(out[1]).toBeGreaterThanOrEqual(STUDIO.minHeight);
      expect(out[1]).toBeLessThanOrEqual(STUDIO.maxHeight);
    }
  });

  it('turns the arc with the head yaw', () => {
    arcSpawnPoint(0, 1.2, 0, Math.PI / 2, 0.5, 0.5, 0.5, STUDIO, out); // facing -X
    expect(out[0]).toBeLessThan(-1);
    expect(Math.abs(out[2])).toBeLessThan(1e-4);
  });

  it('keeps a seated arc (no targets behind you)', () => {
    expect(STUDIO.arcDeg).toBeLessThanOrEqual(150);
    expect(STUDIO.minDist).toBeGreaterThanOrEqual(1);
    expect(STUDIO.maxHeight).toBeLessThanOrEqual(1.9);
  });

  it('enforces spacing against live targets only', () => {
    const points = new Float32Array([0, 1, -2, 5, 5, 5]);
    expect(spacedFrom(0.1, 1, -2, points, new Uint8Array([1, 0]), 0.5)).toBe(false);
    expect(spacedFrom(0.1, 1, -2, points, new Uint8Array([0, 0]), 0.5)).toBe(true);
    expect(spacedFrom(1, 1, -2, points, new Uint8Array([1, 1]), 0.5)).toBe(true);
  });

  it('tracks streaks: hits climb, a miss resets, best and pops persist', () => {
    const s = new StreakTracker();
    expect(s.hit()).toBe(1);
    expect(s.hit()).toBe(2);
    s.miss();
    expect(s.current).toBe(0);
    expect(s.best).toBe(2);
    s.hit();
    expect(s.pops).toBe(3);
    expect(s.best).toBe(2);
    s.reset();
    expect(s.best).toBe(0);
  });

  it('formats the range line in ASCII', () => {
    const line = targetsLine(3, 7, 12, true);
    expect(line).toBe('STREAK 3  BEST 7  POPS 12  HARD');
    expect(isPrintableAscii(line)).toBe(true);
  });

  it('pop splash rays stay inside their cone', () => {
    const d = new Float32Array(3);
    for (const [u1, u2] of [[0, 0], [1, 0.3], [0.5, 0.9], [0.99, 0.5]]) {
      coneDirection(0, 0, -1, STUDIO.popSplatConeDeg, u1, u2, d);
      expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 4);
      const angle = (Math.acos(-d[2]) * 180) / Math.PI;
      expect(angle).toBeLessThanOrEqual(STUDIO.popSplatConeDeg + 1e-3);
    }
    coneDirection(0, 1, 0, 10, 0.5, 0.5, d); // axis parallel to the basis pick
    expect(d[1]).toBeGreaterThan(0.98);
  });

  it('downward misses land on the floor within range', () => {
    expect(floorHitDistance(1.5, -1, 4)).toBeCloseTo(1.5);
    expect(floorHitDistance(1.5, 0.2, 4)).toBe(Number.POSITIVE_INFINITY);
    expect(floorHitDistance(1.5, -0.1, 4)).toBe(Number.POSITIVE_INFINITY);
  });

  it('every pop clears the wall-tunnel rule: targets have no colliders to tunnel', () => {
    expect(STUDIO.bullseyeRadius).toBeGreaterThan(0.1);
    expect(STUDIO.popColors.length).toBeGreaterThan(1);
    for (const c of STUDIO.popColors) for (const v of c) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe('studio contract', () => {
  it('numbers its events from 31 upward without collisions', () => {
    const values = Object.values(GameEvent);
    expect(new Set(values).size).toBe(values.length);
    expect(GameEvent.StudioActivityChanged).toBe(31);
    expect(GameEvent.StudioTargetPopped).toBe(32);
    expect(GameEvent.StudioStencilScored).toBe(33);
    expect(GameEvent.StudioArtSaved).toBe(34);
  });

  it('activities are canvas, stencil, targets in tab order', () => {
    expect(STUDIO_ACTIVITY_ORDER).toEqual([
      StudioActivity.Canvas,
      StudioActivity.Stencil,
      StudioActivity.Targets,
    ]);
    expect(STUDIO_ACTIVITY_ORDER).toContain(STUDIO.defaultActivity);
  });

  it('ships every studio asset it references', () => {
    const urls = [
      ...Object.values(STUDIO.frames).map((f) => f.url),
      ...STUDIO.stencils.map((s) => s.url),
      STUDIO.bullseyeUrl,
      STUDIO.balloonUrl,
      '/studio/studio-sign.webp',
    ];
    for (const url of urls) expect(existsSync(`public${url}`), url).toBe(true);
    // Stencil masks are greyscale PNGs (luminance = inside).
    for (const s of STUDIO.stencils) expect(s.url).toMatch(/\.png$/);
  });

  it('every studio label and line is ASCII', () => {
    for (const s of STUDIO.stencils) expect(isPrintableAscii(s.label)).toBe(true);
    for (const line of Object.values(STUDIO.lines)) expect(isPrintableAscii(line), line).toBe(true);
  });

  it('the chill card has the three tabs, the meter and the actions', () => {
    const markup = readFileSync('ui/hud.uikitml', 'utf8');
    const body = markup.slice(markup.indexOf('</style>'));
    const chill = body.slice(body.indexOf('id="section-chill"'), body.indexOf('id="section-armory"'));
    for (const id of [
      'btn-studio-canvas',
      'btn-studio-stencil',
      'btn-studio-targets',
      'studio-meter',
      'studio-meter-fill',
      'btn-studio-primary',
      'btn-studio-mount',
      'btn-save-painting',
      'btn-new-canvas',
      'btn-exit-chill',
    ]) {
      expect(chill, id).toContain(`id="${id}"`);
    }
    // Every chill button blocks shots like the rest of the HUD (btn- prefix).
    for (const m of chill.matchAll(/<button id="([^"]+)"/g)) expect(m[1].startsWith('btn-')).toBe(true);
    expect(chill).toContain('src="./studio/studio-sign.webp"');
  });
});
