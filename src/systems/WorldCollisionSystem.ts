import {
  createSystem,
  VisibilityState,
  XRPlane,
  XRMesh,
  PhysicsBody,
  PhysicsShape,
  PhysicsState,
  PhysicsShapeType,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';

import { ROOM } from '../config';

/**
 * The label Quest reports for the one big triangle soup covering the whole
 * room, exactly as the WebXR semantic-labels registry spells it: **ASCII
 * lowercase, one space**.
 *
 * Not `globalMesh`, not `global_mesh`, and emphatically not the native
 * `GLOBAL_MESH` that Meta's Unity documentation uses — the OpenXR enum and the
 * WebXR string are two different vocabularies with a translation table between
 * them, and only this side of it ever reaches a browser.
 *
 * @see https://github.com/immersive-web/semantic-labels — `labels.json`
 * @see @iwsdk/core's SceneUnderstandingSystem, which compares against this
 *   literal, and `iwer`'s `XRSemanticLabels.GlobalMesh`.
 */
export const GLOBAL_MESH_LABEL = 'global mesh';

/**
 * Bounded 3D meshes worth turning into colliders, by semantic label.
 *
 * Every string here is from the WebXR registry, which is a **different and
 * shorter** vocabulary than the native Meta one: Space Setup's `STORAGE`
 * arrives as `shelf`, `WALL_FACE` as `wall`, and `CHAIR` as `couch`.
 *
 * Three round-6 corrections after checking the registry and Meta's own
 * native→WebXR mapping table:
 *
 * - **`chair` was dead code, and is gone.** It is not in the WebXR registry at
 *   all; Meta's mapping sends `CHAIR` through as `couch`, and a runtime that
 *   invented its own string would be off-spec in a way this set should not be
 *   quietly accommodating. Every entry here is now a label that can actually
 *   arrive, which is a property worth being able to assert.
 * - **`shelf`, `bed`, `screen`, `plant`, `lamp` and `desk` were missing.** All
 *   six are things Space Setup can hand over as a bounded volume, and all six
 *   are things a paintball ought to stick to. `other` was already catching some
 *   of them, but only the ones Quest failed to classify.
 * - **`wall`, `floor` and `ceiling` are deliberately absent.** Not an
 *   oversight: in a real Space Setup capture those carry a Bounded2D component
 *   and nothing else, so they arrive as `XRPlane` and never appear in
 *   `detectedMeshes` at all. Adding them here would be a comment pretending to
 *   be code. The planes path below is what colliderizes walls.
 *
 * Note that furniture is often **double-represented** — a table shows up as a
 * plane for its top surface *and* a bounded mesh for its volume. Both become
 * static colliders, which is harmless (two static bodies never fight) and
 * slightly better than either alone.
 */
export const COLLIDABLE_MESH_LABELS: ReadonlySet<string> = new Set([
  'table',
  'desk',
  'couch',
  'bed',
  'shelf',
  'screen',
  'lamp',
  'plant',
  'other',
]);

/**
 * Should this XRMesh entity be given a trimesh collider covering the whole
 * room, rather than a convex blob around one object?
 *
 * **This is the round-6 barrier fix, and it does not test the label.** IWSDK's
 * SceneUnderstandingSystem recognises `'global mesh'` itself and then declines
 * to copy it onto the component — the global-mesh branch sets only `_mesh` and
 * `isBounded3D: false`, leaving `semanticLabel` at its empty-string default.
 * So an app that matched on the label would match nothing, forever, silently.
 * `isBounded3D === false` is the flag that actually survives, and the label
 * test below is belt-and-braces for the day IWSDK starts forwarding it.
 *
 * Pure and exported so the rule is unit-tested without a headset.
 */
export function isGlobalMesh(label: string, isBounded3D: boolean): boolean {
  return !isBounded3D || label === GLOBAL_MESH_LABEL;
}

/** Does this bounded mesh's label earn it a collider? @see COLLIDABLE_MESH_LABELS */
export function isCollidableMesh(label: string): boolean {
  return COLLIDABLE_MESH_LABELS.has(label);
}

/**
 * The one-line census logged a few seconds into a session.
 *
 * Every wall-collision report so far has had to be debugged by inference,
 * because the one fact that decides everything — what the headset actually
 * handed over — is invisible from inside the headset. This is that fact, in a
 * form a player can screenshot.
 *
 * Pure and exported so the format is pinned by a test rather than by habit.
 */
export function formatColliderLog(
  planeCount: number,
  meshCount: number,
  labels: readonly string[],
): string {
  const seen = labels.length > 0 ? labels.join(', ') : 'none';
  return `[PaintBlast] room colliders: ${planeCount} planes, ${meshCount} meshes (labels: ${seen})`;
}

const STATIC_BODY_DEFAULTS = {
  state: PhysicsState.Static,
} as const;

const STATIC_SHAPE_DEFAULTS = {
  shape: PhysicsShapeType.Auto,
  dimensions: [0, 0, 0] as [number, number, number],
  density: 0,
  restitution: 0.1,
  friction: 0.8,
} as const;

/** The BoxGeometry parameters IWSDK gives a detected plane's visualisation. */
interface BoxGeometryParams {
  width?: number;
  height?: number;
  depth?: number;
}

/**
 * Bridges detected real-world geometry (XRPlane / XRMesh entities produced
 * by SceneUnderstandingSystem) to the physics engine by attaching static
 * PhysicsBody + PhysicsShape components on qualify and removing them on
 * disqualify.
 *
 * ### What round 6 changed, and why paint kept going through walls
 *
 * Field feedback after five rounds: wall collision is **weak**. Not absent —
 * weak. Paint stuck to walls sometimes. Two separate causes, both found by
 * reading what IWSDK actually builds rather than what it says it builds:
 *
 * 1. **Planes are one millimetre thick.** SceneUnderstandingSystem visualises
 *    every detected plane as `BoxGeometry(width, 0.001, height)`, and
 *    `PhysicsShapeType.Auto` faithfully turns that into a one-millimetre Havok
 *    box. IWSDK steps Havok once per frame with no continuous collision
 *    detection, so a ball at muzzle velocity teleports ~12 cm per step: the
 *    capture band around a 1 mm wall is narrower than one stride and roughly a
 *    third of shots pass straight through. Vertical planes are now given an
 *    explicit Box shape {@link ROOM.wallThicknessMeters} deep instead — the
 *    same reasoning FloorGuardSystem's half-metre slab is built on, applied to
 *    the walls it was never applied to.
 * 2. **The global mesh was excluded.** Quest Space Setup produces one unbounded
 *    XRMesh covering the entire room — floor, walls, furniture, the lot — and
 *    the old label set skipped it, because it has no label to match on
 *    ({@link isGlobalMesh} explains why). It is now a static
 *    {@link PhysicsShapeType.TriMesh}, which is what Meta's own scene guidance
 *    advocates the scene mesh for: "Fast Collisions" and projectiles.
 *
 * `Auto` would have been actively harmful for the global mesh, incidentally,
 * and this is worth stating because `Auto` is the default: it maps a generic
 * BufferGeometry to **ConvexHull**, so the room would have become one solid
 * convex blob with the player, the robots and every ball sealed inside it.
 * TriMesh is not a performance preference here, it is the only correct answer.
 *
 * ### The rules, in short
 *
 * - Every XRPlane becomes a static collider. Vertical ones (walls, doors,
 *   windows) get a thickened box; horizontal ones (floors, ceilings) keep
 *   `Auto`, since FloorGuardSystem already backstops the floor and a thickened
 *   floor would lift every splat off the carpet.
 * - An unbounded XRMesh — the global mesh — becomes a static TriMesh.
 * - A bounded XRMesh becomes a static collider if its label is in
 *   {@link COLLIDABLE_MESH_LABELS}, via `Auto`, which resolves to a convex hull
 *   around that one object. That is the right shape for furniture and cheap.
 *
 * Prerequisites (set in src/main.ts when World.create is called):
 *   xr.features: { planeDetection: true, meshDetection: true, anchors: true }
 *   features:    { sceneUnderstanding: true, physics: true }
 *   sessionMode: SessionMode.ImmersiveAR
 *
 * `meshDetection` is load-bearing for the global mesh specifically:
 * `plane-detection` alone will never surface it.
 */
export class WorldCollisionSystem extends createSystem({
  planes: { required: [XRPlane] },
  meshes: { required: [XRMesh] },
}) {
  /** Labels seen on colliderized meshes, for the diagnostic line. */
  private readonly seenLabels = new Set<string>();
  private planeColliders = 0;
  private meshColliders = 0;

  /** Seconds of immersive session so far, until the census is printed. */
  private elapsedSec = 0;
  private immersive = false;
  private logged = false;

  init() {
    this.cleanupFuncs.push(
      // Same shape as SceneScanSystem's session tracking, and for the same
      // reason: outside an immersive session there is no scene model to count,
      // and a census printed against the 2D preview would say "0 planes" every
      // single time and teach the reader to ignore it.
      this.world.visibilityState.subscribe((state) => {
        const immersive = state !== VisibilityState.NonImmersive;
        if (immersive === this.immersive) return;
        this.immersive = immersive;
        if (!immersive) {
          // SceneUnderstandingSystem destroys every plane and mesh entity on
          // session end, so the next session genuinely is a fresh count and
          // deserves its own line.
          this.elapsedSec = 0;
          this.logged = false;
          this.seenLabels.clear();
          this.planeColliders = 0;
          this.meshColliders = 0;
        }
      }),

      this.queries.planes.subscribe('qualify', (entity) => {
        this.colliderizePlane(entity);
        this.planeColliders++;
      }),
      this.queries.planes.subscribe('disqualify', (entity) => {
        this.stripCollider(entity);
        this.planeColliders = Math.max(0, this.planeColliders - 1);
      }),

      this.queries.meshes.subscribe('qualify', (entity) => {
        if (this.colliderizeMesh(entity)) this.meshColliders++;
      }),
      this.queries.meshes.subscribe('disqualify', (entity) => {
        this.stripCollider(entity);
        this.meshColliders = Math.max(0, this.meshColliders - 1);
      }),
    );
  }

  /**
   * Print the census once the scene model has had a moment to arrive.
   *
   * The only reason this system has an update() at all. It stops counting the
   * instant it has printed, so the steady-state cost is one boolean test.
   */
  update(delta: number) {
    if (this.logged || !this.immersive) return;
    this.elapsedSec += delta;
    if (this.elapsedSec < ROOM.colliderLogDelaySec) return;

    this.logged = true;
    console.log(
      formatColliderLog(
        this.planeColliders,
        this.meshColliders,
        Array.from(this.seenLabels).sort(),
      ),
    );
  }

  /**
   * Give a detected plane a static collider — a thickened box if it is a wall,
   * `Auto` otherwise.
   *
   * The plane's local Y **is** its normal: WebXR defines a plane's polygon in
   * the X-Z plane of its own space, and IWSDK's `BoxGeometry(width, 0.001,
   * height)` puts the thin axis on Y to match. So thickening is a Y-only
   * change, and it grows symmetrically about the real surface — half of
   * {@link ROOM.wallThicknessMeters} bulges into the room, which is the price
   * of the fix and the reason that number is small.
   *
   * Falls back to `Auto` whenever the orientation or the geometry is not what
   * this expects, so a runtime that reports planes differently degrades to
   * round-5 behaviour rather than to no collider at all.
   */
  private colliderizePlane(entity: Entity): void {
    entity.addComponent(PhysicsBody, STATIC_BODY_DEFAULTS);

    const plane = entity.getValue(XRPlane, '_plane') as
      | { orientation?: string }
      | undefined;
    const params = planeBoxParams(entity);

    if (plane?.orientation === 'vertical' && params) {
      entity.addComponent(PhysicsShape, {
        ...STATIC_SHAPE_DEFAULTS,
        shape: PhysicsShapeType.Box,
        // Full extents, not half — Havok's HP_Shape_CreateBox takes total size,
        // the same convention FloorGuardSystem's slab relies on.
        dimensions: [
          params.width ?? 0,
          ROOM.wallThicknessMeters,
          params.height ?? 0,
        ],
      });
      return;
    }

    entity.addComponent(PhysicsShape, STATIC_SHAPE_DEFAULTS);
  }

  /**
   * Give a detected mesh a static collider: one trimesh for the whole room, or
   * a convex hull round a piece of furniture.
   *
   * @returns whether a collider was actually attached, so the census counts
   *   colliders rather than meshes.
   */
  private colliderizeMesh(entity: Entity): boolean {
    const label =
      (entity.getValue(XRMesh, 'semanticLabel') as string | undefined) ?? '';
    const bounded = entity.getValue(XRMesh, 'isBounded3D') === true;

    if (isGlobalMesh(label, bounded)) {
      entity.addComponent(PhysicsBody, STATIC_BODY_DEFAULTS);
      entity.addComponent(PhysicsShape, {
        ...STATIC_SHAPE_DEFAULTS,
        shape: PhysicsShapeType.TriMesh,
        // Meta's scene guidance warns that the scene mesh's normals are
        // unreliable off furniture, so a bouncy wall would bounce in made-up
        // directions. Dead, like a real wall, and grippy so paint that arrives
        // slowly still stops where it landed.
        restitution: 0.05,
        friction: 0.9,
      });
      this.seenLabels.add(GLOBAL_MESH_LABEL);
      return true;
    }

    if (!label || !isCollidableMesh(label)) return false;

    entity.addComponent(PhysicsBody, STATIC_BODY_DEFAULTS);
    entity.addComponent(PhysicsShape, {
      ...STATIC_SHAPE_DEFAULTS,
      restitution: 0.2,
      friction: 0.7,
    });
    this.seenLabels.add(label);
    return true;
  }

  /**
   * Shape first, then body — PhysicsSystem's own teardown order.
   *
   * The `active` check is belt-and-braces rather than a fix for anything
   * observed: a plane most often disqualifies because SceneUnderstandingSystem
   * *destroyed* it, and elics warns on removing a component from a destroyed
   * entity. In practice `destroy()` clears the entity's bitmask before it fires
   * the disqualify callbacks, so the `hasComponent` guards below already cover
   * that case — this just says so out loud and costs one boolean.
   */
  private stripCollider(entity: Entity): void {
    if (!entity.active) return;
    if (entity.hasComponent(PhysicsShape)) {
      entity.removeComponent(PhysicsShape);
    }
    if (entity.hasComponent(PhysicsBody)) {
      entity.removeComponent(PhysicsBody);
    }
  }
}

/**
 * The width and height IWSDK baked into this plane's visualisation mesh.
 *
 * Read off `BoxGeometry.parameters` rather than measured, because that is where
 * the plane's real extent lives — the polygon was reduced to a width and a
 * height when the mesh was built and is not recoverable from the bounding box
 * once a thickness has been applied. Returns undefined for anything that is not
 * a BoxGeometry, which is the signal to leave the shape on `Auto`.
 */
function planeBoxParams(entity: Entity): BoxGeometryParams | undefined {
  const geometry = (
    entity.object3D as { geometry?: { parameters?: BoxGeometryParams } } | null
  )?.geometry;
  const params = geometry?.parameters;
  if (!params || typeof params.width !== 'number') return undefined;
  if (!(params.width > 0) || !(params.height! > 0)) return undefined;
  return params;
}
