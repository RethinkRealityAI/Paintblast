import {
  createComponent,
  createSystem,
  Types,
  AssetManager,
  MeshBasicMaterial,
  CircleGeometry,
  InstancedMesh,
  Color,
  Vector3,
  Quaternion,
  Matrix4,
  DoubleSide,
} from '@iwsdk/core';

import { SPLAT, WEB } from '../config';

type Vec3 = readonly [number, number, number];

/** Asset-manifest key Wave C registers the alpha-tested splat texture under. */
export const SPLAT_TEXTURE_KEY = 'splatTexture';

/**
 * Asset-manifest key for the web silhouette mask (round 4). Same contract as
 * SPLAT_TEXTURE_KEY: a white-on-black mask bound as an alphaMap, so a missing
 * file degrades to a flat disc rather than to nothing.
 */
export const WEB_SPLAT_TEXTURE_KEY = 'webSplat';

/**
 * Instance tint for web decals — very slightly off-white.
 *
 * Pure #ffffff against passthrough reads as a blown-out hole rather than as
 * webbing; a couple of percent down keeps the silhouette legible while still
 * being unmistakably white.
 */
const WEB_SPLAT_TINT: Vec3 = [0.941, 0.941, 0.941];

/**
 * Pure data ring buffer for splatter decals.
 *
 * Kept separate from the System wrapper so unit tests can exercise
 * the indexing/wraparound logic without needing a live World or any
 * Three.js / IWSDK runtime.
 */
export class SplatterPool {
  readonly capacity: number;
  writeIdx = 0;
  liveCount = 0;

