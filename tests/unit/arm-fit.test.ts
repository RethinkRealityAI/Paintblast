import { describe, it, expect } from 'vitest';

import {
  ArmFitCalibrator,
  ARMFIT_JOINT_NAMES,
  SampleResult,
  blendForearmAxis,
  clampQuatAngle,
  computeArmFit,
  createArmFit,
  forearmSectionAt,
  measureHand,
  medianOf,
  parseArmCalibration,
  resolveHandJoints,
  serializeArmCalibration,
  sleeveScaleFor,
  solveElbow,
} from '../../src/systems/GauntletSystem';
import type { ArmFit, HandMeasurement } from '../../src/systems/GauntletSystem';
import { ARMFIT, BLASTER, WEB } from '../../src/config';
import { relaxedHandPose } from 'iwer/lib/device/configs/hand/relaxed.js';

const fitFor = (L: number, P: number, R = NaN): ArmFit =>
  computeArmFit(L, P, R, ARMFIT, createArmFit());

/**
 * The headless harness's forearm proxy: an elliptical cone from 6.6 x 5.0 cm
 * at the wrist joint to 8.4 x 7.6 cm 25 cm up the arm (a realistic adult
 * forearm). Semi-axes at z.
 */
const proxy = (z: number) => {
  const t = Math.min(1, z / 0.25);
  return { a: 0.033 + (0.042 - 0.033) * t, b: 0.025 + (0.038 - 0.025) * t };
};

describe('computeArmFit (anthropometric model)', () => {
  const base = fitFor(ARMFIT.defaultHandLengthMeters, ARMFIT.defaultPalmWidthMeters);

  it('estimates an adult forearm from the default hand', () => {
    expect(base.forearmLength).toBeGreaterThan(0.23);
    expect(base.forearmLength).toBeLessThan(0.28);
    // Wrist circumference 15-18 cm, max forearm circumference 24-30 cm.
    expect(2 * Math.PI * base.wristRadius).toBeGreaterThan(0.15);
    expect(2 * Math.PI * base.wristRadius).toBeLessThan(0.18);
    expect(2 * Math.PI * base.maxRadius).toBeGreaterThan(0.24);
    expect(2 * Math.PI * base.maxRadius).toBeLessThan(0.3);
    expect(base.upperArmLength).toBeGreaterThan(0.29);
    expect(base.upperArmLength).toBeLessThan(0.35);
  });

  it('covers from just behind the wrist to 60-70% of the forearm', () => {
    expect(base.sleeveStart).toBeGreaterThan(0);
    expect(base.sleeveStart).toBeLessThan(0.025);
    const cover = base.sleeveEnd / base.forearmLength;
    expect(cover).toBeGreaterThanOrEqual(0.6);
    expect(cover).toBeLessThanOrEqual(0.7);
  });

  it('inner wall = forearm + skin margin, and tapers wider toward the elbow', () => {
    const s = { a: 0, b: 0 };
    forearmSectionAt(base, base.sleeveStart, 0, s);
    expect(base.innerA0 - s.a).toBeCloseTo(ARMFIT.skinMarginMeters, 6);
    expect(base.innerB0 - s.b).toBeCloseTo(ARMFIT.skinMarginMeters, 6);
    expect(base.innerA1).toBeGreaterThan(base.innerA0 * 1.15);
    expect(base.innerB1).toBeGreaterThan(base.innerB0 * 1.15);
    // Wider than deep (the forearm is an ellipse), rounder toward the elbow.
    expect(base.innerA0).toBeGreaterThan(base.innerB0);
    expect(base.innerB1 / base.innerA1).toBeGreaterThan(base.innerB0 / base.innerA0);
  });

  it('encloses a realistic adult forearm along the whole sleeve', () => {
    for (let z = base.sleeveStart; z <= base.sleeveEnd; z += 0.01) {
      const s = forearmSectionAt(base, z, ARMFIT.skinMarginMeters, { a: 0, b: 0 });
      const p = proxy(z);
      expect(s.a).toBeGreaterThanOrEqual(p.a);
      expect(s.b).toBeGreaterThanOrEqual(p.b);
    }
  });

  it('the margin is 6-10 mm and the skin estimate never exceeds the inner wall', () => {
    expect(ARMFIT.skinMarginMeters).toBeGreaterThanOrEqual(0.006);
    expect(ARMFIT.skinMarginMeters).toBeLessThanOrEqual(0.01);
  });

  it('scales with the hand: small and large players get small and large sleeves', () => {
    const small = fitFor(0.165, 0.072);
    const large = fitFor(0.21, 0.095);
    expect(small.innerA0).toBeLessThan(base.innerA0);
    expect(large.innerA0).toBeGreaterThan(base.innerA0);
    expect(small.sleeveEnd).toBeLessThan(base.sleeveEnd);
    expect(large.sleeveEnd).toBeGreaterThan(base.sleeveEnd);
    expect(large.plateWidth).toBeGreaterThan(small.plateWidth);
    // Plate narrower than the palm: palm edges and fingers stay free.
    expect(large.plateWidth).toBeLessThan(0.095);
    expect(base.plateLength).toBeLessThan(0.1); // short of the knuckles (~9.6 cm)
  });

  it('uses a plausible wrist joint radius, ignores an implausible one', () => {
    const withR = fitFor(0.187, 0.083, 0.0215);
    expect(withR.wristRadius).not.toBeCloseTo(base.wristRadius, 6);
    // IWER's (Meta-captured) wrist radius agrees with the palm estimate within 10%.
    expect(Math.abs(withR.wristRadius - base.wristRadius) / base.wristRadius).toBeLessThan(0.1);
    expect(fitFor(0.187, 0.083, 0.2).wristRadius).toBeCloseTo(base.wristRadius, 9);
    expect(fitFor(0.187, 0.083, NaN).wristRadius).toBeCloseTo(base.wristRadius, 9);
  });

  it('falls back to the defaults on garbage input', () => {
    const g = fitFor(NaN, -1);
    expect(g.handLength).toBe(ARMFIT.defaultHandLengthMeters);
    expect(g.palmWidth).toBe(ARMFIT.defaultPalmWidthMeters);
  });
});

