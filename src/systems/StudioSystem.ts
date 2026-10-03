import {
  AssetManager,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PhysicsBody,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
  XRMesh,
  XRPlane,
  createSystem,
} from '@iwsdk/core';
import type { Entity, Object3D, Texture } from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import { BALLS, STUDIO } from '../config';
import { RoomProbe, isWallNormal } from '../room-probe';
import {
  CoverageGrid,
  StreakTracker,
  arcSpawnPoint,
  coneDirection,
  coverageScore,
  floorHitDistance,
  percent,
  resolveCanvasPlacement,
  sampleMaskToGrid,
  spacedFrom,
  starsFor,
  stencilLine,
  targetsLine,
} from '../studio';
import type { CanvasPlacement } from '../studio';
import {
  CANVAS_SHAPE_LABELS,
  CanvasMount,
  CanvasShape,
  GameEvent,
  GameEventBuffer,
  GamePhase,
  StudioActivity,
  easeOutBack,
  nextCanvasShape,
} from '../types';
import { Ball, BallFlightState } from './BallSpawnSystem';
import { EaselSystem } from './EaselSystem';
import { SplatterSystem } from './SplatterSystem';
import { segmentPointDistSq } from './TargetSystem';

const DEG_TO_RAD = Math.PI / 180;
/** Longest stretch a ball's swept hit test covers in one frame (frame spikes). */
const MAX_SWEEP_METRES = 0.6;

/** Target slot lifecycle. */
const SlotState = { Off: 0, Waiting: 1, Live: 2, Popping: 3 } as const;
/** Target kinds. */
const TargetKind = { Bullseye: 0, Balloon: 1 } as const;

/** One stencil's baked data, built once when its mask first loads. */
interface StencilData {
  /** Mask with luminance baked into alpha (white), STUDIO.guidePx square. */
  alpha: HTMLCanvasElement;
  /** Inside/outside grid, STUDIO.coverageGrid square. */
  inside: Uint8Array;
}

/**
 * Round 10: the STUDIO - Chill mode's three activities.
 *
 * - **CANVAS**: EaselSystem's painting surface, now framed in generated
 *   gallery art and hung on the nearest real wall (a RoomProbe cast against
 *   the scene planes/meshes in a fan of yaws; floats at a seated distance
 *   without scene data) or stood on the round-2 easel. SHAPE cycles
 *   landscape / portrait / round.
 * - **STENCIL**: a square board with a silhouette guide. Every stamp the easel
 *   lays is reported back through `EaselSystem.onStamp` and rasterised into a
 *   128 x 128 CPU coverage grid masked by the stencil (sampled once at load),
 *   so the meter and the 1-3 stars cost a few hundred cell writes per hit and
 *   never read the GPU back.
 * - **TARGETS**: a pooled range of bullseyes and paint balloons in the seated
 *   forward arc. Balls are hit-tested swept (TargetSystem's
 *   segmentPointDistSq) - targets have no colliders, so a miss flies on and
 *   paints the room. A pop emits TargetPopped (sound, rumble, confetti for
 *   free) plus StudioTargetPopped, and throws splats of the target's colour
 *   onto the walls behind it. Any BallImpact in the range breaks the streak.
 *
 * Runs at priority 17: after BallFlightSystem (12) has emitted the frame's
 * impacts and EaselSystem (16) has stamped them (and fed coverage), before
 * EventFlushSystem (90). Everything heavy runs at event rate; the per-frame
 * target loop touches only preallocated typed arrays and scratch vectors.
 */
