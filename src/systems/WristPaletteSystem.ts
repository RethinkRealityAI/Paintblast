import {
  Quaternion,
  Vector3,
  createComponent,
  createSystem,
  setWorldPosition,
  setWorldQuaternion,
} from '@iwsdk/core';

import { PALETTE, WEB } from '../config';
import { buildFacingBasis, quatFromBasis, smoothingAlpha } from '../wrist-frame';
import { WristPose } from '../wrist-pose';

const DEG_TO_RAD = Math.PI / 180;

/**
 * Optional AssetManifest key for a modelled palette board.
 *
 * Drop `public/gltf/palette-board.glb` in, uncomment the manifest entry marked
 * ROUND3-PALETTE-ASSET in main.ts, and the board becomes that model instead of
 * the primitive oval. The dabs and chips are always built in code and always
 * parented to the same root, so tapping keeps working whatever the art is —
 * exactly the arrangement EASEL_ASSET_KEY uses for the easel.
 */
export const PALETTE_BOARD_ASSET_KEY = 'paletteBoard';

/**
 * Marks the single entity that parents the board, the four paint dabs, the five
 * ammo chips and their labels.
 *
 * main.ts builds it (see `seedWristPalette`); this system is the only thing
 * that writes its transform. Everything on the palette is a child, so it all
 * inherits the wrist pose for free and keeps its own PaintDab / KindChip /
 * RayInteractable / PokeInteractable / OneHandGrabbable setup untouched.
 */
export const PaletteRoot = createComponent('PaletteRoot', {});

/**
 * Which axis of a bounding box is thinnest: 0 = x, 1 = y, 2 = z.
 *
 * Round 7 found the palette-board GLB is authored **thin along Z** (1.9 x 1.32
 * x 0.23 model units) — a product shot turned into a slab facing the camera —
 * while the loader assumed Y was its thickness. So since round 3 the wooden
 * board has stood perpendicular to its own paint dabs. The loader now lays
 * whichever axis is thinnest onto the board normal, so any palette model works
 * however its exporter oriented it. Ties prefer Y (no rotation).
 */
export function thinnestAxis(sizeX: number, sizeY: number, sizeZ: number): number {
  const x = Math.abs(sizeX);
  const y = Math.abs(sizeY);
  const z = Math.abs(sizeZ);
  if (y <= x && y <= z) return 1;
  return z <= x ? 2 : 0;
}

/** The latch {@link stepPaletteLock} drives. Caller-owned; stepping allocates nothing. */
export interface PaletteLock {
  /** True while the palette is parked in world space. */
  locked: boolean;
  /** Seconds (caller's clock) at which the fingertip was last inside the radius. */
  lastNearSec: number;
}

/** A released lock. */
export function createPaletteLock(): PaletteLock {
  return { locked: false, lastNearSec: Number.NEGATIVE_INFINITY };
}

/**
 * Decide whether the palette is parked this frame.
 *
 * Parks the instant the poking fingertip is inside `lockRadius`; lets go only
 * once it has stayed outside for `releaseSec`. The asymmetry is the point: a
 * fingertip hovering at the edge of the radius, or a single frame of lost hand
 * tracking mid-poke, must not drop the board back onto a moving wrist under
 * the finger that is aiming at it.
 *
 * `distance` may be Infinity (no fingertip tracked this frame), which counts as
 * "outside" — and so still releases after the grace period rather than
 * parking the palette forever if the other hand drops out of view.
 *
 * Pure apart from mutating `lock`.
 *
 * @returns true when the lock was released on this exact call — the caller's
 *   cue to start gliding back onto the wrist.
 */
export function stepPaletteLock(
  lock: PaletteLock,
  distance: number,
  nowSec: number,
  lockRadius: number,
  releaseSec: number,
): boolean {
  if (distance < lockRadius) {
    lock.locked = true;
    lock.lastNearSec = nowSec;
    return false;
  }
  if (lock.locked && nowSec - lock.lastNearSec >= releaseSec) {
    lock.locked = false;
    return true;
  }
  return false;
}