describe('sleeveScaleFor', () => {
  const base = fitFor(ARMFIT.defaultHandLengthMeters, ARMFIT.defaultPalmWidthMeters);

  it('is identity for the default fit', () => {
    const out = [0, 0, 0];
    sleeveScaleFor(base, base, out);
    expect(out).toEqual([1, 1, 1]);
  });

  it('never leaves the stretched inner wall inside the fitted one', () => {
    for (const [L, P] of [[0.16, 0.07], [0.2, 0.09], [0.23, 0.1]]) {
      const fit = fitFor(L, P);
      const out = [0, 0, 0];
      sleeveScaleFor(fit, base, out);
      expect(base.innerA0 * out[0]).toBeGreaterThanOrEqual(fit.innerA0 - 1e-9);
      expect(base.innerA1 * out[0]).toBeGreaterThanOrEqual(fit.innerA1 - 1e-9);
      expect(base.innerB0 * out[1]).toBeGreaterThanOrEqual(fit.innerB0 - 1e-9);
      expect(base.innerB1 * out[1]).toBeGreaterThanOrEqual(fit.innerB1 - 1e-9);
      expect(base.sleeveEnd * out[2]).toBeCloseTo(fit.sleeveEnd, 9);
      // ...and by no more than a couple of mm (shape is proportional).
      expect(base.innerA0 * out[0] - fit.innerA0).toBeLessThan(0.003);
    }
  });
});

/** IWER's relaxed hand (captured by Meta) as an IWSDK-style jointTransforms buffer. */
function iwerHand(scale = 1): { names: string[]; tr: Float32Array; radii: Float32Array } {
  const jt = (relaxedHandPose as { jointTransforms: Record<string, { offsetMatrix: number[]; radius: number }> }).jointTransforms;
  const names = Object.keys(jt);
  const tr = new Float32Array(names.length * 16);
  const radii = new Float32Array(names.length);
  names.forEach((n, i) => {
    const m = jt[n].offsetMatrix;
    for (let k = 0; k < 16; k++) tr[i * 16 + k] = m[k];
    for (let k = 12; k < 15; k++) tr[i * 16 + k] *= scale;
    radii[i] = jt[n].radius * scale;
  });
  return { names, tr, radii };
}

