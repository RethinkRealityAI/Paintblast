/**
 * Vitest mock for @iwsdk/core.
 *
 * Provides minimal stubs for createComponent, createSystem, and Types so that
 * SplatterSystem.ts can be imported in unit tests without triggering browser-only
 * side effects from @iwsdk/xr-input (canvas.getContext etc.).
 *
 * Only SplatterPool (the pure class) is under test — the System wrapper requires
 * a live World and is verified manually at the Phase 1 gate.
 */

export enum Types {
  Int8 = 'Int8',
  Int16 = 'Int16',
  Int32 = 'Int32',
  Float32 = 'Float32',
  Float64 = 'Float64',
  Boolean = 'Boolean',
  String = 'String',
  Vec3 = 'Vec3',
  Vec4 = 'Vec4',
  Color = 'Color',
  Enum = 'Enum',
  Entity = 'Entity',
  Object = 'Object',
}

export function createComponent(id: string, schema: Record<string, unknown>) {
  return { id, schema, data: {}, bitmask: null, typeId: 0 };
}

// createSystem returns a base class. SplatterSystem extends it.
// The stub just returns a minimal class with the expected interface.
export function createSystem(_queries: Record<string, unknown>, _config?: Record<string, unknown>) {
  return class {
    queries: Record<string, { entities: unknown[]; subscribe: () => void }> = {};
    cleanupFuncs: Array<() => void> = [];
    init?(): void {}
  };
}

// Three.js stubs — never called in unit tests (only pure classes/functions are
// exercised; the System wrappers are merely imported, never instantiated).
export class Vector3 {
  x = 0; y = 0; z = 0;
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(_x: number, _y: number, _z: number) { return this; }
  copy(_v: unknown) { return this; }
  add(_v: unknown) { return this; }
  length() { return 0; }
  lengthSq() { return 0; }
  multiplyScalar(_s: number) { return this; }
  normalize() { return this; }
  addScaledVector(_v: unknown, _s: number) { return this; }
  applyQuaternion(_q: unknown) { return this; }
  applyMatrix4(_m: unknown) { return this; }
}
export class Quaternion {
  copy(_q: unknown) { return this; }
  identity() { return this; }
  setFromUnitVectors(_from: unknown, _to: unknown) { return this; }
  setFromAxisAngle(_axis: unknown, _angle: number) { return this; }
  multiply(_q: unknown) { return this; }
}
export class Matrix4 {
  compose(_p: unknown, _q: unknown, _s: unknown) { return this; }
  copy(_m: unknown) { return this; }
  invert() { return this; }
}
export class Color {
  setRGB(_r: number, _g: number, _b: number) { return this; }
}
export class CircleGeometry {}
export class MeshBasicMaterial {
  constructor(_params?: unknown) {}
}
export class InstancedMesh {
  count = 0;
  frustumCulled = false;
  instanceMatrix = { needsUpdate: false };
  instanceColor: { needsUpdate: boolean } | null = null;
  constructor(_geo: unknown, _mat: unknown, _count: number) {}
  setMatrixAt(_slot: number, _mat: unknown) {}
  setColorAt(_slot: number, _color: unknown) {}
}
export const DoubleSide = 2;
export class Mesh {}

export class SphereGeometry {
  constructor(_radius?: number, _widthSegments?: number, _heightSegments?: number) {}
}
export class MeshStandardMaterial {
  constructor(_params?: unknown) {}
}

// Tag/behaviour components — same stub shape as the other components.
export const Interactable = { id: 'Interactable', schema: {}, data: {}, bitmask: null, typeId: 0 };
/** Round 3: fingertip-poke eligibility, worn by every wrist-palette pressable. */
export const PokeInteractable = { id: 'PokeInteractable', schema: {}, data: {}, bitmask: null, typeId: 0 };
export const Hovered = { id: 'Hovered', schema: {}, data: {}, bitmask: null, typeId: 0 };
export const Pressed = { id: 'Pressed', schema: {}, data: {}, bitmask: null, typeId: 0 };
export const OneHandGrabbable = { id: 'OneHandGrabbable', schema: {}, data: {}, bitmask: null, typeId: 0 };
export const PhysicsBody = { id: 'PhysicsBody', schema: {}, data: {}, bitmask: null, typeId: 0 };
export const PhysicsShape = { id: 'PhysicsShape', schema: {}, data: {}, bitmask: null, typeId: 0 };
export const PhysicsManipulation = { id: 'PhysicsManipulation', schema: {}, data: {}, bitmask: null, typeId: 0 };

