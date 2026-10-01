/**
 * Pure wrist-frame math: everything the game straps to a forearm is posed in
 * one of the frames built here.
 *
 * ### Why this file exists (round 7)
 *
 * Rounds 4-6 posed the web shooters, the wrist palette and the gesture aim
 * straight off the WebXR **grip** space and assumed its -Z was "the way the hand
 * points". That is roughly true for a controller and badly false for a tracked
 * hand. The spec defines grip space anatomically, for both:
 *
 * > -Z runs along a rod held in the fist, *toward the thumb*; X is
 * > perpendicular to the back of the hand (+X = back of the right hand,
 * > -X = back of the left); +Y points roughly *up the arm*.
 *
 * With a controller in a handshake grip the thumb points up-and-forward, so
 * "-Z is forward" was a 45-degree fib that nobody noticed. With an open hand the
 * thumb points sideways, across the wrist — so the shooters sat perpendicular
 * to the forearm and webs flew out toward the thumb. That was the field report.
 *
 * The fix is to stop treating any raw XR space as the mount frame, and to build
 * two frames explicitly:
 *
 * - the **wrist frame**: origin at the wrist, +Y out of the back of the hand
 *   (dorsal), -Z down the forearm toward the fingers (distal), +X = Y x Z
 *   (thumb side on the left hand, pinky side on the right — the same mirror
 *   convention every X offset in this project already uses);
 * - the **aim frame**: the same up-reference, but -Z is exactly the direction
 *   a shot will travel. Anything that must *look* like where it shoots — the
 *   shooter, its nozzle, the strand — is posed in this one.
 *
 * Everything here is plain arithmetic on numbers and caller-owned arrays: no
 * three.js, no IWSDK, no allocation. That keeps it unit-testable under the
 * Vitest mock (whose Vector3 is a stub) and safe to call per frame.
 */

/** -1 for the left hand, +1 for the right. @see wrist-frame module docs */
export function handMirror(hand: number): number {
  return hand === 0 ? -1 : 1;
}

/**
 * Rotate (vx, vy, vz) by the unit quaternion (qx, qy, qz, qw) and write the
 * result into `out[offset..offset+2]`.
 *
 * The standard `v' = v + 2w(q x v) + 2 q x (q x v)` form — two cross products,
 * no matrix, no allocation.
 */
export function rotateByQuat(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  vx: number,
  vy: number,
  vz: number,
  out: Float32Array | number[],
  offset = 0,
): void {
  // t = 2 * (q x v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  // v' = v + w * t + q x t
  out[offset] = vx + qw * tx + (qy * tz - qz * ty);
  out[offset + 1] = vy + qw * ty + (qz * tx - qx * tz);
  out[offset + 2] = vz + qw * tz + (qx * ty - qy * tx);
}

/**
 * Build an orthonormal frame whose -Z is `forward` and whose +Y leans as far
 * toward `upHint` as orthogonality allows.
 *
 * Writes the three axes into `out` as consecutive columns: X at [0..2], Y at
 * [3..5], Z at [6..8]. `forward` need not be unit length; `upHint` need not be
 * unit length or perpendicular to it — it is Gram-Schmidted against the
 * forward axis, which is exactly what you want for "keep the device's top on
 * the back of the hand, but point it where the shot goes".
 *
 * Degenerate hints are survivable rather than fatal: if `upHint` is (nearly)
 * parallel to `forward` — a fist pointed straight at the ceiling with the back
 * of the hand facing the same way, say — world up is tried next, then world
 * +Z. A frame that briefly spins is far better than a NaN that poisons the
 * shooter's transform for the rest of the session.
 *
 * @returns false only when `forward` itself is (nearly) zero.
 */
