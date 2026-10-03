import {
  AssetManager,
  Box3,
  DepthOccludable,
  Group,
  PhysicsBody,
  PhysicsManipulation,
  Raycaster,
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
  Mesh,
  MeshStandardMaterial,
  Object3D,
} from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import { BALLS, GAME, RENDER, ROOM, SPLOTBOTS, TARGETS, WEB } from '../config';
import type { SplotbotArchetypeConfig, SplotbotWave } from '../config';
import {
  AimTargets,
  BallKind,
  BallStyle,
  GameEvent,
  GameEventBuffer,
  GamePhase,
  Splotbot,
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
  /** Round 8: which Splotbot this slot is built as (see {@link Splotbot}). */
  archetype: { type: Types.Int8, default: Splotbot.Mopsy },
});

// ---------------------------------------------------------------------------
// Archetype table
// ---------------------------------------------------------------------------

/** Config per {@link Splotbot}, in enum order. */
const ARCHETYPE_CONFIGS: ReadonlyArray<SplotbotArchetypeConfig> = [
  SPLOTBOTS.archetypes.mopsy,
  SPLOTBOTS.archetypes.squeegee,
  SPLOTBOTS.archetypes.peekaboo,
  SPLOTBOTS.archetypes.duke,
];

/** The tuning for one archetype; unknown values read as Mopsy. */
export function archetypeConfig(archetype: number): SplotbotArchetypeConfig {
  return ARCHETYPE_CONFIGS[archetype] ?? ARCHETYPE_CONFIGS[Splotbot.Mopsy];
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
  waves: ReadonlyArray<SplotbotWave>,
): number {
  let index = 0;
  for (let i = 0; i < waves.length; i++) {
    if (elapsedSec >= waves[i].startSec) index = i;
  }
  return index;
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

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

/** How many deflected balls the shield remembers at once. */
const DEFLECT_CAPACITY = 8;
/** Furniture candidates examined per Peekaboo spawn. */
const MAX_HIDE_CANDIDATES = 12;

/**
 * The Splotbots: a fixed pool of animated robot characters the player shoots
 * (round 8; rounds 1-7 had one generic robot).
 *
 * **Pool.** `TARGETS.poolSize` entities are built once, each permanently one
 * archetype (SPLOTBOTS.archetypes[*].pool of each), then shown, moved and
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
    this.laneOccupancy = new Int8Array(Math.max(1, SPLOTBOTS.lanes));
    this.poseScratch = new Float32Array(3);
    this.pairScratch = new Float32Array(4);
    this.hideCandidates = new Float32Array(MAX_HIDE_CANDIDATES * 4);
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
          // The splotbot GLBs stream in the background; swap them in while
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
    // A Duke being hauled is no longer walking home.
    this.returnStartedAt[slot] = 0;
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
   * `SPLOTBOTS.boss.tetherDamage` HP off him and he stomps back to his spot;
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
      if (arch === Splotbot.Peekaboo) this.restartPeekAtTop(slot, nowSec);
      // A boss let off the line stomps back to his spot rather than idling
      // wherever he was dropped (possibly in the player's lap).
      if (arch === Splotbot.DusterDuke) this.startWalkHome(slot, base, nowSec);
      return;
    }

    if (
      arch === Splotbot.DusterDuke &&
      this.slotHp[slot] > SPLOTBOTS.boss.tetherDamage
    ) {
      const hp = this.slotHp[slot] - SPLOTBOTS.boss.tetherDamage;
      this.slotHp[slot] = hp;
      this.slots[slot]?.setValue(Target, 'hp', hp);
      this.hitStartedAt[slot] = nowSec;
      this.hitFlashUntil[slot] = nowSec + TARGETS.hitFlashSec * 2;
      this.events.emit(
        GameEvent.TargetHit,
        this.slotWorldPos[base],
        this.slotWorldPos[base + 1],
        this.slotWorldPos[base + 2],
        hp,
      );
      // Stomp back to where he landed.
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
      holder.name = `Splotbot_${slot}`;
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
      // Inert until DepthSensingSystem is registered (gotcha 20); harmless.
      entity.addComponent(DepthOccludable);

      this.slots.push(entity);
      this.rigs.push(rig);
      this.yawGroups.push(yaw);
      this.slotArtKey.push('');
      this.slotMaterials.push([]);
      this.slotFlash.push({ value: new Vector3() });
      this.slotState[slot] = TargetSlotState.Empty;
    }

    this.refreshArt();
    return true;
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
   * current wave up to its robot count, one spawn per `spawnStaggerSec`.
   */
  private directSpawns(nowSec: number): void {
    const timeLeft = this.roundTimeLeft();
    const boss = SPLOTBOTS.boss;

    if (bossDue(timeLeft, boss.enterAtSecLeft, this.bossSpawned)) {
      // Only spent on success: a failed spawn retries next frame rather than
      // silently losing the boss for the round.
      this.bossSpawned = this.spawnArchetype(Splotbot.DusterDuke, nowSec) >= 0;
    }

    const waves = SPLOTBOTS.waves;
    const wave = waves[waveIndexAt(GAME.roundSec - timeLeft, waves)];
    if (!wave) return;
    const inBoss = boss.enterAtSecLeft > 0 && timeLeft <= boss.enterAtSecLeft;
    let cap = inBoss
      ? boss.companionsMax + this.countActive(Splotbot.DusterDuke)
      : wave.maxAlive;
    cap = Math.min(cap, TARGETS.maxConcurrent);
    if (this.aliveCount >= cap) return;
    if (nowSec < this.nextSpawnAt[0]) return;

    const arch = pickWeighted(wave.weights, Math.random());
    if (
      this.spawnArchetype(arch, nowSec) < 0 &&
      arch !== Splotbot.Mopsy
    ) {
      this.spawnArchetype(Splotbot.Mopsy, nowSec);
    }
    this.nextSpawnAt[0] = nowSec + SPLOTBOTS.spawnStaggerSec;
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
      case Splotbot.DusterDuke: {
        const boss = SPLOTBOTS.boss;
        this.spawnDirection.set(
          Math.cos(this.spawnArcCenter),
          0,
          Math.sin(this.spawnArcCenter),
        );
        const wall = this.probeWall(this.spawnDirection);
        const dist = Math.max(
          ROOM.spawnMinDist,
          clampSpawnDistance(
            boss.distance,
            wall,
            ROOM.spawnWallMargin,
            ROOM.spawnMinDist,
          ),
        );
        const x = head.x + this.spawnDirection.x * dist;
        const z = head.z + this.spawnDirection.z * dist;
        this.startSlot(slot, x, boss.standHeight, z, nowSec);
        const base = slot * 3;
        this.slotHome[base] = x;
        this.slotHome[base + 1] = boss.standHeight;
        this.slotHome[base + 2] = z;
        this.entranceStartedAt[slot] = nowSec;
        // The drop *is* the entrance: skip the pop-in.
        this.spawnStartedAt[slot] = nowSec - SPLOTBOTS.anim.spawnSec;
        this.events.emit(
          GameEvent.BossEntered,
          x,
          boss.standHeight,
          z,
          slot,
        );
        break;
      }

      case Splotbot.Peekaboo: {
        if (!this.placeBehindFurniture(slot, nowSec)) {
          this.placeLowPeek(slot, nowSec);
        }
        const peek = SPLOTBOTS.peek;
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
    this.shieldFlashUntil[slot] = 0;
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
    const peek = SPLOTBOTS.peek;
    const head = this.headScratch;
    const halfArc = (Math.min(360, TARGETS.spawnArcDeg) * DEG_TO_RAD) / 2;
    const cand = this.hideCandidates;
    let count = 0;

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
      const sx = this.pairScratch[0];
      const sz = this.pairScratch[1];
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
    const height = archetypeConfig(Splotbot.Peekaboo).heightMeters;
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
    const peek = SPLOTBOTS.peek;
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
      nowSec - this.slotHiddenSec[slot] - SPLOTBOTS.peek.riseSec;
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
    const anim = SPLOTBOTS.anim;
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
      const bob = Math.sin(nowSec * bobOmega + phase) * cfg.bobAmplitude;
      let y = this.slotBaseY[slot] + bob;
      switch (arch) {
        case Splotbot.Mopsy:
          // Skirt sway: the body breathes as the fringe swings.
          squash *= 1 + 0.04 * Math.sin(clock * TAU * cfg.swayHz * 2 + phase);
          break;

        case Splotbot.Squeegee: {
          // Guard stance: leaning in behind the blade; recoils on a ping.
          const shield = SPLOTBOTS.shield;
          tiltX += SPLOTBOTS.shield.guardTiltRad;
          const flashLeft = this.shieldFlashUntil[slot] - nowSec;
          if (flashLeft > 0) {
            const k = flashLeft / shield.flashSec;
            tiltX -= shield.recoilRad * k;
            tiltZ += Math.sin(clock * TAU * 11) * 0.12 * k;
          }
          break;
        }

        case Splotbot.Peekaboo: {
          const peek = SPLOTBOTS.peek;
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

        case Splotbot.DusterDuke: {
          const boss = SPLOTBOTS.boss;
          const tE = nowSec - this.entranceStartedAt[slot];
          if (this.entranceStartedAt[slot] > 0 && tE < boss.dropSec) {
            y = this.slotBaseY[slot] + dropOffset(tE, boss.dropSec, boss.dropHeight);
            hittable = false;
            // Stretched by the fall.
            squash *= 1 + 0.15 * (tE / boss.dropSec);
          } else {
            // Stomping home after a haul, if he was hauled.
            this.walkHome(slot, nowSec);
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
  }

  /** Lerp a hauled Duke back to his landing spot. */
  private walkHome(slot: number, nowSec: number): void {
    const started = this.returnStartedAt[slot];
    if (!(started > 0)) return;
    const holder = this.slots[slot].object3D;
    if (!holder) return;
    const base = slot * 3;
    const u = (nowSec - started) / SPLOTBOTS.boss.returnSec;
    if (u >= 1) {
      holder.position.x = this.slotHome[base];
      holder.position.z = this.slotHome[base + 2];
      this.slotBaseY[slot] = this.slotHome[base + 1];
      this.returnStartedAt[slot] = 0;
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
    const white = hitK * SPLOTBOTS.anim.hitFlashIntensity;
    const shieldLeft = this.shieldFlashUntil[slot] - nowSec;
    const cyan =
      shieldLeft > 0 ? (shieldLeft / SPLOTBOTS.shield.flashSec) * 1.4 : 0;
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

    const anim = SPLOTBOTS.anim;
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
          this.slotArchetype[slot] === Splotbot.Squeegee &&
          !this.isTethered(slot) &&
          this.shieldStops(ball, slot, vx, vz)
        ) {
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

  /** Is this ball one the Squeegee's blade turns away? */
  private shieldStops(
    ball: Entity,
    slot: number,
    vx: number,
    vz: number,
  ): boolean {
    const yaw = this.slots[slot].object3D?.rotation.y ?? this.slotYaw[slot];
    if (!shieldBlocks(Math.sin(yaw), Math.cos(yaw), vx, vz, SPLOTBOTS.shield.coneDeg)) {
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
    this.shieldFlashUntil[slot] = nowSec + SPLOTBOTS.shield.flashSec;
    const x = this.ballScratch.x;
    const y = this.ballScratch.y;
    const z = this.ballScratch.z;
    this.events.emit(GameEvent.ShieldDeflected, x, y, z, slot);
    const color = ball.getVectorView(Ball, 'color');
    this.events.emit(
      GameEvent.BallImpact,
      x,
      y,
      z,
      packImpactData(
        (ball.getValue(Ball, 'kind') ?? BallKind.Normal) as BallKind,
        color[0],
        color[1],
        color[2],
        (ball.getValue(Ball, 'style') ?? BallStyle.Paint) as BallStyle,
      ),
    );

    if (ball.hasComponent(PhysicsManipulation) || !ball.hasComponent(PhysicsBody)) {
      return false;
    }

    const yaw = this.slots[slot].object3D?.rotation.y ?? this.slotYaw[slot];
    const shield = SPLOTBOTS.shield;
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
    this.nextSpawnAt[0] = Math.max(
      this.nextSpawnAt[0],
      nowSec + TARGETS.respawnDelaySec,
    );
    const arch = this.slotArchetype[slot];
    this.events.emit(
      GameEvent.TargetPopped,
      this.slotWorldPos[base],
      this.slotWorldPos[base + 1],
      this.slotWorldPos[base + 2],
      packPopData(slot, arch, archetypeConfig(arch).points),
    );

    if (arch === Splotbot.DusterDuke) this.splitBoss(base, nowSec);
  }

  /** Two Mopsys burst out either side of a popped Duke. */
  private splitBoss(base: number, nowSec: number): void {
    if (!this.roundActive) return;
    this.player.head.getWorldPosition(this.headScratch);
    splitPositions(
      this.slotWorldPos[base],
      this.slotWorldPos[base + 2],
      this.headScratch.x,
      this.headScratch.z,
      SPLOTBOTS.boss.splitSpread,
      this.pairScratch,
    );
    // Up off the floor where a seated player can see them over the coffee table.
    const y = Math.max(
      TARGETS.heightMin,
      this.slotWorldPos[base + 1] +
        archetypeConfig(Splotbot.Mopsy).heightMeters * 0.5,
    );
    for (let k = 0; k < 2; k++) {
      const child = this.freeSlotOf(Splotbot.Mopsy);
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
  const cacheTag = `pb-splotbot:${rimGlsl}:${strength}:${power}:${env}`;
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
