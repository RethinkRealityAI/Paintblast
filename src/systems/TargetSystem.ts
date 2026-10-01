import {
  AssetManager,
  Box3,
  DepthOccludable,
  Group,
  Raycaster,
  Vector3,
  XRMesh,
  XRPlane,
  createComponent,
  createSystem,
  Types,
} from '@iwsdk/core';
import type { Entity, Intersection, Object3D } from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import { BALLS, ROOM, TARGETS, WEB } from '../config';
import {
  AimTargets,
  BallStyle,
  GameEvent,
  GameEventBuffer,
  GamePhase,
  WebSubMode,
  packTetherData,
} from '../types';
import { Ball, BallFlightState } from './BallSpawnSystem';

/** AssetManifest key main.ts registers public/gltf/robot/robot.gltf under. */
export const ROBOT_ASSET_KEY = 'robot';

const DEG_TO_RAD = Math.PI / 180;

/** Lifecycle of one pool slot. Stored per slot in a plain Int8Array. */
export const TargetSlotState = {
  /** Hidden and idle — the round is not running, or the pool is oversized. */
  Empty: 0,
  /** Visible, bobbing, and hit-tested. */
  Active: 1,
  /** Shrinking away after its last hit. */
  Popping: 2,
  /** Hidden, waiting out TARGETS.respawnDelaySec. */
  Respawning: 3,
} as const;

export type TargetSlotState =
  typeof TargetSlotState[keyof typeof TargetSlotState];

/**
 * Marks a pooled robot. Carries no motion state — that lives in TargetSystem's
 * parallel arrays — but exposes hp and slot so `ecs_find_entities` /
 * `ecs_query_entity` can inspect a live round from the MCP tools.
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
});

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

/** The subset of TARGETS that ringSpawnPosition needs. @see ringSpawnPosition */
export interface RingSpawnConfig {
  readonly ringMinR: number;
  readonly ringMaxR: number;
  readonly heightMin: number;
  readonly heightMax: number;
  readonly spawnAngleJitter: number;
}

/**
 * Pick one robot spawn point on the ring around the player.
 *
 * Pure and allocation-free (the caller owns `outVec3`) so the distribution can
 * be unit-tested without a World. The three `rand*` arguments are independent
 * 0..1 draws — injected rather than pulled from Math.random() inside so a test
 * can sweep the corners of the distribution deterministically.
 *
 * `outVec3` receives x/z as an **offset from the player**, and y as an
 * absolute height above the floor (the reference space is `local-floor`).
 *
 * Angles are index-based so `count` concurrent robots surround the player
 * evenly, plus up to ±½ slice × spawnAngleJitter of wander so successive
 * rounds do not look stamped from the same template.
 */
export function ringSpawnPosition(
  index: number,
  count: number,
  rand0: number,
  rand1: number,
  rand2: number,
  cfg: RingSpawnConfig,
  outVec3: Float32Array,
): void {
  const slice = (Math.PI * 2) / Math.max(1, count);
  const angle = index * slice + (rand0 - 0.5) * slice * cfg.spawnAngleJitter;
  const radius = cfg.ringMinR + rand1 * (cfg.ringMaxR - cfg.ringMinR);

  outVec3[0] = Math.cos(angle) * radius;
  outVec3[1] = cfg.heightMin + rand2 * (cfg.heightMax - cfg.heightMin);
  outVec3[2] = Math.sin(angle) * radius;
}

/**
 * Fit a spawn distance to the real room.
 *
 * Field feedback: in a small room the 1.2–3.0 m spawn ring reaches straight
 * through the walls, and a robot on the far side is visible in passthrough but
 * can never be hit — the paintball stops at the wall. So each candidate is
 * probed against the detected geometry and pulled back in front of whatever
 * the ray found.
 *
 * Pure and exported so the arithmetic that decides "usable, or try another
 * angle" is unit-tested without a room, a raycaster or a World.
 *
 * @param candidateDist Distance from the head to the ring position, metres.
 * @param wallDist Distance to the nearest real surface along the same ray.
 *   Infinity (or anything non-positive) means "nothing in the way".
 * @param margin Metres to keep between the robot and that surface.
 * @param minDist Closest a robot may ever spawn to the player's head.
 * @returns The distance to spawn at, or -1 when this direction is too tight
 *   and the caller should resample.
 */
