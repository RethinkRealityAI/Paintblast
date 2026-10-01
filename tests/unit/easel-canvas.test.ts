import { describe, it, expect } from 'vitest';
import { boardLocalToPixel, orientationDims } from '../../src/systems/EaselSystem';
import { EASEL } from '../../src/config';

const HALF_W = EASEL.boardWidth / 2;
const HALF_H = EASEL.boardHeight / 2;
const PX_W = EASEL.canvasPxW;
const PX_H = EASEL.canvasPxH;

/** Run the mapping with the shipping board and canvas, into a fresh tuple. */
function mapLive(lx: number, ly: number): [number, number] {
  const out = new Float32Array(2);
  boardLocalToPixel(lx, ly, HALF_W, HALF_H, PX_W, PX_H, out);
  return [out[0], out[1]];
}

describe('boardLocalToPixel', () => {
  it('puts the middle of the board in the middle of the canvas', () => {
    const [x, y] = mapLive(0, 0);
    expect(x).toBeCloseTo(PX_W / 2, 3);
    expect(y).toBeCloseTo(PX_H / 2, 3);
  });

  it('maps the top-left corner to pixel (0, 0)', () => {
    // Board-local +Y is up, canvas rows count down: the top of the board is
    // row zero. Getting this backwards is the whole reason this is tested.
    const [x, y] = mapLive(-HALF_W, HALF_H);
    expect(x).toBeCloseTo(0, 3);
    expect(y).toBeCloseTo(0, 3);
  });

  it('maps the bottom-right corner to the far pixel corner', () => {
    const [x, y] = mapLive(HALF_W, -HALF_H);
    expect(x).toBeCloseTo(PX_W, 3);
    expect(y).toBeCloseTo(PX_H, 3);
  });

  it('maps the other two corners consistently', () => {
    expect(mapLive(HALF_W, HALF_H)[0]).toBeCloseTo(PX_W, 3);
    expect(mapLive(HALF_W, HALF_H)[1]).toBeCloseTo(0, 3);
    expect(mapLive(-HALF_W, -HALF_H)[0]).toBeCloseTo(0, 3);
    expect(mapLive(-HALF_W, -HALF_H)[1]).toBeCloseTo(PX_H, 3);
  });

  it('flips Y rather than just scaling it', () => {
    const above = mapLive(0, HALF_H / 2);
    const below = mapLive(0, -HALF_H / 2);
    expect(above[1]).toBeCloseTo(PX_H * 0.25, 3);
    expect(below[1]).toBeCloseTo(PX_H * 0.75, 3);
    expect(above[1]).toBeLessThan(below[1]);
  });

  it('keeps X increasing left to right', () => {
    expect(mapLive(-HALF_W / 2, 0)[0]).toBeCloseTo(PX_W * 0.25, 3);
    expect(mapLive(HALF_W / 2, 0)[0]).toBeCloseTo(PX_W * 0.75, 3);
  });

  it('is linear across the board', () => {
    const quarter = mapLive(-HALF_W / 2, 0)[0];
    const centre = mapLive(0, 0)[0];
    const threeQuarter = mapLive(HALF_W / 2, 0)[0];
    expect(centre - quarter).toBeCloseTo(threeQuarter - centre, 3);
  });

  it('falls back to the canvas centre for a degenerate board', () => {
    const out = new Float32Array(2);
    boardLocalToPixel(0.1, 0.1, 0, 0, PX_W, PX_H, out);
    expect(out[0]).toBeCloseTo(PX_W / 2, 3);
    expect(out[1]).toBeCloseTo(PX_H / 2, 3);
  });

  it('writes into the caller-owned tuple and returns nothing', () => {
    const out = [0, 0];
    const result = boardLocalToPixel(
      HALF_W,
      -HALF_H,
      HALF_W,
      HALF_H,
      PX_W,
      PX_H,
      out,
    );
    expect(result).toBeUndefined();
    expect(out[0]).toBeCloseTo(PX_W, 3);
    expect(out[1]).toBeCloseTo(PX_H, 3);
  });

  it('accepts an off-board point without clamping, so callers must bounds-check', () => {
    // EaselSystem rejects out-of-board impacts before it ever gets here; the
    // mapping itself stays a plain linear transform.
    const [x, y] = mapLive(HALF_W * 2, 0);
    expect(x).toBeGreaterThan(PX_W);
    expect(y).toBeCloseTo(PX_H / 2, 3);
  });
});

