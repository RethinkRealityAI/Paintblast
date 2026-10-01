import { describe, it, expect, beforeEach } from 'vitest';
import {
  ParticlePool,
  ParticleShape,
  burstAxis,
  coneDirection,
  lifeScale,
  shapeCode,
  tiltUp,
} from '../../src/systems/VfxSystem';
import { VFX } from '../../src/config';
import type { VfxBurstConfig } from '../../src/config';

const length = (v: Float32Array) => Math.hypot(v[0], v[1], v[2]);

/** Spawn one particle with the given position, velocity and life. */
function spawn(
  pool: ParticlePool,
  opts: {
    p?: [number, number, number];
    v?: [number, number, number];
    life?: number;
    gravityScale?: number;
    drag?: number;
    color?: [number, number, number];
  } = {},
): number {
  const slot = pool.alloc();
  if (slot < 0) return slot;
  const [px, py, pz] = opts.p ?? [0, 0, 0];
  const [vx, vy, vz] = opts.v ?? [0, 0, 0];
  pool.px[slot] = px;
  pool.py[slot] = py;
  pool.pz[slot] = pz;
  pool.vx[slot] = vx;
  pool.vy[slot] = vy;
  pool.vz[slot] = vz;
  pool.life[slot] = opts.life ?? 1;
  pool.size[slot] = 0.01;
  pool.gravityScale[slot] = opts.gravityScale ?? 0;
  pool.drag[slot] = opts.drag ?? 0;
  const [r, g, b] = opts.color ?? [1, 1, 1];
  pool.setColor(slot, r, g, b);
  return slot;
}

