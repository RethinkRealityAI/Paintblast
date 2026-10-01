import { describe, it, expect, beforeEach } from 'vitest';
import { detectImpact } from '../../src/systems/BallFlightSystem';
import { IMPACT } from '../../src/config';

const ARM = IMPACT.armSpeed;
const DV = IMPACT.impactDeltaV;

describe('detectImpact', () => {
  let normal: Float32Array;

  beforeEach(() => {
    normal = new Float32Array(3);
  });

  it('reports no impact when the ball is coasting (tiny velocity delta)', () => {
    // Gravity alone changes velocity by ~0.14 m/s per frame at 72 FPS.
    const hit = detectImpact(0, 0, -6, 0, -0.14, -6, ARM, DV, normal);
    expect(hit).toBe(false);
    expect(Array.from(normal)).toEqual([0, 0, 0]);
  });

  it('ignores a large delta while the ball is barely moving (arm-speed gate)', () => {
    // Previous speed 0.5 m/s < armSpeed 0.8: a nudge from a grab or a
    // settling contact must not paint a splat.
    const hit = detectImpact(0, 0, -0.5, 0, 0, 4, ARM, DV, normal);
    expect(hit).toBe(false);
  });

  it('arms exactly above armSpeed, not at it', () => {
    expect(detectImpact(0, 0, -ARM, 0, 0, 5, ARM, DV, normal)).toBe(false);
    expect(detectImpact(0, 0, -(ARM + 0.01), 0, 0, 5, ARM, DV, normal)).toBe(
      true,
    );
  });

  it('brackets the impactDeltaV threshold', () => {
    // Same well-armed ball, deltas straddling the threshold by 1%.
    const below = -5 + DV * 0.99;
    const above = -5 + DV * 1.01;
    expect(detectImpact(0, 0, -5, 0, 0, below, ARM, DV, normal)).toBe(false);
    expect(detectImpact(0, 0, -5, 0, 0, above, ARM, DV, normal)).toBe(true);
  });

  it('returns the surface normal for a head-on reversal', () => {
    // Ball flying at -Z into a wall, bouncing back along +Z. The wall faces
    // the player, so its normal is +Z.
    const hit = detectImpact(0, 0, -6, 0, 0, 2, ARM, DV, normal);
    expect(hit).toBe(true);
    expect(normal[0]).toBeCloseTo(0, 6);
    expect(normal[1]).toBeCloseTo(0, 6);
    expect(normal[2]).toBeCloseTo(1, 6);
  });

  it('returns an up normal for a glancing hit on the floor', () => {
    // Horizontal component survives the bounce; only the vertical flips, so
    // Δv is purely vertical and the recovered normal points straight up.
    const hit = detectImpact(3, -4, 0, 3, 2, 0, ARM, DV, normal);
    expect(hit).toBe(true);
    expect(normal[0]).toBeCloseTo(0, 6);
    expect(normal[1]).toBeCloseTo(1, 6);
    expect(normal[2]).toBeCloseTo(0, 6);
  });

  it('recovers a diagonal normal from an angled surface', () => {
    // Δv = (3, 3, 0) → normalized (0.7071, 0.7071, 0).
    const hit = detectImpact(-3, -3, 0, 0, 0, 0, ARM, DV, normal);
    expect(hit).toBe(true);
    expect(normal[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(normal[1]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(normal[2]).toBeCloseTo(0, 6);
  });

  it('always writes a unit normal on a hit', () => {
    detectImpact(0, 0, -8, 1.5, -2.5, 3, ARM, DV, normal);
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    expect(length).toBeCloseTo(1, 6);
  });

  it('leaves the out-normal untouched when there is no impact', () => {
    normal.set([9, 9, 9]);
    detectImpact(0, 0, -0.1, 0, 0, -0.1, ARM, DV, normal);
    expect(Array.from(normal)).toEqual([9, 9, 9]);
  });
});
