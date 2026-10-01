import {
  AssetManager,
  Box3,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Group,
  InputComponent,
  Interactable,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OneHandGrabbable,
  PokeInteractable,
  Quaternion,
  TorusGeometry,
  Types,
  Vector3,
  createComponent,
  createSystem,
  setWorldPosition,
  setWorldQuaternion,
} from '@iwsdk/core';
import type { Entity, Object3D, Texture } from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import { FIRE, WEB } from '../config';
import {
  BallStyle,
  GameEvent,
  GameEventBuffer,
  GamePhase,
  WebSubMode,
  packTetherData,
} from '../types';
import {
  Ball,
  BallSpawnSystem,
  SELECTED_PAD_SCALE,
  WebModePad,
  canFireInPhase,
} from './BallSpawnSystem';
import { TargetSystem } from './TargetSystem';
import { WEB_SPLAT_TEXTURE_KEY } from './SplatterSystem';

/**
 * Optional AssetManifest key for a modelled web shooter.
 *
 * Drop `public/gltf/web-shooter.glb` in and uncomment the manifest entry marked
 * ROUND4-WEBSHOOTER-ASSET in main.ts, and both wrists wear that model instead
 * of the primitive below. Same contract as the palette board and the easel: the
 * art is decorative, every behaviour is in code, and the fallback ships.
 */
export const WEB_SHOOTER_ASSET_KEY = 'webShooter';

const DEG_TO_RAD = Math.PI / 180;

/**
 * Sign to apply to everything X-ish for this hand: -1 left, +1 right.
 *
 * The WebXR grip frame is right-handed and defined identically for both hands,
 * which means it does *not* mirror with the anatomy: +X is thumb-side on the
 * left hand and pinky-side on the right. So every X offset, and every rotation
 * component about an axis that reflection flips (Y and Z, i.e. yaw and roll),
 * is declared once in the right hand's frame and negated for the left. Pitch,
 * about X itself, survives reflection unchanged and is never negated.
 */
function handMirror(hand: number): number {
  return hand === 0 ? -1 : 1;
}

/** Body colour of the primitive shooter — near-black, so the accent reads. */
const SHOOTER_BODY_COLOR = '#2a2c33';
/** Nozzle accent. The same coral the HUD uses for its web controls. */
const SHOOTER_ACCENT_COLOR = '#ff6b6b';

/**
 * Selector pad colours. The splat pad wears the same web-grey as the WEB chip
 * on the palette, so the two read as the same thing; the tether pad takes the
 * HUD's sky accent, because a hook is a different verb and should not have to
 * be read by shape alone at 2 cm across.
 */
const SELECTOR_SPLAT_COLOR = '#e8e8ee';
const SELECTOR_TETHER_COLOR = '#48dbfb';
/**
 * The disc behind the splat pad's web. Near-black, so a pale web mask has
 * something to read against — on its own the mask disappears into a passthrough
 * hand. @see buildSplatPad
 */
const SELECTOR_BACKING_COLOR = '#33383f';

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

/** Marks one of the two wrist-mounted shooters. 0 = left hand, 1 = right. */
export const WebShooter = createComponent('WebShooter', {
  side: { type: Types.Int8, default: 0 },
});

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
 * Work out how much to shrink a web-shooter model, by finding its band.
 *
 * Round 4 fitted the model's **longest** axis to a target length, on the
 * assumption that a shooter is longer than it is wide. That is the wrong
 * measurement for a thing you wear: a wrist is a fixed size, so what decides
 * whether a cuff looks right is the diameter of its band, and the longest axis
 * of an arbitrary model is whatever happens to stick out furthest.
 *
 * Finding the band needs no metadata, only the bounding box. A band is a ring,
 * and a ring's bounding box has **two roughly equal large extents** — the plane
 * the ring lies in — and one smaller one along the hole. So: take the pair of
 * axes whose extents are closest in ratio, call the plane they span the band,
 * and call the leftover axis the hole. On the shipped GLB (0.73 x 1.85 x 1.90)
 * that picks y/z as the band and x as the hole, which is exactly right.
 *
 * `lengthMeters` is then a cap rather than the target: art that is genuinely
 * long and thin — a barrel, a gauntlet — would be scaled up absurdly by a band
 * fit, so if band-fitting would push the longest axis past the cap, the model
 * is length-fitted instead and `cappedByLength` says so.
 *
 * Pure apart from writing `out`, and free of IWSDK, so both branches are swept
 * in tests without a model.
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

  // A degenerate model (a single point, an empty scene) has no band and no
  // length; leave it alone rather than dividing by zero.
  if (longest <= 0) {
    out.scale = 1;
    out.bandAxis = 0;
    out.bandSpan = 0;
    out.cappedByLength = false;
    return;
  }

  // Ratio of the smaller extent to the larger, per pair — 1 means "these two
  // are equal", which is what a ring's two in-plane extents look like.
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

