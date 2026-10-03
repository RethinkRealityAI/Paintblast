import {
  AssetManager,
  Box3,
  BoxGeometry,
  DepthOccludable,
  DepthSensingSystem,
  Group,
  Mesh,
  MeshBasicMaterial,
  PhysicsBody,
  PhysicsManipulation,
  Quaternion,
  Raycaster,
  SRGBColorSpace,
  Vector3,
  XRMesh,
  XRPlane,
  createComponent,
  createSystem,
  Types,
} from '@iwsdk/core';
import type {
  Entity,
  Intersection,
  Material,
  MeshStandardMaterial,
  Object3D,
} from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import { BALLS, GAME, RENDER, ROOM, NEATNIKS, TARGETS, WEB } from '../config';
import type { NeatnikArchetypeConfig, NeatnikWave } from '../config';
import {
  AimTargets,
  BallKind,
  BallStyle,
  GameEvent,
  GameEventBuffer,
  GamePhase,
  Neatnik,
  WebSubMode,
  packImpactData,
  packPopData,
  packTetherData,
} from '../types';
import { Ball, BallFlightState } from './BallSpawnSystem';
import { PauseClock } from './GameStateSystem';

/** AssetManifest key main.ts registers public/gltf/robot/robot.gltf under. */
export const ROBOT_ASSET_KEY = 'robot';

const DEG_TO_RAD = Math.PI / 180;
const TAU = Math.PI * 2;

/** Lifecycle of one pool slot. Stored per slot in a plain Int8Array. */
export const TargetSlotState = {
  /** Hidden and idle — free for the spawn director to use. */
  Empty: 0,
  /** Visible, animating, and (when its archetype allows) hit-tested. */
  Active: 1,
  /** Squashing, spinning and shrinking away after its last hit. */
  Popping: 2,
  /** Hidden, cooling down for TARGETS.respawnDelaySec before it is Empty. */
  Respawning: 3,
} as const;

export type TargetSlotState =
  typeof TargetSlotState[keyof typeof TargetSlotState];

/**
 * Marks a pooled robot. Carries no motion state — that lives in TargetSystem's
 * parallel arrays — but exposes hp, slot and archetype so `ecs_find_entities`
 * / `ecs_query_entity` can inspect a live round from the MCP tools.
 */
export const Target = createComponent('Target', {
  hp: { type: Types.Int16, default: TARGETS.baseHp },
  slot: { type: Types.Int16, default: -1 },
  /**
   * Hand holding a tether on this robot: 0 left, 1 right, -1 free.
   *
   * Mirrored out of the parallel arrays for the same reason hp is — so a live
   * tether can be seen from `ecs_query_entity` while debugging on device, where
   * there is no console to print to.
   */
  tetheredBy: { type: Types.Int8, default: -1 },
  /** Round 8: which Neatnik this slot is built as (see {@link Neatnik}). */
  archetype: { type: Types.Int8, default: Neatnik.Mopsy },
});

// ---------------------------------------------------------------------------
// Archetype table
// ---------------------------------------------------------------------------

/** Config per {@link Neatnik}, in enum order. */
const ARCHETYPE_CONFIGS: ReadonlyArray<NeatnikArchetypeConfig> = [
  NEATNIKS.archetypes.mopsy,
  NEATNIKS.archetypes.squeegee,
  NEATNIKS.archetypes.peekaboo,
  NEATNIKS.archetypes.duke,
];

/** The tuning for one archetype; unknown values read as Mopsy. */
export function archetypeConfig(archetype: number): NeatnikArchetypeConfig {
  return ARCHETYPE_CONFIGS[archetype] ?? ARCHETYPE_CONFIGS[Neatnik.Mopsy];
}

/** Pool slots per archetype, in enum order. Sum = TARGETS.poolSize. */
export function archetypePoolCounts(): number[] {
  return ARCHETYPE_CONFIGS.map((cfg) => cfg.pool);
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests). All allocation free.
// ---------------------------------------------------------------------------

/**
 * How far along the line one reel step brings a tethered robot.
 *
 * Pure and exported so the clamp is unit-tested without a robot: `metres` is
 * never allowed to drag the robot past the hand (which would sail it out
 * behind the player, where the head-relative kill test would still not have
 * fired), and a robot already inside `minDistance` is left exactly where it is
 * rather than being shoved back out to the minimum.
 *
 * @param current Present distance from the robot to the reel target, metres.
 * @param metres  How much line to take in this step. Negatives are ignored.
 * @param minDistance Closest the robot may end up to the target.
 * @returns the new distance, always in `[min(current, minDistance), current]`.
 */
export function reelDistance(
  current: number,
  metres: number,
  minDistance: number,
): number {
  if (!(current > 0)) return current;
  const next = current - Math.max(0, metres);
  return next < minDistance ? Math.min(current, minDistance) : next;
}

/**
 * Squared distance from point P to the segment A-B.
 *
 * The robot hit test is **swept** since round 7: a ball is tested along the
 * whole path it covered this frame (A = where it was, B = where it is), not
 * just at B. A web leaves the wrist at ~12 m/s — 17 cm per frame at 72 Hz, a
 * quarter of a metre on a 48 Hz hitch frame — and a point test against a
 * ~30 cm robot let grazing shots step clean through it.
 */
export function segmentPointDistSq(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  px: number,
  py: number,
  pz: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const lenSq = abx * abx + aby * aby + abz * abz;
  let t = lenSq > 1e-12 ? (apx * abx + apy * aby + apz * abz) / lenSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  const dz = apz - abz * t;
  return dx * dx + dy * dy + dz * dz;
}

/** Longest stretch, metres, a single frame's swept hit test will look back over. */
const MAX_SWEEP_METRES = 2;

/** The subset of TARGETS that ringSpawnPosition needs. @see ringSpawnPosition */
export interface RingSpawnConfig {
  readonly ringMinR: number;
  readonly ringMaxR: number;
  readonly heightMin: number;
  readonly heightMax: number;
  readonly spawnAngleJitter: number;
}

/**
 * Pick one robot spawn point on the ring around the player — or, since the
 * seated-play pass, on an arc of that ring in front of them.
 *
 * `outVec3` receives x/z as an **offset from the player**, and y as an
 * absolute height above the floor (the reference space is `local-floor`).
 * Angles are in this function's own convention: a direction at angle `a` is
 * `(cos a, 0, sin a)`, so -Z (straight ahead at the origin) is -pi/2.
 * {@link flatHeadingAngle} turns a head pose into one of these.
 *
 * **Full ring** (`arcDeg >= 360`): `count` evenly spaced slices plus up to
 * ±½ slice × spawnAngleJitter of wander; `arcCenterRad` is ignored.
 *
 * **Arc** (`arcDeg < 360`): the arc `arcCenterRad ± arcDeg/2` is cut into
 * `count` equal lanes and `index` stands at the middle of lane
 * `index mod count`, plus jitter clamped to stay inside its lane. Round 8
 * passes a *lane* (see {@link pickLane}) as `index`, not a pool slot.
 */
export function ringSpawnPosition(
  index: number,
  count: number,
  rand0: number,
  rand1: number,
  rand2: number,
  cfg: RingSpawnConfig,
  outVec3: Float32Array,
  arcCenterRad = 0,
  arcDeg = 360,
): void {
  let angle: number;
  // Written as a negated `<` so a NaN arc falls back to the full ring.
  if (!(arcDeg < 360)) {
    const slice = (Math.PI * 2) / Math.max(1, count);
    angle = index * slice + (rand0 - 0.5) * slice * cfg.spawnAngleJitter;
  } else {
    const lanes = Math.max(1, count);
    const arc = Math.max(0, arcDeg) * DEG_TO_RAD;
    const slice = arc / lanes;
    const lane = ((index % lanes) + lanes) % lanes;
    const jitter = Math.min(1, Math.max(0, cfg.spawnAngleJitter));
    angle =
      arcCenterRad -
      arc / 2 +
      (lane + 0.5) * slice +
      (rand0 - 0.5) * slice * jitter;
  }
  const radius = cfg.ringMinR + rand1 * (cfg.ringMaxR - cfg.ringMinR);

  outVec3[0] = Math.cos(angle) * radius;
  outVec3[1] = cfg.heightMin + rand2 * (cfg.heightMax - cfg.heightMin);
  outVec3[2] = Math.sin(angle) * radius;
}

/** Straight ahead (-Z) in {@link ringSpawnPosition}'s angle convention. */
export const FORWARD_HEADING_RAD = -Math.PI / 2;

/**
 * Which way a head is facing across the floor, as a ring angle
 * (`(cos a, 0, sin a)`, see {@link ringSpawnPosition}).
 *
 * The up vector is blended in by how far the head is pitched, so a round
 * started while looking down at the wrist palette still faces forward:
 * `forward - forward.y * up` is that blend, and at level pitch it is plain
 * forward.
 *
 * @returns the heading angle, or `fallbackRad` for a degenerate pose.
 */
export function flatHeadingAngle(
  forwardX: number,
  forwardY: number,
  forwardZ: number,
  upX: number,
  upZ: number,
  fallbackRad: number = FORWARD_HEADING_RAD,
): number {
  const x = forwardX - forwardY * upX;
  const z = forwardZ - forwardY * upZ;
  if (!(x * x + z * z > 1e-8)) return fallbackRad;
  return Math.atan2(z, x);
}

/**
 * Push every set timestamp in `stamps` forward by `bySec`, in place.
 *
 * TargetSystem keeps its deadlines as absolute performance.now() seconds; on
 * resume every deadline moves on by exactly the time spent paused. Entries
 * `<= 0` are "not set" and left alone.
 */
export function shiftTimestamps(stamps: Float64Array, bySec: number): void {
  if (!(bySec > 0)) return;
  for (let i = 0; i < stamps.length; i++) {
    if (stamps[i] > 0) stamps[i] += bySec;
  }
}

/**
 * Re-phase a `sin(now * omega + phase)` oscillator so it carries on from
 * where it froze instead of jumping by `pausedSec` worth of cycles. Wrapped
 * into [0, 2pi).
 */
export function rewindPhase(
  phase: number,
  pausedSec: number,
  omega: number,
): number {
  const next = (phase - pausedSec * omega) % TAU;
  return next < 0 ? next + TAU : next;
}

/**
 * Fit a spawn distance to the real room: pull a candidate in front of the
 * nearest real surface, or reject the direction (-1) when that would put the
 * robot closer than `minDist`.
 */
export function clampSpawnDistance(
  candidateDist: number,
  wallDist: number,
  margin: number,
  minDist: number,
): number {
  if (!Number.isFinite(wallDist) || wallDist <= 0) return candidateDist;
  if (wallDist >= candidateDist) return candidateDist;
  const pulled = wallDist - margin;
  return pulled >= minDist ? pulled : -1;
}

// ---- Waves and the boss ----------------------------------------------------

/**
 * Which wave of `waves` is running `elapsedSec` into the round: the last one
 * whose `startSec` has passed. Waves are assumed sorted by start; anything
 * before the first wave (or an empty table) is wave 0.
 */
export function waveIndexAt(
  elapsedSec: number,
  waves: ReadonlyArray<NeatnikWave>,
): number {
  let index = 0;
  for (let i = 0; i < waves.length; i++) {
    if (elapsedSec >= waves[i].startSec) index = i;
  }
  return index;
}

/**
 * Round 9: is `elapsedSec` inside the rest beat that opens a wave? Every
 * wave after the first starts with `breatherSec` of no new spawns, so the
 * player's arms get a moment between waves. Waves are assumed sorted.
 */
export function inWaveBreather(
  elapsedSec: number,
  waves: ReadonlyArray<NeatnikWave>,
  breatherSec: number,
): boolean {
  if (!(breatherSec > 0)) return false;
  for (let i = 1; i < waves.length; i++) {
    const start = waves[i].startSec;
    if (elapsedSec >= start && elapsedSec < start + breatherSec) return true;
  }
  return false;
}

/**
 * Weighted pick: index `i` with probability `weights[i] / sum`, from one
 * uniform 0..1 draw. Negative and NaN weights count as 0; an all-zero table
 * picks 0 (Mopsy), so a mistuned wave still spawns something.
 */
export function pickWeighted(weights: ArrayLike<number>, rand: number): number {
  let total = 0;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i];
    if (w > 0) total += w;
  }
  if (!(total > 0)) return 0;
  let r = Math.min(Math.max(rand, 0), 0.999999999) * total;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i];
    if (!(w > 0)) continue;
    if (r < w) return i;
    r -= w;
  }
  return weights.length - 1;
}

/**
 * Should the boss enter now? Once per round, when the clock has run down to
 * `enterAtSecLeft`, and never on the final zero (the round is over) or when
 * the boss is disabled (`enterAtSecLeft <= 0`).
 */
export function bossDue(
  timeLeftSec: number,
  enterAtSecLeft: number,
  alreadySpawned: boolean,
): boolean {
  return (
    !alreadySpawned &&
    enterAtSecLeft > 0 &&
    timeLeftSec > 0 &&
    timeLeftSec <= enterAtSecLeft
  );
}

/**
 * The emptiest of `lanes` lanes, given how many live robots stand in each.
 * Ties are broken by starting the scan at a random lane, so equal lanes are
 * picked evenly rather than always left-first.
 */