export class StudioSystem extends createSystem({
  planes: { required: [XRPlane] },
  meshes: { required: [XRMesh] },
  balls: { required: [Ball] },
}) {
  private gamePhase!: Signal<GamePhase>;
  private paused!: Signal<boolean>;
  private events!: GameEventBuffer;
  private studioActivity!: Signal<number>;
  private studioLine!: Signal<string>;
  private studioMeter!: Signal<number>;
  private studioStars!: Signal<number>;

  private activity: StudioActivity = STUDIO.defaultActivity as StudioActivity;
  private canvasShape: CanvasShape = CanvasShape.Landscape;
  private mount: CanvasMount = CanvasMount.Wall;
  private onWall = false;
  private stencilIndex = 0;
  private hard = false;
  private active = false;
  private stencilStamped = false;
  private stars = 0;

  private probe!: RoomProbe;
  private readonly probeObjects: Array<Object3D | undefined> = [];
  private placement!: CanvasPlacement;
  private headPos!: Vector3;
  private headFx = 0;
  private headFz = -1;
  private origin!: Vector3;
  private dir!: Vector3;
  private ballPos!: Vector3;
  private coneOut!: Float32Array;
  private spawnOut!: Float32Array;
  private splatPos: [number, number, number] = [0, 0, 0];
  private splatNormal: [number, number, number] = [0, 1, 0];
  private splatColor: [number, number, number] = [1, 1, 1];

  // Stencils.
  private grid!: CoverageGrid;
  private readonly stencils: Array<StencilData | undefined> = [];
  private readonly stencilLoading = new Set<number>();

  // Target range: fixed pool, struct-of-arrays.
  private readonly targets: Entity[] = [];
  private bullseyeMeshes: Mesh[] = [];
  private balloonMeshes: Mesh[] = [];
  private balloonMaterials: MeshBasicMaterial[] = [];
  private bullseyeMaterial?: MeshBasicMaterial;
  private slotState!: Int8Array;
  private slotKind!: Int8Array;
  private slotColor!: Int8Array;
  private slotLive!: Uint8Array;
  private slotBase!: Float32Array;
  private slotPos!: Float32Array;
  private slotTangent!: Float32Array;
  private slotAge!: Float32Array;
  private slotPhase!: Float32Array;
  private slotRespawnAt!: Float32Array;
  private rangeClock = 0;
  private rangeYaw = 0;
  private rangeHead!: Vector3;
  private colorCursor = 0;
  private readonly streak = new StreakTracker();
  private texturesRequested = false;

  init() {
    this.gamePhase = this.globals.gamePhase as Signal<GamePhase>;
    this.paused = this.globals.paused as Signal<boolean>;
    this.events = this.globals.gameEvents as GameEventBuffer;
    this.studioActivity = this.globals.studioActivity as Signal<number>;
    this.studioLine = this.globals.studioLine as Signal<string>;
    this.studioMeter = this.globals.studioMeter as Signal<number>;
    this.studioStars = this.globals.studioStars as Signal<number>;

    this.probe = new RoomProbe();
    this.placement = { onWall: false, x: 0, y: 0, z: 0, yaw: 0, scale: 1 };
    this.headPos = new Vector3();
    this.origin = new Vector3();
    this.dir = new Vector3();
    this.ballPos = new Vector3();
    this.rangeHead = new Vector3();
    this.coneOut = new Float32Array(3);
    this.spawnOut = new Float32Array(3);
    this.grid = new CoverageGrid(STUDIO.coverageGrid);

    const n = STUDIO.targetCount;
    this.slotState = new Int8Array(n);
    this.slotKind = new Int8Array(n);
    this.slotColor = new Int8Array(n);
    this.slotLive = new Uint8Array(n);
    this.slotBase = new Float32Array(n * 3);
    this.slotPos = new Float32Array(n * 3);
    this.slotTangent = new Float32Array(n * 2);
    this.slotAge = new Float32Array(n);
    this.slotPhase = new Float32Array(n);
    this.slotRespawnAt = new Float32Array(n);

    const easel = this.world.getSystem(EaselSystem);
    if (easel) {
      easel.managed = true;
      easel.onStamp = (u, v, size) => this.onStamp(u, v, size);
    }

    this.cleanupFuncs.push(
      this.gamePhase.subscribe((phase) => {
        if (phase === GamePhase.Chill) this.enter();
        else this.leave();
      }),
      () => {
        const e = this.world.getSystem(EaselSystem);
        if (e) e.onStamp = undefined;
      },
    );
  }

  update(delta: number) {
    if (!this.active || this.activity !== StudioActivity.Targets) return;
    if (this.paused.peek()) return;
    this.rangeClock += delta;
    this.scanMisses();
    this.stepTargets(delta);
    this.testHits(delta);
  }

  // ---- Public API (HudSystem buttons, harness) -------------------------------

  /** The activity showing (or that will show on the next Chill entry). */
  get currentActivity(): StudioActivity {
    return this.activity;
  }

  /** Switch activity. A no-op outside Chill except for remembering it. */
  selectActivity(activity: StudioActivity): void {
    if (this.active && activity === this.activity) {
      // Re-pressing the lit tab re-hangs the canvas / re-arcs the range in
      // front of wherever you face now.
      this.applyActivity(activity);
      return;
    }
    this.activity = activity;
    this.studioActivity.value = activity;
    if (this.active) this.applyActivity(activity);
  }

  /** Canvas: next SHAPE. Stencil: NEXT stencil. Targets: HARD on/off. */
  primaryAction(): void {
    if (!this.active) return;
    switch (this.activity) {
      case StudioActivity.Canvas: {
        this.canvasShape = nextCanvasShape(this.canvasShape);
        this.easel()?.setShape(this.canvasShape);
        this.refreshLine();
        break;
      }
      case StudioActivity.Stencil:
        this.stencilIndex = (this.stencilIndex + 1) % STUDIO.stencils.length;
        this.easel()?.newCanvas();
        this.showStencil();
        break;
      default:
        this.hard = !this.hard;
        this.refreshLine();
        break;
    }
  }

  /** Canvas / Stencil: move between the wall and the easel (re-hangs either way). */
  secondaryAction(): void {
    if (!this.active || this.activity === StudioActivity.Targets) return;
    this.mount = this.mount === CanvasMount.Wall ? CanvasMount.Easel : CanvasMount.Wall;
    this.placeCanvas();
    this.refreshLine();
  }

  /** SAVE: the painting as a PNG (a stencil saves lifted: outside knocked out). */
  save(): void {
    const easel = this.easel();
    if (!this.active || !easel || this.activity === StudioActivity.Targets) return;
    let index: number;
    if (this.activity === StudioActivity.Stencil) {
      const stencil = this.stencils[this.stencilIndex];
      index = easel.savePainting(
        stencil?.alpha ?? null,
        `stencil-${STUDIO.stencils[this.stencilIndex].id}`,
      );
    } else {
      index = easel.savePainting(null, 'painting');
    }
    this.events.emit(GameEvent.StudioArtSaved, 0, 0, 0, index);
    this.studioLine.value = STUDIO.lines.saved;
  }

  /** CLEAR: a blank canvas (and a fresh stencil score). Room splats stay. */
  clear(): void {
    if (!this.active || this.activity === StudioActivity.Targets) return;
    this.easel()?.newCanvas();
    if (this.activity === StudioActivity.Stencil) {
      this.grid.reset();
      this.stencilStamped = false;
      this.stars = 0;
      this.publishScore();
    }
    this.refreshLine();
  }

  /** Label for the activity's first action button. ASCII. */
  get primaryLabel(): string {
    switch (this.activity) {
      case StudioActivity.Canvas:
        return 'SHAPE';
      case StudioActivity.Stencil:
        return 'NEXT';
      default:
        return this.hard ? 'HARD: ON' : 'HARD: OFF';
    }
  }

  /** Label for the mount button (where it would move the canvas). ASCII. */
  get secondaryLabel(): string {
    return this.mount === CanvasMount.Wall ? 'TO EASEL' : 'TO WALL';
  }

  /** Harness / tests: the live coverage numbers. */
  get debugCoverage(): { fill: number; spill: number; stars: number } {
    return { fill: this.grid.fill, spill: this.grid.spill, stars: this.stars };
  }

  /** Harness: the streak tracker. */
  get debugStreak(): StreakTracker {
    return this.streak;
  }

  // ---- Lifecycle ---------------------------------------------------------------

  private enter(): void {
    this.active = true;
    this.requestTextures();
    this.studioActivity.value = this.activity;
    this.applyActivity(this.activity);
  }

  private leave(): void {
    if (!this.active) return;
    this.active = false;
    this.hideTargets();
    // EaselSystem hides the canvas itself on any phase but Chill.
  }

  private applyActivity(activity: StudioActivity): void {
    const easel = this.easel();
    this.studioMeter.value = -1;
    this.studioStars.value = 0;

    if (activity === StudioActivity.Targets) {
      easel?.hide();
      this.startTargets();
    } else {
      this.hideTargets();
      if (easel) {
        const shape = activity === StudioActivity.Stencil ? CanvasShape.Square : this.canvasShape;
        if (easel.currentShape !== shape) easel.setShape(shape);
        if (activity !== StudioActivity.Stencil) easel.setStencilGuide(null);
        // A stencil always starts on a clean board (its score starts at 0).
        else easel.newCanvas();
        this.placeCanvas();
        easel.show();
      }
      if (activity === StudioActivity.Stencil) this.showStencil();
    }

    this.events.emit(GameEvent.StudioActivityChanged, 0, 0, 0, activity);
    this.refreshLine();
  }

  private easel(): EaselSystem | undefined {
    return this.world.getSystem(EaselSystem);
  }

  /** Start streaming every Studio texture on the first entry (also in the manifest). */
  private requestTextures(): void {
    if (this.texturesRequested) return;
    this.texturesRequested = true;
    for (const [url, key] of [
      [STUDIO.bullseyeUrl, STUDIO.bullseyeKey],
      [STUDIO.balloonUrl, STUDIO.balloonKey],
    ] as const) {
      if (this.texture(key)) continue;
      try {
        AssetManager.loadTexture(url, key)
          .then(() => this.applyTargetTextures())
          .catch(() => undefined);
      } catch {
        // AssetManager unavailable: targets render untextured.
      }
    }
  }

  private texture(key: string): Texture | null {
    try {
      return (AssetManager.getTexture(key) as Texture | null) ?? null;
    } catch {
      return null;
    }
  }

  // ---- Canvas placement ----------------------------------------------------------

  /** Read the head's world position and flattened forward into scratch. */
  private readHead(): void {
    const head = this.player?.head;
    if (!head) {
      this.headPos.set(0, 1.2, 0);
      this.headFx = 0;
      this.headFz = -1;
      return;
    }
    head.updateWorldMatrix(true, false);
    const m = head.matrixWorld.elements;
    this.headPos.set(m[12], m[13], m[14]);
    const len = Math.hypot(m[8], m[10]);
    if (len > 1e-3) {
      this.headFx = -m[8] / len;
      this.headFz = -m[10] / len;
    } else {
      this.headFx = 0;
      this.headFz = -1;
    }
  }

  private gatherSceneObjects(): number {
    this.probeObjects.length = 0;
    for (const e of this.queries.planes.entities) this.probeObjects.push(e.object3D);
    for (const e of this.queries.meshes.entities) this.probeObjects.push(e.object3D);
    return this.probeObjects.length;
  }

  /** Hang the canvas per the current mount: nearest wall (or float), or the easel. */
  private placeCanvas(): void {
    const easel = this.easel();
    if (!easel) return;
    if (this.mount === CanvasMount.Easel) {
      easel.placeOnEasel();
      this.onWall = false;
      return;
    }

    this.readHead();
    const p = this.placement;
    const eyeY = this.headPos.y;
    let best = Number.POSITIVE_INFINITY;
    let px = 0;
    let pz = 0;
    let nx = 0;
    let nz = 1;
    if (this.gatherSceneObjects() > 0) {
      this.origin.set(this.headPos.x, Math.max(0.5, eyeY - STUDIO.canvasBelowEyes), this.headPos.z);
      const baseYaw = Math.atan2(-this.headFx, -this.headFz);
      for (const offset of STUDIO.wallProbeYawsDeg) {
        const yaw = baseYaw + offset * DEG_TO_RAD;
        this.dir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
        const dist = this.probe.cast(
          this.origin,
          this.dir,
          this.probeObjects,
          STUDIO.wallMinDist,
          STUDIO.wallMaxDist,
          (_x, ny) => isWallNormal(ny, STUDIO.wallMaxTiltDeg),
        );
        if (dist < best) {
          best = dist;
          px = this.probe.point.x;
          pz = this.probe.point.z;
          nx = this.probe.hitNormal.x;
          nz = this.probe.hitNormal.z;
        }
      }
    }

    resolveCanvasPlacement(
      this.headPos.x,
      this.headPos.y,
      this.headPos.z,
      this.headFx,
      this.headFz,
      best,
      px,
      pz,
      nx,
      nz,
      STUDIO.wallStandoff,
      STUDIO,
      p,
    );
    this.onWall = p.onWall;
    easel.placeAt(p.x, p.y, p.z, p.yaw, p.scale);
  }

  // ---- Status line -----------------------------------------------------------------

  private refreshLine(): void {
    switch (this.activity) {
      case StudioActivity.Canvas: {
        const where =
          this.mount === CanvasMount.Easel
            ? STUDIO.lines.canvasEasel
            : this.onWall
              ? STUDIO.lines.canvasWall
              : STUDIO.lines.canvasFloat;
        this.studioLine.value = `${CANVAS_SHAPE_LABELS[this.canvasShape]} - ${where}`;
        break;
      }
      case StudioActivity.Stencil: {
        const label = STUDIO.stencils[this.stencilIndex].label;
        this.studioLine.value = this.stencilStamped
          ? stencilLine(label, this.grid.fill, this.grid.spill)
          : `${label} - ${STUDIO.lines.stencil}`;
        break;
      }
      default:
        this.studioLine.value =
          this.streak.pops > 0
            ? targetsLine(this.streak.current, this.streak.best, this.streak.pops, this.hard)
            : this.hard
              ? `${STUDIO.lines.targets} HARD`
              : STUDIO.lines.targets;
        break;
    }
  }

  // ---- Stencil ------------------------------------------------------------------------

  /** Put the current stencil on the board (loading it the first time). */
  private showStencil(): void {
    this.grid.reset();
    this.stencilStamped = false;
    this.stars = 0;
    this.studioStars.value = 0;
    const index = this.stencilIndex;
    const data = this.stencils[index];
    if (data) {
      this.grid.inside.set(data.inside);
      this.grid.setMask();
      this.easel()?.setStencilGuide(data.alpha);
      this.publishScore();
    } else {
      this.easel()?.setStencilGuide(null);
      this.studioMeter.value = 0;
      this.loadStencil(index);
    }
    this.refreshLine();
  }

  /**
   * Load a stencil mask with a plain Image (as EaselSystem's stamp masks are):
   * we need its pixels, not a GPU texture. Sampled into the coverage grid and
   * baked into an alpha silhouette exactly once.
   */
  private loadStencil(index: number): void {
    if (this.stencilLoading.has(index)) return;
    this.stencilLoading.add(index);
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      try {
        const size = STUDIO.guidePx;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(image, 0, 0, size, size);
        const pixels = ctx.getImageData(0, 0, size, size);
        const n = STUDIO.coverageGrid;
        const inside = new Uint8Array(n * n);
        sampleMaskToGrid(pixels.data, size, size, n, STUDIO.maskThreshold, inside);
        const d = pixels.data;
        for (let i = 0; i < d.length; i += 4) {
          const coverage = d[i];
          d[i] = 255;
          d[i + 1] = 255;
          d[i + 2] = 255;
          d[i + 3] = coverage;
        }
        ctx.putImageData(pixels, 0, 0);
        this.stencils[index] = { alpha: canvas, inside };
        if (this.active && this.activity === StudioActivity.Stencil && this.stencilIndex === index) {
          this.showStencil();
        }
      } catch {
        // Tainted / failed: the stencil stays unavailable; free painting still works.
      } finally {
        this.stencilLoading.delete(index);
      }
    };
    image.onerror = () => this.stencilLoading.delete(index);
    image.src = STUDIO.stencils[index].url;
  }

  /** EaselSystem laid a stamp: score it if a stencil is up. */
  private onStamp(u: number, v: number, sizeFrac: number): void {
    if (!this.active || this.activity !== StudioActivity.Stencil) return;
    if (!this.stencils[this.stencilIndex]) return;
    this.grid.stamp(u, v, sizeFrac * STUDIO.stampCoverRadius);
    this.stencilStamped = true;
    this.publishScore();
    this.refreshLine();
  }

  private publishScore(): void {
    const score = coverageScore(this.grid.fill, this.grid.spill, STUDIO.spillPenalty);
    const stars = starsFor(score, STUDIO.starThresholds);
    this.studioMeter.value = percent(score);
    if (stars > this.stars) {
      this.events.emit(GameEvent.StudioStencilScored, 0, 0, 0, stars);
    }
    this.stars = stars;
    this.studioStars.value = stars;
  }

  // ---- Target range -------------------------------------------------------------------

  private buildTargets(): void {
    if (this.targets.length > 0) return;
    const bullseyeGeo = new PlaneGeometry(STUDIO.bullseyeRadius * 2, STUDIO.bullseyeRadius * 2);
    // The balloon art is 384 x 510: keep its aspect.
    const balloonH = STUDIO.balloonRadius * 2;
    const balloonGeo = new PlaneGeometry(balloonH * (384 / 510), balloonH);
    this.bullseyeMaterial = new MeshBasicMaterial({
      transparent: true,
      alphaTest: 0.25,
      side: DoubleSide,
    });
    for (let i = 0; i < STUDIO.targetCount; i++) {
      const group = new Group();
      group.name = `StudioTarget${i}`;
      group.visible = false;
      const bull = new Mesh(bullseyeGeo, this.bullseyeMaterial);
      const balloonMat = new MeshBasicMaterial({
        transparent: true,
        alphaTest: 0.25,
        side: DoubleSide,
      });
      const balloon = new Mesh(balloonGeo, balloonMat);
      group.add(bull, balloon);
      this.bullseyeMeshes.push(bull);
      this.balloonMeshes.push(balloon);
      this.balloonMaterials.push(balloonMat);
      const entity = this.world.createTransformEntity(group, {
        parent: this.world.sceneEntity,
        persistent: true,
      });
      this.targets.push(entity);
    }
    this.applyTargetTextures();
  }

  private applyTargetTextures(): void {
    const bull = this.texture(STUDIO.bullseyeKey);
    if (bull && this.bullseyeMaterial && this.bullseyeMaterial.map !== bull) {
      bull.colorSpace = SRGBColorSpace;
      this.bullseyeMaterial.map = bull;
      this.bullseyeMaterial.needsUpdate = true;
    }
    const balloon = this.texture(STUDIO.balloonKey);
    if (balloon) {
      balloon.colorSpace = SRGBColorSpace;
      for (const m of this.balloonMaterials) {
        if (m.map === balloon) continue;
        m.map = balloon;
        m.needsUpdate = true;
      }
    }
  }

  private startTargets(): void {
    this.buildTargets();
    this.applyTargetTextures();
    this.readHead();
    this.rangeHead.copy(this.headPos);
    this.rangeYaw = Math.atan2(-this.headFx, -this.headFz);
    this.rangeClock = 0;
    this.streak.current = 0;
    for (let i = 0; i < this.targets.length; i++) {
      this.slotState[i] = SlotState.Waiting;
      this.slotLive[i] = 0;
      this.slotRespawnAt[i] = 0.15 + i * 0.3;
      const object3D = this.targets[i].object3D;
      if (object3D) object3D.visible = false;
    }
  }

  private hideTargets(): void {
    for (let i = 0; i < this.targets.length; i++) {
      this.slotState[i] = SlotState.Off;
      this.slotLive[i] = 0;
      const object3D = this.targets[i].object3D;
      if (object3D) object3D.visible = false;
    }
  }

  private spawnTarget(slot: number): void {
    const out = this.spawnOut;
    const head = this.rangeHead;
    let placed = false;
    for (let attempt = 0; attempt < 10 && !placed; attempt++) {
      arcSpawnPoint(
        head.x,
        head.y,
        head.z,
        this.rangeYaw,
        Math.random(),
        Math.random(),
        Math.random(),
        STUDIO,
        out,
      );
      placed = spacedFrom(out[0], out[1], out[2], this.slotPos, this.slotLive, STUDIO.minSpacing);
    }
    const b = slot * 3;
    this.slotBase[b] = out[0];
    this.slotBase[b + 1] = out[1];
    this.slotBase[b + 2] = out[2];
    this.slotPos[b] = out[0];
    this.slotPos[b + 1] = out[1];
    this.slotPos[b + 2] = out[2];
    // Drift runs across your view: perpendicular to head -> target.
    const dx = out[0] - head.x;
    const dz = out[2] - head.z;
    const len = Math.hypot(dx, dz) || 1;
    this.slotTangent[slot * 2] = -dz / len;
    this.slotTangent[slot * 2 + 1] = dx / len;
    this.slotKind[slot] = Math.random() < STUDIO.balloonShare ? TargetKind.Balloon : TargetKind.Bullseye;
    this.slotColor[slot] = this.colorCursor;
    this.colorCursor = (this.colorCursor + 1) % STUDIO.popColors.length;
    this.slotAge[slot] = 0;
    this.slotPhase[slot] = Math.random() * Math.PI * 2;
    this.slotState[slot] = SlotState.Live;
    this.slotLive[slot] = 1;

    const balloon = this.slotKind[slot] === TargetKind.Balloon;
    this.bullseyeMeshes[slot].visible = !balloon;
    this.balloonMeshes[slot].visible = balloon;
    if (balloon) {
      const c = STUDIO.popColors[this.slotColor[slot]];
      this.balloonMaterials[slot].color.setRGB(c[0], c[1], c[2], SRGBColorSpace);
    }
    const object3D = this.targets[slot].object3D;
    if (object3D) {
      object3D.visible = true;
      object3D.scale.setScalar(0.001);
    }
  }

  private stepTargets(delta: number): void {
    const head = this.rangeHead;
    for (let slot = 0; slot < this.targets.length; slot++) {
      const state = this.slotState[slot];
      const object3D = this.targets[slot].object3D;
      if (state === SlotState.Waiting) {
        if (this.rangeClock >= this.slotRespawnAt[slot]) this.spawnTarget(slot);
        continue;
      }
      if (!object3D || state === SlotState.Off) continue;
      this.slotAge[slot] += delta;
      const age = this.slotAge[slot];
      const b = slot * 3;

      if (state === SlotState.Popping) {
        const k = Math.min(1, age / STUDIO.popSec);
        object3D.scale.setScalar((1 + 0.7 * k) * (1 - k * k * k) + 0.001);
        if (k >= 1) {
          object3D.visible = false;
          this.slotState[slot] = SlotState.Waiting;
          this.slotRespawnAt[slot] = this.rangeClock + STUDIO.respawnSec;
        }
        continue;
      }

      // Live: appear, bob, (HARD) drift; face the player.
      const appear = Math.min(1, age / STUDIO.appearSec);
      object3D.scale.setScalar(Math.max(0.001, easeOutBack(appear)));
      const phase = this.slotPhase[slot];
      const bob = Math.sin(age * STUDIO.bobHz * Math.PI * 2 + phase) * STUDIO.bobAmp;
      const drift = this.hard
        ? Math.sin(age * STUDIO.hardDriftHz * Math.PI * 2 + phase) * STUDIO.hardDriftMeters
        : 0;
      const x = this.slotBase[b] + this.slotTangent[slot * 2] * drift;
      const y = this.slotBase[b + 1] + bob;
      const z = this.slotBase[b + 2] + this.slotTangent[slot * 2 + 1] * drift;
      this.slotPos[b] = x;
      this.slotPos[b + 1] = y;
      this.slotPos[b + 2] = z;
      object3D.position.set(x, y, z);
      const facing = Math.atan2(head.x - x, head.z - z);
      const balloon = this.slotKind[slot] === TargetKind.Balloon;
      const spin = this.hard && !balloon ? age * STUDIO.hardSpinDegPerSec * DEG_TO_RAD : 0;
      object3D.rotation.set(0, facing + spin, balloon ? Math.sin(age * 1.3 + phase) * 0.12 : 0);
    }
  }

  /** Any paint that landed on the room this frame broke the streak. */
  private scanMisses(): void {
    const events = this.events;
    for (let i = 0; i < events.count; i++) {
      if (events.typeAt(i) === GameEvent.BallImpact) {
        if (this.streak.current > 0) {
          this.streak.miss();
          this.refreshLine();
        }
        return;
      }
    }
  }

  private testHits(delta: number): void {
    let any = false;
    for (let slot = 0; slot < this.targets.length; slot++) {
      if (this.slotState[slot] === SlotState.Live && this.slotAge[slot] > STUDIO.appearSec * 0.4) {
        any = true;
        break;
      }
    }
    if (!any) return;

    for (const ball of this.queries.balls.entities) {
      if (ball.getValue(Ball, 'flightState') !== BallFlightState.Flying) continue;
      const object3D = ball.object3D;
      if (!object3D) continue;
      object3D.getWorldPosition(this.ballPos);
      const radius = ball.getValue(Ball, 'radius') ?? BALLS.radius;
      let tx = this.ballPos.x;
      let ty = this.ballPos.y;
      let tz = this.ballPos.z;
      if (ball.hasComponent(PhysicsBody) && delta > 0) {
        const v = ball.getVectorView(PhysicsBody, '_linearVelocity');
        const speed = Math.hypot(v[0], v[1], v[2]);
        let back = delta;
        if (speed * back > MAX_SWEEP_METRES) back = MAX_SWEEP_METRES / speed;
        tx -= v[0] * back;
        ty -= v[1] * back;
        tz -= v[2] * back;
      }
      for (let slot = 0; slot < this.targets.length; slot++) {
        if (this.slotState[slot] !== SlotState.Live) continue;
        if (this.slotAge[slot] <= STUDIO.appearSec * 0.4) continue;
        const b = slot * 3;
        const reach =
          (this.slotKind[slot] === TargetKind.Balloon ? STUDIO.balloonRadius : STUDIO.bullseyeRadius) +
          radius +
          STUDIO.hitSlop;
        const d2 = segmentPointDistSq(
          tx,
          ty,
          tz,
          this.ballPos.x,
          this.ballPos.y,
          this.ballPos.z,
          this.slotPos[b],
          this.slotPos[b + 1],
          this.slotPos[b + 2],
        );
        if (d2 > reach * reach) continue;
        // destroy(), never dispose(): balls share geometry/materials (gotcha 4).
        ball.destroy();
        this.pop(slot);
        break;
      }
    }
  }

  private pop(slot: number): void {
    const b = slot * 3;
    const x = this.slotPos[b];
    const y = this.slotPos[b + 1];
    const z = this.slotPos[b + 2];
    this.slotState[slot] = SlotState.Popping;
    this.slotLive[slot] = 0;
    this.slotAge[slot] = 0;
    const streak = this.streak.hit();
    // The ordinary pop event carries the sound, rumble and confetti; scoring
    // and the tutorial ignore it outside Playing.
    this.events.emit(GameEvent.TargetPopped, x, y, z, 0);
    this.events.emit(GameEvent.StudioTargetPopped, x, y, z, streak);
    this.splashRoom(slot, x, y, z);
    this.refreshLine();
  }

  /**
   * Throw the popped target's colour onto the room: rays from the target,
   * away from the player in a cone, against the scene planes/meshes; misses
   * that point down land on the floor. Event-rate (one pop), so the
   * raycaster's own hit allocations are fine here.
   */
  private splashRoom(slot: number, x: number, y: number, z: number): void {
    const splatter = this.world.getSystem(SplatterSystem);
    if (!splatter) return;
    const c = STUDIO.popColors[this.slotColor[slot]];
    this.splatColor[0] = c[0];
    this.splatColor[1] = c[1];
    this.splatColor[2] = c[2];
    const head = this.rangeHead;
    let ax = x - head.x;
    let ay = y - head.y;
    let az = z - head.z;
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al;
    ay /= al;
    az /= al;
    const sceneCount = this.gatherSceneObjects();
    this.origin.set(x, y, z);
    for (let k = 0; k < STUDIO.popSplats; k++) {
      // Every other ray aims down-range and low, so some always reach the floor.
      let bx = ax;
      let by = k % 2 === 1 ? ay - 0.9 : ay;
      let bz = az;
      const bl = Math.hypot(bx, by, bz) || 1;
      bx /= bl;
      by /= bl;
      bz /= bl;
      coneDirection(bx, by, bz, STUDIO.popSplatConeDeg, Math.random(), Math.random(), this.coneOut);
      this.dir.set(this.coneOut[0], this.coneOut[1], this.coneOut[2]).normalize();
      let dist = Number.POSITIVE_INFINITY;
      if (sceneCount > 0) {
        dist = this.probe.cast(this.origin, this.dir, this.probeObjects, 0.05, STUDIO.popSplatRange);
      }
      if (Number.isFinite(dist)) {
        this.splatPos[0] = this.probe.point.x;
        this.splatPos[1] = this.probe.point.y;
        this.splatPos[2] = this.probe.point.z;
        this.splatNormal[0] = this.probe.hitNormal.x;
        this.splatNormal[1] = this.probe.hitNormal.y;
        this.splatNormal[2] = this.probe.hitNormal.z;
      } else {
        const t = floorHitDistance(y, this.dir.y, STUDIO.popSplatRange);
        if (!Number.isFinite(t)) continue;
        this.splatPos[0] = x + this.dir.x * t;
        this.splatPos[1] = 0;
        this.splatPos[2] = z + this.dir.z * t;
        this.splatNormal[0] = 0;
        this.splatNormal[1] = 1;
        this.splatNormal[2] = 0;
      }
      splatter.addSplat(this.splatPos, this.splatNormal, this.splatColor, STUDIO.popSplatSize);
    }
  }
}
