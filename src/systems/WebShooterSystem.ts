import {
  Color,
  CylinderGeometry,
  InputComponent,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  SRGBColorSpace,
  Types,
  Vector3,
  createComponent,
  createSystem,
  setWorldPosition,
  setWorldQuaternion,
} from '@iwsdk/core';
import type { Entity, Object3D } from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import { FIRE, WEB } from '../config';
import { drainReelQueue, pullReel } from '../wrist-frame';
import { GauntletSystem } from './GauntletSystem';
import {
  BallStyle,
  GameEvent,
  GameEventBuffer,
  GamePhase,
  packTetherData,
} from '../types';
import { Ball, BallSpawnSystem, canFireInPhase } from './BallSpawnSystem';
import { TargetSystem, shiftTimestamps } from './TargetSystem';
import { PauseClock } from './GameStateSystem';

/**
 * Round 8: the hardware (and the optional GLB, its asset key and the band
 * fit) moved to GauntletSystem. Re-exported here so main.ts's manifest and
 * the round-5 tests keep finding them where they always did.
 */
export {
  WEB_SHOOTER_ASSET_KEY,
  createShooterFit,
  fitShooterScale,
} from './GauntletSystem';
export type { ShooterFit } from './GauntletSystem';

/** Cached joint slots. Index into WebShooterSystem's per-hand joint tables. */
const JOINT_WRIST = 0;
const JOINT_INDEX = 1;
const JOINT_MIDDLE = 2;
const JOINT_RING = 3;
const JOINT_PINKY = 4;
const JOINT_SLOTS = 5;

/** WebXR joint names, in the same order as the JOINT_* slots above. */
const JOINT_NAMES: readonly string[] = [
  'wrist',
  'index-finger-tip',
  'middle-finger-tip',
  'ring-finger-tip',
  'pinky-finger-tip',
];

/** Lifecycle of one strand slot. Stored per slot in a plain Int8Array. */
export const StrandState = {
  /** Hidden, available. */
  Free: 0,
  /** Stretched from a wrist to a web ball still in the air. */
  Flying: 1,
  /** Ball has landed; the far end is pinned and the strand is fading out. */
  Fading: 2,
  /**
   * Round 6: the line is attached to a robot. Both ends live — the near end
   * tracks the nozzle, the far end tracks the robot as it is reeled in — and
   * unlike Fading it has no timer of its own. It ends when the tether does.
   */
  Tethered: 3,
} as const;

export type StrandState = typeof StrandState[keyof typeof StrandState];

/**
 * Marks one pooled strand. The live numbers live in TypedArrays on the system;
 * these mirror just enough for `ecs_find_entities` / `ecs_query_entity` to show
 * which slots are busy from the MCP tools.
 */
export const WebStrand = createComponent('WebStrand', {
  slot: { type: Types.Int8, default: -1 },
  /** @see StrandState */
  state: { type: Types.Int8, default: StrandState.Free },
});

/**
 * GOO strand colour (round 9), as an sRGB triple written into `out`.
 *
 * With `usePaint` the strand wears the loaded paint colour (an sRGB palette
 * tuple, gotcha 23); a tether line is lifted `tetherLift` (0..1) of the way
 * toward white so a held line still reads brighter than a flying one. Without
 * it, or with no colour to read, the strand is the classic white thread.
 * Pure and allocation-free: the caller owns `out`.
 */
export function gooStrandRgb(
  paint: ArrayLike<number> | undefined,
  usePaint: boolean,
  tether: boolean,
  tetherLift: number,
  out: [number, number, number],
): [number, number, number] {
  if (!usePaint || !paint || paint.length < 3) {
    out[0] = 1;
    out[1] = 1;
    out[2] = 1;
    return out;
  }
  const lift = tether ? Math.min(1, Math.max(0, tetherLift)) : 0;
  for (let i = 0; i < 3; i++) {
    const c = Math.min(1, Math.max(0, Number.isFinite(paint[i]) ? paint[i] : 1));
    out[i] = c + (1 - c) * lift;
  }
  return out;
}

/** The four fingertip-to-wrist distances a flick (ex-"thwip") is judged on, in metres. */
export interface ThwipPose {
  readonly indexDist: number;
  readonly middleDist: number;
  readonly ringDist: number;
  readonly pinkyDist: number;
}

/** The two thresholds {@link isThwipPose} compares against. */
export interface ThwipThresholds {
  readonly curlThreshold: number;
  readonly extendThreshold: number;
}

/**
 * Is this hand making the thwip?
 *
 * Middle and ring folded into the palm, index and pinky still out. That is the
 * whole gesture — and it is chosen precisely because no other hand shape people
 * make in mid-air accidentally matches it: a fist curls all four, a point curls
 * three, a pinch moves the thumb, and an open hand extends everything.
 *
 * Distances are fingertip-to-wrist, which is why the classifier does not care
 * where the hand is or which way it is facing: IWSDK reports joint transforms in
 * the hand's own grip space, so these four numbers are the same whether the
 * player is reaching overhead or down at the floor.
 *
 * The gap between `curlThreshold` (0.07 m) and `extendThreshold` (0.13 m) is
 * deliberate dead space. A finger drifting through the middle of that band
 * satisfies neither test, so a half-made gesture reads as "no", not as a
 * coin-flip that fires on tracking noise.
 *
 * Pure, and free of any IWSDK dependency, so the pose can be swept in tests
 * without a headset or a hand.
 */
export function isThwipPose(
  pose: ThwipPose,
  cfg: ThwipThresholds,
): boolean {
  return (
    pose.middleDist < cfg.curlThreshold &&
    pose.ringDist < cfg.curlThreshold &&
    pose.indexDist > cfg.extendThreshold &&
    pose.pinkyDist > cfg.extendThreshold
  );
}

/**
 * The hysteresis latch shared by both gesture triggers.
 *
 * @see stepGestureGate — one of these per hand per trigger, owned by the caller
 * so stepping it allocates nothing.
 */
export interface GestureGate {
  /** True while the gesture is still being held from a previous frame. */
  latched: boolean;
  /** performance.now() ms of the last shot this gate let through. */
  lastFireMs: number;
}

/** A cold gate: nothing held, nothing fired. */
export function createGestureGate(): GestureGate {
  return { latched: false, lastFireMs: Number.NEGATIVE_INFINITY };
}

/**
 * Turn a continuous "is the gesture happening" signal into single shots.
 *
 * Two rules, and both matter on a real hand:
 *
 * 1. **Latch.** Firing happens on the *rising edge* only. Holding the thwip
 *    pose is one web, not ninety per second, and the gate does not re-arm until
 *    the pose has actually cleared.
 * 2. **Cooldown.** Hand tracking flickers. Without a floor on the interval, a
 *    single frame of lost tracking mid-pose reads as clear-then-pose and throws
 *    a second web the player never asked for.
 *
 * Used by both triggers: `active` is the thwip pose for one, and "forward hand
 * speed is over the threshold" for the other. Same two failure modes, same fix.
 *
 * Pure apart from mutating the caller's gate.
 *
 * @returns true when this call should fire.
 */
export function stepGestureGate(
  gate: GestureGate,
  active: boolean,
  nowMs: number,
  cooldownMs: number,
): boolean {
  if (!active) {
    gate.latched = false;
    return false;
  }
  if (gate.latched) return false;

  gate.latched = true;
  if (nowMs - gate.lastFireMs < cooldownMs) return false;

  gate.lastFireMs = nowMs;
  return true;
}

