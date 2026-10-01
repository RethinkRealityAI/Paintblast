import { Quaternion, Vector3 } from '@iwsdk/core';
import type { Object3D } from '@iwsdk/core';

import {
  blendAim,
  buildAimBasis,
  handGripToWristBasis,
  handMirror,
  quatFromBasis,
  rotateByQuat,
} from './wrist-frame';

/**
 * The slice of IWSDK's input manager WristPose reads. Structural rather than
 * imported, so this file depends on behaviour rather than on @iwsdk/xr-input's
 * class layout.
 */
export interface WristPoseInput {
  isPrimary(deviceType: 'controller' | 'hand', side: 'left' | 'right'): boolean;
  visualAdapters: {
    hand: {
      left?: WristPoseHandAdapter;
      right?: WristPoseHandAdapter;
    };
  };
}

/** One hand's visual adapter: joint names, and their grip-relative matrices. */
export interface WristPoseHandAdapter {
  jointSpaces: ReadonlyArray<{ jointName?: string }>;
  /** 16 floats per joint, column-major, relative to the hand's grip space. */
  jointTransforms?: Float32Array;
}

/** The slice of IWSDK's XROrigin WristPose reads. */
export interface WristPosePlayer {
  gripSpaces: { left: Object3D; right: Object3D };
  raySpaces: { left: Object3D; right: Object3D };
}

/**
 * Is this side currently driven by a tracked hand or a connected controller?
 *
 * The only reliable tracking signal in IWSDK 0.3.1 — its grip, ray and
 * index-tip spaces are never hidden, they just freeze at the last pose.
 */
export function isTracked(
  input: Pick<WristPoseInput, 'isPrimary'>,
  side: 'left' | 'right',
): boolean {
  return input.isPrimary('hand', side) || input.isPrimary('controller', side);
}

/** Where a tracked hand's aim comes from. @see WEB.handAimSource */
export type HandAimSource = 'ray' | 'hand';

/** Tunables WristPose needs, passed in so this file never imports config. */
export interface WristPoseConfig {
  /** Tracked-hand aim: the OS target ray, or the hand's own distal axis. */
  readonly handAimSource: HandAimSource;
  /**
   * Controllers have no wrist joint. Metres from the grip origin back up the
   * forearm (wrist-frame +Z) to where the wrist is assumed to be.
   */
  readonly controllerWristBack: number;
  /**
   * With `handAimSource: 'ray'`: within this many degrees of the hand's own
   * axis the OS ray is used outright; beyond `rayBlendFarDeg` the hand's axis
   * is. Smoothstep between. @see blendAim
   */
  readonly rayBlendNearDeg: number;
  readonly rayBlendFarDeg: number;
}

const DEG_TO_RAD = Math.PI / 180;

/**
 * Per-frame wrist pose for one hand — the runtime half of `wrist-frame.ts`.
 *
 * Owned by a system (one per hand), refreshed once per frame with
 * {@link update}, then read from. Every output is a field built in the
 * constructor, so a frame of updates allocates nothing.
 *
 * ### Two input modes, one answer
 *
 * - **Tracked hand.** The wrist *joint* is the ground truth. WebXR Hand Input
 *   defines every joint frame identically on both hands (-Z along the bone
 *   toward the fingertips, +Y out of the back of the hand), and IWSDK hands us
 *   the joints relative to the grip — so grip x joint is the joint's world
 *   pose whatever convention the runtime used for the grip itself. That
 *   matters: the emulator, for one, does not mirror the right hand's grip.
 *   The spec's grip anatomy is only a fallback for a frame with no joints.
 * - **Controller.** No joints. The aim is the controller's own target ray —
 *   the direction the trigger has always fired along — and the dorsal side is
 *   the grip's X mirrored per the spec (+X is the back of the right hand, -X
 *   the back of the left). The wrist is assumed a fixed distance behind the
 *   grip, back along that ray.
 *
 * ### Outputs
 *
 * - `anchor`: the wrist, world space.
 * - `palm`: the palm centroid (the grip origin, in both modes).
 * - `wristQ`: the anatomical wrist frame (+Y dorsal, -Z distal). The palette
 *   mounts in this one: it is strapped to the hand, not to the aim.
 * - `aim`: unit direction a shot from this wrist travels.
 * - `aimQ`: -Z is `aim`, +Y is as dorsal as orthogonality allows. The shooter
 *   mounts in this one, which is what makes it point exactly where it fires.
 */