export function buildAimBasis(
  forwardX: number,
  forwardY: number,
  forwardZ: number,
  upX: number,
  upY: number,
  upZ: number,
  out: Float32Array | number[],
): boolean {
  const fLen = Math.sqrt(
    forwardX * forwardX + forwardY * forwardY + forwardZ * forwardZ,
  );
  if (!(fLen > 1e-6)) return false;

  // Z = -forward
  const zx = -forwardX / fLen;
  const zy = -forwardY / fLen;
  const zz = -forwardZ / fLen;

  // Y = hint minus its component along Z, falling back through two spares.
  let yx = 0;
  let yy = 0;
  let yz = 0;
  let yLen = 0;
  for (let attempt = 0; attempt < 3 && yLen < 1e-3; attempt++) {
    let hx = upX;
    let hy = upY;
    let hz = upZ;
    if (attempt === 1) {
      hx = 0;
      hy = 1;
      hz = 0;
    } else if (attempt === 2) {
      hx = 0;
      hy = 0;
      hz = 1;
    }
    const along = hx * zx + hy * zy + hz * zz;
    yx = hx - along * zx;
    yy = hy - along * zy;
    yz = hz - along * zz;
    yLen = Math.sqrt(yx * yx + yy * yy + yz * yz);
  }
  yx /= yLen;
  yy /= yLen;
  yz /= yLen;

  // X = Y x Z, which keeps the frame right-handed.
  out[0] = yy * zz - yz * zy;
  out[1] = yz * zx - yx * zz;
  out[2] = yx * zy - yy * zx;
  out[3] = yx;
  out[4] = yy;
  out[5] = yz;
  out[6] = zx;
  out[7] = zy;
  out[8] = zz;
  return true;
}

/**
 * Unit quaternion (x, y, z, w) for the rotation whose columns are the basis
 * in `basis` (X at [0..2], Y at [3..5], Z at [6..8] — the layout
 * {@link buildAimBasis} writes). Written into `out[0..3]`.
 *
 * Shepperd's method, the same branch structure as three's
 * `Quaternion.setFromRotationMatrix`, so it agrees with the renderer on which
 * of the two equivalent signs it picks.
 */
export function quatFromBasis(
  basis: ArrayLike<number>,
  out: Float32Array | number[],
): void {
  // Row/column naming: mRC = row R, column C. Column C is axis C.
  const m00 = basis[0];
  const m10 = basis[1];
  const m20 = basis[2];
  const m01 = basis[3];
  const m11 = basis[4];
  const m21 = basis[5];
  const m02 = basis[6];
  const m12 = basis[7];
  const m22 = basis[8];
  const trace = m00 + m11 + m22;

  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    out[3] = 0.25 / s;
    out[0] = (m21 - m12) * s;
    out[1] = (m02 - m20) * s;
    out[2] = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    out[3] = (m21 - m12) / s;
    out[0] = 0.25 * s;
    out[1] = (m01 + m10) / s;
    out[2] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    out[3] = (m02 - m20) / s;
    out[0] = (m01 + m10) / s;
    out[1] = 0.25 * s;
    out[2] = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    out[3] = (m10 - m01) / s;
    out[0] = (m02 + m20) / s;
    out[1] = (m12 + m21) / s;
    out[2] = 0.25 * s;
  }
}

/**
 * Per-frame blend factor for an exponential smoother with time constant
 * `tauSec`: `value += (target - value) * alpha`.
 *
 * Frame-rate independent by construction, so a 72 Hz and a 120 Hz headset
 * settle at the same speed. A non-positive time constant means "no smoothing"
 * and returns 1; a non-positive frame time returns 0 (hold still).
 */
export function smoothingAlpha(deltaSec: number, tauSec: number): number {
  if (!(tauSec > 0)) return 1;
  if (!(deltaSec > 0)) return 0;
  return 1 - Math.exp(-deltaSec / tauSec);
}

/**
 * The canonical wrist frame, expressed in a **hand-tracking grip** space, per
 * hand. Used only when a tracked hand delivers a grip pose but no usable wrist
 * joint (the joint frame is preferred — see WristPose).
 *
 * Straight from the spec's anatomy: distal is grip -Y, dorsal is +X on the
 * right hand and -X on the left. So the wrist frame's axes, as grip-space
 * columns, are:
 *
 * - right: X = +Z_grip (pinky side), Y = +X_grip (dorsal), Z = +Y_grip
 * - left:  X = -Z_grip (thumb side), Y = -X_grip (dorsal), Z = +Y_grip
 *
 * Both are proper rotations (determinant +1), which the tests pin down.
 * Written as a basis into `out` in {@link buildAimBasis}'s column layout.
 */