export enum PhysicsState {
  Static = 0,
  Dynamic = 1,
  Kinematic = 2,
}

export enum PhysicsShapeType {
  Sphere = 0,
  Box = 1,
  Cylinder = 2,
  Capsule = 3,
  ConvexHull = 4,
  TriMesh = 5,
  Auto = 6,
}

// Scene understanding components — produced by SceneUnderstandingSystem for
// detected real-world planes and meshes. Stubs only; live entities are never
// created in unit tests (happy-dom has no WebXR).
export const XRPlane = { id: 'XRPlane', schema: { semanticLabel: {} }, data: {}, bitmask: null, typeId: 0 };
export const XRMesh  = { id: 'XRMesh',  schema: { semanticLabel: {} }, data: {}, bitmask: null, typeId: 0 };

// ---- Additions for Task 7/8 (main.ts + HUD) --------------------------------

export enum SessionMode {
  ImmersiveAR = 'immersive-ar',
  ImmersiveVR = 'immersive-vr',
}

export enum AssetType {
  GLTF = 'gltf',
  Audio = 'audio',
  Texture = 'texture',
  HDRTexture = 'hdr-texture',
}

// SplatterSystem.init() probes for an optional splat texture and
// TargetSystem.ensurePool() probes for the robot GLTF. In unit tests nothing
// is registered, so both report "not loaded": the splatter keeps its flat
// procedural disc and the robot pool stays empty.
export const AssetManager = {
  getTexture(_key: string): unknown {
    return null;
  },
  getGLTF(_key: string): { scene: unknown } | null {
    return null;
  },
  getAudio(_key: string): unknown {
    return null;
  },
};

export const World = {
  create: async (_container: unknown, _options: unknown): Promise<never> => {
    throw new Error('World.create is not available in unit-test environment');
  },
};

export const PanelUI = { id: 'PanelUI', schema: {}, data: {}, bitmask: null, typeId: 0 };
export const PanelDocument = { id: 'PanelDocument', schema: {}, data: {}, bitmask: null, typeId: 0 };
export const Follower = { id: 'Follower', schema: {}, data: {}, bitmask: null, typeId: 0 };

export enum FollowBehavior {
  FaceTarget = 0,
  PivotY = 1,
  NoRotation = 2,
}

export const XRAnchor = { id: 'XRAnchor', schema: {}, data: {}, bitmask: null, typeId: 0 };

// Task 9: depth occlusion tag component (AR-only — DepthSensingSystem
// silently no-ops on devices without depth-sensing).
export const DepthOccludable = { id: 'DepthOccludable', schema: {}, data: {}, bitmask: null, typeId: 0 };
// Round 9: TargetSystem extends it (RobotDepthSensingSystem); never run here.
export class DepthSensingSystem {
  update(): void {}
}

// ---- Additions for Wave B (targets, game state, HUD, feedback) -------------
//
// Same contract as everything above: only the pure exports of the Wave B
// systems are under test (ringSpawnPosition, advancePhase, ComboTracker,
// formatTimer), but importing those modules pulls the whole file in, so every
// symbol they reference at module scope needs a stub that can be constructed.

export class Box3 {
  setFromObject(_object: unknown) { return this; }
  getSize(_target: unknown) { return _target; }
  getCenter(_target: unknown) { return _target; }
}

export class Group {
  name = '';
  visible = true;
  children: unknown[] = [];
  position = { x: 0, y: 0, z: 0, set(_x: number, _y: number, _z: number) { return this; } };
  rotation = { x: 0, y: 0, z: 0 };
  scale = { setScalar(_s: number) { return this; } };
  add(..._objects: unknown[]) { return this; }
  getWorldPosition(target: unknown) { return target; }
}

// Panel document + audio components used by HudSystem / FeedbackSystem.
export const AudioSource = { id: 'AudioSource', schema: {}, data: {}, bitmask: null, typeId: 0 };

export const AudioUtils = {
  play(_entity: unknown, _fadeIn?: number): void {},
  pause(_entity: unknown, _fadeOut?: number): void {},
  stop(_entity: unknown): void {},
  isPlaying(_entity: unknown): boolean { return false; },
  setVolume(_entity: unknown, _volume: number): void {},
};

