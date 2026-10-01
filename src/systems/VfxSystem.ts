import {
  createSystem,
  DynamicDrawUsage,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import { VFX } from '../config';
import type { VfxBurstConfig, VfxShape } from '../config';
import {
  BallStyle,
  GameEvent,
  GameEventBuffer,
  PALETTE_COLORS,
  srgbToLinear,
  WEB_BALL_COLOR,
  unpackFiredStyle,
  unpackImpactRgb,
  unpackImpactStyle,
} from '../types';
import { tangentBasis } from './BallFlightSystem';

/** Per-particle silhouette, stored as a byte. @see VfxShape */
export const ParticleShape = {
  /** Uniformly scaled droplet. */
  Blob: 0,
  /** Flattened chip tumbling about a random axis — confetti. */
  Flake: 1,
  /** Stretched along its own velocity — a spark trail. */
  Streak: 2,
} as const;

export type ParticleShape = typeof ParticleShape[keyof typeof ParticleShape];

/** Config spelling → the byte the pool stores. Pure; exported for tests. */
export function shapeCode(shape: VfxShape): ParticleShape {
  switch (shape) {
    case 'flake':
      return ParticleShape.Flake;
    case 'streak':
      return ParticleShape.Streak;
    default:
      return ParticleShape.Blob;
  }
}

/**
 * Fixed-capacity, struct-of-arrays particle store. Pure data: no three.js, no
 * IWSDK, so the integration and compaction rules are unit-testable.
 *
 * Live particles are always **dense in [0, count)**. A particle that expires is
 * replaced by the last live one (swap-remove), which is what lets the system
 * hand `count` straight to `InstancedMesh.count` and draw exactly the live
 * prefix — no free list, no holes, no per-frame scan of dead slots.
 *
 * `colors` is laid out exactly like an `InstancedBufferAttribute(…, 3)` so the
 * system can wrap this very array as the mesh's `instanceColor`: a swap-remove
 * here moves the GPU-side colour too, with no copy. `colorsDirty` tells the
 * system a re-upload is due.
 */
export class ParticlePool {
  readonly capacity: number;
  /** Live particles, occupying slots [0, count). */
  count = 0;
  /** Set by any write to `colors`; the owner clears it after uploading. */
  colorsDirty = false;

  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  /** Seconds since spawn. */
  readonly age: Float32Array;
  /** Seconds the particle lives; it is removed once age >= life. */
  readonly life: Float32Array;
  /** Base radius, metres, before the life-curve scale. */
  readonly size: Float32Array;
  /** Fraction of the step's gravity this particle feels. */
  readonly gravityScale: Float32Array;
  /** Linear drag, 1/s. */
  readonly drag: Float32Array;
  /** Tumble axis (unit), angular speed (rad/s) and starting angle (rad). */
  readonly spinX: Float32Array;
  readonly spinY: Float32Array;
  readonly spinZ: Float32Array;
  readonly spinSpeed: Float32Array;
  readonly spinPhase: Float32Array;
  readonly shape: Uint8Array;
  /** Interleaved RGB, three floats per slot. Doubles as the instanceColor array. */
  readonly colors: Float32Array;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(
        `ParticlePool capacity must be a positive integer, got ${capacity}`,
      );
    }
    this.capacity = capacity;
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.gravityScale = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.spinX = new Float32Array(capacity);
    this.spinY = new Float32Array(capacity);
    this.spinZ = new Float32Array(capacity);
    this.spinSpeed = new Float32Array(capacity);
    this.spinPhase = new Float32Array(capacity);
    this.shape = new Uint8Array(capacity);
    this.colors = new Float32Array(capacity * 3);
  }

  /**
   * Claim the next free slot and reset its age. Returns -1 when the pool is
   * full: a burst that does not fit is truncated rather than evicting live
   * particles, because a half-finished confetti burst blinking out mid-air
   * looks worse than one with a few fewer pieces.
   *
   * The caller fills in every other field of the returned slot.
   */
  alloc(): number {
    if (this.count >= this.capacity) return -1;
    const slot = this.count++;
    this.age[slot] = 0;
    return slot;
  }

  /** Write one slot's colour (linear RGB) and flag the colours for upload. */
  setColor(slot: number, r: number, g: number, b: number): void {
    const base = slot * 3;
    this.colors[base] = r;
    this.colors[base + 1] = g;
    this.colors[base + 2] = b;
    this.colorsDirty = true;
  }

  /**
   * Advance every live particle by `dt` seconds: gravity on Y, linear drag,
   * semi-implicit Euler (velocity first, then position), then retire anything
   * that has outlived its life by swap-remove.
   *
   * Drag uses `1 / (1 + drag·dt)` rather than `exp(-drag·dt)`: identical to
   * first order, never negative, and no transcendental per particle.
   */
  step(dt: number, gravity: number): void {
    let i = 0;
    while (i < this.count) {
      const age = this.age[i] + dt;
      if (age >= this.life[i]) {
        this.removeAt(i);
        // The particle swapped into slot i has not been stepped yet.
        continue;
      }
      this.age[i] = age;

      this.vy[i] -= gravity * this.gravityScale[i] * dt;
      const damp = 1 / (1 + this.drag[i] * dt);
      const vx = this.vx[i] * damp;
      const vy = this.vy[i] * damp;
      const vz = this.vz[i] * damp;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;

      this.px[i] += vx * dt;
      this.py[i] += vy * dt;
      this.pz[i] += vz * dt;
      i++;
    }
  }

  /** Drop every live particle. */
  clear(): void {
    this.count = 0;
  }

  /** Retire slot `i` by moving the last live particle into it. */
  private removeAt(i: number): void {
    const last = this.count - 1;
    if (i !== last) {
      this.px[i] = this.px[last];
      this.py[i] = this.py[last];
      this.pz[i] = this.pz[last];
      this.vx[i] = this.vx[last];
      this.vy[i] = this.vy[last];
      this.vz[i] = this.vz[last];
      this.age[i] = this.age[last];
      this.life[i] = this.life[last];
      this.size[i] = this.size[last];
      this.gravityScale[i] = this.gravityScale[last];
      this.drag[i] = this.drag[last];
      this.spinX[i] = this.spinX[last];
      this.spinY[i] = this.spinY[last];
      this.spinZ[i] = this.spinZ[last];
      this.spinSpeed[i] = this.spinSpeed[last];
      this.spinPhase[i] = this.spinPhase[last];
      this.shape[i] = this.shape[last];
      const to = i * 3;
      const from = last * 3;
      this.colors[to] = this.colors[from];
      this.colors[to + 1] = this.colors[from + 1];
      this.colors[to + 2] = this.colors[from + 2];
      this.colorsDirty = true;
    }
    this.count = last;
  }
}