export class WristPose {
  readonly anchor = new Vector3();
  readonly palm = new Vector3();
  readonly aim = new Vector3(0, 0, -1);
  readonly wristQ = new Quaternion();
  readonly aimQ = new Quaternion();
  /** True when the last update produced a pose. */
  valid = false;
  /** True when the last pose came from a tracked hand rather than a controller. */
  isHand = false;

  private readonly side: 'left' | 'right';
  private readonly hand: number;
  private readonly gripPos = new Vector3();
  private readonly gripQ = new Quaternion();
  private readonly rayQ = new Quaternion();
  private readonly localQ = new Quaternion();
  private readonly offset = new Vector3();
  private readonly basis = new Float32Array(9);
  private readonly quat = new Float32Array(4);
  private readonly vec = new Float32Array(3);
  /** Cached index of 'wrist' in the adapter's joint order; -1 unknown. */
  private wristJoint = -1;

  constructor(side: 'left' | 'right') {
    this.side = side;
    this.hand = side === 'left' ? 0 : 1;
  }

  /**
   * Refresh every output from this frame's input state.
   *
   * @returns false (and `valid = false`) when the grip is missing or hidden —
   *   a disconnected controller or a hand that lost tracking. Callers should
   *   park whatever they pose rather than snap it to the world origin.
   */
  update(
    player: WristPosePlayer | undefined,
    input: WristPoseInput | undefined,
    cfg: WristPoseConfig,
  ): boolean {
    const grip = player?.gripSpaces?.[this.side];
    // Tracking is read from the input manager, never from `grip.visible`:
    // IWSDK 0.3.1 never hides grip, ray or fingertip spaces — a hand that
    // drops out just leaves them frozen at its last pose — but it does stop
    // reporting the source as primary. Without this, a dropped hand fell
    // through to the controller branch with a stale grip and every "tracking
    // lost" reset downstream was dead code.
    if (!grip || !input || !isTracked(input, this.side)) {
      this.valid = false;
      return false;
    }
    grip.getWorldPosition(this.gripPos);
    grip.getWorldQuaternion(this.gripQ);
    this.palm.copy(this.gripPos);

    const ray = player?.raySpaces?.[this.side];
    if (ray) ray.getWorldQuaternion(this.rayQ);
    else this.rayQ.copy(this.gripQ);

    this.isHand = input.isPrimary('hand', this.side);
    if (this.isHand) {
      this.poseHandWrist(input);
      // Hand aim: the hand's own distal axis, or the OS ray blended onto it
      // by agreement (see blendAim for why not the raw ray).
      this.aim.set(0, 0, -1).applyQuaternion(this.wristQ);
      if (cfg.handAimSource === 'ray') {
        this.offset.set(0, 0, -1).applyQuaternion(this.rayQ);
        blendAim(
          this.aim.x,
          this.aim.y,
          this.aim.z,
          this.offset.x,
          this.offset.y,
          this.offset.z,
          cfg.rayBlendNearDeg * DEG_TO_RAD,
          cfg.rayBlendFarDeg * DEG_TO_RAD,
          this.vec,
        );
        this.aim.set(this.vec[0], this.vec[1], this.vec[2]);
      }
    } else {
      this.poseController(cfg);
    }

    this.buildAimFrame();
    this.valid = true;
    return true;
  }