/**
 * Straps the painter's palette to the player's left wrist.
 *
 * Field feedback, round 1: the palette lived at fixed world coordinates, which
 * put it behind, below or simply out of reach depending on where the player
 * happened to be standing. A palette you carry is always reachable.
 *
 * Field feedback, round 2: "it could be like an actual paint palette, and I
 * should just tap a colour". So the 4x4 grid of combined colour+kind orbs
 * became a flat oval board with paint dabs curving round its far edge and a
 * row of kind chips by the wrist — see main.ts's `seedWristPalette`.
 *
 * Field feedback, round 4: web mode hid the palette, because webbing was a
 * phase in which there was nothing to choose. Round 5 made webbing a chip *on*
 * the palette, so the board is now the only way back to paint — it is visible
 * and live in every phase, unconditionally, and there is deliberately no phase
 * subscription here any more. Hiding it would strand the player in web ammo.
 *
 * ### Round 7: hands are not controllers
 *
 * Rounds 2-6 copied the left **grip** pose onto the board, believing "IWSDK
 * poses grip spaces from the wrist joint, so there is one code path for
 * controllers and hands". The grip *exists* for hands, but the spec defines it
 * anatomically — -Z toward the thumb, +Y up the arm — which for an open hand is
 * a quarter turn away from a controller's, so the board tuned on controllers
 * stood on edge across the forearm in hand mode. And a bare hand rolls freely:
 * "above the back of the hand" is *under* the arm the moment the palm turns up.
 *
 * Controllers keep the tuned grip path untouched. Hands now go through
 * {@link WristPose}, which reads the wrist joint, and the board is posed in
 * world terms: {@link PALETTE.handLift} straight up from the wrist, nudged
 * toward the fingers and away from the body, turned to face the player's eyes
 * with its dab edge pointing the way the fingers do. Whatever the wrist is
 * doing, the palette is above it and readable.
 *
 * Round 7 also stops the board moving **while you poke it**. Meta's hands UI
 * guidance is explicit that wrist-anchored menus are hard to hit because they
 * shift under the other hand's finger; so when the right index fingertip (or
 * the right controller) comes within {@link PALETTE.lockRadius}, the palette
 * parks in world space, and glides back onto the wrist once the finger has
 * gone. See {@link stepPaletteLock}.
 *
 * Runs at priority 8, i.e. before BallSpawnSystem (10) reads palette presses
 * and before the panel-ray test looks at anything, so the dabs are already
 * where the player sees them when the frame's input is resolved.
 *
 * Zero allocations in update(): every scratch object is built in init().
 */