/**
 * How fast the hand is travelling **along its own pointing axis**, m/s.
 *
 * The projection onto `forward` is the entire point: a thrust is a punch out
 * from the shoulder, and measuring plain speed would fire on any brisk wave,
 * any arm swing while walking, and every time the player turned to look at
 * something. Sideways and backwards motion projects to zero or negative and is
 * ignored for free.
 *
 * `forward` is expected to be a unit vector (the grip's -Z). `elapsedSec` is the
 * span the displacement was measured over — a whole sample window rather than
 * one frame, because a single 11 ms frame of tracking jitter is worth several
 * m/s and would fire on a perfectly still hand.
 *
 * Pure and exported for tests.
 *
 * @returns metres per second along `forward`; negative when pulling back.
 */
export function forwardSpeed(
  prevX: number,
  prevY: number,
  prevZ: number,
  curX: number,
  curY: number,
  curZ: number,
  forwardX: number,
  forwardY: number,
  forwardZ: number,
  elapsedSec: number,
): number {
  if (!(elapsedSec > 0)) return 0;
  const dx = curX - prevX;
  const dy = curY - prevY;
  const dz = curZ - prevZ;
  return (dx * forwardX + dy * forwardY + dz * forwardZ) / elapsedSec;
}

/**
 * Web ammo: a shooter on each wrist, two gesture triggers, and the strands.
 *
 * ### What round 5 changed
 *
 * Round 4 made this a **mode**. You left the title screen for a Web sandbox in
 * which the palette was hidden, everything was white, and the trigger was
 * rewired to this system. Field feedback: "I want web mode AND chill mode —
 * same interactions", plus "still want regular mode". A phase cannot give you
 * that; ammo can. So GamePhase.Web is gone, webbing is the fifth chip on the
 * palette, and this system now switches on `globals.activeStyle` rather than on
 * where in the game you happen to be. Load WEB in Chill and you web the easel;
 * load it mid-round and web splats score like paint splats.
 *
 * The trigger went back to BallSpawnSystem with the phase. Webbing is an
 * ordinary shot whose loadout came back white, which is both less code and the
 * only way spray-on-hold, the per-hand cooldown and the don't-shoot-the-HUD
 * rule apply to it without being reimplemented here.
 *
 * ### What round 6 changed
 *
 * Two things, and the first is a deletion. The thwip and the thrust used to
 * throw webbing *specifically*, which meant they were a web feature and only
 * worked with the WEB chip loaded. They now fire **whatever the palette has
 * loaded**, through {@link BallSpawnSystem.fireFromGesture} — a thwip with red
 * splash paint on throws red splash paint. That makes them a second trigger
 * rather than a mode, so this system's update no longer waits for web ammo; it
 * only waits for a phase in which firing is allowed at all.
 *
 * The second is the **tether**: a web sub-mode that latches onto a robot so you
 * can reel it in and pop it. The robot side of that lives entirely in
 * TargetSystem (see its tether API); what lives here is the per-hand line — one
 * slot index, a deadline, and the persistent strand drawn along it — plus the
 * the ways to haul on it (round 7: a proportional pull, a held pinch or
 * trigger, a held squeeze — all queued and paid out as a glide).
 *
 * ### What is left, and why it is here
 *
 * Two triggers that no other system could own, because both are read off raw
 * hand joints:
 *
 * - the **thwip**: middle and ring fingers curled into the palm with index and
 *   pinky out;
 * - a **thrust**: shoving the hand forward along its own pointing axis.
 *
 * Plus the strand pool. (Round 10: the SPLAT / TETHER selector pads that hung
 * under the left spinneret are gone; GOO's sub-mode is picked on the wrist
 * menu's GOO MODE row, or with B.) Strands are attached
 * by watching Ball entities appear rather than by the firing code asking for
 * one — see the `webBalls` query — so a web thrown by the trigger, the thwip
 * or the thrust all trail exactly the same thread, and BallSpawnSystem never
 * has to import this system back.
 *
 * ### What round 8 moved out
 *
 * The hardware and the pose. GauntletSystem now owns both arms' WristPose,
 * the smoothed aim frame, and every model (bracer, paint barrel, spinneret,
 * hand plate) across the three blaster modes. This system reads the palm, the
 * aim and the nozzle back through GauntletSystem's public API.
 *
 * Runs at priority 10 — after GauntletSystem (9, which poses this frame's
 * wrists), before BallSpawnSystem (11). It must sit well above IWSDK's
 * InputSystem (priority -4), which is what refreshes the hand joint
 * transforms this system classifies: at a lower priority the gesture would be
 * judged on last frame's fingers.
 *
 * Zero allocations in update(): the strand pool, the per-hand gates and every
 * vector are built once in init().
 */