export function pickLane(
  occupancy: ArrayLike<number>,
  lanes: number,
  rand: number,
): number {
  const n = Math.max(1, Math.floor(lanes));
  const start = Math.min(n - 1, Math.floor(Math.max(0, rand) * n));
  let best = start;
  let bestCount = occupancy[start] ?? 0;
  for (let k = 1; k < n; k++) {
    const lane = (start + k) % n;
    const count = occupancy[lane] ?? 0;
    if (count < bestCount) {
      best = lane;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Where the boss's two Mopsys appear when he pops: either side of him,
 * across the player's line of sight (so both stay in view), `spread` apart.
 * Writes [x0, z0, x1, z1] into `out`.
 */
export function splitPositions(
  cx: number,
  cz: number,
  headX: number,
  headZ: number,
  spread: number,
  out: Float32Array,
): void {
  let dx = cx - headX;
  let dz = cz - headZ;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len > 1e-6) {
    dx /= len;
    dz /= len;
  } else {
    dx = 0;
    dz = -1;
  }
  // Perpendicular on the floor: (dz, -dx).
  const half = spread / 2;
  out[0] = cx + dz * half;
  out[1] = cz - dx * half;
  out[2] = cx - dz * half;
  out[3] = cz + dx * half;
}

// ---- Squeegee's shield -----------------------------------------------------

/**
 * Does a ball travelling with velocity (vx, *, vz) hit the shield of a robot
 * facing (fwdX, fwdZ)? True when the ball arrives from inside the shield's
 * front cone (`coneDeg` wide, centred on the facing). Only the floor-plane
 * part of the velocity counts: a ball dropping straight down on the robot's
 * head comes from no side at all and is never blocked.
 */
export function shieldBlocks(
  fwdX: number,
  fwdZ: number,
  vx: number,
  vz: number,
  coneDeg: number,
): boolean {
  const speed = Math.sqrt(vx * vx + vz * vz);
  const fwdLen = Math.sqrt(fwdX * fwdX + fwdZ * fwdZ);
  if (!(speed > 1e-4) || !(fwdLen > 1e-6)) return false;
  // The ball comes FROM the front when it travels against the facing.
  const cosToward = -(vx * fwdX + vz * fwdZ) / (speed * fwdLen);
  const half = Math.min(180, Math.max(0, coneDeg)) * 0.5 * DEG_TO_RAD;
  return cosToward >= Math.cos(half);
}

/**
 * The three ways past a shield (art bible: "needs a Bouncy shot off a wall or
 * a tether"): a ball that has already bounced, a tether web, or SPLASH ammo,
 * whose burst wraps round the blade.
 */
export function shieldBypassed(
  bounceCount: number,
  kind: number,
  isTetherWeb: boolean,
): boolean {
  return bounceCount > 0 || isTetherWeb || kind === BallKind.Splash;
}

/**
 * The velocity a deflected ball leaves the shield with: reflected about the
 * shield's (horizontal) facing, scaled by `restitution`, plus an upward
 * `lift` so the ping visibly arcs away. Writes xyz into `out`.
 *
 * A ball already moving away from the face (it clipped the shield's edge from
 * behind the plane) is not mirrored back into it — it just loses speed.
 */
export function deflectVelocity(
  vx: number,
  vy: number,
  vz: number,
  nx: number,
  nz: number,
  restitution: number,
  lift: number,
  out: Float32Array,
): void {
  const nLen = Math.sqrt(nx * nx + nz * nz);
  const ux = nLen > 1e-6 ? nx / nLen : 0;
  const uz = nLen > 1e-6 ? nz / nLen : 0;
  const dot = vx * ux + vz * uz;
  let rx = vx;
  let rz = vz;
  if (dot < 0) {
    rx = vx - 2 * dot * ux;
    rz = vz - 2 * dot * uz;
  }
  out[0] = rx * restitution;
  out[1] = vy * restitution + lift;
  out[2] = rz * restitution;
}

// ---- Peekaboo --------------------------------------------------------------

/**
 * How far up a Peekaboo is, 0 (hidden) .. 1 (peeking), `tSec` into its
 * cycle: hidden for `hiddenSec`, rises over `riseSec` (ease-out, a quick
 * pop up), holds for `upSec`, ducks over `riseSec` (ease-in), repeat.
 */
export function peekLift(
  tSec: number,
  hiddenSec: number,
  riseSec: number,
  upSec: number,
): number {
  const hidden = Math.max(0, hiddenSec);
  const rise = Math.max(1e-3, riseSec);
  const up = Math.max(0, upSec);
  const period = hidden + rise + up + rise;
  let t = tSec % period;
  if (t < 0) t += period;
  if (t < hidden) return 0;
  t -= hidden;
  if (t < rise) return easeOutCubic(t / rise);
  t -= rise;
  if (t < up) return 1;
  t -= up;
  return 1 - easeInCubic(Math.min(1, t / rise));
}

/** Can a Peekaboo at this lift be hit? */
export function peekHittable(lift: number, threshold: number): boolean {
  return lift >= threshold;
}

/**
 * A hiding spot behind a piece of furniture, seen from the head: the point
 * `margin` beyond the far face of its floor-plane bounding box, along the
 * line from the head through the box centre. Writes [x, z] into `out` and
 * returns the horizontal distance from the head to it.
 */
export function hideSpotBehind(
  headX: number,
  headZ: number,
  cx: number,
  cz: number,
  halfX: number,
  halfZ: number,
  margin: number,
  out: Float32Array,
): number {
  let dx = cx - headX;
  let dz = cz - headZ;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len > 1e-6) {
    dx /= len;
    dz /= len;
  } else {
    dx = 0;
    dz = -1;
  }
  // Ray-box exit distance from the centre along (dx, dz).
  const tx = Math.abs(dx) > 1e-6 ? Math.abs(halfX / dx) : Infinity;
  const tz = Math.abs(dz) > 1e-6 ? Math.abs(halfZ / dz) : Infinity;
  const exit = Math.min(tx, tz);
  const t = (Number.isFinite(exit) ? exit : 0) + margin;
  out[0] = cx + dx * t;
  out[1] = cz + dz * t;
  return len + t;
}

/**
 * Round 9: push a floor-plane point straight out from the head until it is
 * at least `minDist` away. Writes [x, z] into `out`; returns true when it had
 * to move. A point exactly on the head goes out along `fallbackHeading`
 * (radians, three's atan2(z, x) convention).
 */
export function pushOutToRadius(
  px: number,
  pz: number,
  headX: number,
  headZ: number,
  minDist: number,
  fallbackHeading: number,
  out: Float32Array,
): boolean {
  let dx = px - headX;
  let dz = pz - headZ;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len >= minDist) {
    out[0] = px;
    out[1] = pz;
    return false;
  }
  if (len > 1e-6) {
    dx /= len;
    dz /= len;
  } else {
    dx = Math.cos(fallbackHeading);
    dz = Math.sin(fallbackHeading);
  }
  out[0] = headX + dx * minDist;
  out[1] = headZ + dz * minDist;
  return true;
}

/**
 * Round 9: where a popped Duster Duke's two Mopsys split around. Normally
 * where he died; but a tether haul pops him within the kill radius — right
 * at the player's face — so inside `minDist` of the head they burst out of
 * his home (landing) spot instead. Writes [x, z] into `out`; returns true
 * when it used home.
 */
export function splitCentre(
  dukeX: number,
  dukeZ: number,
  homeX: number,
  homeZ: number,
  headX: number,
  headZ: number,
  minDist: number,
  out: Float32Array,
): boolean {
  const dx = dukeX - headX;
  const dz = dukeZ - headZ;
  if (dx * dx + dz * dz >= minDist * minDist) {
    out[0] = dukeX;
    out[1] = dukeZ;
    return false;
  }
  out[0] = homeX;
  out[1] = homeZ;
  return true;
}

/**
 * Round 9: is (x, z) within `minSpacing` of any of the first `count` points
 * packed [x0, z0, x1, z1, ...] in `points`? Used to keep Peekaboos from
 * stacking on one hiding spot.
 */
export function crowded2D(
  x: number,
  z: number,
  points: ArrayLike<number>,
  count: number,
  minSpacing: number,
): boolean {
  const limitSq = minSpacing * minSpacing;
  for (let i = 0; i < count; i++) {
    const dx = points[i * 2] - x;
    const dz = points[i * 2 + 1] - z;
    if (dx * dx + dz * dz < limitSq) return true;
  }
  return false;
}

// ---- Facing and easing -----------------------------------------------------

/**
 * Yaw (rotation about +Y) that turns a robot's local +Z toward a target on
 * the floor plane. three's rotation.y = a maps +Z to (sin a, 0, cos a).
 */
export function faceYaw(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
): number {
  return Math.atan2(toX - fromX, toZ - fromZ);
}

/** Wrap an angle into (-pi, pi]. */
export function wrapAngle(a: number): number {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r <= -Math.PI) r += TAU;
  return r;
}

/**
 * Ease a yaw toward a target the short way round: exponential smoothing at
 * `rate` per second, framerate independent. `rate <= 0` never turns.
 */
export function stepYawToward(
  current: number,
  target: number,
  rate: number,
  dtSec: number,
): number {
  if (!(rate > 0) || !(dtSec > 0)) return current;
  const diff = wrapAngle(target - current);
  const k = 1 - Math.exp(-rate * dtSec);
  return wrapAngle(current + diff * k);
}

export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function easeOutCubic(t: number): number {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

export function easeInCubic(t: number): number {
  const u = clamp01(t);
  return u * u * u;
}

export function easeInOutSine(t: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));
}

/**
 * Ease-out with overshoot (Penner's back): runs 0 → past 1 → settles at 1.
 * `s` is the overshoot (1.70158 is the classic ~10%).
 */
export function easeOutBack(t: number, s: number): number {
  const u = clamp01(t) - 1;
  return 1 + u * u * ((s + 1) * u + s);
}

/**
 * Vertical scale of a squash-and-stretch that rings out over `durSec`:
 * squashes by `amp` at t = 0 then wobbles (`hz`) back to exactly 1 with a
 * quadratic envelope. Pair with `1 / sqrt(sy)` sideways to keep volume.
 */
export function squashWobble(
  tSec: number,
  durSec: number,
  amp: number,
  hz: number,
): number {
  if (!(tSec >= 0) || !(durSec > 0) || tSec >= durSec) return 1;
  const env = 1 - tSec / durSec;
  return 1 - amp * env * env * Math.cos(TAU * hz * tSec);
}

/**
 * Pose of a popping robot at progress `p` (0..1): a squash for the first
 * `squashFrac` of the animation, then a spinning, stretching shrink to
 * nothing. Writes [scaleY, scaleXZ, spinRad] into `out`.
 */
export function popPose(
  p: number,
  squashFrac: number,
  spinTurns: number,
  out: Float32Array,
): void {
  const t = clamp01(p);
  const sf = Math.min(0.95, Math.max(0, squashFrac));
  if (t < sf) {
    const u = sf > 0 ? t / sf : 1;
    const squash = 1 - 0.45 * Math.sin((Math.PI / 2) * u);
    out[0] = squash;
    out[1] = 1 / Math.sqrt(squash);
    out[2] = 0;
    return;
  }
  const q = sf < 1 ? (t - sf) / (1 - sf) : 1;
  const k = 1 - q * q;
  out[0] = k * (0.55 + 0.9 * q);
  out[1] = k * 1.35 * (1 - 0.5 * q);
  out[2] = spinTurns * TAU * easeInCubic(q);
}

/**
 * Height above its landing spot of a boss `tSec` into a `dropSec` entrance
 * drop from `dropHeight`: falls accelerating (quadratic, like gravity) and
 * reads 0 from the moment it lands.
 */
export function dropOffset(
  tSec: number,
  dropSec: number,
  dropHeight: number,
): number {
  if (!(dropSec > 0) || tSec >= dropSec) return 0;
  const u = clamp01(tSec / dropSec);
  return dropHeight * (1 - u * u);
}

// ---- Round 10: pacing director ----------------------------------------------

/** The knobs the spawn director's pacing reads. @see directorCap */
export interface DirectorTuning {
  /** Seconds after a pop before a refill (NEATNIKS.refillDelaySec). */
  readonly refillDelaySec: number;
  /** Seconds between two spawns (NEATNIKS.spawnStaggerSec). */
  readonly spawnStaggerSec: number;
  /** Seconds after the last bot pops before the next is due (NEATNIKS.emptyRefillSec). */
  readonly emptyRefillSec: number;
  /** NEATNIKS.waveBreatherSec. */
  readonly waveBreatherSec: number;
  /** NEATNIKS.breatherKeepAlive. */
  readonly breatherKeepAlive: number;
  /** TARGETS.maxConcurrent. */
  readonly maxConcurrent: number;
  /** NEATNIKS.boss.enterAtSecLeft. */
  readonly bossEnterAtSecLeft: number;
  /** NEATNIKS.boss.companionsMax. */
  readonly bossCompanionsMax: number;
}

/** The shipped tuning, gathered from config for the system and the tests. */
export const DIRECTOR_TUNING: DirectorTuning = {
  refillDelaySec: NEATNIKS.refillDelaySec,
  spawnStaggerSec: NEATNIKS.spawnStaggerSec,
  emptyRefillSec: NEATNIKS.emptyRefillSec,
  waveBreatherSec: NEATNIKS.waveBreatherSec,
  breatherKeepAlive: NEATNIKS.breatherKeepAlive,
  maxConcurrent: TARGETS.maxConcurrent,
  bossEnterAtSecLeft: NEATNIKS.boss.enterAtSecLeft,
  bossCompanionsMax: NEATNIKS.boss.companionsMax,
};

/**
 * Round 10: how many robots the director keeps up right now.
 *
 * - Boss phase (`timeLeft <= bossEnterAtSecLeft`): the boss's companions
 *   plus the Duke himself, so small bots keep spawning while he is up.
 * - Otherwise the running wave's `maxAlive` - but inside a wave's opening
 *   breather only `breatherKeepAlive` (a thinned arena, never an empty one;
 *   round 9's breather stopped spawns outright for 3 s).
 *
 * Always capped by `maxConcurrent`.
 */
export function directorCap(
  elapsedSec: number,
  timeLeftSec: number,
  waves: ReadonlyArray<NeatnikWave>,
  dukeAlive: number,
  t: DirectorTuning,
): number {
  const inBoss = t.bossEnterAtSecLeft > 0 && timeLeftSec <= t.bossEnterAtSecLeft;
  let cap: number;
  if (inBoss) {
    cap = t.bossCompanionsMax + dukeAlive;
  } else {
    const wave = waves[waveIndexAt(elapsedSec, waves)];
    cap = wave ? wave.maxAlive : 0;
    if (inWaveBreather(elapsedSec, waves, t.waveBreatherSec)) {
      cap = Math.min(cap, Math.max(1, t.breatherKeepAlive));
    }
  }
  return Math.max(0, Math.min(cap, t.maxConcurrent));
}

/**
 * Round 10: may the director spawn this frame?
 *
 * Below the cap, a spawn waits for `nextSpawnAt` (the stagger after the last
 * spawn, pushed out by `refillDelaySec` after each pop). An EMPTY arena
 * ignores that and only waits `emptyRefillSec` after the last pop, which is
 * what bounds the dead time with zero bots on screen.
 */
export function directorReady(
  nowSec: number,
  alive: number,
  cap: number,
  nextSpawnAt: number,
  lastPopAt: number,
  emptyRefillSec: number,
): boolean {
  if (alive >= cap) return false;
  if (alive <= 0) return nowSec >= lastPopAt + Math.max(0, emptyRefillSec);
  return nowSec >= nextSpawnAt;
}

// ---- Round 10: Duster Duke's patrol -----------------------------------------

/**
 * Angular offsets (radians, relative to the arc centre) of `count` patrol
 * points spread evenly across `arcDeg`. One point stands in the middle;
 * none stands outside +/- arcDeg/2. Writes into `out`, returns the count used.
 */
export function patrolOffsets(
  count: number,
  arcDeg: number,
  out: Float32Array,
): number {
  const n = Math.max(1, Math.min(out.length, Math.floor(count)));
  const half = (Math.max(0, Math.min(360, arcDeg)) * DEG_TO_RAD) / 2;
  if (n === 1) {
    out[0] = 0;
    return 1;
  }
  for (let i = 0; i < n; i++) out[i] = -half + (2 * half * i) / (n - 1);
  return n;
}

/**
 * Weight (0..1) of the HUD keep-clear radius at an angular offset from the
 * arc centre: 1 inside +/- `avoidRad`, fading linearly to 0 over a further
 * `avoidRad / 2`.
 */
export function hudBandWeight(offsetRad: number, avoidRad: number): number {
  if (!(avoidRad > 0)) return 0;
  const a = Math.abs(offsetRad);
  if (a <= avoidRad) return 1;
  const blend = avoidRad * 0.5;
  return a >= avoidRad + blend ? 0 : 1 - (a - avoidRad) / blend;
}

/**
 * One point along a patrol leg, in polar coordinates around the player:
 * angle and radius ease (in-out sine) from (a0, r0) to (a1, r1), and inside
 * the HUD band ({@link hudBandWeight}) the radius bulges out toward
 * `clearR`, so a Duke strafing past the middle walks behind the docked HUD
 * strip rather than through it. Polar (not a straight chord) so a leg never
 * cuts in closer than its endpoints. Writes [angle, radius] into `out`.
 */
export function patrolPathPoint(
  a0: number,
  r0: number,
  a1: number,
  r1: number,
  u: number,
  avoidRad: number,
  clearR: number,
  out: Float32Array,
): void {
  const k = easeInOutSine(u);
  const a = a0 + (a1 - a0) * k;
  let r = r0 + (r1 - r0) * k;
  const w = hudBandWeight(a, avoidRad);
  if (w > 0 && clearR > r) r += (clearR - r) * w;
  out[0] = a;
  out[1] = r;
}

/** Rough length of a patrol leg, metres (arc + radial change). */
export function patrolLegLength(
  a0: number,
  r0: number,
  a1: number,
  r1: number,
): number {
  return Math.abs(a1 - a0) * Math.max(r0, r1) + Math.abs(r1 - r0);
}

/** A different patrol point from `current`, uniform over the rest. */
export function nextPatrolIndex(
  current: number,
  count: number,
  rand: number,
): number {
  const n = Math.floor(count);
  if (n <= 1) return 0;
  const pick = Math.min(n - 2, Math.floor(clamp01(rand) * (n - 1)));
  return pick >= current ? pick + 1 : pick;
}

// ---- Round 10: HP pips --------------------------------------------------------

/** What one HP pip shows. */
export const PipLook = { Off: 0, On: 1, Flash: 2 } as const;
export type PipLook = typeof PipLook[keyof typeof PipLook];

/**
 * Look of pip `index` in a row whose bot has `remaining` of its points left.
 * Lit pips flash while `flashing`; so does the pip just lost (index ==
 * remaining), so the hit reads as a pip blinking out.
 */
export function pipLook(
  index: number,
  remaining: number,
  flashing: boolean,
): PipLook {
  if (index < remaining) return flashing ? PipLook.Flash : PipLook.On;
  if (flashing && index === remaining) return PipLook.Flash;
  return PipLook.Off;
}

/** Centre x of pip `index` in a row of `count`, centred on 0. */
export function pipX(
  index: number,
  count: number,
  width: number,
  gap: number,
): number {
  return (index - (count - 1) / 2) * (width + gap);
}

/**
 * Round 10: one blocked frontal shot against a shield with `shieldHp` left.
 * @returns the shield HP after the block (never below 0). A shield already at
 *   0 does not block at all - see {@link shieldStillUp}.
 */
export function chipShield(shieldHp: number): number {
  return shieldHp > 0 ? shieldHp - 1 : 0;
}