  private readonly positions: Float32Array;
  private readonly normals: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`SplatterPool capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.normals = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
  }

  /**
   * Write one splat into the pool and return the slot index that was written.
   * Advances writeIdx (wrapping) and grows liveCount up to capacity.
   *
   * `size` is the final scale multiplier applied to the decal geometry (which
   * is already SPLAT.baseRadius across), i.e. kind multiplier × random jitter.
   */
  addSplat(position: Vec3, normal: Vec3, color: Vec3, size = 1): number {
    const slot = this.writeIdx;
    const base = slot * 3;

    this.positions[base]     = position[0];
    this.positions[base + 1] = position[1];
    this.positions[base + 2] = position[2];

    this.normals[base]     = normal[0];
    this.normals[base + 1] = normal[1];
    this.normals[base + 2] = normal[2];

    this.colors[base]     = color[0];
    this.colors[base + 1] = color[1];
    this.colors[base + 2] = color[2];

    this.sizes[slot] = size;

    this.writeIdx = (this.writeIdx + 1) % this.capacity;
    if (this.liveCount < this.capacity) {
      this.liveCount++;
    }

    return slot;
  }

  /**
   * Reset the pool: zero writeIdx and liveCount, zero out all TypedArrays.
   * Capacity is preserved. Used by the HUD's "Clear Paint" button.
   */
  clear(): void {
    this.writeIdx = 0;
    this.liveCount = 0;
    this.positions.fill(0);
    this.normals.fill(0);
    this.colors.fill(0);
    this.sizes.fill(0);
  }

  /** Read back a splat slot for tests / the System wrapper's InstancedMesh sync. */
  getSplatPosition(slot: number): Vec3 {
    const b = slot * 3;
    return [this.positions[b], this.positions[b + 1], this.positions[b + 2]];
  }

  getSplatNormal(slot: number): Vec3 {
    const b = slot * 3;
    return [this.normals[b], this.normals[b + 1], this.normals[b + 2]];
  }

  getSplatColor(slot: number): Vec3 {
    const b = slot * 3;
    return [this.colors[b], this.colors[b + 1], this.colors[b + 2]];
  }

  getSplatSize(slot: number): number {
    return this.sizes[slot];
  }
}

/**
 * Singleton component marking the one-per-session SplatterField entity.
 * The entity is also tagged with XRAnchor (in main.ts) so its origin stays
 * locked to the real room across WebXR tracking drift.
 *
 * The `web*` mirrors are the round-4 web-splat pool, which is a second,
 * independent ring buffer behind a second InstancedMesh (different mask, white
 * tint) hung off this same entity. Kept as extra fields rather than a second
 * component so one `ecs_query_entity` call still shows the whole paint state.
 */
export const SplatterField = createComponent('SplatterField', {
  capacity:  { type: Types.Int32, default: SPLAT.capacity },
  writeIdx:  { type: Types.Int32, default: 0 },
  liveCount: { type: Types.Int32, default: 0 },
  webCapacity:  { type: Types.Int32, default: WEB.splatCapacity },
  webWriteIdx:  { type: Types.Int32, default: 0 },
  webLiveCount: { type: Types.Int32, default: 0 },
});

/**
 * Owns the InstancedMesh(es) of splat decals and keeps their instance
 * matrices/colors in sync with a SplatterPool on every add call.
 *
 * One entity (marked with SplatterField), one draw call per paint type, no
 * per-splat ECS overhead.
 *
 * Each splat gets a random size, a random roll about the surface normal, and a
 * couple of millimetres of lift off that surface. The lift is what stops decals
 * z-fighting with the real-world plane they were painted on; the size and roll
 * are what stop a painted wall reading as a lattice of identical circles.
 *
 * Round 4 added a **second** pool for web mode. It is a genuinely separate ring
 * buffer and mesh rather than a flag on the first, for two reasons: the mask is
 * a different texture (a web silhouette, not a paint splat), and a material can
 * only carry one alphaMap. Both hang off the same anchored entity, so both
 * stay locked to the room, and CLEAR PAINT wipes both.
 */
export class SplatterSystem extends createSystem({
  field: { required: [SplatterField] },
}) {
  private pool!: SplatterPool;
  private instancedMesh!: InstancedMesh;
  private webPool!: SplatterPool;
  private webMesh!: InstancedMesh;

  // Scratch objects reused every addSplat() — NEVER allocated in update loops.
  private scratchMatrix!: Matrix4;
  private scratchQuaternion!: Quaternion;
  private scratchRoll!: Quaternion;
  private scratchPosition!: Vector3;
  private scratchScale!: Vector3;
  private scratchColor!: Color;
  private scratchNormal!: Vector3;
  private scratchUp!: Vector3;

  init() {
    this.pool = new SplatterPool(SPLAT.capacity);
    this.webPool = new SplatterPool(WEB.splatCapacity);

    this.instancedMesh = this.buildDecalMesh(
      SPLAT.capacity,
      SPLAT_TEXTURE_KEY,
    );
    this.webMesh = this.buildDecalMesh(
      WEB.splatCapacity,
      WEB_SPLAT_TEXTURE_KEY,
    );

    this.scratchMatrix = new Matrix4();
    this.scratchQuaternion = new Quaternion();
    this.scratchRoll = new Quaternion();
    this.scratchPosition = new Vector3();
    this.scratchScale = new Vector3(1, 1, 1);
    this.scratchColor = new Color();
    this.scratchNormal = new Vector3();
    this.scratchUp = new Vector3(0, 0, 1);

    // Attach both InstancedMeshes under the SplatterField entity's object3D
    // when the singleton entity qualifies. There should only ever be one.
    this.cleanupFuncs.push(
      this.queries.field.subscribe('qualify', (entity) => {
        entity.object3D?.add(this.instancedMesh);
        entity.object3D?.add(this.webMesh);
        entity.setValue(SplatterField, 'capacity', this.pool.capacity);
        entity.setValue(SplatterField, 'webCapacity', this.webPool.capacity);
        this.syncFieldCounters();
      }),
    );
  }

  /**
   * One decal draw call: a shared disc geometry, a transparent unlit material,
   * and an optional white-on-black silhouette bound as its alphaMap.
   *
   * The mask binds as `alphaMap`, never as `map`: the PNGs are white shapes on
   * black with no alpha channel, so alphaTest punches the black out while the
   * material colour stays white — which is what lets the per-instance colour
   * tint each decal. Bound as `map` it would multiply every splat toward black.
   *
   * Feature-detected throughout, so a texture that is missing (or an
   * AssetManager that was never initialised, as in unit tests) leaves a clean
   * flat disc rather than failing to render at all.
   */
  private buildDecalMesh(capacity: number, textureKey: string): InstancedMesh {
    const geometry = new CircleGeometry(SPLAT.baseRadius, 12);
    const material = new MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });

    try {
      const texture = AssetManager.getTexture(textureKey);
      if (texture) {
        material.alphaMap = texture;
        material.alphaTest = 0.4;
        material.transparent = true;
        material.depthWrite = false;
        material.needsUpdate = true;
      }
    } catch {
      // AssetManager not initialised (unit tests) or key absent — flat disc.
    }

    const mesh = new InstancedMesh(geometry, material, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    return mesh;
  }

  /**
   * Write a paint splat into the pool and update the InstancedMesh slot in
   * place. Called by BallFlightSystem on every confirmed impact of a
   * paint-style ball.
   *
   * @param sizeMult Per-ball-kind size multiplier; random jitter is applied on top.
   */
  addSplat(
    worldPosition: Vec3,
    worldNormal: Vec3,
    colorRgb: Vec3,
    sizeMult = 1,
  ): void {
    this.place(
      this.pool,
      this.instancedMesh,
      worldPosition,
      worldNormal,
      colorRgb,
      sizeMult,
    );
    this.syncFieldCounters();
  }

  /**
   * The same, for web mode: a web silhouette rather than a paint splat, always
   * white, in its own pool so webbing never evicts paint (or the reverse).
   *
   * Colour is not a parameter because web mode has no palette — every strand
   * comes out of the shooter the same near-white. Keeping it fixed here rather
   * than threading `[1,1,1]` through every call site is what makes that a
   * property of the mode instead of a convention callers must remember.
   */
  addWebSplat(worldPosition: Vec3, worldNormal: Vec3, sizeMult = 1): void {
    this.place(
      this.webPool,
      this.webMesh,
      worldPosition,
      worldNormal,
      WEB_SPLAT_TINT,
      sizeMult,
    );
    this.syncFieldCounters();
  }

  /**
   * Ring-buffer write plus the matching InstancedMesh slot update. Shared by
   * both pools — the jitter, the normal lift and the in-plane roll are the same
   * anti-lattice treatment whichever mask is on top.
   */
  private place(
    pool: SplatterPool,
    mesh: InstancedMesh,
    worldPosition: Vec3,
    worldNormal: Vec3,
    colorRgb: Vec3,
    sizeMult: number,
  ): void {
    const jitter =
      SPLAT.sizeJitterMin +
      Math.random() * (SPLAT.sizeJitterMax - SPLAT.sizeJitterMin);
    const finalSize = sizeMult * jitter;
    const lift =
      SPLAT.normalOffsetMin +
      Math.random() * (SPLAT.normalOffsetMax - SPLAT.normalOffsetMin);

    const slot = pool.addSplat(worldPosition, worldNormal, colorRgb, finalSize);

    this.scratchNormal
      .set(worldNormal[0], worldNormal[1], worldNormal[2])
      .normalize();
    this.scratchPosition
      .set(worldPosition[0], worldPosition[1], worldPosition[2])
      .addScaledVector(this.scratchNormal, lift);

    // Align the disc's +Z face to the surface, then spin it in-plane so
    // repeated splats on the same wall are not rotationally identical.
    this.scratchQuaternion.setFromUnitVectors(this.scratchUp, this.scratchNormal);
    this.scratchRoll.setFromAxisAngle(this.scratchUp, Math.random() * Math.PI * 2);
    this.scratchQuaternion.multiply(this.scratchRoll);

    this.scratchScale.set(finalSize, finalSize, finalSize);
    this.scratchMatrix.compose(this.scratchPosition, this.scratchQuaternion, this.scratchScale);
    mesh.setMatrixAt(slot, this.scratchMatrix);

    this.scratchColor.setRGB(colorRgb[0], colorRgb[1], colorRgb[2]);
    mesh.setColorAt(slot, this.scratchColor);

    mesh.count = pool.liveCount;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Mirror both pools' state onto the component for MCP inspection tools. */
  private syncFieldCounters(): void {
    for (const entity of this.queries.field.entities) {
      entity.setValue(SplatterField, 'writeIdx', this.pool.writeIdx);
      entity.setValue(SplatterField, 'liveCount', this.pool.liveCount);
      entity.setValue(SplatterField, 'webWriteIdx', this.webPool.writeIdx);
      entity.setValue(SplatterField, 'webLiveCount', this.webPool.liveCount);
    }
  }

  /**
   * Wipe both pools — the HUD's CLEAR PAINT button.
   *
   * It clears webbing as well as paint, deliberately: the button is the one
   * "undo the mess" control in the game, and a player who has just webbed their
   * living room white does not want to be told that the button only removes the
   * other kind of mess.
   */
  clearAll(): void {
    this.pool.clear();
    this.instancedMesh.count = 0;
    this.instancedMesh.instanceMatrix.needsUpdate = true;

    this.webPool.clear();
    this.webMesh.count = 0;
    this.webMesh.instanceMatrix.needsUpdate = true;

    this.syncFieldCounters();
  }

  /** Read-only access for tests and debugging. */
  get debugPool(): SplatterPool {
    return this.pool;
  }

  /** Read-only access to the web-splat ring buffer. */
  get debugWebPool(): SplatterPool {
    return this.webPool;
  }
}