describe('measureHand', () => {
  const out: HandMeasurement = { handLength: 0, palmWidth: 0, wristRadius: 0 };

  it('resolves every joint it needs from the WebXR names', () => {
    const { names } = iwerHand();
    const idx = new Int16Array(8);
    expect(resolveHandJoints(names, idx)).toBe(true);
    expect(names[idx[0]]).toBe('wrist');
    expect(ARMFIT_JOINT_NAMES).toHaveLength(8);
    expect(resolveHandJoints(['wrist'], new Int16Array(8))).toBe(false);
  });

  it('measures an adult hand from the emulator pose', () => {
    const { names, tr, radii } = iwerHand();
    const idx = new Int16Array(8);
    resolveHandJoints(names, idx);
    expect(measureHand(tr, idx, radii, ARMFIT.fallbackKnuckleRadius, out)).toBe(true);
    expect(out.handLength).toBeGreaterThan(0.18);
    expect(out.handLength).toBeLessThan(0.2);
    expect(out.palmWidth).toBeGreaterThan(0.075);
    expect(out.palmWidth).toBeLessThan(0.088);
    expect(out.wristRadius).toBeCloseTo(0.0215, 3);
  });

  it('works without radii (fallback knuckle radius), giving a similar palm', () => {
    const { names, tr, radii } = iwerHand();
    const idx = new Int16Array(8);
    resolveHandJoints(names, idx);
    measureHand(tr, idx, radii, ARMFIT.fallbackKnuckleRadius, out);
    const withRadii = out.palmWidth;
    measureHand(tr, idx, null, ARMFIT.fallbackKnuckleRadius, out);
    expect(Math.abs(out.palmWidth - withRadii)).toBeLessThan(0.003);
    expect(Number.isNaN(out.wristRadius)).toBe(true);
  });

  it('scales linearly with the hand', () => {
    const idx = new Int16Array(8);
    const a = iwerHand(1);
    const b = iwerHand(0.85);
    resolveHandJoints(a.names, idx);
    measureHand(a.tr, idx, a.radii, 0.0095, out);
    const la = out.handLength;
    measureHand(b.tr, idx, b.radii, 0.0095, out);
    expect(out.handLength / la).toBeCloseTo(0.85, 5);
  });

  it('is pose-invariant: bone lengths survive a curled finger', () => {
    const { names, tr } = iwerHand();
    const idx = new Int16Array(8);
    resolveHandJoints(names, idx);
    measureHand(tr, idx, null, 0.0095, out);
    const open = out.handLength;
    // Curl: rotate the distal and tip joints about the intermediate joint.
    const pivot = idx[3];
    const px = tr[pivot * 16 + 12];
    const py = tr[pivot * 16 + 13];
    const pz = tr[pivot * 16 + 14];
    const c = Math.cos(1.2);
    const s = Math.sin(1.2);
    for (const j of [idx[4], idx[5]]) {
      const x = tr[j * 16 + 12] - px;
      const y = tr[j * 16 + 13] - py;
      tr[j * 16 + 12] = px + x * c - y * s;
      tr[j * 16 + 13] = py + x * s + y * c;
      tr[j * 16 + 14] = pz + (tr[j * 16 + 14] - pz);
    }
    measureHand(tr, idx, null, 0.0095, out);
    expect(out.handLength).toBeCloseTo(open, 5);
  });

  it('refuses a missing joint', () => {
    const idx = new Int16Array([0, 1, 2, 3, 4, 5, 6, -1]);
    expect(measureHand(new Float32Array(25 * 16), idx, null, 0.0095, out)).toBe(false);
  });
});

describe('medianOf', () => {
  it('odd, even, skips non-finite, NaN when empty', () => {
    const scratch = new Float32Array(8);
    expect(medianOf([3, 1, 2], 3, scratch)).toBe(2);
    expect(medianOf([4, 1, 3, 2], 4, scratch)).toBe(2.5);
    expect(medianOf([NaN, 5, 1, Infinity, 3], 5, scratch)).toBe(3);
    expect(Number.isNaN(medianOf([NaN], 1, scratch))).toBe(true);
  });
});