/**
 * Scale multiplier over a particle's life, `t` = age / life in [0, 1].
 *
 * Pops in from 40% to full size over [0, growEnd] (ease-out, so it reads as a
 * burst rather than a fade-in), holds, then shrinks to exactly zero over
 * [shrinkStart, 1] with a smoothstep. Shrinking is how particles "fade": the
 * material is opaque, so there is no alpha sorting and no overdraw.
 *
 * Pure; exported for tests. Out-of-range `t` is clamped.
 */
export function lifeScale(
  t: number,
  growEnd: number,
  shrinkStart: number,
): number {
  if (t <= 0) return growEnd > 0 ? 0.4 : 1;
  if (t >= 1) return 0;
  if (t < growEnd) {
    const u = t / growEnd;
    return 0.4 + 0.6 * (1 - (1 - u) * (1 - u));
  }
  if (t <= shrinkStart) return 1;
  const u = (t - shrinkStart) / (1 - shrinkStart);
  return 1 - u * u * (3 - 2 * u);
}

/**
 * Unit axis for a burst: the direction from (fx, fy, fz) toward (tx, ty, tz).
 * Falls back to straight up when the two points coincide.
 *
 * Used two ways: impact point → head approximates the surface normal (the
 * BallImpact event carries none — for a wall or a floor in front of the player
 * the normal points back at them), and head → muzzle approximates the shot's
 * forward direction for the muzzle puff.
 *
 * Pure; exported for tests. Writes into `out`, allocates nothing.
 */
