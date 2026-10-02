import {
  Quaternion,
  Vector3,
  createComponent,
  createSystem,
  setWorldPosition,
  setWorldQuaternion,
} from '@iwsdk/core';
import type { Object3D } from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import { PALETTE, WEB } from '../config';
import { BallKind, BallStyle, BlasterMode, appearFrame } from '../types';
import { buildFacingBasis, quatFromBasis, smoothingAlpha } from '../wrist-frame';
import { WristPose, isTracked } from '../wrist-pose';

/** The slice of a three material the palette animates. */
interface FadeMaterial {
  opacity: number;
}
/** ...and of a lit one, for the paint's inner glow. */
interface GlowMaterial {
  emissiveIntensity: number;
}

/**
 * Handles to the holo palette's animated decoration, built once by main.ts's
 * `seedWristPalette` and hung on the palette root's `userData.paletteVisuals`.
 * Everything here is decoration — never an entity, never pressable — so the
 * system may fade and pulse it freely without touching selection state, which
 * BallSpawnSystem owns (dab / chip / pad scale and chip emissive).
 */
export interface PaletteVisuals {
  /** The soft additive halo round the neon edge (shimmers). */
  edgeGlow?: FadeMaterial;
  /** The crisp neon line itself (fades in on appear). */
  edgeLine?: FadeMaterial;
  /** One per paint dab, in PALETTE_DAB_ORDER. */
  wells: Array<{
    color: readonly [number, number, number, number];
    rim: FadeMaterial;
    glow: FadeMaterial;
    paint: GlowMaterial;
  }>;
  /** One per ammo chip, in PALETTE_CHIP_ORDER. */
  chipSockets: Array<{ kind: BallKind; style: BallStyle; rim: FadeMaterial }>;
  /** One per launcher pad, in BLASTER_MODE_ORDER. */
  padSockets: Array<{ mode: BlasterMode; rim: FadeMaterial }>;
}

/** userData key main.ts stores {@link PaletteVisuals} under. */
export const PALETTE_VISUALS_KEY = 'paletteVisuals';

/** Squared colour distance under which a dab counts as the loaded colour. */
const SAME_COLOR_EPS = 1e-4;

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

