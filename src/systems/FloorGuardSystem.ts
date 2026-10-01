import {
  Group,
  PhysicsBody,
  PhysicsShape,
  PhysicsShapeType,
  PhysicsState,
  Types,
  createComponent,
  createSystem,
} from '@iwsdk/core';

import { FLOOR } from '../config';

/**
 * Y coordinate of the guard slab's centre, metres.
 *
 * PhysicsShape's Box `dimensions` are **full** extents centred on the entity's
 * own origin (verified against @iwsdk/core's physics-system: the Box branch
 * passes the dimensions vector straight to `HP_Shape_CreateBox`, whose third
 * argument Havok documents as "total size of the box"). So the top face lands
 * at `centreY + thickness / 2`, and this is the centre that puts it
 * FLOOR.sinkMeters below y = 0.
 *
 * Exported so a test can assert the arithmetic rather than trusting a literal.
 */
export const FLOOR_GUARD_CENTRE_Y = -(
  FLOOR.thicknessMeters / 2 +
  FLOOR.sinkMeters
);

/**
 * Marks the single always-present floor collider.
 *
 * Carries the numbers the system computed so `ecs_find_entities` /
 * `ecs_query_entity` can confirm from the MCP tools that the safety net is
 * actually in the world — which matters precisely because the thing is
 * invisible and has no mesh to find in the scene hierarchy.
 */
export const FloorGuard = createComponent('FloorGuard', {
  /** Side length of the square slab, metres. */
  extent: { type: Types.Float32, default: FLOOR.extentMeters },
  /** Slab thickness, metres. */
  thickness: { type: Types.Float32, default: FLOOR.thicknessMeters },
  /** Y of the slab's centre — top face is this plus half the thickness. */
  centreY: { type: Types.Float32, default: FLOOR_GUARD_CENTRE_Y },
});

/**
 * Guarantees a floor.
 *
 * Everything else in this game that a paintball can hit comes from scene
 * understanding: WorldCollisionSystem turns detected XRPlane and XRMesh
 * entities into static colliders. That is the right model right up until the
 * headset has no scene data — a room that was never scanned, a session where
 * plane detection has not reported yet, or the desktop emulator. Then there are
 * no colliders at all, and round 3's field report follows exactly: balls fly
 * through everything, never splat, and vanish at BALLS.killFloorY with no
 * paint and no sound.
 *
 * So: one invisible static slab, laid down once at startup and never touched
 * again. FLOOR.extentMeters across, FLOOR.thicknessMeters thick, its top face a
 * millimetre under the `local-floor` origin. Balls that miss everything real
 * land on it and paint, exactly as if the room had been scanned.
 *
 * Three implementation notes, all load-bearing:
 *
 * - The entity's object3D is a bare `Group` with no geometry. The Box shape
 *   path never looks at geometry — only at `dimensions` — while body creation
 *   needs nothing from object3D but `.position` and `.quaternion`. An invisible
 *   `Mesh` would work too and would cost a geometry for nothing.
 * - The shape is explicitly `Box`, never `Auto`. `Auto` calls
 *   `detectShapeFromGeometry`, which merges the object's mesh geometries — and
 *   on a group with no meshes that merge throws inside PhysicsSystem.update().
 * - The entity is parented to `world.sceneEntity` and marked persistent.
 *   PhysicsSystem writes Havok's world transform straight onto the object3D's
 *   *local* position, so a physics body under a transformed parent lands in the
 *   wrong place; the scene entity is the identity root the easel's collider
 *   already relies on. Persistent keeps the slab across level changes.
 *
 * Runs at priority 6, right behind WorldCollisionSystem (5), because the two
 * are the same concern: everything a ball can hit. It has no update() — the
 * collider is created once in init() and is then PhysicsSystem's problem.
 */
export class FloorGuardSystem extends createSystem({
  guards: { required: [FloorGuard] },
}) {
  init() {
    // Idempotent: registering the system twice must not stack two slabs.
    if (this.queries.guards.entities.size > 0) return;

    const holder = new Group();
    holder.name = 'FloorGuard';
    holder.position.set(0, FLOOR_GUARD_CENTRE_Y, 0);

    const entity = this.world.createTransformEntity(holder, {
      parent: this.world.sceneEntity,
      persistent: true,
    });

    entity.addComponent(FloorGuard, {
      extent: FLOOR.extentMeters,
      thickness: FLOOR.thicknessMeters,
      centreY: FLOOR_GUARD_CENTRE_Y,
    });
    entity.addComponent(PhysicsBody, { state: PhysicsState.Static });
    entity.addComponent(PhysicsShape, {
      shape: PhysicsShapeType.Box,
      // Full extents, not half — see FLOOR_GUARD_CENTRE_Y.
      dimensions: [
        FLOOR.extentMeters,
        FLOOR.thicknessMeters,
        FLOOR.extentMeters,
      ],
      // Zero density is what WorldCollisionSystem gives its static planes; a
      // static body's mass is ignored either way.
      density: 0,
      restitution: FLOOR.restitution,
      friction: FLOOR.friction,
    });
  }
}