export function burstAxis(
  fx: number,
  fy: number,
  fz: number,
  tx: number,
  ty: number,
  tz: number,
  out: Float32Array,
): void {
  const dx = tx - fx;
  const dy = ty - fy;
  const dz = tz - fz;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-6) {
    out[0] = 0;
    out[1] = 1;
    out[2] = 0;
    return;
  }
  out[0] = dx / len;
  out[1] = dy / len;
  out[2] = dz / len;
}

/**
 * Tilt a unit direction upward by `upBias` and renormalise it, in place.
 * Leaves the direction untouched when the bias would cancel it exactly
 * (straight down with a bias of 1), rather than producing a zero vector.
 *
 * Applied per particle, after the cone sample, so it works the same for a
 * full-sphere burst (which has no meaningful axis to tilt) as for a cone.
 *
 * Pure; exported for tests.
 */
export function tiltUp(dir: Float32Array, upBias: number): void {
  if (upBias === 0) return;
  const x = dir[0];
  const y = dir[1] + upBias;
  const z = dir[2];
  const len = Math.sqrt(x * x + y * y + z * z);
  if (len < 1e-6) return;
  dir[0] = x / len;
  dir[1] = y / len;
  dir[2] = z / len;
}

/**
 * A direction drawn uniformly from the spherical cap of half-angle
 * `halfAngleRad` around the unit axis (ax, ay, az), given two uniform randoms
 * in [0, 1). A half-angle of π covers the whole sphere.
 *
 * Uniform on the cap (cosθ uniform in [cos half, 1]), not uniform in θ —
 * otherwise bursts would bunch visibly along their axis.
 *
 * `basisT` / `basisB` are scratch for the tangent frame (reused, not read).
 * Pure; exported for tests. Writes into `out`, allocates nothing.
 */
export function coneDirection(
  ax: number,
  ay: number,
  az: number,
  halfAngleRad: number,
  u1: number,
  u2: number,
  basisT: Float32Array,
  basisB: Float32Array,
  out: Float32Array,
): void {
  const cosHalf = Math.cos(Math.min(Math.PI, Math.max(0, halfAngleRad)));
  const cosTheta = 1 - u1 * (1 - cosHalf);
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const phi = u2 * Math.PI * 2;
  const c = Math.cos(phi) * sinTheta;
  const s = Math.sin(phi) * sinTheta;

  tangentBasis(ax, ay, az, basisT, basisB);
  out[0] = basisT[0] * c + basisB[0] * s + ax * cosTheta;
  out[1] = basisT[1] * c + basisB[1] * s + ay * cosTheta;
  out[2] = basisT[2] * c + basisB[2] * s + az * cosTheta;
}

const DEG_TO_RAD = Math.PI / 180;

/** Speed (m/s) at which a streak reaches its full {@link VFX.streakStretch}. */
const STREAK_FULL_SPEED = 2;

/** How a burst picks each particle's colour. */
const ColorMode = {
  /** Every particle takes the burst's own colour. */
  Fixed: 0,
  /** Each particle picks one of the confetti colours at random. */
  Confetti: 1,
} as const;

type ColorMode = typeof ColorMode[keyof typeof ColorMode];

/**
 * Particle juice: robot-pop confetti, impact droplets, robot-hit spray, tether
 * sparks and a muzzle puff — everything from ONE pooled InstancedMesh.
 *
 * Event-driven and read-only toward the game: it reads this frame's
 * GameEventBuffer like FeedbackSystem does and never emits, so registering it
 * at priority 37 (after every producer and after FeedbackSystem at 36, before
 * EventFlushSystem clears the buffer at 90) is the whole integration.
 *
 * Performance budget, by design:
 * - **One draw call**, and only while something is alive: the mesh hides
 *   itself at count 0 (bar a few warm-up frames at session start, which exist
 *   so the shader compiles before the first robot pop rather than during it).
 * - **Opaque**: particles shrink to nothing instead of fading, so no sorting,
 *   no blending, no overdraw. 20-triangle icosahedra, 256 max = 5k triangles
 *   worst case.
 * - **Zero allocation per frame**: struct-of-arrays pool, scratch math objects
 *   built in init(), whole-buffer uploads (see update()) and nothing else.
 * - **Not interactive**: `raycast` is a no-op and there is no Interactable, so
 *   no pointer or game raycast can ever hit a particle.
 * - **Not depth-occluded**: IWSDK's DepthOccludable computes view depth from
 *   the raw `position` attribute, ignoring `instanceMatrix`, so on an
 *   InstancedMesh every particle would be tested at the mesh origin's depth —
 *   worse than no occlusion for things that live a fraction of a second.
 */