export function clampSpawnDistance(
  candidateDist: number,
  wallDist: number,
  margin: number,
  minDist: number,
): number {
  // Open direction (or a nonsense reading): the ring position stands.
  if (!Number.isFinite(wallDist) || wallDist <= 0) return candidateDist;
  // The candidate is already inside the room.
  if (wallDist >= candidateDist) return candidateDist;

  const pulled = wallDist - margin;
  return pulled >= minDist ? pulled : -1;
}

/**
 * The robots: a fixed pool of hovering targets that the player shoots.
 *
 * Pooled, never created or destroyed during play. `TARGETS.poolSize` entities
 * are built once (each a Group holding one clone of robot.gltf), then shown,
 * moved and hidden as the round demands. All per-slot state — hp, lifecycle,
 * hover parameters, timers — lives in parallel TypedArrays indexed by slot, so
 * a frame of robot logic allocates nothing. The one array of entity references
 * is the pool itself: fixed-length, built once, an object pool rather than the
 * manual entity tracking the ECS guidance warns about.
 *
 * Robots deliberately carry **no physics body**. Havok would push the balls
 * around and IWSDK raises no collision events anyway, so hits are a plain
 * sphere-overlap test against every free-flying ball (≤4 robots × ≤20 balls).
 *
 * Round handoff is via the `gamePhase` signal rather than the RoundStart
 * event: this system runs at priority 14 but GameStateSystem flips the phase at
 * priority 30, so an event would be flushed (priority 90) before this system
 * ever looked at the buffer. Subscribing makes the handoff order-independent.
 */
