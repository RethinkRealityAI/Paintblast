import {
  AdditiveBlending,
  AssetManager,
  Box3,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Quaternion,
  SRGBColorSpace,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Types,
  Vector2,
  Vector3,
  createComponent,
  createSystem,
  setWorldPosition,
  setWorldQuaternion,
} from '@iwsdk/core';
import type { Entity, Object3D } from '@iwsdk/core';
import { signal } from '@preact/signals-core';
import type { Signal } from '@preact/signals-core';

import { ARMFIT, BLASTER, WEB } from '../config';
import type { BlasterSkin } from '../config';
import { buildAimBasis, handMirror, quatFromBasis, smoothingAlpha } from '../wrist-frame';
import { WristPose } from '../wrist-pose';
import {
  BallStyle,
  BlasterMode,
  GameEvent,
  GameEventBuffer,
  GauntletMuzzles,
  WebSubMode,
} from '../types';
import { Ball } from './BallSpawnSystem';

/**
 * Optional AssetManifest key for a modelled web spinneret. main.ts streams
 * `public/gltf/web-shooter.glb` under it only when `WEB.shooterUseGlb` is on
 * (re-exported from WebShooterSystem, where the manifest has always found it).
 */
export const WEB_SHOOTER_ASSET_KEY = 'webShooter';

const DEG_TO_RAD = Math.PI / 180;

// ---- Pure helpers (exported for tests) -------------------------------------

/**
 * Move a 0..1 deploy value toward its target at a constant rate, so a full
 * swing takes `durationSec`. Linear on purpose: the easing is applied when the
 * value is *shown* ({@link easeOutBack}), which keeps a reversal mid-swing
 * (BLASTER -> HAND -> BLASTER inside 0.3 s) continuous instead of jumping.
 *
 * `durationSec <= 0` snaps. Non-finite input is treated as 0.
 */
export function stepDeploy(
  current: number,
  target: number,
  deltaSec: number,
  durationSec: number,
): number {
  const c = Number.isFinite(current) ? current : 0;
  const t = target >= 0.5 ? 1 : 0;
  if (!(durationSec > 0)) return t;
  const step = Math.max(0, Number.isFinite(deltaSec) ? deltaSec : 0) / durationSec;
  if (c < t) return Math.min(t, c + step);
  if (c > t) return Math.max(t, c - step);
  return c;
}

/** Cubic ease-out, clamped to [0, 1]. */
export function easeOutCubic(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const u = 1 - x;
  return 1 - u * u * u;
}

/**
 * Back ease-out: overshoots ~10% then settles — the "snap into place" of a
 * panel locking on. Exactly 0 at 0 and 1 at 1; clamped outside.
 */
export function easeOutBack(t: number, overshoot = 1.70158): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const c3 = overshoot + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + overshoot * u * u;
}

/** Which pieces of hardware a mode shows. Caller-owned, so nothing allocates. */
export interface DeployTargets {
  /** The forearm sleeve and the back-of-hand plate (BLASTER and GOO). */
  bracer: number;
  /** Barrel + canister on the turret (BLASTER). */
  paint: number;
  /** GOO launcher on the turret (GOO). */
  web: number;
}

/** Write the 0/1 deploy targets for `mode` into `out`. Unknown modes show nothing. */
export function deployTargetsFor(mode: number, out: DeployTargets): DeployTargets {
  out.paint = mode === BlasterMode.Paint ? 1 : 0;
  out.web = mode === BlasterMode.Web ? 1 : 0;
  out.bracer = out.paint || out.web ? 1 : 0;
  return out;
}

/**
 * The skin a stored index selects. Out-of-range, fractional, negative or
 * non-numeric indices (a stale localStorage value from a build with more
 * skins, a hand-edited key) fall back to the first skin rather than to
 * undefined. An empty list returns undefined.
 */
export function resolveSkin<T>(skins: ReadonlyArray<T>, index: unknown): T | undefined {
  if (skins.length === 0) return undefined;
  const i = typeof index === 'number' && Number.isInteger(index) ? index : 0;
  return i >= 0 && i < skins.length ? skins[i] : skins[0];
}

/**
 * Exponential settle of a 0..1 recoil value with time constant `tauSec`.
 * Values under 1e-3 snap to 0 so the per-frame work stops.
 */
export function decayRecoil(value: number, deltaSec: number, tauSec: number): number {
  if (!(value > 0)) return 0;
  if (!(tauSec > 0)) return 0;
  const next = value * Math.exp(-Math.max(0, deltaSec) / tauSec);
  return next < 1e-3 ? 0 : next;
}

// ---- Arm fit (round 10) -----------------------------------------------------

/** Config literals widened to plain numbers, so tests can pass variations. */
type Widen<T> = {
  readonly [K in keyof T]: T[K] extends number
    ? number
    : T[K] extends readonly [number, number]
      ? readonly [number, number]
      : T[K];
};

/** The ARMFIT keys the fit model reads (tests pass variations of ARMFIT). */
export type ArmFitConfig = Widen<Pick<
  typeof ARMFIT,
  | 'wristCircPerPalmWidth'
  | 'wristJointRadiusWeight'
  | 'wristRadiusRange'
  | 'forearmLengthPerHandLength'
  | 'upperArmLengthPerHandLength'
  | 'forearmMaxCircPerWristCirc'
  | 'forearmMaxAt'
  | 'aspectWrist'
  | 'aspectProximal'
  | 'sleeveStartMeters'
  | 'sleeveCoverage'
  | 'skinMarginMeters'
  | 'plateWidthPerPalmWidth'
  | 'plateLengthPerHandLength'
>>;

/**
 * Everything the gauntlet needs to know about one player's arm, metres.
 * Caller-owned ({@link createArmFit}), so recomputing allocates nothing.
 */
export interface ArmFit {
  handLength: number;
  palmWidth: number;
  /** Equivalent round radius of the wrist at the wrist joint (skin). */
  wristRadius: number;
  /** Equivalent round radius at the forearm's widest point (skin). */
  maxRadius: number;
  /** Wrist joint to elbow. */
  forearmLength: number;
  /** Shoulder to elbow. */
  upperArmLength: number;
  /** Fraction of the forearm length (from the wrist) where it is widest. */
  maxAt: number;
  /** Cross-section depth / breadth at the wrist and at the widest point. */
  aspectWrist: number;
  aspectProximal: number;
  /** Sleeve extent, metres behind the wrist joint. */
  sleeveStart: number;
  sleeveEnd: number;
  /** Inner-wall semi-axes (breadth A, depth B) at the sleeve's two ends. */
  innerA0: number;
  innerB0: number;
  innerA1: number;
  innerB1: number;
  /** Back-of-hand plate size. */
  plateWidth: number;
  plateLength: number;
}

/** A zeroed ArmFit to hand to {@link computeArmFit}. */
export function createArmFit(): ArmFit {
  return {
    handLength: 0,
    palmWidth: 0,
    wristRadius: 0,
    maxRadius: 0,
    forearmLength: 0,
    upperArmLength: 0,
    maxAt: 0.72,
    aspectWrist: 0.8,
    aspectProximal: 0.9,
    sleeveStart: 0,
    sleeveEnd: 0,
    innerA0: 0,
    innerB0: 0,
    innerA1: 0,
    innerB1: 0,
    plateWidth: 0,
    plateLength: 0,
  };
}

/** Breadth (`a`) and depth (`b`) semi-axes of an ellipse. Caller-owned. */
export interface SemiAxes {
  a: number;
  b: number;
}

/**
 * The forearm's cross-section `z` metres behind the wrist joint, as an
 * ellipse (breadth semi-axis `a` along the wrist frame's X, depth `b` along
 * its Y), grown by `offset` metres all round.
 *
 * The equivalent round radius eases from the wrist radius up to the widest
 * radius at `maxAt` of the forearm (quadratic ease-out: the forearm swells
 * fast just above the wrist, then plateaus), and the section rounds out from
 * `aspectWrist` to `aspectProximal` over the same span. Area-preserving split:
 * a = r / sqrt(aspect), b = r * sqrt(aspect).
 */
export function forearmSectionAt(fit: ArmFit, z: number, offset: number, out: SemiAxes): SemiAxes {
  const len = fit.forearmLength > 0 ? fit.forearmLength : 0.25;
  const span = fit.maxAt > 0 ? fit.maxAt : 0.72;
  const u = Math.min(1, Math.max(0, z / len / span));
  const ease = 1 - (1 - u) * (1 - u);
  const r = fit.wristRadius + (fit.maxRadius - fit.wristRadius) * ease;
  const aspect = fit.aspectWrist + (fit.aspectProximal - fit.aspectWrist) * u;
  const s = Math.sqrt(aspect > 0 ? aspect : 1);
  out.a = r / s + offset;
  out.b = r * s + offset;
  return out;
}

/**
 * The anthropometric model: a player's whole arm from two hand measurements
 * (and, optionally, the runtime's wrist joint radius). See ARMFIT for the
 * ratios and their sources. Non-finite or non-positive inputs fall back to
 * the ARMFIT defaults, so the result is always a wearable fit.
 *
 * @param wristJointRadius XRJointPose.radius of the wrist (half its depth),
 *   or NaN when the runtime gives none. Ignored outside `wristRadiusRange`.
 */
export function computeArmFit(
  handLength: number,
  palmWidth: number,
  wristJointRadius: number,
  cfg: ArmFitConfig,
  out: ArmFit,
): ArmFit {
  const L = handLength > 0 && Number.isFinite(handLength) ? handLength : ARMFIT.defaultHandLengthMeters;
  const P = palmWidth > 0 && Number.isFinite(palmWidth) ? palmWidth : ARMFIT.defaultPalmWidthMeters;
  out.handLength = L;
  out.palmWidth = P;
  out.aspectWrist = cfg.aspectWrist;
  out.aspectProximal = cfg.aspectProximal;
  out.maxAt = cfg.forearmMaxAt;

  let rWrist = (cfg.wristCircPerPalmWidth * P) / (2 * Math.PI);
  const [rMin, rMax] = cfg.wristRadiusRange;
  if (Number.isFinite(wristJointRadius) && wristJointRadius >= rMin && wristJointRadius <= rMax) {
    // The joint radius is half the wrist's depth: b = r * sqrt(aspect).
    const fromJoint = wristJointRadius / Math.sqrt(cfg.aspectWrist);
    const w = Math.min(1, Math.max(0, cfg.wristJointRadiusWeight));
    rWrist = rWrist + (fromJoint - rWrist) * w;
  }
  out.wristRadius = rWrist;
  out.maxRadius = rWrist * cfg.forearmMaxCircPerWristCirc;
  out.forearmLength = cfg.forearmLengthPerHandLength * L;
  out.upperArmLength = cfg.upperArmLengthPerHandLength * L;
  out.sleeveStart = cfg.sleeveStartMeters;
  out.sleeveEnd = Math.max(cfg.sleeveStartMeters + 0.05, cfg.sleeveCoverage * out.forearmLength);

  const s: SemiAxes = { a: 0, b: 0 };
  forearmSectionAt(out, out.sleeveStart, cfg.skinMarginMeters, s);
  out.innerA0 = s.a;
  out.innerB0 = s.b;
  forearmSectionAt(out, out.sleeveEnd, cfg.skinMarginMeters, s);
  out.innerA1 = s.a;
  out.innerB1 = s.b;

  out.plateWidth = cfg.plateWidthPerPalmWidth * P;
  out.plateLength = cfg.plateLengthPerHandLength * L;
  return out;
}

/**
 * How much to stretch a sleeve modelled for `base` so it fits `fit`:
 * `out[0..2]` = X (breadth), Y (depth), Z (length) scale. Each cross-section
 * axis takes the larger of its two end ratios, so the stretched inner wall is
 * never inside the fitted one anywhere along the sleeve (the profile is
 * proportional between players, so the two ratios differ by the fixed margin
 * only). Length follows the sleeve end.
 */
export function sleeveScaleFor(fit: ArmFit, base: ArmFit, out: Float32Array | number[]): void {
  const r = (a: number, b: number) => (b > 0 ? a / b : 1);
  out[0] = Math.max(r(fit.innerA0, base.innerA0), r(fit.innerA1, base.innerA1));
  out[1] = Math.max(r(fit.innerB0, base.innerB0), r(fit.innerB1, base.innerB1));
  out[2] = r(fit.sleeveEnd, base.sleeveEnd);
}

/**
 * WebXR joint names the measurement reads, in the order of the index table
 * {@link resolveHandJoints} fills: the middle-finger bone chain (hand length),
 * then the index and pinky knuckles (palm width).
 *
 * NB: in WebXR the `*-metacarpal` joints sit at the BASE of the metacarpal
 * (near the wrist); the knuckles are the `*-phalanx-proximal` joints.
 */
export const ARMFIT_JOINT_NAMES = [
  'wrist',
  'middle-finger-metacarpal',
  'middle-finger-phalanx-proximal',
  'middle-finger-phalanx-intermediate',
  'middle-finger-phalanx-distal',
  'middle-finger-tip',
  'index-finger-phalanx-proximal',
  'pinky-finger-phalanx-proximal',
] as const;

/**
 * Fill `out` (length >= 8) with the index of each {@link ARMFIT_JOINT_NAMES}
 * entry in the adapter's joint order. @returns true when all were found.
 */
export function resolveHandJoints(
  names: ArrayLike<string | undefined>,
  out: Int16Array | number[],
): boolean {
  let all = true;
  for (let k = 0; k < ARMFIT_JOINT_NAMES.length; k++) {
    out[k] = -1;
    for (let i = 0; i < names.length; i++) {
      if (names[i] === ARMFIT_JOINT_NAMES[k]) {
        out[k] = i;
        break;
      }
    }
    if (out[k] < 0) all = false;
  }
  return all;
}

/** One frame's hand measurement. Caller-owned. */
export interface HandMeasurement {
  handLength: number;
  palmWidth: number;
  /** The wrist joint's radius, NaN when the runtime gave none. */
  wristRadius: number;
}