export function handGripToWristBasis(
  hand: number,
  out: Float32Array | number[],
): void {
  const m = handMirror(hand);
  // X column
  out[0] = 0;
  out[1] = 0;
  out[2] = m;
  // Y column
  out[3] = m;
  out[4] = 0;
  out[5] = 0;
  // Z column
  out[6] = 0;
  out[7] = 1;
  out[8] = 0;
}

/** The two numbers {@link ballisticAim} needs about the projectile. */
export interface BallisticConfig {
  /** Launch speed, m/s. */
  readonly speed: number;
  /** Downward acceleration, m/s^2 (already multiplied by any gravity factor). */
  readonly gravity: number;
}

/**
 * Launch direction that makes a projectile fired at `cfg.speed` under
 * `cfg.gravity` pass through the target point — the low (flat) arc, which is
 * the one that looks like a shot rather than a lob.
 *
 * Writes a unit direction into `out[0..2]`.
 *
 * @returns false when the target is out of range at this speed (no real
 *   solution), or is straight above/below the origin.
 */
export function ballisticAim(
  ox: number,
  oy: number,
  oz: number,
  tx: number,
  ty: number,
  tz: number,
  cfg: BallisticConfig,
  out: Float32Array | number[],
): boolean {
  const dx = tx - ox;
  const dy = ty - oy;
  const dz = tz - oz;
  const horizontal = Math.sqrt(dx * dx + dz * dz);
  if (!(horizontal > 1e-4)) return false;

  const v = cfg.speed;
  const g = cfg.gravity;
  const hx = dx / horizontal;
  const hz = dz / horizontal;

  if (!(g > 1e-6)) {
    // No gravity: aim straight at it.
    const len = Math.sqrt(horizontal * horizontal + dy * dy);
    out[0] = dx / len;
    out[1] = dy / len;
    out[2] = dz / len;
    return true;
  }

  const v2 = v * v;
  const disc = v2 * v2 - g * (g * horizontal * horizontal + 2 * dy * v2);
  if (disc < 0) return false;

  const tanTheta = (v2 - Math.sqrt(disc)) / (g * horizontal);
  const cos = 1 / Math.sqrt(1 + tanTheta * tanTheta);
  const sin = tanTheta * cos;
  out[0] = hx * cos;
  out[1] = sin;
  out[2] = hz * cos;
  return true;
}

/** Everything {@link pickAssistedAim} compares candidates against. */
export interface AimAssistConfig extends BallisticConfig {
  /** Widest correction allowed, radians. Zero disables assist outright. */
  readonly maxAngleRad: number;
  /** Targets beyond this many metres are ignored. */
  readonly maxRange: number;
}

/**
 * Gentle aim assist: if a live target sits within `cfg.maxAngleRad` of where
 * the player is aiming, bend the shot onto the ballistic arc that hits it.
 *
 * "Within the cone" is judged against **whichever is closer**: the straight
 * line to the target, or the corrected arc. Paint drops about 0.6 m over
 * three metres — some 12 degrees — so a newcomer pointing straight at a robot
 * and a regular who has learned to lead the drop are aiming a long way apart,
 * and both deserve the hit. Either way the shot leaves on the arc.
 *
 * Hand tracking is centimetre-noisy and a thrust or a thwip moves the very arm
 * that is aiming; Meta's hands guidance is explicit that targeting should be
 * forgiving. The cone is small by default and the correction is invisible when
 * no target is near, so a player who aims well never feels it.
 *
 * `positions` holds xyz per slot; `active[slot]` non-zero marks a live target.
 * The chosen unit direction is written into `out[0..2]` (left untouched when
 * nothing qualifies).
 *
 * @returns the slot index that was assisted toward, or -1.
 */