describe('ParticlePool', () => {
  it('rejects a non-positive or fractional capacity', () => {
    expect(() => new ParticlePool(0)).toThrow();
    expect(() => new ParticlePool(-4)).toThrow();
    expect(() => new ParticlePool(2.5)).toThrow();
  });

  it('allocates dense slots and refuses once full', () => {
    const pool = new ParticlePool(3);
    expect(pool.alloc()).toBe(0);
    expect(pool.alloc()).toBe(1);
    expect(pool.alloc()).toBe(2);
    expect(pool.alloc()).toBe(-1);
    expect(pool.count).toBe(3);
  });

  it('resets age on alloc so a recycled slot starts fresh', () => {
    const pool = new ParticlePool(1);
    spawn(pool, { life: 0.1 });
    pool.step(0.05, 0);
    expect(pool.age[0]).toBeCloseTo(0.05, 6);
    pool.clear();
    expect(pool.alloc()).toBe(0);
    expect(pool.age[0]).toBe(0);
  });

  it('flags colours dirty on every colour write', () => {
    const pool = new ParticlePool(2);
    expect(pool.colorsDirty).toBe(false);
    spawn(pool, { color: [0.2, 0.4, 0.6] });
    expect(pool.colorsDirty).toBe(true);
    expect(Array.from(pool.colors.slice(0, 3))).toEqual([
      expect.closeTo(0.2, 6),
      expect.closeTo(0.4, 6),
      expect.closeTo(0.6, 6),
    ]);
  });

  it('integrates position from velocity with no gravity or drag', () => {
    const pool = new ParticlePool(1);
    spawn(pool, { v: [1, 2, -3] });
    pool.step(0.1, 9.81);
    expect(pool.px[0]).toBeCloseTo(0.1, 6);
    expect(pool.py[0]).toBeCloseTo(0.2, 6);
    expect(pool.pz[0]).toBeCloseTo(-0.3, 6);
  });

  it('applies gravity scaled per particle (semi-implicit Euler)', () => {
    const pool = new ParticlePool(2);
    spawn(pool, { gravityScale: 1 });
    spawn(pool, { gravityScale: 0.5 });
    pool.step(0.1, 10);
    // v first: -1 m/s and -0.5 m/s, then p += v*dt.
    expect(pool.vy[0]).toBeCloseTo(-1, 6);
    expect(pool.py[0]).toBeCloseTo(-0.1, 6);
    expect(pool.vy[1]).toBeCloseTo(-0.5, 6);
    expect(pool.py[1]).toBeCloseTo(-0.05, 6);
  });

  it('slows particles with drag but never reverses them', () => {
    const pool = new ParticlePool(1);
    spawn(pool, { v: [2, 0, 0], drag: 3, life: 10 });
    let previous = 2;
    for (let i = 0; i < 30; i++) {
      pool.step(0.05, 0);
      expect(pool.vx[0]).toBeLessThan(previous);
      expect(pool.vx[0]).toBeGreaterThan(0);
      previous = pool.vx[0];
    }
    // Even an absurd step leaves the velocity positive.
    pool.step(10, 0);
    expect(pool.vx[0]).toBeGreaterThanOrEqual(0);
  });

  it('retires expired particles by swap-remove, keeping live ones dense', () => {
    const pool = new ParticlePool(4);
    spawn(pool, { life: 0.05, color: [1, 0, 0] }); // dies first step
    spawn(pool, { life: 1, color: [0, 1, 0], v: [1, 0, 0] });
    spawn(pool, { life: 0.05, color: [0, 0, 1] }); // dies first step
    spawn(pool, { life: 1, color: [1, 1, 0], v: [0, 1, 0] });
    pool.colorsDirty = false;

    pool.step(0.1, 0);

    expect(pool.count).toBe(2);
    // The two survivors are packed into slots 0 and 1, colours moved with them.
    const survivors = [0, 1].map((i) => [
      pool.colors[i * 3],
      pool.colors[i * 3 + 1],
      pool.colors[i * 3 + 2],
    ]);
    expect(survivors).toContainEqual([0, 1, 0]);
    expect(survivors).toContainEqual([1, 1, 0]);
    expect(pool.colorsDirty).toBe(true);
    // And each survivor carries its own motion, stepped exactly once.
    for (let i = 0; i < 2; i++) {
      expect(pool.age[i]).toBeCloseTo(0.1, 6);
      const moved = Math.hypot(pool.px[i], pool.py[i], pool.pz[i]);
      expect(moved).toBeCloseTo(0.1, 6);
    }
  });

  it('can retire every particle in one step', () => {
    const pool = new ParticlePool(8);
    for (let i = 0; i < 8; i++) spawn(pool, { life: 0.01 });
    pool.step(0.02, 0);
    expect(pool.count).toBe(0);
    expect(pool.alloc()).toBe(0);
  });

  it('lets the last particle expire without touching other slots', () => {
    const pool = new ParticlePool(2);
    spawn(pool, { life: 1, color: [0.5, 0.5, 0.5] });
    spawn(pool, { life: 0.01, color: [0.9, 0.1, 0.1] });
    pool.colorsDirty = false;
    pool.step(0.02, 0);
    expect(pool.count).toBe(1);
    expect(pool.colors[0]).toBeCloseTo(0.5, 6);
    // Removing the tail needs no move, so no colour upload either.
    expect(pool.colorsDirty).toBe(false);
  });
});

describe('lifeScale', () => {
  const grow = 0.1;
  const shrink = 0.6;

  it('pops in from 40% rather than from nothing', () => {
    expect(lifeScale(0, grow, shrink)).toBeCloseTo(0.4, 6);
    expect(lifeScale(grow / 2, grow, shrink)).toBeGreaterThan(0.4);
    expect(lifeScale(grow / 2, grow, shrink)).toBeLessThan(1);
  });

  it('holds full size between grow and shrink', () => {
    expect(lifeScale(grow, grow, shrink)).toBeCloseTo(1, 6);
    expect(lifeScale(0.3, grow, shrink)).toBe(1);
    expect(lifeScale(shrink, grow, shrink)).toBe(1);
  });

  it('shrinks monotonically to exactly zero at end of life', () => {
    let previous = 1;
    for (let t = shrink; t <= 1.0001; t += 0.05) {
      const s = lifeScale(Math.min(1, t), grow, shrink);
      expect(s).toBeLessThanOrEqual(previous + 1e-9);
      previous = s;
    }
    expect(lifeScale(1, grow, shrink)).toBe(0);
  });

  it('clamps out-of-range ages', () => {
    expect(lifeScale(-1, grow, shrink)).toBeCloseTo(0.4, 6);
    expect(lifeScale(2, grow, shrink)).toBe(0);
  });

  it('starts at full size when there is no grow phase', () => {
    expect(lifeScale(0, 0, shrink)).toBe(1);
  });
});