  /**
   * Tracked hand: the wrist joint if the adapter has one, the spec's grip
   * anatomy if not. Writes `wristQ` and `anchor`.
   */
  private poseHandWrist(input: WristPoseInput): void {
    const adapter = input.visualAdapters?.hand?.[this.side];
    const transforms = adapter?.jointTransforms;
    const joint = adapter && transforms ? this.resolveWrist(adapter) : -1;

    if (joint >= 0 && transforms && joint * 16 + 15 < transforms.length) {
      const o = joint * 16;
      // Column-major: X axis [0..2], Y [4..6], Z [8..10], translation [12..14].
      this.basis[0] = transforms[o];
      this.basis[1] = transforms[o + 1];
      this.basis[2] = transforms[o + 2];
      this.basis[3] = transforms[o + 4];
      this.basis[4] = transforms[o + 5];
      this.basis[5] = transforms[o + 6];
      this.basis[6] = transforms[o + 8];
      this.basis[7] = transforms[o + 9];
      this.basis[8] = transforms[o + 10];
      quatFromBasis(this.basis, this.quat);
      this.localQ
        .set(this.quat[0], this.quat[1], this.quat[2], this.quat[3])
        .normalize();
      this.wristQ.copy(this.gripQ).multiply(this.localQ);

      this.offset
        .set(transforms[o + 12], transforms[o + 13], transforms[o + 14])
        .applyQuaternion(this.gripQ);
      this.anchor.copy(this.gripPos).add(this.offset);
      return;
    }

    handGripToWristBasis(this.hand, this.basis);
    quatFromBasis(this.basis, this.quat);
    this.localQ.set(this.quat[0], this.quat[1], this.quat[2], this.quat[3]);
    this.wristQ.copy(this.gripQ).multiply(this.localQ);
    // The grip origin sits in the palm; the wrist joint is ~6.5 cm up the arm
    // and ~3.6 cm toward the back of the hand from it (measured off Meta's
    // captured relaxed-hand pose that the emulator ships).
    this.offset.set(0, 0.036, 0.065).applyQuaternion(this.wristQ);
    this.anchor.copy(this.gripPos).add(this.offset);
  }

  /**
   * Controller: aim along the target ray, dorsal from the mirrored grip X, and
   * the wrist a fixed distance back up the arm from the grip.
   */
  private poseController(cfg: WristPoseConfig): void {
    this.aim.set(0, 0, -1).applyQuaternion(this.rayQ);

    const mirror = handMirror(this.hand);
    rotateByQuat(
      this.gripQ.x,
      this.gripQ.y,
      this.gripQ.z,
      this.gripQ.w,
      mirror,
      0,
      0,
      this.vec,
    );
    if (
      buildAimBasis(
        this.aim.x,
        this.aim.y,
        this.aim.z,
        this.vec[0],
        this.vec[1],
        this.vec[2],
        this.basis,
      )
    ) {
      quatFromBasis(this.basis, this.quat);
      this.wristQ.set(this.quat[0], this.quat[1], this.quat[2], this.quat[3]);
    } else {
      this.wristQ.copy(this.gripQ);
    }

    this.offset.set(0, 0, cfg.controllerWristBack).applyQuaternion(this.wristQ);
    this.anchor.copy(this.gripPos).add(this.offset);
  }

  /** `aimQ` from `aim` and the dorsal axis of `wristQ`. */
  private buildAimFrame(): void {
    rotateByQuat(
      this.wristQ.x,
      this.wristQ.y,
      this.wristQ.z,
      this.wristQ.w,
      0,
      1,
      0,
      this.vec,
    );
    if (
      buildAimBasis(
        this.aim.x,
        this.aim.y,
        this.aim.z,
        this.vec[0],
        this.vec[1],
        this.vec[2],
        this.basis,
      )
    ) {
      quatFromBasis(this.basis, this.quat);
      this.aimQ.set(this.quat[0], this.quat[1], this.quat[2], this.quat[3]);
    } else {
      this.aimQ.copy(this.wristQ);
    }
  }

  /** Cache the adapter's index for 'wrist'; re-resolved on a name mismatch. */
  private resolveWrist(adapter: WristPoseHandAdapter): number {
    const spaces = adapter.jointSpaces;
    if (spaces[this.wristJoint]?.jointName === 'wrist') return this.wristJoint;
    this.wristJoint = -1;
    for (let i = 0; i < spaces.length; i++) {
      if (spaces[i]?.jointName === 'wrist') {
        this.wristJoint = i;
        break;
      }
    }
    return this.wristJoint;
  }
}