/** Does a Squeegee with `shieldHp` left still have a shield to block with? */
export function shieldStillUp(shieldHp: number): boolean {
  return shieldHp > 0;
}

/**
 * Round 10: a Mopsy's sideways strafe offset, metres, at `clockSec`: a slow
 * sine of `amplitude` at `hz` with the bot's own `phase`.
 */
export function strafeOffset(
  clockSec: number,
  phase: number,
  amplitude: number,
  hz: number,
): number {
  if (!(amplitude > 0) || !(hz > 0)) return 0;
  return Math.sin(clockSec * TAU * hz + phase) * amplitude;
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

/** How many deflected balls the shield remembers at once. */
const DEFLECT_CAPACITY = 8;
/** Furniture candidates examined per Peekaboo spawn. */
const MAX_HIDE_CANDIDATES = 12;
/** Round 10: most patrol points Duster Duke can use (NEATNIKS.boss.patrolPoints). */
const MAX_PATROL_POINTS = 6;
/** Round 10: archetypes the director falls back through when a pool is busy. */
const FALLBACK_ORDER: readonly number[] = [
  Neatnik.Mopsy,
  Neatnik.Squeegee,
  Neatnik.Peekaboo,
];

/** Round 10: does this archetype wear an HP pip bar? */
export function wearsHpBar(archetype: number): boolean {
  return archetype === Neatnik.Squeegee || archetypeConfig(archetype).hp > 1;
}

/**
 * Round 9: IWSDK's DepthSensingSystem, made safe to register on any runtime.
 * Registered by main.ts (behind RENDER.depthOcclusion) so the robots'
 * DepthOccludable tags actually occlude.
 *
 * Why a subclass: the stock system trusts `enabledFeatures`. IWER (the
 * emulator) grants `depth-sensing` but implements neither
 * `XRFrame.getDepthInformation` nor the GPU binding call, so the stock
 * update() threw every frame — and a throw inside a system's update aborts
 * the whole world update (no round, no robots). This checks the API the
 * session's depth path will call before handing over, and turns itself off
 * for good, with one warning, the first time depth is missing or throws.
 * The occlusion uniforms default to disabled, so a disabled system leaves
 * the robots plainly visible.
 */
export class RobotDepthSensingSystem extends DepthSensingSystem {
  private depthBroken = false;
  /** The session `depthBroken` was decided in; a new session tries again. */
  private brokenSession: unknown = null;

  update(): void {
    const frame = this.xrFrame as unknown as
      | {
          session?: { depthUsage?: string; enabledFeatures?: readonly string[] };
          getDepthInformation?: unknown;
        }
      | undefined;
    const session = frame?.session;
    if (this.depthBroken) {
      // One failure (or one depth-less session) must not switch occlusion
      // off for every later session on this page.
      if (!session || session === this.brokenSession) return;
      this.depthBroken = false;
    }
    if (session?.enabledFeatures?.includes('depth-sensing')) {
      let callable: boolean;
      if (session.depthUsage === 'gpu-optimized') {
        const binding = (
          this.renderer.xr as unknown as { getBinding?: () => unknown }
        ).getBinding?.() as { getDepthInformation?: unknown } | null | undefined;
        callable = typeof binding?.getDepthInformation === 'function';
      } else {
        callable = typeof frame?.getDepthInformation === 'function';
      }
      if (!callable) {
        this.disableDepth('this runtime grants depth-sensing but has no depth API');
        return;
      }
    }
    try {
      super.update();
    } catch (err) {
      this.disableDepth(String(err));
    }
  }

  private disableDepth(why: string): void {
    this.depthBroken = true;
    this.brokenSession =
      (this.xrFrame as unknown as { session?: unknown } | undefined)?.session ?? null;
    console.warn(`[Splotopia] depth occlusion off: ${why}`);
  }
}

/**
 * The Neatniks: a fixed pool of animated robot characters the player shoots
 * (round 8; rounds 1-7 had one generic robot).
 *
 * **Pool.** `TARGETS.poolSize` entities are built once, each permanently one
 * archetype (NEATNIKS.archetypes[*].pool of each), then shown, moved and
 * hidden as the round demands. Per-slot state lives in parallel TypedArrays
 * indexed by slot, so a frame of robot logic allocates nothing. Each slot's
 * object tree is `holder` (the entity: position, facing yaw) → `rig`
 * (procedural animation: tilt, squash, scale) → `yaw` (the art's
 * `yawOffsetDeg`) → `fit` (measured rescale + recentre) → the GLB clone.
 *
 * **Art.** Each archetype wears its Meshy GLB once it has streamed in, and
 * robot.gltf until then; {@link refreshArt} swaps at every Countdown, so a new
 * GLB at the configured URL never needs a code change. Every slot gets its own
 * clones of the art's materials, patched with the round-7 rim light plus a
 * per-slot emissive `pbFlash` uniform — one shader program for the whole cast,
 * per-robot hit flashes.
 *
 * **Spawning.** A director ({@link directSpawns}) keeps the current wave's
 * robot count up, picking archetypes by the wave's weights; robots take the
 * emptiest lane of the seated forward arc, room-clamped. Peekaboo prefers to
 * hide behind real furniture; Duster Duke drops in for the finale.
 *
 * Robots carry **no physics body**: hits are a swept sphere-overlap test
 * against every free-flying ball. Round handoff is via the `gamePhase`
 * signal, which makes it order-independent of GameStateSystem.
 */
export class TargetSystem extends createSystem({
  balls: { required: [Ball] },
  // Real-world geometry, used only at spawn time.
  planes: { required: [XRPlane] },
  meshes: { required: [XRMesh] },
}) {
  private events!: GameEventBuffer;
  private gamePhase!: Signal<GamePhase>;
  private targetsAlive!: Signal<number>;
  /** Bitmask of hands holding a line: bit 0 left, bit 1 right. */
  private tetheredHands!: Signal<number>;
  /** Round clock; read to pace the waves and the boss. Optional in tests. */
  private timeLeft?: Signal<number>;
  /** Live, hittable robot positions for BallSpawnSystem's aim assist. */
  private aimTargets?: AimTargets;

  /** The pool. Fixed length after ensurePool(); slots are reused forever. */
  private readonly slots: Entity[] = [];
  /** Per-slot animation groups, built once with the pool. */
  private readonly rigs: Object3D[] = [];
  private readonly yawGroups: Object3D[] = [];
  /** Asset key each slot's art currently comes from ('' = none yet). */
  private readonly slotArtKey: string[] = [];
  /** Per-slot cloned materials, so a swap can release them. */
  private readonly slotMaterials: Material[][] = [];
  /** Per-slot emissive flash uniform shared by that slot's materials. */
  private readonly slotFlash: { value: Vector3 }[] = [];

  // Per-slot state, all indexed by slot, all allocated once in init().
  private slotState!: Int8Array;
  private slotArchetype!: Int8Array;
  private slotLane!: Int8Array;
  private slotHp!: Int16Array;
  private slotRadius!: Float32Array;
  /** Hover centre height — for Peekaboo, the *peeking* height. */
  private slotBaseY!: Float32Array;
  private slotBobPhase!: Float32Array;
  /** Facing yaw (eased toward the player). */
  private slotYaw!: Float32Array;
  /** Peekaboo: metres between peeking and hidden centre heights. */
  private slotPeekDrop!: Float32Array;
  /** Peekaboo: this slot's hidden time per cycle (base + jitter). */
  private slotHiddenSec!: Float32Array;
  /** This frame's lift (Peekaboo) — 1 for everyone else. */
  private slotLift!: Float32Array;
  /** 1 when the slot may be hit this frame. */
  private slotHittable!: Uint8Array;
  /** Duster Duke's landing spot, xyz per slot. */
  private slotHome!: Float32Array;
  /** Where a returning Duke started back from, xyz per slot. */
  private slotReturnFrom!: Float32Array;

  // Absolute performance.now() seconds; 0 = unset. Shifted across pauses.
  private respawnAt!: Float64Array;
  private popStartedAt!: Float64Array;
  private hitFlashUntil!: Float64Array;
  private spawnStartedAt!: Float64Array;
  private hitStartedAt!: Float64Array;
  private peekStartedAt!: Float64Array;
  private entranceStartedAt!: Float64Array;
  private returnStartedAt!: Float64Array;
  private shieldFlashUntil!: Float64Array;
  /** [0] = the director's next allowed spawn. An array so it shifts too. */
  private nextSpawnAt!: Float64Array;
  /** Round 10: [0] = when the last robot popped (empty-arena refill clock). */
  private lastPopAt!: Float64Array;
  /** Round 10: HP pips (body row) flash until; shield row likewise. */
  private barFlashUntil!: Float64Array;
  private shieldBarFlashUntil!: Float64Array;

  // ---- Round 10: Squeegee shield HP, Mopsy strafe, Duke patrol ----
  /** Blocked shots the Squeegee's shield can still take (0 = shattered). */
  private slotShieldHp!: Int8Array;
  /** Unit floor-plane strafe direction (across the line of sight), xz per slot. */
  private slotStrafeDir!: Float32Array;
  /** Last frame's strafe offset; the strafe is applied as a delta. */
  private slotStrafePrev!: Float32Array;
  /** Patrol points per slot (Duke): count, current target index. */
  private patrolCount!: Int8Array;
  private patrolIdx!: Int8Array;
  /** Patrol point angle offsets (from the arc centre) and radii. */
  private patrolA!: Float32Array;
  private patrolR!: Float32Array;
  /** Current leg [a0, r0, a1, r1] per slot. */
  private patrolLeg!: Float32Array;
  /** Head xz the patrol is laid out around, per slot. */
  private patrolCentre!: Float32Array;
  /** Room-clamped HUD keep-clear radius, per slot. */
  private patrolClearR!: Float32Array;
  private patrolMoveDur!: Float32Array;
  /** Absolute seconds; shifted across pauses like every other deadline. */
  private patrolMoveStart!: Float64Array;
  private patrolPauseUntil!: Float64Array;
  private patrolScratch!: Float32Array;

  // ---- Round 10: HP pip bars (built with the pool, only for wearsHpBar) ----
  private readonly barObjects: (Object3D | null)[] = [];
  private readonly barShieldRows: (Object3D | null)[] = [];
  private readonly barBodyPips: Mesh[][] = [];
  private readonly barShieldPips: Mesh[][] = [];
  private pipGeometry: BoxGeometry | null = null;
  /** [body on, shield on, off, flash], shared by every bar. */
  private pipMaterials: MeshBasicMaterial[] = [];
  private headQuat!: Quaternion;

  /** Hand holding a tether on this slot: 0 left, 1 right, -1 free. */
  private slotTetherHand!: Int8Array;
  /** This frame's robot world positions, xyz per slot. */
  private slotWorldPos!: Float32Array;

  // Deflected balls the shield ignores for a moment (and whose prevVelocity
  // must be re-primed so BallFlightSystem does not read the bounce as a wall
  // impact). Identity is entity + generation (gotcha 3).
  private readonly deflectBall: (Entity | null)[] = [];
  private deflectGen!: Int32Array;
  private deflectSlot!: Int8Array;
  private deflectUntil!: Float64Array;
  private deflectVel!: Float32Array;
  private deflectPending!: Uint8Array;

  // Scratch — reused every frame, never reallocated.
  private measureBox!: Box3;
  private measureSize!: Vector3;
  private measureCenter!: Vector3;
  private spawnOffset!: Float32Array;
  private worldScratch!: Vector3;
  private ballScratch!: Vector3;
  private headScratch!: Vector3;
  private spawnDirection!: Vector3;
  private bestDirection!: Vector3;
  private tetherTarget!: Vector3;
  private laneOccupancy!: Int8Array;
  private poseScratch!: Float32Array;
  private pairScratch!: Float32Array;
  private hideCandidates!: Float32Array;
  /** Round 9: [x, z] of every other live Peekaboo, packed. */
  private peekOccupied!: Float32Array;
  /** Round 9: per slot, the walk home is a plain release drift (not a Duke). */
  private slotDriftHome!: Uint8Array;
  private spawnRay!: Raycaster;
  private rayHits!: Intersection[];

  private roundActive = false;
  private aliveCount = 0;
  private bossSpawned = false;
  /** Seconds of un-paused round time, for worlds without a timeLeft global. */
  private roundClock = 0;
  /** Seconds of un-paused animation time; drives the idle oscillators. */
  private animClock = 0;

  init() {
    this.events = this.globals.gameEvents as GameEventBuffer;
    this.gamePhase = this.globals.gamePhase as Signal<GamePhase>;
    this.targetsAlive = this.globals.targetsAlive as Signal<number>;
    this.tetheredHands = this.globals.tetheredHands as Signal<number>;
    this.timeLeft = this.globals.timeLeft as Signal<number> | undefined;
    this.aimTargets = this.globals.aimTargets as AimTargets | undefined;

    const size = TARGETS.poolSize;
    this.slotState = new Int8Array(size);
    this.slotArchetype = new Int8Array(size);
    this.slotLane = new Int8Array(size).fill(-1);
    this.slotHp = new Int16Array(size);
    this.slotRadius = new Float32Array(size);
    this.slotBaseY = new Float32Array(size);
    this.slotBobPhase = new Float32Array(size);
    this.slotYaw = new Float32Array(size);
    this.slotPeekDrop = new Float32Array(size);
    this.slotHiddenSec = new Float32Array(size);
    this.slotLift = new Float32Array(size).fill(1);
    this.slotHittable = new Uint8Array(size);
    this.slotHome = new Float32Array(size * 3);
    this.slotReturnFrom = new Float32Array(size * 3);
    this.respawnAt = new Float64Array(size);
    this.popStartedAt = new Float64Array(size);
    this.hitFlashUntil = new Float64Array(size);
    this.spawnStartedAt = new Float64Array(size);
    this.hitStartedAt = new Float64Array(size);
    this.peekStartedAt = new Float64Array(size);
    this.entranceStartedAt = new Float64Array(size);
    this.returnStartedAt = new Float64Array(size);
    this.shieldFlashUntil = new Float64Array(size);
    this.nextSpawnAt = new Float64Array(1);
    this.lastPopAt = new Float64Array(1);
    this.barFlashUntil = new Float64Array(size);
    this.shieldBarFlashUntil = new Float64Array(size);
    this.slotShieldHp = new Int8Array(size);
    this.slotStrafeDir = new Float32Array(size * 2);
    this.slotStrafePrev = new Float32Array(size);
    this.patrolCount = new Int8Array(size);
    this.patrolIdx = new Int8Array(size);
    this.patrolA = new Float32Array(size * MAX_PATROL_POINTS);
    this.patrolR = new Float32Array(size * MAX_PATROL_POINTS);
    this.patrolLeg = new Float32Array(size * 4);
    this.patrolCentre = new Float32Array(size * 2);
    this.patrolClearR = new Float32Array(size);
    this.patrolMoveDur = new Float32Array(size);
    this.patrolMoveStart = new Float64Array(size);
    this.patrolPauseUntil = new Float64Array(size);
    this.patrolScratch = new Float32Array(MAX_PATROL_POINTS);
    this.headQuat = new Quaternion();
    this.slotTetherHand = new Int8Array(size).fill(-1);
    this.slotWorldPos = new Float32Array(size * 3);

    // Archetype of every slot is fixed by the config, pool or no pool.
    let slot = 0;
    for (let a = 0; a < ARCHETYPE_CONFIGS.length; a++) {
      for (let i = 0; i < ARCHETYPE_CONFIGS[a].pool && slot < size; i++) {
        this.slotArchetype[slot++] = a;
      }
    }

    for (let i = 0; i < DEFLECT_CAPACITY; i++) this.deflectBall.push(null);
    this.deflectGen = new Int32Array(DEFLECT_CAPACITY);
    this.deflectSlot = new Int8Array(DEFLECT_CAPACITY);
    this.deflectUntil = new Float64Array(DEFLECT_CAPACITY);
    this.deflectVel = new Float32Array(DEFLECT_CAPACITY * 3);
    this.deflectPending = new Uint8Array(DEFLECT_CAPACITY);

    this.tetherTarget = new Vector3();
    this.measureBox = new Box3();
    this.measureSize = new Vector3();
    this.measureCenter = new Vector3();
    this.spawnOffset = new Float32Array(3);
    this.worldScratch = new Vector3();
    this.ballScratch = new Vector3();
    this.headScratch = new Vector3();
    this.spawnDirection = new Vector3();
    this.bestDirection = new Vector3();
    this.laneOccupancy = new Int8Array(Math.max(1, NEATNIKS.lanes));
    this.poseScratch = new Float32Array(3);
    this.pairScratch = new Float32Array(4);
    this.hideCandidates = new Float32Array(MAX_HIDE_CANDIDATES * 4);
    this.peekOccupied = new Float32Array(size * 2);
    this.slotDriftHome = new Uint8Array(size);
    this.spawnRay = new Raycaster();
    this.spawnRay.near = 0.05;
    this.spawnRay.far = ROOM.spawnRayMaxDist;
    this.rayHits = [];

    // Best effort now (robot.gltf is critical, so it is ready); retried on
    // the first round start if not.
    this.ensurePool();

    this.cleanupFuncs.push(
      this.gamePhase.subscribe((phase) => {
        if (phase === GamePhase.Countdown) {
          // The neatnik GLBs stream in the background; swap them in while
          // the countdown hides the (one-off) clone cost.
          if (this.ensurePool()) this.refreshArt();
        } else if (phase === GamePhase.Playing) {
          this.beginRound();
        } else if (this.roundActive) {
          this.endRound();
        }
      }),
    );
  }

  update(delta: number) {
    // Frozen while the session is out of focus; the frame that ends a freeze
    // is spent re-basing the clocks rather than animating. @see holdForPause
    if (this.holdForPause(delta)) return;
    if (!this.roundActive) return;

    this.animClock += delta;
    this.roundClock += delta;

    const nowSec = performance.now() / 1000;
    const bobOmega = TARGETS.bobHz * TAU;
    this.player.head.getWorldPosition(this.headScratch);

    for (let slot = 0; slot < this.slots.length; slot++) {
      switch (this.slotState[slot]) {
        case TargetSlotState.Active:
          this.animateActive(slot, nowSec, delta, bobOmega);
          break;
        case TargetSlotState.Popping:
          this.animatePop(slot, nowSec);
          break;
        case TargetSlotState.Respawning:
          if (nowSec >= this.respawnAt[slot]) {
            this.slotState[slot] = TargetSlotState.Empty;
            this.respawnAt[slot] = 0;
          }
          break;
        default:
          break;
      }
    }

    this.directSpawns(nowSec);
    this.testBallOverlaps(nowSec, delta);
    this.publishAimTargets();
    this.updateHpBars(nowSec);

    if (this.targetsAlive.peek() !== this.aliveCount) {
      this.targetsAlive.value = this.aliveCount;
    }
  }

  /**
   * Copy this frame's shootable robots into the shared {@link AimTargets}.
   * A popping, respawning, hidden (Peekaboo down) or still-dropping (Duke)
   * robot is not a target: assist must never bend a shot toward something
   * that cannot be hit.
   */
  private publishAimTargets(): void {
    const aim = this.aimTargets;
    if (!aim) return;
    const count = Math.min(aim.capacity, this.slots.length);
    for (let slot = 0; slot < count; slot++) {
      const live =
        this.slotState[slot] === TargetSlotState.Active &&
        this.slotHittable[slot] === 1;
      aim.active[slot] = live ? 1 : 0;
      if (!live) continue;
      const base = slot * 3;
      aim.positions[base] = this.slotWorldPos[base];
      aim.positions[base + 1] = this.slotWorldPos[base + 1];
      aim.positions[base + 2] = this.slotWorldPos[base + 2];
    }
  }

  // ---- Pause / resume ------------------------------------------------------
  //
  // GameStateSystem owns the decision (it mirrors the session's visibility
  // into the `paused` global); this file only has to honour it. While paused
  // nothing here runs, and on the way out every absolute deadline is moved on
  // by the time spent away, so the round resumes exactly where it stopped.
  // The idle oscillators run off `animClock`, which simply does not advance
  // while paused; only the shared hover bob reads the wall clock.

  private pausedSignal: Signal<boolean> | undefined;
  private readonly pauseClock = new PauseClock();

  /**
   * The top-of-update guard. @returns true when this frame must not animate:
   * either the game is paused, or this is the frame a pause (or a stall
   * longer than GAME.pauseGapSec) just ended, spent re-basing deadlines.
   */
  private holdForPause(delta: number): boolean {
    this.pausedSignal ??= this.globals.paused as Signal<boolean> | undefined;
    const paused = this.pausedSignal?.peek() === true;
    const frozenSec = this.pauseClock.sync(
      paused,
      performance.now() / 1000,
      delta,
    );
    if (paused) return true;
    if (!(frozenSec > 0)) return false;

    this.resumeFromPause(frozenSec);
    return true;
  }

  /** Carry every clock-based piece of robot state across a pause. */
  private resumeFromPause(pausedSec: number): void {
    shiftTimestamps(this.respawnAt, pausedSec);
    shiftTimestamps(this.popStartedAt, pausedSec);
    shiftTimestamps(this.hitFlashUntil, pausedSec);
    shiftTimestamps(this.spawnStartedAt, pausedSec);
    shiftTimestamps(this.hitStartedAt, pausedSec);
    shiftTimestamps(this.peekStartedAt, pausedSec);
    shiftTimestamps(this.entranceStartedAt, pausedSec);
    shiftTimestamps(this.returnStartedAt, pausedSec);
    shiftTimestamps(this.shieldFlashUntil, pausedSec);
    shiftTimestamps(this.nextSpawnAt, pausedSec);
    shiftTimestamps(this.deflectUntil, pausedSec);
    shiftTimestamps(this.lastPopAt, pausedSec);
    shiftTimestamps(this.barFlashUntil, pausedSec);
    shiftTimestamps(this.shieldBarFlashUntil, pausedSec);
    shiftTimestamps(this.patrolMoveStart, pausedSec);
    shiftTimestamps(this.patrolPauseUntil, pausedSec);

    const bobOmega = TARGETS.bobHz * TAU;
    for (let slot = 0; slot < this.slotBobPhase.length; slot++) {
      this.slotBobPhase[slot] = rewindPhase(
        this.slotBobPhase[slot],
        pausedSec,
        bobOmega,
      );
    }
  }

  /** Live robot count, for tests and MCP-driven smoke checks. */
  get debugAliveCount(): number {
    return this.aliveCount;
  }

  /**
   * Dev / harness hook: spawn one robot of `archetype` right now if a slot
   * is free (during a round). @returns its slot, or -1.
   */
  debugSpawn(archetype: number): number {
    if (!this.roundActive) return -1;
    this.player.head.getWorldPosition(this.headScratch);
    return this.spawnArchetype(archetype, performance.now() / 1000);
  }

  /**
   * Round 10 dev / harness hook: one frontal shot blocked by this Squeegee's
   * shield, through the same chip / shatter path a real ball takes (minus
   * the ball). @returns the shield HP left, or -1 when there is no shield.
   */
  debugShieldHit(slot: number): number {
    if (slot < 0 || slot >= this.slots.length) return -1;
    if (this.slotState[slot] !== TargetSlotState.Active) return -1;
    if (!shieldStillUp(this.slotShieldHp[slot])) return -1;
    const base = slot * 3;
    this.chipShieldAt(
      slot,
      this.slotWorldPos[base],
      this.slotWorldPos[base + 1],
      this.slotWorldPos[base + 2],
      performance.now() / 1000,
    );
    return this.slotShieldHp[slot];
  }

  /** Round 10 dev / harness hook: one ordinary hit on a live slot. */
  debugHit(slot: number): number {
    if (slot < 0 || slot >= this.slots.length) return -1;
    if (this.slotState[slot] !== TargetSlotState.Active) return -1;
    this.registerHit(slot, slot * 3, performance.now() / 1000);
    return this.slotHp[slot];
  }

  /** Round 10 dev / harness: a snapshot of one slot (allocates; never per frame). */
  debugSlot(slot: number): {
    state: number;
    archetype: number;
    hp: number;
    shieldHp: number;
    hittable: boolean;
    pos: number[];
    patrolIdx: number;
  } {
    const base = slot * 3;
    return {
      state: this.slotState[slot],
      archetype: this.slotArchetype[slot],
      hp: this.slotHp[slot],
      shieldHp: this.slotShieldHp[slot],
      hittable: this.slotHittable[slot] === 1,
      pos: [
        this.slotWorldPos[base],
        this.slotWorldPos[base + 1],
        this.slotWorldPos[base + 2],
      ],
      patrolIdx: this.patrolIdx[slot],
    };
  }

  // ---- The tether API ------------------------------------------------------
  //
  // A tether is a *lease* on one pool slot, and every fact about it lives
  // here. WebShooterSystem asks {@link tetherSlotForHand} every frame and
  // believes the answer, so "the round ended" and "the robot was shot by
  // someone else" resolve themselves without a message ever being sent.

  /** Is this slot currently on the end of somebody's line? */
  isTethered(slot: number): boolean {
    return this.tetherHandOf(slot) >= 0;
  }

  /** The slot this hand is reeling, or -1. */
  tetherSlotForHand(hand: number): number {
    for (let slot = 0; slot < this.slotTetherHand.length; slot++) {
      if (this.slotTetherHand[slot] === hand) return slot;
    }
    return -1;
  }

  /**
   * Latch a hand onto an active robot: its hover stops (it struggles
   * instead), it stays visible and shootable, and it will not respawn out
   * from under the line because it never popped. A hooked Peekaboo stays up.
   *
   * @returns false when the slot is not a live target, is already on a line,
   *   or that hand already has one — all "the shot missed", not errors.
   */
  beginTether(slot: number, hand: number): boolean {
    if (hand !== 0 && hand !== 1) return false;
    if (slot < 0 || slot >= this.slots.length) return false;
    if (this.slotState[slot] !== TargetSlotState.Active) return false;
    if (this.slotTetherHand[slot] >= 0) return false;
    if (this.tetherSlotForHand(hand) >= 0) return false;

    this.slotTetherHand[slot] = hand;
    this.slots[slot]?.setValue(Target, 'tetheredBy', hand);
    // A Duke being hauled is no longer walking home (nor is a drifting bot),
    // nor patrolling: his current leg's target stays his home to walk back to.
    this.returnStartedAt[slot] = 0;
    this.slotDriftHome[slot] = 0;
    this.patrolMoveStart[slot] = 0;
    this.publishTetheredHands();
    return true;
  }

  /**
   * Haul a tethered robot `metres` closer to `towardWorldPos`, clamped by
   * {@link reelDistance}. Robots are parented to the identity scene root, so
   * local position is world position.
   */
  reelTether(slot: number, towardWorldPos: Vector3, metres: number): void {
    if (!this.isTethered(slot)) return;
    const object3D = this.slots[slot]?.object3D;
    if (!object3D) return;

    object3D.getWorldPosition(this.tetherTarget);
    const dx = this.tetherTarget.x - towardWorldPos.x;
    const dy = this.tetherTarget.y - towardWorldPos.y;
    const dz = this.tetherTarget.z - towardWorldPos.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance < 1e-4) return;

    const pulled = reelDistance(distance, metres, TARGETS.tetherMinReach);
    if (pulled >= distance) return;

    const scale = pulled / distance;
    object3D.position.set(
      towardWorldPos.x + dx * scale,
      towardWorldPos.y + dy * scale,
      towardWorldPos.z + dz * scale,
    );
    // Keep the hover's anchor with it, so a line that breaks without a pop
    // leaves the robot about where it was left.
    this.slotBaseY[slot] = object3D.position.y;
  }

  /** Where the far end of the strand should be drawn. */
  tetherAnchorInto(slot: number, out: Vector3): boolean {
    if (!this.isTethered(slot)) return false;
    const object3D = this.slots[slot]?.object3D;
    if (!object3D) return false;
    object3D.getWorldPosition(out);
    return true;
  }

  /**
   * Let go. `pop` true runs the ordinary kill — pop animation, TargetPopped
   * (score, combo, cue) — through the one code path every kill takes. False
   * hands the robot back its idle.
   *
   * Round 8: Duster Duke is too big to haul in and pop. A "pop" haul takes
   * `NEATNIKS.boss.tetherDamage` HP off him and he stomps back to his spot;
   * only a haul that finishes him pops (and splits) him.
   */
  endTether(slot: number, pop: boolean): void {
    if (!this.isTethered(slot)) return;
    const hand = this.slotTetherHand[slot];
    this.clearTether(slot);

    const base = slot * 3;
    const object3D = this.slots[slot]?.object3D;
    if (object3D) {
      object3D.getWorldPosition(this.worldScratch);
      this.slotWorldPos[base] = this.worldScratch.x;
      this.slotWorldPos[base + 1] = this.worldScratch.y;
      this.slotWorldPos[base + 2] = this.worldScratch.z;
    }
    const nowSec = performance.now() / 1000;
    const arch = this.slotArchetype[slot];

    if (!pop) {
      if (arch === Neatnik.Peekaboo) this.restartPeekAtTop(slot, nowSec);
      // A boss let off the line stomps back to his spot rather than idling
      // wherever he was dropped (possibly in the player's lap).
      if (arch === Neatnik.DusterDuke) {
        this.startWalkHome(slot, base, nowSec);
      } else {
        // Round 9: everyone else drifts back out to a comfortable distance
        // instead of hovering 0.8 m from the player's face.
        this.startReleaseDrift(slot, base, nowSec);
      }
      return;
    }

    if (
      arch === Neatnik.DusterDuke &&
      this.slotHp[slot] > NEATNIKS.boss.tetherDamage
    ) {
      const hp = this.slotHp[slot] - NEATNIKS.boss.tetherDamage;
      this.slotHp[slot] = hp;
      this.slots[slot]?.setValue(Target, 'hp', hp);
      this.hitStartedAt[slot] = nowSec;
      this.hitFlashUntil[slot] = nowSec + TARGETS.hitFlashSec * 2;
      this.barFlashUntil[slot] = nowSec + NEATNIKS.hpBar.flashSec * 2;
      this.events.emit(
        GameEvent.TargetHit,
        this.slotWorldPos[base],
        this.slotWorldPos[base + 1],
        this.slotWorldPos[base + 2],
        hp,
      );
      // Stomp back to his patrol (the point his last leg was heading for).
      this.startWalkHome(slot, base, nowSec);
      return;
    }

    this.popSlot(slot, base, nowSec);
    // Rides alongside TargetPopped so the rumble can be the harder one a
    // hand-hauled kill has earned.
    this.events.emit(
      GameEvent.TetherPopped,
      this.slotWorldPos[base],
      this.slotWorldPos[base + 1],
      this.slotWorldPos[base + 2],
      packTetherData(slot, hand),
    );
  }

  /** Drop the lease without touching the robot. */
  private clearTether(slot: number): void {
    if (slot < 0 || slot >= this.slotTetherHand.length) return;
    if (this.slotTetherHand[slot] < 0) return;
    this.slotTetherHand[slot] = -1;
    this.slots[slot]?.setValue(Target, 'tetheredBy', -1);
    this.publishTetheredHands();
  }

  private tetherHandOf(slot: number): number {
    if (slot < 0 || slot >= this.slotTetherHand.length) return -1;
    return this.slotTetherHand[slot];
  }

  /** Recompute the globals bitmask BallSpawnSystem watches. */
  private publishTetheredHands(): void {
    let mask = 0;
    for (let slot = 0; slot < this.slotTetherHand.length; slot++) {
      const hand = this.slotTetherHand[slot];
      if (hand === 0) mask |= 1;
      else if (hand === 1) mask |= 2;
    }
    if (this.tetheredHands.peek() !== mask) this.tetheredHands.value = mask;
  }

  // ---- Pool and art --------------------------------------------------------

  /**
   * Build the entity pool. Idempotent; returns false while no art at all is
   * loaded (unit tests, or robot.gltf missing) so callers can retry.
   */
  private ensurePool(): boolean {
    if (this.slots.length > 0) return true;
    let anyArt = false;
    try {
      for (let a = 0; a < ARCHETYPE_CONFIGS.length && !anyArt; a++) {
        anyArt = this.desiredArtKey(a) !== '';
      }
    } catch {
      // AssetManager not initialised (unit tests) — no robots, no crash.
      return false;
    }
    if (!anyArt) return false;

    for (let slot = 0; slot < TARGETS.poolSize; slot++) {
      const arch = this.slotArchetype[slot];
      const fit = new Group();
      fit.name = 'Fit';
      const yaw = new Group();
      yaw.name = 'YawOffset';
      yaw.add(fit);
      const rig = new Group();
      rig.name = 'Rig';
      rig.add(yaw);
      const holder = new Group();
      holder.name = `Neatnik_${slot}`;
      holder.visible = false;
      holder.add(rig);

      const entity = this.world.createTransformEntity(holder, {
        parent: this.world.sceneEntity,
        persistent: true,
      });
      entity.addComponent(Target, {
        hp: archetypeConfig(arch).hp,
        slot,
        archetype: arch,
      });
      // DepthOccludable is added per art install (installArt), not here:
      // DepthSensingSystem patches the materials it finds at qualify time.

      this.slots.push(entity);
      this.rigs.push(rig);
      this.yawGroups.push(yaw);
      this.slotArtKey.push('');
      this.slotMaterials.push([]);
      this.slotFlash.push({ value: new Vector3() });
      this.slotState[slot] = TargetSlotState.Empty;
      this.buildHpBar(slot);
    }

    this.refreshArt();
    return true;
  }

  /**
   * Round 10: a floating HP pip bar for a multi-hit slot (see
   * {@link wearsHpBar}); everyone else gets nulls. Its own transform entity,
   * not a child of the robot: kept off the robot's DepthOccludable material
   * patching (the pip materials are shared across bars) and off the rig's
   * squash. Positioned and billboarded every frame by {@link updateHpBars}.
   */
  private buildHpBar(slot: number): void {
    const arch = this.slotArchetype[slot];
    if (!wearsHpBar(arch)) {
      this.barObjects.push(null);
      this.barShieldRows.push(null);
      this.barBodyPips.push([]);
      this.barShieldPips.push([]);
      return;
    }
    const hb = NEATNIKS.hpBar;
    if (!this.pipGeometry) {
      this.pipGeometry = new BoxGeometry(hb.pipWidth, hb.pipHeight, hb.pipDepth);
      const colors = [hb.bodyColor, hb.shieldColor, hb.offColor, hb.flashColor];
      for (const c of colors) {
        const material = new MeshBasicMaterial();
        // Gotcha 23: palette tuples are sRGB.
        material.color.setRGB(c[0], c[1], c[2], SRGBColorSpace);
        material.toneMapped = false;
        this.pipMaterials.push(material);
      }
    }
    const group = new Group();
    group.name = `NeatnikHp_${slot}`;
    group.visible = false;
    const makeRow = (count: number, y: number, into: Mesh[]): Group => {
      const row = new Group();
      row.position.set(0, y, 0);
      for (let i = 0; i < count; i++) {
        const pip = new Mesh(this.pipGeometry!, this.pipMaterials[2]);
        pip.position.set(pipX(i, count, hb.pipWidth, hb.pipGap), 0, 0);
        pip.renderOrder = 3;
        row.add(pip);
        into.push(pip);
      }
      group.add(row);
      return row;
    };
    const body: Mesh[] = [];
    const shield: Mesh[] = [];
    makeRow(archetypeConfig(arch).hp, 0, body);
    const shieldRow =
      arch === Neatnik.Squeegee
        ? makeRow(NEATNIKS.shield.hp, hb.rowGap, shield)
        : null;
    this.world.createTransformEntity(group, {
      parent: this.world.sceneEntity,
      persistent: true,
    });
    this.barObjects.push(group);
    this.barShieldRows.push(shieldRow);
    this.barBodyPips.push(body);
    this.barShieldPips.push(shield);
  }

  /**
   * Round 10: float each live multi-hit bot's pips over its head, facing the
   * player (billboard to the head), with lit / spent / flashing pips. Shared
   * materials, so a frame only swaps material references - no allocation.
   */
  private updateHpBars(nowSec: number): void {
    if (this.barObjects.length === 0) return;
    const hb = NEATNIKS.hpBar;
    const mats = this.pipMaterials;
    let headQuatRead = false;
    for (let slot = 0; slot < this.barObjects.length; slot++) {
      const bar = this.barObjects[slot];
      if (!bar) continue;
      const live = this.slotState[slot] === TargetSlotState.Active;
      bar.visible = live;
      if (!live) continue;
      if (!headQuatRead) {
        this.player.head.getWorldQuaternion(this.headQuat);
        headQuatRead = true;
      }
      const base = slot * 3;
      const cfg = archetypeConfig(this.slotArchetype[slot]);
      bar.position.set(
        this.slotWorldPos[base],
        this.slotWorldPos[base + 1] + cfg.heightMeters * 0.5 + hb.above,
        this.slotWorldPos[base + 2],
      );
      bar.quaternion.copy(this.headQuat);

      const bodyLeft = this.barFlashUntil[slot] - nowSec;
      const shieldLeft = this.shieldBarFlashUntil[slot] - nowSec;
      const bodyFlash = bodyLeft > 0;
      const shieldFlash = shieldLeft > 0;
      const punchK = Math.max(
        bodyFlash ? bodyLeft / hb.flashSec : 0,
        shieldFlash ? shieldLeft / hb.flashSec : 0,
      );
      bar.scale.setScalar(1 + hb.flashPunch * Math.min(1, punchK));

      const body = this.barBodyPips[slot];
      const hp = this.slotHp[slot];
      for (let i = 0; i < body.length; i++) {
        const look = pipLook(i, hp, bodyFlash);
        body[i].material =
          look === PipLook.On ? mats[0] : look === PipLook.Flash ? mats[3] : mats[2];
      }
      const row = this.barShieldRows[slot];
      if (row) {
        const shieldHp = this.slotShieldHp[slot];
        // A shattered shield's row blinks out with the burst, then goes.
        row.visible = shieldHp > 0 || shieldFlash;
        const pips = this.barShieldPips[slot];
        for (let i = 0; i < pips.length; i++) {
          const look = pipLook(i, shieldHp, shieldFlash);
          pips[i].material =
            look === PipLook.On ? mats[1] : look === PipLook.Flash ? mats[3] : mats[2];
        }
      }
    }
  }

  /** The asset key a slot of this archetype should wear right now, or ''. */
  private desiredArtKey(archetype: number): string {
    const key = archetypeConfig(archetype).assetKey;
    if (AssetManager.getGLTF(key)?.scene) return key;
    if (AssetManager.getGLTF(ROBOT_ASSET_KEY)?.scene) return ROBOT_ASSET_KEY;
    return '';
  }

  /**
   * Give every slot the best art available: its archetype's GLB once it has
   * streamed in, robot.gltf until then. Only slots whose art changed are
   * rebuilt, so this is free when nothing new has arrived.
   */
  private refreshArt(): void {
    for (let slot = 0; slot < this.slots.length; slot++) {
      // Never swap under a live robot.
      if (this.slotState[slot] !== TargetSlotState.Empty) continue;
      let key = '';
      try {
        key = this.desiredArtKey(this.slotArchetype[slot]);
      } catch {
        return;
      }
      if (key === '' || key === this.slotArtKey[slot]) continue;
      this.installArt(slot, key);
    }
  }

  /**
   * Clone `key`'s art into a slot: per-slot materials (rim + flash patched),
   * measured and rescaled to the archetype's height, recentred on the slot's
   * pivot, and turned by its yawOffsetDeg (robot.gltf has no front: 0).
   */
  private installArt(slot: number, key: string): void {
    const source = AssetManager.getGLTF(key)?.scene as Object3D | undefined;
    const yaw = this.yawGroups[slot];
    const fit = yaw?.children[0];
    if (!source || !yaw || !fit) return;
    const cfg = archetypeConfig(this.slotArchetype[slot]);

    // Release the previous art's per-slot materials (its geometry and
    // textures belong to the shared GLTF and stay).
    for (const material of this.slotMaterials[slot]) material.dispose();
    this.slotMaterials[slot].length = 0;
    while (fit.children.length > 0) fit.remove(fit.children[0]);

    const model = source.clone(true);
    const flash = this.slotFlash[slot];
    const materials = this.slotMaterials[slot];
    model.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material as Material | Material[];
      if (Array.isArray(material)) {
        mesh.material = material.map((m) => {
          const copy = m.clone();
          patchRobotMaterial(copy, flash);
          materials.push(copy);
          return copy;
        });
      } else if (material) {
        const copy = material.clone();
        patchRobotMaterial(copy, flash);
        materials.push(copy);
        mesh.material = copy;
      }
    });

    model.updateMatrixWorld(true);
    this.measureBox.setFromObject(model);
    this.measureBox.getSize(this.measureSize);
    this.measureBox.getCenter(this.measureCenter);

    const scale = cfg.heightMeters / (this.measureSize.y || 1);
    this.slotRadius[slot] = Math.max(
      TARGETS.hitRadiusMin,
      0.5 *
        scale *
        cfg.hitRadiusScale *
        Math.max(this.measureSize.x, this.measureSize.y, this.measureSize.z),
    );
    fit.scale.setScalar(scale);
    fit.position.set(
      -this.measureCenter.x * scale,
      -this.measureCenter.y * scale,
      -this.measureCenter.z * scale,
    );
    fit.add(model);
    yaw.rotation.y =
      key === ROBOT_ASSET_KEY ? 0 : cfg.yawOffsetDeg * DEG_TO_RAD;
    this.slotArtKey[slot] = key;
    this.refreshOcclusion(slot);
  }

  /**
   * Round 9: real-world depth occlusion for this slot's CURRENT art.
   *
   * IWSDK's DepthSensingSystem injects its occlusion shader into the
   * materials it finds under the entity when DepthOccludable *qualifies* —
   * so art swapped in later (robot.gltf -> the Meshy GLB at Countdown) would
   * never be patched. Removing and re-adding the tag re-runs that qualify on
   * the new per-slot materials. Robots are plain meshes (never instanced),
   * which the occlusion shader requires (gotcha 20). Inert when
   * RENDER.depthOcclusion is off, and the uniforms stay disabled on a
   * session without `depth-sensing`.
   */
  private refreshOcclusion(slot: number): void {
    if (!RENDER.depthOcclusion) return;
    const entity = this.slots[slot];
    if (!entity) return;
    if (entity.hasComponent(DepthOccludable)) {
      entity.removeComponent(DepthOccludable);
    }
    entity.addComponent(DepthOccludable);
  }

  // ---- Rounds and the spawn director --------------------------------------

  /** Middle of the spawn arc, captured once per round. Defaults to -Z. */
  private spawnArcCenter = FORWARD_HEADING_RAD;

  /** Wake the pool for a fresh round, arc facing the player's heading. */
  private beginRound(): void {
    if (!this.ensurePool()) return;
    this.refreshArt();

    const head = this.player.head;
    head.updateWorldMatrix(true, false);
    const m = head.matrixWorld.elements;
    this.spawnArcCenter = flatHeadingAngle(-m[8], -m[9], -m[10], m[4], m[6]);

    for (let slot = 0; slot < this.slots.length; slot++) {
      this.deactivate(slot);
    }
    this.aliveCount = 0;
    this.roundActive = true;
    this.bossSpawned = false;
    this.roundClock = 0;
    this.nextSpawnAt[0] = performance.now() / 1000;
    this.lastPopAt[0] = 0;
    this.targetsAlive.value = 0;
  }

  /** Hide everything and cancel pending respawns. */
  private endRound(): void {
    this.roundActive = false;
    for (let slot = 0; slot < this.slots.length; slot++) {
      this.deactivate(slot);
    }
    this.aliveCount = 0;
    this.targetsAlive.value = 0;
  }

  /** Seconds left on the round clock (the global, or our own fallback). */
  private roundTimeLeft(): number {
    const left = this.timeLeft?.peek();
    return typeof left === 'number' ? left : GAME.roundSec - this.roundClock;
  }

  /**
   * Keep the round populated: bring the boss on at his cue, then top the
   * arena up to the current cap, one spawn per `spawnStaggerSec`.
   *
   * Round 10 pacing (owner: "waiting a few seconds after I beat a round"):
   * refills wait `refillDelaySec` after a pop (was 1.5 s), an empty arena
   * refills `emptyRefillSec` after its last pop whatever the stagger, and a
   * wave breather only thins the arena to `breatherKeepAlive` (was 3 s of no
   * spawns at all). @see directorCap @see directorReady
   */
  private directSpawns(nowSec: number): void {
    const timeLeft = this.roundTimeLeft();
    const boss = NEATNIKS.boss;

    if (bossDue(timeLeft, boss.enterAtSecLeft, this.bossSpawned)) {
      // Only spent on success: a failed spawn retries next frame rather than
      // silently losing the boss for the round.
      this.bossSpawned = this.spawnArchetype(Neatnik.DusterDuke, nowSec) >= 0;
    }

    const waves = NEATNIKS.waves;
    const elapsed = GAME.roundSec - timeLeft;
    const cap = directorCap(
      elapsed,
      timeLeft,
      waves,
      this.countActive(Neatnik.DusterDuke),
      DIRECTOR_TUNING,
    );
    if (
      !directorReady(
        nowSec,
        this.aliveCount,
        cap,
        this.nextSpawnAt[0],
        this.lastPopAt[0],
        DIRECTOR_TUNING.emptyRefillSec,
      )
    ) {
      return;
    }
    const wave = waves[waveIndexAt(elapsed, waves)];
    if (!wave) return;
    const inBoss = boss.enterAtSecLeft > 0 && timeLeft <= boss.enterAtSecLeft;
    const arch = pickWeighted(
      inBoss ? boss.companionWeights : wave.weights,
      Math.random(),
    );
    // A busy pool (all its slots up or cooling down) falls back to any
    // other small bot, Mopsys first, so a refill is never skipped.
    if (this.spawnArchetype(arch, nowSec) < 0) {
      for (let k = 0; k < FALLBACK_ORDER.length; k++) {
        const other = FALLBACK_ORDER[k];
        if (other !== arch && this.spawnArchetype(other, nowSec) >= 0) break;
      }
    }
    this.nextSpawnAt[0] = nowSec + NEATNIKS.spawnStaggerSec;
  }

  private countActive(archetype: number): number {
    let n = 0;
    for (let slot = 0; slot < this.slots.length; slot++) {
      if (
        this.slotState[slot] === TargetSlotState.Active &&
        this.slotArchetype[slot] === archetype
      ) {
        n++;
      }
    }
    return n;
  }

  private freeSlotOf(archetype: number): number {
    for (let slot = 0; slot < this.slots.length; slot++) {
      if (
        this.slotArchetype[slot] === archetype &&
        this.slotState[slot] === TargetSlotState.Empty
      ) {
        return slot;
      }
    }
    return -1;
  }

  /**
   * Place and wake one robot of `archetype`. Expects `headScratch` to hold
   * the head's world position. @returns the slot, or -1 when none is free.
   */
  private spawnArchetype(archetype: number, nowSec: number): number {
    const slot = this.freeSlotOf(archetype);
    if (slot < 0) return -1;
    const object3D = this.slots[slot].object3D;
    if (!object3D) return -1;
    const head = this.headScratch;
    this.slotLane[slot] = -1;

    switch (archetype) {
      case Neatnik.DusterDuke: {
        const boss = NEATNIKS.boss;
        // Round 10: lay out his patrol, then land on its middle point.
        const landing = this.layOutPatrol(slot);
        this.patrolPointInto(slot, landing, this.pairScratch);
        const x = this.pairScratch[0];
        const z = this.pairScratch[1];
        this.startSlot(slot, x, boss.standHeight, z, nowSec);
        const base = slot * 3;
        this.slotHome[base] = x;
        this.slotHome[base + 1] = boss.standHeight;
        this.slotHome[base + 2] = z;
        this.patrolIdx[slot] = landing;
        this.patrolMoveStart[slot] = 0;
        this.patrolPauseUntil[slot] =
          nowSec + boss.dropSec + boss.patrolPauseSec;
        this.entranceStartedAt[slot] = nowSec;
        // The drop *is* the entrance: skip the pop-in.
        this.spawnStartedAt[slot] = nowSec - NEATNIKS.anim.spawnSec;
        this.events.emit(
          GameEvent.BossEntered,
          x,
          boss.standHeight,
          z,
          slot,
        );
        break;
      }

      case Neatnik.Peekaboo: {
        if (!this.placeBehindFurniture(slot, nowSec)) {
          this.placeLowPeek(slot, nowSec);
        }
        const peek = NEATNIKS.peek;
        this.slotHiddenSec[slot] =
          peek.hiddenSec + Math.random() * peek.hiddenJitterSec;
        // Start half-way through hiding, so the first peek comes soon.
        this.peekStartedAt[slot] = nowSec - this.slotHiddenSec[slot] * 0.5;
        break;
      }

      default: {
        const lane = this.pickFreeLane();
        const lanes = this.laneOccupancy.length;
        const distance = this.pickRoomAwareSpawn(lane, lanes);
        this.startSlot(
          slot,
          head.x + this.spawnDirection.x * distance,
          head.y + this.spawnDirection.y * distance,
          head.z + this.spawnDirection.z * distance,
          nowSec,
        );
        this.slotLane[slot] = lane;
        break;
      }
    }
    this.events.emit(GameEvent.BotSpawned, this.slotWorldPos[slot * 3], this.slotWorldPos[slot * 3 + 1], this.slotWorldPos[slot * 3 + 2], packPopData(slot, archetype, 0)); // R9: first-encounter coaching (CoachSystem)
    return slot;
  }

  /**
   * Round 10: Duster Duke's patrol points for this slot, around the head
   * (expects `headScratch`): `patrolPoints` spread over `patrolArcDeg` of the
   * seated arc at `boss.distance`, pushed out to `hudClearDist` in the band
   * straight ahead where the docked HUD sits, each room-clamped and never
   * nearer than ROOM.spawnMinDist. @returns the landing (middle) index.
   */
  private layOutPatrol(slot: number): number {
    const boss = NEATNIKS.boss;
    const head = this.headScratch;
    const n = patrolOffsets(
      boss.patrolPoints,
      Math.min(boss.patrolArcDeg, TARGETS.spawnArcDeg),
      this.patrolScratch,
    );
    const avoidRad = boss.hudAvoidDeg * DEG_TO_RAD;
    const base = slot * MAX_PATROL_POINTS;
    this.patrolCentre[slot * 2] = head.x;
    this.patrolCentre[slot * 2 + 1] = head.z;
    for (let i = 0; i < n; i++) {
      const a = this.patrolScratch[i];
      const w = hudBandWeight(a, avoidRad);
      const want = boss.distance + Math.max(0, boss.hudClearDist - boss.distance) * w;
      this.patrolA[base + i] = a;
      this.patrolR[base + i] = this.roomClampedRadius(a, want);
    }
    this.patrolCount[slot] = n;
    this.patrolClearR[slot] = this.roomClampedRadius(0, boss.hudClearDist);
    return Math.floor(n / 2);
  }

  /** `want` metres along arc offset `a`, pulled in front of real walls. */
  private roomClampedRadius(a: number, want: number): number {
    const heading = this.spawnArcCenter + a;
    this.spawnDirection.set(Math.cos(heading), 0, Math.sin(heading));
    const wall = this.probeWall(this.spawnDirection);
    const used = clampSpawnDistance(
      want,
      wall,
      ROOM.spawnWallMargin,
      ROOM.spawnMinDist,
    );
    return Math.max(ROOM.spawnMinDist, used);
  }

  /** World [x, z] of patrol point `index` of a slot, into `out`. */
  private patrolPointInto(slot: number, index: number, out: Float32Array): void {
    this.polarInto(
      slot,
      this.patrolA[slot * MAX_PATROL_POINTS + index],
      this.patrolR[slot * MAX_PATROL_POINTS + index],
      out,
    );
  }

  /** World [x, z] of (arc offset, radius) around a slot's patrol centre. */
  private polarInto(slot: number, a: number, r: number, out: Float32Array): void {
    const heading = this.spawnArcCenter + a;
    out[0] = this.patrolCentre[slot * 2] + Math.cos(heading) * r;
    out[1] = this.patrolCentre[slot * 2 + 1] + Math.sin(heading) * r;
  }

  /**
   * Round 10: one frame of the Duke's patrol (landed, not hauled, not
   * walking home): stomp in place for a pause, then strafe to another point
   * along {@link patrolPathPoint}'s HUD-dodging polar path.
   */
  private patrolStep(slot: number, nowSec: number, holder: Object3D): void {
    const boss = NEATNIKS.boss;
    const count = this.patrolCount[slot];
    if (count <= 1) return;
    const leg = slot * 4;
    const started = this.patrolMoveStart[slot];
    if (started > 0) {
      const u = (nowSec - started) / Math.max(0.05, this.patrolMoveDur[slot]);
      patrolPathPoint(
        this.patrolLeg[leg],
        this.patrolLeg[leg + 1],
        this.patrolLeg[leg + 2],
        this.patrolLeg[leg + 3],
        clamp01(u),
        boss.hudAvoidDeg * DEG_TO_RAD,
        this.patrolClearR[slot],
        this.poseScratch,
      );
      this.polarInto(slot, this.poseScratch[0], this.poseScratch[1], this.pairScratch);
      holder.position.x = this.pairScratch[0];
      holder.position.z = this.pairScratch[1];
      if (u >= 1) {
        this.patrolMoveStart[slot] = 0;
        this.patrolPauseUntil[slot] =
          nowSec + boss.patrolPauseSec + Math.random() * boss.patrolPauseJitterSec;
      }
      return;
    }
    if (nowSec < this.patrolPauseUntil[slot]) return;

    const from = this.patrolIdx[slot];
    const to = nextPatrolIndex(from, count, Math.random());
    const pb = slot * MAX_PATROL_POINTS;
    const a0 = this.patrolA[pb + from];
    const r0 = this.patrolR[pb + from];
    const a1 = this.patrolA[pb + to];
    const r1 = this.patrolR[pb + to];
    this.patrolLeg[leg] = a0;
    this.patrolLeg[leg + 1] = r0;
    this.patrolLeg[leg + 2] = a1;
    this.patrolLeg[leg + 3] = r1;
    const length = patrolLegLength(a0, r0, a1, r1);
    this.patrolMoveDur[slot] = Math.max(0.4, length / Math.max(0.05, boss.patrolSpeed));
    this.patrolMoveStart[slot] = nowSec;
    this.patrolIdx[slot] = to;
    // His home is wherever this leg is heading: a haul mid-leg walks him
    // back there, onto his patrol.
    const base = slot * 3;
    this.patrolPointInto(slot, to, this.pairScratch);
    this.slotHome[base] = this.pairScratch[0];
    this.slotHome[base + 1] = boss.standHeight;
    this.slotHome[base + 2] = this.pairScratch[1];
  }

  /** The least crowded lane of the arc right now. */
  private pickFreeLane(): number {
    const occupancy = this.laneOccupancy;
    occupancy.fill(0);
    for (let slot = 0; slot < this.slots.length; slot++) {
      const lane = this.slotLane[slot];
      if (
        lane >= 0 &&
        lane < occupancy.length &&
        this.slotState[slot] === TargetSlotState.Active
      ) {
        occupancy[lane]++;
      }
    }
    return pickLane(occupancy, occupancy.length, Math.random());
  }

  /**
   * Common wake-up: position, timers, hp, facing. Every archetype-specific
   * placement funnels through here.
   */
  private startSlot(
    slot: number,
    x: number,
    y: number,
    z: number,
    nowSec: number,
  ): void {
    const entity = this.slots[slot];
    const object3D = entity.object3D;
    if (!object3D) return;
    const cfg = archetypeConfig(this.slotArchetype[slot]);

    object3D.position.set(x, y, z);
    object3D.scale.setScalar(1);
    object3D.visible = true;
    this.resetRig(slot);

    this.slotBaseY[slot] = y;
    this.slotBobPhase[slot] = Math.random() * TAU;
    // Face the player from the first frame; the pop-in spin unwinds onto it.
    this.slotYaw[slot] = faceYaw(x, z, this.headScratch.x, this.headScratch.z);
    this.slotHp[slot] = cfg.hp;
    this.slotLift[slot] = 1;
    this.slotHittable[slot] = 1;
    this.slotState[slot] = TargetSlotState.Active;
    this.respawnAt[slot] = 0;
    this.popStartedAt[slot] = 0;
    this.hitFlashUntil[slot] = 0;
    this.hitStartedAt[slot] = 0;
    this.spawnStartedAt[slot] = nowSec;
    this.entranceStartedAt[slot] = 0;
    this.returnStartedAt[slot] = 0;
    this.slotDriftHome[slot] = 0;
    this.shieldFlashUntil[slot] = 0;
    this.barFlashUntil[slot] = 0;
    this.shieldBarFlashUntil[slot] = 0;
    this.slotShieldHp[slot] =
      this.slotArchetype[slot] === Neatnik.Squeegee ? NEATNIKS.shield.hp : 0;
    this.patrolMoveStart[slot] = 0;
    // Round 10: strafe across the line of sight (perpendicular to head->bot).
    let sx = -(z - this.headScratch.z);
    let sz = x - this.headScratch.x;
    const sl = Math.sqrt(sx * sx + sz * sz);
    if (sl > 1e-6) {
      sx /= sl;
      sz /= sl;
    } else {
      sx = 1;
      sz = 0;
    }
    this.slotStrafeDir[slot * 2] = sx;
    this.slotStrafeDir[slot * 2 + 1] = sz;
    this.slotStrafePrev[slot] = strafeOffset(
      this.animClock,
      this.slotBobPhase[slot],
      NEATNIKS.mopsyDrift.amplitude,
      NEATNIKS.mopsyDrift.hz,
    );
    entity.setValue(Target, 'hp', cfg.hp);
    this.aliveCount++;

    const base = slot * 3;
    this.slotWorldPos[base] = x;
    this.slotWorldPos[base + 1] = y;
    this.slotWorldPos[base + 2] = z;
  }

  /**
   * Peekaboo's signature: hide behind a real piece of furniture on the far
   * side from the player — a bounded scene mesh (couch, table, desk...) whose
   * top is at a hideable height, inside the seated arc, with no wall between.
   * @returns false when the room offers nothing usable.
   */
  private placeBehindFurniture(slot: number, nowSec: number): boolean {
    const peek = NEATNIKS.peek;
    const head = this.headScratch;
    const halfArc = (Math.min(360, TARGETS.spawnArcDeg) * DEG_TO_RAD) / 2;
    const cand = this.hideCandidates;
    let count = 0;

    // Round 9: where the other live Peekaboos already hide, so two never
    // stack on one spot (they used to share the same couch-back point).
    let occupied = 0;
    for (let other = 0; other < this.slots.length; other++) {
      if (other === slot) continue;
      if (this.slotArchetype[other] !== Neatnik.Peekaboo) continue;
      if (this.slotState[other] !== TargetSlotState.Active) continue;
      this.peekOccupied[occupied * 2] = this.slotWorldPos[other * 3];
      this.peekOccupied[occupied * 2 + 1] = this.slotWorldPos[other * 3 + 2];
      occupied++;
    }
    const spacing = peek.minSpacing;

    for (const mesh of this.queries.meshes.entities) {
      if (count >= MAX_HIDE_CANDIDATES) break;
      if (mesh.getValue(XRMesh, 'isBounded3D') !== true) continue;
      const object3D = mesh.object3D;
      if (!object3D) continue;
      object3D.updateWorldMatrix(true, false);
      this.measureBox.setFromObject(object3D);
      const box = this.measureBox;
      const top = box.max.y;
      if (top < peek.furnitureMinTop || top > peek.furnitureMaxTop) continue;
      const cx = (box.min.x + box.max.x) / 2;
      const cz = (box.min.z + box.max.z) / 2;
      const off = wrapAngle(
        Math.atan2(cz - head.z, cx - head.x) - this.spawnArcCenter,
      );
      if (TARGETS.spawnArcDeg < 360 && Math.abs(off) > halfArc) continue;

      const dist = hideSpotBehind(
        head.x,
        head.z,
        cx,
        cz,
        (box.max.x - box.min.x) / 2,
        (box.max.z - box.min.z) / 2,
        peek.behindMargin,
        this.pairScratch,
      );
      if (dist < ROOM.spawnMinDist || dist > TARGETS.ringMaxR + 1.5) continue;

      // A wall between the player and the spot would make it unreachable.
      let sx = this.pairScratch[0];
      let sz = this.pairScratch[1];
      if (crowded2D(sx, sz, this.peekOccupied, occupied, spacing)) {
        // Slide sideways along the furniture (across the line of sight), if
        // the piece is wide enough to hide a second one; else skip it.
        const halfSpan = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
        if (halfSpan < spacing) continue;
        let px = -(sz - head.z);
        let pz = sx - head.x;
        const pl = Math.sqrt(px * px + pz * pz) || 1;
        px /= pl;
        pz /= pl;
        let placed = false;
        for (let k = 0; k < 2 && !placed; k++) {
          const sign = k === 0 ? 1 : -1;
          const tx = sx + px * spacing * sign;
          const tz = sz + pz * spacing * sign;
          if (!crowded2D(tx, tz, this.peekOccupied, occupied, spacing)) {
            sx = tx;
            sz = tz;
            placed = true;
          }
        }
        if (!placed) continue;
      }
      this.spawnDirection.set(sx - head.x, 0, sz - head.z).normalize();
      if (this.probePlanes(this.spawnDirection) < dist + 0.1) continue;

      const k = count * 4;
      cand[k] = sx;
      cand[k + 1] = sz;
      cand[k + 2] = top;
      count++;
    }
    if (count === 0) return false;

    const pick = Math.min(count - 1, Math.floor(Math.random() * count));
    const k = pick * 4;
    const height = archetypeConfig(Neatnik.Peekaboo).heightMeters;
    const top = cand[k + 2];
    const upY = top + peek.peekAbove;
    // Hidden: the top of the head just below the furniture's top.
    const hiddenY = top - height * 0.5 - 0.02;
    this.startSlot(slot, cand[k], upY, cand[k + 1], nowSec);
    this.slotPeekDrop[slot] = Math.max(0, upY - hiddenY);
    return true;
  }

  /** No furniture: periscope up out of a low spot in a lane of the arc. */
  private placeLowPeek(slot: number, nowSec: number): void {
    const peek = NEATNIKS.peek;
    const head = this.headScratch;
    const lane = this.pickFreeLane();
    const distance = this.pickRoomAwareSpawn(lane, this.laneOccupancy.length);
    const upY = peek.lowHideY + peek.lowPeekRise;
    this.startSlot(
      slot,
      head.x + this.spawnDirection.x * distance,
      upY,
      head.z + this.spawnDirection.z * distance,
      nowSec,
    );
    this.slotLane[slot] = lane;
    this.slotPeekDrop[slot] = peek.lowPeekRise;
  }

  /** After a tether lets a Peekaboo go: it is up, then ducks on schedule. */
  private restartPeekAtTop(slot: number, nowSec: number): void {
    this.peekStartedAt[slot] =
      nowSec - this.slotHiddenSec[slot] - NEATNIKS.peek.riseSec;
  }

  /**
   * Choose a spawn direction and distance in `lane` of `lanes` that actually
   * lands inside the room (probing the detected planes and meshes; see
   * {@link clampSpawnDistance}). Leaves the unit direction in
   * `this.spawnDirection` and returns the distance from the head.
   */
  private pickRoomAwareSpawn(lane: number, lanes: number): number {
    const attempts = Math.max(1, ROOM.spawnAttempts);
    let bestWall = -1;
    this.bestDirection.set(
      Math.cos(this.spawnArcCenter),
      0,
      Math.sin(this.spawnArcCenter),
    );

    for (let attempt = 0; attempt < attempts; attempt++) {
      ringSpawnPosition(
        lane,
        lanes,
        Math.random(),
        Math.random(),
        Math.random(),
        TARGETS,
        this.spawnOffset,
        this.spawnArcCenter,
        TARGETS.spawnArcDeg,
      );
      this.spawnDirection.set(
        this.spawnOffset[0],
        this.spawnOffset[1] - this.headScratch.y,
        this.spawnOffset[2],
      );
      const candidate = this.spawnDirection.length();
      if (candidate < 1e-4) continue;
      this.spawnDirection.multiplyScalar(1 / candidate);

      const wall = this.probeWall(this.spawnDirection);
      const used = clampSpawnDistance(
        candidate,
        wall,
        ROOM.spawnWallMargin,
        ROOM.spawnMinDist,
      );
      if (used >= 0) return used;

      if (wall > bestWall) {
        bestWall = wall;
        this.bestDirection.copy(this.spawnDirection);
      }
    }

    this.spawnDirection.copy(this.bestDirection);
    return ROOM.spawnMinDist;
  }

  /** Nearest real surface (planes and meshes) along `dir` from the head. */
  private probeWall(dir: Vector3): number {
    this.spawnRay.set(this.headScratch, dir);
    let nearest = Number.POSITIVE_INFINITY;
    for (const plane of this.queries.planes.entities) {
      nearest = Math.min(nearest, this.hitDistance(plane.object3D));
    }
    for (const mesh of this.queries.meshes.entities) {
      nearest = Math.min(nearest, this.hitDistance(mesh.object3D));
    }
    return nearest;
  }

  /** Nearest wall/floor plane along `dir` — furniture deliberately ignored. */
  private probePlanes(dir: Vector3): number {
    this.spawnRay.set(this.headScratch, dir);
    let nearest = Number.POSITIVE_INFINITY;
    for (const plane of this.queries.planes.entities) {
      nearest = Math.min(nearest, this.hitDistance(plane.object3D));
    }
    return nearest;
  }

  /** Nearest intersection of the current spawn ray with one object. */
  private hitDistance(object3D: Object3D | undefined): number {
    if (!object3D) return Number.POSITIVE_INFINITY;
    object3D.updateWorldMatrix(true, false);
    this.rayHits.length = 0;
    this.spawnRay.intersectObject(object3D, false, this.rayHits);
    return this.rayHits.length > 0
      ? this.rayHits[0].distance
      : Number.POSITIVE_INFINITY;
  }

  /** Neutral rig pose and no flash. */
  private resetRig(slot: number): void {
    const rig = this.rigs[slot];
    if (rig) {
      rig.position.set(0, 0, 0);
      rig.rotation.set(0, 0, 0);
      rig.scale.setScalar(1);
    }
    this.slotFlash[slot]?.value.set(0, 0, 0);
  }

  /** Hide a slot and clear its timers, without destroying anything. */
  private deactivate(slot: number): void {
    // Any lease on this slot dies with it; WebShooterSystem sees the slot go
    // free on its next poll and fades its strand out.
    this.clearTether(slot);
    if (this.aimTargets && slot < this.aimTargets.capacity) {
      this.aimTargets.active[slot] = 0;
    }
    const object3D = this.slots[slot]?.object3D;
    if (object3D) {
      object3D.visible = false;
      object3D.scale.setScalar(1);
      object3D.rotation.set(0, 0, 0);
    }
    this.resetRig(slot);
    this.slotState[slot] = TargetSlotState.Empty;
    this.slotHp[slot] = 0;
    this.slotLane[slot] = -1;
    this.slotHittable[slot] = 0;
    this.respawnAt[slot] = 0;
    this.popStartedAt[slot] = 0;
    this.hitFlashUntil[slot] = 0;
    this.hitStartedAt[slot] = 0;
    this.spawnStartedAt[slot] = 0;
    this.peekStartedAt[slot] = 0;
    this.entranceStartedAt[slot] = 0;
    this.returnStartedAt[slot] = 0;
    this.shieldFlashUntil[slot] = 0;
    this.barFlashUntil[slot] = 0;
    this.shieldBarFlashUntil[slot] = 0;
    this.slotShieldHp[slot] = 0;
    this.patrolMoveStart[slot] = 0;
    this.patrolPauseUntil[slot] = 0;
    const bar = this.barObjects[slot];
    if (bar) bar.visible = false;
  }

  // ---- Animation -----------------------------------------------------------

  /**
   * One frame of a live robot: per-archetype idle, facing, spawn pop-in, hit
   * squash, tether struggle and the emissive flash. Also decides whether the
   * robot can be hit this frame (Peekaboo only while up, Duke only once he
   * has landed).
   */
  private animateActive(
    slot: number,
    nowSec: number,
    delta: number,
    bobOmega: number,
  ): void {
    const holder = this.slots[slot].object3D;
    const rig = this.rigs[slot];
    if (!holder || !rig) return;

    const arch = this.slotArchetype[slot];
    const cfg = archetypeConfig(arch);
    const anim = NEATNIKS.anim;
    const tethered = this.isTethered(slot);
    const phase = this.slotBobPhase[slot];
    const clock = this.animClock;

    let hittable = true;
    let lift = 1;
    /** Volume-preserving squash (sideways = 1/sqrt). */
    let squash = 1;
    /** Plain vertical scale (Peekaboo's telescoping neck). */
    let telescope = 1;
    let tiltX = 0;
    let tiltZ = Math.sin(clock * TAU * cfg.swayHz + phase) * cfg.swayRad;

    // Spawn pop-in: overshooting grow + a spin that unwinds onto the facing.
    let grow = 1;
    let spin = 0;
    const tSpawn = nowSec - this.spawnStartedAt[slot];
    if (tSpawn >= 0 && tSpawn < anim.spawnSec) {
      const u = tSpawn / anim.spawnSec;
      grow = Math.max(0, easeOutBack(u, anim.spawnOvershoot));
      spin = (1 - easeOutCubic(u)) * anim.spawnSpinTurns * TAU;
    }

    if (!tethered) {
      // Round 9: a released robot drifting back out (the Duke walks home
      // inside his own branch below, after his drop).
      if (arch !== Neatnik.DusterDuke) this.walkHome(slot, nowSec);
      const bob = Math.sin(nowSec * bobOmega + phase) * cfg.bobAmplitude;
      let y = this.slotBaseY[slot] + bob;
      switch (arch) {
        case Neatnik.Mopsy: {
          // Skirt sway: the body breathes as the fringe swings.
          squash *= 1 + 0.04 * Math.sin(clock * TAU * cfg.swayHz * 2 + phase);
          // Round 10: a gentle strafe, applied as a delta so it composes with
          // the release drift and the tether (no jump when either ends).
          const off = strafeOffset(
            clock,
            phase,
            NEATNIKS.mopsyDrift.amplitude,
            NEATNIKS.mopsyDrift.hz,
          );
          if (!(this.returnStartedAt[slot] > 0)) {
            const d = off - this.slotStrafePrev[slot];
            holder.position.x += d * this.slotStrafeDir[slot * 2];
            holder.position.z += d * this.slotStrafeDir[slot * 2 + 1];
          }
          this.slotStrafePrev[slot] = off;
          break;
        }

        case Neatnik.Squeegee: {
          // Guard stance: leaning in behind the blade; recoils on a ping.
          const shield = NEATNIKS.shield;
          // Round 10: the guard stance drops once the shield has shattered.
          if (shieldStillUp(this.slotShieldHp[slot])) tiltX += shield.guardTiltRad;
          const flashLeft = this.shieldFlashUntil[slot] - nowSec;
          if (flashLeft > 0) {
            const k = flashLeft / shield.flashSec;
            tiltX -= shield.recoilRad * k;
            tiltZ += Math.sin(clock * TAU * 11) * 0.12 * k;
          }
          break;
        }

        case Neatnik.Peekaboo: {
          const peek = NEATNIKS.peek;
          lift = peekLift(
            nowSec - this.peekStartedAt[slot],
            this.slotHiddenSec[slot],
            peek.riseSec,
            peek.upSec,
          );
          y =
            this.slotBaseY[slot] -
            this.slotPeekDrop[slot] * (1 - lift) +
            bob * lift;
          hittable = peekHittable(lift, peek.hittableLift);
          // Periscope: the neck telescopes in while hiding, and the head
          // wobbles looking around while up.
          telescope = 0.6 + 0.4 * lift;
          tiltZ += Math.sin(clock * TAU * 2.1 + phase) * peek.wobbleRad * lift;
          tiltX += Math.sin(clock * TAU * 1.4 + phase) * peek.wobbleRad * 0.5 * lift;
          break;
        }

        case Neatnik.DusterDuke: {
          const boss = NEATNIKS.boss;
          const tE = nowSec - this.entranceStartedAt[slot];
          if (this.entranceStartedAt[slot] > 0 && tE < boss.dropSec) {
            y = this.slotBaseY[slot] + dropOffset(tE, boss.dropSec, boss.dropHeight);
            hittable = false;
            // Stretched by the fall.
            squash *= 1 + 0.15 * (tE / boss.dropSec);
          } else {
            // Stomping home after a haul, if he was hauled; otherwise on
            // patrol (round 10).
            if (this.returnStartedAt[slot] > 0) this.walkHome(slot, nowSec);
            else this.patrolStep(slot, nowSec, holder);
            // Footsteps: a hop per step, a squat on each landing.
            const step = Math.abs(Math.sin(clock * Math.PI * boss.stompHz + phase));
            y = this.slotBaseY[slot] + step * boss.stompLift;
            squash *= 1 - 0.05 * Math.pow(1 - step, 6);
            if (this.entranceStartedAt[slot] > 0) {
              squash *= squashWobble(
                tE - boss.dropSec,
                anim.hitSec * 1.6,
                boss.landSquash,
                3.5,
              );
            }
          }
          break;
        }

        default:
          break;
      }
      holder.position.y = y;
    } else {
      // A hooked robot struggles: a fast side-to-side rock (round 7's, now
      // on the rig so it composes with the facing yaw).
      tiltZ +=
        Math.sin(nowSec * WEB.tetherStruggleHz * TAU) * WEB.tetherStruggleRad;
      // Keep the Mopsy strafe phase current so release does not jump.
      if (arch === Neatnik.Mopsy) {
        this.slotStrafePrev[slot] = strafeOffset(
          clock,
          phase,
          NEATNIKS.mopsyDrift.amplitude,
          NEATNIKS.mopsyDrift.hz,
        );
      }
    }
    this.slotLift[slot] = lift;
    this.slotHittable[slot] = hittable ? 1 : 0;

    // Face the player (eased, short way round).
    const target = faceYaw(
      holder.position.x,
      holder.position.z,
      this.headScratch.x,
      this.headScratch.z,
    );
    this.slotYaw[slot] = stepYawToward(
      this.slotYaw[slot],
      target,
      cfg.faceRate,
      delta,
    );
    holder.rotation.y = this.slotYaw[slot] + spin;

    // Hit squash-and-stretch + the classic flash punch.
    if (this.hitStartedAt[slot] > 0) {
      squash *= squashWobble(
        nowSec - this.hitStartedAt[slot],
        anim.hitSec,
        anim.hitSquash,
        anim.hitWobbleHz,
      );
    }
    const flashLeft = this.hitFlashUntil[slot] - nowSec;
    const flashK = flashLeft > 0 ? Math.min(1, flashLeft / TARGETS.hitFlashSec) : 0;
    grow *= 1 + (TARGETS.hitFlashScale - 1) * flashK;

    const side = 1 / Math.sqrt(squash > 0.05 ? squash : 0.05);
    rig.scale.set(side * grow, squash * telescope * grow, side * grow);
    rig.rotation.set(tiltX, 0, tiltZ);

    this.writeFlash(slot, nowSec, flashK);
  }

  /** Start a Duke's walk from where he is now (slotWorldPos) back home. */
  private startWalkHome(slot: number, base: number, nowSec: number): void {
    this.slotReturnFrom[base] = this.slotWorldPos[base];
    this.slotReturnFrom[base + 1] = this.slotWorldPos[base + 1];
    this.slotReturnFrom[base + 2] = this.slotWorldPos[base + 2];
    this.returnStartedAt[slot] = nowSec;
    this.slotDriftHome[slot] = 0;
    if (this.slotArchetype[slot] === Neatnik.DusterDuke) {
      // Round 10: back on his patrol point, he catches his breath first.
      this.patrolMoveStart[slot] = 0;
      this.patrolPauseUntil[slot] =
        nowSec + NEATNIKS.boss.returnSec + NEATNIKS.boss.patrolPauseSec;
    }
  }

  /**
   * Round 9: a released (tap / timeout) non-boss robot inside
   * ROOM.spawnMinDist eases straight back out to that radius over
   * NEATNIKS.releaseReturnSec, keeping its height. Reuses the Duke's
   * walk-home lerp with a temporary home; a robot already far enough out
   * stays put.
   */
  private startReleaseDrift(slot: number, base: number, nowSec: number): void {
    this.player.head.getWorldPosition(this.headScratch);
    const moved = pushOutToRadius(
      this.slotWorldPos[base],
      this.slotWorldPos[base + 2],
      this.headScratch.x,
      this.headScratch.z,
      ROOM.spawnMinDist,
      this.spawnArcCenter,
      this.pairScratch,
    );
    if (!moved) return;
    this.slotHome[base] = this.pairScratch[0];
    this.slotHome[base + 1] = this.slotBaseY[slot];
    this.slotHome[base + 2] = this.pairScratch[1];
    this.startWalkHome(slot, base, nowSec);
    this.slotReturnFrom[base + 1] = this.slotBaseY[slot];
    this.slotDriftHome[slot] = 1;
  }

  /** Lerp a hauled Duke back to his landing spot. */
  private walkHome(slot: number, nowSec: number): void {
    const started = this.returnStartedAt[slot];
    if (!(started > 0)) return;
    const holder = this.slots[slot].object3D;
    if (!holder) return;
    const base = slot * 3;
    const drift = this.slotDriftHome[slot] === 1;
    const u =
      (nowSec - started) /
      (drift ? NEATNIKS.releaseReturnSec : NEATNIKS.boss.returnSec);
    if (u >= 1) {
      holder.position.x = this.slotHome[base];
      holder.position.z = this.slotHome[base + 2];
      this.slotBaseY[slot] = this.slotHome[base + 1];
      this.returnStartedAt[slot] = 0;
      this.slotDriftHome[slot] = 0;
      return;
    }
    const k = easeInOutSine(u);
    const from = this.slotReturnFrom;
    holder.position.x = from[base] + (this.slotHome[base] - from[base]) * k;
    holder.position.z =
      from[base + 2] + (this.slotHome[base + 2] - from[base + 2]) * k;
    this.slotBaseY[slot] =
      from[base + 1] + (this.slotHome[base + 1] - from[base + 1]) * k;
  }

  /** White hit flash + cyan shield ping, into the slot's emissive uniform. */
  private writeFlash(slot: number, nowSec: number, hitK: number): void {
    const flash = this.slotFlash[slot];
    if (!flash) return;
    const white = hitK * NEATNIKS.anim.hitFlashIntensity;
    const shieldLeft = this.shieldFlashUntil[slot] - nowSec;
    const cyan =
      shieldLeft > 0
        ? Math.min(2, shieldLeft / NEATNIKS.shield.flashSec) * 1.4
        : 0;
    flash.value.set(white + 0.25 * cyan, white + 0.9 * cyan, white + 1.2 * cyan);
  }

  /** Squash, spin and shrink, then hand the slot to the cooldown. */
  private animatePop(slot: number, nowSec: number): void {
    const holder = this.slots[slot].object3D;
    const rig = this.rigs[slot];
    const progress =
      (nowSec - this.popStartedAt[slot]) / TARGETS.popDurationSec;

    if (progress >= 1) {
      if (holder) holder.visible = false;
      this.resetRig(slot);
      this.slotState[slot] = TargetSlotState.Respawning;
      this.respawnAt[slot] = nowSec + TARGETS.respawnDelaySec;
      return;
    }

    const anim = NEATNIKS.anim;
    popPose(progress, anim.popSquashFrac, anim.popSpinTurns, this.poseScratch);
    if (rig) {
      rig.scale.set(this.poseScratch[1], this.poseScratch[0], this.poseScratch[1]);
    }
    if (holder) holder.rotation.y = this.slotYaw[slot] + this.poseScratch[2];
    const k = 1 - progress;
    this.slotFlash[slot]?.value.set(k * 1.2, k * 1.2, k * 1.2);
  }

  // ---- Hits ----------------------------------------------------------------

  /**
   * Sphere-overlap every free-flying ball against every hittable robot —
   * swept along the stretch the ball covered this frame. Squeegee's shield
   * gets first say on any ball arriving from its front.
   */
  private testBallOverlaps(nowSec: number, delta: number): void {
    this.serviceDeflections(nowSec);

    let hittableSlots = 0;
    for (let slot = 0; slot < this.slots.length; slot++) {
      if (this.slotState[slot] !== TargetSlotState.Active) continue;
      const object3D = this.slots[slot].object3D;
      if (!object3D) continue;
      object3D.getWorldPosition(this.worldScratch);
      const base = slot * 3;
      this.slotWorldPos[base] = this.worldScratch.x;
      this.slotWorldPos[base + 1] = this.worldScratch.y;
      this.slotWorldPos[base + 2] = this.worldScratch.z;
      if (this.slotHittable[slot] === 1) hittableSlots++;
    }
    if (hittableSlots === 0) return;

    for (const ball of this.queries.balls.entities) {
      if (ball.getValue(Ball, 'flightState') !== BallFlightState.Flying) {
        continue;
      }
      const object3D = ball.object3D;
      if (!object3D) continue;

      object3D.getWorldPosition(this.ballScratch);
      const ballRadius = ball.getValue(Ball, 'radius') ?? BALLS.radius;
      const latchHand = this.latchHandFor(ball);

      // Where it was at the start of the frame: back along its velocity,
      // capped so a frame-time spike cannot sweep half the room.
      let tailX = this.ballScratch.x;
      let tailY = this.ballScratch.y;
      let tailZ = this.ballScratch.z;
      let vx = 0;
      let vy = 0;
      let vz = 0;
      if (ball.hasComponent(PhysicsBody)) {
        const v = ball.getVectorView(PhysicsBody, '_linearVelocity');
        vx = v[0];
        vy = v[1];
        vz = v[2];
        if (delta > 0) {
          let back = delta;
          const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
          if (speed * back > MAX_SWEEP_METRES) back = MAX_SWEEP_METRES / speed;
          tailX -= vx * back;
          tailY -= vy * back;
          tailZ -= vz * back;
        }
      }

      for (let slot = 0; slot < this.slots.length; slot++) {
        if (this.slotState[slot] !== TargetSlotState.Active) continue;
        if (this.slotHittable[slot] !== 1) continue;
        if (this.isImmune(ball, slot, nowSec)) continue;

        const base = slot * 3;
        const distSq = segmentPointDistSq(
          tailX,
          tailY,
          tailZ,
          this.ballScratch.x,
          this.ballScratch.y,
          this.ballScratch.z,
          this.slotWorldPos[base],
          this.slotWorldPos[base + 1],
          this.slotWorldPos[base + 2],
        );
        const reach =
          this.slotRadius[slot] +
          ballRadius +
          (latchHand >= 0 && this.slotTetherHand[slot] < 0
            ? WEB.tetherLatchBonus
            : 0);
        if (distSq > reach * reach) continue;

        if (
          this.slotArchetype[slot] === Neatnik.Squeegee &&
          !this.isTethered(slot) &&
          this.shieldStops(ball, slot, vx, vz)
        ) {
          // Round 10: every blocked shot chips the shield; the one that
          // breaks it shatters the blade and is absorbed (paint spray only).
          if (
            this.chipShieldAt(
              slot,
              this.ballScratch.x,
              this.ballScratch.y,
              this.ballScratch.z,
              nowSec,
            )
          ) {
            this.emitBladeImpact(ball);
            ball.destroy();
            break;
          }
          if (!this.deflect(ball, slot, vx, vy, vz, nowSec)) {
            // Could not re-launch it (velocity already pending): it dies on
            // the blade, still harmlessly.
            ball.destroy();
          }
          break;
        }

        // A tether web latches instead of hitting; one that cannot take
        // falls through to the ordinary damage path.
        if (!this.tryTether(ball, slot, base)) {
          this.registerHit(slot, base, nowSec);
        }
        // destroy(), never dispose(): geometry/materials are shared (gotcha 4).
        ball.destroy();
        break;
      }
    }
  }

  /**
   * Round 10: one blocked shot against a Squeegee's shield. Chips a pip
   * (flashing the shield row); the last pip shatters it - ShieldBroken (cue
   * + cyan burst), a big cyan flash and a recoil squash - after which
   * {@link shieldStops} lets everything through. @returns true on shatter.
   */
  private chipShieldAt(
    slot: number,
    x: number,
    y: number,
    z: number,
    nowSec: number,
  ): boolean {
    const left = chipShield(this.slotShieldHp[slot]);
    this.slotShieldHp[slot] = left;
    this.shieldBarFlashUntil[slot] = nowSec + NEATNIKS.hpBar.flashSec;
    if (left > 0) return false;
    const shield = NEATNIKS.shield;
    this.shieldFlashUntil[slot] = nowSec + shield.shatterFlashSec;
    this.shieldBarFlashUntil[slot] = nowSec + shield.shatterFlashSec;
    this.hitStartedAt[slot] = nowSec;
    this.events.emit(GameEvent.ShieldBroken, x, y, z, slot);
    return true;
  }

  /** Is this ball one the Squeegee's blade turns away? */
  private shieldStops(
    ball: Entity,
    slot: number,
    vx: number,
    vz: number,
  ): boolean {
    if (!shieldStillUp(this.slotShieldHp[slot])) return false;
    const yaw = this.slots[slot].object3D?.rotation.y ?? this.slotYaw[slot];
    if (!shieldBlocks(Math.sin(yaw), Math.cos(yaw), vx, vz, NEATNIKS.shield.coneDeg)) {
      return false;
    }
    const isTether =
      ball.getValue(Ball, 'style') === BallStyle.Web &&
      ball.getValue(Ball, 'subStyle') === WebSubMode.Tether;
    return !shieldBypassed(
      ball.getValue(Ball, 'bounceCount') ?? 0,
      ball.getValue(Ball, 'kind') ?? BallKind.Normal,
      isTether,
    );
  }

  /**
   * Bounce a ball off a Squeegee's shield: a one-shot velocity through
   * PhysicsManipulation (gotcha 8), the robot ignores that ball for
   * `immunitySec`, and the blade flashes and recoils. The paint "ping" rides
   * a BallImpact at the blade, so the existing spray, splat sound and 5-point
   * paint bonus all fire with no new plumbing.
   *
   * @returns false when the ball already has a velocity change queued.
   */
  private deflect(
    ball: Entity,
    slot: number,
    vx: number,
    vy: number,
    vz: number,
    nowSec: number,
  ): boolean {
    this.shieldFlashUntil[slot] = nowSec + NEATNIKS.shield.flashSec;
    this.events.emit(
      GameEvent.ShieldDeflected,
      this.ballScratch.x,
      this.ballScratch.y,
      this.ballScratch.z,
      slot,
    );
    this.emitBladeImpact(ball);

    if (ball.hasComponent(PhysicsManipulation) || !ball.hasComponent(PhysicsBody)) {
      return false;
    }

    const yaw = this.slots[slot].object3D?.rotation.y ?? this.slotYaw[slot];
    const shield = NEATNIKS.shield;
    deflectVelocity(
      vx,
      vy,
      vz,
      Math.sin(yaw),
      Math.cos(yaw),
      shield.deflectRestitution,
      shield.deflectLift,
      this.poseScratch,
    );
    // Gotcha 22: never faster than it arrived (restitution < 1), but cap
    // anyway so a tuned-up lift cannot make a wall-tunnelling ball.
    const out = this.poseScratch;
    const speed = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]);
    const maxSpeed = shield.maxDeflectSpeed;
    if (speed > maxSpeed) {
      const k = maxSpeed / speed;
      out[0] *= k;
      out[1] *= k;
      out[2] *= k;
    }
    ball.addComponent(PhysicsManipulation, {
      linearVelocity: [out[0], out[1], out[2]],
    });

    // Remember it: immune to this shield for a moment, and its prevVelocity
    // re-primed once the new velocity lands (else BallFlightSystem reads the
    // bounce as a wall impact and splats it in mid-air).
    let r = 0;
    for (let i = 0; i < DEFLECT_CAPACITY; i++) {
      if (this.deflectBall[i] === null) {
        r = i;
        break;
      }
      if (this.deflectUntil[i] < this.deflectUntil[r]) r = i;
    }
    this.deflectBall[r] = ball;
    this.deflectGen[r] = ball.generation;
    this.deflectSlot[r] = slot;
    this.deflectUntil[r] = nowSec + shield.immunitySec;
    this.deflectVel[r * 3] = out[0];
    this.deflectVel[r * 3 + 1] = out[1];
    this.deflectVel[r * 3 + 2] = out[2];
    this.deflectPending[r] = 1;
    return true;
  }

  /** The paint ping at the blade: a BallImpact at `ballScratch`. */
  private emitBladeImpact(ball: Entity): void {
    const color = ball.getVectorView(Ball, 'color');
    this.events.emit(
      GameEvent.BallImpact,
      this.ballScratch.x,
      this.ballScratch.y,
      this.ballScratch.z,
      packImpactData(
        (ball.getValue(Ball, 'kind') ?? BallKind.Normal) as BallKind,
        color[0],
        color[1],
        color[2],
        (ball.getValue(Ball, 'style') ?? BallStyle.Paint) as BallStyle,
      ),
    );
  }

  /**
   * Housekeeping for deflected balls. PhysicsSystem (priority -2) applies a
   * PhysicsManipulation *after* its step and then removes it, so the frame
   * the component disappears is the frame BallFlightSystem has just copied
   * the *old* velocity into prevVelocity; overwriting it with the deflected
   * one here means next frame's Δv is only gravity, not an "impact".
   */
  private serviceDeflections(nowSec: number): void {
    for (let r = 0; r < DEFLECT_CAPACITY; r++) {
      const ball = this.deflectBall[r];
      if (!ball) continue;
      if (!ball.active || ball.generation !== this.deflectGen[r]) {
        this.deflectBall[r] = null;
        continue;
      }
      if (
        this.deflectPending[r] === 1 &&
        !ball.hasComponent(PhysicsManipulation) &&
        ball.hasComponent(Ball)
      ) {
        const prev = ball.getVectorView(Ball, 'prevVelocity');
        prev[0] = this.deflectVel[r * 3];
        prev[1] = this.deflectVel[r * 3 + 1];
        prev[2] = this.deflectVel[r * 3 + 2];
        this.deflectPending[r] = 0;
      }
      if (this.deflectPending[r] === 0 && nowSec >= this.deflectUntil[r]) {
        this.deflectBall[r] = null;
      }
    }
  }

  private isImmune(ball: Entity, slot: number, nowSec: number): boolean {
    for (let r = 0; r < DEFLECT_CAPACITY; r++) {
      if (
        this.deflectBall[r] === ball &&
        this.deflectGen[r] === ball.generation &&
        this.deflectSlot[r] === slot &&
        nowSec < this.deflectUntil[r]
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * The hand a tether ball could latch for, or -1 when it is not a tether web
   * or that hand already holds a line. Only ever widens the reach test.
   */
  private latchHandFor(ball: Entity): number {
    if (ball.getValue(Ball, 'style') !== BallStyle.Web) return -1;
    if (ball.getValue(Ball, 'subStyle') !== WebSubMode.Tether) return -1;
    const hand = ball.getValue(Ball, 'firedBy') ?? -1;
    if (hand !== 0 && hand !== 1) return -1;
    return this.tetherSlotForHand(hand) >= 0 ? -1 : hand;
  }

  /** Latch this robot if the ball that reached it was a tether web. */
  private tryTether(ball: Entity, slot: number, base: number): boolean {
    if (ball.getValue(Ball, 'style') !== BallStyle.Web) return false;
    if (ball.getValue(Ball, 'subStyle') !== WebSubMode.Tether) return false;

    const hand = ball.getValue(Ball, 'firedBy') ?? -1;
    if (!this.beginTether(slot, hand)) return false;

    this.events.emit(
      GameEvent.TetherAttached,
      this.slotWorldPos[base],
      this.slotWorldPos[base + 1],
      this.slotWorldPos[base + 2],
      packTetherData(slot, hand),
    );
    return true;
  }

  /** Apply one hit of damage and emit the matching events. */
  private registerHit(slot: number, base: number, nowSec: number): void {
    const x = this.slotWorldPos[base];
    const y = this.slotWorldPos[base + 1];
    const z = this.slotWorldPos[base + 2];

    const hp = this.slotHp[slot] - 1;
    this.slotHp[slot] = hp;
    this.slots[slot].setValue(Target, 'hp', hp);
    this.hitFlashUntil[slot] = nowSec + TARGETS.hitFlashSec;
    this.hitStartedAt[slot] = nowSec;
    this.barFlashUntil[slot] = nowSec + NEATNIKS.hpBar.flashSec;

    // data = hit points the robot has left (0 on the killing blow).
    this.events.emit(GameEvent.TargetHit, x, y, z, hp);
    if (hp > 0) return;

    this.popSlot(slot, base, nowSec);
  }

  /**
   * Start the pop and announce it — the single exit a live robot has, shot
   * or reeled. TargetPopped's `data` is {@link packPopData}: the slot in the
   * low byte as before, plus archetype and base points for scoring. Duster
   * Duke splits into two Mopsys on the spot.
   */
  private popSlot(slot: number, base: number, nowSec: number): void {
    this.clearTether(slot);
    this.slotState[slot] = TargetSlotState.Popping;
    this.slotHittable[slot] = 0;
    this.popStartedAt[slot] = nowSec;
    this.aliveCount = Math.max(0, this.aliveCount - 1);
    // Round 10: refill quickly (was TARGETS.respawnDelaySec, 1.5 s).
    this.nextSpawnAt[0] = Math.max(
      this.nextSpawnAt[0],
      nowSec + NEATNIKS.refillDelaySec,
    );
    this.lastPopAt[0] = nowSec;
    const arch = this.slotArchetype[slot];
    this.events.emit(
      GameEvent.TargetPopped,
      this.slotWorldPos[base],
      this.slotWorldPos[base + 1],
      this.slotWorldPos[base + 2],
      packPopData(slot, arch, archetypeConfig(arch).points),
    );

    if (arch === Neatnik.DusterDuke) this.splitBoss(base, nowSec);
  }

  /**
   * Two Mopsys burst out either side of a popped Duke. Round 9: a Duke
   * hauled in and popped by the tether dies inside the kill radius, so when
   * he is closer than ROOM.spawnMinDist the pair bursts out of his landing
   * spot instead of in the player's face. @see splitCentre
   */
  private splitBoss(base: number, nowSec: number): void {
    if (!this.roundActive) return;
    this.player.head.getWorldPosition(this.headScratch);
    const atHome = splitCentre(
      this.slotWorldPos[base],
      this.slotWorldPos[base + 2],
      this.slotHome[base],
      this.slotHome[base + 2],
      this.headScratch.x,
      this.headScratch.z,
      ROOM.spawnMinDist,
      this.pairScratch,
    );
    splitPositions(
      this.pairScratch[0],
      this.pairScratch[1],
      this.headScratch.x,
      this.headScratch.z,
      NEATNIKS.boss.splitSpread,
      this.pairScratch,
    );
    // Up off the floor where a seated player can see them over the coffee table.
    const y = Math.max(
      TARGETS.heightMin,
      (atHome ? this.slotHome[base + 1] : this.slotWorldPos[base + 1]) +
        archetypeConfig(Neatnik.Mopsy).heightMeters * 0.5,
    );
    for (let k = 0; k < 2; k++) {
      const child = this.freeSlotOf(Neatnik.Mopsy);
      if (child < 0) return;
      this.startSlot(
        child,
        this.pairScratch[k * 2],
        y,
        this.pairScratch[k * 2 + 1],
        nowSec,
      );
    }
  }
}

/**
 * Patch one per-slot robot material: the round-7 holo rim and IBL boost, plus
 * a `pbFlash` emissive uniform the slot drives for hit flashes and the shield
 * ping. The program cache key is the same for every robot, so the whole cast
 * shares one shader program; only the uniform object is per slot.
 */
function patchRobotMaterial(
  material: Material,
  flash: { value: Vector3 },
): void {
  const standard = material as MeshStandardMaterial;
  if (!standard.isMeshStandardMaterial) return;
  const f = (value: number) => value.toFixed(4);
  const rim = RENDER.robotRimColor;
  const rimGlsl = `vec3(${f(rim[0])}, ${f(rim[1])}, ${f(rim[2])})`;
  const strength = f(RENDER.robotRimStrength);
  const power = f(RENDER.robotRimPower);
  const env = f(RENDER.robotEnvBoost);
  // ':occ' when DepthSensingSystem will also patch these materials (round 9):
  // three keys programs on this tag, not on what onBeforeCompile does, so an
  // occluded and an unoccluded robot material must never share one.
  const occ = RENDER.depthOcclusion ? ':occ' : '';
  const cacheTag = `pb-neatnik:${rimGlsl}:${strength}:${power}:${env}${occ}`;
  standard.onBeforeCompile = (shader) => {
    shader.uniforms.pbFlash = flash;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 pbFlash;')
      // `normal` and `vViewPosition` are both view space here, and
      // `totalEmissiveRadiance` is still open for additions.
      .replace(
        '#include <emissivemap_fragment>',
        [
          '#include <emissivemap_fragment>',
          '{',
          '  float pbFacing = saturate( dot( normal, normalize( vViewPosition ) ) );',
          `  totalEmissiveRadiance += ${rimGlsl} * ( ${strength} * pow( 1.0 - pbFacing, ${power} ) );`,
          '  totalEmissiveRadiance += pbFlash;',
          '}',
        ].join('\n'),
      )
      .replace(
        '#include <lights_fragment_maps>',
        [
          '#include <lights_fragment_maps>',
          '#if defined( RE_IndirectDiffuse )',
          `  iblIrradiance *= ${env};`,
          '#endif',
          '#if defined( RE_IndirectSpecular )',
          `  radiance *= ${env};`,
          '#endif',
        ].join('\n'),
      );
  };
  standard.customProgramCacheKey = () => cacheTag;
  standard.needsUpdate = true;
}