describe('ArmFitCalibrator', () => {
  const cfg = { ...ARMFIT, windowSamples: 10 };

  it('a full window of clean samples calibrates to the medians', () => {
    const c = new ArmFitCalibrator(cfg);
    expect(c.calibrated).toBe(false);
    let last = 0;
    for (let i = 0; i < 10; i++) last = c.addSample(0.19 + (i % 3) * 0.001, 0.08, 0.021);
    expect(last).toBe(SampleResult.Calibrated);
    expect(c.calibrated).toBe(true);
    expect(c.handLength).toBeCloseTo(0.191, 4);
    expect(c.palmWidth).toBeCloseTo(0.08, 6);
    expect(c.wristRadius).toBeCloseTo(0.021, 6);
    expect(c.windows).toBe(1);
  });

  it('rejects implausible samples and outliers', () => {
    const c = new ArmFitCalibrator(cfg);
    expect(c.addSample(0.5, 0.08, NaN)).toBe(SampleResult.Rejected);
    expect(c.addSample(0.19, 0.2, NaN)).toBe(SampleResult.Rejected);
    for (let i = 0; i < 6; i++) c.addSample(0.19, 0.08, NaN);
    // A tracking glitch: 20% long.
    expect(c.addSample(0.23, 0.08, NaN)).toBe(SampleResult.Rejected);
    expect(c.addSample(0.19, 0.06, NaN)).toBe(SampleResult.Rejected);
    expect(c.pending).toBe(6);
  });

  it('a stored calibration is followed strongly by the first window, then refined gently', () => {
    const c = new ArmFitCalibrator(cfg);
    c.load({ handLength: 0.2, palmWidth: 0.09, wristRadius: NaN, windows: 5 });
    for (let i = 0; i < 10; i++) c.addSample(0.17, 0.075, NaN);
    const first = 0.2 + (0.17 - 0.2) * ARMFIT.firstWindowWeight;
    expect(c.handLength).toBeCloseTo(first, 6);
    for (let i = 0; i < 10; i++) c.addSample(0.17, 0.075, NaN);
    const w = Math.max(ARMFIT.minRefineWeight, 1 / 7);
    expect(c.handLength).toBeCloseTo(first + (0.17 - first) * w, 6);
    expect(c.sessionWindows).toBe(2);
  });

  it('losing the hand drops a half-filled window', () => {
    const c = new ArmFitCalibrator(cfg);
    for (let i = 0; i < 5; i++) c.addSample(0.19, 0.08, NaN);
    c.resetWindow();
    expect(c.pending).toBe(0);
  });
});

describe('stored calibration', () => {
  it('round-trips', () => {
    const s = serializeArmCalibration({ handLength: 0.1912, palmWidth: 0.0804, wristRadius: 0.0214, windows: 3 });
    const p = parseArmCalibration(s, ARMFIT);
    expect(p).not.toBeNull();
    expect(p!.handLength).toBeCloseTo(0.1912, 4);
    expect(p!.palmWidth).toBeCloseTo(0.0804, 4);
    expect(p!.wristRadius).toBeCloseTo(0.0214, 4);
    expect(p!.windows).toBe(3);
  });

  it('omits a missing radius and reads it back as NaN', () => {
    const s = serializeArmCalibration({ handLength: 0.19, palmWidth: 0.08, wristRadius: NaN, windows: 1 });
    expect(s).not.toContain('wristRadius');
    expect(Number.isNaN(parseArmCalibration(s, ARMFIT)!.wristRadius)).toBe(true);
  });

  it('rejects garbage and implausible values', () => {
    expect(parseArmCalibration(null, ARMFIT)).toBeNull();
    expect(parseArmCalibration('{', ARMFIT)).toBeNull();
    expect(parseArmCalibration('42', ARMFIT)).toBeNull();
    expect(parseArmCalibration('{"handLength":2,"palmWidth":0.08}', ARMFIT)).toBeNull();
    expect(parseArmCalibration('{"handLength":0.19,"palmWidth":"x"}', ARMFIT)).toBeNull();
  });

  it('uses its own localStorage key', () => {
    expect(ARMFIT.storageKey).toBe('splotopia.armFit');
  });
});

