import { Raycaster, Vector3 } from '@iwsdk/core';
import type { Intersection, Object3D } from '@iwsdk/core';

/**
 * Round 9: "where is the real wall in front of me?" for things that want to
 * land ON the room rather than float in it — the intro's logo splat and the
 * tutorial's first target ring.
 *
 * Casts once against the scene-understanding planes and meshes (Space Setup
 * data; gotcha 10: Guardian is not scene data) and reports the nearest hit's
 * point and a world-space normal turned toward the caster. Spawn-time only:
 * never per frame, so the cost of a recursive raycast is irrelevant.
 */

/** Pure: is a unit normal with vertical component `ny` a wall (not floor / table / ceiling)? */
export function isWallNormal(ny: number, maxTiltDeg: number): boolean {
  if (!Number.isFinite(ny)) return false;
  const limit = Math.sin((Math.max(0, Math.min(90, maxTiltDeg)) * Math.PI) / 180);
  return Math.abs(ny) <= limit;
}

/** Pure: yaw (about +Y) that turns a +Z-facing plane to face along (nx, nz). */
export function yawFacingNormal(nx: number, nz: number): number {
  return Math.atan2(nx, nz);
}

/**
 * Pure: keep something's apparent size when it moves from `baseDist` to
 * `dist` metres away — scale by the distance ratio, clamped to [min, max].
 */
export function apparentScale(
  dist: number,
  baseDist: number,
  min: number,
  max: number,
): number {
  if (!(dist > 0) || !(baseDist > 0)) return 1;
  return Math.min(max, Math.max(min, dist / baseDist));
}

/** Reusable probe; one per system, built in init(). */
export class RoomProbe {
  private readonly ray = new Raycaster();
  private readonly hits: Intersection[] = [];
  private readonly normal = new Vector3();

  /** World point of the last successful cast. */
  readonly point = new Vector3();
  /** World unit normal of the last successful cast, facing the caster. */
  readonly hitNormal = new Vector3();

  /**
   * Nearest surface along `dir` (unit) from `origin` among `objects`, within
   * [minDist, maxDist], whose normal passes `accept` (default: anything).
   * @returns the distance, or Infinity when nothing qualified — then
   *   `point` / `hitNormal` are left untouched.
   */
  cast(
    origin: Vector3,
    dir: Vector3,
    objects: Iterable<Object3D | undefined>,
    minDist: number,
    maxDist: number,
    accept?: (nx: number, ny: number, nz: number) => boolean,
  ): number {
    this.ray.set(origin, dir);
    this.ray.near = Math.max(0, minDist);
    this.ray.far = maxDist;
    let best = Number.POSITIVE_INFINITY;
    for (const object of objects) {
      if (!object) continue;
      object.updateWorldMatrix(true, true);
      this.hits.length = 0;
      this.ray.intersectObject(object, true, this.hits);
      for (const hit of this.hits) {
        if (hit.distance >= best) break;
        const face = hit.face;
        if (face) {
          this.normal.copy(face.normal).transformDirection(hit.object.matrixWorld);
        } else {
          this.normal.copy(dir).multiplyScalar(-1);
        }
        // Face the caster whichever way the mesh winds.
        if (this.normal.dot(dir) > 0) this.normal.multiplyScalar(-1);
        if (accept && !accept(this.normal.x, this.normal.y, this.normal.z)) continue;
        best = hit.distance;
        this.point.copy(hit.point);
        this.hitNormal.copy(this.normal);
        break;
      }
    }
    this.hits.length = 0;
    return best;
  }
}
