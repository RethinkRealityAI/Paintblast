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

import { BLASTER, WEB } from '../config';
import type { BlasterSkin } from '../config';
import { handMirror, smoothingAlpha } from '../wrist-frame';
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
  /** The forearm bracer and the back-of-hand plate (BLASTER and WEB). */
  bracer: number;
  /** Barrel + canister over the wrist (BLASTER). */
  paint: number;
  /** Spinneret under the wrist (WEB). */
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

// ---- Components ------------------------------------------------------------

/** Which piece of a gauntlet an entity is. */
export const GauntletPart = {
  /** Forearm root, aim frame: bracer + paint barrel + web spinneret. */
  Forearm: 0,
  /** Back-of-hand plate, wrist frame. */
  Plate: 1,
  /** The web spinneret (child of the forearm root; parent of the selector pads). */
  Spinneret: 2,
} as const;

/** Tags the gauntlet hardware for the MCP tools. 0 = left hand, 1 = right. */
export const Gauntlet = createComponent('Gauntlet', {
  side: { type: Types.Int8, default: 0 },
  /** @see GauntletPart */
  part: { type: Types.Int8, default: GauntletPart.Forearm },
});

// ---- Geometry constants (aim frame at the wrist joint, metres) --------------

/** Forearm cross-section is an ellipse: wider than it is deep. */
const ELLIPSE_Y = 0.78;
/** Paint module pivot: the saddle's centre, so recoil tips about the canister. */
const PAINT_PIVOT: readonly [number, number, number] = [0, 0.045, 0.06];
/** Paint barrel axis height (matches BLASTER.muzzleLocal[1] by default). */
const BARREL_Y = 0.058;
/** Plate hinge, metres toward the wrist from the plate centre. */
const PLATE_HINGE_Z = 0.037;
/** How far (radians) a stowed plate is folded up off the hand. */
const PLATE_FOLD_RAD = 1.35;

/** Glow on the web cartridge: white = splat, sky = tether. */
const WEB_GLOW_SPLAT = '#e9f4ff';
const WEB_GLOW_TETHER = '#48dbfb';