describe('burstAxis', () => {
  let out: Float32Array;
  beforeEach(() => {
    out = new Float32Array(3);
  });

  it('points from the impact back toward the viewer', () => {
    // Wall 3 m ahead (-Z), head at standing height.
    burstAxis(0, 1.6, -3, 0, 1.6, 0, out);
    expect(out[2]).toBeCloseTo(1, 6);
    expect(length(out)).toBeCloseTo(1, 6);
  });

  it('points mostly up for a floor hit in front of the player', () => {
    burstAxis(0, 0, -1, 0, 1.6, 0, out);
    expect(out[1]).toBeGreaterThan(0.8);
    expect(length(out)).toBeCloseTo(1, 6);
  });

  it('falls back to straight up when the points coincide', () => {
    burstAxis(1, 2, 3, 1, 2, 3, out);
    expect(Array.from(out)).toEqual([0, 1, 0]);
  });
});

describe('tiltUp', () => {
  it('leaves directions alone with no bias', () => {
    const dir = new Float32Array([1, 0, 0]);
    tiltUp(dir, 0);
    expect(Array.from(dir)).toEqual([1, 0, 0]);
  });

  it('tilts a horizontal direction upward and keeps it unit length', () => {
    const dir = new Float32Array([1, 0, 0]);
    tiltUp(dir, 1);
    expect(dir[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(dir[1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(length(dir)).toBeCloseTo(1, 6);
  });

  it('does not collapse a direction the bias exactly cancels', () => {
    const dir = new Float32Array([0, -1, 0]);
    tiltUp(dir, 1);
    expect(Array.from(dir)).toEqual([0, -1, 0]);
  });
});

describe('coneDirection', () => {
  const t = new Float32Array(3);
  const b = new Float32Array(3);
  const out = new Float32Array(3);
  // Deterministic grid of (u1, u2) samples covering the unit square.
  const samples: Array<[number, number]> = [];
  for (let i = 0; i < 9; i++) {
    for (let j = 0; j < 9; j++) samples.push([i / 8.0001, j / 8.0001]);
  }

  const axes: Array<[number, number, number]> = [
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [1 / Math.sqrt(3), 1 / Math.sqrt(3), -1 / Math.sqrt(3)],
  ];

  it('always returns a unit vector', () => {
    for (const [ax, ay, az] of axes) {
      for (const [u1, u2] of samples) {
        coneDirection(ax, ay, az, Math.PI / 3, u1, u2, t, b, out);
        expect(length(out)).toBeCloseTo(1, 5);
      }
    }
  });

  it('stays inside the cone half-angle', () => {
    const half = (40 * Math.PI) / 180;
    for (const [ax, ay, az] of axes) {
      for (const [u1, u2] of samples) {
        coneDirection(ax, ay, az, half, u1, u2, t, b, out);
        const cos = out[0] * ax + out[1] * ay + out[2] * az;
        expect(cos).toBeGreaterThanOrEqual(Math.cos(half) - 1e-5);
      }
    }
  });

  it('returns the axis itself at u1 = 0', () => {
    for (const [ax, ay, az] of axes) {
      coneDirection(ax, ay, az, Math.PI / 2, 0, 0.37, t, b, out);
      expect(out[0]).toBeCloseTo(ax, 5);
      expect(out[1]).toBeCloseTo(ay, 5);
      expect(out[2]).toBeCloseTo(az, 5);
    }
  });

  it('reaches the opposite pole for a full-sphere burst', () => {
    coneDirection(0, 1, 0, Math.PI, 1, 0, t, b, out);
    expect(out[1]).toBeCloseTo(-1, 5);
  });

  it('spreads around the axis rather than bunching on one side', () => {
    // Half-angle 90 deg around +Y: the azimuth sweep must cover all four
    // horizontal quadrants.
    const seen = new Set<string>();
    for (const [u1, u2] of samples) {
      if (u1 < 0.5) continue;
      coneDirection(0, 1, 0, Math.PI / 2, u1, u2, t, b, out);
      seen.add(`${Math.sign(Math.round(out[0] * 100))},${Math.sign(Math.round(out[2] * 100))}`);
    }
    for (const quadrant of ['1,1', '1,-1', '-1,1', '-1,-1']) {
      expect(seen.has(quadrant)).toBe(true);
    }
  });
});

describe('shapeCode', () => {
  it('maps every config spelling to its byte', () => {
    expect(shapeCode('blob')).toBe(ParticleShape.Blob);
    expect(shapeCode('flake')).toBe(ParticleShape.Flake);
    expect(shapeCode('streak')).toBe(ParticleShape.Streak);
  });
});

describe('VFX config', () => {
  const bursts: Array<[string, VfxBurstConfig]> = [
    ['pop', VFX.pop],
    ['impact', VFX.impact],
    ['hit', VFX.hit],
    ['tether', VFX.tether],
    ['muzzle', VFX.muzzle],
  ];

  it.each(bursts)('%s has sane, ordered ranges', (_name, burst) => {
    expect(Number.isInteger(burst.count)).toBe(true);
    expect(burst.count).toBeGreaterThanOrEqual(0);
    expect(burst.speedMin).toBeGreaterThanOrEqual(0);
    expect(burst.speedMax).toBeGreaterThanOrEqual(burst.speedMin);
    expect(burst.lifeMin).toBeGreaterThan(0);
    expect(burst.lifeMax).toBeGreaterThanOrEqual(burst.lifeMin);
    expect(burst.size).toBeGreaterThan(0);
    expect(burst.spreadDeg).toBeGreaterThan(0);
    expect(burst.spreadDeg).toBeLessThanOrEqual(180);
    expect(burst.gravityScale).toBeGreaterThanOrEqual(0);
    expect(burst.drag).toBeGreaterThanOrEqual(0);
    expect(burst.startOffset).toBeGreaterThanOrEqual(0);
  });

  it('fits the worst realistic frame in the pool', () => {
    // Two simultaneous pops (each with its killing-blow hit spray), a tether
    // latch, and a fistful of impacts and shots, all in one frame.
    const burstLoad =
      2 * (VFX.pop.count + VFX.hit.count) +
      VFX.tether.count +
      4 * VFX.impact.count +
      2 * VFX.muzzle.count;
    expect(burstLoad).toBeLessThanOrEqual(VFX.poolSize);
  });

  it('keeps the life curve well-formed', () => {
    expect(VFX.growEnd).toBeGreaterThanOrEqual(0);
    expect(VFX.growEnd).toBeLessThan(VFX.shrinkStart);
    expect(VFX.shrinkStart).toBeLessThan(1);
    expect(VFX.maxStepSec).toBeGreaterThan(0);
    expect(VFX.spinMax).toBeGreaterThanOrEqual(VFX.spinMin);
    expect(VFX.flakeThickness).toBeGreaterThan(0);
    expect(VFX.streakStretch).toBeGreaterThanOrEqual(1);
    expect(VFX.poolSize).toBeGreaterThan(0);
    expect(Number.isInteger(VFX.poolSize)).toBe(true);
  });

  it('keeps particles to a few millimetres so they never block aim', () => {
    for (const [, burst] of bursts) {
      // Largest possible radius: base * size * max jitter (1.3).
      expect(VFX.particleRadius * burst.size * 1.3).toBeLessThan(0.02);
    }
  });
});
