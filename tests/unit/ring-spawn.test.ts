import { describe, it, expect } from 'vitest';
import { ringSpawnPosition } from '../../src/systems/TargetSystem';
import type { RingSpawnConfig } from '../../src/systems/TargetSystem';
import { TARGETS } from '../../src/config';

/** The shipping ring, jitter and all. */
const LIVE: RingSpawnConfig = TARGETS;

/** Same ring with the wander switched off, for exact-angle assertions. */
const REGULAR: RingSpawnConfig = { ...TARGETS, spawnAngleJitter: 0 };

function radiusOf(out: Float32Array): number {
  return Math.hypot(out[0], out[2]);
}

function angleOf(out: Float32Array): number {
  const angle = Math.atan2(out[2], out[0]);
  return angle < 0 ? angle + Math.PI * 2 : angle;
}

describe('ringSpawnPosition', () => {
  it('keeps every draw inside the configured ring and height band', () => {
    const out = new Float32Array(3);
    const count = TARGETS.maxConcurrent;

    for (let draw = 0; draw < 2000; draw++) {
      const index = draw % count;
      ringSpawnPosition(
        index,
        count,
        Math.random(),
        Math.random(),
        Math.random(),
        LIVE,
        out,
      );

      const radius = radiusOf(out);
      // Float32 storage costs a few ulps at these magnitudes.
      expect(radius).toBeGreaterThanOrEqual(TARGETS.ringMinR - 1e-5);
      expect(radius).toBeLessThanOrEqual(TARGETS.ringMaxR + 1e-5);
      expect(out[1]).toBeGreaterThanOrEqual(TARGETS.heightMin - 1e-5);
      expect(out[1]).toBeLessThanOrEqual(TARGETS.heightMax + 1e-5);
    }
  });

  it('maps the rand extremes onto the exact bounds', () => {
    const out = new Float32Array(3);

    ringSpawnPosition(0, 4, 0.5, 0, 0, LIVE, out);
    expect(radiusOf(out)).toBeCloseTo(TARGETS.ringMinR, 5);
    expect(out[1]).toBeCloseTo(TARGETS.heightMin, 5);

    ringSpawnPosition(0, 4, 0.5, 1, 1, LIVE, out);
    expect(radiusOf(out)).toBeCloseTo(TARGETS.ringMaxR, 5);
    expect(out[1]).toBeCloseTo(TARGETS.heightMax, 5);
  });

  it('spreads a full ring evenly when jitter is off', () => {
    const count = 4;
    const angles: number[] = [];
    const out = new Float32Array(3);

    for (let index = 0; index < count; index++) {
      // Radius/height still vary; only the angle is under test here.
      ringSpawnPosition(index, count, 0.5, Math.random(), Math.random(), REGULAR, out);
      angles.push(angleOf(out));
    }

    const slice = (Math.PI * 2) / count;
    for (let index = 0; index < count; index++) {
      expect(angles[index]).toBeCloseTo(index * slice, 4);
    }
  });

  it('never places two robots on top of each other at jitter 0', () => {
    const count = TARGETS.maxConcurrent;
    const slice = (Math.PI * 2) / count;
    const angles: number[] = [];
    const out = new Float32Array(3);

    for (let index = 0; index < count; index++) {
      ringSpawnPosition(index, count, 0.5, Math.random(), Math.random(), REGULAR, out);
      angles.push(angleOf(out));
    }

    for (let a = 0; a < count; a++) {
      for (let b = a + 1; b < count; b++) {
        const raw = Math.abs(angles[a] - angles[b]);
        const separation = Math.min(raw, Math.PI * 2 - raw);
        expect(separation).toBeGreaterThan(slice * 0.5);
      }
    }
  });

  it('keeps jitter inside half a slice', () => {
    const count = 6;
    const slice = (Math.PI * 2) / count;
    const out = new Float32Array(3);
    // spawnAngleJitter is a fraction of a slice, so the worst case is
    // ±(slice/2 × jitter) away from the nominal angle.
    const maxOffset = (slice / 2) * TARGETS.spawnAngleJitter + 1e-4;

    for (let draw = 0; draw < 500; draw++) {
      const index = draw % count;
      ringSpawnPosition(index, count, Math.random(), 0.5, 0.5, LIVE, out);

      const nominal = index * slice;
      const raw = Math.abs(angleOf(out) - nominal);
      const offset = Math.min(raw, Math.PI * 2 - raw);
      expect(offset).toBeLessThanOrEqual(maxOffset);
    }
  });

  it('writes in place and never returns a fresh array', () => {
    const out = new Float32Array(3);
    ringSpawnPosition(0, 4, 0.1, 0.2, 0.3, LIVE, out);
    const first = Array.from(out);

    const result = ringSpawnPosition(2, 4, 0.9, 0.8, 0.7, LIVE, out);
    expect(result).toBeUndefined();
    expect(Array.from(out)).not.toEqual(first);
  });

  it('treats a count of one as a single point on the ring', () => {
    const out = new Float32Array(3);
    ringSpawnPosition(0, 1, 0.5, 0.5, 0.5, REGULAR, out);

    expect(angleOf(out)).toBeCloseTo(0, 5);
    expect(radiusOf(out)).toBeCloseTo(
      (TARGETS.ringMinR + TARGETS.ringMaxR) / 2,
      5,
    );
  });

  it('survives a zero count without dividing by zero', () => {
    const out = new Float32Array(3);
    ringSpawnPosition(0, 0, 0.5, 0.5, 0.5, REGULAR, out);

    expect(Number.isFinite(out[0])).toBe(true);
    expect(Number.isFinite(out[1])).toBe(true);
    expect(Number.isFinite(out[2])).toBe(true);
  });
});
