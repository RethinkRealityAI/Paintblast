import { describe, it, expect, beforeEach } from 'vitest';
import { tangentBasis } from '../../src/systems/BallFlightSystem';

const dot = (a: Float32Array, b: Float32Array) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (v: Float32Array) => Math.hypot(v[0], v[1], v[2]);

describe('tangentBasis', () => {
  let t: Float32Array;
  let b: Float32Array;

  beforeEach(() => {
    t = new Float32Array(3);
    b = new Float32Array(3);
  });

  /** (t, b) must be unit length and mutually perpendicular, and both ⊥ n. */
  function expectOrthonormal(n: [number, number, number]) {
    const nv = new Float32Array(n);
    tangentBasis(n[0], n[1], n[2], t, b);

    expect(length(t)).toBeCloseTo(1, 5);
    expect(length(b)).toBeCloseTo(1, 5);
    expect(dot(t, b)).toBeCloseTo(0, 5);
    expect(dot(t, nv)).toBeCloseTo(0, 5);
    expect(dot(b, nv)).toBeCloseTo(0, 5);
  }

  it('builds an orthonormal basis for a wall normal', () => {
    expectOrthonormal([0, 0, 1]);
  });

  it('builds an orthonormal basis for an oblique normal', () => {
    const inv = 1 / Math.sqrt(3);
    expectOrthonormal([inv, inv, inv]);
  });

  it('handles the degenerate straight-up normal', () => {
    // The default reference axis is +Y; crossing it with a +Y normal would
    // collapse to zero, so the implementation must swap references here.
    expectOrthonormal([0, 1, 0]);
  });

  it('handles the degenerate straight-down normal', () => {
    expectOrthonormal([0, -1, 0]);
  });

  it('handles a near-vertical normal just inside the swap threshold', () => {
    const ny = 0.95;
    const rest = Math.sqrt(1 - ny * ny);
    expectOrthonormal([rest, ny, 0]);
  });

  it('handles a near-vertical normal just outside the swap threshold', () => {
    const ny = 0.85;
    const rest = Math.sqrt(1 - ny * ny);
    expectOrthonormal([rest, ny, 0]);
  });

  it('spans the plane it is meant to — a full ring stays on the surface', () => {
    const n: [number, number, number] = [0, 0, 1];
    const nv = new Float32Array(n);
    tangentBasis(n[0], n[1], n[2], t, b);

    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const offset = new Float32Array([
        t[0] * cos + b[0] * sin,
        t[1] * cos + b[1] * sin,
        t[2] * cos + b[2] * sin,
      ]);
      // Every satellite offset lies in the surface plane (zero along n)
      // and is exactly one radius out.
      expect(dot(offset, nv)).toBeCloseTo(0, 5);
      expect(length(offset)).toBeCloseTo(1, 5);
    }
  });
});