/**
 * The gauntlet blasters (round 8): models, posing, mode transitions, skins,
 * recoil. One per arm, both arms.
 *
 * ### What it owns
 *
 * - The **pose**. Each arm's {@link WristPose} (wrist joint for hands, ray +
 *   mirrored grip for controllers — see `src/wrist-pose.ts`), smoothed with
 *   `WEB.shooterSmoothingSec`. Round 7 kept this in WebShooterSystem; it moved
 *   here because the hardware is no longer web-only. WebShooterSystem reads
 *   the palm, the aim and the nozzle back through the small public API below,
 *   so there is exactly one smoothed aim per arm in the game.
 * - The **hardware**: a forearm bracer in the aim frame (so whatever is
 *   mounted on it points exactly where it fires), the paint barrel + glowing
 *   canister on top of it, the web spinneret under it, and a back-of-hand
 *   plate in the hand's own wrist frame (it rides the hand, fingers free).
 * - **Mode transitions**: `globals.blasterMode` deploys and stows the pieces
 *   over `BLASTER.transitionSec` (slide, unfold, scale with a little
 *   overshoot), and emits `GameEvent.BlasterModeChanged` for the cue.
 * - **Skins**: `globals.blasterSkin` recolours the shared materials — once,
 *   on change, never per frame.
 * - **Recoil**: every paint ball fired in BLASTER mode kicks that arm's
 *   barrel and flashes its muzzle; the canister swirls and breathes.
 * - **Muzzles**: each frame it writes where each arm launches from into
 *   `globals.gauntletMuzzles`, which BallSpawnSystem reads to route the
 *   trigger/pinch out of the barrel.
 *
 * ### Ordering
 *
 * Priority 9: after WristPaletteSystem (8), before WebShooterSystem (10,
 * gestures + strands read this frame's pose) and BallSpawnSystem (11, fires
 * from this frame's muzzle). Well above IWSDK's InputSystem (-4), which
 * refreshes the hand joints the pose is built from. Registered before
 * WebShooterSystem in main.ts, because WebShooterSystem.init() parents its
 * selector pads to the left spinneret built in this init().
 *
 * ### Allocation
 *
 * Every mesh, material, vector and pose is built in init(). update() writes
 * into those and allocates nothing.
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
  /** Smoothed aim-frame pose of the forearm root (the wrist anchor). */
  private shownPos!: [Vector3, Vector3];
  private shownQ!: [Quaternion, Quaternion];
  /** Smoothed wrist-frame pose of the plate. */
  private platePos!: [Vector3, Vector3];
  private plateQ!: [Quaternion, Quaternion];
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
  private animating = true;
  /** Per-hand recoil 0..1. */
  private recoil!: Float32Array;
  private seamPulsing = false;
  private wasPaused = false;
  private elapsed = 0;

  // Entities and the animated groups inside them, per hand.
  private readonly forearmEntities: Array<Entity | undefined> = [undefined, undefined];
  private readonly plateEntities: Array<Entity | undefined> = [undefined, undefined];
  private readonly spinneretEntities: Array<Entity | undefined> = [undefined, undefined];
  private readonly bracers: Object3D[] = [];
  private readonly paintModules: Object3D[] = [];
  private readonly webModules: Object3D[] = [];
  private readonly plateHinges: Object3D[] = [];
  private readonly swirls: Object3D[] = [];
  private readonly liquids: Object3D[] = [];
  private readonly flashes: Object3D[] = [];

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
  /** Linear-space base colours the per-frame pulses scale from. */
  private accentBase!: Color;
  private liquidBase!: Color;

  // Scratch.
  private tmpV!: Vector3;
  private tmpQ!: Quaternion;
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
    this.platePos = [new Vector3(), new Vector3()];
    this.plateQ = [new Quaternion(), new Quaternion()];
    this.lastPalm = [new Vector3(), new Vector3()];
    this.palms = [new Vector3(), new Vector3()];
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
    this.tmpQ = new Quaternion();
    this.dir = new Vector3();
    this.accentBase = new Color();
    this.liquidBase = new Color();

    this.buildMaterials();
    for (let hand = 0; hand < 2; hand++) this.buildHand(hand);

    // Start already in the stored mode: no deploy animation (and no cue) for
    // the loadout the session boots with.
    this.lastMode = this.blasterMode.peek();
    deployTargetsFor(this.lastMode, this.targets);
    this.deploy[0] = this.targets.bracer;
    this.deploy[1] = this.targets.paint;
    this.deploy[2] = this.targets.web;
    this.animating = true;

    this.applySkin();
    this.applyPaintColor();
    this.applyWebGlow();

    this.cleanupFuncs.push(
      ...(this.blasterSkin ? [this.blasterSkin.subscribe(() => this.applySkin())] : []),
      ...(this.activeColor
        ? [this.activeColor.subscribe(() => this.applyPaintColor())]
        : []),
      ...(this.webSubMode ? [this.webSubMode.subscribe(() => this.applyWebGlow())] : []),
      // Recoil: any paint ball an arm fires while the barrel is out. Keyed off
      // the ball appearing (like WebShooterSystem's strands), so the trigger,
      // auto-fire, the thwip and the thrust all kick the same way.
      this.queries.balls.subscribe('qualify', (ball) => {
        if (this.blasterMode.peek() !== BlasterMode.Paint) return;
        if (ball.getValue(Ball, 'style') !== BallStyle.Paint) return;
        const hand = ball.getValue(Ball, 'firedBy') ?? -1;
        if (hand !== 0 && hand !== 1) return;
        this.recoil[hand] = 1;
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
    }
    this.elapsed += delta;

    this.stepMode(delta);
    for (let hand = 0; hand < 2; hand++) this.poseHand(hand, delta);
    this.animateHardware(delta);
  }

  // ---- Public API (WebShooterSystem, MCP smoke tests) ----------------------

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

  /** Unit direction a shot from this arm travels: the shown barrel's -Z. */
  aimInto(hand: number, out: Vector3): Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.shownQ[hand]);
  }

  /**
   * The web nozzle tip, world space (no clearance offset) — where strands
   * start. Valid in every mode: HAND-mode gestures fire from the same
   * (invisible) point, exactly as round 7 did.
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
   * barrel in BLASTER mode, out of the spinneret otherwise, plus that
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

  /** The spinneret entity of this arm — the parent for the web selector pads. */
  spinneretEntity(hand: number): Entity | undefined {
    return this.spinneretEntities[hand];
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
      this.animating = true;
      this.events?.emit(GameEvent.BlasterModeChanged, 0, 0, 0, mode);
    }
    if (!this.animating) return;

    deployTargetsFor(mode, this.targets);
    const d = this.deploy;
    const sec = BLASTER.transitionSec;
    d[0] = stepDeploy(d[0], this.targets.bracer, delta, sec);
    d[1] = stepDeploy(d[1], this.targets.paint, delta, sec);
    d[2] = stepDeploy(d[2], this.targets.web, delta, sec);
  }

  // ---- Pose ------------------------------------------------------------------

  private poseHand(hand: number, delta: number): void {
    const wrist = this.wrists[hand];
    const muzzles = this.muzzles;
    if (!wrist.update(this.player, this.input, WEB)) {
      // Lost (or never seen: the hardware starts at the world origin). Hide
      // it rather than leave a bracer frozen in mid-air while the real hand
      // carries on in passthrough, and forget the smoothing, so reacquiring
      // snaps instead of gliding across the room. The last pose is kept, so
      // strands still hang off the last nozzle position.
      if (this.posed[hand] || this.everPosed[hand] === 0) this.setShown(hand, false);
      this.posed[hand] = 0;
      this.primed[hand] = 0;
      muzzles.valid[hand] = 0;
      return;
    }
    if (!this.posed[hand]) this.setShown(hand, true);
    this.posed[hand] = 1;
    this.everPosed[hand] = 1;
    this.palms[hand].copy(wrist.palm);

    // A palm that jumps further than any real hand moves in a frame is a hand
    // that dropped out and came back: snap.
    const jump = WEB.reacquireJumpMeters;
    if (
      this.primed[hand] &&
      this.lastPalm[hand].distanceToSquared(wrist.palm) > jump * jump
    ) {
      this.primed[hand] = 0;
    }
    this.lastPalm[hand].copy(wrist.palm);

    // Forearm root: wrist anchor, aim frame (+ the optional controller roll).
    this.tmpQ.copy(wrist.aimQ);
    if (!wrist.isHand) {
      this.tmpQ.multiply(this.controllerRoll[hand]);
    }
    // Plate: wrist frame, offset onto the back of the hand.
    const off = wrist.isHand ? BLASTER.plateOffsetHand : BLASTER.plateOffsetController;
    this.tmpV
      .set(handMirror(hand) * off[0], off[1], off[2])
      .applyQuaternion(wrist.wristQ)
      .add(wrist.anchor);

    const shownPos = this.shownPos[hand];
    const shownQ = this.shownQ[hand];
    const platePos = this.platePos[hand];
    const plateQ = this.plateQ[hand];
    if (!this.primed[hand]) {
      shownPos.copy(wrist.anchor);
      shownQ.copy(this.tmpQ);
      platePos.copy(this.tmpV);
      plateQ.copy(wrist.wristQ);
      this.primed[hand] = 1;
    } else {
      const alpha = smoothingAlpha(delta, WEB.shooterSmoothingSec);
      shownPos.lerp(wrist.anchor, alpha);
      shownQ.slerp(this.tmpQ, alpha);
      platePos.lerp(this.tmpV, alpha);
      plateQ.slerp(wrist.wristQ, alpha);
    }

    const forearm = this.forearmEntities[hand]?.object3D;
    if (forearm) {
      setWorldPosition(forearm, shownPos);
      setWorldQuaternion(forearm, shownQ);
    }
    const plate = this.plateEntities[hand]?.object3D;
    if (plate) {
      setWorldPosition(plate, platePos);
      setWorldQuaternion(plate, plateQ);
    }

    // Publish this arm's launch point for BallSpawnSystem's trigger path.
    const mode = this.lastMode;
    if (mode === BlasterMode.Hand) {
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

  /** Show or hide both of this arm's roots (tracking gained / lost). */
  private setShown(hand: number, shown: boolean): void {
    const forearm = this.forearmEntities[hand]?.object3D;
    if (forearm) forearm.visible = shown;
    const plate = this.plateEntities[hand]?.object3D;
    if (plate) plate.visible = shown;
  }

  // ---- Animation -------------------------------------------------------------

  private animateHardware(delta: number): void {
    const d = this.deploy;

    if (this.animating) {
      const bracer = d[0];
      const paint = d[1];
      const web = d[2];
      const eb = easeOutBack(bracer);
      const ebz = easeOutCubic(bracer);
      const ep = easeOutBack(paint);
      const ew = easeOutBack(web);
      for (let hand = 0; hand < 2; hand++) {
        const br = this.bracers[hand];
        if (br) {
          br.visible = bracer > 0.001;
          // Grows out of the wrist up the forearm, widening as it locks on.
          br.scale.set(0.6 + 0.4 * eb, 0.6 + 0.4 * eb, 0.15 + 0.85 * ebz);
        }
        const hinge = this.plateHinges[hand];
        if (hinge) {
          hinge.visible = bracer > 0.001;
          // Folds down onto the back of the hand like a visor.
          hinge.rotation.x = (1 - ebz) * PLATE_FOLD_RAD;
          const s = 0.3 + 0.7 * eb;
          hinge.scale.set(s, s, s);
        }
        const pm = this.paintModules[hand];
        if (pm) {
          pm.visible = paint > 0.001;
          const s = 0.15 + 0.85 * ep;
          pm.scale.set(s, s, s);
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
          wm.position.set(
            handMirror(hand) * WEB.shooterOffsetX,
            WEB.shooterOffsetY - (1 - ebz) * 0.012,
            WEB.shooterOffsetZ + (1 - easeOutCubic(web)) * 0.035,
          );
        }
      }
      deployTargetsFor(this.lastMode, this.targets);
      if (
        d[0] === this.targets.bracer &&
        d[1] === this.targets.paint &&
        d[2] === this.targets.web
      ) {
        this.animating = false;
      }
    }

    // Paint module rest pose + recoil + the canister's idle life.
    const paintShown = d[1] > 0.001;
    let maxRecoil = 0;
    for (let hand = 0; hand < 2; hand++) {
      const r = decayRecoil(this.recoil[hand], delta, BLASTER.recoilDecaySec);
      this.recoil[hand] = r;
      if (r > maxRecoil) maxRecoil = r;
      const pm = this.paintModules[hand];
      if (pm) {
        const rise = (1 - easeOutCubic(d[1])) * -0.024;
        pm.position.set(
          PAINT_PIVOT[0],
          PAINT_PIVOT[1] + rise,
          PAINT_PIVOT[2] + r * BLASTER.recoilMeters,
        );
        pm.rotation.x = r * BLASTER.recoilPitchDeg * DEG_TO_RAD;
      }
      const flash = this.flashes[hand];
      if (flash) {
        flash.visible = paintShown && r > 0.04;
        const s = Math.max(0.001, r * BLASTER.muzzleFlashScale);
        flash.scale.set(s, s, s);
      }
      const swirl = this.swirls[hand];
      if (swirl && paintShown) {
        swirl.rotation.z +=
          delta * Math.PI * 2 * BLASTER.canisterSwirlHz * (1 + 3 * r);
      }
    }

    if (paintShown) {
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

  /** Canister liquid, swirl and muzzle flash in the loaded paint colour. */
  private applyPaintColor(): void {
    const c = this.activeColor?.peek();
    if (!c) return;
    this.liquidBase.setRGB(c[0], c[1], c[2], SRGBColorSpace);
    this.liquidMat.color.copy(this.liquidBase);
    this.swirlMat.color.setRGB(1, 1, 1).lerp(this.liquidBase, 0.55);
    this.flashMat.color.copy(this.liquidBase).lerp(this.swirlMat.color, 0.3);
  }

  /** Web cartridge glow keyed to SPLAT / TETHER. */
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
      opacity: 0.6,
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
  }

  private buildHand(hand: number): void {
    // ---- Forearm root (aim frame) -------------------------------------------
    const forearm = new Group();
    forearm.name = hand === 0 ? 'GauntletLeft' : 'GauntletRight';
    const forearmEntity = this.world
      .createTransformEntity(forearm, { parent: this.world.sceneEntity, persistent: true })
      .addComponent(Gauntlet, { side: hand, part: GauntletPart.Forearm });
    this.forearmEntities[hand] = forearmEntity;

    const bracer = this.buildBracer();
    forearm.add(bracer);
    this.bracers[hand] = bracer;

    const paint = this.buildPaintModule(hand);
    forearm.add(paint);
    this.paintModules[hand] = paint;

    // The spinneret is its own entity so the web selector pads (entities) can
    // be parented into it and ride its deploy animation.
    const web = new Group();
    web.name = hand === 0 ? 'SpinneretLeft' : 'SpinneretRight';
    web.position.set(
      handMirror(hand) * WEB.shooterOffsetX,
      WEB.shooterOffsetY,
      WEB.shooterOffsetZ,
    );
    web.add(
      (WEB.shooterUseGlb ? this.buildSpinneretModel() : undefined) ?? this.buildSpinneret(),
    );
    this.spinneretEntities[hand] = this.world
      .createTransformEntity(web, { parent: forearmEntity, persistent: true })
      .addComponent(Gauntlet, { side: hand, part: GauntletPart.Spinneret });
    this.webModules[hand] = web;

    // ---- Back-of-hand plate (wrist frame) -----------------------------------
    const plate = new Group();
    plate.name = hand === 0 ? 'GauntletPlateLeft' : 'GauntletPlateRight';
    const hinge = this.buildPlate();
    plate.add(hinge);
    this.plateHinges[hand] = hinge;
    this.plateEntities[hand] = this.world
      .createTransformEntity(plate, { parent: this.world.sceneEntity, persistent: true })
      .addComponent(Gauntlet, { side: hand, part: GauntletPart.Plate });
  }

  /**
   * The forearm bracer: a flared sleeve round the forearm (a lathe, so it has
   * real thickness and a lip at each end), chrome rims, graphite side panels,
   * trim bands near the elbow and neon seams cut into the shell. Built round a
   * circle and squashed to the forearm's ellipse. Authored along +Z (up the
   * forearm) from the wrist joint. The inside is a graphite liner, so looking
   * down the sleeve reads as padding rather than as the back of the shell.
   */
  private buildBracer(): Object3D {
    const group = new Group();
    group.name = 'Bracer';

    // Outer shell (radius, z): wrist lip, along the forearm, elbow flare.
    const outer: Array<[number, number]> = [
      [0.0335, 0.03],
      [0.0358, 0.0245],
      [0.0386, 0.0238],
      [0.0402, 0.0285],
      [0.0406, 0.06],
      [0.0422, 0.095],
      [0.0446, 0.118],
      [0.0472, 0.131],
      [0.0476, 0.1365],
      [0.0456, 0.139],
      [0.0438, 0.1335],
    ];
    const shell = new LatheGeometry(
      outer.map(([r, z]) => new Vector2(r, z)),
      40,
    );
    shell.rotateX(Math.PI / 2);
    shell.scale(1, ELLIPSE_Y, 1);
    group.add(new Mesh(shell, this.shellMat));

    // Liner: the inside wall, elbow back to the wrist (same winding as the
    // outer loop, so its faces point in at the arm).
    const liner = new LatheGeometry(
      [
        new Vector2(0.0438, 0.1335),
        new Vector2(0.0372, 0.09),
        new Vector2(0.0335, 0.03),
      ],
      40,
    );
    liner.rotateX(Math.PI / 2);
    liner.scale(1, ELLIPSE_Y, 1);
    group.add(new Mesh(liner, this.graphiteMat));

    // Chrome rims at both ends.
    const rimA = new TorusGeometry(0.0383, 0.003, 8, 40);
    rimA.translate(0, 0, 0.0262);
    const rimB = new TorusGeometry(0.0468, 0.0033, 8, 40);
    rimB.translate(0, 0, 0.1365);
    const chrome = mergeGeometries([rimA, rimB]);
    chrome.scale(1, ELLIPSE_Y, 1);
    group.add(new Mesh(chrome, this.chromeMat));

    // Trim bands near the elbow.
    const bandA = new TorusGeometry(0.0438, 0.0013, 6, 40);
    bandA.translate(0, 0, 0.108);
    const bandB = new TorusGeometry(0.0448, 0.0013, 6, 40);
    bandB.translate(0, 0, 0.1145);
    const bands = mergeGeometries([bandA, bandB]);
    bands.scale(1, ELLIPSE_Y, 1);
    group.add(new Mesh(bands, this.trimMat));

    // Graphite side panels, one on each flank of the forearm.
    const panels: BufferGeometry[] = [];
    const span = Math.PI / 4;
    for (const mid of [Math.PI / 2, (Math.PI * 3) / 2]) {
      const p = new CylinderGeometry(0.0428, 0.0415, 0.042, 10, 1, true, mid - span / 2, span);
      p.rotateX(Math.PI / 2);
      p.translate(0, 0, 0.072);
      panels.push(p);
    }
    const panelGeo = mergeGeometries(panels);
    panelGeo.scale(1, ELLIPSE_Y, 1);
    group.add(new Mesh(panelGeo, this.graphiteMat));

    // Neon seams: a ring near the wrist, L-shaped cuts down each flank of the
    // top, and a line framing each side panel.
    const seams: BufferGeometry[] = [];
    const ring = new TorusGeometry(0.0411, 0.001, 5, 40);
    ring.translate(0, 0, 0.037);
    seams.push(ring);
    for (const s of [1, -1]) {
      const top = 90 - s * 38;
      seams.push(
        seamTube([
          [top, 0.042],
          [top, 0.086],
          [90 - s * 54, 0.104],
          [90 - s * 54, 0.126],
        ]),
      );
      const flank = s > 0 ? 28 : 152;
      seams.push(
        seamTube([
          [s > 0 ? -28 : 208, 0.048],
          [flank, 0.048],
          [flank, 0.1],
          [s > 0 ? 18 : 162, 0.112],
        ]),
      );
    }
    const seamGeo = mergeGeometries(seams);
    seamGeo.scale(1, ELLIPSE_Y, 1);
    group.add(new Mesh(seamGeo, this.accentMat));

    return group;
  }

  /**
   * BLASTER hardware over the wrist: a shell saddle on the bracer, a
   * transparent canister of glowing paint (with a swirl inside), and a chunky
   * graphite barrel with a chrome muzzle collar and a neon bore ring. Authored
   * in aim-frame coordinates, then re-seated so the group's origin is
   * {@link PAINT_PIVOT} — recoil tips the barrel about the canister.
   */
  private buildPaintModule(hand: number): Object3D {
    const group = new Group();
    group.name = 'PaintBlaster';
    group.position.set(PAINT_PIVOT[0], PAINT_PIVOT[1], PAINT_PIVOT[2]);
    const px = -PAINT_PIVOT[0];
    const py = -PAINT_PIVOT[1];
    const pz = -PAINT_PIVOT[2];
    const place = (g: BufferGeometry, x: number, y: number, z: number) =>
      g.translate(x + px, y + py, z + pz);

    // Saddle: a flattened capsule riding the top of the bracer.
    const saddle = new CapsuleGeometry(0.016, 0.075, 6, 16);
    saddle.rotateX(Math.PI / 2);
    saddle.scale(1.35, 0.6, 1);
    place(saddle, 0, 0.04, 0.062);
    // Barrel shroud fairing: a shell cowl round the barrel's rear half.
    // thetaStart pi/2, length pi: after the quarter turn about X that is the
    // upper half (+Y), i.e. the cowl caps the barrel from above.
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

    // Canister: swirl inside liquid inside glass. Opaque swirl first, then the
    // translucent liquid, then the glass.
    // Two interleaved helical ribbons of brighter paint; spinning the pair
    // about the canister axis reads as the paint swirling.
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
   * WEB hardware under the wrist (in the spinneret's own frame, which sits at
   * WEB.shooterOffset*): a graphite housing tucked under the bracer, a chrome
   * collar, a glowing cartridge (white = splat, sky = tether) and a chrome
   * needle whose tip is WEB.muzzleLocal.
   */
  private buildSpinneret(): Object3D {
    const group = new Group();
    group.name = 'SpinneretModel';

    const housing = new CapsuleGeometry(0.0125, 0.052, 5, 16);
    housing.rotateX(Math.PI / 2);
    housing.scale(1.2, 0.85, 1);
    group.add(new Mesh(housing, this.graphiteMat));

    const collar = new CylinderGeometry(0.0108, 0.0112, 0.008, 20);
    collar.rotateX(Math.PI / 2);
    collar.translate(0, 0, -0.04);
    const tipCollar = new CylinderGeometry(0.0094, 0.0098, 0.004, 18);
    tipCollar.rotateX(Math.PI / 2);
    tipCollar.translate(0, 0, -0.0705);
    const needle = new CylinderGeometry(0.0016, 0.0072, 0.012, 16);
    needle.rotateX(-Math.PI / 2);
    needle.translate(0, 0, WEB.muzzleLocal[2] + 0.006);
    group.add(new Mesh(mergeGeometries([collar, tipCollar, needle]), this.chromeMat));

    // Neon seams along both flanks and a ring at the collar.
    const seams: BufferGeometry[] = [];
    for (const s of [1, -1]) {
      const seam = new CylinderGeometry(0.001, 0.001, 0.05, 4);
      seam.rotateX(Math.PI / 2);
      seam.translate(s * 0.0151, -0.003, 0.002);
      seams.push(seam);
    }
    const ring = new TorusGeometry(0.0112, 0.0012, 5, 24);
    ring.translate(0, 0, -0.0355);
    seams.push(ring);
    group.add(new Mesh(mergeGeometries(seams), this.accentMat));

    // Cartridge: a glowing core in a glass sleeve, between collar and needle.
    const core = new CylinderGeometry(0.0071, 0.0071, 0.024, 16);
    core.rotateX(Math.PI / 2);
    core.translate(0, 0, -0.0565);
    group.add(new Mesh(core, this.webGlowMat));
    const sleeve = new CylinderGeometry(0.0095, 0.0095, 0.026, 20, 1, true);
    sleeve.rotateX(Math.PI / 2);
    sleeve.translate(0, 0, -0.0565);
    const glass = new Mesh(sleeve, this.glassMat);
    glass.renderOrder = 3;
    group.add(glass);

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
   * The back-of-hand plate, in the wrist-joint frame (+Y out of the back of
   * the hand, -Z toward the knuckles), centred on the plate: a domed shell
   * over a neon edge layer that peeks out round its rim, a graphite centre
   * panel, a chrome knuckle bar and a hinge pin at the wrist end. Returned
   * inside its hinge group, whose X rotation folds it up off the hand.
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

/** Outer radius of the bracer at height `z` (piecewise linear, matches the lathe). */
function bracerRadiusAt(z: number): number {
  const pts: ReadonlyArray<readonly [number, number]> = [
    [0.0285, 0.0402],
    [0.06, 0.0406],
    [0.095, 0.0422],
    [0.118, 0.0446],
    [0.131, 0.0472],
  ];
  if (z <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (z <= pts[i][0]) {
      const [z0, r0] = pts[i - 1];
      const [z1, r1] = pts[i];
      return r0 + ((r1 - r0) * (z - z0)) / (z1 - z0);
    }
  }
  return pts[pts.length - 1][1];
}

/**
 * A glowing seam laid on the bracer's (circular, pre-squash) outer surface,
 * through waypoints given as [angle in degrees from +X toward +Y, z]. Build
 * time only.
 */
function seamTube(waypoints: ReadonlyArray<readonly [number, number]>): BufferGeometry {
  const points: Vector3[] = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const [a0, z0] = waypoints[i];
    const [a1, z1] = waypoints[i + 1];
    const steps = 6;
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const a = (a0 + (a1 - a0) * t) * DEG_TO_RAD;
      const z = z0 + (z1 - z0) * t;
      const r = bracerRadiusAt(z) + 0.0009;
      points.push(new Vector3(r * Math.cos(a), r * Math.sin(a), z));
    }
  }
  const [aEnd, zEnd] = waypoints[waypoints.length - 1];
  const rEnd = bracerRadiusAt(zEnd) + 0.0009;
  points.push(
    new Vector3(rEnd * Math.cos(aEnd * DEG_TO_RAD), rEnd * Math.sin(aEnd * DEG_TO_RAD), zEnd),
  );
  const curve = new CatmullRomCurve3(points, false, 'catmullrom', 0.05);
  return new TubeGeometry(curve, points.length * 3, 0.00105, 5, false);
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
