import {
  createSystem,
  Pressed,
  PhysicsBody,
  PhysicsShape,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';

import { BALLS, BALL_KIND_CONFIG, IMPACT, SPLAT, WEB } from '../config';
import {
  BallKind,
  BallStyle,
  GameEvent,
  GameEventBuffer,
  packImpactData,
} from '../types';
import { Ball, BallFlightState } from './BallSpawnSystem';
import { SplatterSystem } from './SplatterSystem';

type MutableVec3 = [number, number, number];

/**
 * Size multiplier on the splat a ball leaves when it dissolves at rest,
 * relative to what the same ball would paint on a proper hit. Under 1 because
 * a ball that dribbled to a halt did not arrive with any force.
 */
export const REST_SPLAT_MULT = 0.85;

/**
 * Decide whether a ball hit something this frame, purely from its velocity
 * samples. Exported (and free of any IWSDK dependency) so the thresholds can
 * be unit-tested without a physics engine.
 *
 * IWSDK's PhysicsSystem raises no collision events — it only writes Havok's
 * per-frame velocity back onto PhysicsBody. But an impulse from a static
 * surface is, by definition, directed along that surface's normal, so
 * `normalize(v - vPrev)` recovers the contact normal pointing away from the
 * surface. The armSpeed gate stops a barely-moving ball from registering hits
 * off numerical noise or a physics nudge.
 *
 * @param outNormal Receives the unit contact normal. Untouched when false.
 * @returns true if this velocity change should be treated as an impact.
 */
export function detectImpact(
  prevX: number,
  prevY: number,
  prevZ: number,
  curX: number,
  curY: number,
  curZ: number,
  armSpeed: number,
  deltaV: number,
  outNormal: Float32Array,
): boolean {
  const prevSpeedSq = prevX * prevX + prevY * prevY + prevZ * prevZ;
  if (prevSpeedSq <= armSpeed * armSpeed) {
    return false;
  }

  const dx = curX - prevX;
  const dy = curY - prevY;
  const dz = curZ - prevZ;
  const deltaSq = dx * dx + dy * dy + dz * dz;
  if (deltaSq <= deltaV * deltaV) {
    return false;
  }

  const inv = 1 / Math.sqrt(deltaSq);
  outNormal[0] = dx * inv;
  outNormal[1] = dy * inv;
  outNormal[2] = dz * inv;
  return true;
}

/**
 * Build an orthonormal basis (t, b) spanning the plane perpendicular to a unit
 * normal, so Splash balls can lay satellite splats flat against the surface
 * they hit. Exported for unit tests.
 *
 * The reference axis is swapped when the normal is close to vertical: crossing
 * against a nearly-parallel axis collapses to a zero-length vector.
 */
export function tangentBasis(
  nx: number,
  ny: number,
  nz: number,
  outT: Float32Array,
  outB: Float32Array,
): void {
  // Reference axis deliberately unlike the normal.
  const upRef = Math.abs(ny) > 0.9;
  const rx = upRef ? 1 : 0;
  const ry = upRef ? 0 : 1;
  const rz = 0;

  // t = normalize(r × n)
  let tx = ry * nz - rz * ny;
  let ty = rz * nx - rx * nz;
  let tz = rx * ny - ry * nx;
  const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
  tx /= tLen;
  ty /= tLen;
  tz /= tLen;

  outT[0] = tx;
  outT[1] = ty;
  outT[2] = tz;

  // b = n × t (unit as long as n is unit and t ⊥ n)
  outB[0] = ny * tz - nz * ty;
  outB[1] = nz * tx - nx * tz;
  outB[2] = nx * ty - ny * tx;
}

/**
 * Everything that happens to a ball after it leaves the muzzle: impact
 * detection, per-kind paint behaviour, settling, and the two cull rules.
 *
 * Runs at priority 12 — after BallSpawnSystem has created this frame's balls
 * and after IWSDK's PhysicsSystem (priority -2) has refreshed
 * PhysicsBody._linearVelocity from Havok.
 *
 * Zero allocations in update(): every vector is a preallocated Float32Array or
 * a reused tuple, and the velocity samples are read through TypedArray views.
 */
export class BallFlightSystem extends createSystem({
  // Free-flying balls: impact-tested and rest-tracked.
  flying: { required: [Ball, PhysicsBody], excluded: [Pressed] },
  // Grabbed balls: PhysicsSystem drives these kinematically, so their velocity
  // deltas are meaningless. Only keep prevVelocity fresh so releasing one does
  // not immediately read as an impact.
  held: { required: [Ball, PhysicsBody, Pressed] },
  // Every ball, including Stuck ones whose physics components were stripped.
  all: { required: [Ball] },
}) {
  private events!: GameEventBuffer;
  private splatter?: SplatterSystem;

  // Scratch buffers reused by every impact.
  private contactNormal!: Float32Array;
  private tangent!: Float32Array;
  private bitangent!: Float32Array;
  private splatPosition!: MutableVec3;
  private splatNormal!: MutableVec3;
  private splatColor!: MutableVec3;
  private worldPosition!: Vector3;

  init() {
    this.events = this.globals.gameEvents as GameEventBuffer;

    this.contactNormal = new Float32Array(3);
    this.tangent = new Float32Array(3);
    this.bitangent = new Float32Array(3);
    this.splatPosition = [0, 0, 0];
    this.splatNormal = [0, 0, 0];
    this.splatColor = [0, 0, 0];
    this.worldPosition = new Vector3();
  }

  update() {
    const nowSec = performance.now() / 1000;

    for (const ball of this.queries.held.entities) {
      this.syncPrevVelocity(ball);
    }

    for (const ball of this.queries.flying.entities) {
      this.stepFlyingBall(ball, nowSec);
    }

    for (const ball of this.queries.all.entities) {
      this.cullBall(ball, nowSec);
    }
  }

  /** Copy this frame's Havok velocity into prevVelocity for the next frame. */
  private syncPrevVelocity(ball: Entity): void {
    const velocity = ball.getVectorView(
      PhysicsBody,
      '_linearVelocity',
    ) as Float32Array;
    const prev = ball.getVectorView(Ball, 'prevVelocity') as Float32Array;
    prev[0] = velocity[0];
    prev[1] = velocity[1];
    prev[2] = velocity[2];
  }

  private stepFlyingBall(ball: Entity, nowSec: number): void {
    const velocity = ball.getVectorView(
      PhysicsBody,
      '_linearVelocity',
    ) as Float32Array;
    const prev = ball.getVectorView(Ball, 'prevVelocity') as Float32Array;
    const state = ball.getValue(Ball, 'flightState');

    if (state === BallFlightState.Flying) {
      const hit = detectImpact(
        prev[0],
        prev[1],
        prev[2],
        velocity[0],
        velocity[1],
        velocity[2],
        IMPACT.armSpeed,
        IMPACT.impactDeltaV,
        this.contactNormal,
      );

      if (hit) {
        this.handleImpact(ball, nowSec);
        // handleImpact may have destroyed the ball or stripped its
        // PhysicsBody — both make the views above invalid.
        if (!ball.active || !ball.hasComponent(PhysicsBody)) return;
      } else {
        this.trackRest(ball, velocity);
        // Settling now dissolves the ball into paint, so the views above can
        // be pointing at a freed component slot — same hazard as handleImpact.
        if (!ball.active) return;
      }
    }

    prev[0] = velocity[0];
    prev[1] = velocity[1];
    prev[2] = velocity[2];
  }

  /**
   * Count the consecutive near-stationary frames that mean a ball has settled,
   * and dissolve it into paint the moment it has.
   *
   * Rounds 1-2 promoted the ball to Resting and left it there for the rest of
   * its 15-second lifetime. Field feedback: "paint bubbles stick on the canvas
   * and the ground without splattering" — a lobbed ball that lands softly never
   * crosses the impact thresholds, so it just sat on the floor as a bead. Round
   * 3 softened those thresholds AND made settling itself a paint event: a
   * settled ball paints one splat where it lies and is gone. Between the two,
   * no ball anywhere can end its life as an inert bubble.
   *
   * Sticky is unaffected — Stuck is a different state, reached through
   * handleImpact, and a welded sticky ball is supposed to sit there.
   */
  private trackRest(ball: Entity, velocity: Float32Array): void {
    const speedSq =
      velocity[0] * velocity[0] +
      velocity[1] * velocity[1] +
      velocity[2] * velocity[2];
    const frames = ball.getValue(Ball, 'restFrames') ?? 0;

    if (speedSq < IMPACT.restSpeed * IMPACT.restSpeed) {
      if (frames + 1 >= IMPACT.restFrames) {
        ball.setValue(Ball, 'flightState', BallFlightState.Resting);
        ball.setValue(Ball, 'restFrames', 0);
        this.dissolveRestingBall(ball);
      } else {
        ball.setValue(Ball, 'restFrames', frames + 1);
      }
    } else if (frames !== 0) {
      ball.setValue(Ball, 'restFrames', 0);
    }
  }

  /**
   * Turn a settled ball into a splat and destroy it.
   *
   * The contact normal is forced to +Y: whatever the ball rolled to a stop
   * against, gravity is what held it there, so a decal lying flat is right far
   * more often than any normal recoverable from a velocity delta of nearly
   * zero. Size is scaled down a little because a ball that dribbled to a halt
   * did not hit hard.
   *
   * BallImpact is emitted alongside the splat exactly as a real contact would,
   * so scoring, feedback and the easel treat a dissolve like any other landing
   * — dribbling paint onto the canvas still paints the picture.
   */
  private dissolveRestingBall(ball: Entity): void {
    const object3D = ball.object3D;
    if (!object3D) {
      ball.destroy();
      return;
    }

    object3D.getWorldPosition(this.worldPosition);
    const x = this.worldPosition.x;
    const y = this.worldPosition.y;
    const z = this.worldPosition.z;

    const kind = (ball.getValue(Ball, 'kind') ?? BallKind.Normal) as BallKind;
    const kindConfig =
      BALL_KIND_CONFIG[kind] ?? BALL_KIND_CONFIG[BallKind.Normal];
    const color = ball.getVectorView(Ball, 'color') as Float32Array;
    const style = (ball.getValue(Ball, 'style') ??
      BallStyle.Paint) as BallStyle;

    this.events.emit(
      GameEvent.BallImpact,
      x,
      y,
      z,
      packImpactData(kind, color[0], color[1], color[2], style),
    );

    this.contactNormal[0] = 0;
    this.contactNormal[1] = 1;
    this.contactNormal[2] = 0;

    // Webbing that dribbles to a halt still webs the floor — same routing as a
    // proper web impact, just the smaller rest-sized decal.
    if (style === BallStyle.Web) {
      this.paintWebSplat(x, y, z, WEB.splatSizeMult * REST_SPLAT_MULT);
    } else {
      this.paintSplat(
        x,
        y,
        z,
        color,
        kindConfig.splatSizeMult * REST_SPLAT_MULT,
        kind,
      );
    }

    ball.destroy();
  }

  /** Paint and dispatch the per-kind outcome of a confirmed contact. */
  private handleImpact(ball: Entity, nowSec: number): void {
    const object3D = ball.object3D;
    if (!object3D) return;

    // Splats are addressed in world space; balls hang off the level root.
    object3D.getWorldPosition(this.worldPosition);
    const x = this.worldPosition.x;
    const y = this.worldPosition.y;
    const z = this.worldPosition.z;

    const kind = (ball.getValue(Ball, 'kind') ?? BallKind.Normal) as BallKind;
    const kindConfig =
      BALL_KIND_CONFIG[kind] ?? BALL_KIND_CONFIG[BallKind.Normal];
    const color = ball.getVectorView(Ball, 'color') as Float32Array;
    const style = (ball.getValue(Ball, 'style') ??
      BallStyle.Paint) as BallStyle;

    // data carries the kind in bits 0..6, the paint style in bit 7 and this
    // ball's colour in the upper 24 bits. EaselSystem needs the colour and the
    // style to pick a stamp, FeedbackSystem needs the style to pick a sound,
    // and scoring reads none of it — one BallImpact is one BallImpact whether
    // it was paint or webbing, which is what makes web splats score identically
    // without a second scoring path to keep in step.
    this.events.emit(
      GameEvent.BallImpact,
      x,
      y,
      z,
      packImpactData(kind, color[0], color[1], color[2], style),
    );

    // Webbing short-circuits the whole per-kind table: one white splat from the
    // web pool and it is gone. Bouncing, welding and bursting are paint-ball
    // behaviours, and a web that ricocheted round the room would be a different
    // (and much sillier) toy than the one being asked for.
    if (style === BallStyle.Web) {
      this.paintWebSplat(x, y, z, WEB.splatSizeMult);
      ball.destroy();
      return;
    }

    switch (kind) {
      case BallKind.Bouncy: {
        this.paintSplat(x, y, z, color, kindConfig.splatSizeMult, kind);
        const bounces = (ball.getValue(Ball, 'bounceCount') ?? 0) + 1;
        ball.setValue(Ball, 'bounceCount', bounces);
        if (bounces > kindConfig.maxBounces) {
          ball.destroy();
        }
        break;
      }

      case BallKind.Sticky: {
        this.paintSplat(x, y, z, color, kindConfig.splatSizeMult, kind);
        // PhysicsBody.state cannot be switched to Static after the Havok body
        // exists (motion type is fixed at creation), so strip the physics
        // components instead — shape first, matching PhysicsSystem's cleanup
        // order. The mesh then freezes exactly where it landed.
        if (ball.hasComponent(PhysicsShape)) ball.removeComponent(PhysicsShape);
        if (ball.hasComponent(PhysicsBody)) ball.removeComponent(PhysicsBody);
        ball.setValue(Ball, 'flightState', BallFlightState.Stuck);
        ball.setValue(Ball, 'landedAt', nowSec);
        this.events.emit(GameEvent.BallStuck, x, y, z, kind);
        break;
      }

      case BallKind.Splash: {
        this.paintSplat(x, y, z, color, kindConfig.splatSizeMult, kind);
        tangentBasis(
          this.contactNormal[0],
          this.contactNormal[1],
          this.contactNormal[2],
          this.tangent,
          this.bitangent,
        );
        for (let i = 0; i < SPLAT.splashCount; i++) {
          const angle = (i / SPLAT.splashCount) * Math.PI * 2;
          const cos = Math.cos(angle) * SPLAT.splashRadius;
          const sin = Math.sin(angle) * SPLAT.splashRadius;
          this.paintSplat(
            x + this.tangent[0] * cos + this.bitangent[0] * sin,
            y + this.tangent[1] * cos + this.bitangent[1] * sin,
            z + this.tangent[2] * cos + this.bitangent[2] * sin,
            color,
            kindConfig.splatSizeMult,
            kind,
          );
        }
        ball.destroy();
        break;
      }

      default: {
        this.paintSplat(x, y, z, color, kindConfig.splatSizeMult, kind);
        ball.destroy();
        break;
      }
    }
  }

  /** Lifetime, kill-floor, and sticky-fade culling. Applies to every ball. */
  private cullBall(ball: Entity, nowSec: number): void {
    const state = ball.getValue(Ball, 'flightState');

    if (state === BallFlightState.Stuck) {
      const landedAt = ball.getValue(Ball, 'landedAt') ?? 0;
      if (nowSec - landedAt > BALLS.stickyLifetimeSec) {
        ball.destroy();
      }
      return;
    }

    const spawnTime = ball.getValue(Ball, 'spawnTime') ?? 0;
    if (nowSec - spawnTime > BALLS.lifetimeSec) {
      ball.destroy();
      return;
    }

    const object3D = ball.object3D;
    if (!object3D) return;
    object3D.getWorldPosition(this.worldPosition);
    if (this.worldPosition.y < BALLS.killFloorY) {
      ball.destroy();
    }
  }

  /**
   * Write one splat through SplatterSystem, reusing the tuple scratch buffers.
   * The normal always comes from the current contact so satellite splats of a
   * Splash lie in the same plane as the centre one.
   */
  private paintSplat(
    x: number,
    y: number,
    z: number,
    color: Float32Array,
    sizeMult: number,
    kind: BallKind,
  ): void {
    const splatter = this.resolveSplatter();
    if (!splatter) return;

    this.splatPosition[0] = x;
    this.splatPosition[1] = y;
    this.splatPosition[2] = z;
    this.splatNormal[0] = this.contactNormal[0];
    this.splatNormal[1] = this.contactNormal[1];
    this.splatNormal[2] = this.contactNormal[2];
    this.splatColor[0] = color[0];
    this.splatColor[1] = color[1];
    this.splatColor[2] = color[2];

    splatter.addSplat(
      this.splatPosition,
      this.splatNormal,
      this.splatColor,
      sizeMult,
    );
    this.events.emit(GameEvent.SplatPainted, x, y, z, kind);
  }

  /**
   * The web-mode equivalent: one decal from SplatterSystem's second pool.
   *
   * No colour argument — webbing is always white, and SplatterSystem owns that
   * fact. SplatPainted is still emitted so anything counting paint events sees
   * webbing too; the kind byte stays Normal, which is what a web ball is
   * physically.
   */
  private paintWebSplat(
    x: number,
    y: number,
    z: number,
    sizeMult: number,
  ): void {
    const splatter = this.resolveSplatter();
    if (!splatter) return;

    this.splatPosition[0] = x;
    this.splatPosition[1] = y;
    this.splatPosition[2] = z;
    this.splatNormal[0] = this.contactNormal[0];
    this.splatNormal[1] = this.contactNormal[1];
    this.splatNormal[2] = this.contactNormal[2];

    splatter.addWebSplat(this.splatPosition, this.splatNormal, sizeMult);
    this.events.emit(GameEvent.SplatPainted, x, y, z, BallKind.Normal);
  }

  /**
   * Looked up on first impact rather than in init(): system registration order
   * is independent of priority, so SplatterSystem may not exist yet when this
   * system initialises.
   */
  private resolveSplatter(): SplatterSystem | undefined {
    if (!this.splatter) {
      this.splatter = this.world.getSystem(SplatterSystem);
    }
    return this.splatter;
  }
}
