import { describe, it, expect } from 'vitest';
import { clampSpawnDistance } from '../../src/systems/TargetSystem';
import { ROOM, TARGETS } from '../../src/config';

/** The shipping numbers, so the tests fail if the tuning goes nonsensical. */
const MARGIN = ROOM.spawnWallMargin;
const MIN = ROOM.spawnMinDist;

describe('clampSpawnDistance', () => {
  it('leaves the ring position alone when nothing is in the way', () => {
    expect(clampSpawnDistance(2.5, Number.POSITIVE_INFINITY, MARGIN, MIN)).toBe(
      2.5,
    );
  });

  it('treats a nonsense wall reading as open space', () => {
    expect(clampSpawnDistance(2.5, 0, MARGIN, MIN)).toBe(2.5);
    expect(clampSpawnDistance(2.5, -1, MARGIN, MIN)).toBe(2.5);
    expect(clampSpawnDistance(2.5, Number.NaN, MARGIN, MIN)).toBe(2.5);
  });

  it('leaves the ring position alone when the wall is further out', () => {
    expect(clampSpawnDistance(2.0, 4.5, MARGIN, MIN)).toBe(2.0);
  });

  it('accepts a wall exactly at the candidate as "inside the room"', () => {
    expect(clampSpawnDistance(2.0, 2.0, MARGIN, MIN)).toBe(2.0);
  });

  it('pulls the spawn in front of a nearer wall by exactly the margin', () => {
    expect(clampSpawnDistance(3.0, 2.0, MARGIN, MIN)).toBeCloseTo(
      2.0 - MARGIN,
      10,
    );
    expect(clampSpawnDistance(3.0, 2.0, 0.45, 0.9)).toBeCloseTo(1.55, 10);
  });

  it('resamples rather than spawning a robot in the player face', () => {
    // A wall 1.1 m away leaves 0.65 m after the margin, under the 0.9 m floor.
    expect(clampSpawnDistance(2.4, 1.1, MARGIN, MIN)).toBe(-1);
    // Nose-to-the-wall: pulled distance goes negative.
    expect(clampSpawnDistance(2.4, 0.3, MARGIN, MIN)).toBe(-1);
  });

  it('keeps a pull that lands exactly on the minimum distance', () => {
    const wall = MIN + MARGIN;
    expect(clampSpawnDistance(3.0, wall, MARGIN, MIN)).toBeCloseTo(MIN, 10);
    // One millimetre tighter and the direction is rejected.
    expect(clampSpawnDistance(3.0, wall - 0.001, MARGIN, MIN)).toBe(-1);
  });

  it('never returns a usable distance beyond the candidate', () => {
    for (let wall = 0.1; wall < 6; wall += 0.1) {
      const used = clampSpawnDistance(3.0, wall, MARGIN, MIN);
      if (used >= 0) expect(used).toBeLessThanOrEqual(3.0 + 1e-9);
    }
  });

  it('is a no-op for a zero margin against a wall at the candidate distance', () => {
    expect(clampSpawnDistance(2.0, 1.5, 0, MIN)).toBeCloseTo(1.5, 10);
  });

  it('is configured so the whole spawn ring can survive a normal room', () => {
    // A wall just past the outer ring must still leave a usable spawn: if the
    // margin ever grew past (ringMaxR - spawnMinDist) every direction in a
    // room this size would resample.
    expect(MARGIN).toBeLessThan(TARGETS.ringMaxR - MIN);
    expect(MIN).toBeLessThan(TARGETS.ringMinR);
  });
});