/** The holo visuals main.ts hung on a palette root, if any. */
function paletteVisualsOf(object3D: Object3D | undefined): PaletteVisuals | undefined {
  return object3D?.userData?.[PALETTE_VISUALS_KEY] as PaletteVisuals | undefined;
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

  // ---- Round 8: visibility, appear pop and idle shimmer ---------------------
  /** Seconds since the left hand was last tracked (0 while tracked). */
  private lostSec = 0;
  /** Whether the palette is currently shown. Starts hidden until first tracked. */
  private shown = false;
  /** Seconds into the current appear animation; >= appearSec when settled. */
  private appearElapsed = Number.POSITIVE_INFINITY;
  /** Scratch out-param for appearFrame. */
  private readonly appear = { scale: 1, glow: 1 };
  /** Shimmer clock, seconds. */
  private shimmerSec = 0;
  private activeColor?: Signal<readonly [number, number, number, number]>;
  private activeKind?: Signal<BallKind>;
  private activeStyle?: Signal<BallStyle>;
  private blasterMode?: Signal<BlasterMode>;

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

    // Read-only views of the loadout, for lighting the loaded well / socket.
    // Optional: a test world without them simply never lights one.
    const globals = this.globals as Record<string, unknown>;
    this.activeColor = globals.activeColor as typeof this.activeColor;
    this.activeKind = globals.activeKind as typeof this.activeKind;
    this.activeStyle = globals.activeStyle as typeof this.activeStyle;
    this.blasterMode = globals.blasterMode as typeof this.blasterMode;

    // A new palette starts hidden; the first tracked frame pops it in.
    this.cleanupFuncs.push(
      this.queries.roots.subscribe('qualify', (root) => {
        const object3D = root.object3D;
        if (!object3D || this.shown) return;
        object3D.visible = false;
        object3D.scale.setScalar(1e-4);
      }),
    );
  }

  update(delta: number) {
    this.shimmerSec += delta;
    if (!this.computeTarget()) {
      // Lost hand: hold the pose, and after a grace period hide the board so
      // it never hangs frozen in mid-air (IWSDK leaves a lost hand's spaces
      // where they were). Never while parked under a poking finger — but
      // the lock is stepped here too, as if the finger had left: otherwise a
      // lock engaged just before the left hand dropped would never release
      // (it is only stepped on tracked frames) and pin the board in mid-air.
      this.lostSec += delta;
      if (
        stepPaletteLock(
          this.lock,
          Infinity,
          performance.now() / 1000,
          PALETTE.lockRadius,
          PALETTE.lockReleaseSec,
        )
      ) {
        this.gliding = true;
      }
      if (this.shown && !this.lock.locked && this.lostSec >= PALETTE.hideAfterLostSec) {
        this.setShown(false);
      }
      this.animateVisuals(delta);
      return;
    }
    this.lostSec = 0;
    if (!this.shown) this.setShown(true);

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
    this.animateVisuals(delta);
  }

  /** Show or hide the whole palette; showing restarts the appear pop. */
  private setShown(shown: boolean): void {
    this.shown = shown;
    if (shown) this.appearElapsed = 0;
    for (const root of this.queries.roots.entities) {
      const object3D = root.object3D;
      if (!object3D) continue;
      object3D.visible = shown;
      // Collapsed as well as invisible, so a hidden board also has no reach
      // for a stray fingertip or squeeze.
      if (!shown) object3D.scale.setScalar(1e-4);
    }
  }

  /**
   * Appear pop + idle shimmer + loaded-slot lighting. Scalars only: no
   * allocation, a handful of material writes per frame.
   */
  private animateVisuals(delta: number): void {
    if (!this.shown) return;
    let glow = 1;
    if (this.appearElapsed < PALETTE.appearSec) {
      this.appearElapsed += delta;
      appearFrame(
        this.appearElapsed,
        PALETTE.appearSec,
        PALETTE.appearFromScale,
        this.appear,
      );
      glow = this.appear.glow;
      for (const root of this.queries.roots.entities) {
        root.object3D?.scale.setScalar(this.appear.scale);
      }
    } else if (this.appearElapsed !== Number.POSITIVE_INFINITY) {
      // Settle exactly on 1 once, then stop touching the scale.
      this.appearElapsed = Number.POSITIVE_INFINITY;
      for (const root of this.queries.roots.entities) {
        root.object3D?.scale.setScalar(1);
      }
    }

    for (const root of this.queries.roots.entities) {
      const visuals = paletteVisualsOf(root.object3D);
      if (visuals) this.paintVisuals(visuals, glow);
    }
  }

  private paintVisuals(visuals: PaletteVisuals, glow: number): void {
    const phase = this.shimmerSec * PALETTE.shimmerHz * Math.PI * 2;
    const wave = Math.sin(phase);

    if (visuals.edgeLine) visuals.edgeLine.opacity = glow;
    if (visuals.edgeGlow) {
      visuals.edgeGlow.opacity =
        PALETTE.holoGlowOpacity * (1 + PALETTE.shimmerEdgeAmp * wave) * glow;
    }

    const color = this.activeColor?.peek();
    for (let i = 0; i < visuals.wells.length; i++) {
      const well = visuals.wells[i];
      const selected =
        !!color &&
        (well.color[0] - color[0]) ** 2 +
          (well.color[1] - color[1]) ** 2 +
          (well.color[2] - color[2]) ** 2 <
          SAME_COLOR_EPS;
      well.rim.opacity =
        (selected ? PALETTE.wellRimSelectedOpacity : PALETTE.wellRimOpacity) * glow;
      well.glow.opacity =
        (selected ? PALETTE.wellGlowSelectedOpacity : PALETTE.wellGlowOpacity) * glow;
      // Each dab breathes a little out of step with its neighbours.
      well.paint.emissiveIntensity =
        PALETTE.dabEmissive +
        PALETTE.dabPulseAmp * (0.5 + 0.5 * Math.sin(phase + i * 1.3));
    }

    const style = this.activeStyle?.peek() ?? BallStyle.Paint;
    const kind = this.activeKind?.peek() ?? BallKind.Normal;
    for (const socket of visuals.chipSockets) {
      // Same rule as BallSpawnSystem's chip highlight: a web chip is selected
      // on style alone, a paint chip also has to be the loaded kind.
      const selected =
        socket.style === style &&
        (socket.style !== BallStyle.Paint || socket.kind === kind);
      socket.rim.opacity =
        (selected ? PALETTE.socketRimSelectedOpacity : PALETTE.socketRimOpacity) * glow;
    }
    const mode = this.blasterMode?.peek();
    for (const socket of visuals.padSockets) {
      socket.rim.opacity =
        (socket.mode === mode
          ? PALETTE.socketRimSelectedOpacity
          : PALETTE.socketRimOpacity) * glow;
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
    // Not `visible`: IWSDK leaves a lost hand's spaces frozen where it was
    // last seen, and a frozen fingertip inside lockRadius would park the
    // palette forever — exactly when the left arm occludes the right hand.
    if (!tip || !this.input || !isTracked(this.input, 'right')) {
      return Number.POSITIVE_INFINITY;
    }
    tip.getWorldPosition(this.fingertip);
    return this.fingertip.distanceTo(this.shownPosition);
  }
}