function jointDistance(tr: ArrayLike<number>, i: number, j: number): number {
  const a = i * 16 + 12;
  const b = j * 16 + 12;
  const dx = tr[a] - tr[b];
  const dy = tr[a + 1] - tr[b + 1];
  const dz = tr[a + 2] - tr[b + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Measure a hand from one frame of joint matrices (16 floats per joint,
 * column-major — IWSDK's `jointTransforms`; any common reference frame works,
 * distances are frame-invariant).
 *
 * - **Hand length** = the sum of the middle-finger bone lengths from the
 *   wrist joint to the fingertip. Bone lengths do not change when the hand
 *   curls, unlike the straight wrist-to-tip distance.
 * - **Palm width** = index-knuckle to pinky-knuckle span plus both knuckle
 *   radii (from `radii`, else `fallbackKnuckleRadius` each): hand breadth.
 *
 * @param radii joint radii in the same order (XRFrame.fillJointRadii), or null.
 * @returns false when a joint is missing or a value is not finite.
 */
export function measureHand(
  tr: ArrayLike<number>,
  idx: ArrayLike<number>,
  radii: ArrayLike<number> | null,
  fallbackKnuckleRadius: number,
  out: HandMeasurement,
): boolean {
  for (let k = 0; k < 8; k++) {
    if (!(idx[k] >= 0) || idx[k] * 16 + 15 >= tr.length) return false;
  }
  let length = 0;
  for (let k = 1; k <= 5; k++) length += jointDistance(tr, idx[k - 1], idx[k]);
  let rIndex = fallbackKnuckleRadius;
  let rPinky = fallbackKnuckleRadius;
  let rWrist = NaN;
  if (radii) {
    const ri = radii[idx[6]];
    const rp = radii[idx[7]];
    const rw = radii[idx[0]];
    if (ri > 0 && ri < 0.03) rIndex = ri;
    if (rp > 0 && rp < 0.03) rPinky = rp;
    if (rw > 0) rWrist = rw;
  }
  const width = jointDistance(tr, idx[6], idx[7]) + rIndex + rPinky;
  if (!Number.isFinite(length) || !Number.isFinite(width)) return false;
  out.handLength = length;
  out.palmWidth = width;
  out.wristRadius = rWrist;
  return true;
}

/**
 * Median of the first `n` values of `src`, sorted in `scratch` (insertion
 * sort: n is a couple of dozen). Non-finite values are skipped. NaN when
 * nothing finite is left.
 */
export function medianOf(src: ArrayLike<number>, n: number, scratch: Float32Array | number[]): number {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const v = src[i];
    if (!Number.isFinite(v)) continue;
    let j = m - 1;
    while (j >= 0 && scratch[j] > v) {
      scratch[j + 1] = scratch[j];
      j--;
    }
    scratch[j + 1] = v;
    m++;
  }
  if (m === 0) return NaN;
  return m % 2 === 1 ? scratch[(m - 1) >> 1] : 0.5 * (scratch[m / 2 - 1] + scratch[m / 2]);
}

/** A stored or live calibration. */
export interface ArmCalibration {
  handLength: number;
  palmWidth: number;
  /** NaN when no runtime ever reported a wrist radius. */
  wristRadius: number;
  /** Completed measurement windows behind these numbers (all sessions). */
  windows: number;
}

/** The ARMFIT keys the calibrator reads. */
export type ArmCalibratorConfig = Widen<Pick<
  typeof ARMFIT,
  | 'windowSamples'
  | 'handLengthRange'
  | 'palmWidthRange'
  | 'wristRadiusRange'
  | 'outlierFraction'
  | 'firstWindowWeight'
  | 'minRefineWeight'
>>;

/** What {@link ArmFitCalibrator.addSample} did with a sample. */
export const SampleResult = {
  Rejected: 0,
  Accepted: 1,
  /** Accepted, and it completed a window: the calibration just changed. */
  Calibrated: 2,
} as const;

/**
 * Robust per-player hand calibration (round 10). Pure: no three, no DOM.
 *
 * Samples go into a window; implausible values and values more than
 * `outlierFraction` from the window's running median are rejected. When the
 * window fills, its MEDIANS are blended into the calibration: fully when
 * there is none yet, at `firstWindowWeight` for the first window of a session
 * over a stored calibration (it may be someone else's), then at 1/(n+1)
 * (floored at `minRefineWeight`) so it keeps refining over time.
 */
export class ArmFitCalibrator {
  handLength = NaN;
  palmWidth = NaN;
  wristRadius = NaN;
  /** Windows behind the current values, stored ones included. */
  windows = 0;
  /** Windows completed this session. */
  sessionWindows = 0;

  private readonly cfg: ArmCalibratorConfig;
  private readonly bufL: Float32Array;
  private readonly bufP: Float32Array;
  private readonly bufR: Float32Array;
  private readonly scratch: Float32Array;
  private n = 0;

  constructor(cfg: ArmCalibratorConfig) {
    this.cfg = cfg;
    const size = Math.max(3, Math.floor(cfg.windowSamples));
    this.bufL = new Float32Array(size);
    this.bufP = new Float32Array(size);
    this.bufR = new Float32Array(size);
    this.scratch = new Float32Array(size + 1);
  }

  /** True once there is a calibration (stored or measured). */
  get calibrated(): boolean {
    return Number.isFinite(this.handLength) && Number.isFinite(this.palmWidth);
  }

  /** Samples in the current window. */
  get pending(): number {
    return this.n;
  }

  /** Start from a stored calibration (or clear it with null). */
  load(stored: ArmCalibration | null): void {
    if (stored) {
      this.handLength = stored.handLength;
      this.palmWidth = stored.palmWidth;
      this.wristRadius = stored.wristRadius;
      this.windows = Math.max(1, Math.floor(stored.windows) || 1);
    } else {
      this.handLength = NaN;
      this.palmWidth = NaN;
      this.wristRadius = NaN;
      this.windows = 0;
    }
    this.sessionWindows = 0;
    this.n = 0;
  }

  /** Drop the current window (e.g. the hand was lost mid-window). */
  resetWindow(): void {
    this.n = 0;
  }

  /** Offer one frame's measurement. @returns a {@link SampleResult}. */
  addSample(handLength: number, palmWidth: number, wristRadius: number): number {
    const c = this.cfg;
    if (!(handLength >= c.handLengthRange[0] && handLength <= c.handLengthRange[1])) {
      return SampleResult.Rejected;
    }
    if (!(palmWidth >= c.palmWidthRange[0] && palmWidth <= c.palmWidthRange[1])) {
      return SampleResult.Rejected;
    }
    if (this.n >= 6) {
      const mL = medianOf(this.bufL, this.n, this.scratch);
      const mP = medianOf(this.bufP, this.n, this.scratch);
      if (Math.abs(handLength - mL) > c.outlierFraction * mL) return SampleResult.Rejected;
      if (Math.abs(palmWidth - mP) > c.outlierFraction * mP) return SampleResult.Rejected;
    }
    const r =
      wristRadius >= c.wristRadiusRange[0] && wristRadius <= c.wristRadiusRange[1]
        ? wristRadius
        : NaN;
    this.bufL[this.n] = handLength;
    this.bufP[this.n] = palmWidth;
    this.bufR[this.n] = r;
    this.n++;
    if (this.n < this.bufL.length) return SampleResult.Accepted;
    this.finishWindow();
    return SampleResult.Calibrated;
  }

  private finishWindow(): void {
    const n = this.n;
    this.n = 0;
    const mL = medianOf(this.bufL, n, this.scratch);
    const mP = medianOf(this.bufP, n, this.scratch);
    let finiteR = 0;
    for (let i = 0; i < n; i++) if (Number.isFinite(this.bufR[i])) finiteR++;
    const mR = finiteR * 2 >= n ? medianOf(this.bufR, n, this.scratch) : NaN;

    let w: number;
    if (!this.calibrated) w = 1;
    else if (this.sessionWindows === 0) w = this.cfg.firstWindowWeight;
    else w = Math.max(this.cfg.minRefineWeight, 1 / (this.windows + 1));

    this.handLength = this.calibrated ? this.handLength + (mL - this.handLength) * w : mL;
    this.palmWidth = Number.isFinite(this.palmWidth) ? this.palmWidth + (mP - this.palmWidth) * w : mP;
    if (Number.isFinite(mR)) {
      this.wristRadius = Number.isFinite(this.wristRadius)
        ? this.wristRadius + (mR - this.wristRadius) * w
        : mR;
    }
    this.windows++;
    this.sessionWindows++;
  }
}

/**
 * Parse a stored calibration (`ARMFIT.storageKey`). Anything malformed,
 * non-finite or outside the plausible ranges reads as "none" rather than
 * dressing the player in a wrong-sized sleeve.
 */
export function parseArmCalibration(
  raw: string | null | undefined,
  cfg: Pick<typeof ARMFIT, 'handLengthRange' | 'palmWidthRange' | 'wristRadiusRange'>,
): ArmCalibration | null {
  if (!raw) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const v = o as Record<string, unknown>;
  const L = Number(v.handLength);
  const P = Number(v.palmWidth);
  if (!(L >= cfg.handLengthRange[0] && L <= cfg.handLengthRange[1])) return null;
  if (!(P >= cfg.palmWidthRange[0] && P <= cfg.palmWidthRange[1])) return null;
  const R = v.wristRadius == null ? NaN : Number(v.wristRadius);
  const W = Number(v.windows);
  return {
    handLength: L,
    palmWidth: P,
    wristRadius:
      R >= cfg.wristRadiusRange[0] && R <= cfg.wristRadiusRange[1] ? R : NaN,
    windows: W >= 1 && Number.isFinite(W) ? Math.floor(W) : 1,
  };
}

/** JSON for `ARMFIT.storageKey` (millimetre precision; NaN radius omitted). */
export function serializeArmCalibration(c: ArmCalibration): string {
  const mm = (x: number) => Math.round(x * 10000) / 10000;
  return JSON.stringify({
    v: 1,
    handLength: mm(c.handLength),
    palmWidth: mm(c.palmWidth),
    ...(Number.isFinite(c.wristRadius) ? { wristRadius: mm(c.wristRadius) } : {}),
    windows: c.windows,
  });
}

/**
 * Two-bone IK for the elbow: shoulder S, wrist W, upper-arm and forearm
 * lengths, and a pole direction the elbow bends toward (down/out/back for a
 * human arm). Writes the elbow position into `out[0..2]`. A reach beyond the
 * arm's length straightens it (elbow on the S-W line); a degenerate pole picks
 * any perpendicular.
 */
export function solveElbow(
  sx: number, sy: number, sz: number,
  wx: number, wy: number, wz: number,
  upper: number,
  fore: number,
  px: number, py: number, pz: number,
  out: Float32Array | number[],
): void {
  let dx = wx - sx;
  let dy = wy - sy;
  let dz = wz - sz;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(dist > 1e-6)) {
    out[0] = sx + px * upper;
    out[1] = sy + py * upper;
    out[2] = sz + pz * upper;
    return;
  }
  dx /= dist;
  dy /= dist;
  dz /= dist;
  const minD = Math.abs(upper - fore) + 1e-4;
  const maxD = upper + fore - 1e-4;
  const d = Math.min(maxD, Math.max(minD, dist));
  const along = (upper * upper - fore * fore + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, upper * upper - along * along));
  // Pole, minus its component along the S-W line.
  const pd = px * dx + py * dy + pz * dz;
  let qx = px - pd * dx;
  let qy = py - pd * dy;
  let qz = pz - pd * dz;
  let ql = Math.sqrt(qx * qx + qy * qy + qz * qz);
  if (ql < 1e-5) {
    // Any perpendicular: cross with world X, or Z if parallel to X.
    if (Math.abs(dx) < 0.9) {
      qx = 0; qy = dz; qz = -dy;
    } else {
      qx = -dy; qy = dx; qz = 0;
    }
    ql = Math.sqrt(qx * qx + qy * qy + qz * qz);
  }
  qx /= ql;
  qy /= ql;
  qz /= ql;
  out[0] = sx + dx * along + qx * h;
  out[1] = sy + dy * along + qy * h;
  out[2] = sz + dz * along + qz * h;
}

/**
 * The sleeve's distal axis: the hand's own wrist-joint axis `h` blended
 * toward the IK forearm axis `f` by `weight`, then held within `maxRad` of
 * `h` (the wrist only bends so far, and a wrong elbow guess must not tear the
 * sleeve off the arm). Both inputs unit; writes a unit vector to `out[0..2]`.
 *
 * With a dead zone (`deadNearRad` < `deadFarRad`), the weight fades in with
 * the angle between the two axes (smoothstep): small disagreements — the
 * elbow guess's own error, a little ulnar deviation — trust the tracked
 * wrist; only a clearly bent wrist hands the sleeve to the forearm estimate.
 */
export function blendForearmAxis(
  hx: number, hy: number, hz: number,
  fx: number, fy: number, fz: number,
  weight: number,
  maxRad: number,
  out: Float32Array | number[],
  deadNearRad = 0,
  deadFarRad = 0,
): void {
  let w = Math.min(1, Math.max(0, Number.isFinite(weight) ? weight : 0));
  if (deadFarRad > deadNearRad) {
    const between = Math.acos(Math.min(1, Math.max(-1, hx * fx + hy * fy + hz * fz)));
    const u = Math.min(1, Math.max(0, (between - deadNearRad) / (deadFarRad - deadNearRad)));
    w *= u * u * (3 - 2 * u);
  }
  let vx = hx * (1 - w) + fx * w;
  let vy = hy * (1 - w) + fy * w;
  let vz = hz * (1 - w) + fz * w;
  let len = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (!(len > 1e-6)) {
    out[0] = hx; out[1] = hy; out[2] = hz;
    return;
  }
  vx /= len;
  vy /= len;
  vz /= len;
  const cos = Math.min(1, Math.max(-1, vx * hx + vy * hy + vz * hz));
  if (Math.acos(cos) <= maxRad) {
    out[0] = vx; out[1] = vy; out[2] = vz;
    return;
  }
  // Rotate h toward v by exactly maxRad.
  let px = vx - cos * hx;
  let py = vy - cos * hy;
  let pz = vz - cos * hz;
  len = Math.sqrt(px * px + py * py + pz * pz);
  if (!(len > 1e-6)) {
    out[0] = hx; out[1] = hy; out[2] = hz;
    return;
  }
  px /= len;
  py /= len;
  pz /= len;
  const c = Math.cos(maxRad);
  const s = Math.sin(maxRad);
  out[0] = hx * c + px * s;
  out[1] = hy * c + py * s;
  out[2] = hz * c + pz * s;
}

/**
 * Limit a (relative) unit quaternion to at most `maxRad` of rotation about
 * its own axis. Writes [x, y, z, w] (w >= 0) to `out`. The turret uses it to
 * keep the barrel within a believable swivel of the sleeve.
 */
export function clampQuatAngle(
  x: number, y: number, z: number, w: number,
  maxRad: number,
  out: Float32Array | number[],
): void {
  if (w < 0) {
    x = -x; y = -y; z = -z; w = -w;
  }
  const angle = 2 * Math.acos(Math.min(1, w));
  if (angle <= maxRad) {
    out[0] = x; out[1] = y; out[2] = z; out[3] = w;
    return;
  }
  const s = Math.sqrt(x * x + y * y + z * z);
  if (!(s > 1e-9)) {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
    return;
  }
  const half = Math.max(0, maxRad) / 2;
  const k = Math.sin(half) / s;
  out[0] = x * k;
  out[1] = y * k;
  out[2] = z * k;
  out[3] = Math.cos(half);
}

// ---- Components ------------------------------------------------------------

/** Which piece of a gauntlet an entity is. */
export const GauntletPart = {
  /** Forearm sleeve root (forearm frame): the armour tube, menu-gem mount. */
  Forearm: 0,
  /** Back-of-hand plate, wrist frame. */
  Plate: 1,
  /** Retired in round 10 (the under-wrist spinneret / pad mount). Id kept stable. */
  Spinneret: 2,
  /** Round 10: the swivel turret on top of the sleeve (aim frame): barrel or goo launcher. */
  Turret: 3,
} as const;