export class WebShooterSystem extends createSystem({
  strands: { required: [WebStrand] },
  // Every ball, so a web ball can be given its strand the instant it exists —
  // and so ANY shot from a hand can let go of whatever that hand was reeling.
  webBalls: { required: [Ball] },
}) {
  private gamePhase!: Signal<GamePhase>;
  private activeStyle!: Signal<BallStyle>;
  /** Loaded paint colour (sRGB RGBA tuple); GOO strands wear it (round 9). */
  private activeColor?: Signal<readonly [number, number, number, number]>;
  /** Scratch sRGB triple for {@link gooStrandRgb}. */
  private readonly gooRgb: [number, number, number] = [1, 1, 1];
  private events!: GameEventBuffer;
  private spawner?: BallSpawnSystem;
  private targets?: TargetSystem;
  /** Pose, aim and nozzle source (round 8). Resolved lazily. */
  private gauntlet?: GauntletSystem;

  /**
   * The strand pool. Fixed-length, built once, reused forever — an object
   * pool, not the ad-hoc entity tracking the ECS guidance warns about, and the
   * same exception TargetSystem's robot pool makes.
   */
  private readonly strandEntities: Entity[] = [];
  private readonly strandMaterials: MeshBasicMaterial[] = [];
  /** The web ball each busy strand is chasing. Cleared when the slot frees. */
  private readonly strandBalls: Array<Entity | undefined> = [];
  /**
   * That ball's mesh, captured at throw time.
   *
   * Held alongside the Entity because elics recycles entity *indices*: a ball
   * destroyed on impact frees its index, and the very next web thrown can be
   * handed the same one — inside the same frame, since this system fires
   * (priority 9) before BallFlightSystem reaps (12). `entity.active` would then
   * be true again for a different ball, and the old strand would silently snap
   * across the room to follow it. Meshes are never recycled (spawnBall builds a
   * fresh one per ball), so an identity check against the mesh settles it.
   */
  private readonly strandBallObjects: Array<Object3D | undefined> = [];

  // Per-strand state, all indexed by slot, all allocated once in init().
  private strandState!: Int8Array;
  /** Which hand threw it: 0 left, 1 right. */
  private strandSide!: Int8Array;
  /** performance.now()/1000 when the strand was thrown — oldest-first eviction. */
  private strandStartedAt!: Float64Array;
  /** performance.now()/1000 the fade finishes at. Only meaningful when Fading. */
  private strandFadeUntil!: Float64Array;
  /** Frozen far endpoint, xyz per slot, captured the frame the ball landed. */
  private strandEndPoint!: Float32Array;

  // Per-hand firing state. Index 0 = left, 1 = right.
  private thwipGates!: GestureGate[];
  private thrustGates!: GestureGate[];
  /** This hand's grip world position, xyz per hand, sampled in stepHand. */
  private handPos!: Float32Array;
  /** This hand's grip world velocity, xyz per hand, m/s. */
  private handVel!: Float32Array;
  /** False until handPos holds a real sample, per hand. */
  private handPrimed!: Uint8Array;
  /** Was this hand's grip actually posed this frame? */
  private handTracked!: Uint8Array;

  // Per-hand tether state. Slot indices only — never entity references, which
  // TargetSystem is free to recycle out from under us at any moment.
  /** Robot pool slot this hand is reeling, or -1. Mirrored from TargetSystem. */
  private tetherSlot!: Int8Array;
  /** performance.now()/1000 at which this tether gives up on its own. */
  private tetherUntil!: Float64Array;
  /**
   * Metres of line hauled but not yet travelled, per hand (round 7). Every
   * reel source adds here; {@link drainReelQueue} pays it out at a bounded
   * speed so the robot glides instead of teleporting.
   */
  private reelQueue!: Float32Array;
  /** performance.now() ms of this hand's last TetherReeled rumble. */
  private lastReelFeedbackMs!: Float64Array;
  /**
   * performance.now() ms at which a press began on a hand that already held a
   * line, or -1. Only such presses can be a release tap; the press that fired
   * the tether in the first place started before it latched and never counts.
   */
  private tetherPressStartMs!: Float64Array;
  /** Strand slot drawing this hand's line, or -1. */
  private tetherStrand!: Int8Array;
  /**
   * This frame's delta, stashed for the hold-reel.
   *
   * The reel runs out of {@link updateTethers}, which is two calls below the
   * one place delta arrives; threading it through every signature in between
   * for one multiplication is worse than one field.
   */
  private lastDelta = 0;
  /**
   * The `paused` global (GameStateSystem mirrors session focus into it), bound
   * on first use, and this system's view of game time. While paused nothing
   * here runs; on resume the tether and strand deadlines move on by the time
   * away, so a line that was mid-reel when the player opened the Quest menu is
   * still there when they come back. @see PauseClock
   */
  private pausedSignal: Signal<boolean> | undefined;
  private readonly pauseClock = new PauseClock();
  /** Cached joint indices per hand, JOINT_SLOTS each. -1 = unresolved. */
  private jointIndices!: Int8Array;
  /**
   * Scratch for the thwip classifier's argument.
   *
   * A fresh object literal per hand per frame is 180 short-lived allocations a
   * second, and the only reason it would not show up as GC pressure is if V8
   * happens to inline the classifier and scalar-replace it. That is a bet, not
   * a guarantee — and this project's whole allocation discipline exists because
   * a GC pause inside an 11 ms frame is a dropped frame.
   */
  private thwipScratch!: { -readonly [K in keyof ThwipPose]: ThwipPose[K] };
  /** Thrust window anchor: palm world position, xyz per hand. */
  private thrustAnchor!: Float32Array;
  /** Seconds accumulated into the current thrust sample window, per hand. */
  private thrustElapsed!: Float32Array;
  /** False until the anchor holds a real sample, per hand. */
  private thrustPrimed!: Uint8Array;

  // Scratch — reused every frame, never reallocated.
  /** This hand's palm position (the grip origin), written by stepHand. */
  private gripPosition!: Vector3;
  /**
   * The direction every shot from this wrist takes: the shown barrel's -Z,
   * read from GauntletSystem's smoothed aim frame.
   */
  private forward!: Vector3;
  private muzzle!: Vector3;
  private ballPosition!: Vector3;
  private strandDirection!: Vector3;
  private strandMidpoint!: Vector3;
  private strandOrientation!: Quaternion;
  private strandUp!: Vector3;
  /** Reel target: this hand's grip, rebuilt from `handPos` each frame. */
  private reelTarget!: Vector3;
  /** The tethered robot's current position. */
  private tetherAnchor!: Vector3;
  /** The player's head, for the kill-radius test. */
  private headPosition!: Vector3;

  init() {
    this.gamePhase = this.globals.gamePhase as Signal<GamePhase>;
    this.activeStyle = this.globals.activeStyle as Signal<BallStyle>;
    this.activeColor = this.globals.activeColor as
      | Signal<readonly [number, number, number, number]>
      | undefined;
    this.events = this.globals.gameEvents as GameEventBuffer;

    const pool = WEB.strandPool;
    this.strandState = new Int8Array(pool);
    this.strandSide = new Int8Array(pool);
    this.strandStartedAt = new Float64Array(pool);
    this.strandFadeUntil = new Float64Array(pool);
    this.strandEndPoint = new Float32Array(pool * 3);

    this.thwipGates = [createGestureGate(), createGestureGate()];
    this.thrustGates = [createGestureGate(), createGestureGate()];
    this.handPos = new Float32Array(6);
    this.handVel = new Float32Array(6);
    this.handPrimed = new Uint8Array(2);
    this.handTracked = new Uint8Array(2);
    this.tetherSlot = new Int8Array(2).fill(-1);
    this.tetherUntil = new Float64Array(2);
    this.reelQueue = new Float32Array(2);
    this.lastReelFeedbackMs = new Float64Array(2).fill(Number.NEGATIVE_INFINITY);
    this.tetherPressStartMs = new Float64Array(2).fill(-1);
    this.tetherStrand = new Int8Array(2).fill(-1);
    this.jointIndices = new Int8Array(2 * JOINT_SLOTS).fill(-1);
    this.thwipScratch = {
      indexDist: 0,
      middleDist: 0,
      ringDist: 0,
      pinkyDist: 0,
    };
    this.thrustAnchor = new Float32Array(6);
    this.thrustElapsed = new Float32Array(2);
    this.thrustPrimed = new Uint8Array(2);

    this.gripPosition = new Vector3();
    this.forward = new Vector3(0, 0, -1);
    this.muzzle = new Vector3();
    this.ballPosition = new Vector3();
    this.strandDirection = new Vector3();
    this.strandMidpoint = new Vector3();
    this.strandOrientation = new Quaternion();
    this.strandUp = new Vector3(0, 1, 0);
    this.reelTarget = new Vector3();
    this.tetherAnchor = new Vector3();
    this.headPosition = new Vector3();

    this.buildStrandPool();

    this.cleanupFuncs.push(
      this.gamePhase.subscribe(() => this.applyArmedState()),
      this.activeStyle.subscribe(() => this.applyArmedState()),
      // GOO strands re-tint the moment the player dips a new colour. Event
      // driven, so update() never touches the colour.
      ...(this.activeColor
        ? [this.activeColor.subscribe(() => this.applyGooColors())]
        : []),
      // Any ball, however it was fired, lets go of whatever that hand was
      // reeling — "the same hand fires again" is one of the five ways a tether
      // ends, and keying it off the ball appearing catches the trigger, the
      // thwip and the thrust with one rule instead of three. Web balls also
      // pick up a strand off the wrist that threw them; that inversion is what
      // keeps BallSpawnSystem from having to import this system back.
      this.queries.webBalls.subscribe('qualify', (ball) => {
        const hand = ball.getValue(Ball, 'firedBy') ?? -1;
        if (hand !== 0 && hand !== 1) return;
        this.breakTether(hand);
        if (ball.getValue(Ball, 'style') !== BallStyle.Web) return;
        this.attachStrand(hand, ball, performance.now() / 1000);
      }),
    );
  }

  update(delta: number) {
    if (this.holdForPause(delta)) return;

    // Round 6 moved this gate from "is web ammo loaded" to "may anything be
    // fired at all". The gestures are a second trigger now, not a web feature,
    // so they have to be read whatever the palette says. (The hardware tracks
    // the wrist in every phase; GauntletSystem owns that since round 8.)
    if (!this.canFire()) return;

    const nowMs = performance.now();
    const nowSec = nowMs / 1000;
    this.lastDelta = delta;

    this.stepHand('left', 0, nowMs, delta);
    this.stepHand('right', 1, nowMs, delta);
    // Before the strands: a tether writes its strand's far end, and a tether
    // that just ended has to fade its strand this frame rather than next.
    this.updateTethers(nowSec, nowMs);
    this.updateStrands(nowSec);
  }

  /**
   * The pause guard, the same protocol TargetSystem follows.
   *
   * @returns true when this frame must not run: paused, or the first frame
   *   after a pause or a long stall, which is spent moving every deadline on
   *   by the time away and forgetting every motion sample — a hand that was
   *   at the Quest menu is not "moving at" wherever it is now.
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

    shiftTimestamps(this.tetherUntil, frozenSec);
    shiftTimestamps(this.strandFadeUntil, frozenSec);
    shiftTimestamps(this.strandStartedAt, frozenSec);
    for (let hand = 0; hand < 2; hand++) {
      this.thrustPrimed[hand] = 0;
      this.handPrimed[hand] = 0;
      this.reelQueue[hand] = 0;
    }
    return true;
  }

  /**
   * May anything be fired right now?
   *
   * {@link canFireInPhase} is shared with BallSpawnSystem so the trigger and
   * the gestures can never disagree about when firing is allowed — without it
   * nothing would stop a thwip throwing paint across the round-summary screen.
   */
  private canFire(): boolean {
    return canFireInPhase(this.gamePhase.peek(), FIRE.sandboxFireInIdle);
  }

  /**
   * Is web ammo loaded, in a phase that allows firing?
   *
   * Narrower than {@link canFire}. Since round 8 it no longer governs the
   * hardware (GauntletSystem shows the spinneret by blaster mode); it decides
   * whether strands and tethers may stay alive.
   */
  private armed(): boolean {
    return this.activeStyle.peek() === BallStyle.Web && this.canFire();
  }

  /** Live strand count, for tests and MCP-driven smoke checks. */
  get debugActiveStrands(): number {
    let count = 0;
    for (let slot = 0; slot < this.strandState.length; slot++) {
      if (this.strandState[slot] !== StrandState.Free) count++;
    }
    return count;
  }

  // ---- Per-hand: pose the shooter, then look for a reason to fire ----------

  private stepHand(
    side: 'left' | 'right',
    hand: number,
    nowMs: number,
    delta: number,
  ): void {
    const gauntlet = this.resolveGauntlet();
    // A disconnected controller or a hand that lost tracking leaves no pose
    // (GauntletSystem parks the hardware at its last one).
    if (!gauntlet || !gauntlet.isPosed(hand)) {
      // Drop the thrust anchor and the velocity sample. A hand that loses
      // tracking here and reappears somewhere else would otherwise be measured
      // as having crossed that whole gap inside one sample window — metres per
      // second of pure fiction, a web thrown at nothing and a robot hauled
      // halfway across the room.
      this.thrustPrimed[hand] = 0;
      this.handPrimed[hand] = 0;
      this.handTracked[hand] = 0;
      return;
    }

    gauntlet.palmInto(hand, this.gripPosition);
    this.sampleHandMotion(hand, delta);
    // The direction every shot from this wrist takes is the *shown* barrel's
    // -Z — smoothed, and identical to what the player sees. Round 6 used the
    // raw grip -Z, which on a tracked hand points at the thumb.
    gauntlet.aimInto(hand, this.forward);

    // The trigger is deliberately absent. It belongs to BallSpawnSystem, which
    // fires whatever the palette has loaded through the one firing path that
    // already knows about spray-on-hold and not shooting the HUD.
    //
    // The gestures stay, because nothing else can read finger joints — but they
    // go through the SAME entry point, so a thwip fires the loadout rather than
    // always webbing. They remain exempt from the don't-shoot-the-HUD rule:
    // curling two fingers cannot press a button.
    if (WEB.gestureEnabled && this.tryThwip(side, hand, nowMs)) {
      this.fireGesture(hand, nowMs);
    }

    // Not while this hand is hauling a tether (round 7). The recovery stroke of
    // a hand-over-hand haul is a push back toward the robot — along the aim,
    // often fast — and reading it as a thrust fired a ball, and any ball from
    // the reeling hand breaks its own line. The thwip stays live as the
    // deliberate "let go".
    if (this.tetherSlot[hand] >= 0) {
      this.thrustPrimed[hand] = 0;
      this.thrustGates[hand].latched = false;
    } else if (this.tryThrust(hand, delta, nowMs)) {
      this.fireGesture(hand, nowMs);
    }
  }

  /**
   * Record this hand's world position and per-frame velocity.
   *
   * One frame rather than a rolling window, unlike the thrust: a yank is
   * debounced by {@link WEB.yankCooldownMs} instead, and a 250 ms floor already
   * swallows the single-frame spikes the thrust window exists to average out.
   * Using a window here as well would make hauling feel a quarter-second late.
   */
  private sampleHandMotion(hand: number, delta: number): void {
    const base = hand * 3;
    // Round 7: a palm that jumps further than any real hand moves in a frame
    // is a hand that dropped out and came back somewhere else. Treat it as a
    // fresh acquisition — no velocity, a new thrust window, a snapped pose —
    // or the gap reads as a thrust (a shot nobody fired) or a giant haul.
    if (this.handPrimed[hand]) {
      const jx = this.gripPosition.x - this.handPos[base];
      const jy = this.gripPosition.y - this.handPos[base + 1];
      const jz = this.gripPosition.z - this.handPos[base + 2];
      const jump = WEB.reacquireJumpMeters;
      if (jx * jx + jy * jy + jz * jz > jump * jump) {
        this.handPrimed[hand] = 0;
        this.thrustPrimed[hand] = 0;
      }
    }
    if (this.handPrimed[hand] && delta > 0) {
      const inv = 1 / delta;
      this.handVel[base] = (this.gripPosition.x - this.handPos[base]) * inv;
      this.handVel[base + 1] =
        (this.gripPosition.y - this.handPos[base + 1]) * inv;
      this.handVel[base + 2] =
        (this.gripPosition.z - this.handPos[base + 2]) * inv;
    } else {
      this.handVel[base] = 0;
      this.handVel[base + 1] = 0;
      this.handVel[base + 2] = 0;
    }
    this.handPos[base] = this.gripPosition.x;
    this.handPos[base + 1] = this.gripPosition.y;
    this.handPos[base + 2] = this.gripPosition.z;
    this.handPrimed[hand] = 1;
    this.handTracked[hand] = 1;
  }

  /**
   * Classify this hand's fingers, then run the answer through its latch.
   *
   * Returns false the moment anything is missing — controllers in this hand, a
   * hand that has not been tracked yet, a joint set the runtime named
   * differently. Web mode still has two other triggers in that case, which is
   * the whole reason there are three.
   */
  private tryThwip(
    side: 'left' | 'right',
    hand: number,
    nowMs: number,
  ): boolean {
    if (!this.input.isPrimary('hand', side)) {
      // Controllers are driving this hand; clear the latch so switching back
      // to hands mid-session does not need a spurious pose to re-arm.
      this.thwipGates[hand].latched = false;
      return false;
    }

    const adapter = this.input.visualAdapters.hand[side];
    const transforms = adapter?.jointTransforms;
    if (!transforms || !this.resolveJointIndices(adapter, hand)) {
      this.thwipGates[hand].latched = false;
      return false;
    }

    const base = hand * JOINT_SLOTS;
    const wrist = this.jointIndices[base + JOINT_WRIST];
    const pose = this.thwipScratch;
    pose.indexDist = jointDistance(
      transforms,
      this.jointIndices[base + JOINT_INDEX],
      wrist,
    );
    pose.middleDist = jointDistance(
      transforms,
      this.jointIndices[base + JOINT_MIDDLE],
      wrist,
    );
    pose.ringDist = jointDistance(
      transforms,
      this.jointIndices[base + JOINT_RING],
      wrist,
    );
    pose.pinkyDist = jointDistance(
      transforms,
      this.jointIndices[base + JOINT_PINKY],
      wrist,
    );

    const posed = isThwipPose(pose, WEB);

    return stepGestureGate(
      this.thwipGates[hand],
      posed,
      nowMs,
      WEB.gestureCooldownMs,
    );
  }

  /**
   * Look up the five joints this system cares about in the runtime's own joint
   * order, and cache the result.
   *
   * The WebXR spec fixes the `XRHandJoint` names but the array order is
   * whatever the runtime's `XRHand` map iterates in — in practice the enum
   * order (wrist 0, index tip 9, middle tip 14, ring tip 19, pinky tip 24), but
   * resolving by name costs nothing here and cannot be wrong. The cache is
   * re-resolved only when the wrist slot stops naming the wrist, i.e. when a
   * hand connects or reconnects; the steady-state cost is one string compare.
   *
   * @returns true when all five joints were found.
   */
  private resolveJointIndices(
    adapter: { jointSpaces: ReadonlyArray<{ jointName?: string }> },
    hand: number,
  ): boolean {
    const base = hand * JOINT_SLOTS;
    const spaces = adapter.jointSpaces;

    if (spaces[this.jointIndices[base + JOINT_WRIST]]?.jointName === 'wrist') {
      return true;
    }

    for (let slot = 0; slot < JOINT_SLOTS; slot++) {
      this.jointIndices[base + slot] = -1;
    }
    for (let i = 0; i < spaces.length; i++) {
      const name = spaces[i]?.jointName;
      if (name === undefined) continue;
      for (let slot = 0; slot < JOINT_SLOTS; slot++) {
        if (JOINT_NAMES[slot] === name) {
          this.jointIndices[base + slot] = i;
          break;
        }
      }
    }
    for (let slot = 0; slot < JOINT_SLOTS; slot++) {
      if (this.jointIndices[base + slot] < 0) return false;
    }
    return true;
  }

  /**
   * Measure how hard this hand is being pushed forward, over a short rolling
   * window, and run the answer through its latch.
   *
   * The window (WEB.thrustWindowSec, 80 ms) is the difference between a gesture
   * and a hair trigger. One 11 ms frame of hand-tracking jitter is easily two
   * or three metres per second; averaged over 80 ms the noise cancels and only
   * a deliberate shove survives.
   */
  private tryThrust(hand: number, delta: number, nowMs: number): boolean {
    const base = hand * 3;

    if (!this.thrustPrimed[hand]) {
      this.thrustAnchor[base] = this.gripPosition.x;
      this.thrustAnchor[base + 1] = this.gripPosition.y;
      this.thrustAnchor[base + 2] = this.gripPosition.z;
      this.thrustElapsed[hand] = 0;
      this.thrustPrimed[hand] = 1;
      return false;
    }

    this.thrustElapsed[hand] += delta;
    if (this.thrustElapsed[hand] < WEB.thrustWindowSec) return false;

    const speed = forwardSpeed(
      this.thrustAnchor[base],
      this.thrustAnchor[base + 1],
      this.thrustAnchor[base + 2],
      this.gripPosition.x,
      this.gripPosition.y,
      this.gripPosition.z,
      this.forward.x,
      this.forward.y,
      this.forward.z,
      this.thrustElapsed[hand],
    );

    this.thrustAnchor[base] = this.gripPosition.x;
    this.thrustAnchor[base + 1] = this.gripPosition.y;
    this.thrustAnchor[base + 2] = this.gripPosition.z;
    this.thrustElapsed[hand] = 0;

    return stepGestureGate(
      this.thrustGates[hand],
      speed > WEB.thrustSpeed,
      nowMs,
      WEB.thrustCooldownMs,
    );
  }

  // ---- Firing --------------------------------------------------------------

  /**
   * Fire this hand's loadout from its wrist muzzle. Both gesture triggers land
   * here.
   *
   * ### The round-6 rewrite
   *
   * This used to build a white Web ball itself, which is why the gestures only
   * worked with web ammo loaded. It now hands the shot to
   * {@link BallSpawnSystem.fireFromGesture}, which resolves the palette exactly
   * as the trigger does: a thwip with red splash paint on throws red splash
   * paint, and a thwip with a tether web loaded throws a tether web. Everything
   * that used to be duplicated here — the loadout, the live-ball cap, the
   * velocity, the BallFired event and its packed hand and style bits — now
   * happens in one place, once.
   *
   * The cooldown moved with it, and is now **shared** with the trigger rather
   * than separate. Round 5's separate cooldowns were defensible when the two
   * inputs fired different ammo; now that they produce an identical ball,
   * keeping them apart would just be a way to double your rate of fire.
   *
   * **Aim is the shown barrel's -Z** (round 7), i.e. the smoothed aim frame
   * from {@link WristPose}: the target ray for controllers and, by default,
   * for hands too — the same ray the trigger and the pinch have always fired
   * along, so every way of shooting agrees. Round 6 aimed along the raw grip
   * -Z, which on a tracked hand points at the thumb; that, plus the device
   * being mounted in the same wrong frame, was the "shooters are perpendicular
   * to the forearm" report. The model's own mount rotation (for an optional
   * GLB) never steers the shot; {@link WEB.muzzleLocal} moves the spawn point,
   * nothing more.
   *
   * Public so an MCP-driven smoke test can fire without a hand or a controller.
   * Note that it throws along whatever direction the last {@link stepHand} left
   * in `this.forward`, so a synthetic call outside the update loop fires along
   * that hand's most recent pose rather than a freshly sampled one.
   *
   * @param hand 0 for the left hand, 1 for the right.
   */
  fireGesture(hand: number, nowMs: number): boolean {
    const spawner = this.resolveSpawner();
    if (!spawner) return false;

    this.muzzleFor(hand);
    // Neither the strand nor the tether break is applied here: spawnBall
    // qualifies the ball for the webBalls query, whose subscription does both
    // off `firedBy`. One mechanism, whichever input pulled the trigger.
    return (
      spawner.fireFromGesture(
        hand === 1 ? 'right' : 'left',
        this.muzzle.x,
        this.muzzle.y,
        this.muzzle.z,
        this.forward.x,
        this.forward.y,
        this.forward.z,
        nowMs,
      ) !== undefined
    );
  }

  /**
   * Where a gesture shot is born (round 8): out of whichever launcher the
   * blaster mode shows — the paint barrel in BLASTER, the spinneret nozzle
   * otherwise (HAND mode fires from the same, invisible, nozzle round 7 did)
   * — plus that launcher's clearance along the aim. Falls back to the palm.
   */
  private muzzleFor(hand: number): void {
    const gauntlet = this.resolveGauntlet();
    if (gauntlet?.isPosed(hand)) {
      gauntlet.shotOriginInto(hand, this.muzzle);
      return;
    }
    this.muzzle
      .copy(this.gripPosition)
      .addScaledVector(this.forward, WEB.muzzleOffset);
  }

  private resolveGauntlet(): GauntletSystem | undefined {
    if (!this.gauntlet) {
      this.gauntlet = this.world.getSystem(GauntletSystem);
    }
    return this.gauntlet;
  }

  private resolveSpawner(): BallSpawnSystem | undefined {
    // Looked up lazily rather than in init(): system registration order is
    // independent of priority, so BallSpawnSystem may not exist yet when this
    // system initialises. Same pattern BallFlightSystem uses for SplatterSystem.
    if (!this.spawner) {
      this.spawner = this.world.getSystem(BallSpawnSystem);
    }
    return this.spawner;
  }

  private resolveTargets(): TargetSystem | undefined {
    if (!this.targets) {
      this.targets = this.world.getSystem(TargetSystem);
    }
    return this.targets;
  }

  // ---- Tether --------------------------------------------------------------

  /**
   * Drive both hands' lines: mirror TargetSystem's view of who is holding what,
   * reel, and pop.
   *
   * **Polled, never pushed.** TargetSystem detects the latch (it is the only
   * thing that knows a ball touched a robot) at priority 14, one tick after
   * this system runs at 9 — so an event would already have been flushed by the
   * time this looked for it. Asking every frame costs two array scans over an
   * eight-slot pool and has the far more valuable property that the *robot*
   * side is the single source of truth: a round that ends, a slot that is shot
   * by the other hand, a pool that is reset — all of them free the slot, and
   * this notices on the very next frame without anyone sending a message.
   */
  private updateTethers(nowSec: number, nowMs: number): void {
    const targets = this.resolveTargets();
    if (!targets) return;

    let anyLive = false;
    for (let hand = 0; hand < 2; hand++) {
      if (targets.tetherSlotForHand(hand) >= 0) anyLive = true;
    }
    // Nothing attached and nothing to tidy up: skip the head lookup entirely.
    if (!anyLive && this.tetherSlot[0] < 0 && this.tetherSlot[1] < 0) return;

    this.player?.head?.getWorldPosition(this.headPosition);

    for (let hand = 0; hand < 2; hand++) {
      const slot = targets.tetherSlotForHand(hand);

      if (slot < 0) {
        // Gone — timed out, shot by someone else, round over, pool reset.
        if (this.tetherSlot[hand] >= 0) this.releaseTetherStrand(hand);
        this.tetherSlot[hand] = -1;
        continue;
      }

      if (this.tetherSlot[hand] !== slot) {
        this.tetherSlot[hand] = slot;
        this.tetherUntil[hand] = nowSec + WEB.tetherMaxSec;
        this.reelQueue[hand] = 0;
        this.lastReelFeedbackMs[hand] = Number.NEGATIVE_INFINITY;
        this.tetherPressStartMs[hand] = -1;
        this.adoptTetherStrand(hand, nowSec);
      }

      if (nowSec >= this.tetherUntil[hand]) {
        targets.endTether(slot, false);
        this.releaseTetherStrand(hand);
        this.tetherSlot[hand] = -1;
        continue;
      }

      if (!targets.tetherAnchorInto(slot, this.tetherAnchor)) continue;
      this.drawTetherStrand(hand);

      // Close enough to your face to count. Measured off the head rather than
      // the hand: an arm held out at full stretch would otherwise pop things
      // that are still most of a room away.
      if (
        this.tetherAnchor.distanceTo(this.headPosition) < WEB.tetherKillRadius
      ) {
        targets.endTether(slot, true);
        this.releaseTetherStrand(hand);
        this.tetherSlot[hand] = -1;
        continue;
      }

      if (this.tapReleased(hand, nowMs)) {
        targets.endTether(slot, false);
        this.releaseTetherStrand(hand);
        this.tetherSlot[hand] = -1;
        continue;
      }

      this.reelHand(targets, hand, slot, nowMs);
    }
  }

  /**
   * Did the tethered hand just *tap* — press and let go inside
   * {@link WEB.releaseTapMs}? That is "let go of the line" (round 7). Holding
   * the same press reels instead, so one verb covers both, for hands (pinch)
   * and controllers (trigger) alike. Before this a controller player had no
   * deliberate release at all: their tethered hand cannot fire, the thrust is
   * off while hauling, and there are no fingers to curl.
   */
  private tapReleased(hand: number, nowMs: number): boolean {
    const gamepad = this.input?.gamepads?.[hand === 1 ? 'right' : 'left'];
    if (!gamepad) return false;
    if (gamepad.getSelectStart()) this.tetherPressStartMs[hand] = nowMs;
    if (!gamepad.getSelectEnd()) return false;
    const started = this.tetherPressStartMs[hand];
    this.tetherPressStartMs[hand] = -1;
    return started >= 0 && nowMs - started < WEB.releaseTapMs;
  }

  /**
   * Haul on this hand's line: queue up line from every source, then pay the
   * queue out at a bounded speed (round 7).
   *
   * Three sources, all live at once, because the input modes want different
   * things and a player doing two of them at once is asking to reel faster:
   *
   * 1. **Pull** — the hand's velocity projected onto robot -> hand, through
   *    {@link pullReel}. Pushing back toward the robot projects negative and
   *    takes in nothing, so hand-over-hand hauling works: the recovery stroke
   *    is free. Proportional rather than round 6's fixed 0.55 m chunk, so a
   *    small tug is a small reel.
   * 2. **Pinch / trigger held** on this hand. BallSpawnSystem stops firing a
   *    hand that holds a line (see its `tetheredHands` check), so the press
   *    that would have shot — and broken the tether — reels instead. This is
   *    the hand-tracking player's "hold to reel", which round 6 did not have.
   * 3. **Squeeze held** — the controller player's.
   *
   * The queue drains through {@link drainReelQueue} at up to
   * {@link WEB.reelGlideSpeed}, which is the whole fix for the round-6 robot
   * that teleported half a metre per yank: now it glides. While tracking is
   * lost nothing new is queued, but what is already queued still finishes,
   * toward the last place the hand was seen — a short, readable settle rather
   * than a dead stop.
   */
  private reelHand(
    targets: TargetSystem,
    hand: number,
    slot: number,
    nowMs: number,
  ): void {
    const base = hand * 3;
    const delta = this.lastDelta;
    this.reelTarget.set(
      this.handPos[base],
      this.handPos[base + 1],
      this.handPos[base + 2],
    );

    if (this.handTracked[hand]) {
      // (1) PULL.
      let dx = this.reelTarget.x - this.tetherAnchor.x;
      let dy = this.reelTarget.y - this.tetherAnchor.y;
      let dz = this.reelTarget.z - this.tetherAnchor.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance > 1e-4) {
        const inv = 1 / distance;
        dx *= inv;
        dy *= inv;
        dz *= inv;
        const away =
          this.handVel[base] * dx +
          this.handVel[base + 1] * dy +
          this.handVel[base + 2] * dz;
        this.reelQueue[hand] += pullReel(away, delta, WEB);
      }

      // (2) + (3) HOLD. Frame-rate independent, so a 72 Hz headset and a
      // 90 Hz one reel at the same metres per second.
      const gamepad = this.input?.gamepads?.[hand === 1 ? 'right' : 'left'];
      if (
        gamepad?.getSelecting() ||
        gamepad?.getButtonPressed(InputComponent.Squeeze)
      ) {
        this.reelQueue[hand] += WEB.reelSpeed * delta;
      }

      if (this.reelQueue[hand] > WEB.reelQueueMax) {
        this.reelQueue[hand] = WEB.reelQueueMax;
      }
    }

    const step = drainReelQueue(this.reelQueue[hand], WEB.reelGlideSpeed, delta);
    if (step <= 0) return;
    this.reelQueue[hand] -= step;
    targets.reelTether(slot, this.reelTarget, step);

    // A light ratchet on the hauling arm, rate-limited: reeling is continuous
    // now, and a buzz every frame would numb the hand rather than read as
    // line coming in. data = hand in bit 8, the layout every hand-carrying
    // event uses, so FeedbackSystem can buzz the arm doing the work.
    if (nowMs - this.lastReelFeedbackMs[hand] >= WEB.reelFeedbackMs) {
      this.lastReelFeedbackMs[hand] = nowMs;
      this.events.emit(
        GameEvent.TetherReeled,
        this.tetherAnchor.x,
        this.tetherAnchor.y,
        this.tetherAnchor.z,
        packTetherData(slot, hand),
      );
    }
  }

  /**
   * End this hand's tether early without popping — the "fired again" and
   * "unloaded the ammo" cases. Safe to call when there is nothing attached.
   */
  private breakTether(hand: number): void {
    const slot = this.tetherSlot[hand];
    if (slot < 0) return;
    this.tetherSlot[hand] = -1;
    this.resolveTargets()?.endTether(slot, false);
    this.releaseTetherStrand(hand);
  }

  /** Both hands let go. Used when web ammo is unloaded or the round ends. */
  private breakAllTethers(): void {
    this.breakTether(0);
    this.breakTether(1);
  }

  // ---- Strands -------------------------------------------------------------

  /**
   * Claim a strand slot for a freshly thrown web.
   *
   * A free slot if there is one, otherwise the oldest busy one — retiring a
   * strand early is far better than silently dropping the strand on the web the
   * player is watching right now.
   */
  private attachStrand(hand: number, ball: Entity, nowSec: number): void {
    const slot = this.claimStrandSlot(hand, nowSec);
    if (slot < 0) return;

    this.strandState[slot] = StrandState.Flying;
    this.strandBalls[slot] = ball;
    this.strandBallObjects[slot] = ball.object3D;
    this.strandEntities[slot]?.setValue(
      WebStrand,
      'state',
      StrandState.Flying,
    );
  }

  /**
   * Take a strand slot for this hand: a free one if there is one, otherwise the
   * oldest busy one.
   *
   * Retiring a strand early is far better than silently dropping the strand on
   * the web the player is watching right now. A **tethered** slot is never
   * evicted, though: it is a live line the player is actively hauling on, and a
   * thread that vanished mid-reel would look like the tether had broken when it
   * had not.
   */
  private claimStrandSlot(hand: number, nowSec: number): number {
    let slot = -1;
    let oldest = Number.POSITIVE_INFINITY;

    for (let i = 0; i < this.strandState.length; i++) {
      if (this.strandState[i] === StrandState.Free) {
        slot = i;
        break;
      }
      if (this.strandState[i] === StrandState.Tethered) continue;
      if (this.strandStartedAt[i] < oldest) {
        oldest = this.strandStartedAt[i];
        slot = i;
      }
    }
    if (slot < 0) return -1;

    this.strandSide[slot] = hand;
    this.strandStartedAt[slot] = nowSec;
    this.strandFadeUntil[slot] = 0;
    this.strandBalls[slot] = undefined;
    this.strandBallObjects[slot] = undefined;
    this.strandMaterials[slot].opacity = 1;
    this.tintStrand(slot, false);

    const entity = this.strandEntities[slot];
    if (entity?.object3D) entity.object3D.visible = true;
    return slot;
  }

  /**
   * Give this hand a persistent strand for a tether that has just taken hold.
   *
   * Prefers to **reuse the strand the tether ball was already trailing** rather
   * than claim a fresh one, which is the difference between the thread carrying
   * on into the robot and a second thread appearing beside the first while the
   * original fades. That strand is this hand's most recent, and it will be
   * either still Flying (its ball was destroyed by TargetSystem last tick and
   * nothing has noticed yet) or already Fading.
   */
  private adoptTetherStrand(hand: number, nowSec: number): void {
    let slot = -1;
    let newest = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.strandState.length; i++) {
      const state = this.strandState[i];
      if (state !== StrandState.Flying && state !== StrandState.Fading) {
        continue;
      }
      if (this.strandSide[i] !== hand) continue;
      if (this.strandStartedAt[i] > newest) {
        newest = this.strandStartedAt[i];
        slot = i;
      }
    }
    if (slot < 0) slot = this.claimStrandSlot(hand, nowSec);
    if (slot < 0) return;

    this.strandState[slot] = StrandState.Tethered;
    this.strandSide[slot] = hand;
    this.strandFadeUntil[slot] = 0;
    this.strandBalls[slot] = undefined;
    this.strandBallObjects[slot] = undefined;
    this.strandMaterials[slot].opacity = 1;
    this.tintStrand(slot, true);
    this.tetherStrand[hand] = slot;

    const entity = this.strandEntities[slot];
    entity?.setValue(WebStrand, 'state', StrandState.Tethered);
    if (entity?.object3D) entity.object3D.visible = true;
  }

  /** Point this hand's tether strand at the robot's current position. */
  private drawTetherStrand(hand: number): void {
    const slot = this.tetherStrand[hand];
    if (slot < 0 || this.strandState[slot] !== StrandState.Tethered) return;
    const base = slot * 3;
    this.strandEndPoint[base] = this.tetherAnchor.x;
    this.strandEndPoint[base + 1] = this.tetherAnchor.y;
    this.strandEndPoint[base + 2] = this.tetherAnchor.z;
  }

  /**
   * The line let go: hand the strand over to the ordinary fade rather than
   * blinking it out. Whatever ended the tether, the thread going slack and
   * dissolving is the readable version of it.
   */
  private releaseTetherStrand(hand: number): void {
    const slot = this.tetherStrand[hand];
    this.tetherStrand[hand] = -1;
    if (slot < 0) return;
    if (this.strandState[slot] !== StrandState.Tethered) return;

    this.strandState[slot] = StrandState.Fading;
    this.strandFadeUntil[slot] = performance.now() / 1000 + WEB.strandLingerSec;
    this.strandEntities[slot]?.setValue(
      WebStrand,
      'state',
      StrandState.Fading,
    );
  }

  /**
   * Stretch every busy strand between its wrist and its far end, and retire the
   * ones whose fade has run out.
   *
   * The near end always tracks the live wrist, including through the fade — a
   * strand pinned at the pose the hand held half a second ago detaches from the
   * shooter the instant the player moves, which looks far worse than a strand
   * that stays connected while it dissolves. The far end tracks the ball while
   * it flies, follows the robot while a tether holds it, and freezes where it
   * landed.
   */
  private updateStrands(nowSec: number): void {
    for (let slot = 0; slot < this.strandState.length; slot++) {
      const state = this.strandState[slot];
      if (state === StrandState.Free) continue;

      const base = slot * 3;

      // A tethered strand has no timer and no ball to chase: updateTethers has
      // already written its far end from the live robot. Just draw it.
      if (state === StrandState.Tethered) {
        this.stretchStrand(slot, base);
        continue;
      }

      if (state === StrandState.Flying) {
        const ball = this.strandBalls[slot];
        const captured = this.strandBallObjects[slot];
        // Both halves matter: `active` catches the destroy, and the mesh
        // identity catches an index that has already been recycled into a
        // different ball. @see strandBallObjects
        const ballObject =
          ball?.active && ball.object3D === captured ? captured : undefined;

        if (ballObject) {
          ballObject.getWorldPosition(this.ballPosition);
          this.strandEndPoint[base] = this.ballPosition.x;
          this.strandEndPoint[base + 1] = this.ballPosition.y;
          this.strandEndPoint[base + 2] = this.ballPosition.z;
        } else {
          // The ball splatted (or was culled) — pin the far end where it was
          // last seen, which is the splat, and start dissolving.
          this.strandState[slot] = StrandState.Fading;
          this.strandFadeUntil[slot] = nowSec + WEB.strandLingerSec;
          this.strandBalls[slot] = undefined;
          this.strandBallObjects[slot] = undefined;
          this.strandEntities[slot]?.setValue(
            WebStrand,
            'state',
            StrandState.Fading,
          );
        }
      }

      if (this.strandState[slot] === StrandState.Fading) {
        const remaining = this.strandFadeUntil[slot] - nowSec;
        if (remaining <= 0) {
          this.releaseStrand(slot);
          continue;
        }
        this.strandMaterials[slot].opacity =
          remaining / Math.max(1e-6, WEB.strandLingerSec);
      }

      this.stretchStrand(slot, base);
    }
  }

  /**
   * Lay one cylinder between the nozzle and the strand's far end.
   *
   * The near end is the muzzle, not the shooter's origin, so a strand comes out
   * of the hole the web came out of however the cuff is mounted. No
   * WEB.muzzleOffset here, deliberately: that offset exists to birth the *ball*
   * clear of the hand, and adding it to the thread as well would leave a
   * centimetres-wide gap between the nozzle and the strand that starts at it.
   *
   * The geometry is a unit-height cylinder standing on +Y, so the whole thing is
   * position-at-the-midpoint, rotate-up-onto-the-direction, scale-Y-to-length —
   * three writes into scratch objects and no allocation.
   */
  private stretchStrand(slot: number, base: number): void {
    const object3D = this.strandEntities[slot]?.object3D;
    if (!object3D) return;

    const hand = this.strandSide[slot];
    const side = hand === 0 ? 'left' : 'right';
    const grip = this.player?.gripSpaces?.[side];

    const gauntlet = this.resolveGauntlet();
    if (gauntlet) {
      // The spinneret nozzle; parked at its last pose while tracking is lost.
      gauntlet.nozzleInto(hand, this.strandMidpoint);
    } else if (grip) {
      grip.getWorldPosition(this.strandMidpoint);
    } else {
      // No wrist to hang from this frame; leave the strand where it was.
      return;
    }

    this.strandDirection
      .set(
        this.strandEndPoint[base] - this.strandMidpoint.x,
        this.strandEndPoint[base + 1] - this.strandMidpoint.y,
        this.strandEndPoint[base + 2] - this.strandMidpoint.z,
      );
    const length = this.strandDirection.length();
    if (length < 1e-4) {
      object3D.visible = false;
      return;
    }
    object3D.visible = true;
    this.strandDirection.multiplyScalar(1 / length);

    this.strandMidpoint.addScaledVector(this.strandDirection, length / 2);
    this.strandOrientation.setFromUnitVectors(
      this.strandUp,
      this.strandDirection,
    );

    setWorldPosition(object3D, this.strandMidpoint);
    setWorldQuaternion(object3D, this.strandOrientation);
    object3D.scale.set(1, length, 1);
  }

  /** Hand a slot back to the pool. */
  private releaseStrand(slot: number): void {
    this.strandState[slot] = StrandState.Free;
    this.strandBalls[slot] = undefined;
    this.strandBallObjects[slot] = undefined;
    this.strandFadeUntil[slot] = 0;
    this.strandMaterials[slot].opacity = 1;
    // A hand pointing at this slot must be cleared too, or the next tether
    // would draw itself down a strand the pool has already handed to someone
    // else.
    for (let hand = 0; hand < 2; hand++) {
      if (this.tetherStrand[hand] === slot) this.tetherStrand[hand] = -1;
    }

    const entity = this.strandEntities[slot];
    entity?.setValue(WebStrand, 'state', StrandState.Free);
    if (entity?.object3D) entity.object3D.visible = false;
  }

  /** Retire every strand at once — used when web ammo is unloaded. */
  private releaseAllStrands(): void {
    for (let slot = 0; slot < this.strandState.length; slot++) {
      this.releaseStrand(slot);
    }
  }

  // ---- Lifecycle -----------------------------------------------------------

  /**
   * Strands and tethers exist exactly while web ammo is loaded and firing is
   * allowed. Both signals feed this, because either can turn it off: swapping
   * to a paint chip, or the round ending under you.
   *
   * Since round 8 this no longer touches the hardware: GauntletSystem shows
   * the spinneret by blaster mode.
   *
   * Unloading drops every tether and every strand immediately rather than
   * letting them fade: a line hanging in mid-air off a wrist whose spinneret
   * is stowing is a bug the player can see.
   *
   * Note the gesture *latches* are cold-started here but the gestures
   * themselves are not disabled — with paint loaded a thwip still fires paint.
   * What must not happen is a stale latch or a window's worth of hand travel
   * from before the swap throwing a shot the player did not ask for.
   */
  private applyArmedState(): void {
    if (!this.armed()) {
      this.breakAllTethers();
      this.releaseAllStrands();
      for (let hand = 0; hand < 2; hand++) {
        this.thwipGates[hand].latched = false;
        this.thrustGates[hand].latched = false;
        this.thrustPrimed[hand] = 0;
      }
    }
  }

  // ---- Construction --------------------------------------------------------

  /**
   * Colour one strand's material: the loaded paint colour for GOO (or white
   * with {@link WEB.gooUsesPaintColor} off), lifted toward white for a tether.
   * Writes into the existing Color — no allocation.
   */
  private tintStrand(slot: number, tether: boolean): void {
    const material = this.strandMaterials[slot];
    if (!material) return;
    const rgb = gooStrandRgb(
      this.activeColor?.peek(),
      WEB.gooUsesPaintColor,
      tether,
      WEB.gooTetherLift,
      this.gooRgb,
    );
    material.color.setRGB(rgb[0], rgb[1], rgb[2], SRGBColorSpace);
  }

  /** Re-tint every strand after a colour change; tether lines keep their lift. */
  private applyGooColors(): void {
    for (let slot = 0; slot < this.strandMaterials.length; slot++) {
      this.tintStrand(slot, this.strandState[slot] === StrandState.Tethered);
    }
  }

  /**
   * Build the strand pool once: WEB.strandPool hidden cylinders, each with its
   * own material.
   *
   * Own material, not a shared one, precisely because the fade is per strand —
   * one material would make every live strand dissolve together the moment any
   * single web landed.
   */
  private buildStrandPool(): void {
    // Unit height standing on +Y, so a Y scale IS the strand length.
    const geometry = new CylinderGeometry(
      WEB.strandRadius,
      WEB.strandRadius,
      1,
      6,
      1,
      true,
    );

    for (let slot = 0; slot < WEB.strandPool; slot++) {
      const material = new MeshBasicMaterial({
        color: new Color(1, 1, 1),
        transparent: true,
        opacity: 1,
        // Threads crossing each other should blend, not punch holes in one
        // another through the depth buffer.
        depthWrite: false,
      });
      const mesh = new Mesh(geometry, material);
      mesh.name = `GooStrand_${slot}`;
      mesh.visible = false;
      mesh.frustumCulled = false;

      const entity = this.world
        .createTransformEntity(mesh, {
          parent: this.world.sceneEntity,
          persistent: true,
        })
        .addComponent(WebStrand, { slot, state: StrandState.Free });

      this.strandEntities.push(entity);
      this.strandMaterials.push(material);
      this.strandBalls.push(undefined);
      this.strandBallObjects.push(undefined);
      this.strandState[slot] = StrandState.Free;
    }
    this.applyGooColors();
  }
}

/**
 * Distance between two joints, straight out of IWSDK's packed joint transforms.
 *
 * `jointTransforms` is one column-major 4x4 per joint, so the translation of
 * joint *i* is floats 12..14 of its 16-float stride. Reading them directly
 * beats decomposing into a Matrix4 — this runs four times per hand per frame.
 *
 * Returns Infinity for an unresolved joint index, which fails every "is it
 * curled" test and passes every "is it extended" one — so a missing joint can
 * never be mistaken for a thwip.
 */
function jointDistance(
  transforms: Float32Array,
  jointIndex: number,
  wristIndex: number,
): number {
  if (jointIndex < 0 || wristIndex < 0) return Number.POSITIVE_INFINITY;
  const a = jointIndex * 16;
  const b = wristIndex * 16;
  if (a + 14 >= transforms.length || b + 14 >= transforms.length) {
    return Number.POSITIVE_INFINITY;
  }
  const dx = transforms[a + 12] - transforms[b + 12];
  const dy = transforms[a + 13] - transforms[b + 13];
  const dz = transforms[a + 14] - transforms[b + 14];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