export class WristPaletteSystem extends createSystem({
  roots: { required: [PaletteRoot] },
}) {
  // Scratch — reused every frame, never reallocated.
  private gripPosition!: Vector3;
  private gripOrientation!: Quaternion;
  private localOffset!: Vector3;
  private targetPosition!: Vector3;
  private targetOrientation!: Quaternion;
  /** Constant pitch of the palette plane; built once from PALETTE.tiltDeg. */
  private tilt!: Quaternion;
  /** Hand-mode scratch: the head, the forearm's distal axis, the facing basis. */
  private headPosition!: Vector3;
  private distal!: Vector3;
  private sideways!: Vector3;
  private basis!: Float32Array;
  private quat!: Float32Array;
  /** The left wrist, read fresh each frame. */
  private wrist!: WristPose;
  /** Where the palette actually is: the target, or the parked pose, or between. */
  private shownPosition!: Vector3;
  private shownOrientation!: Quaternion;
  /** False until `shown*` holds a real pose. */
  private primed = false;
  /** True while gliding back onto the wrist after a park. */
  private gliding = false;
  private lock!: PaletteLock;
  private fingertip!: Vector3;

  init() {
    this.gripPosition = new Vector3();
    this.gripOrientation = new Quaternion();
    this.localOffset = new Vector3();
    this.targetPosition = new Vector3();
    this.targetOrientation = new Quaternion();
    this.shownPosition = new Vector3();
    this.shownOrientation = new Quaternion();
    this.fingertip = new Vector3();
    this.wrist = new WristPose('left');
    this.lock = createPaletteLock();

    this.tilt = new Quaternion().setFromAxisAngle(
      new Vector3(1, 0, 0),
      PALETTE.tiltDeg * DEG_TO_RAD,
    );
    this.headPosition = new Vector3();
    this.distal = new Vector3();
    this.sideways = new Vector3();
    this.basis = new Float32Array(9);
    this.quat = new Float32Array(4);
  }

  update(delta: number) {
    if (!this.computeTarget()) return;

    const nowSec = performance.now() / 1000;
    const released = stepPaletteLock(
      this.lock,
      this.fingertipDistance(),
      nowSec,
      PALETTE.lockRadius,
      PALETTE.lockReleaseSec,
    );
    if (released) this.gliding = true;

    if (!this.primed) {
      this.shownPosition.copy(this.targetPosition);
      this.shownOrientation.copy(this.targetOrientation);
      this.primed = true;
    } else if (this.lock.locked) {
      // Parked: leave shown* exactly where the finger found it.
    } else if (this.gliding) {
      const alpha = smoothingAlpha(delta, PALETTE.reattachSec);
      this.shownPosition.lerp(this.targetPosition, alpha);
      this.shownOrientation.slerp(this.targetOrientation, alpha);
      // Close enough to be indistinguishable: snap and stop gliding, so normal
      // tracking carries no smoothing lag at all.
      if (
        this.shownPosition.distanceToSquared(this.targetPosition) < 4e-6 &&
        this.shownOrientation.angleTo(this.targetOrientation) < 0.01
      ) {
        this.gliding = false;
      }
    } else {
      this.shownPosition.copy(this.targetPosition);
      this.shownOrientation.copy(this.targetOrientation);
    }

    for (const root of this.queries.roots.entities) {
      const object3D = root.object3D;
      if (!object3D) continue;
      setWorldPosition(object3D, this.shownPosition);
      setWorldQuaternion(object3D, this.shownOrientation);
    }
  }

  /**
   * Where the palette belongs on the wrist this frame, into `target*`.
   * @returns false when the left hand is not tracked — the palette stays put.
   */
  private computeTarget(): boolean {
    if (!this.wrist.update(this.player, this.input, WEB)) return false;

    if (this.wrist.isHand) return this.computeHandTarget();

    const grip = this.player?.gripSpaces?.left;
    if (!grip) return false;
    grip.getWorldPosition(this.gripPosition);
    grip.getWorldQuaternion(this.gripOrientation);

    this.localOffset
      .set(PALETTE.wristOffsetX, PALETTE.wristOffsetY, PALETTE.wristOffsetZ)
      .applyQuaternion(this.gripOrientation);
    this.targetPosition.copy(this.gripPosition).add(this.localOffset);
    this.targetOrientation.copy(this.gripOrientation).multiply(this.tilt);
    return true;
  }

  /**
   * Hand mode: above the wrist in world terms, facing the eyes. Writes
   * `target*`. @see PALETTE.handLift
   */
  private computeHandTarget(): boolean {
    const head = this.player?.head;
    if (!head) return false;
    head.getWorldPosition(this.headPosition);

    this.distal.set(0, 0, -1).applyQuaternion(this.wrist.wristQ);
    // Away from the body for a LEFT forearm is to its left: -(distal x up).
    this.sideways.set(this.distal.z, 0, -this.distal.x);
    const sideLen = this.sideways.length();
    if (sideLen > 1e-3) this.sideways.multiplyScalar(1 / sideLen);
    else this.sideways.set(0, 0, 0);

    this.targetPosition
      .copy(this.wrist.anchor)
      .addScaledVector(this.distal, PALETTE.handForward)
      .addScaledVector(this.sideways, PALETTE.handOutward);
    this.targetPosition.y += PALETTE.handLift;

    if (
      !buildFacingBasis(
        this.headPosition.x - this.targetPosition.x,
        this.headPosition.y - this.targetPosition.y,
        this.headPosition.z - this.targetPosition.z,
        this.distal.x,
        this.distal.y,
        this.distal.z,
        this.basis,
      )
    ) {
      return false;
    }
    quatFromBasis(this.basis, this.quat);
    this.targetOrientation.set(
      this.quat[0],
      this.quat[1],
      this.quat[2],
      this.quat[3],
    );
    return true;
  }

  /**
   * Distance from the palette's shown centre to the right hand's index
   * fingertip (the ray origin for a controller, which is where IWSDK parks the
   * "index tip" when there are no fingers). Infinity when the right hand is
   * not tracked.
   */
  private fingertipDistance(): number {
    if (!this.primed) return Number.POSITIVE_INFINITY;
    const tip = this.player?.indexTipSpaces?.right;
    const grip = this.player?.gripSpaces?.right;
    if (!tip || !grip || grip.visible === false) {
      return Number.POSITIVE_INFINITY;
    }
    tip.getWorldPosition(this.fingertip);
    return this.fingertip.distanceTo(this.shownPosition);
  }
}