/** Tags the gauntlet hardware for the MCP tools. 0 = left hand, 1 = right. */
export const Gauntlet = createComponent('Gauntlet', {
  side: { type: Types.Int8, default: 0 },
  /** @see GauntletPart */
  part: { type: Types.Int8, default: GauntletPart.Forearm },
});

// ---- Geometry constants (metres) -----------------------------------------------

/**
 * The paint module was authored (round 8) in the aim frame at the wrist joint.
 * Round 10 mounts it on the turret, whose origin is the pivot on top of the
 * sleeve: this is where that pivot sat in the old coordinates, so the round-8
 * numbers carry over by subtraction.
 */
const LEGACY_ORIGIN: readonly [number, number, number] = [0, 0.031, 0.057];
/** Paint module pivot (legacy coords): the saddle's centre, so recoil tips about the canister. */
const PAINT_PIVOT: readonly [number, number, number] = [0, 0.045, 0.06];
/** Paint barrel axis height (legacy coords). */
const BARREL_Y = 0.058;
/** Plate hinge, metres toward the wrist from the plate centre. */
const PLATE_HINGE_Z = 0.037;
/** How far (radians) a stowed plate is folded up off the hand. */
const PLATE_FOLD_RAD = 1.35;
/** The plate model's own width / length (capsule 0.021 r x1.5, 0.032 + 2r long). */
const PLATE_MODEL_WIDTH = 0.063;
const PLATE_MODEL_LENGTH = 0.074;
/** How far a stowed turret module sinks into its rail. */
const MODULE_SINK = 0.026;

/** GOO state light: coral-white = SPLAT, cyan = TETHER. */
const WEB_GLOW_SPLAT = '#ff9c86';
const WEB_GLOW_TETHER = '#36e0ff';

/** Debug override for the head the body estimate hangs off (headless harness). */
export interface DebugBodyHead {
  position: readonly [number, number, number];
  quaternion: readonly [number, number, number, number];
}

interface HandAdapterLike {
  jointSpaces?: ReadonlyArray<XRJointSpace & { jointName?: string }>;
  jointTransforms?: Float32Array;
}

/**
 * The gauntlet blasters (round 8, refitted round 10): models, posing, fit,
 * mode transitions, skins, recoil. One per arm, both arms.
 *
 * ### What it owns
 *
 * - The **pose**. Each arm's {@link WristPose} (wrist joint for hands, ray +
 *   mirrored grip for controllers — see `src/wrist-pose.ts`), smoothed with
 *   `WEB.shooterSmoothingSec`. WebShooterSystem reads the palm, the aim and
 *   the nozzle back through the small public API below, so there is exactly
 *   one smoothed aim per arm in the game.
 * - The **fit** (round 10). The player's hand is measured from the tracked
 *   joints ({@link ArmFitCalibrator}: pose-invariant bone lengths, medians of
 *   ~1.6 s windows, outliers and just-reacquired frames rejected), persisted
 *   per device in `ARMFIT.storageKey`, and turned into a forearm estimate
 *   ({@link computeArmFit}). Controllers wear the default fit. Size changes
 *   glide over `ARMFIT.sizeSmoothingSec`.
 * - The **hardware**, three pieces per arm:
 *   - the **sleeve** — a closed armour tube round the forearm, posed from
 *     the FOREARM axis (the wrist joint's distal axis blended with an IK elbow
 *     estimate hung off the head), so it sits on the arm even when the aim
 *     ray wanders. Carries the left arm's menu gem and the legacy pad mount.
 *   - the **turret** — a swivel pinned to the top of the sleeve that follows
 *     the aim (clamped to `ARMFIT.turretMaxDeg`). The BLASTER barrel and the
 *     GOO launcher both live on it and swap places on a mode change, so
 *     whatever is loaded is on top of the arm, in view, and points exactly
 *     where it fires.
 *   - the back-of-hand **plate** in the hand's own wrist frame, sized to the
 *     palm (fingers and palm free).
 * - **Mode transitions**: `globals.blasterMode` deploys and stows the pieces
 *   over `BLASTER.transitionSec`, and emits `GameEvent.BlasterModeChanged`.
 * - **Skins**: `globals.blasterSkin` recolours the shared materials on change.
 * - **Recoil**: every ball an arm fires kicks its loaded module.
 * - **Muzzles**: each frame it writes where each arm launches from into
 *   `globals.gauntletMuzzles` (BallSpawnSystem's trigger path).
 *
 * ### Ordering
 *
 * Priority 9: after WristPaletteSystem (8), before WebShooterSystem (10) and
 * BallSpawnSystem (11). Registered before WebShooterSystem in main.ts, because
 * WebShooterSystem reads this frame's palm/aim/nozzle. WristMenuSystem (8)
 * reads the gem anchor (previous frame).
 *
 * ### Allocation
 *
 * Every mesh, material, vector and pose is built in init(). update() writes
 * into those and allocates nothing (the emulator's own fillJointRadii copies
 * its argument; a headset's does not — and it runs at `ARMFIT.sampleHz`).
 */