export class VfxSystem extends createSystem({}) {
  private events!: GameEventBuffer;
  private activeColor!: Signal<readonly [number, number, number, number]>;
  private activeStyle!: Signal<BallStyle>;

  private pool?: ParticlePool;
  private mesh?: InstancedMesh;
  private colorAttribute?: InstancedBufferAttribute;
  /** Frames left in the post-session-start shader warm-up. */
  private warmupFrames = 0;

  /** Flat RGB triplets the confetti picks from: the palette plus white. */
  private confettiColors!: Float32Array;

  // Scratch — built once in init(), reused for every particle of every frame.
  private matrix!: Matrix4;
  private rotation!: Quaternion;
  private position!: Vector3;
  private scale!: Vector3;
  private spinAxis!: Vector3;
  private velocityDir!: Vector3;
  private yAxis!: Vector3;
  private headPosition!: Vector3;
  private axis!: Float32Array;
  private direction!: Float32Array;
  private basisT!: Float32Array;
  private basisB!: Float32Array;
  private rgb!: Float32Array;

  init() {
    if (!VFX.enabled) return;

    this.events = this.globals.gameEvents as GameEventBuffer;
    this.activeColor = this.globals.activeColor as Signal<
      readonly [number, number, number, number]
    >;
    this.activeStyle = this.globals.activeStyle as Signal<BallStyle>;

    this.matrix = new Matrix4();
    this.rotation = new Quaternion();
    this.position = new Vector3();
    this.scale = new Vector3(1, 1, 1);
    this.spinAxis = new Vector3();
    this.velocityDir = new Vector3();
    this.yAxis = new Vector3(0, 1, 0);
    this.headPosition = new Vector3(0, 1.6, 0);
    this.axis = new Float32Array(3);
    this.direction = new Float32Array(3);
    this.basisT = new Float32Array(3);
    this.basisB = new Float32Array(3);
    this.rgb = new Float32Array(3);

    // Palette colours are sRGB; an instance-colour buffer is read as linear
    // and three never converts it, so convert once here — the same colour the
    // ball materials and splat decals now get via setRGB(..., SRGBColorSpace),
    // so a confetti chip and the paint on the wall are the same red.
    this.confettiColors = new Float32Array((PALETTE_COLORS.length + 1) * 3);
    for (let i = 0; i < PALETTE_COLORS.length; i++) {
      this.confettiColors[i * 3] = srgbToLinear(PALETTE_COLORS[i][0]);
      this.confettiColors[i * 3 + 1] = srgbToLinear(PALETTE_COLORS[i][1]);
      this.confettiColors[i * 3 + 2] = srgbToLinear(PALETTE_COLORS[i][2]);
    }
    const white = PALETTE_COLORS.length * 3;
    this.confettiColors[white] = 1;
    this.confettiColors[white + 1] = 1;
    this.confettiColors[white + 2] = 1;

    const pool = new ParticlePool(VFX.poolSize);
    this.pool = pool;

    // Unit-radius icosahedron (20 triangles) scaled per instance. Flat-shaded
    // and lit by the same IBL as the balls, so a tumbling confetti flake
    // flashes as its faces turn through the light — the cheapest "sparkle"
    // there is. Opaque on purpose (see the class comment).
    const geometry = new IcosahedronGeometry(1, 0);
    const material = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: VFX.roughness,
      metalness: 0,
      flatShading: true,
    });

    const mesh = new InstancedMesh(geometry, material, pool.capacity);
    mesh.name = 'VfxParticles';
    mesh.count = 0;
    // Instances span the whole room while the mesh's own bounds sit at the
    // origin; culling against those would drop live bursts. The mesh is hidden
    // outright whenever it is empty, which is the real culling.
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Never a hit for anything: pointer rays, grab probes or game raycasts.
    mesh.raycast = () => {};
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // Wrap the pool's own colour array: compaction moves colours in place and
    // the next upload just ships them.
    const colorAttribute = new InstancedBufferAttribute(pool.colors, 3);
    colorAttribute.setUsage(DynamicDrawUsage);
    mesh.instanceColor = colorAttribute;
    mesh.visible = false;
    this.mesh = mesh;
    this.colorAttribute = colorAttribute;

    // Persistent and parented to the scene root, so instance matrices are in
    // world space and the mesh survives any level change.
    this.world.createTransformEntity(mesh, {
      parent: this.world.sceneEntity,
      persistent: true,
    });

    // Shader warm-up: draw the empty mesh for a few frames whenever the
    // headset session becomes visible. Programs compiled in the immersive
    // (multiview) render path are not the ones compiled on the 2D page, so this
    // has to happen in-session; a 0-instance draw is a no-op on the GPU.
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        if (state === VisibilityState.Visible) {
          this.warmupFrames = VFX.warmupFrames;
        }
      }),
    );
  }

  update(delta: number) {
    const pool = this.pool;
    const mesh = this.mesh;
    if (!pool || !mesh) return;

    this.consumeEvents(pool);

    // A long frame (asset streaming, a shader compile elsewhere) would
    // otherwise integrate a huge step and fling particles through the walls.
    const dt = Math.min(Math.max(delta, 0), VFX.maxStepSec);
    if (pool.count > 0 && dt > 0) {
      pool.step(dt, VFX.gravity);
    }

    const count = pool.count;
    if (count > 0) {
      this.writeMatrices(pool, mesh, count);
      // Whole-buffer uploads on purpose: 16 KB of matrices (+3 KB of colours
      // when they moved) is nothing over the bus, whereas update ranges cost a
      // fresh {start, count} object per call plus three's sort closure — i.e.
      // per-frame garbage, which is the one thing this system must not make.
      mesh.instanceMatrix.needsUpdate = true;
      const colors = this.colorAttribute;
      if (colors && pool.colorsDirty) {
        colors.needsUpdate = true;
        pool.colorsDirty = false;
      }
    }

    mesh.count = count;
    mesh.visible = count > 0 || this.warmupFrames > 0;
    if (this.warmupFrames > 0) this.warmupFrames--;
  }

  // ---- Events → bursts -------------------------------------------------------

  private consumeEvents(pool: ParticlePool): void {
    const events = this.events;
    const count = events.count;
    if (count === 0) return;

    let headKnown = false;

    for (let i = 0; i < count; i++) {
      const type = events.typeAt(i);
      switch (type) {
        case GameEvent.TargetPopped: {
          // Confetti straight up and out of the robot's body; the axis is
          // world-up and the wide cone + upBias do the rest.
          this.burst(
            pool,
            VFX.pop,
            events.xAt(i),
            events.yAt(i),
            events.zAt(i),
            0,
            1,
            0,
            ColorMode.Confetti,
          );
          break;
        }

        case GameEvent.BallImpact: {
          if (VFX.impact.count <= 0) break;
          if (!headKnown) headKnown = this.readHead();
          const data = events.dataAt(i);
          if (unpackImpactStyle(data) === BallStyle.Web) {
            this.setRgb(WEB_BALL_COLOR[0], WEB_BALL_COLOR[1], WEB_BALL_COLOR[2]);
          } else {
            const packed = unpackImpactRgb(data);
            this.setRgb(
              ((packed >> 16) & 0xff) / 255,
              ((packed >> 8) & 0xff) / 255,
              (packed & 0xff) / 255,
            );
          }
          this.burstToward(pool, VFX.impact, i, true);
          break;
        }

        case GameEvent.TargetHit: {
          // Every hit, the killing blow included (TargetHit fires on it with
          // data = 0 hp, alongside TargetPopped): the ball's paint bursting off
          // the robot, under the kill's confetti.
          if (VFX.hit.count <= 0) break;
          if (!headKnown) headKnown = this.readHead();
          // The event carries hit points, not a colour. The loaded ammo is
          // what was almost certainly fired: a ball crosses a room in well
          // under a second, far faster than anyone re-picks a colour.
          this.setLoadedColor();
          this.burstToward(pool, VFX.hit, i, true);
          break;
        }

        case GameEvent.TetherAttached: {
          this.setRgb(1, 1, 1);
          this.burst(
            pool,
            VFX.tether,
            events.xAt(i),
            events.yAt(i),
            events.zAt(i),
            0,
            1,
            0,
            ColorMode.Fixed,
          );
          break;
        }

        case GameEvent.BallFired: {
          if (VFX.muzzle.count <= 0) break;
          if (!headKnown) headKnown = this.readHead();
          if (unpackFiredStyle(events.dataAt(i)) === BallStyle.Web) {
            this.setRgb(WEB_BALL_COLOR[0], WEB_BALL_COLOR[1], WEB_BALL_COLOR[2]);
          } else {
            this.setLoadedColor();
          }
          // Head → muzzle approximates the shot direction; the puff drifts
          // forward off the barrel.
          this.burstToward(pool, VFX.muzzle, i, false);
          break;
        }

        default:
          break;
      }
    }
  }

  /**
   * A burst whose axis points from the event toward the head (`towardHead`)
   * or from the head through the event (muzzle puffs). Colour is whatever
   * `this.rgb` holds.
   */
  private burstToward(
    pool: ParticlePool,
    config: VfxBurstConfig,
    eventIndex: number,
    towardHead: boolean,
  ): void {
    const events = this.events;
    const x = events.xAt(eventIndex);
    const y = events.yAt(eventIndex);
    const z = events.zAt(eventIndex);
    const h = this.headPosition;
    if (towardHead) {
      burstAxis(x, y, z, h.x, h.y, h.z, this.axis);
    } else {
      burstAxis(h.x, h.y, h.z, x, y, z, this.axis);
    }
    this.burst(
      pool,
      config,
      x,
      y,
      z,
      this.axis[0],
      this.axis[1],
      this.axis[2],
      ColorMode.Fixed,
    );
  }

  /**
   * Spawn one burst of `config.count` particles at (x, y, z): directions are
   * sampled in the cone of `config.spreadDeg` around the axis, then tilted up
   * by `config.upBias`, so arcs rise before gravity takes them.
   */
  private burst(
    pool: ParticlePool,
    config: VfxBurstConfig,
    x: number,
    y: number,
    z: number,
    axisX: number,
    axisY: number,
    axisZ: number,
    colorMode: ColorMode,
  ): void {
    if (config.count <= 0) return;

    const half = config.spreadDeg * DEG_TO_RAD;
    const shape = shapeCode(config.shape);
    const baseSize = VFX.particleRadius * config.size;
    const dir = this.direction;
    const confetti = this.confettiColors;
    const confettiCount = confetti.length / 3;

    for (let n = 0; n < config.count; n++) {
      const slot = pool.alloc();
      if (slot < 0) return;

      coneDirection(
        axisX,
        axisY,
        axisZ,
        half,
        Math.random(),
        Math.random(),
        this.basisT,
        this.basisB,
        dir,
      );
      // Per particle rather than on the axis, so a full-sphere burst (which
      // has no axis worth tilting) still fountains instead of exploding evenly.
      tiltUp(dir, config.upBias);
      const dx = dir[0];
      const dy = dir[1];
      const dz = dir[2];

      const speed =
        config.speedMin + Math.random() * (config.speedMax - config.speedMin);
      pool.px[slot] = x + dx * config.startOffset;
      pool.py[slot] = y + dy * config.startOffset;
      pool.pz[slot] = z + dz * config.startOffset;
      pool.vx[slot] = dx * speed;
      pool.vy[slot] = dy * speed;
      pool.vz[slot] = dz * speed;
      pool.life[slot] =
        config.lifeMin + Math.random() * (config.lifeMax - config.lifeMin);
      pool.size[slot] = baseSize * (0.7 + Math.random() * 0.6);
      pool.gravityScale[slot] = config.gravityScale;
      pool.drag[slot] = config.drag;
      pool.shape[slot] = shape;

      if (shape === ParticleShape.Flake) {
        // Random tumble axis: reuse the cone sampler over the full sphere.
        coneDirection(
          0,
          1,
          0,
          Math.PI,
          Math.random(),
          Math.random(),
          this.basisT,
          this.basisB,
          dir,
        );
        pool.spinX[slot] = dir[0];
        pool.spinY[slot] = dir[1];
        pool.spinZ[slot] = dir[2];
        pool.spinSpeed[slot] =
          VFX.spinMin + Math.random() * (VFX.spinMax - VFX.spinMin);
        pool.spinPhase[slot] = Math.random() * Math.PI * 2;
      }

      if (colorMode === ColorMode.Confetti) {
        const pick = Math.min(
          confettiCount - 1,
          Math.floor(Math.random() * confettiCount),
        );
        pool.setColor(
          slot,
          confetti[pick * 3],
          confetti[pick * 3 + 1],
          confetti[pick * 3 + 2],
        );
      } else {
        pool.setColor(slot, this.rgb[0], this.rgb[1], this.rgb[2]);
      }
    }
  }

  // ---- Pool → instance matrices ---------------------------------------------

  private writeMatrices(
    pool: ParticlePool,
    mesh: InstancedMesh,
    count: number,
  ): void {
    const matrix = this.matrix;
    const rotation = this.rotation;
    const position = this.position;
    const scale = this.scale;
    const array = mesh.instanceMatrix.array as Float32Array;

    for (let i = 0; i < count; i++) {
      const s =
        pool.size[i] *
        lifeScale(pool.age[i] / pool.life[i], VFX.growEnd, VFX.shrinkStart);
      position.set(pool.px[i], pool.py[i], pool.pz[i]);

      switch (pool.shape[i]) {
        case ParticleShape.Flake: {
          this.spinAxis.set(pool.spinX[i], pool.spinY[i], pool.spinZ[i]);
          rotation.setFromAxisAngle(
            this.spinAxis,
            pool.spinPhase[i] + pool.spinSpeed[i] * pool.age[i],
          );
          scale.set(s, s * VFX.flakeThickness, s);
          break;
        }

        case ParticleShape.Streak: {
          const vx = pool.vx[i];
          const vy = pool.vy[i];
          const vz = pool.vz[i];
          const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
          if (speed > 1e-4) {
            this.velocityDir.set(vx / speed, vy / speed, vz / speed);
            rotation.setFromUnitVectors(this.yAxis, this.velocityDir);
          } else {
            rotation.identity();
          }
          // Full trail length at STREAK_FULL_SPEED, collapsing to a dot as
          // drag stalls the spark — the trail reads as speed, not as shape.
          const stretch =
            1 +
            (VFX.streakStretch - 1) * Math.min(1, speed / STREAK_FULL_SPEED);
          scale.set(s, s * stretch, s);
          break;
        }

        default: {
          rotation.identity();
          scale.set(s, s, s);
          break;
        }
      }

      matrix.compose(position, rotation, scale);
      matrix.toArray(array, i * 16);
    }
  }

  // ---- Small helpers ----------------------------------------------------------

  /** Refresh the cached head position. Returns true so callers can latch it. */
  private readHead(): boolean {
    const head = this.player?.head;
    if (head) head.getWorldPosition(this.headPosition);
    return true;
  }

  /** Store an sRGB colour (palette convention) as linear for the buffer. */
  private setRgb(r: number, g: number, b: number): void {
    this.rgb[0] = srgbToLinear(r);
    this.rgb[1] = srgbToLinear(g);
    this.rgb[2] = srgbToLinear(b);
  }

  /** Whatever is loaded right now: webbing is always white, paint its dab. */
  private setLoadedColor(): void {
    if (this.activeStyle.peek() === BallStyle.Web) {
      this.setRgb(WEB_BALL_COLOR[0], WEB_BALL_COLOR[1], WEB_BALL_COLOR[2]);
      return;
    }
    const color = this.activeColor.peek();
    this.setRgb(color[0], color[1], color[2]);
  }
}