export class TargetSystem extends createSystem({
  balls: { required: [Ball] },
  // Real-world geometry, used only at spawn time to keep robots indoors.
  planes: { required: [XRPlane] },
  meshes: { required: [XRMesh] },
}) {
  private events!: GameEventBuffer;
  private gamePhase!: Signal<GamePhase>;
  private targetsAlive!: Signal<number>;
  /**
   * Bitmask of hands holding a line: bit 0 left, bit 1 right.
   *
   * Published as a signal rather than read back through `getSystem` because the
   * one consumer outside this file is BallSpawnSystem, which this module
   * imports — asking it back would close a cycle. It is also genuinely
   * cross-cutting state ("is this hand busy?"), which is what globals are for.
   */
  private tetheredHands!: Signal<number>;
  /**
   * Round 7: where the live robots are, published every frame of a round for
   * BallSpawnSystem's aim assist. Optional so a test world without the global
   * still runs.
   */
  private aimTargets?: AimTargets;

  /** The pool. Fixed length after ensurePool(); slots are reused forever. */
  private readonly slots: Entity[] = [];

  // Per-slot state, all indexed by slot, all allocated once in init().
  private slotState!: Int8Array;
  private slotHp!: Int16Array;
  private slotRadius!: Float32Array;
  private slotBaseY!: Float32Array;
  private slotBobPhase!: Float32Array;
  private slotYaw!: Float32Array;
  private respawnAt!: Float64Array;
  private popStartedAt!: Float64Array;
  private hitFlashUntil!: Float64Array;
  /**
   * Hand holding a tether on this slot: 0 left, 1 right, -1 free.
   *
   * A flag beside the lifecycle rather than a fifth {@link TargetSlotState},
   * deliberately. A tethered robot is still an Active robot in every way the
   * rest of this system cares about — it is visible, it is hit-testable, it
   * still counts as alive — and the only two behaviours that change are the
   * hover (its position is being driven from outside) and where it is allowed
   * to move to. A new state would have meant duplicating the Active branch of
   * four switch statements to keep those three facts true.
   */
  private slotTetherHand!: Int8Array;
  /** This frame's robot world positions, xyz per slot. */
  private slotWorldPos!: Float32Array;

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
  /** Scratch for {@link reelTether} — the robot's position while it is moved. */
  private tetherTarget!: Vector3;
  /**
   * Wall probe for spawn placement. A raw Raycaster rather than an
   * Interactable, deliberately: this fires a handful of rays when a robot
   * spawns, not every frame on the input path, and the targets are the
   * scene-understanding meshes, which are not (and should not be)
   * interactable.
   */
  private spawnRay!: Raycaster;
  private rayHits!: Intersection[];

  private roundActive = false;
  private aliveCount = 0;

  init() {
    this.events = this.globals.gameEvents as GameEventBuffer;
    this.gamePhase = this.globals.gamePhase as Signal<GamePhase>;
    this.targetsAlive = this.globals.targetsAlive as Signal<number>;
    this.tetheredHands = this.globals.tetheredHands as Signal<number>;
    this.aimTargets = this.globals.aimTargets as AimTargets | undefined;

    const size = TARGETS.poolSize;
    this.slotState = new Int8Array(size);
    this.slotHp = new Int16Array(size);
    this.slotRadius = new Float32Array(size);
    this.slotBaseY = new Float32Array(size);
    this.slotBobPhase = new Float32Array(size);
    this.slotYaw = new Float32Array(size);
    this.respawnAt = new Float64Array(size);
    this.popStartedAt = new Float64Array(size);
    this.hitFlashUntil = new Float64Array(size);
    this.slotTetherHand = new Int8Array(size).fill(-1);
    this.slotWorldPos = new Float32Array(size * 3);
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
    this.spawnRay = new Raycaster();
    this.spawnRay.near = 0.05;
    this.spawnRay.far = ROOM.spawnRayMaxDist;
    this.rayHits = [];

    // Best effort now (critical assets finish before World.create resolves);
    // retried on the first round start if the GLTF is somehow not ready.
    this.ensurePool();

    this.cleanupFuncs.push(
      this.gamePhase.subscribe((phase) => {
        if (phase === GamePhase.Playing) {
          this.beginRound();
        } else if (this.roundActive) {
          this.endRound();
        }
      }),
    );
  }

  update(delta: number) {
    if (!this.roundActive) return;

    const nowSec = performance.now() / 1000;
    const spawnCount = Math.min(TARGETS.maxConcurrent, this.slots.length);
    const bobOmega = TARGETS.bobHz * Math.PI * 2;
    const yawStep = TARGETS.turnDegPerSec * DEG_TO_RAD * delta;

    for (let slot = 0; slot < this.slots.length; slot++) {
      switch (this.slotState[slot]) {
        case TargetSlotState.Active:
          this.animateActive(slot, nowSec, bobOmega, yawStep);
          break;
        case TargetSlotState.Popping:
          this.animatePop(slot, nowSec);
          break;
        case TargetSlotState.Respawning:
          if (nowSec >= this.respawnAt[slot]) {
            this.activate(slot, spawnCount);
          }
          break;
        default:
          break;
      }
    }

    this.testBallOverlaps(nowSec);
    this.publishAimTargets();

    if (this.targetsAlive.peek() !== this.aliveCount) {
      this.targetsAlive.value = this.aliveCount;
    }
  }

  /**
   * Copy this frame's shootable robots into the shared {@link AimTargets}.
   *
   * Runs right after {@link testBallOverlaps}, which has just refreshed
   * `slotWorldPos` for every Active slot — so this is a copy, not a second
   * round of getWorldPosition calls. A popping or respawning robot is not a
   * target: assist must never bend a shot toward something that is vanishing.
   */
  private publishAimTargets(): void {
    const aim = this.aimTargets;
    if (!aim) return;
    const count = Math.min(aim.capacity, this.slots.length);
    for (let slot = 0; slot < count; slot++) {
      const live = this.slotState[slot] === TargetSlotState.Active;
      aim.active[slot] = live ? 1 : 0;
      if (!live) continue;
      const base = slot * 3;
      aim.positions[base] = this.slotWorldPos[base];
      aim.positions[base + 1] = this.slotWorldPos[base + 1];
      aim.positions[base + 2] = this.slotWorldPos[base + 2];
    }
  }

  /** Live robot count, for tests and MCP-driven smoke checks. */
  get debugAliveCount(): number {
    return this.aliveCount;
  }

  // ---- The tether API ------------------------------------------------------
  //
  // Round 6's headline feature is a web that latches onto a robot and reels it
  // in, and every fact about a latched robot lives here rather than in the
  // system that threw the web. That is not tidiness for its own sake: the robot
  // pool is created, moved, popped and recycled entirely inside this file, and
  // a tether is a *lease* on one of those slots. Handing a slot index to
  // another system and hoping it notices the round ending is exactly how you
  // get a strand hanging off a robot that no longer exists. So WebShooterSystem
  // asks {@link tetherSlotForHand} every frame and believes the answer.
  //
  // The one deviation from the brief's shape: beginTether takes the hand as
  // well as the slot. It has to, if this file is going to own the mapping — and
  // owning it here is what makes "the round ended" and "the robot was shot by
  // someone else" resolve themselves without a message ever being sent.

  /** Is this slot currently on the end of somebody's line? */
  isTethered(slot: number): boolean {
    return this.tetherHandOf(slot) >= 0;
  }

  /**
   * The slot this hand is reeling, or -1. The whole of WebShooterSystem's view
   * of the tether: it holds a slot index and nothing else, so there is no
   * entity reference anywhere to go stale.
   */
  tetherSlotForHand(hand: number): number {
    for (let slot = 0; slot < this.slotTetherHand.length; slot++) {
      if (this.slotTetherHand[slot] === hand) return slot;
    }
    return -1;
  }

  /**
   * Latch a hand onto an active robot: its hover and its yaw stop, it stays
   * visible and stays shootable, and it will not respawn out from under the
   * line because it never popped.
   *
   * @returns false when the slot is not a live target, or is already on
   *   somebody's line, or that hand already has one — all three of which are
   *   "the shot missed", not an error.
   */
  beginTether(slot: number, hand: number): boolean {
    if (hand !== 0 && hand !== 1) return false;
    if (slot < 0 || slot >= this.slots.length) return false;
    if (this.slotState[slot] !== TargetSlotState.Active) return false;
    if (this.slotTetherHand[slot] >= 0) return false;
    if (this.tetherSlotForHand(hand) >= 0) return false;

    this.slotTetherHand[slot] = hand;
    this.slots[slot]?.setValue(Target, 'tetheredBy', hand);
    this.publishTetheredHands();
    return true;
  }

  /**
   * Haul a tethered robot `metres` closer to `towardWorldPos`, clamped by
   * {@link reelDistance}.
   *
   * Writes the object3D's local position directly, which is its world position:
   * robots are parented to `world.sceneEntity`, the identity root that
   * {@link activate} already assumes when it plants them at head-relative
   * coordinates.
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
    // Keep the hover's anchor with it, so a tether that breaks without a pop
    // leaves the robot bobbing about where it was left rather than snapping
    // back to wherever it originally spawned.
    this.slotBaseY[slot] = object3D.position.y;
  }

  /**
   * Where the far end of the strand should be drawn: the robot's current
   * position. @returns false when there is nothing on the line.
   */
  tetherAnchorInto(slot: number, out: Vector3): boolean {
    if (!this.isTethered(slot)) return false;
    const object3D = this.slots[slot]?.object3D;
    if (!object3D) return false;
    object3D.getWorldPosition(out);
    return true;
  }

  /**
   * Let go. `pop` routes the ending: true runs the ordinary kill — the shrink
   * animation, the respawn timer, the TargetPopped event that scoring and the
   * combo already listen for — so a robot dragged into your face is worth
   * exactly what a robot shot across the room is worth, through one code path.
   * False simply hands the robot back its hover.
   */
  endTether(slot: number, pop: boolean): void {
    if (!this.isTethered(slot)) return;
    const hand = this.slotTetherHand[slot];
    this.clearTether(slot);

    if (!pop) return;

    const base = slot * 3;
    const object3D = this.slots[slot]?.object3D;
    if (object3D) {
      object3D.getWorldPosition(this.worldScratch);
      this.slotWorldPos[base] = this.worldScratch.x;
      this.slotWorldPos[base + 1] = this.worldScratch.y;
      this.slotWorldPos[base + 2] = this.worldScratch.z;
    }
    this.popSlot(slot, base, performance.now() / 1000);
    // Rides alongside TargetPopped rather than replacing it: that event carries
    // the score and the pop cue, and this one exists only so the rumble can be
    // the harder one a hand-hauled kill has earned.
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

  /**
   * Build the entity pool from the preloaded robot GLTF. Idempotent, and
   * returns false when the asset is not available yet so callers can retry.
   */
  private ensurePool(): boolean {
    if (this.slots.length > 0) return true;

    let source: Object3D | undefined;
    try {
      source = AssetManager.getGLTF(ROBOT_ASSET_KEY)?.scene;
    } catch {
      // AssetManager not initialised (unit tests) — no robots, no crash.
      return false;
    }
    if (!source) return false;

    // Measure the art rather than trusting its units. robot.gltf's geometry is
    // authored at roughly 53 × 68 × 35 centimetre-ish units and its root node
    // carries a 0.01 scale, which happens to land near 0.68 m tall — but that
    // is a property of this export, not a guarantee. Box3 tells the truth for
    // whatever model is dropped in here next.
    const first = source.clone(true);
    this.measureBox.setFromObject(first);
    this.measureBox.getSize(this.measureSize);
    this.measureBox.getCenter(this.measureCenter);

    const fit = TARGETS.heightMeters / (this.measureSize.y || 1);
    const radius = Math.max(
      TARGETS.hitRadiusMin,
      0.5 *
        fit *
        Math.max(
          this.measureSize.x,
          this.measureSize.y,
          this.measureSize.z,
        ),
    );
    // The raw model sits well off its own origin; re-centring it inside the
    // holder puts the entity pivot at the robot's middle, which is what both
    // the hover and the overlap test assume.
    const offsetX = -this.measureCenter.x * fit;
    const offsetY = -this.measureCenter.y * fit;
    const offsetZ = -this.measureCenter.z * fit;

    for (let slot = 0; slot < TARGETS.poolSize; slot++) {
      const model = slot === 0 ? first : source.clone(true);
      model.scale.setScalar(fit);
      model.position.set(offsetX, offsetY, offsetZ);

      const holder = new Group();
      holder.name = `Robot_${slot}`;
      holder.visible = false;
      holder.add(model);

      const entity = this.world.createTransformEntity(holder, {
        parent: this.world.sceneEntity,
        persistent: true,
      });
      entity.addComponent(Target, { hp: TARGETS.baseHp, slot });
      // Depth sensing hides a robot standing behind real furniture instead of
      // letting it float in front of the couch it is actually behind. Silently
      // no-ops on devices without depth support.
      entity.addComponent(DepthOccludable);

      this.slots.push(entity);
      this.slotRadius[slot] = radius;
      this.slotState[slot] = TargetSlotState.Empty;
    }

    return true;
  }

  /** Wake the pool for a fresh round. */
  private beginRound(): void {
    if (!this.ensurePool()) return;

    for (let slot = 0; slot < this.slots.length; slot++) {
      this.deactivate(slot);
    }
    this.aliveCount = 0;
    this.roundActive = true;

    const spawnCount = Math.min(TARGETS.maxConcurrent, this.slots.length);
    for (let slot = 0; slot < spawnCount; slot++) {
      this.activate(slot, spawnCount);
    }
    this.targetsAlive.value = this.aliveCount;
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

  /** Place a slot at a fresh ring position and make it shootable. */
  private activate(slot: number, count: number): void {
    const entity = this.slots[slot];
    const object3D = entity.object3D;
    if (!object3D) return;

    this.player.head.getWorldPosition(this.headScratch);
    const distance = this.pickRoomAwareSpawn(slot, count);

    object3D.position.set(
      this.headScratch.x + this.spawnDirection.x * distance,
      this.headScratch.y + this.spawnDirection.y * distance,
      this.headScratch.z + this.spawnDirection.z * distance,
    );
    object3D.scale.setScalar(1);
    object3D.visible = true;

    this.slotBaseY[slot] = object3D.position.y;
    // Phase-offset the hover so a ring of robots does not pulse in unison.
    this.slotBobPhase[slot] = (slot / Math.max(1, count)) * Math.PI * 2;
    this.slotYaw[slot] = Math.random() * Math.PI * 2;
    this.slotHp[slot] = TARGETS.baseHp;
    this.slotState[slot] = TargetSlotState.Active;
    this.respawnAt[slot] = 0;
    this.popStartedAt[slot] = 0;
    this.hitFlashUntil[slot] = 0;
    entity.setValue(Target, 'hp', TARGETS.baseHp);
    this.aliveCount++;
  }

  /**
   * Choose a spawn direction and distance that actually lands inside the room.
   *
   * Samples up to `ROOM.spawnAttempts` ring positions. Each is probed against
   * the detected planes and meshes; {@link clampSpawnDistance} then either
   * accepts the ring distance, pulls it in front of the wall, or rejects the
   * direction as too tight. Every sample redraws the radius and height as well
   * as the angle, and the radius is the lever that usually saves a cramped
   * direction: a nearer draw simply fits where the far one did not.
   *
   * Samples stay inside the slot's own angular band so the ring keeps its even
   * spread and two robots never stack. If every sample is rejected — a
   * genuinely tiny room — the roomiest direction seen wins and the robot stands
   * at `ROOM.spawnMinDist`, which is at least somewhere the player can turn and
   * hit.
   *
   * Leaves the chosen unit direction in `this.spawnDirection` and returns the
   * distance along it, measured from the head.
   */
  private pickRoomAwareSpawn(slot: number, count: number): number {
    const attempts = Math.max(1, ROOM.spawnAttempts);
    let bestWall = -1;
    this.bestDirection.set(0, 0, -1);

    for (let attempt = 0; attempt < attempts; attempt++) {
      ringSpawnPosition(
        slot,
        count,
        Math.random(),
        Math.random(),
        Math.random(),
        TARGETS,
        this.spawnOffset,
      );

      // ringSpawnPosition returns x/z relative to the player and y absolute,
      // so the vertical leg of the direction is measured off the head.
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

      // Rejected: remember it in case every direction is this cramped.
      if (wall > bestWall) {
        bestWall = wall;
        this.bestDirection.copy(this.spawnDirection);
      }
    }

    this.spawnDirection.copy(this.bestDirection);
    return ROOM.spawnMinDist;
  }

  /**
   * Distance from the player's head to the nearest real surface along `dir`,
   * or Infinity when the room does not get in the way inside
   * `ROOM.spawnRayMaxDist`. Returns Infinity before the room is scanned, which
   * makes the whole clamp a no-op rather than a hazard.
   */
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

  /** Nearest intersection of the current spawn ray with one object. */
  private hitDistance(object3D: Object3D | undefined): number {
    if (!object3D) return Number.POSITIVE_INFINITY;
    // Plane and mesh transforms are refreshed by SceneUnderstandingSystem each
    // frame but their world matrices are only flushed at render time.
    object3D.updateWorldMatrix(true, false);
    this.rayHits.length = 0;
    this.spawnRay.intersectObject(object3D, false, this.rayHits);
    return this.rayHits.length > 0
      ? this.rayHits[0].distance
      : Number.POSITIVE_INFINITY;
  }

  /** Hide a slot and clear its timers, without destroying anything. */
  private deactivate(slot: number): void {
    // Any lease on this slot dies with it — the round ending, or the pool being
    // reset for a fresh one, is the "deactivates for any other reason" case the
    // tether has to survive. WebShooterSystem sees the slot go free on its very
    // next poll and fades its strand out.
    this.clearTether(slot);
    // Off the aim-assist list at once: update() stops publishing when the
    // round ends, so nothing else would ever clear it.
    if (this.aimTargets && slot < this.aimTargets.capacity) {
      this.aimTargets.active[slot] = 0;
    }
    const object3D = this.slots[slot]?.object3D;
    if (object3D) {
      object3D.visible = false;
      object3D.scale.setScalar(1);
      object3D.rotation.z = 0;
    }
    this.slotState[slot] = TargetSlotState.Empty;
    this.slotHp[slot] = 0;
    this.respawnAt[slot] = 0;
    this.popStartedAt[slot] = 0;
    this.hitFlashUntil[slot] = 0;
  }

  /** Hover, spin, and the tail of a hit flash. */
  private animateActive(
    slot: number,
    nowSec: number,
    bobOmega: number,
    yawStep: number,
  ): void {
    const object3D = this.slots[slot].object3D;
    if (!object3D) return;

    // A robot on the end of a line is being dragged, not hovering. Leaving the
    // bob running would fight the reel for the Y axis, and leaving the yaw
    // running would spin a thing the player is actively hauling toward
    // themselves. The hit flash below still plays: a tethered robot is still
    // shootable, and a shot that lands on one should still read.
    if (!this.isTethered(slot)) {
      object3D.position.y =
        this.slotBaseY[slot] +
        Math.sin(nowSec * bobOmega + this.slotBobPhase[slot]) *
          TARGETS.bobAmplitude;

      // Constant yaw drift rather than tracking the player: the robot art has
      // no dependable "front", so a slow spin reads as alive without ever
      // showing the player its back. Swap in an atan2 toward this.player.head
      // if the art is ever re-authored facing -Z.
      this.slotYaw[slot] += yawStep;
      object3D.rotation.y = this.slotYaw[slot];
      object3D.rotation.z = 0;
    } else {
      // Round 7: a hooked robot struggles. A fast side-to-side rock about its
      // own Z is the cheapest possible "it's caught and it doesn't like it" —
      // no animation clips, no allocation, and it stops the instant the line
      // lets go (the branch above zeroes it).
      object3D.rotation.z =
        Math.sin(nowSec * WEB.tetherStruggleHz * Math.PI * 2) *
        WEB.tetherStruggleRad;
    }

    const flashLeft = this.hitFlashUntil[slot] - nowSec;
    const punch =
      flashLeft > 0
        ? 1 + (TARGETS.hitFlashScale - 1) * (flashLeft / TARGETS.hitFlashSec)
        : 1;
    object3D.scale.setScalar(punch);
  }

  /** Shrink to nothing, then hand the slot over to the respawn timer. */
  private animatePop(slot: number, nowSec: number): void {
    const object3D = this.slots[slot].object3D;
    const progress =
      (nowSec - this.popStartedAt[slot]) / TARGETS.popDurationSec;

    if (progress >= 1) {
      if (object3D) {
        object3D.visible = false;
        object3D.scale.setScalar(1);
      }
      this.slotState[slot] = TargetSlotState.Respawning;
      this.respawnAt[slot] = nowSec + TARGETS.respawnDelaySec;
      return;
    }

    object3D?.scale.setScalar(Math.max(0, 1 - progress));
  }

  /**
   * Sphere-overlap every free-flying ball against every active robot.
   *
   * Robot world positions are cached once per frame so the inner loop is pure
   * arithmetic over TypedArrays; only the balls pay for a getWorldPosition.
   */
  private testBallOverlaps(nowSec: number): void {
    let activeSlots = 0;
    for (let slot = 0; slot < this.slots.length; slot++) {
      if (this.slotState[slot] !== TargetSlotState.Active) continue;
      const object3D = this.slots[slot].object3D;
      if (!object3D) continue;
      object3D.getWorldPosition(this.worldScratch);
      const base = slot * 3;
      this.slotWorldPos[base] = this.worldScratch.x;
      this.slotWorldPos[base + 1] = this.worldScratch.y;
      this.slotWorldPos[base + 2] = this.worldScratch.z;
      activeSlots++;
    }
    if (activeSlots === 0) return;

    for (const ball of this.queries.balls.entities) {
      // Resting and Stuck balls are lying on the room, not travelling.
      if (ball.getValue(Ball, 'flightState') !== BallFlightState.Flying) {
        continue;
      }
      const object3D = ball.object3D;
      if (!object3D) continue;

      object3D.getWorldPosition(this.ballScratch);
      const ballRadius = ball.getValue(Ball, 'radius') ?? BALLS.radius;
      // Round 7: a tether web that *could* latch reaches further than paint —
      // a line that brushes a robot should catch it. Only when the latch can
      // actually take (the hand is free; the slot check is per slot below),
      // or a tether that cannot latch would score paint hits at the wider
      // radius.
      const latchHand = this.latchHandFor(ball);

      for (let slot = 0; slot < this.slots.length; slot++) {
        if (this.slotState[slot] !== TargetSlotState.Active) continue;

        const base = slot * 3;
        const dx = this.ballScratch.x - this.slotWorldPos[base];
        const dy = this.ballScratch.y - this.slotWorldPos[base + 1];
        const dz = this.ballScratch.z - this.slotWorldPos[base + 2];
        const reach =
          this.slotRadius[slot] +
          ballRadius +
          (latchHand >= 0 && this.slotTetherHand[slot] < 0
            ? WEB.tetherLatchBonus
            : 0);
        if (dx * dx + dy * dy + dz * dz > reach * reach) continue;

        // A tether web latches instead of hitting. Detected here rather than
        // anywhere else because this loop is already the only place in the game
        // that knows a ball and a robot are touching — and because a tether
        // that failed to take (the slot is already on a line) has to fall
        // straight through to the ordinary damage path rather than vanishing.
        if (!this.tryTether(ball, slot, base)) {
          this.registerHit(slot, base, nowSec);
        }
        // destroy(), never dispose(): geometry and materials are shared with
        // every other ball (see BallSpawnSystem).
        ball.destroy();
        // One ball can only be spent on one robot.
        break;
      }
    }
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

  /**
   * Latch this robot if the ball that reached it was a tether web.
   *
   * @returns true when the line took, which is the caller's cue to consume the
   *   ball *without* damaging the robot.
   */
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

  /** Apply damage to a slot and emit the matching events. */
  private registerHit(slot: number, base: number, nowSec: number): void {
    const x = this.slotWorldPos[base];
    const y = this.slotWorldPos[base + 1];
    const z = this.slotWorldPos[base + 2];

    const hp = this.slotHp[slot] - 1;
    this.slotHp[slot] = hp;
    this.slots[slot].setValue(Target, 'hp', hp);
    this.hitFlashUntil[slot] = nowSec + TARGETS.hitFlashSec;

    // data = hit points the robot has left (0 on the killing blow).
    this.events.emit(GameEvent.TargetHit, x, y, z, hp);
    if (hp > 0) return;

    this.popSlot(slot, base, nowSec);
  }

  /**
   * Start the pop animation and announce it. The single exit a live robot has,
   * whether it was shot or reeled in — which is what makes a tether kill score,
   * combo and sound exactly like any other kill without a second scoring path
   * to keep in step.
   *
   * Drops any tether first: a robot that is popping is no longer something a
   * line can be attached to, and leaving the lease would strand a strand.
   */
  private popSlot(slot: number, base: number, nowSec: number): void {
    this.clearTether(slot);
    this.slotState[slot] = TargetSlotState.Popping;
    this.popStartedAt[slot] = nowSec;
    this.aliveCount = Math.max(0, this.aliveCount - 1);
    // data = pool slot index, so a consumer can tell two simultaneous pops
    // apart without comparing float positions.
    this.events.emit(
      GameEvent.TargetPopped,
      this.slotWorldPos[base],
      this.slotWorldPos[base + 1],
      this.slotWorldPos[base + 2],
      slot,
    );
  }
}