export class GauntletSystem extends createSystem({
  balls: { required: [Ball] },
}) {
  private blasterMode!: Signal<BlasterMode>;
  private blasterSkin?: Signal<number>;
  private activeColor?: Signal<readonly [number, number, number, number]>;
  private webSubMode?: Signal<WebSubMode>;
  private pausedSignal?: Signal<boolean>;
  private events?: GameEventBuffer;
  private muzzles!: GauntletMuzzles;

  private wrists!: [WristPose, WristPose];
  /** Smoothed turret pose (the aim frame at the pivot on top of the sleeve). */
  private shownPos!: [Vector3, Vector3];
  private shownQ!: [Quaternion, Quaternion];
  /** Smoothed sleeve pose (forearm frame at the wrist joint). */
  private sleevePos!: [Vector3, Vector3];
  private sleeveQ!: [Quaternion, Quaternion];
  /** Smoothed wrist-frame pose of the plate. */
  private platePos!: [Vector3, Vector3];
  private plateQ!: [Quaternion, Quaternion];
  /** Smoothed anatomical wrist frame (for the menu). */
  private wristQs!: [Quaternion, Quaternion];
  /** Last palm seen per hand, for the reacquire-jump test. */
  private lastPalm!: [Vector3, Vector3];
  /** Palm of the current pose, per hand. */
  private palms!: [Vector3, Vector3];
  /** 1 once shown* holds a real pose; cleared on loss, jumps and pauses. */
  private primed!: Uint8Array;
  /** 1 while this frame produced a pose for the hand. */
  private posed!: Uint8Array;
  /** 1 once the hand has been posed at least once this session. */
  private everPosed!: Uint8Array;
  /** Controller roll (BLASTER.controllerRollDeg), mirrored per hand. */
  private controllerRoll!: [Quaternion, Quaternion];

  /** Deploy progress 0..1, shared by both arms: bracer, paint, web. */
  private deploy!: Float32Array;
  private readonly targets: DeployTargets = { bracer: 0, paint: 0, web: 0 };
  private lastMode: BlasterMode = BlasterMode.Hand;
  /** Per-hand recoil 0..1. */
  private recoil!: Float32Array;
  private seamPulsing = false;
  private wasPaused = false;
  private elapsed = 0;

  // ---- Fit ----
  private baseFit!: ArmFit;
  private targetFit!: ArmFit;
  private calibrator!: ArmFitCalibrator;
  private fitDirty = true;
  /** [sleeve X, Y, Z, plate X, plate Z, palm ratio, hand-length ratio], shown and target. */
  private fitShown!: Float32Array;
  private fitTarget!: Float32Array;
  private fitPrimed = false;
  private section!: SemiAxes;
  private readonly lastSaved: ArmCalibration = { handLength: NaN, palmWidth: NaN, wristRadius: NaN, windows: 0 };
  private jointIdx!: [Int16Array, Int16Array];
  private jointIdxFor: Array<unknown> = [undefined, undefined];
  private radii!: Float32Array;
  private readonly measurement: HandMeasurement = { handLength: 0, palmWidth: 0, wristRadius: NaN };
  private sampleClock!: Float32Array;
  private trackedAt!: Float32Array;
  private palmSpeed!: Float32Array;

  // ---- Body estimate (forearm IK) ----
  /** Set by the headless harness to keep the body put while the camera moves. */
  debugBodyHead: DebugBodyHead | null = null;
  /** false pauses hand measuring (the harness's small/large-hand shots). */
  measuring = true;
  private torsoFwd!: Vector3;
  private bodyPrimed = false;
  private bodyValid = false;
  private headPos!: Vector3;
  private headQ!: Quaternion;
  private neck!: Vector3;
  private elbow!: Float32Array;
  private axis!: Float32Array;
  private basis!: Float32Array;
  private quat!: Float32Array;

  // ---- Entities and the animated groups inside them, per hand ----
  private readonly sleeveEntities: Array<Entity | undefined> = [undefined, undefined];
  private readonly turretEntities: Array<Entity | undefined> = [undefined, undefined];
  private readonly plateEntities: Array<Entity | undefined> = [undefined, undefined];
  private readonly bracers: Object3D[] = [];
  private readonly plateFits: Object3D[] = [];
  private readonly turretBases: Object3D[] = [];
  private readonly paintModules: Object3D[] = [];
  private readonly webModules: Object3D[] = [];
  private readonly plateHinges: Object3D[] = [];
  private readonly swirls: Object3D[] = [];
  private readonly gooSwirls: Object3D[] = [];
  private readonly liquids: Object3D[] = [];
  private readonly flashes: Object3D[] = [];
  private gem?: Object3D;
  private gemBand?: Object3D;
  /** Gem centre and outward normal in the left sleeve's frame (updated per frame). */
  private gemLocal!: Vector3;
  private gemNormal!: Vector3;
  private gemShown = false;
  /** Turret pivot in each sleeve's frame (updated per frame from the fit). */
  private pivotLocal!: [Vector3, Vector3];

  // Shared materials: one write recolours both arms.
  private shellMat!: MeshPhysicalMaterial;
  private graphiteMat!: MeshStandardMaterial;
  private chromeMat!: MeshStandardMaterial;
  private trimMat!: MeshStandardMaterial;
  private accentMat!: MeshBasicMaterial;
  private glassMat!: MeshPhysicalMaterial;
  private liquidMat!: MeshBasicMaterial;
  private swirlMat!: MeshBasicMaterial;
  private flashMat!: MeshBasicMaterial;
  private boreMat!: MeshBasicMaterial;
  private webGlowMat!: MeshBasicMaterial;
  private gemMat!: MeshBasicMaterial;
  /** Linear-space base colours the per-frame pulses scale from. */
  private accentBase!: Color;
  private liquidBase!: Color;

  // Scratch.
  private tmpV!: Vector3;
  private tmpV2!: Vector3;
  private tmpQ!: Quaternion;
  private tmpQ2!: Quaternion;
  private tmpQ3!: Quaternion;
  private dir!: Vector3;

  init() {
    this.blasterMode =
      (this.globals.blasterMode as Signal<BlasterMode> | undefined) ??
      signal<BlasterMode>(BlasterMode.Paint);
    this.blasterSkin = this.globals.blasterSkin as Signal<number> | undefined;
    this.activeColor = this.globals.activeColor as
      | Signal<readonly [number, number, number, number]>
      | undefined;
    this.webSubMode = this.globals.webSubMode as Signal<WebSubMode> | undefined;
    this.events = this.globals.gameEvents as GameEventBuffer | undefined;
    // Created here rather than seeded in main.ts: this system is its only
    // writer and is registered before its reader (BallSpawnSystem).
    this.muzzles =
      (this.globals.gauntletMuzzles as GauntletMuzzles | undefined) ??
      new GauntletMuzzles();
    this.globals.gauntletMuzzles = this.muzzles;

    this.wrists = [new WristPose('left'), new WristPose('right')];
    this.shownPos = [new Vector3(), new Vector3()];
    this.shownQ = [new Quaternion(), new Quaternion()];
    this.sleevePos = [new Vector3(), new Vector3()];
    this.sleeveQ = [new Quaternion(), new Quaternion()];
    this.platePos = [new Vector3(), new Vector3()];
    this.plateQ = [new Quaternion(), new Quaternion()];
    this.wristQs = [new Quaternion(), new Quaternion()];
    this.lastPalm = [new Vector3(), new Vector3()];
    this.palms = [new Vector3(), new Vector3()];
    this.pivotLocal = [new Vector3(), new Vector3()];
    this.primed = new Uint8Array(2);
    this.posed = new Uint8Array(2);
    this.everPosed = new Uint8Array(2);
    this.controllerRoll = [new Quaternion(), new Quaternion()];
    for (let hand = 0; hand < 2; hand++) {
      this.controllerRoll[hand].setFromAxisAngle(
        new Vector3(0, 0, 1),
        handMirror(hand) * BLASTER.controllerRollDeg * DEG_TO_RAD,
      );
    }
    this.deploy = new Float32Array(3);
    this.recoil = new Float32Array(2);
    this.tmpV = new Vector3();
    this.tmpV2 = new Vector3();
    this.tmpQ = new Quaternion();
    this.tmpQ2 = new Quaternion();
    this.tmpQ3 = new Quaternion();
    this.dir = new Vector3();
    this.accentBase = new Color();
    this.liquidBase = new Color();
    this.gemLocal = new Vector3();
    this.gemNormal = new Vector3(0, 1, 0);

    // Fit: defaults, then whatever this device remembers.
    this.section = { a: 0, b: 0 };
    this.baseFit = computeArmFit(
      ARMFIT.defaultHandLengthMeters,
      ARMFIT.defaultPalmWidthMeters,
      NaN,
      ARMFIT,
      createArmFit(),
    );
    this.targetFit = createArmFit();
    this.calibrator = new ArmFitCalibrator(ARMFIT);
    this.calibrator.load(this.readStoredCalibration());
    this.copyCalibration(this.lastSaved);
    this.fitShown = new Float32Array(7);
    this.fitTarget = new Float32Array(7);
    this.jointIdx = [new Int16Array(8), new Int16Array(8)];
    this.radii = new Float32Array(32);
    this.sampleClock = new Float32Array(2);
    this.trackedAt = new Float32Array(2);
    this.palmSpeed = new Float32Array(2);

    this.torsoFwd = new Vector3(0, 0, -1);
    this.headPos = new Vector3();
    this.headQ = new Quaternion();
    this.neck = new Vector3();
    this.elbow = new Float32Array(3);
    this.axis = new Float32Array(3);
    this.basis = new Float32Array(9);
    this.quat = new Float32Array(4);

    this.buildMaterials();
    for (let hand = 0; hand < 2; hand++) this.buildHand(hand);

    // Start already in the stored mode: no deploy animation (and no cue) for
    // the loadout the session boots with.
    this.lastMode = this.blasterMode.peek();
    deployTargetsFor(this.lastMode, this.targets);
    this.deploy[0] = this.targets.bracer;
    this.deploy[1] = this.targets.paint;
    this.deploy[2] = this.targets.web;

    this.applySkin();
    this.applyPaintColor();
    this.applyWebGlow();

    this.cleanupFuncs.push(
      ...(this.blasterSkin ? [this.blasterSkin.subscribe(() => this.applySkin())] : []),
      ...(this.activeColor
        ? [this.activeColor.subscribe(() => this.applyPaintColor())]
        : []),
      ...(this.webSubMode ? [this.webSubMode.subscribe(() => this.applyWebGlow())] : []),
      // Recoil: any ball an arm fires while a launcher is out. Keyed off the
      // ball appearing, so the trigger, auto-fire, the flick and the thrust
      // all kick the same way.
      this.queries.balls.subscribe('qualify', (ball) => {
        const mode = this.blasterMode.peek();
        if (mode === BlasterMode.Hand) return;
        const style = ball.getValue(Ball, 'style');
        if (mode === BlasterMode.Paint && style !== BallStyle.Paint) return;
        const hand = ball.getValue(Ball, 'firedBy') ?? -1;
        if (hand !== 0 && hand !== 1) return;
        this.recoil[hand] = mode === BlasterMode.Paint ? 1 : 0.7;
      }),
    );
  }

  update(delta: number) {
    this.pausedSignal ??= this.globals.paused as Signal<boolean> | undefined;
    if (this.pausedSignal?.peek() === true) {
      this.wasPaused = true;
      return;
    }
    if (this.wasPaused) {
      // Back from the Quest menu: the hand is wherever it is now. Snap, do
      // not glide from where it was a minute ago.
      this.wasPaused = false;
      this.primed[0] = 0;
      this.primed[1] = 0;
      this.bodyPrimed = false;
    }
    this.elapsed += delta;

    this.stepMode(delta);
    this.updateBody(delta);
    this.updateFit(delta);
    for (let hand = 0; hand < 2; hand++) this.poseHand(hand, delta);
    this.animateHardware(delta);
  }

  // ---- Public API (WebShooterSystem, the wrist menu, MCP smoke tests) -------

  /** True when this hand produced a pose this frame. */
  isPosed(hand: number): boolean {
    return this.posed[hand] === 1;
  }

  /** True when this frame's pose came from a tracked hand (not a controller). */
  isHand(hand: number): boolean {
    return this.wrists?.[hand]?.isHand === true;
  }

  /** The palm (grip origin) of this hand's latest pose. */
  palmInto(hand: number, out: Vector3): Vector3 {
    return out.copy(this.palms[hand]);
  }

  /** Unit direction a shot from this arm travels: the shown turret's -Z. */
  aimInto(hand: number, out: Vector3): Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.shownQ[hand]);
  }

  /**
   * The GOO nozzle tip, world space (no clearance offset) — where strands
   * start. Round 10: on top of the forearm, on the turret. Valid in every
   * mode: HAND-mode gestures fire from the same (invisible) point.
   */
  nozzleInto(hand: number, out: Vector3): Vector3 {
    const m = handMirror(hand);
    out
      .set(
        m * (WEB.shooterOffsetX + WEB.muzzleLocal[0]),
        WEB.shooterOffsetY + WEB.muzzleLocal[1],
        WEB.shooterOffsetZ + WEB.muzzleLocal[2],
      )
      .applyQuaternion(this.shownQ[hand]);
    return out.add(this.shownPos[hand]);
  }

  /** The paint barrel's muzzle, world space (no clearance offset). */
  barrelMuzzleInto(hand: number, out: Vector3): Vector3 {
    const m = handMirror(hand);
    out
      .set(m * BLASTER.muzzleLocal[0], BLASTER.muzzleLocal[1], BLASTER.muzzleLocal[2])
      .applyQuaternion(this.shownQ[hand]);
    return out.add(this.shownPos[hand]);
  }

  /**
   * Where a shot from this arm is born in the current mode: out of the paint
   * barrel in BLASTER mode, out of the GOO nozzle otherwise, plus that
   * launcher's clearance along the aim.
   */
  shotOriginInto(hand: number, out: Vector3): Vector3 {
    this.aimInto(hand, this.dir);
    if (this.blasterMode.peek() === BlasterMode.Paint) {
      this.barrelMuzzleInto(hand, out);
      return out.addScaledVector(this.dir, BLASTER.muzzleOffset);
    }
    this.nozzleInto(hand, out);
    return out.addScaledVector(this.dir, WEB.muzzleOffset);
  }

  /**
   * World position of the LEFT arm's menu gem (round 10), for the wrist menu
   * to anchor to / poke-test against.
   *
   * @returns false (out untouched) while the left arm is not posed or the gem
   *   is hidden (HAND mode with `ARMFIT.gemInHandMode` off).
   */
  menuGemInto(out: Vector3): boolean {
    if (!this.posed[0] || !this.gemShown) return false;
    out.copy(this.gemLocal).applyQuaternion(this.sleeveQ[0]).add(this.sleevePos[0]);
    return true;
  }

  /** Outward surface normal at the menu gem, world space (unit). Same validity as {@link menuGemInto}. */
  menuGemNormalInto(out: Vector3): boolean {
    if (!this.posed[0] || !this.gemShown) return false;
    out.copy(this.gemNormal).applyQuaternion(this.sleeveQ[0]);
    return true;
  }

  /** The menu gem's Object3D (left sleeve), e.g. to pulse it. */
  menuGemObject(): Object3D | undefined {
    return this.gem;
  }

  /**
   * The smoothed anatomical wrist frame of this hand (WebXR wrist joint:
   * +Y out of the back of the hand, -Z toward the fingers, same on both
   * hands; controllers: aim + mirrored grip). @returns false when not posed.
   */
  wristQuaternionInto(hand: number, out: Quaternion): boolean {
    if (!this.posed[hand]) return false;
    out.copy(this.wristQs[hand]);
    return true;
  }

  /**
   * The smoothed sleeve (forearm) frame the menu gem rides: origin at the
   * wrist joint, -Z toward the hand along the forearm, +Y off its back.
   * @returns false when not posed.
   */
  sleeveQuaternionInto(hand: number, out: Quaternion): boolean {
    if (!this.posed[hand]) return false;
    out.copy(this.sleeveQ[hand]);
    return true;
  }

  /** Wrist joint position (sleeve origin), smoothed, world space. */
  sleeveOriginInto(hand: number, out: Vector3): boolean {
    if (!this.posed[hand]) return false;
    out.copy(this.sleevePos[hand]);
    return true;
  }

  /**
   * Set the calibration by hand (a future settings slider, the headless
   * harness). Not persisted unless `persist`. Measuring carries on refining
   * from it.
   */
  setCalibration(handLength: number, palmWidth: number, wristRadius = NaN, persist = false): void {
    this.calibrator.load({ handLength, palmWidth, wristRadius, windows: 1 });
    this.fitDirty = true;
    if (persist) this.persistCalibration(true);
  }

  /**
   * Inner-wall semi-axes of the SHOWN sleeve `z` metres behind the wrist
   * joint, in the sleeve's frame (breadth along X, depth along Y), and its
   * extent along Z in `range` when given. For enclosure checks (harness).
   */
  sleeveInnerAt(z: number, out: SemiAxes, range?: number[]): SemiAxes {
    const fs = this.fitShown;
    forearmSectionAt(this.baseFit, z / (fs[2] || 1), ARMFIT.skinMarginMeters, out);
    out.a *= fs[0];
    out.b *= fs[1];
    if (range) {
      range[0] = this.baseFit.sleeveStart * fs[2];
      range[1] = this.baseFit.sleeveEnd * fs[2];
    }
    return out;
  }

  /** The fit the gauntlets are growing toward, and the live calibrator (tests, MCP). */
  get debugFit(): { target: ArmFit; base: ArmFit; shown: Readonly<Float32Array>; calibrator: ArmFitCalibrator } {
    return { target: this.targetFit, base: this.baseFit, shown: this.fitShown, calibrator: this.calibrator };
  }

  /** Deploy progress 0..1 of [bracer, paint, web], for tests and MCP checks. */
  get debugDeploy(): Readonly<Float32Array> {
    return this.deploy;
  }

  // ---- Mode ------------------------------------------------------------------

  private stepMode(delta: number): void {
    const mode = this.blasterMode.peek();
    if (mode !== this.lastMode) {
      this.lastMode = mode;
      this.events?.emit(GameEvent.BlasterModeChanged, 0, 0, 0, mode);
    }
    deployTargetsFor(mode, this.targets);
    const d = this.deploy;
    const sec = BLASTER.transitionSec;
    d[0] = stepDeploy(d[0], this.targets.bracer, delta, sec);
    d[1] = stepDeploy(d[1], this.targets.paint, delta, sec);
    d[2] = stepDeploy(d[2], this.targets.web, delta, sec);
  }

  // ---- Fit -------------------------------------------------------------------

  private readStoredCalibration(): ArmCalibration | null {
    try {
      return parseArmCalibration(globalThis.localStorage?.getItem(ARMFIT.storageKey), ARMFIT);
    } catch {
      return null;
    }
  }

  private copyCalibration(out: ArmCalibration): void {
    out.handLength = this.calibrator.handLength;
    out.palmWidth = this.calibrator.palmWidth;
    out.wristRadius = this.calibrator.wristRadius;
    out.windows = this.calibrator.windows;
  }

  /** Save when something moved by more than the epsilon (or always, `force`). */
  private persistCalibration(force: boolean): void {
    const c = this.calibrator;
    if (!c.calibrated) return;
    const eps = ARMFIT.persistEpsilonMeters;
    const s = this.lastSaved;
    const moved =
      !(Math.abs(c.handLength - s.handLength) <= eps) ||
      !(Math.abs(c.palmWidth - s.palmWidth) <= eps) ||
      (Number.isFinite(c.wristRadius) && !(Math.abs(c.wristRadius - s.wristRadius) <= eps));
    if (!moved && !force) return;
    this.copyCalibration(s);
    try {
      globalThis.localStorage?.setItem(ARMFIT.storageKey, serializeArmCalibration(s));
    } catch {
      // Private window / blocked storage: the fit still applies this session.
    }
  }

  /**
   * Pick the fit to grow toward (the calibration while a tracked hand is
   * up, the defaults otherwise) and glide the shown scales to it.
   */
  private updateFit(delta: number): void {
    const handUp =
      (this.posed[0] === 1 && this.wrists[0].isHand) ||
      (this.posed[1] === 1 && this.wrists[1].isHand);
    const useCal = handUp && this.calibrator.calibrated && ARMFIT.enabled;
    if (this.fitDirty || useCal !== this.fitUsedCal) {
      this.fitDirty = false;
      this.fitUsedCal = useCal;
      const c = this.calibrator;
      computeArmFit(
        useCal ? c.handLength : ARMFIT.defaultHandLengthMeters,
        useCal ? c.palmWidth : ARMFIT.defaultPalmWidthMeters,
        useCal ? c.wristRadius : NaN,
        ARMFIT,
        this.targetFit,
      );
      const t = this.fitTarget;
      sleeveScaleFor(this.targetFit, this.baseFit, t);
      t[3] = this.targetFit.plateWidth / PLATE_MODEL_WIDTH;
      t[4] = this.targetFit.plateLength / PLATE_MODEL_LENGTH;
      t[5] = this.targetFit.palmWidth / this.baseFit.palmWidth;
      t[6] = this.targetFit.handLength / this.baseFit.handLength;
    }
    const s = this.fitShown;
    const t = this.fitTarget;
    if (!this.fitPrimed) {
      s.set(t);
      this.fitPrimed = true;
      return;
    }
    const a = smoothingAlpha(delta, ARMFIT.sizeSmoothingSec);
    for (let i = 0; i < 7; i++) s[i] += (t[i] - s[i]) * a;
  }

  private fitUsedCal = false;

  /**
   * Sample this hand's joints into the calibrator (at `ARMFIT.sampleHz`, only
   * once it has been tracked for `settleAfterReacquireSec` and while it is
   * not whipping about).
   */
  private sampleHand(hand: number, delta: number): void {
    if (!ARMFIT.enabled || !this.measuring) return;
    this.sampleClock[hand] += delta;
    if (this.sampleClock[hand] < 1 / ARMFIT.sampleHz) return;
    this.sampleClock[hand] = 0;
    if (this.elapsed - this.trackedAt[hand] < ARMFIT.settleAfterReacquireSec) return;
    if (this.palmSpeed[hand] > ARMFIT.maxSampleSpeed) return;

    const side = hand === 0 ? 'left' : 'right';
    const adapter = (this.input?.visualAdapters?.hand as unknown as Record<string, HandAdapterLike | undefined>)?.[side];
    const spaces = adapter?.jointSpaces;
    const tr = adapter?.jointTransforms;
    if (!spaces || !tr) return;
    const idx = this.jointIdx[hand];
    if (this.jointIdxFor[hand] !== spaces || idx[0] < 0 || spaces[idx[0]]?.jointName !== 'wrist') {
      this.jointIdxFor[hand] = spaces;
      const names: Array<string | undefined> = [];
      for (let i = 0; i < spaces.length; i++) names.push(spaces[i]?.jointName);
      resolveHandJoints(names, idx);
    }

    let radii: Float32Array | null = null;
    // WebXR Hand Input's XRFrame.fillJointRadii (absent from the bundled
    // typings, and from some runtimes: feature-tested).
    const frame = this.xrFrame as
      | { fillJointRadii?: (spaces: XRJointSpace[], radii: Float32Array) => boolean }
      | undefined;
    if (frame && typeof frame.fillJointRadii === 'function' && spaces.length <= this.radii.length) {
      try {
        if (frame.fillJointRadii(spaces as XRJointSpace[], this.radii)) radii = this.radii;
      } catch {
        radii = null;
      }
    }
    if (!measureHand(tr, idx, radii, ARMFIT.fallbackKnuckleRadius, this.measurement)) return;
    const m = this.measurement;
    if (this.calibrator.addSample(m.handLength, m.palmWidth, m.wristRadius) === SampleResult.Calibrated) {
      this.fitDirty = true;
      this.persistCalibration(false);
    }
  }

  // ---- Body estimate ------------------------------------------------------------

  /**
   * A rough torso from the head: a neck pivot behind and below the eyes, and
   * a torso yaw that follows the head's slowly. The shoulders hang off it
   * (see {@link shoulderInto}) for the forearm IK.
   */
  private updateBody(delta: number): void {
    const dbg = this.debugBodyHead;
    if (dbg) {
      this.headPos.set(dbg.position[0], dbg.position[1], dbg.position[2]);
      this.headQ.set(dbg.quaternion[0], dbg.quaternion[1], dbg.quaternion[2], dbg.quaternion[3]);
    } else {
      const head = this.player?.head;
      if (!head) {
        this.bodyValid = false;
        return;
      }
      head.getWorldPosition(this.headPos);
      head.getWorldQuaternion(this.headQ);
    }
    // Horizontal forward that survives looking straight down: forward + up.
    this.tmpV.set(0, 0, -1).applyQuaternion(this.headQ);
    this.tmpV2.set(0, 1, 0).applyQuaternion(this.headQ);
    let fx = this.tmpV.x + this.tmpV2.x;
    let fz = this.tmpV.z + this.tmpV2.z;
    const fl = Math.sqrt(fx * fx + fz * fz);
    if (fl > 1e-3) {
      fx /= fl;
      fz /= fl;
      if (!this.bodyPrimed) {
        this.torsoFwd.set(fx, 0, fz);
        this.bodyPrimed = true;
      } else {
        const a = smoothingAlpha(delta, ARMFIT.torsoYawSmoothingSec);
        this.torsoFwd.x += (fx - this.torsoFwd.x) * a;
        this.torsoFwd.z += (fz - this.torsoFwd.z) * a;
        this.torsoFwd.y = 0;
        if (this.torsoFwd.lengthSq() < 1e-6) this.torsoFwd.set(fx, 0, fz);
        this.torsoFwd.normalize();
      }
    }
    this.neck
      .set(0, -ARMFIT.neckDownMeters, ARMFIT.neckBackMeters)
      .applyQuaternion(this.headQ)
      .add(this.headPos);
    this.bodyValid = this.bodyPrimed;
  }

  /** The estimated shoulder joint of `hand`, world space. */
  private shoulderInto(hand: number, out: Vector3): Vector3 {
    const side = handMirror(hand);
    const f = this.torsoFwd;
    // Right = forward x up = (-f.z, 0, f.x).
    return out.set(
      this.neck.x - f.z * side * ARMFIT.shoulderHalfWidthMeters,
      this.neck.y - ARMFIT.shoulderDropMeters,
      this.neck.z + f.x * side * ARMFIT.shoulderHalfWidthMeters,
    );
  }

  /**
   * The sleeve's orientation for this frame's wrist: -Z along the estimated
   * forearm (toward the hand), +Y the hand's dorsal axis made orthogonal.
   */
  private sleeveTargetInto(hand: number, wrist: WristPose, out: Quaternion): void {
    this.tmpV.set(0, 0, -1).applyQuaternion(wrist.wristQ);
    const hx = this.tmpV.x;
    const hy = this.tmpV.y;
    const hz = this.tmpV.z;
    let ax = hx;
    let ay = hy;
    let az = hz;
    if (this.bodyValid && ARMFIT.forearmIkWeight > 0) {
      const s = this.shoulderInto(hand, this.tmpV2);
      const side = handMirror(hand);
      const f = this.torsoFwd;
      // Elbows hang down, a little out and back.
      const px = -f.z * side * 0.6 - f.x * 0.25;
      const pz = f.x * side * 0.6 - f.z * 0.25;
      const fit = this.targetFit;
      solveElbow(
        s.x, s.y, s.z,
        wrist.anchor.x, wrist.anchor.y, wrist.anchor.z,
        fit.upperArmLength, fit.forearmLength,
        px, -1, pz,
        this.elbow,
      );
      let ix = wrist.anchor.x - this.elbow[0];
      let iy = wrist.anchor.y - this.elbow[1];
      let iz = wrist.anchor.z - this.elbow[2];
      const il = Math.sqrt(ix * ix + iy * iy + iz * iz);
      if (il > 1e-4) {
        ix /= il;
        iy /= il;
        iz /= il;
        blendForearmAxis(
          hx, hy, hz, ix, iy, iz,
          ARMFIT.forearmIkWeight,
          ARMFIT.wristMaxBendDeg * DEG_TO_RAD,
          this.axis,
          ARMFIT.forearmIkDeadzoneDeg[0] * DEG_TO_RAD,
          ARMFIT.forearmIkDeadzoneDeg[1] * DEG_TO_RAD,
        );
        ax = this.axis[0];
        ay = this.axis[1];
        az = this.axis[2];
      }
    }
    this.tmpV.set(0, 1, 0).applyQuaternion(wrist.wristQ);
    if (buildAimBasis(ax, ay, az, this.tmpV.x, this.tmpV.y, this.tmpV.z, this.basis)) {
      quatFromBasis(this.basis, this.quat);
      out.set(this.quat[0], this.quat[1], this.quat[2], this.quat[3]).normalize();
    } else {
      out.copy(wrist.wristQ);
    }
  }

  // ---- Pose ------------------------------------------------------------------

  private poseHand(hand: number, delta: number): void {
    const wrist = this.wrists[hand];
    const muzzles = this.muzzles;
    if (!wrist.update(this.player, this.input, WEB)) {
      // Lost (or never seen: the hardware starts at the world origin). Hide
      // it rather than leave a sleeve frozen in mid-air while the real hand
      // carries on in passthrough, and forget the smoothing, so reacquiring
      // snaps instead of gliding across the room. The last pose is kept, so
      // strands still hang off the last nozzle position.
      if (this.posed[hand] || this.everPosed[hand] === 0) this.setShown(hand, false);
      if (this.posed[hand]) this.calibrator.resetWindow();
      this.posed[hand] = 0;
      this.primed[hand] = 0;
      muzzles.valid[hand] = 0;
      return;
    }
    if (!this.posed[hand]) {
      this.setShown(hand, true);
      this.trackedAt[hand] = this.elapsed;
    }
    this.posed[hand] = 1;
    this.everPosed[hand] = 1;
    this.palms[hand].copy(wrist.palm);

    // A palm that jumps further than any real hand moves in a frame is a hand
    // that dropped out and came back: snap (and distrust its joints a while).
    const jump = WEB.reacquireJumpMeters;
    const moved = this.lastPalm[hand].distanceTo(wrist.palm);
    if (this.primed[hand] && moved > jump) {
      this.primed[hand] = 0;
      this.trackedAt[hand] = this.elapsed;
    }
    this.palmSpeed[hand] = this.primed[hand] && delta > 0 ? moved / delta : 0;
    this.lastPalm[hand].copy(wrist.palm);

    const isHand = wrist.isHand;
    const roll = this.controllerRoll[hand];

    // Sleeve: forearm axis at the wrist anchor (unrolled — the ellipse
    // follows the anatomy; the controller roll moves the turret instead).
    this.sleeveTargetInto(hand, wrist, this.tmpQ2);
    // Turret: the aim, rolled for controllers, clamped to a swivel of the
    // sleeve's rest pose for the turret.
    this.tmpQ3.copy(this.tmpQ2);
    if (!isHand) this.tmpQ3.multiply(roll);
    this.tmpQ.copy(wrist.aimQ);
    if (!isHand) this.tmpQ.multiply(roll);
    // rel = rest^-1 * aim
    const restX = this.tmpQ3.x;
    const restY = this.tmpQ3.y;
    const restZ = this.tmpQ3.z;
    const restW = this.tmpQ3.w;
    this.tmpQ3.invert().multiply(this.tmpQ);
    clampQuatAngle(
      this.tmpQ3.x, this.tmpQ3.y, this.tmpQ3.z, this.tmpQ3.w,
      ARMFIT.turretMaxDeg * DEG_TO_RAD,
      this.quat,
    );
    this.tmpQ.set(restX, restY, restZ, restW).multiply(
      this.tmpQ3.set(this.quat[0], this.quat[1], this.quat[2], this.quat[3]),
    );

    // Plate: wrist frame, offset onto the back of the hand, scaled to it.
    const off = isHand ? BLASTER.plateOffsetHand : BLASTER.plateOffsetController;
    const fs = this.fitShown;
    const py = isHand ? fs[5] : 1;
    const pz = isHand ? fs[6] : 1;
    this.tmpV
      .set(handMirror(hand) * off[0], off[1] * py, off[2] * pz)
      .applyQuaternion(wrist.wristQ)
      .add(wrist.anchor);

    const sleevePos = this.sleevePos[hand];
    const sleeveQ = this.sleeveQ[hand];
    const shownQ = this.shownQ[hand];
    const platePos = this.platePos[hand];
    const plateQ = this.plateQ[hand];
    const wristQ = this.wristQs[hand];
    if (!this.primed[hand]) {
      sleevePos.copy(wrist.anchor);
      sleeveQ.copy(this.tmpQ2);
      shownQ.copy(this.tmpQ);
      platePos.copy(this.tmpV);
      plateQ.copy(wrist.wristQ);
      wristQ.copy(wrist.wristQ);
      this.primed[hand] = 1;
    } else {
      const alpha = smoothingAlpha(delta, WEB.shooterSmoothingSec);
      sleevePos.lerp(wrist.anchor, alpha);
      sleeveQ.slerp(this.tmpQ2, alpha);
      shownQ.slerp(this.tmpQ, alpha);
      platePos.lerp(this.tmpV, alpha);
      plateQ.slerp(wrist.wristQ, alpha);
      wristQ.copy(plateQ);
    }

    // Turret pivot on the sleeve's top (thumb side for controllers).
    this.updatePivot(hand, isHand);
    const shownPos = this.shownPos[hand];
    shownPos.copy(this.pivotLocal[hand]).applyQuaternion(sleeveQ).add(sleevePos);

    const sleeve = this.sleeveEntities[hand]?.object3D;
    if (sleeve) {
      setWorldPosition(sleeve, sleevePos);
      setWorldQuaternion(sleeve, sleeveQ);
    }
    const turret = this.turretEntities[hand]?.object3D;
    if (turret) {
      setWorldPosition(turret, shownPos);
      setWorldQuaternion(turret, shownQ);
    }
    const plate = this.plateEntities[hand]?.object3D;
    if (plate) {
      setWorldPosition(plate, platePos);
      setWorldQuaternion(plate, plateQ);
    }

    if (isHand) this.sampleHand(hand, delta);

    // Publish this arm's launch point for BallSpawnSystem's trigger path.
    if (this.lastMode === BlasterMode.Hand) {
      muzzles.valid[hand] = 0;
      return;
    }
    this.shotOriginInto(hand, this.tmpV);
    const b = hand * 3;
    muzzles.origin[b] = this.tmpV.x;
    muzzles.origin[b + 1] = this.tmpV.y;
    muzzles.origin[b + 2] = this.tmpV.z;
    muzzles.direction[b] = this.dir.x;
    muzzles.direction[b + 1] = this.dir.y;
    muzzles.direction[b + 2] = this.dir.z;
    muzzles.valid[hand] = 1;
  }

  /**
   * Where the turret pivot sits in this sleeve's frame for the shown fit:
   * on the outer surface at the top (hands) or the thumb side (controllers,
   * rolled), lifted by `ARMFIT.turretPivotLift`, `turretPivotZ` back.
   */
  private updatePivot(hand: number, isHand: boolean): void {
    const fs = this.fitShown;
    const zc = ARMFIT.turretPivotZ;
    this.outerSectionAt(zc, this.section);
    const theta = (90 + (isHand ? 0 : BLASTER.controllerRollDeg)) * DEG_TO_RAD;
    const a = this.section.a * fs[0];
    const b = this.section.b * fs[1];
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    // Outward normal of the ellipse at theta: (cos/a, sin/b), normalised.
    let nx = c / a;
    let ny = s / b;
    const nl = Math.sqrt(nx * nx + ny * ny);
    nx /= nl;
    ny /= nl;
    const lift = ARMFIT.turretPivotLift;
    this.pivotLocal[hand].set(
      handMirror(hand) * (a * c + nx * lift),
      b * s + ny * lift,
      zc * fs[2],
    );
  }

  /** The sleeve's outer surface at canonical (default-fit) z, unscaled. */
  private outerSectionAt(z: number, out: SemiAxes): SemiAxes {
    return forearmSectionAt(
      this.baseFit,
      z,
      ARMFIT.skinMarginMeters + ARMFIT.shellThicknessMeters,
      out,
    );
  }

  /** Show or hide this arm's roots (tracking gained / lost). */
  private setShown(hand: number, shown: boolean): void {
    const sleeve = this.sleeveEntities[hand]?.object3D;
    if (sleeve) sleeve.visible = shown;
    const turret = this.turretEntities[hand]?.object3D;
    if (turret) turret.visible = shown;
    const plate = this.plateEntities[hand]?.object3D;
    if (plate) plate.visible = shown;
  }

  // ---- Animation -------------------------------------------------------------

  private animateHardware(delta: number): void {
    const d = this.deploy;
    const fs = this.fitShown;
    const bracer = d[0];
    const paint = d[1];
    const web = d[2];
    const eb = easeOutBack(bracer);
    const ebz = easeOutCubic(bracer);
    const ep = easeOutBack(paint);
    const ew = easeOutBack(web);

    let maxRecoil = 0;
    for (let hand = 0; hand < 2; hand++) {
      const r = decayRecoil(this.recoil[hand], delta, BLASTER.recoilDecaySec);
      this.recoil[hand] = r;
      if (r > maxRecoil) maxRecoil = r;

      const br = this.bracers[hand];
      if (br) {
        br.visible = bracer > 0.001;
        // Grows out of the wrist up the forearm, widening as it locks on.
        const w = 0.6 + 0.4 * eb;
        br.scale.set(fs[0] * w, fs[1] * w, fs[2] * (0.15 + 0.85 * ebz));
      }
      const tb = this.turretBases[hand];
      if (tb) {
        tb.visible = bracer > 0.001;
        const s = 0.3 + 0.7 * eb;
        tb.scale.set(s, s, s);
      }
      const pf = this.plateFits[hand];
      if (pf) {
        const isHand = this.wrists[hand].isHand;
        pf.scale.set(isHand ? fs[3] : PLATE_MODEL_SCALE_X, 1, isHand ? fs[4] : PLATE_MODEL_SCALE_Z);
      }
      const hinge = this.plateHinges[hand];
      if (hinge) {
        hinge.visible = bracer > 0.001;
        // Folds down onto the back of the hand like a visor.
        hinge.rotation.x = (1 - ebz) * PLATE_FOLD_RAD;
        const s = 0.3 + 0.7 * eb;
        hinge.scale.set(s, s, s);
      }

      // Turret modules: the loaded one rises out of the rail, the other sinks.
      const pm = this.paintModules[hand];
      if (pm) {
        pm.visible = paint > 0.001;
        const s = 0.15 + 0.85 * ep;
        pm.scale.set(s, s, s);
        const rise = (1 - easeOutCubic(paint)) * -MODULE_SINK;
        const pr = this.lastMode === BlasterMode.Paint ? r : 0;
        pm.position.set(
          PAINT_PIVOT[0] - LEGACY_ORIGIN[0],
          PAINT_PIVOT[1] - LEGACY_ORIGIN[1] + rise,
          PAINT_PIVOT[2] - LEGACY_ORIGIN[2] + pr * BLASTER.recoilMeters,
        );
        pm.rotation.x = pr * BLASTER.recoilPitchDeg * DEG_TO_RAD;
      }
      const liquid = this.liquids[hand];
      if (liquid) {
        // The canister fills a beat after the barrel rises.
        liquid.scale.set(1, 1, Math.max(0.02, easeOutCubic((paint - 0.35) / 0.65)));
      }
      const wm = this.webModules[hand];
      if (wm) {
        wm.visible = web > 0.001;
        const s = 0.15 + 0.85 * ew;
        wm.scale.set(s, s, s);
        const wr = this.lastMode === BlasterMode.Web ? r : 0;
        wm.position.set(
          handMirror(hand) * WEB.shooterOffsetX,
          WEB.shooterOffsetY + (1 - easeOutCubic(web)) * -MODULE_SINK,
          WEB.shooterOffsetZ + wr * BLASTER.recoilMeters,
        );
        wm.rotation.x = wr * BLASTER.recoilPitchDeg * 0.6 * DEG_TO_RAD;
      }

      const flash = this.flashes[hand];
      if (flash) {
        flash.visible = paint > 0.001 && r > 0.04 && this.lastMode === BlasterMode.Paint;
        const s = Math.max(0.001, r * BLASTER.muzzleFlashScale);
        flash.scale.set(s, s, s);
      }
      const swirl = this.swirls[hand];
      if (swirl && paint > 0.001) {
        swirl.rotation.z += delta * Math.PI * 2 * BLASTER.canisterSwirlHz * (1 + 3 * r);
      }
      const goo = this.gooSwirls[hand];
      if (goo && web > 0.001) {
        goo.rotation.z += delta * Math.PI * 2 * BLASTER.canisterSwirlHz * 0.7 * (1 + 3 * r);
      }
    }

    this.animateGem(bracer);

    if (paint > 0.001 || web > 0.001) {
      // Breathing glow on the shared liquid: one colour write per frame.
      const pulse =
        0.82 + 0.18 * Math.sin(this.elapsed * Math.PI * 2 * BLASTER.canisterPulseHz);
      this.liquidMat.color.copy(this.liquidBase).multiplyScalar(pulse + 0.4 * maxRecoil);
    }
    // Seams flare with each shot, then settle (and stop writing).
    if (maxRecoil > 0) {
      this.accentMat.color.copy(this.accentBase).multiplyScalar(1 + 1.2 * maxRecoil);
      this.seamPulsing = true;
    } else if (this.seamPulsing) {
      this.accentMat.color.copy(this.accentBase);
      this.seamPulsing = false;
    }
  }

  /** Place the left gem on the shown sleeve; show it with the sleeve (or always). */
  private animateGem(bracer: number): void {
    const gem = this.gem;
    if (!gem) return;
    const fs = this.fitShown;
    const isHand = this.wrists[0].isHand;
    const zc = this.baseFit.sleeveStart + ARMFIT.gemBackMeters;
    this.outerSectionAt(zc, this.section);
    const theta = (ARMFIT.gemAngleDeg + (isHand ? 0 : BLASTER.controllerRollDeg)) * DEG_TO_RAD;
    const a = this.section.a * fs[0];
    const b = this.section.b * fs[1];
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    let nx = c / a;
    let ny = s / b;
    const nl = Math.sqrt(nx * nx + ny * ny);
    nx /= nl;
    ny /= nl;
    const m = handMirror(0);
    const lift = 0.0035;
    this.gemNormal.set(m * nx, ny, 0);
    this.gemLocal.set(m * (a * c + nx * lift), b * s + ny * lift, zc * fs[2]);
    gem.position.copy(this.gemLocal);
    // Gem +Y along the outward normal.
    gem.quaternion.setFromUnitVectors(this.tmpV.set(0, 1, 0), this.gemNormal);

    const always = ARMFIT.gemInHandMode;
    const k = always ? 1 : easeOutBack(bracer);
    this.gemShown = always || bracer > 0.001;
    gem.visible = this.gemShown;
    const gs = 0.2 + 0.8 * k;
    gem.scale.set(gs, gs, gs);
    const band = this.gemBand;
    if (band) {
      // The slim band only matters when the sleeve is not there to carry it.
      band.visible = always && bracer < 0.999;
      band.scale.set(fs[0], fs[1], fs[2]);
    }
  }

  // ---- Colour ----------------------------------------------------------------

  /** Shell, trim and glow from the selected skin. On change only. */
  private applySkin(): void {
    const skin =
      resolveSkin<BlasterSkin>(BLASTER.skins, this.blasterSkin?.peek()) ??
      ({ name: '', accent: '#ff4f81', trim: '#ffb347', shell: '#ecebe6' } as BlasterSkin);
    // Hex strings are sRGB; Color.set() converts them to the linear working
    // space (gotcha 23 is about raw tuples, handled in applyPaintColor).
    this.shellMat.color.set(skin.shell);
    this.trimMat.color.set(skin.trim);
    this.trimMat.emissive.set(skin.trim);
    this.accentBase.set(skin.accent);
    this.accentMat.color.copy(this.accentBase);
  }

  /** Canister liquid, goo, swirl and muzzle flash in the loaded paint colour. */
  private applyPaintColor(): void {
    const c = this.activeColor?.peek();
    if (!c) return;
    this.liquidBase.setRGB(c[0], c[1], c[2], SRGBColorSpace);
    this.liquidMat.color.copy(this.liquidBase);
    this.swirlMat.color.setRGB(1, 1, 1).lerp(this.liquidBase, 0.55);
    this.flashMat.color.copy(this.liquidBase).lerp(this.swirlMat.color, 0.3);
  }

  /** GOO state light keyed to SPLAT (coral-white) / TETHER (cyan). */
  private applyWebGlow(): void {
    this.webGlowMat.color.set(
      this.webSubMode?.peek() === WebSubMode.Tether ? WEB_GLOW_TETHER : WEB_GLOW_SPLAT,
    );
  }

  // ---- Construction ----------------------------------------------------------

  private buildMaterials(): void {
    // Glossy vinyl: a clearcoat over a soft base, so the room IBL lays a crisp
    // highlight across every curve.
    this.shellMat = new MeshPhysicalMaterial({
      color: new Color('#ecebe6'),
      roughness: 0.32,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
    });
    this.graphiteMat = new MeshStandardMaterial({
      color: new Color('#3a404b'),
      roughness: 0.42,
      metalness: 0.3,
    });
    this.chromeMat = new MeshStandardMaterial({
      color: new Color('#eef1f6'),
      roughness: 0.1,
      metalness: 1,
    });
    this.trimMat = new MeshStandardMaterial({
      color: new Color('#ffb347'),
      roughness: 0.3,
      metalness: 0.35,
      emissive: new Color('#ffb347'),
      emissiveIntensity: 0.18,
    });
    // Neon: unlit and outside tone mapping, so it reads as light, not paint.
    this.accentMat = new MeshBasicMaterial({ color: new Color('#ff4f81'), toneMapped: false });
    this.glassMat = new MeshPhysicalMaterial({
      color: new Color('#ffffff'),
      roughness: 0.04,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
    });
    this.liquidMat = new MeshBasicMaterial({
      color: new Color('#ff4fb8'),
      toneMapped: false,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    });
    this.swirlMat = new MeshBasicMaterial({ color: new Color('#ffffff'), toneMapped: false });
    this.flashMat = new MeshBasicMaterial({
      color: new Color('#ffffff'),
      toneMapped: false,
      transparent: true,
      opacity: 0.85,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    this.boreMat = new MeshBasicMaterial({ color: new Color('#07080a') });
    this.webGlowMat = new MeshBasicMaterial({ color: new Color(WEB_GLOW_SPLAT), toneMapped: false });
    this.gemMat = new MeshBasicMaterial({ color: new Color(ARMFIT.gemColor), toneMapped: false });
  }

  private buildHand(hand: number): void {
    // ---- Sleeve root (forearm frame) ----------------------------------------
    const sleeve = new Group();
    sleeve.name = hand === 0 ? 'GauntletLeft' : 'GauntletRight';
    const sleeveEntity = this.world
      .createTransformEntity(sleeve, { parent: this.world.sceneEntity, persistent: true })
      .addComponent(Gauntlet, { side: hand, part: GauntletPart.Forearm });
    this.sleeveEntities[hand] = sleeveEntity;

    const bracer = this.buildSleeve();
    sleeve.add(bracer);
    this.bracers[hand] = bracer;

    if (hand === 0) {
      const gem = this.buildGem();
      sleeve.add(gem);
      this.gem = gem;
      const band = this.buildGemBand();
      sleeve.add(band);
      this.gemBand = band;
    }

    // ---- Turret (aim frame, pinned to the top of the sleeve) ----------------
    const turret = new Group();
    turret.name = hand === 0 ? 'GauntletTurretLeft' : 'GauntletTurretRight';
    this.turretEntities[hand] = this.world
      .createTransformEntity(turret, { parent: this.world.sceneEntity, persistent: true })
      .addComponent(Gauntlet, { side: hand, part: GauntletPart.Turret });

    const base = this.buildTurretBase();
    turret.add(base);
    this.turretBases[hand] = base;

    const paint = this.buildPaintModule(hand);
    turret.add(paint);
    this.paintModules[hand] = paint;

    const web = new Group();
    web.name = hand === 0 ? 'GooLauncherLeft' : 'GooLauncherRight';
    web.position.set(handMirror(hand) * WEB.shooterOffsetX, WEB.shooterOffsetY, WEB.shooterOffsetZ);
    web.add(
      (WEB.shooterUseGlb ? this.buildSpinneretModel() : undefined) ?? this.buildGooLauncher(hand),
    );
    turret.add(web);
    this.webModules[hand] = web;

    // ---- Back-of-hand plate (wrist frame) -----------------------------------
    const plate = new Group();
    plate.name = hand === 0 ? 'GauntletPlateLeft' : 'GauntletPlateRight';
    const fit = new Group();
    fit.name = 'PlateFit';
    plate.add(fit);
    this.plateFits[hand] = fit;
    const hinge = this.buildPlate();
    fit.add(hinge);
    this.plateHinges[hand] = hinge;
    this.plateEntities[hand] = this.world
      .createTransformEntity(plate, { parent: this.world.sceneEntity, persistent: true })
      .addComponent(Gauntlet, { side: hand, part: GauntletPart.Plate });
  }

  /** Section function over the default fit, for the build-time geometry helpers. */
  private sectionFn(): SectionFn {
    const fit = this.baseFit;
    return (z, off, out) => forearmSectionAt(fit, z, off, out);
  }

  /**
   * The forearm sleeve (round 10): a closed elliptical armour tube that wraps
   * the top, both sides AND the underside of the forearm, modelled round the
   * DEFAULT arm estimate and stretched per player by the parent's scale
   * ({@link sleeveScaleFor}). Inner wall = forearm + `skinMarginMeters`, wall
   * `shellThicknessMeters`; it tapers with the forearm (wider toward the
   * elbow) and flares at the elbow lip. Chrome bands at both ends, a graphite
   * mount rail along the top (where the turret sits), graphite flank and
   * underside panels, trim bands near the elbow, neon seams on every face —
   * so it reads as armour from above, from the side and palm-up.
   *
   * Authored along +Z (up the forearm) from the wrist joint, X = breadth
   * (radius-ulna), Y = depth (+Y = back of the forearm).
   */
  private buildSleeve(): Object3D {
    const group = new Group();
    group.name = 'Sleeve';
    const f = this.sectionFn();
    const fit = this.baseFit;
    const s0 = fit.sleeveStart;
    const s1 = fit.sleeveEnd;
    const M = ARMFIT.skinMarginMeters;
    const T = ARMFIT.shellThicknessMeters;
    const O = M + T;

    // Outer shell: wrist face, along the arm, elbow flare, elbow face.
    const profile: Array<[number, number]> = [[s0, M], [s0, M]];
    profile.push([s0, O], [s0, O]);
    const steps = 9;
    for (let i = 1; i <= steps; i++) {
      const z = s0 + ((s1 - 0.012 - s0) * i) / steps;
      profile.push([z, O]);
    }
    profile.push([s1 - 0.006, O + 0.0018], [s1, O + 0.0032], [s1, O + 0.0032], [s1, M], [s1, M]);
    group.add(new Mesh(ellipticSurface(f, profile, 48), this.shellMat));

    // Liner: the inside wall (faces in at the arm), so looking down the
    // sleeve reads as padding rather than as the back of the shell.
    group.add(
      new Mesh(ellipticSurface(f, [[s0, M], [(s0 + s1) / 2, M], [s1, M]], 48, 0, Math.PI * 2, true), this.graphiteMat),
    );

    // Chrome bands proud of both ends.
    const band = (z0: number, z1: number, h: number): BufferGeometry =>
      ellipticSurface(
        f,
        [[z0, O], [z0, O], [z0 + 0.0012, O + h], [z0 + 0.0012, O + h], [z1 - 0.0012, O + h], [z1 - 0.0012, O + h], [z1, O], [z1, O]],
        48,
      );
    group.add(
      new Mesh(mergeGeometries([band(s0 + 0.0005, s0 + 0.0085, 0.0022), band(s1 - 0.017, s1 - 0.011, 0.0022)]), this.chromeMat),
    );

    // Trim bands near the elbow.
    group.add(
      new Mesh(
        mergeGeometries([sleeveRing(f, s1 - 0.026, O + 0.0004, 0.0013), sleeveRing(f, s1 - 0.0215, O + 0.0004, 0.0013)]),
        this.trimMat,
      ),
    );

    // Graphite: the top mount rail, a panel on each flank, one underneath.
    const panel = (mid: number, half: number, z0: number, z1: number, h: number): BufferGeometry =>
      ellipticSurface(
        f,
        [[z0, O], [z0, O], [z0, O + h], [z0, O + h], [z1, O + h], [z1, O + h], [z1, O], [z1, O]],
        10,
        (mid - half) * DEG_TO_RAD,
        2 * half * DEG_TO_RAD,
      );
    const midZ0 = s0 + 0.042;
    const midZ1 = s1 - 0.038;
    group.add(
      new Mesh(
        mergeGeometries([
          panel(90, 15, s0 + 0.012, s0 + 0.088, 0.0016),
          panel(0, 24, midZ0, midZ1, 0.0011),
          panel(180, 24, midZ0, midZ1, 0.0011),
          panel(270, 30, s0 + 0.03, s1 - 0.03, 0.0011),
        ]),
        this.graphiteMat,
      ),
    );

    // Neon seams: a ring near the wrist, L-cuts down each side of the top,
    // frames round the flank panels and the underside panel.
    const off = O + 0.0011;
    const seams: BufferGeometry[] = [sleeveRing(f, s0 + 0.0135, off, 0.001)];
    for (const sgn of [1, -1]) {
      const top = 90 - sgn * 22;
      seams.push(
        sleeveSeam(f, [[top, s0 + 0.016], [top, s0 + 0.075], [90 - sgn * 40, s0 + 0.095], [90 - sgn * 40, s1 - 0.034]], off),
      );
      const fl = sgn > 0 ? 0 : 180;
      seams.push(
        sleeveSeam(
          f,
          [[fl - 28, midZ0 - 0.004], [fl + 28, midZ0 - 0.004], [fl + 28, midZ1 + 0.004], [fl - 28, midZ1 + 0.004], [fl - 28, midZ0 - 0.004]],
          off,
        ),
      );
    }
    seams.push(
      sleeveSeam(
        f,
        [[236, s0 + 0.026], [304, s0 + 0.026], [304, s1 - 0.026], [236, s1 - 0.026], [236, s0 + 0.026]],
        off,
      ),
    );
    group.add(new Mesh(mergeGeometries(seams), this.accentMat));

    return group;
  }

  /**
   * The turret's fixed base: a chrome swivel puck on the pivot with a neon
   * ring, so the barrel visibly turns ON the arm rather than floating.
   */
  private buildTurretBase(): Object3D {
    const group = new Group();
    group.name = 'TurretBase';
    const puck = new CylinderGeometry(0.0125, 0.0145, 0.005, 24);
    puck.translate(0, 0.0015, 0);
    group.add(new Mesh(puck, this.chromeMat));
    const ring = new TorusGeometry(0.0128, 0.0011, 5, 28);
    ring.rotateX(Math.PI / 2);
    ring.translate(0, 0.0042, 0);
    group.add(new Mesh(ring, this.accentMat));
    return group;
  }

  /**
   * BLASTER hardware on the turret: a shell saddle, a transparent canister of
   * glowing paint (with a swirl inside), and a chunky graphite barrel with a
   * chrome muzzle collar and a neon bore ring. Authored in the round-8 aim
   * frame at the wrist joint, re-seated onto the turret ({@link LEGACY_ORIGIN})
   * with the group's origin at {@link PAINT_PIVOT}, so recoil tips the barrel
   * about the canister.
   */
  private buildPaintModule(hand: number): Object3D {
    const group = new Group();
    group.name = 'SplotBlaster';
    group.position.set(
      PAINT_PIVOT[0] - LEGACY_ORIGIN[0],
      PAINT_PIVOT[1] - LEGACY_ORIGIN[1],
      PAINT_PIVOT[2] - LEGACY_ORIGIN[2],
    );
    const px = -PAINT_PIVOT[0];
    const py = -PAINT_PIVOT[1];
    const pz = -PAINT_PIVOT[2];
    const place = (g: BufferGeometry, x: number, y: number, z: number) =>
      g.translate(x + px, y + py, z + pz);

    // Saddle: a flattened capsule riding the turret puck.
    const saddle = new CapsuleGeometry(0.016, 0.075, 6, 16);
    saddle.rotateX(Math.PI / 2);
    saddle.scale(1.35, 0.6, 1);
    place(saddle, 0, 0.04, 0.062);
    // Barrel shroud fairing: a shell cowl capping the barrel's rear half.
    const cowl = new CylinderGeometry(0.0148, 0.0148, 0.03, 18, 1, true, Math.PI / 2, Math.PI);
    cowl.rotateX(Math.PI / 2);
    place(cowl, 0, BARREL_Y, 0.042);
    group.add(new Mesh(mergeGeometries([saddle, cowl]), this.shellMat));

    // Barrel: graphite, stepped, from inside the canister cap to the collar.
    const barrel = new LatheGeometry(
      [
        new Vector2(0.0001, -0.002),
        new Vector2(0.0112, -0.002),
        new Vector2(0.0118, 0.004),
        new Vector2(0.0118, 0.03),
        new Vector2(0.0128, 0.034),
        new Vector2(0.0128, 0.066),
        new Vector2(0.0001, 0.066),
      ],
      20,
    );
    barrel.rotateX(Math.PI / 2);
    place(barrel, 0, BARREL_Y, 0);
    group.add(new Mesh(barrel, this.graphiteMat));

    // Chrome: muzzle collar and the canister's end caps.
    const collar = new CylinderGeometry(0.0138, 0.0142, 0.012, 22);
    collar.rotateX(Math.PI / 2);
    place(collar, 0, BARREL_Y, -0.008);
    const capA = new CylinderGeometry(0.0222, 0.0222, 0.007, 26);
    capA.rotateX(Math.PI / 2);
    place(capA, 0, BARREL_Y, 0.0605);
    const capB = new CylinderGeometry(0.0222, 0.0204, 0.009, 26);
    capB.rotateX(Math.PI / 2);
    place(capB, 0, BARREL_Y, 0.1255);
    const knob = new SphereGeometry(0.0095, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    knob.rotateX(Math.PI / 2);
    place(knob, 0, BARREL_Y, 0.1298);
    group.add(new Mesh(mergeGeometries([collar, capA, capB, knob]), this.chromeMat));

    // Trim stripe on the barrel.
    const stripe = new TorusGeometry(0.0121, 0.0012, 6, 24);
    place(stripe, 0, BARREL_Y, 0.018);
    group.add(new Mesh(stripe, this.trimMat));

    // Neon: bore ring at the muzzle, glow rims at both ends of the glass.
    const bore = new TorusGeometry(0.0084, 0.0016, 6, 24);
    place(bore, 0, BARREL_Y, -0.0142);
    const rimA = new TorusGeometry(0.0199, 0.0016, 6, 32);
    place(rimA, 0, BARREL_Y, 0.0655);
    const rimB = new TorusGeometry(0.0199, 0.0016, 6, 32);
    place(rimB, 0, BARREL_Y, 0.1205);
    group.add(new Mesh(mergeGeometries([bore, rimA, rimB]), this.accentMat));

    // The dark bore itself, facing down the barrel.
    const hole = new CircleGeometry(0.0078, 18);
    hole.rotateY(Math.PI);
    place(hole, 0, BARREL_Y, -0.0141);
    group.add(new Mesh(hole, this.boreMat));

    // Canister: swirl inside liquid inside glass.
    const swirlGeo = mergeGeometries([helixTube(0.0112, 0.05, 2.2, 0), helixTube(0.0112, 0.05, 2.2, Math.PI)]);
    const swirl = new Mesh(swirlGeo, this.swirlMat);
    swirl.position.set(px, BARREL_Y + py, 0.093 + pz);
    swirl.renderOrder = 1;
    group.add(swirl);
    this.swirls[hand] = swirl;

    const liquidGeo = new CylinderGeometry(0.0176, 0.0176, 0.054, 24);
    liquidGeo.rotateX(Math.PI / 2);
    // Fill from the back of the canister: anchor the geometry's rear at z=0.
    liquidGeo.translate(0, 0, -0.027);
    const liquid = new Mesh(liquidGeo, this.liquidMat);
    liquid.position.set(px, BARREL_Y + py, 0.12 + pz);
    liquid.renderOrder = 2;
    group.add(liquid);
    this.liquids[hand] = liquid;

    const glassGeo = new CylinderGeometry(0.0197, 0.0197, 0.058, 28, 1, true);
    glassGeo.rotateX(Math.PI / 2);
    place(glassGeo, 0, BARREL_Y, 0.093);
    const glass = new Mesh(glassGeo, this.glassMat);
    glass.renderOrder = 3;
    group.add(glass);

    // Muzzle flash: an additive bloom just past the bore, scaled by recoil.
    const flash = new Mesh(new SphereGeometry(0.014, 12, 8), this.flashMat);
    flash.position.set(px, BARREL_Y + py, -0.024 + pz);
    flash.visible = false;
    flash.renderOrder = 4;
    group.add(flash);
    this.flashes[hand] = flash;

    return group;
  }

  /**
   * GOO hardware on the turret (round 10 — it used to hide under the wrist):
   * a squat, caged glass TANK of glowing goo in the loaded paint colour (a
   * different silhouette from the BLASTER's long canister), blobs tumbling
   * inside, and a flared goo nozzle out front ringed by a big STATE LIGHT —
   * coral-white for SPLAT, cyan for TETHER — plus a lamp on the tank's nose.
   * In the launcher's own frame (centre at WEB.shooterOffset*, axis = aim);
   * the nozzle tip is WEB.muzzleLocal.
   */
  private buildGooLauncher(hand: number): Object3D {
    const group = new Group();
    group.name = 'GooLauncherModel';
    const tipZ = WEB.muzzleLocal[2];
    const baseY = -WEB.shooterOffsetY; // the turret pivot, in this frame

    // Saddle on the turret puck (shell).
    const saddle = new CapsuleGeometry(0.0165, 0.06, 6, 16);
    saddle.rotateX(Math.PI / 2);
    saddle.scale(1.4, 0.62, 1);
    saddle.translate(0, baseY + 0.0115, 0.022);
    // Nozzle cowl over the rear of the nozzle.
    const cowl = new CylinderGeometry(0.0155, 0.0155, 0.026, 18, 1, true, Math.PI / 2, Math.PI);
    cowl.rotateX(Math.PI / 2);
    cowl.translate(0, 0, -0.009);
    group.add(new Mesh(mergeGeometries([saddle, cowl]), this.shellMat));

    // The goo: a fat blob in the paint colour, with tumbling bright blobs.
    const tankZ = 0.036;
    const gooGeo = new CapsuleGeometry(0.0185, 0.022, 8, 22);
    gooGeo.rotateX(Math.PI / 2);
    const goo = new Mesh(gooGeo, this.liquidMat);
    goo.position.set(0, 0.0015, tankZ);
    goo.renderOrder = 2;
    group.add(goo);
    const blobs = new Group();
    blobs.position.set(0, 0.0015, tankZ);
    const blobGeo = mergeGeometries([
      new SphereGeometry(0.0062, 10, 8).translate(0.008, 0.004, -0.008),
      new SphereGeometry(0.0048, 10, 8).translate(-0.007, -0.006, 0.004),
      new SphereGeometry(0.0055, 10, 8).translate(0.002, 0.009, 0.012),
    ]);
    const blobMesh = new Mesh(blobGeo, this.swirlMat);
    blobMesh.renderOrder = 1;
    blobs.add(blobMesh);
    group.add(blobs);
    this.gooSwirls[hand] = blobs;

    // Glass tank round it.
    const tankGeo = new CapsuleGeometry(0.0222, 0.024, 10, 28);
    tankGeo.rotateX(Math.PI / 2);
    tankGeo.translate(0, 0.0015, tankZ);
    const tank = new Mesh(tankGeo, this.glassMat);
    tank.renderOrder = 3;
    group.add(tank);

    // Chrome cage: four ribs over the tank and a ring at each end, plus the
    // nose cap the nozzle screws into.
    const cage: BufferGeometry[] = [];
    for (let i = 0; i < 4; i++) {
      const ang = Math.PI / 4 + (i * Math.PI) / 2;
      const rib = new CylinderGeometry(0.0016, 0.0016, 0.05, 6);
      rib.rotateX(Math.PI / 2);
      rib.translate(Math.cos(ang) * 0.0232, 0.0015 + Math.sin(ang) * 0.0232, tankZ);
      cage.push(rib);
    }
    for (const z of [tankZ - 0.022, tankZ + 0.022]) {
      const ring = new TorusGeometry(0.0232, 0.0022, 6, 30);
      ring.translate(0, 0.0015, z);
      cage.push(ring);
    }
    const nose = new CylinderGeometry(0.0168, 0.0188, 0.009, 26);
    nose.rotateX(Math.PI / 2);
    nose.translate(0, 0, 0.0075);
    cage.push(nose);
    const tipCollar = new CylinderGeometry(0.0118, 0.0112, 0.006, 22);
    tipCollar.rotateX(Math.PI / 2);
    tipCollar.translate(0, 0, tipZ + 0.006);
    cage.push(tipCollar);
    group.add(new Mesh(mergeGeometries(cage), this.chromeMat));

    // Nozzle: graphite, tapering then flaring like a goo gun's horn.
    const nozzle = new LatheGeometry(
      [
        new Vector2(0.0001, 0.004),
        new Vector2(0.0125, 0.004),
        new Vector2(0.0118, 0.0),
        new Vector2(0.0082, tipZ * -0.55),
        new Vector2(0.0078, -tipZ - 0.012),
        new Vector2(0.0102, -tipZ - 0.003),
        new Vector2(0.0098, -tipZ),
        new Vector2(0.0001, -tipZ),
      ],
      22,
    );
    // Lathe runs along +Y; turn it to run along -Z (tip forward).
    nozzle.rotateX(-Math.PI / 2);
    group.add(new Mesh(nozzle, this.graphiteMat));

    // The goo bore at the tip.
    const hole = new CircleGeometry(0.0068, 18);
    hole.rotateY(Math.PI);
    hole.translate(0, 0, tipZ - 0.0002);
    group.add(new Mesh(hole, this.boreMat));

    // STATE LIGHT, all one material recoloured on SPLAT/TETHER: a big halo
    // and a glowing cap on the tank's BACK (the face the player sees over
    // their own forearm), a stripe along the tank's top, a lamp on the nose,
    // a ring round the nozzle root and one at the tip.
    const tankBack = tankZ + 0.0345;
    const halo = new TorusGeometry(0.0205, 0.0042, 8, 32);
    halo.translate(0, 0.0015, tankBack - 0.002);
    const cap = new CircleGeometry(0.0168, 24);
    cap.translate(0, 0.0015, tankBack);
    const stripe = new CapsuleGeometry(0.0024, 0.034, 3, 8);
    stripe.rotateX(Math.PI / 2);
    stripe.translate(0, 0.0015 + 0.0236, tankZ);
    const lamp = new SphereGeometry(0.0082, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    lamp.translate(0, 0.0165, 0.0045);
    const stateRing = new TorusGeometry(0.0168, 0.0034, 8, 30);
    stateRing.translate(0, 0, -0.0035);
    const tipRing = new TorusGeometry(0.0104, 0.0019, 6, 24);
    tipRing.translate(0, 0, tipZ + 0.0015);
    group.add(
      new Mesh(mergeGeometries([halo, cap, stripe, lamp, stateRing, tipRing]), this.webGlowMat),
    );
    // Back plate behind the cap, so the glow reads against shell, not the arm.
    const backPlate = new CylinderGeometry(0.0228, 0.0228, 0.004, 28);
    backPlate.rotateX(Math.PI / 2);
    backPlate.translate(0, 0.0015, tankBack - 0.0032);
    group.add(new Mesh(backPlate, this.chromeMat));

    // Skin accent: neon seams along the saddle flanks.
    const seams: BufferGeometry[] = [];
    for (const s of [1, -1]) {
      const seam = new CylinderGeometry(0.001, 0.001, 0.05, 4);
      seam.rotateX(Math.PI / 2);
      seam.translate(s * 0.0225, baseY + 0.012, 0.022);
      seams.push(seam);
    }
    group.add(new Mesh(mergeGeometries(seams), this.accentMat));

    return group;
  }

  /**
   * Optional modelled spinneret (`WEB.shooterUseGlb`), measured and rescaled
   * with {@link fitShooterScale}. Same contract as round 7: author it long
   * axis = model -Z, nozzle at -Z, back of hand +Y; WEB.shooterYaw/Pitch/Roll
   * correct an exporter's axes.
   */
  private buildSpinneretModel(): Object3D | undefined {
    let source: Object3D | undefined;
    try {
      source = AssetManager.getGLTF(WEB_SHOOTER_ASSET_KEY)?.scene;
    } catch {
      return undefined;
    }
    if (!source) return undefined;
    const model = source.clone(true);
    const box = new Box3().setFromObject(model);
    const size = box.getSize(new Vector3());
    const centre = box.getCenter(new Vector3());
    const fit = createShooterFit();
    fitShooterScale(size.x, size.y, size.z, WEB.shooterBandMeters, WEB.shooterLengthMeters, fit);
    model.scale.setScalar(fit.scale);
    model.position.set(-centre.x * fit.scale, -centre.y * fit.scale, -centre.z * fit.scale);
    const mount = new Group();
    mount.rotation.set(
      WEB.shooterPitchDeg * DEG_TO_RAD,
      WEB.shooterYawDeg * DEG_TO_RAD,
      WEB.shooterRollDeg * DEG_TO_RAD,
      'ZXY',
    );
    mount.add(model);
    return mount;
  }

  /**
   * The menu-gem MOUNT (left arm, round 10): a chrome bezel socket, built
   * along +Y (the parent turns +Y onto the sleeve's outward normal at the
   * gem). WristMenuSystem seats its summon gem in it.
   */
  private buildGem(): Object3D {
    const group = new Group();
    group.name = 'MenuGem';
    const r = ARMFIT.gemRadiusMeters;
    const bezel = new CylinderGeometry(r * 1.25, r * 1.4, r * 0.55, 20);
    bezel.translate(0, r * 0.1, 0);
    group.add(new Mesh(bezel, this.chromeMat));
    // Socket only: WristMenuSystem draws the glowing gem itself and seats it
    // here (menuGemInto + the normal x MENU.gemRadius). A dark recess and a
    // glow ring mark the mount even before the menu's gem pops in.
    const recess = new CircleGeometry(r * 1.05, 20);
    recess.rotateX(-Math.PI / 2);
    recess.translate(0, r * 0.38, 0);
    group.add(new Mesh(recess, this.boreMat));
    const ring = new TorusGeometry(r * 1.1, r * 0.12, 5, 24);
    ring.rotateX(Math.PI / 2);
    ring.translate(0, r * 0.4, 0);
    group.add(new Mesh(ring, this.gemMat));
    return group;
  }

  /**
   * A slim chrome band at the gem's ring of the forearm: what carries the gem
   * in HAND mode, when the sleeve is stowed. Default-fit geometry, scaled like
   * the sleeve.
   */
  private buildGemBand(): Object3D {
    const f = this.sectionFn();
    const z = this.baseFit.sleeveStart + ARMFIT.gemBackMeters;
    const O = ARMFIT.skinMarginMeters + ARMFIT.shellThicknessMeters;
    const geo = ellipticSurface(
      f,
      [[z - 0.006, O - 0.003], [z - 0.006, O - 0.003], [z - 0.006, O], [z - 0.006, O], [z + 0.006, O], [z + 0.006, O], [z + 0.006, O - 0.003], [z + 0.006, O - 0.003]],
      40,
    );
    const band = new Mesh(geo, this.graphiteMat);
    band.name = 'MenuGemBand';
    band.visible = false;
    return band;
  }

  /**
   * The back-of-hand plate, in the wrist-joint frame (+Y out of the back of
   * the hand, -Z toward the knuckles), centred on the plate: a domed shell
   * over a neon edge layer that peeks out round its rim, a graphite centre
   * panel, a chrome knuckle bar and a hinge pin at the wrist end. Returned
   * inside its hinge group, whose X rotation folds it up off the hand. The
   * parent `PlateFit` group scales it to the measured palm.
   */
  private buildPlate(): Object3D {
    const hinge = new Group();
    hinge.name = 'PlateHinge';
    hinge.position.set(0, 0, PLATE_HINGE_Z);
    const z0 = -PLATE_HINGE_Z;

    const shell = new CapsuleGeometry(0.021, 0.032, 6, 18);
    shell.rotateX(Math.PI / 2);
    shell.scale(1.5, 0.34, 1);
    shell.translate(0, 0, z0);
    hinge.add(new Mesh(shell, this.shellMat));

    const edge = new CapsuleGeometry(0.021, 0.032, 4, 18);
    edge.rotateX(Math.PI / 2);
    edge.scale(1.58, 0.2, 1.07);
    edge.translate(0, -0.0016, z0);
    hinge.add(new Mesh(edge, this.accentMat));

    const inset = new CapsuleGeometry(0.021, 0.018, 4, 16);
    inset.rotateX(Math.PI / 2);
    inset.scale(0.95, 0.21, 0.82);
    inset.translate(0, 0.0047, z0 + 0.002);
    hinge.add(new Mesh(inset, this.graphiteMat));

    const knuckle = new CapsuleGeometry(0.0052, 0.046, 4, 12);
    knuckle.rotateZ(Math.PI / 2);
    knuckle.translate(0, 0.0015, z0 - 0.039);
    const pin = new CylinderGeometry(0.0038, 0.0038, 0.03, 12);
    pin.rotateZ(Math.PI / 2);
    pin.translate(0, 0, 0.001);
    hinge.add(new Mesh(mergeGeometries([knuckle, pin]), this.chromeMat));

    const stripe = new CapsuleGeometry(0.0016, 0.03, 3, 8);
    stripe.rotateX(Math.PI / 2);
    stripe.translate(0, 0.0072, z0 + 0.004);
    hinge.add(new Mesh(stripe, this.trimMat));

    return hinge;
  }
}

/** Plate scale for controllers: the default fit's plate. */
const PLATE_MODEL_SCALE_X =
  (ARMFIT.plateWidthPerPalmWidth * ARMFIT.defaultPalmWidthMeters) / PLATE_MODEL_WIDTH;
const PLATE_MODEL_SCALE_Z =
  (ARMFIT.plateLengthPerHandLength * ARMFIT.defaultHandLengthMeters) / PLATE_MODEL_LENGTH;

// ---- Shared construction helpers --------------------------------------------

/** What {@link fitShooterScale} worked out. Caller-owned, so nothing allocates. */
export interface ShooterFit {
  /** Uniform scale to apply to the model. */
  scale: number;
  /** Axis the band's hole runs along: 0 = x, 1 = y, 2 = z. */
  bandAxis: number;
  /** Diameter, in model units, that `scale` was fitted against. */
  bandSpan: number;
  /** True when the length cap bound the result instead of the band target. */
  cappedByLength: boolean;
}

/** A zero-filled ShooterFit to hand to {@link fitShooterScale}. */
export function createShooterFit(): ShooterFit {
  return { scale: 1, bandAxis: 0, bandSpan: 0, cappedByLength: false };
}

/**
 * How much to shrink a wrist-worn model, by finding its band (round 4/5).
 *
 * A wrist is a fixed size, so what decides whether a cuff looks right is the
 * diameter of its band. A ring's bounding box has two roughly equal large
 * extents (the plane it lies in) and one smaller one (the hole): take the pair
 * of axes closest in ratio as the band. `lengthMeters` caps the result for art
 * that is long and thin, in which case `cappedByLength` is set.
 *
 * Pure apart from writing `out`. Moved here from WebShooterSystem in round 8
 * (still re-exported there).
 */
export function fitShooterScale(
  sizeX: number,
  sizeY: number,
  sizeZ: number,
  bandMeters: number,
  lengthMeters: number,
  out: ShooterFit,
): void {
  const sx = Math.abs(sizeX) || 0;
  const sy = Math.abs(sizeY) || 0;
  const sz = Math.abs(sizeZ) || 0;
  const longest = Math.max(sx, sy, sz);

  if (longest <= 0) {
    out.scale = 1;
    out.bandAxis = 0;
    out.bandSpan = 0;
    out.cappedByLength = false;
    return;
  }

  const ratio = (a: number, b: number) => {
    const hi = Math.max(a, b);
    return hi > 0 ? Math.min(a, b) / hi : 0;
  };
  const yz = ratio(sy, sz);
  const xz = ratio(sx, sz);
  const xy = ratio(sx, sy);

  let bandAxis: number;
  let bandSpan: number;
  if (yz >= xz && yz >= xy) {
    bandAxis = 0;
    bandSpan = Math.max(sy, sz);
  } else if (xz >= xy) {
    bandAxis = 1;
    bandSpan = Math.max(sx, sz);
  } else {
    bandAxis = 2;
    bandSpan = Math.max(sx, sy);
  }

  const bandScale = bandSpan > 0 ? bandMeters / bandSpan : lengthMeters / longest;
  const lengthScale = lengthMeters / longest;
  const capped = bandScale > lengthScale;

  out.scale = capped ? lengthScale : bandScale;
  out.bandAxis = bandAxis;
  out.bandSpan = bandSpan;
  out.cappedByLength = capped;
}

/** Cross-section of the sleeve's arm at z, grown by `off`. Build time only. */
type SectionFn = (z: number, off: number, out: SemiAxes) => SemiAxes;

/**
 * An elliptical surface of revolution round +Z: one ring of `radialSegs`
 * per profile point (z, offset), each ring the arm's section at z grown by
 * the offset. Repeat a profile point for a hard edge. Outward-facing unless
 * `inward`. `thetaLen < 2 pi` makes an open patch (angles from +X toward +Y).
 * Build time only.
 */
function ellipticSurface(
  section: SectionFn,
  profile: ReadonlyArray<readonly [number, number]>,
  radialSegs: number,
  theta0 = 0,
  thetaLen = Math.PI * 2,
  inward = false,
): BufferGeometry {
  const rings = profile.length;
  const cols = radialSegs + 1;
  const position = new Float32Array(rings * cols * 3);
  const uv = new Float32Array(rings * cols * 2);
  const s: SemiAxes = { a: 0, b: 0 };
  for (let i = 0; i < rings; i++) {
    const [z, off] = profile[i];
    section(z, off, s);
    for (let j = 0; j < cols; j++) {
      const t = theta0 + (thetaLen * j) / radialSegs;
      const k = i * cols + j;
      position[k * 3] = s.a * Math.cos(t);
      position[k * 3 + 1] = s.b * Math.sin(t);
      position[k * 3 + 2] = z;
      uv[k * 2] = j / radialSegs;
      uv[k * 2 + 1] = rings > 1 ? i / (rings - 1) : 0;
    }
  }
  const index: number[] = [];
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < radialSegs; j++) {
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      if (inward) index.push(a, c, b, b, c, d);
      else index.push(a, b, c, b, d, c);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(position, 3));
  geo.setAttribute('uv', new BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  // A closed ring has a seam column at j = 0 and j = radialSegs: average it.
  if (Math.abs(thetaLen - Math.PI * 2) < 1e-6) {
    const n = geo.attributes.normal as BufferAttribute;
    for (let i = 0; i < rings; i++) {
      const a = i * cols;
      const b = a + radialSegs;
      let x = n.getX(a) + n.getX(b);
      let y = n.getY(a) + n.getY(b);
      let z = n.getZ(a) + n.getZ(b);
      const l = Math.sqrt(x * x + y * y + z * z) || 1;
      x /= l;
      y /= l;
      z /= l;
      n.setXYZ(a, x, y, z);
      n.setXYZ(b, x, y, z);
    }
  }
  return geo;
}

/**
 * A glowing seam laid on the sleeve's surface (grown by `off`), through
 * waypoints [angle in degrees from +X toward +Y, z]. Build time only.
 */
function sleeveSeam(
  section: SectionFn,
  waypoints: ReadonlyArray<readonly [number, number]>,
  off: number,
): BufferGeometry {
  const points: Vector3[] = [];
  const s: SemiAxes = { a: 0, b: 0 };
  const at = (deg: number, z: number) => {
    section(z, off, s);
    const t = deg * DEG_TO_RAD;
    return new Vector3(s.a * Math.cos(t), s.b * Math.sin(t), z);
  };
  for (let i = 0; i < waypoints.length - 1; i++) {
    const [a0, z0] = waypoints[i];
    const [a1, z1] = waypoints[i + 1];
    const steps = 6;
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      points.push(at(a0 + (a1 - a0) * t, z0 + (z1 - z0) * t));
    }
  }
  const [aEnd, zEnd] = waypoints[waypoints.length - 1];
  points.push(at(aEnd, zEnd));
  const curve = new CatmullRomCurve3(points, false, 'catmullrom', 0.05);
  return new TubeGeometry(curve, points.length * 3, 0.00105, 5, false);
}

/** A closed tube ring round the sleeve at z (surface grown by `off`). Build time only. */
function sleeveRing(section: SectionFn, z: number, off: number, tube: number): BufferGeometry {
  const s: SemiAxes = { a: 0, b: 0 };
  section(z, off, s);
  const points: Vector3[] = [];
  const n = 40;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    points.push(new Vector3(s.a * Math.cos(t), s.b * Math.sin(t), z));
  }
  return new TubeGeometry(new CatmullRomCurve3(points, true), n * 2, tube, 5, true);
}

/**
 * A helical tube round +Z, centred on the origin: `turns` turns over `length`
 * metres at `radius`, starting at angle `phase`. Build time only.
 */
function helixTube(radius: number, length: number, turns: number, phase: number): BufferGeometry {
  const points: Vector3[] = [];
  const steps = Math.ceil(turns * 16);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = phase + t * turns * Math.PI * 2;
    points.push(new Vector3(radius * Math.cos(a), radius * Math.sin(a), (t - 0.5) * length));
  }
  return new TubeGeometry(new CatmullRomCurve3(points), steps * 2, 0.0024, 6, false);
}