describe('forearm IK', () => {
  const out = new Float32Array(3);
  const dist = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) =>
    Math.hypot(ax - bx, ay - by, az - bz);

  it('keeps both bone lengths and bends toward the pole', () => {
    solveElbow(0, 0, 0, 0.1, 0, -0.4, 0.32, 0.25, 0, -1, 0, out);
    expect(dist(0, 0, 0, out[0], out[1], out[2])).toBeCloseTo(0.32, 4);
    expect(dist(out[0], out[1], out[2], 0.1, 0, -0.4)).toBeCloseTo(0.25, 4);
    expect(out[1]).toBeLessThan(0);
  });

  it('a reach beyond the arm straightens it along the line', () => {
    solveElbow(0, 0, 0, 0, 0, -1, 0.32, 0.25, 0, -1, 0, out);
    expect(out[0]).toBeCloseTo(0, 3);
    expect(Math.abs(out[1])).toBeLessThan(0.01);
    expect(out[2]).toBeCloseTo(-0.32, 2);
  });

  it('survives a pole parallel to the reach', () => {
    solveElbow(0, 0, 0, 0, -0.3, 0, 0.32, 0.25, 0, -1, 0, out);
    expect(Number.isFinite(out[0] + out[1] + out[2])).toBe(true);
  });

  it('blends the hand axis toward the forearm and caps the bend', () => {
    const axis = new Float32Array(3);
    // Forearm 90 degrees off the hand: weight 0.5 -> 45 deg, capped at 30.
    blendForearmAxis(0, 0, -1, 0, 1, 0, 0.5, (30 * Math.PI) / 180, axis);
    const ang = (Math.acos(-axis[2]) * 180) / Math.PI;
    expect(ang).toBeCloseTo(30, 3);
    expect(Math.hypot(axis[0], axis[1], axis[2])).toBeCloseTo(1, 6);
    // Under the cap: plain normalised blend.
    blendForearmAxis(0, 0, -1, 0, Math.sin(0.2), -Math.cos(0.2), 1, 1, axis);
    expect(axis[1]).toBeCloseTo(Math.sin(0.2), 6);
    // Weight 0 = the wrist frame.
    blendForearmAxis(0, 0, -1, 1, 0, 0, 0, 1, axis);
    expect(Array.from(axis)).toEqual([0, 0, -1]);
  });

  it('the default bend cap is within the wrist range of motion', () => {
    expect(ARMFIT.wristMaxBendDeg).toBeGreaterThan(20);
    expect(ARMFIT.wristMaxBendDeg).toBeLessThanOrEqual(70);
    expect(ARMFIT.forearmIkWeight).toBeGreaterThanOrEqual(0);
    expect(ARMFIT.forearmIkWeight).toBeLessThanOrEqual(1);
  });
});

describe('clampQuatAngle (turret swivel)', () => {
  it('passes small rotations, clamps large ones about the same axis', () => {
    const q = new Float32Array(4);
    const h = 0.1; // 0.2 rad about X
    clampQuatAngle(Math.sin(h), 0, 0, Math.cos(h), 0.5, q);
    expect(q[0]).toBeCloseTo(Math.sin(h), 6);
    clampQuatAngle(Math.sin(0.6), 0, 0, Math.cos(0.6), 0.5, q);
    expect(2 * Math.acos(q[3])).toBeCloseTo(0.5, 6);
    expect(q[1]).toBe(0);
    expect(q[0]).toBeGreaterThan(0);
  });

  it('takes the short way round (negative w)', () => {
    const q = new Float32Array(4);
    clampQuatAngle(-Math.sin(0.1), 0, 0, -Math.cos(0.1), 1, q);
    expect(q[3]).toBeGreaterThan(0);
    expect(q[0]).toBeCloseTo(Math.sin(0.1), 6);
  });
});

describe('round-10 launcher placement', () => {
  it('BLASTER and GOO fire from the same spot on top of the arm, past the wrist', () => {
    const goo = [
      WEB.shooterOffsetX + WEB.muzzleLocal[0],
      WEB.shooterOffsetY + WEB.muzzleLocal[1],
      WEB.shooterOffsetZ + WEB.muzzleLocal[2],
    ];
    for (let i = 0; i < 3; i++) expect(goo[i]).toBeCloseTo(BLASTER.muzzleLocal[i], 3);
    // Above the pivot (top of the forearm) and forward of the wrist joint.
    expect(goo[1]).toBeGreaterThan(0.015);
    expect(goo[2] + ARMFIT.turretPivotZ).toBeLessThan(0);
  });

  it('the turret pivot sits on the sleeve, the gem near its wrist end', () => {
    const base = fitFor(ARMFIT.defaultHandLengthMeters, ARMFIT.defaultPalmWidthMeters);
    expect(ARMFIT.turretPivotZ).toBeGreaterThan(base.sleeveStart);
    expect(ARMFIT.turretPivotZ).toBeLessThan(base.sleeveEnd);
    expect(base.sleeveStart + ARMFIT.gemBackMeters).toBeLessThan(base.sleeveEnd / 2);
    // Off the top centre (turret) but on the upper half (thumb side).
    expect(ARMFIT.gemAngleDeg).toBeGreaterThan(110);
    expect(ARMFIT.gemAngleDeg).toBeLessThan(160);
    expect(ARMFIT.gemRadiusMeters).toBeGreaterThanOrEqual(0.007);
  });

  it('the turret swivel is bounded', () => {
    expect(ARMFIT.turretMaxDeg).toBeGreaterThan(15);
    expect(ARMFIT.turretMaxDeg).toBeLessThanOrEqual(45);
  });
});