describe('EASEL board geometry', () => {
  it('matches the painting aspect so the picture is never stretched', () => {
    expect(EASEL.boardWidth / EASEL.boardHeight).toBeCloseTo(PX_W / PX_H, 2);
  });

  it('declares an ordered stamp size range that fits on the canvas', () => {
    expect(EASEL.stampMinPx).toBeGreaterThan(0);
    expect(EASEL.stampMaxPx).toBeGreaterThan(EASEL.stampMinPx);
    expect(EASEL.stampMaxPx).toBeLessThan(Math.min(PX_W, PX_H));
  });

  it('stands the board high enough to have legs under it', () => {
    expect(EASEL.boardCentreHeight).toBeGreaterThan(EASEL.boardHeight / 2);
    expect(EASEL.spawnDistance).toBeGreaterThan(0.5);
  });
});

describe('orientationDims', () => {
  it('hands back the landscape board and canvas by default', () => {
    expect(orientationDims(false, EASEL)).toEqual({
      boardWidth: EASEL.boardWidth,
      boardHeight: EASEL.boardHeight,
      canvasPxW: EASEL.canvasPxW,
      canvasPxH: EASEL.canvasPxH,
    });
  });

  it('hands back the portrait pair when asked', () => {
    expect(orientationDims(true, EASEL)).toEqual({
      boardWidth: EASEL.portraitBoardWidth,
      boardHeight: EASEL.portraitBoardHeight,
      canvasPxW: EASEL.portraitCanvasPxW,
      canvasPxH: EASEL.portraitCanvasPxH,
    });
  });

  it('actually rotates: landscape is wide, portrait is tall', () => {
    const landscape = orientationDims(false, EASEL);
    const portrait = orientationDims(true, EASEL);
    expect(landscape.boardWidth).toBeGreaterThan(landscape.boardHeight);
    expect(portrait.boardHeight).toBeGreaterThan(portrait.boardWidth);
    expect(landscape.canvasPxW).toBeGreaterThan(landscape.canvasPxH);
    expect(portrait.canvasPxH).toBeGreaterThan(portrait.canvasPxW);
  });

  it('keeps metres and pixels in the same aspect either way up', () => {
    // Board aspect drifting from canvas aspect is what stretches the picture,
    // and ROTATE CANVAS has to keep four numbers in step to avoid it.
    for (const dims of [orientationDims(false, EASEL), orientationDims(true, EASEL)]) {
      expect(dims.boardWidth / dims.boardHeight).toBeCloseTo(
        dims.canvasPxW / dims.canvasPxH,
        2,
      );
    }
  });

  it('swaps the pair rather than inventing new numbers', () => {
    const landscape = orientationDims(false, EASEL);
    const portrait = orientationDims(true, EASEL);
    expect(portrait.boardWidth).toBeCloseTo(landscape.boardHeight, 6);
    expect(portrait.boardHeight).toBeCloseTo(landscape.boardWidth, 6);
    expect(portrait.canvasPxW).toBe(landscape.canvasPxH);
    expect(portrait.canvasPxH).toBe(landscape.canvasPxW);
  });

  it('is pure — reads the config it is handed, not the shipping one', () => {
    const doubled = orientationDims(true, {
      boardWidth: 1,
      boardHeight: 2,
      canvasPxW: 10,
      canvasPxH: 20,
      portraitBoardWidth: 3,
      portraitBoardHeight: 4,
      portraitCanvasPxW: 30,
      portraitCanvasPxH: 40,
    });
    expect(doubled).toEqual({
      boardWidth: 3,
      boardHeight: 4,
      canvasPxW: 30,
      canvasPxH: 40,
    });
  });
});