/**
 * Merge indexed geometries that share position / normal / uv into one, so a
 * module costs one draw call per material. Build time only.
 */
function mergeGeometries(list: BufferGeometry[]): BufferGeometry {
  let vertexCount = 0;
  let indexCount = 0;
  for (const g of list) {
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const index = new Uint32Array(indexCount);
  let v = 0;
  let i = 0;
  for (const g of list) {
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    const tex = g.attributes.uv;
    for (let k = 0; k < pos.count; k++) {
      position[(v + k) * 3] = pos.getX(k);
      position[(v + k) * 3 + 1] = pos.getY(k);
      position[(v + k) * 3 + 2] = pos.getZ(k);
      if (nor) {
        normal[(v + k) * 3] = nor.getX(k);
        normal[(v + k) * 3 + 1] = nor.getY(k);
        normal[(v + k) * 3 + 2] = nor.getZ(k);
      }
      if (tex) {
        uv[(v + k) * 2] = tex.getX(k);
        uv[(v + k) * 2 + 1] = tex.getY(k);
      }
    }
    if (g.index) {
      for (let k = 0; k < g.index.count; k++) index[i + k] = g.index.getX(k) + v;
      i += g.index.count;
    } else {
      for (let k = 0; k < pos.count; k++) index[i + k] = v + k;
      i += pos.count;
    }
    v += pos.count;
    g.dispose();
  }
  const merged = new BufferGeometry();
  merged.setAttribute('position', new BufferAttribute(position, 3));
  merged.setAttribute('normal', new BufferAttribute(normal, 3));
  merged.setAttribute('uv', new BufferAttribute(uv, 2));
  merged.setIndex(new BufferAttribute(index, 1));
  return merged;
}
