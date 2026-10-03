import { describe, it, expect } from 'vitest';
import {
  FORWARD_HEADING_RAD,
  flatHeadingAngle,
  ringSpawnPosition,
} from '../../src/systems/TargetSystem';
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

/** Signed shortest angular distance a - b, in (-pi, pi]. */
function angleDelta(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

describe('ringSpawnPosition on a forward arc', () => {
  const ARC = TARGETS.spawnArcDeg;
  const HALF = ((ARC / 2) * Math.PI) / 180;
  // A handful of facings, including ones that straddle the atan2 seam at +/-pi.
  const CENTERS = [FORWARD_HEADING_RAD, 0, 1.1, Math.PI, -Math.PI + 0.05, 2.9];

  it('defaults to the seated 150-degree arc', () => {
    expect(TARGETS.spawnArcDeg).toBe(150);
  });

  it('keeps every draw inside the arc, the ring and the height band', () => {
    const out = new Float32Array(3);
    const count = TARGETS.maxConcurrent;

    for (const center of CENTERS) {
      for (let draw = 0; draw < 1000; draw++) {
        ringSpawnPosition(
          draw % count,
          count,
          Math.random(),
          Math.random(),
          Math.random(),
          LIVE,
          out,
          center,
          ARC,
        );
        expect(Math.abs(angleDelta(Math.atan2(out[2], out[0]), center))).toBeLessThanOrEqual(
          HALF + 1e-4,
        );
        const radius = radiusOf(out);
        expect(radius).toBeGreaterThanOrEqual(TARGETS.ringMinR - 1e-5);
        expect(radius).toBeLessThanOrEqual(TARGETS.ringMaxR + 1e-5);
        expect(out[1]).toBeGreaterThanOrEqual(TARGETS.heightMin - 1e-5);
        expect(out[1]).toBeLessThanOrEqual(TARGETS.heightMax + 1e-5);
      }
    }
  });

  it('stays inside the arc even at the extremes of rand0 and a jitter over 1', () => {
    const wild: RingSpawnConfig = { ...TARGETS, spawnAngleJitter: 3 };
    const out = new Float32Array(3);
    for (const rand0 of [0, 1]) {
      for (let index = 0; index < 4; index++) {
        ringSpawnPosition(index, 4, rand0, 0.5, 0.5, wild, out, 0.3, ARC);
        expect(Math.abs(angleDelta(Math.atan2(out[2], out[0]), 0.3))).toBeLessThanOrEqual(
          HALF + 1e-4,
        );
      }
    }
  });

  it('spreads robots evenly across the arc, symmetric about the facing', () => {
    const count = 4;
    const out = new Float32Array(3);
    const lane = (2 * HALF) / count;

    for (const center of CENTERS) {
      const offsets: number[] = [];
      for (let index = 0; index < count; index++) {
        ringSpawnPosition(index, count, 0.5, Math.random(), Math.random(), REGULAR, out, center, ARC);
        offsets.push(angleDelta(Math.atan2(out[2], out[0]), center));
      }
      // Lane centres: -3/8, -1/8, +1/8, +3/8 of the arc for four robots.
      for (let index = 0; index < count; index++) {
        expect(offsets[index]).toBeCloseTo(-HALF + (index + 0.5) * lane, 4);
      }
      // Equal gaps between neighbours...
      for (let index = 1; index < count; index++) {
        expect(offsets[index] - offsets[index - 1]).toBeCloseTo(lane, 4);
      }
      // ...and centred: the mean offset is the facing itself.
      const mean = offsets.reduce((a, b) => a + b, 0) / count;
      expect(mean).toBeCloseTo(0, 4);
    }
  });

  it('puts a single robot dead ahead', () => {
    const out = new Float32Array(3);
    ringSpawnPosition(0, 1, 0.5, 0.5, 0.5, REGULAR, out, FORWARD_HEADING_RAD, ARC);
    // Straight ahead is -Z.
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[2]).toBeLessThan(0);
  });

  it('wraps an index past the count back into its lane', () => {
    const a = new Float32Array(3);
    const b = new Float32Array(3);
    ringSpawnPosition(1, 4, 0.5, 0.5, 0.5, REGULAR, a, 0.4, ARC);
    ringSpawnPosition(5, 4, 0.5, 0.5, 0.5, REGULAR, b, 0.4, ARC);
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it('keeps jitter inside the lane', () => {
    const count = TARGETS.maxConcurrent;
    const lane = (2 * HALF) / count;
    const maxOffset = (lane / 2) * TARGETS.spawnAngleJitter + 1e-4;
    const out = new Float32Array(3);

    for (let draw = 0; draw < 500; draw++) {
      const index = draw % count;
      ringSpawnPosition(index, count, Math.random(), 0.5, 0.5, LIVE, out, 0, ARC);
      const nominal = -HALF + (index + 0.5) * lane;
      expect(Math.abs(angleDelta(Math.atan2(out[2], out[0]), nominal))).toBeLessThanOrEqual(
        maxOffset,
      );
    }
  });

  it('is byte-identical to the original ring at 360 degrees, whatever the facing', () => {
    const legacy = new Float32Array(3);
    const viaArc = new Float32Array(3);
    for (let draw = 0; draw < 200; draw++) {
      const index = draw % 6;
      const r0 = Math.random();
      const r1 = Math.random();
      const r2 = Math.random();
      ringSpawnPosition(index, 6, r0, r1, r2, LIVE, legacy);
      ringSpawnPosition(index, 6, r0, r1, r2, LIVE, viaArc, Math.random() * 6, 360);
      expect(Array.from(viaArc)).toEqual(Array.from(legacy));
      // Anything wider than a circle, or not a number at all, is still a ring.
      ringSpawnPosition(index, 6, r0, r1, r2, LIVE, viaArc, 1, 720);
      expect(Array.from(viaArc)).toEqual(Array.from(legacy));
      ringSpawnPosition(index, 6, r0, r1, r2, LIVE, viaArc, 1, Number.NaN);
      expect(Array.from(viaArc)).toEqual(Array.from(legacy));
    }
  });

  it('collapses a zero-width arc onto the facing without dividing by zero', () => {
    const out = new Float32Array(3);
    ringSpawnPosition(2, 4, 0.9, 0.5, 0.5, LIVE, out, 0.8, 0);
    expect(angleDelta(Math.atan2(out[2], out[0]), 0.8)).toBeCloseTo(0, 5);
    ringSpawnPosition(0, 0, 0.5, 0.5, 0.5, LIVE, out, 0.8, 150);
    expect(Number.isFinite(out[0]) && Number.isFinite(out[2])).toBe(true);
  });
});

describe('flatHeadingAngle', () => {
  /** Head pitched by `pitch` (down positive) after a yaw of `yaw` (CCW from above). */
  function pose(yaw: number, pitch: number): [number, number, number, number, number] {
    // Level forward for this yaw is (-sin yaw, 0, -cos yaw); up tilts with it.
    const fx = -Math.sin(yaw) * Math.cos(pitch);
    const fy = -Math.sin(pitch);
    const fz = -Math.cos(yaw) * Math.cos(pitch);
    const ux = -Math.sin(yaw) * Math.sin(pitch);
    const uz = -Math.cos(yaw) * Math.sin(pitch);
    return [fx, fy, fz, ux, uz];
  }

  it('reads -Z as straight ahead', () => {
    expect(flatHeadingAngle(0, 0, -1, 0, 0)).toBeCloseTo(FORWARD_HEADING_RAD, 10);
  });

  it('follows yaw on a level head', () => {
    // Turned 90 degrees left, the face points down -X: angle pi.
    expect(Math.abs(flatHeadingAngle(...pose(Math.PI / 2, 0)))).toBeCloseTo(Math.PI, 6);
    // Turned right, +X: angle 0.
    expect(flatHeadingAngle(...pose(-Math.PI / 2, 0))).toBeCloseTo(0, 6);
  });

  it('keeps the heading when looking almost straight down or up', () => {
    for (const yaw of [0, 0.6, -2.2, 3]) {
      const level = flatHeadingAngle(...pose(yaw, 0));
      for (const pitch of [1.2, 1.5, Math.PI / 2, -1.4, -Math.PI / 2]) {
        expect(angleDelta(flatHeadingAngle(...pose(yaw, pitch)), level)).toBeCloseTo(0, 6);
      }
    }
  });

  it('falls back when the pose has no horizontal extent', () => {
    expect(flatHeadingAngle(0, 0, 0, 0, 0)).toBe(FORWARD_HEADING_RAD);
    expect(flatHeadingAngle(0, 0, 0, 0, 0, 1.25)).toBe(1.25);
    expect(flatHeadingAngle(Number.NaN, 0, 0, 0, 0, 0.5)).toBe(0.5);
  });

  it('feeds ringSpawnPosition an arc that sits in front of the head', () => {
    const out = new Float32Array(3);
    for (const yaw of [0, 1, -2, 2.8]) {
      const [fx, , fz] = pose(yaw, 0);
      const center = flatHeadingAngle(...pose(yaw, 0.3));
      for (let index = 0; index < 4; index++) {
        ringSpawnPosition(index, 4, Math.random(), 0.5, 0.5, LIVE, out, center, TARGETS.spawnArcDeg);
        // In front: positive projection onto the level facing direction.
        const forwardness = (out[0] * fx + out[2] * fz) / Math.hypot(fx, fz) / radiusOf(out);
        expect(forwardness).toBeGreaterThan(Math.cos(((TARGETS.spawnArcDeg / 2) * Math.PI) / 180) - 1e-4);
      }
    }
  });
});