export function pickAssistedAim(
  ox: number,
  oy: number,
  oz: number,
  aimX: number,
  aimY: number,
  aimZ: number,
  positions: ArrayLike<number>,
  active: ArrayLike<number>,
  count: number,
  cfg: AimAssistConfig,
  scratch: Float32Array | number[],
  out: Float32Array | number[],
): number {
  if (!(cfg.maxAngleRad > 0)) return -1;
  const aimLen = Math.sqrt(aimX * aimX + aimY * aimY + aimZ * aimZ);
  if (!(aimLen > 1e-6)) return -1;
  const ax = aimX / aimLen;
  const ay = aimY / aimLen;
  const az = aimZ / aimLen;

  const minCos = Math.cos(cfg.maxAngleRad);
  const maxRangeSq = cfg.maxRange * cfg.maxRange;
  let best = -1;
  let bestCos = minCos;

  for (let slot = 0; slot < count; slot++) {
    if (!active[slot]) continue;
    const base = slot * 3;
    const tx = positions[base];
    const ty = positions[base + 1];
    const tz = positions[base + 2];
    const dx = tx - ox;
    const dy = ty - oy;
    const dz = tz - oz;
    if (dx * dx + dy * dy + dz * dz > maxRangeSq) continue;
    if (!ballisticAim(ox, oy, oz, tx, ty, tz, cfg, scratch)) continue;

    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const cosLine =
      dist > 1e-6 ? (ax * dx + ay * dy + az * dz) / dist : -1;
    const cosArc = ax * scratch[0] + ay * scratch[1] + az * scratch[2];
    const cos = cosLine > cosArc ? cosLine : cosArc;
    if (cos > bestCos) {
      bestCos = cos;
      best = slot;
      out[0] = scratch[0];
      out[1] = scratch[1];
      out[2] = scratch[2];
    }
  }
  return best;
}

/** What {@link pullReel} needs to turn arm motion into line. */
export interface PullReelConfig {
  /** Hand speed away from the target, m/s, ignored as tracking noise. */
  readonly pullDeadband: number;
  /** Metres of line taken in per metre the hand travels away from the target. */
  readonly pullGain: number;
}

/**
 * How much line one frame of hauling takes in, metres.
 *
 * Round 6 reeled in fixed 0.55 m chunks whenever the hand crossed a speed
 * threshold, and the robot *teleported* each chunk — which is what "the hook
 * feels janky" was describing. This replaces the chunk with a ratchet that is
 * proportional to the pull itself: move your hand 20 cm away from the robot and
 * the line comes in `20 cm x pullGain`, however fast or slow you did it.
 *
 * `speedAway` is the hand's velocity projected onto the target-to-hand
 * direction (positive = pulling). Pushing back toward the robot projects
 * negative and takes in nothing, which is what makes hand-over-hand hauling
 * work: the recovery stroke is free. The deadband is subtracted rather than
 * gated, so the reel ramps in smoothly instead of switching on with a jolt.
 */
export function pullReel(
  speedAway: number,
  deltaSec: number,
  cfg: PullReelConfig,
): number {
  if (!(deltaSec > 0)) return 0;
  const effective = speedAway - cfg.pullDeadband;
  if (!(effective > 0)) return 0;
  return effective * deltaSec * cfg.pullGain;
}

/**
 * Feed a queued amount of line out at a bounded speed.
 *
 * Every reel source — the pull ratchet, a held pinch or squeeze — adds to a
 * per-hand queue; this decides how much of it the robot actually travels this
 * frame. Bounding the rate is what turns a big haul into a short glide rather
 * than a jump, and the result is never more than what is queued.
 *
 * @returns metres to move the target this frame (0..queued).
 */
export function drainReelQueue(
  queued: number,
  maxSpeed: number,
  deltaSec: number,
): number {
  if (!(queued > 0) || !(deltaSec > 0)) return 0;
  if (!(maxSpeed > 0)) return queued;
  return Math.min(queued, maxSpeed * deltaSec);
}

/**
 * Blend a tracked hand's own distal axis toward the OS target ray, by how
 * much the two agree. Writes a unit direction into `out[0..2]`.
 *
 * Why not just the ray: on Quest the hand ray is the shoulder-through-hand
 * pointer the system UI uses — steady, and down the forearm when the arm is
 * out in front, which is when you shoot. But it stays a *pointer* whatever the
 * hand is doing, so when the player turns a hand up to look at it the ray
 * swings off at an angle the forearm never makes, and a gauntlet slaved to it
 * would visibly peel off the arm. So: within `nearRad` of each other the ray
 * wins outright; beyond `farRad` the hand's own axis does; in between it is a
 * smoothstep, so nothing ever snaps.
 *
 * Inputs need not be unit length. Falls back to whichever is non-zero.
 */
