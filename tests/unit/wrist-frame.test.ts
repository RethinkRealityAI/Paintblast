import { describe, it, expect } from 'vitest';
import {
  ballisticAim,
  blendAim,
  buildAimBasis,
  buildFacingBasis,
  drainReelQueue,
  handGripToWristBasis,
  handMirror,
  pickAssistedAim,
  pullReel,
  quatFromBasis,
  rotateByQuat,
  smoothingAlpha,
} from '../../src/wrist-frame';
import {
  createPaletteLock,
  stepPaletteLock,
  thinnestAxis,
} from '../../src/systems/WristPaletteSystem';
import { AimTargets } from '../../src/types';
import { WEB } from '../../src/config';

const EPS = 1e-5;

/** Column `c` of a 9-float basis as a tuple. */
function col(b: ArrayLike<number>, c: number): [number, number, number] {
  return [b[c * 3], b[c * 3 + 1], b[c * 3 + 2]];
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function det(b: ArrayLike<number>): number {
  return dot(col(b, 0), cross(col(b, 1), col(b, 2)));
}

/** Rotate v by a quaternion stored [x, y, z, w]. */
function rot(q: ArrayLike<number>, v: [number, number, number]) {
  const out = [0, 0, 0];
  rotateByQuat(q[0], q[1], q[2], q[3], v[0], v[1], v[2], out);
  return out;
}

describe('handMirror', () => {
  it('reflects X for the left hand only', () => {
    expect(handMirror(0)).toBe(-1);
    expect(handMirror(1)).toBe(1);
  });
});

describe('rotateByQuat', () => {
  it('is the identity for the identity quaternion', () => {
    const out = [0, 0, 0];
    rotateByQuat(0, 0, 0, 1, 1, 2, 3, out);
    expect(out[0]).toBeCloseTo(1);
    expect(out[1]).toBeCloseTo(2);
    expect(out[2]).toBeCloseTo(3);
  });

  it('turns +X onto +Y for a quarter turn about Z', () => {
    const h = Math.SQRT1_2;
    const out = [0, 0, 0];
    rotateByQuat(0, 0, h, h, 1, 0, 0, out);
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(1);
    expect(out[2]).toBeCloseTo(0);
  });
});

describe('buildAimBasis', () => {
  it('points -Z exactly along forward', () => {
    const b = new Float32Array(9);
    expect(buildAimBasis(0.3, -0.2, -0.9, 0, 1, 0, b)).toBe(true);
    const z = col(b, 2);
    const len = Math.hypot(0.3, -0.2, -0.9);
    expect(-z[0]).toBeCloseTo(0.3 / len, 5);
    expect(-z[1]).toBeCloseTo(-0.2 / len, 5);
    expect(-z[2]).toBeCloseTo(-0.9 / len, 5);
  });

  it('is orthonormal and right-handed for an oblique up hint', () => {
    const b = new Float32Array(9);
    buildAimBasis(1, 0.4, -0.2, 0.3, 1, 0.5, b);
    for (let c = 0; c < 3; c++) {
      expect(dot(col(b, c), col(b, c))).toBeCloseTo(1, 5);
    }
    expect(dot(col(b, 0), col(b, 1))).toBeCloseTo(0, 5);
    expect(dot(col(b, 1), col(b, 2))).toBeCloseTo(0, 5);
    expect(dot(col(b, 0), col(b, 2))).toBeCloseTo(0, 5);
    expect(det(b)).toBeCloseTo(1, 5);
  });

  it('keeps Y on the side the hint points to', () => {
    const b = new Float32Array(9);
    buildAimBasis(0, 0, -1, 0, 0.2, 0, b);
    expect(col(b, 1)[1]).toBeGreaterThan(0.99);
  });

  it('survives a hint parallel to forward instead of producing NaN', () => {
    const b = new Float32Array(9);
    expect(buildAimBasis(0, 1, 0, 0, 3, 0, b)).toBe(true);
    for (let i = 0; i < 9; i++) expect(Number.isFinite(b[i])).toBe(true);
    expect(det(b)).toBeCloseTo(1, 5);
  });

  it('refuses a zero forward', () => {
    const b = new Float32Array(9);
    expect(buildAimBasis(0, 0, 0, 0, 1, 0, b)).toBe(false);
  });
});

describe('quatFromBasis', () => {
  it('round-trips every axis of a basis through the quaternion', () => {
    const b = new Float32Array(9);
    const q = new Float32Array(4);
    // Sweep forwards that exercise every Shepperd branch.
    const forwards: Array<[number, number, number]> = [
      [0, 0, -1],
      [0, 0, 1],
      [1, 0, 0],
      [-1, 0.2, 0],
      [0.2, -1, 0.1],
      [0.6, 0.5, 0.6],
    ];
    for (const f of forwards) {
      buildAimBasis(f[0], f[1], f[2], 0.1, 1, 0.2, b);
      quatFromBasis(b, q);
      expect(Math.hypot(q[0], q[1], q[2], q[3])).toBeCloseTo(1, 5);
      for (let c = 0; c < 3; c++) {
        const unit: [number, number, number] = [0, 0, 0];
        unit[c] = 1;
        const r = rot(q, unit);
        const axis = col(b, c);
        expect(r[0]).toBeCloseTo(axis[0], 4);
        expect(r[1]).toBeCloseTo(axis[1], 4);
        expect(r[2]).toBeCloseTo(axis[2], 4);
      }
    }
  });
});

describe('handGripToWristBasis', () => {
  // The bug round 7 fixed: in a tracked hand's grip space, distal (toward the
  // fingers) is -Y and the thumb is -Z. Round 6 fired along grip -Z.
  for (const hand of [0, 1]) {
    const name = hand === 0 ? 'left' : 'right';

    it(`is a proper rotation for the ${name} hand`, () => {
      const b = new Float32Array(9);
      handGripToWristBasis(hand, b);
      expect(det(b)).toBeCloseTo(1, 6);
    });

    it(`maps wrist-forward onto grip -Y (distal) for the ${name} hand`, () => {
      const b = new Float32Array(9);
      handGripToWristBasis(hand, b);
      // Wrist -Z, expressed in grip coordinates, is minus the Z column.
      const z = col(b, 2);
      expect(-z[0]).toBeCloseTo(0);
      expect(-z[1]).toBeCloseTo(-1);
      expect(-z[2]).toBeCloseTo(0);
    });

    it(`puts dorsal on the spec's back-of-hand X for the ${name} hand`, () => {
      const b = new Float32Array(9);
      handGripToWristBasis(hand, b);
      // +X is the back of the right hand, -X the back of the left.
      expect(col(b, 1)[0]).toBe(handMirror(hand));
    });
  }

  it('never maps forward onto the thumb axis (grip Z)', () => {
    const b = new Float32Array(9);
    for (const hand of [0, 1]) {
      handGripToWristBasis(hand, b);
      expect(Math.abs(col(b, 2)[2])).toBeLessThan(EPS);
    }
  });
});

describe('smoothingAlpha', () => {
  it('passes straight through with no time constant', () => {
    expect(smoothingAlpha(1 / 72, 0)).toBe(1);
  });

  it('holds still on a zero frame', () => {
    expect(smoothingAlpha(0, 0.03)).toBe(0);
  });

  it('is frame-rate independent', () => {
    // Two 90 Hz frames must cover the same ground as... 2/90 s in one step.
    const a90 = smoothingAlpha(1 / 90, 0.03);
    const twoFrames = 1 - (1 - a90) * (1 - a90);
    expect(twoFrames).toBeCloseTo(smoothingAlpha(2 / 90, 0.03), 6);
  });

  it('settles a 72 Hz shooter within a handful of frames', () => {
    let remaining = 1;
    for (let i = 0; i < 8; i++) {
      remaining *= 1 - smoothingAlpha(1 / 72, WEB.shooterSmoothingSec);
    }
    expect(remaining).toBeLessThan(0.05);
  });
});

/** Integrate a projectile and return its closest approach to a point. */
function closestApproach(
  origin: [number, number, number],
  dir: ArrayLike<number>,
  speed: number,
  gravity: number,
  target: [number, number, number],
): number {
  let x = origin[0];
  let y = origin[1];
  let z = origin[2];
  let vx = dir[0] * speed;
  let vy = dir[1] * speed;
  let vz = dir[2] * speed;
  const dt = 1 / 2000;
  let best = Infinity;
  for (let i = 0; i < 4000; i++) {
    vy -= gravity * dt;
    x += vx * dt;
    y += vy * dt;
    z += vz * dt;
    best = Math.min(
      best,
      Math.hypot(x - target[0], y - target[1], z - target[2]),
    );
  }
  return best;
}

describe('ballisticAim', () => {
  it('aims straight at the target with no gravity', () => {
    const out = [0, 0, 0];
    expect(ballisticAim(0, 1, 0, 0, 1, -3, { speed: 8, gravity: 0 }, out)).toBe(
      true,
    );
    expect(out[2]).toBeCloseTo(-1);
  });

  it('lifts the shot so it lands on the target under gravity', () => {
    const out = [0, 0, 0];
    const cfg = { speed: 8.5, gravity: 9.81 };
    expect(ballisticAim(0, 1.2, 0, 0.5, 1.4, -2.8, cfg, out)).toBe(true);
    expect(out[1]).toBeGreaterThan(0.07); // above the straight line
    expect(
      closestApproach([0, 1.2, 0], out, cfg.speed, cfg.gravity, [0.5, 1.4, -2.8]),
    ).toBeLessThan(0.01);
  });

  it('reports a target out of range', () => {
    const out = [0, 0, 0];
    expect(
      ballisticAim(0, 0, 0, 0, 0, -50, { speed: 5, gravity: 9.81 }, out),
    ).toBe(false);
  });

  it('refuses a target straight overhead', () => {
    const out = [0, 0, 0];
    expect(
      ballisticAim(0, 0, 0, 0, 2, 0, { speed: 8, gravity: 9.81 }, out),
    ).toBe(false);
  });
});

describe('pickAssistedAim', () => {
  const cfg = {
    speed: 8.5,
    gravity: 9.81,
    maxAngleRad: (6 * Math.PI) / 180,
    maxRange: 6,
  };

  function targets(points: Array<[number, number, number] | null>) {
    const aim = new AimTargets(points.length);
    points.forEach((p, i) => {
      if (!p) return;
      aim.active[i] = 1;
      aim.positions.set(p, i * 3);
    });
    return aim;
  }

  it('bends a shot aimed straight at a robot onto the arc that hits', () => {
    const aim = targets([[0.15, 1.5, -3]]);
    const scratch = new Float32Array(3);
    const out = new Float32Array(3);
    // Aimed a little left of and level with the robot.
    const len = Math.hypot(0, 0.05, -1);
    const slot = pickAssistedAim(
      0, 1.4, 0,
      0, 0.05 / len, -1 / len,
      aim.positions, aim.active, aim.capacity, cfg, scratch, out,
    );
    expect(slot).toBe(0);
    expect(
      closestApproach([0, 1.4, 0], out, cfg.speed, cfg.gravity, [0.15, 1.5, -3]),
    ).toBeLessThan(0.02);
  });

  it('leaves a shot alone when nothing is inside the cone', () => {
    const aim = targets([[2, 1.5, -1]]);
    const out = new Float32Array([9, 9, 9]);
    const slot = pickAssistedAim(
      0, 1.4, 0, 0, 0, -1,
      aim.positions, aim.active, aim.capacity, cfg,
      new Float32Array(3), out,
    );
    expect(slot).toBe(-1);
    expect(Array.from(out)).toEqual([9, 9, 9]);
  });

  it('ignores inactive slots and targets past maxRange', () => {
    const aim = targets([[0, 1.4, -3], [0, 1.4, -9]]);
    aim.active[0] = 0;
    const slot = pickAssistedAim(
      0, 1.4, 0, 0, 0, -1,
      aim.positions, aim.active, aim.capacity, cfg,
      new Float32Array(3), new Float32Array(3),
    );
    expect(slot).toBe(-1);
  });

  it('also catches a player who leads the drop, a little off line', () => {
    const aim = targets([[0.1, 1.4, -3]]);
    const out = new Float32Array(3);
    // ~12 degrees up (roughly the arc), ~2 degrees off to the side.
    const d: [number, number, number] = [0, 0.21, -1];
    const len = Math.hypot(...d);
    const slot = pickAssistedAim(
      0, 1.4, 0,
      d[0] / len, d[1] / len, d[2] / len,
      aim.positions, aim.active, aim.capacity, cfg,
      new Float32Array(3), out,
    );
    expect(slot).toBe(0);
    expect(
      closestApproach([0, 1.4, 0], out, cfg.speed, cfg.gravity, [0.1, 1.4, -3]),
    ).toBeLessThan(0.02);
  });

  it('prefers the target needing the smallest correction', () => {
    const aim = targets([[0.25, 1.45, -3], [0.05, 1.45, -3]]);
    const slot = pickAssistedAim(
      0, 1.4, 0, 0, 0.03, -1,
      aim.positions, aim.active, aim.capacity, cfg,
      new Float32Array(3), new Float32Array(3),
    );
    expect(slot).toBe(1);
  });

  it('is off with a zero cone', () => {
    const aim = targets([[0, 1.4, -3]]);
    const slot = pickAssistedAim(
      0, 1.4, 0, 0, 0, -1,
      aim.positions, aim.active, aim.capacity,
      { ...cfg, maxAngleRad: 0 },
      new Float32Array(3), new Float32Array(3),
    );
    expect(slot).toBe(-1);
  });
});

describe('AimTargets', () => {
  it('allocates fixed storage and starts empty', () => {
    const aim = new AimTargets(8);
    expect(aim.positions).toHaveLength(24);
    expect(Array.from(aim.active).every((v) => v === 0)).toBe(true);
  });

  it('clears every slot', () => {
    const aim = new AimTargets(3);
    aim.active.fill(1);
    aim.clear();
    expect(Array.from(aim.active)).toEqual([0, 0, 0]);
  });
});

describe('pullReel', () => {
  const cfg = { pullDeadband: 0.2, pullGain: 2 };

  it('takes in nothing for a hand pushing toward the robot', () => {
    expect(pullReel(-3, 1 / 72, cfg)).toBe(0);
  });

  it('ignores motion inside the deadband', () => {
    expect(pullReel(0.19, 1 / 72, cfg)).toBe(0);
  });

  it('is proportional to the pull, past the deadband', () => {
    const slow = pullReel(0.7, 0.1, cfg);
    const fast = pullReel(1.2, 0.1, cfg);
    expect(slow).toBeCloseTo(0.5 * 0.1 * 2, 6);
    expect(fast).toBeCloseTo(1.0 * 0.1 * 2, 6);
  });

  it('is frame-rate independent', () => {
    let at72 = 0;
    for (let i = 0; i < 72; i++) at72 += pullReel(1, 1 / 72, cfg);
    let at90 = 0;
    for (let i = 0; i < 90; i++) at90 += pullReel(1, 1 / 90, cfg);
    expect(at72).toBeCloseTo(at90, 6);
  });
});

describe('drainReelQueue', () => {
  it('never pays out more than is queued', () => {
    expect(drainReelQueue(0.01, 10, 1)).toBe(0.01);
  });

  it('caps the travel at the glide speed', () => {
    expect(drainReelQueue(1, 4, 0.1)).toBeCloseTo(0.4, 6);
  });

  it('does nothing with an empty queue or a zero frame', () => {
    expect(drainReelQueue(0, 4, 0.1)).toBe(0);
    expect(drainReelQueue(1, 4, 0)).toBe(0);
  });

  it('turns a whole queued haul into a glide over several frames', () => {
    let queue = 0.55; // the size of round 6's single teleport
    let frames = 0;
    while (queue > 1e-9 && frames < 100) {
      queue -= drainReelQueue(queue, WEB.reelGlideSpeed, 1 / 72);
      frames++;
    }
    expect(frames).toBeGreaterThan(4);
    expect(frames).toBeLessThan(20);
  });
});

describe('stepPaletteLock', () => {
  const R = 0.16;
  const HOLD = 0.35;

  it('parks the instant a fingertip comes inside the radius', () => {
    const lock = createPaletteLock();
    stepPaletteLock(lock, 0.1, 0, R, HOLD);
    expect(lock.locked).toBe(true);
  });

  it('does not let go while the fingertip hovers at the edge', () => {
    const lock = createPaletteLock();
    stepPaletteLock(lock, 0.1, 0, R, HOLD);
    expect(stepPaletteLock(lock, 0.2, 0.2, R, HOLD)).toBe(false);
    expect(lock.locked).toBe(true);
    // Back inside resets the clock.
    stepPaletteLock(lock, 0.15, 0.3, R, HOLD);
    expect(stepPaletteLock(lock, 0.3, 0.6, R, HOLD)).toBe(false);
    expect(lock.locked).toBe(true);
  });

  it('releases once, after the grace period, and reports it', () => {
    const lock = createPaletteLock();
    stepPaletteLock(lock, 0.1, 0, R, HOLD);
    expect(stepPaletteLock(lock, 0.5, HOLD, R, HOLD)).toBe(true);
    expect(lock.locked).toBe(false);
    expect(stepPaletteLock(lock, 0.5, HOLD + 0.1, R, HOLD)).toBe(false);
  });

  it('treats a lost fingertip as outside, so it still lets go', () => {
    const lock = createPaletteLock();
    stepPaletteLock(lock, 0.1, 0, R, HOLD);
    expect(
      stepPaletteLock(lock, Number.POSITIVE_INFINITY, 1, R, HOLD),
    ).toBe(true);
  });
});

describe('blendAim', () => {
  const NEAR = (30 * Math.PI) / 180;
  const FAR = (65 * Math.PI) / 180;

  it('uses the OS ray outright when it agrees with the hand', () => {
    const out = [0, 0, 0];
    // 20 degrees apart.
    const a = (20 * Math.PI) / 180;
    blendAim(0, 0, -1, Math.sin(a), 0, -Math.cos(a), NEAR, FAR, out);
    expect(out[0]).toBeCloseTo(Math.sin(a), 5);
    expect(out[2]).toBeCloseTo(-Math.cos(a), 5);
  });

  it('keeps to the hand when the ray has swung far off the arm', () => {
    const out = [0, 0, 0];
    // Hand turned straight up to look at it; the pointer stays forward.
    blendAim(0, 1, 0, 0, 0, -1, NEAR, FAR, out);
    expect(out[1]).toBeCloseTo(1, 5);
  });

  it('blends continuously in between, with no snap', () => {
    let prevX = -Infinity;
    for (let deg = 0; deg <= 90; deg += 1) {
      const a = (deg * Math.PI) / 180;
      const out = [0, 0, 0];
      blendAim(0, 0, -1, Math.sin(a), 0, -Math.cos(a), NEAR, FAR, out);
      expect(Math.hypot(out[0], out[1], out[2])).toBeCloseTo(1, 5);
      // The blended x never jumps by more than a few hundredths per degree.
      if (prevX !== -Infinity) {
        expect(Math.abs(out[0] - prevX)).toBeLessThan(0.06);
      }
      prevX = out[0];
    }
  });

  it('falls back to whichever input exists', () => {
    const out = [0, 0, 0];
    blendAim(0, 0, 0, 0, 0, -2, NEAR, FAR, out);
    expect(out[2]).toBeCloseTo(-1);
    blendAim(3, 0, 0, 0, 0, 0, NEAR, FAR, out);
    expect(out[0]).toBeCloseTo(1);
  });
});

describe('buildFacingBasis', () => {
  it('faces +Y exactly along the normal', () => {
    const b = new Float32Array(9);
    expect(buildFacingBasis(0.2, 0.9, 0.4, 0, 0, -1, b)).toBe(true);
    const len = Math.hypot(0.2, 0.9, 0.4);
    const y = col(b, 1);
    expect(y[0]).toBeCloseTo(0.2 / len, 5);
    expect(y[1]).toBeCloseTo(0.9 / len, 5);
    expect(y[2]).toBeCloseTo(0.4 / len, 5);
  });

  it('points -Z as close to forward as it can, and is right-handed', () => {
    const b = new Float32Array(9);
    buildFacingBasis(0, 1, 0, 0.3, 0.5, -1, b);
    const z = col(b, 2);
    // Forward projected onto the board's plane, then negated.
    const len = Math.hypot(0.3, 1);
    expect(-z[0]).toBeCloseTo(0.3 / len, 5);
    expect(z[1]).toBeCloseTo(0, 5);
    expect(-z[2]).toBeCloseTo(-1 / len, 5);
    expect(det(b)).toBeCloseTo(1, 5);
  });

  it('survives a forward parallel to the normal', () => {
    const b = new Float32Array(9);
    expect(buildFacingBasis(0, 1, 0, 0, 5, 0, b)).toBe(true);
    for (let i = 0; i < 9; i++) expect(Number.isFinite(b[i])).toBe(true);
    expect(det(b)).toBeCloseTo(1, 5);
  });

  it('refuses a zero normal', () => {
    expect(buildFacingBasis(0, 0, 0, 0, 0, -1, new Float32Array(9))).toBe(false);
  });
});

describe('thinnestAxis', () => {
  it('finds the shipped palette GLB is a slab thin along Z', () => {
    // Measured off public/gltf/palette-board.glb's POSITION accessor.
    expect(thinnestAxis(1.899, 1.318, 0.23)).toBe(2);
  });

  it('leaves a board already thin along Y alone', () => {
    expect(thinnestAxis(0.22, 0.008, 0.187)).toBe(1);
  });

  it('handles a slab thin along X', () => {
    expect(thinnestAxis(0.01, 0.3, 0.2)).toBe(0);
  });

  it('prefers no rotation on a tie', () => {
    expect(thinnestAxis(1, 1, 1)).toBe(1);
  });
});