export const PlaybackMode = {
  Restart: 'restart',
  Overlap: 'overlap',
  Ignore: 'ignore',
  FadeRestart: 'fade-restart',
} as const;

export enum InputComponent {
  Trigger = 'xr-standard-trigger',
  Squeeze = 'xr-standard-squeeze',
  Touchpad = 'xr-standard-touchpad',
  Thumbstick = 'xr-standard-thumbstick',
  A_Button = 'a-button',
  B_Button = 'b-button',
  X_Button = 'x-button',
  Y_Button = 'y-button',
  Thumbrest = 'thumbrest',
  Menu = 'menu',
}

// Query value predicates. HudSystem filters its panel query with eq(); the
// stub only has to return something query-shaped, since no live World runs.
export function eq(component: unknown, key: string, value: unknown) {
  return { component, key, op: 'eq' as const, value };
}

/** UIKitML document handle — type-only in HudSystem, stubbed for completeness. */
export class UIKitDocument {
  getElementById(_id: string): unknown {
    return null;
  }
}

// ---- Additions for Round 2 (wrist palette, room-aware spawns, easel) -------
//
// Same contract as everything above: the pure exports under test
// (clampSpawnDistance, boardLocalToPixel) live in modules that pull these in
// at import time, so each needs a stub that can at least be constructed.

/** Spawn-time wall probe in TargetSystem. Never fired in unit tests. */
export class Raycaster {
  near = 0;
  far = Infinity;
  set(_origin: unknown, _direction: unknown) {}
  intersectObject(_object: unknown, _recursive: boolean, _target: unknown[]) {
    return _target;
  }
}

/** EaselSystem builds its board, legs and crossbar from these. */
export class BoxGeometry {
  constructor(
    _width?: number,
    _height?: number,
    _depth?: number,
  ) {}
}

/**
 * Round 5: WebShooterSystem's fallback shooter is a band, so the module pulls
 * a torus in at import time even though no test ever builds one.
 */
export class TorusGeometry {
  constructor(
    _radius?: number,
    _tube?: number,
    _radialSegments?: number,
    _tubularSegments?: number,
  ) {}
}

/**
 * Round 4: main.ts squashes the palette board out of one of these, and
 * WebShooterSystem builds its nozzle and its strand pool from them.
 */
export class CylinderGeometry {
  constructor(
    _radiusTop?: number,
    _radiusBottom?: number,
    _height?: number,
    _radialSegments?: number,
    _heightSegments?: number,
    _openEnded?: boolean,
  ) {}
  scale(_x: number, _y: number, _z: number) {
    return this;
  }
}

/** Backs the paintable canvas texture. */
export class CanvasTexture {
  needsUpdate = false;
  colorSpace = '';
  constructor(_canvas?: unknown) {}
}

export const SRGBColorSpace = 'srgb';

export const TwoHandsGrabbable = {
  id: 'TwoHandsGrabbable',
  schema: {},
  data: {},
  bitmask: null,
  typeId: 0,
};

/** World-space transform helpers used by WristPaletteSystem. */
export function setWorldPosition(_object: unknown, _position: unknown): void {}
export function setWorldQuaternion(
  _object: unknown,
  _orientation: unknown,
): void {}

/** SceneScanSystem starts its grace period off this. */
export enum VisibilityState {
  NonImmersive = 'non-immersive',
  Hidden = 'hidden',
  Visible = 'visible',
  VisibleBlurred = 'visible-blurred',
}

// ---- Additions for Round 7 (wet-paint balls, VFX particles) ----------------
//
// Same contract as everything above: VfxSystem's pure exports (ParticlePool,
// lifeScale, burstAxis, coneDirection, tiltUp, shapeCode) are under test, and
// importing the module pulls these in at module scope.

/** BallSpawnSystem's clearcoat ball material. Never constructed in tests. */
export class MeshPhysicalMaterial {
  constructor(_params?: unknown) {}
}

/** VfxSystem's particle geometry. */
export class IcosahedronGeometry {
  constructor(_radius?: number, _detail?: number) {}
}

/** VfxSystem wraps its pool's colour array in one of these. */
export class InstancedBufferAttribute {
  constructor(
    public array: ArrayLike<number>,
    public itemSize: number,
  ) {}
  setUsage(_usage: number) {
    return this;
  }
}

export const DynamicDrawUsage = 35048;