/** The four fingertip-to-wrist distances a thwip is judged on, in metres. */
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

/** The two numbers {@link shouldYank} compares against. */
export interface YankThresholds {
  readonly yankSpeed: number;
  readonly yankCooldownMs: number;
}

/**
 * Did the player just yank the line?
 *
 * `velTowardHand` is the hand's velocity **projected onto the direction from
 * the robot to the hand** — the same trick {@link forwardSpeed} plays with the
 * pointing axis, and for the same reason. A yank is a pull *away from the thing
 * on the end of the line*, so pushing toward it projects negative and a
 * sideways sweep projects to nothing. Neither reels, which is what stops
 * ordinary arm movement from hauling a robot across the room.
 *
 * Unlike {@link stepGestureGate} there is no latch here, only a cooldown. That
 * is deliberate and it is the difference between a trigger and a ratchet:
 * repeated yanking is the *intended* verb, so a player hauling hand-over-hand
 * must be able to keep firing this without ever letting the speed fall back
 * through zero. The cooldown alone stops one continuous pull from counting
 * several times.
 *
 * Pure, and free of IWSDK, so the rule can be swept without a hand.
 */
export function shouldYank(
  velTowardHand: number,
  cooldownElapsedMs: number,
  cfg: YankThresholds,
): boolean {
  return (
    velTowardHand > cfg.yankSpeed && cooldownElapsedMs >= cfg.yankCooldownMs
  );
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
 * two ways to pull on it, a yank and a held squeeze.
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
 * Plus the shooters themselves, the wrist sub-mode selector hanging off the
 * left one, and the strand pool. Strands are attached by watching Ball entities
 * appear rather than by the firing code asking for one — see the `webBalls`
 * query — so a web thrown by the trigger, the thwip or the thrust all trail
 * exactly the same thread, and BallSpawnSystem never has to import this system
 * back.
 *
 * Runs at priority 9 — after WristPaletteSystem (8), before BallSpawnSystem
 * (10). It must sit well above IWSDK's InputSystem (priority -4), which is what
 * refreshes the hand joint transforms this system classifies: at a lower
 * priority the gesture would be judged on last frame's fingers.
 *
 * Zero allocations in update(): the shooters, the strand pool, the per-hand
 * gates and every vector are built once in init().
 */
export class WebShooterSystem extends createSystem({
  shooters: { required: [WebShooter] },
  strands: { required: [WebStrand] },
  // Every ball, so a web ball can be given its strand the instant it exists —
  // and so ANY shot from a hand can let go of whatever that hand was reeling.
  webBalls: { required: [Ball] },
}) {
  private gamePhase!: Signal<GamePhase>;
  private activeStyle!: Signal<BallStyle>;
  private webSubMode!: Signal<WebSubMode>;
  private events!: GameEventBuffer;
  private spawner?: BallSpawnSystem;
  private targets?: TargetSystem;

  /**
   * The two shooter entities and the strand pool. Fixed-length, built once,
   * reused forever — object pools, not the ad-hoc entity tracking the ECS
   * guidance warns about, and the same exception TargetSystem's robot pool
   * makes.
   */
  private readonly shooterEntities: Array<Entity | undefined> = [
    undefined,
    undefined,
  ];
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
  /** performance.now() ms of this hand's last yank. */
  private lastYankMs!: Float64Array;
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
  /** Thrust window anchor: grip world position, xyz per hand. */
  private thrustAnchor!: Float32Array;
  /** Seconds accumulated into the current thrust sample window, per hand. */
  private thrustElapsed!: Float32Array;
  /** False until the anchor holds a real sample, per hand. */
  private thrustPrimed!: Uint8Array;

  // Scratch — reused every frame, never reallocated.
  private gripPosition!: Vector3;
  private gripOrientation!: Quaternion;
  private localOffset!: Vector3;
  private targetPosition!: Vector3;
  private forward!: Vector3;
  private muzzle!: Vector3;
  private ballPosition!: Vector3;
  private strandDirection!: Vector3;
  private strandMidpoint!: Vector3;
  private strandOrientation!: Quaternion;
  private strandUp!: Vector3;
  private measureBox!: Box3;
  private measureSize!: Vector3;
  private measureCentre!: Vector3;
  /** Where the nozzle is, in world space. Written by {@link muzzleWorld}. */
  private nozzle!: Vector3;
  /** Reel target: this hand's grip, rebuilt from `handPos` each frame. */
  private reelTarget!: Vector3;
  /** The tethered robot's current position. */
  private tetherAnchor!: Vector3;
  /** The player's head, for the kill-radius test. */
  private headPosition!: Vector3;

  init() {
    this.gamePhase = this.globals.gamePhase as Signal<GamePhase>;
    this.activeStyle = this.globals.activeStyle as Signal<BallStyle>;
    this.webSubMode = this.globals.webSubMode as Signal<WebSubMode>;
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
    this.lastYankMs = new Float64Array(2).fill(Number.NEGATIVE_INFINITY);
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
    this.gripOrientation = new Quaternion();
    this.localOffset = new Vector3();
    this.targetPosition = new Vector3();
    this.forward = new Vector3();
    this.muzzle = new Vector3();
    this.ballPosition = new Vector3();
    this.strandDirection = new Vector3();
    this.strandMidpoint = new Vector3();
    this.strandOrientation = new Quaternion();
    this.strandUp = new Vector3(0, 1, 0);
    this.measureBox = new Box3();
    this.measureSize = new Vector3();
    this.measureCentre = new Vector3();
    this.nozzle = new Vector3();
    this.reelTarget = new Vector3();
    this.tetherAnchor = new Vector3();
    this.headPosition = new Vector3();

    this.buildShooters();
    this.buildStrandPool();

    this.cleanupFuncs.push(
      this.gamePhase.subscribe(() => this.applyArmedState()),
      this.activeStyle.subscribe(() => this.applyArmedState()),
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
    // Round 6 moved this gate from "is web ammo loaded" to "may anything be
    // fired at all". The gestures are a second trigger now, not a web feature,
    // so they have to be read whatever the palette says — and the shooter
    // holders have to keep tracking the wrist even while the models are hidden,
    // because a paint thwip still fires from the same grip muzzle.
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
   * Narrower than {@link canFire}, and it governs only *hardware*: the wrist
   * shooters and the selector gadget are web equipment, so they appear exactly
   * when webbing is loaded. A paint thwip fires from the same invisible muzzle.
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
    const grip = this.player?.gripSpaces?.[side];
    // A disconnected controller leaves its grip space hidden rather than posed;
    // parking the shooter at its last pose beats snapping it to the world
    // origin. Same guard WristPaletteSystem makes.
    if (!grip || grip.visible === false) {
      // Drop the thrust anchor and the velocity sample with it. A hand that
      // loses tracking here and reappears somewhere else would otherwise be
      // measured as having crossed that whole gap inside one sample window —
      // metres per second of pure fiction, a web thrown at nothing and a robot
      // yanked halfway across the room.
      this.thrustPrimed[hand] = 0;
      this.handPrimed[hand] = 0;
      this.handTracked[hand] = 0;
      return;
    }

    grip.getWorldPosition(this.gripPosition);
    grip.getWorldQuaternion(this.gripOrientation);
    // XR grip spaces point along their LOCAL -Z, the way the hand is aimed.
    this.forward.set(0, 0, -1).applyQuaternion(this.gripOrientation);

    this.sampleHandMotion(hand, delta);
    this.poseShooter(hand);

    // The trigger is deliberately absent. It belongs to BallSpawnSystem, which
    // fires whatever the palette has loaded through the one firing path that
    // already knows about spray-on-hold and not shooting the HUD.
    //
    // The gestures stay, because nothing else can read finger joints — but they
    // now go through the SAME entry point, so a thwip fires the loadout rather
    // than always webbing. They remain exempt from the don't-shoot-the-HUD
    // rule: curling two fingers cannot press a button, so there is nothing to
    // disambiguate.
    if (WEB.gestureEnabled && this.tryThwip(side, hand, nowMs)) {
      this.fireGesture(hand, nowMs);
    }

    if (this.tryThrust(hand, delta, nowMs)) {
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
   * Copy the grip's pose onto this hand's shooter holder.
   *
   * The holder stays **grip-aligned** — the mount rotation lives on the model
   * inside it (see {@link buildShooters}), which is what lets
   * {@link WEB.muzzleLocal} be a plain point in a frame a tuner can reason
   * about rather than a point in whatever frame the exporter chose.
   *
   * Everything X-ish is mirrored between hands. The grip frame is right-handed
   * for both hands, so +X is thumb-side on the left and pinky-side on the
   * right; declaring the numbers in the right hand's frame and reflecting the
   * left across x = 0 is what makes one pair of numbers describe a symmetric
   * pair of devices.
   */
  private poseShooter(hand: number): void {
    const entity = this.shooterEntities[hand];
    const object3D = entity?.object3D;
    if (!object3D) return;

    this.localOffset
      .set(
        handMirror(hand) * WEB.shooterOffsetX,
        WEB.shooterOffsetY,
        WEB.shooterOffsetZ,
      )
      .applyQuaternion(this.gripOrientation);
    this.targetPosition.copy(this.gripPosition).add(this.localOffset);

    setWorldPosition(object3D, this.targetPosition);
    setWorldQuaternion(object3D, this.gripOrientation);
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
   * **Aim is the grip's forward**, i.e. the way the arm points, and not the
   * mounted nozzle's own axis. The mount rotation is there to make the device
   * sit on the wrist correctly; letting it steer the shot as well would mean
   * every cosmetic tweak to how the cuff hangs also changed where shots go.
   * {@link WEB.muzzleLocal} moves the spawn point, nothing more.
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
   * The nozzle in world space, written into `out`.
   *
   * {@link WEB.muzzleLocal} is a point in the holder's own frame, and the
   * holder is grip-aligned, so this is one matrix multiply. It has to be the
   * holder's matrix rather than its world *position*: round 4 spawned webs at
   * the shooter's origin, which was fine while the model was a symmetric block
   * and wrong the moment a mount rotation moved the nozzle off-centre.
   */
  private muzzleWorld(hand: number, out: Vector3): boolean {
    const object3D = this.shooterEntities[hand]?.object3D;
    if (!object3D) return false;
    const mirror = handMirror(hand);
    out.set(
      mirror * WEB.muzzleLocal[0],
      WEB.muzzleLocal[1],
      WEB.muzzleLocal[2],
    );
    object3D.updateWorldMatrix(true, false);
    out.applyMatrix4(object3D.matrixWorld);
    return true;
  }

  /** Where the web is born: out of the nozzle, then clear of the hand. */
  private muzzleFor(hand: number): void {
    if (!this.muzzleWorld(hand, this.muzzle)) {
      this.muzzle.copy(this.gripPosition);
    }
    this.muzzle.addScaledVector(this.forward, WEB.muzzleOffset);
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
        this.lastYankMs[hand] = Number.NEGATIVE_INFINITY;
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

      this.reelHand(targets, hand, slot, nowMs);
    }
  }

  /**
   * The two ways to pull: yank the hand back, or hold the squeeze.
   *
   * Two rather than one because the two input modes want different things. A
   * controller player has a squeeze button under their middle finger and
   * expects holding it to do something continuous. A hand-tracking player has
   * no buttons at all, but does have a whole arm — and hauling is the gesture
   * everyone mimes anyway. Both are live at once; a player squeezing *and*
   * yanking simply reels faster, which is exactly what they were asking for.
   */
  private reelHand(
    targets: TargetSystem,
    hand: number,
    slot: number,
    nowMs: number,
  ): void {
    if (!this.handTracked[hand]) return;

    const base = hand * 3;
    this.reelTarget.set(
      this.handPos[base],
      this.handPos[base + 1],
      this.handPos[base + 2],
    );

    let reeled = 0;

    // (a) YANK. The hand's velocity projected onto robot -> hand, so pushing
    // toward the robot and waving across it both project to nothing.
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
      if (shouldYank(away, nowMs - this.lastYankMs[hand], WEB)) {
        this.lastYankMs[hand] = nowMs;
        reeled += WEB.yankReelMeters;
      }
    }

    // (b) HOLD. Frame-rate independent, so a 72 Hz headset and a 90 Hz one
    // reel at the same metres per second.
    const gamepad = this.input?.gamepads?.[hand === 1 ? 'right' : 'left'];
    if (gamepad?.getButtonPressed(InputComponent.Squeeze)) {
      reeled += WEB.reelSpeed * this.lastDelta;
    }

    if (reeled <= 0) return;

    targets.reelTether(slot, this.reelTarget, reeled);
    // data = hand in bit 8, the same layout every other hand-carrying event
    // uses, so FeedbackSystem can buzz the arm that is doing the work.
    this.events.emit(
      GameEvent.TetherReeled,
      this.tetherAnchor.x,
      this.tetherAnchor.y,
      this.tetherAnchor.z,
      packTetherData(slot, hand),
    );
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

    if (this.muzzleWorld(hand, this.strandMidpoint)) {
      // Nozzle found; nothing else to do.
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
   * Shooters, the selector gadget and strands exist exactly while web ammo is
   * loaded and firing is allowed. Both signals feed this, because either can
   * turn it off: swapping to a paint chip, or the round ending under you.
   *
   * The shooter **holders** keep tracking the wrist either way — round 6's
   * gestures fire paint from the same muzzle — so this only hides the models.
   * Hiding the holder is how that is done, since the pads and the model hang
   * off it and `updateWorldMatrix` works perfectly well on an invisible object.
   *
   * Unloading also drops every tether and every strand immediately rather than
   * letting them fade: a line hanging in mid-air off a wrist that no longer has
   * a shooter on it is a bug the player can see.
   *
   * Note the gesture *latches* are cold-started here but the gestures
   * themselves are not disabled — with paint loaded a thwip still fires paint.
   * What must not happen is a stale latch or a window's worth of hand travel
   * from before the swap throwing a shot the player did not ask for.
   */
  private applyArmedState(): void {
    const armed = this.armed();

    for (const entity of this.queries.shooters.entities) {
      if (entity.object3D) entity.object3D.visible = armed;
    }

    if (!armed) {
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
   * One shooter per wrist, hidden until web ammo is loaded.
   *
   * Two nested groups, and the nesting is load-bearing. The **outer** holder is
   * the entity, and {@link poseShooter} keeps it exactly grip-aligned, which is
   * what makes {@link WEB.muzzleLocal} a point in a frame a tuner can picture
   * (+Y out of the back of the hand, -Z toward the fingers). The **inner** group
   * carries the mount rotation and the model's own re-seating, so changing how
   * the cuff hangs never moves the frame the muzzle is measured in.
   */
  private buildShooters(): void {
    for (let hand = 0; hand < 2; hand++) {
      const holder = new Group();
      holder.name = hand === 0 ? 'WebShooterLeft' : 'WebShooterRight';
      holder.visible = false;

      const mount = new Group();
      mount.name = 'WebShooterMount';
      // Order 'ZXY' composes as R = Rz * Rx * Ry, i.e. yaw first (in the
      // model's own frame, where it aligns the band) and roll last (about the
      // grip's Z, i.e. the forearm), which is what makes roll the knob that
      // spins the mounted cuff without disturbing anything else.
      //
      // The left hand is the right hand mirrored across x = 0, and reflecting
      // a rotation through that plane negates the components about Y and Z and
      // leaves the one about X alone. Hence: yaw and roll flip, pitch does not.
      const mirror = handMirror(hand);
      mount.rotation.set(
        WEB.shooterPitchDeg * DEG_TO_RAD,
        mirror * WEB.shooterYawDeg * DEG_TO_RAD,
        mirror * WEB.shooterRollDeg * DEG_TO_RAD,
        'ZXY',
      );
      mount.add(this.buildShooterModel() ?? this.buildPrimitiveShooter());
      holder.add(mount);

      const entity = this.world
        .createTransformEntity(holder, {
          parent: this.world.sceneEntity,
          persistent: true,
        })
        .addComponent(WebShooter, { side: hand });
      this.shooterEntities[hand] = entity;

      // The sub-mode selector rides the LEFT wrist only. One gadget, not two:
      // it is a setting, and two of them would raise the question of what
      // happens when they disagree. Left because that is already the hand the
      // palette is strapped to, so "look at your left arm to change what you
      // are firing" stays one habit rather than two.
      if (hand === 0) this.buildModeSelector(entity);
    }
  }

  /**
   * The wrist gadget: two mini pads floating just off the left cuff, one per
   * {@link WebSubMode}.
   *
   * Parented **into the shooter holder**, so it inherits the grip pose for free
   * and hides with the shooter when paint is loaded — there is no sub-mode to
   * choose without webbing on. Sitting further out on the palm side than the
   * cuff itself (see {@link WEB.selectorOffsetY}) puts it where a supinated
   * forearm points it straight at the player's face, which is the whole reason
   * the mount was rolled over to the palm-up pose in the first place.
   *
   * Each pad wears the same three pointer tags as a palette chip —
   * RayInteractable, PokeInteractable, OneHandGrabbable — so a fingertip poke,
   * a hand pinch and a controller squeeze all arrive at the same `Pressed` tag
   * BallSpawnSystem selects off. Plus the proximity path, plus the B button.
   * Four routes to a two-way switch is not excessive for something worn on a
   * wrist and read at a glance mid-round.
   */
  private buildModeSelector(shooter: Entity): void {
    const size = WEB.selectorPadMeters;
    const step = size + WEB.selectorPadGap;

    for (let i = 0; i < 2; i++) {
      const mode = i === 0 ? WebSubMode.Splat : WebSubMode.Tether;
      const selected = mode === this.webSubMode.peek();
      const accent = new Color(
        mode === WebSubMode.Tether
          ? SELECTOR_TETHER_COLOR
          : SELECTOR_SPLAT_COLOR,
      );
      const material = new MeshStandardMaterial({
        color: accent,
        roughness: 0.35,
        metalness: 0,
        // Baked once, exactly like a palette chip's: BallSpawnSystem only ever
        // moves the intensity, so a pad always glows in its own colour.
        emissive: accent.clone(),
        emissiveIntensity: selected
          ? WEB.selectorSelectedEmissive
          : WEB.selectorIdleEmissive,
        transparent: true,
        opacity: 0.92,
      });

      const pad =
        mode === WebSubMode.Tether
          ? buildHookPad(size, material)
          : buildSplatPad(size, material, accent, selected);
      pad.name = mode === WebSubMode.Tether ? 'WebPadTether' : 'WebPadSplat';
      // Both pads face the grip's -Y, i.e. out through the palm side, which is
      // where the player's eyes are once the forearm is supinated.
      pad.rotation.x = Math.PI / 2;
      pad.position.set(
        (i - 0.5) * step,
        WEB.selectorOffsetY,
        WEB.selectorOffsetZ,
      );
      if (selected) pad.scale.setScalar(SELECTED_PAD_SCALE);

      const entity = this.world.createTransformEntity(pad, {
        parent: shooter,
        persistent: true,
      });
      entity.addComponent(Interactable);
      entity.addComponent(PokeInteractable);
      entity.addComponent(OneHandGrabbable, { rotate: false, translate: false });
      entity.addComponent(WebModePad, { mode });
    }
  }

  /**
   * The `webShooter` GLB, measured and rescaled — the measure-the-art trick
   * TargetSystem uses on the robot, so swapping the model never needs a code
   * change.
   *
   * Round 4 fitted the **longest** axis to WEB.shooterLengthMeters and the
   * field said the result was too small. {@link fitShooterScale} fits the
   * **band** instead, because a wrist is a fixed size and the band is the part
   * that has to go round it; length survives as a cap for art shaped nothing
   * like a cuff. Returns undefined when no such asset is registered, which
   * leaves the primitive block-and-nozzle in its place.
   */
  private buildShooterModel(): Object3D | undefined {
    let source: Object3D | undefined;
    try {
      source = AssetManager.getGLTF(WEB_SHOOTER_ASSET_KEY)?.scene;
    } catch {
      // AssetManager not initialised, or the key is absent.
      return undefined;
    }
    if (!source) return undefined;

    const model = source.clone(true);
    this.measureBox.setFromObject(model);
    this.measureBox.getSize(this.measureSize);
    this.measureBox.getCenter(this.measureCentre);

    const measured = createShooterFit();
    fitShooterScale(
      this.measureSize.x,
      this.measureSize.y,
      this.measureSize.z,
      WEB.shooterBandMeters,
      WEB.shooterLengthMeters,
      measured,
    );
    const fit = measured.scale;
    model.scale.setScalar(fit);
    // Re-seat the art so its centre is the mount's origin, whatever origin the
    // exporter happened to choose — the mount rotation then spins it about its
    // own middle rather than swinging it round on an arm.
    model.position.set(
      -this.measureCentre.x * fit,
      -this.measureCentre.y * fit,
      -this.measureCentre.z * fit,
    );

    const holder = new Group();
    holder.name = 'WebShooterModel';
    holder.add(model);
    return holder;
  }

  /**
   * The fallback shooter when the GLB is missing: a dark band with a coral
   * nozzle on its underside.
   *
   * **Authored in the same convention as the shipped GLB** — a band lying in
   * the YZ plane with its hole along X — precisely because the mount rotation
   * is applied to whatever sits in the mount group. A fallback authored
   * "already pointing -Z" would be swung sideways by the same yaw that puts the
   * real model right, which is the sort of divergence that only shows up on the
   * one device that failed to stream the asset.
   *
   * Deliberately small and dark. It has to sit on a real hand in passthrough
   * without swallowing it, and the one bright part is the end the webbing
   * comes out of, which is the only part the player needs to find.
   */
  private buildPrimitiveShooter(): Object3D {
    const group = new Group();
    group.name = 'WebShooterPrimitive';

    const bandRadius = WEB.shooterBandMeters / 2;
    const band = new Mesh(
      new TorusGeometry(bandRadius * 0.9, bandRadius * 0.12, 8, 20),
      new MeshStandardMaterial({
        color: new Color(SHOOTER_BODY_COLOR),
        roughness: 0.45,
        metalness: 0.3,
      }),
    );
    // Torus is authored in the XY plane with its hole along +Z; a quarter turn
    // about Y swings that hole onto +X, where the mount expects to find it.
    band.rotation.y = Math.PI / 2;
    group.add(band);

    const nozzleLength = bandRadius * 0.8;
    const nozzle = new Mesh(
      new CylinderGeometry(
        bandRadius * 0.14,
        bandRadius * 0.2,
        nozzleLength,
        10,
      ),
      new MeshStandardMaterial({
        color: new Color(SHOOTER_ACCENT_COLOR),
        roughness: 0.3,
        metalness: 0.1,
      }),
    );
    // Cylinders stand on +Y; a quarter turn about Z lies this one along -X,
    // i.e. out through the band's hole, which the mount then aims down the arm.
    nozzle.rotation.z = Math.PI / 2;
    // +Y in the model, which the shipped 180-degree roll (WEB.shooterRollDeg,
    // the palm-up fix) swings round to the grip's -Y — the palm side, where
    // WEB.muzzleLocal puts the spawn point. Authored to agree with the mount
    // rather than in isolation, because a visible nozzle on one side of the
    // cuff and strands leaving the other is precisely the sort of thing that
    // only shows up on the one device that failed to stream the GLB.
    nozzle.position.set(-nozzleLength * 0.7, bandRadius * 0.72, 0);
    group.add(nozzle);

    return group;
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
      mesh.name = `WebStrand_${slot}`;
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
  }
}

/**
 * The splat pad: a dark disc with the web mask glowing on its face.
 *
 * **Two meshes, and the backing one is not optional.** The first attempt was a
 * single disc wearing the mask as an `alphaMap`, which is how SplatterSystem
 * paints its decals — and in the emulator the pad simply was not there. A web
 * mask is mostly *black*: alpha-testing it away leaves a few pale threads
 * floating over a white controller, which is a perfectly good decal on a wall
 * and completely illegible as a 2.2 cm button on your own wrist.
 *
 * So the mask goes on a slightly smaller face over an opaque backing, which
 * gives the pad an outline, something for the thread to read against, and a
 * silhouette that survives being glanced at mid-round.
 *
 * The mask still binds as `alphaMap` and never as `map`, for the same reason it
 * does on a decal: the PNG is a white shape on black with no alpha channel, so
 * bound as `map` it would multiply the whole face toward black instead of
 * cutting a web out of it.
 *
 * A missing texture leaves the plain backing disc, which is still a perfectly
 * readable "the round one" next to a hook.
 */
function buildSplatPad(
  size: number,
  material: MeshStandardMaterial,
  accent: Color,
  selected: boolean,
): Object3D {
  const group = new Group();

  const backing = new Mesh(
    new CircleGeometry(size / 2, 20),
    new MeshStandardMaterial({
      color: new Color(SELECTOR_BACKING_COLOR),
      roughness: 0.5,
      metalness: 0,
      transparent: true,
      opacity: 0.88,
      // The backing carries the accent as its emissive too, so the selection
      // lift reaches the whole pad rather than a few threads of web. Without
      // it the *unselected* cyan hook out-glows the *selected* splat pad,
      // which is exactly backwards — a vivid colour beats a dark disc on raw
      // brightness whatever the emissive says.
      emissive: accent.clone(),
      emissiveIntensity: selected
        ? WEB.selectorSelectedEmissive
        : WEB.selectorIdleEmissive,
    }),
  );
  group.add(backing);

  const face = new Mesh(new CircleGeometry(size * 0.44, 20), material);
  // A hair in front of the backing. Both discs are coplanar otherwise, and
  // z-fighting on something held 30 cm from the player's eye is very visible.
  face.position.z = size * 0.02;
  try {
    const texture = AssetManager.getTexture(WEB_SPLAT_TEXTURE_KEY) as
      | Texture
      | undefined;
    if (texture) {
      material.alphaMap = texture;
      material.alphaTest = 0.35;
      material.needsUpdate = true;
      group.add(face);
    } else {
      // No mask to cut a web out of: fall back to a solid face, so the pad
      // still has its accent colour and still lights up when selected.
      group.add(face);
    }
  } catch {
    // AssetManager not initialised (unit tests) or key absent.
    group.add(face);
  }

  return group;
}

/**
 * The tether pad: a hook.
 *
 * Three quarters of a torus for the curve of the hook plus a straight shank
 * above it, which at 2.2 cm reads unmistakably as "the pointy one that grabs"
 * next to a disc. Both parts share the pad's material, so the selected glow
 * lights the whole silhouette at once rather than half of it.
 *
 * Authored in the XY plane like the torus it is built from, so the caller's one
 * quarter-turn about X lays the whole pad face-out with everything else.
 */
function buildHookPad(size: number, material: MeshStandardMaterial): Object3D {
  const group = new Group();
  const radius = size * 0.3;
  const tube = size * 0.075;

  const curve = new Mesh(
    new TorusGeometry(radius, tube, 6, 16, Math.PI * 1.45),
    material,
  );
  // Open the arc's mouth downward, so the hook looks like it could catch
  // something rather than like a broken ring.
  curve.rotation.z = Math.PI * 0.28;
  group.add(curve);

  const shank = new Mesh(
    new CylinderGeometry(tube, tube, size * 0.42, 6),
    material,
  );
  shank.position.set(0, radius + size * 0.16, 0);
  group.add(shank);

  return group;
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