export function blendAim(
  handX: number,
  handY: number,
  handZ: number,
  rayX: number,
  rayY: number,
  rayZ: number,
  nearRad: number,
  farRad: number,
  out: Float32Array | number[],
): void {
  const hLen = Math.sqrt(handX * handX + handY * handY + handZ * handZ);
  const rLen = Math.sqrt(rayX * rayX + rayY * rayY + rayZ * rayZ);
  if (!(rLen > 1e-6) && !(hLen > 1e-6)) {
    out[0] = 0;
    out[1] = 0;
    out[2] = -1;
    return;
  }
  if (!(hLen > 1e-6)) {
    out[0] = rayX / rLen;
    out[1] = rayY / rLen;
    out[2] = rayZ / rLen;
    return;
  }
  if (!(rLen > 1e-6)) {
    out[0] = handX / hLen;
    out[1] = handY / hLen;
    out[2] = handZ / hLen;
    return;
  }
  const hx = handX / hLen;
  const hy = handY / hLen;
  const hz = handZ / hLen;
  const rx = rayX / rLen;
  const ry = rayY / rLen;
  const rz = rayZ / rLen;

  const cos = hx * rx + hy * ry + hz * rz;
  const cosNear = Math.cos(nearRad);
  const cosFar = Math.cos(farRad);
  let t = cosNear > cosFar ? (cos - cosFar) / (cosNear - cosFar) : cos >= cosNear ? 1 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const w = t * t * (3 - 2 * t); // smoothstep: weight on the ray

  let x = hx + (rx - hx) * w;
  let y = hy + (ry - hy) * w;
  let z = hz + (rz - hz) * w;
  const len = Math.sqrt(x * x + y * y + z * z);
  if (!(len > 1e-6)) {
    // Exactly opposed and exactly half-way: take the hand, it is on the arm.
    x = hx;
    y = hy;
    z = hz;
  } else {
    x /= len;
    y /= len;
    z /= len;
  }
  out[0] = x;
  out[1] = y;
  out[2] = z;
}

/**
 * A frame whose +Y is exactly `normal` and whose -Z leans as far toward
 * `forward` as orthogonality allows — the converse of {@link buildAimBasis},
 * for something that must *face* a point (a palette facing the eyes) while
 * keeping a sense of direction (its far edge toward the fingers).
 *
 * Same column layout as {@link buildAimBasis}. A `forward` parallel to the
 * normal falls back to world -Z, then world +X.
 *
 * @returns false only when `normal` is (nearly) zero.
 */
export function buildFacingBasis(
  normalX: number,
  normalY: number,
  normalZ: number,
  forwardX: number,
  forwardY: number,
  forwardZ: number,
  out: Float32Array | number[],
): boolean {
  const nLen = Math.sqrt(normalX * normalX + normalY * normalY + normalZ * normalZ);
  if (!(nLen > 1e-6)) return false;
  const yx = normalX / nLen;
  const yy = normalY / nLen;
  const yz = normalZ / nLen;

  let zx = 0;
  let zy = 0;
  let zz = 0;
  let zLen = 0;
  for (let attempt = 0; attempt < 3 && zLen < 1e-3; attempt++) {
    let fx = forwardX;
    let fy = forwardY;
    let fz = forwardZ;
    if (attempt === 1) {
      fx = 0;
      fy = 0;
      fz = -1;
    } else if (attempt === 2) {
      fx = 1;
      fy = 0;
      fz = 0;
    }
    const along = fx * yx + fy * yy + fz * yz;
    // Z is minus the forward component perpendicular to Y.
    zx = -(fx - along * yx);
    zy = -(fy - along * yy);
    zz = -(fz - along * yz);
    zLen = Math.sqrt(zx * zx + zy * zy + zz * zz);
  }
  zx /= zLen;
  zy /= zLen;
  zz /= zLen;

  out[0] = yy * zz - yz * zy;
  out[1] = yz * zx - yx * zz;
  out[2] = yx * zy - yy * zx;
  out[3] = yx;
  out[4] = yy;
  out[5] = yz;
  out[6] = zx;
  out[7] = zy;
  out[8] = zz;
  return true;
}
