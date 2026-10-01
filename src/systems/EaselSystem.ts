import {
  AssetManager,
  Box3,
  BoxGeometry,
  CanvasTexture,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PhysicsBody,
  PhysicsShape,
  PhysicsShapeType,
  PhysicsState,
  Quaternion,
  SRGBColorSpace,
  TwoHandsGrabbable,
  Types,
  Vector3,
  createComponent,
  createSystem,
} from '@iwsdk/core';
import type { Entity, Object3D } from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import { EASEL } from '../config';
import {
  BallStyle,
  GameEvent,
  GameEventBuffer,
  GamePhase,
  unpackImpactRgb,
  unpackImpactStyle,
} from '../types';

const DEG_TO_RAD = Math.PI / 180;

/** Rotation axes. Read-only inputs to setFromAxisAngle. */
const UP = new Vector3(0, 1, 0);
const RIGHT = new Vector3(1, 0, 0);

/** Object3D name of the paintable board, so ROTATE CANVAS can find and swap it. */
const BOARD_MESH_NAME = 'EaselCanvas';

/**
 * AssetManifest key for the modelled easel used as the frame. The stand is
 * decorative only — the paintable board is always built here, so the painting
 * keeps working whatever the art is (and the system falls back to primitive
 * legs when the GLTF is missing or has not streamed in yet).
 *
 * The model must be an EMPTY easel. Round 2 shipped one generated from a photo
 * of an easel *holding* a canvas, which baked a second, unpaintable canvas into
 * the stand right behind the real one — the "second easel that doesn't work".
 * Swapping the file at this path fixes that with no code change.
 */
export const EASEL_ASSET_KEY = 'easel';

/** Canvas board dimensions for one orientation. @see orientationDims */
export interface EaselDims {
  /** Board width, metres. */
  boardWidth: number;
  /** Board height, metres. */
  boardHeight: number;
  /** Painting resolution across, pixels. */
  canvasPxW: number;
  /** Painting resolution down, pixels. */
  canvasPxH: number;
}

/** The slice of EASEL that {@link orientationDims} reads. */
export interface EaselOrientationConfig {
  readonly boardWidth: number;
  readonly boardHeight: number;
  readonly canvasPxW: number;
  readonly canvasPxH: number;
  readonly portraitBoardWidth: number;
  readonly portraitBoardHeight: number;
  readonly portraitCanvasPxW: number;
  readonly portraitCanvasPxH: number;
}

/**
 * Pick the board and painting dimensions for an orientation.
 *
 * Pure and exported because ROTATE CANVAS has to keep four numbers in step —
 * the mesh, the physics box, the Easel component's half-extents and the 2D
 * canvas. Getting the metres and the pixels out of sync stretches the picture,
 * so the mapping lives in one tested function rather than four call sites.
 */
export function orientationDims(
  isPortrait: boolean,
  cfg: EaselOrientationConfig,
): EaselDims {
  return isPortrait
    ? {
        boardWidth: cfg.portraitBoardWidth,
        boardHeight: cfg.portraitBoardHeight,
        canvasPxW: cfg.portraitCanvasPxW,
        canvasPxH: cfg.portraitCanvasPxH,
      }
    : {
        boardWidth: cfg.boardWidth,
        boardHeight: cfg.boardHeight,
        canvasPxW: cfg.canvasPxW,
        canvasPxH: cfg.canvasPxH,
      };
}

/**
 * Marks the single easel entity. The numbers mirror what the system computed
 * so `ecs_query_entity` can inspect a live easel from the MCP tools.
 */
export const Easel = createComponent('Easel', {
  /** Half the canvas board's width, metres. */
  halfWidth: { type: Types.Float32, default: EASEL.boardWidth / 2 },
  /** Half the canvas board's height, metres. */
  halfHeight: { type: Types.Float32, default: EASEL.boardHeight / 2 },
  /** Paint stamps laid on the current canvas since the last NEW CANVAS. */
  stampCount: { type: Types.Int32, default: 0 },
  /** Paintings exported by SAVE PAINTING this session. */
  saveCount: { type: Types.Int32, default: 0 },
});

/**
 * Map a point on the canvas board into painting pixels.
 *
 * Board-local coordinates run right-handed with +Y up, so the vertical axis is
 * flipped: board top (`ly = +halfH`) is pixel row 0. Pure and exported so the
 * mapping — the one piece of easel maths that can silently paint in the wrong
 * corner — is unit-tested.
 *
 * Degenerate board dimensions map to the centre of the canvas rather than
 * producing NaN, so a mis-configured board still paints somewhere visible.
 *
 * @param outXY Receives [pixelX, pixelY]. Caller-owned; nothing is allocated.
 */
export function boardLocalToPixel(
  lx: number,
  ly: number,
  halfW: number,
  halfH: number,
  pxW: number,
  pxH: number,
  outXY: Float32Array | number[],
): void {
  outXY[0] = halfW > 0 ? ((lx + halfW) / (2 * halfW)) * pxW : pxW / 2;
  outXY[1] = halfH > 0 ? ((halfH - ly) / (2 * halfH)) * pxH : pxH / 2;
}

/** 0xRRGGBB to the `#rrggbb` string a 2D context wants. */
function rgbToCss(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
}

/**
 * The Chill-mode easel: a canvas you can actually paint a picture on.
 *
 * Ordinary splats are decals scattered around the room. This is different — an
 * offscreen 2D canvas is the board's texture, every impact that lands inside
 * the board is stamped onto it at the matching pixel, and SAVE PAINTING hands
 * the result back as a PNG. The board carries a physics box so balls hit it in
 * the first place; BallFlightSystem's velocity-delta detection then fires the
 * BallImpact event this system reads, with no extra plumbing.
 *
 * Runs at priority 16 — after BallFlightSystem (12) has emitted the frame's
 * impacts and before EventFlushSystem (90) clears them.
 *
 * The easel is a singleton built on the first entry into Chill and then shown
 * and hidden rather than rebuilt; it is found through the `easels` query, so
 * this system holds no entity references of its own. Its physics components
 * come and go with visibility, because an invisible easel that balls still
 * bounced off would be a ghost wall in the middle of the room.
 *
 * Allocation rules are relaxed here because everything runs at event rate (a
 * phase change, or a ball landing) rather than per frame — but the canvases,
 * the mask and the scratch vectors are still built once in init().
 */
export class EaselSystem extends createSystem({
  easels: { required: [Easel] },
}) {
  private events!: GameEventBuffer;
  private gamePhase!: Signal<GamePhase>;

  // The painting itself.
  private painting!: HTMLCanvasElement;
  private paintCtx!: CanvasRenderingContext2D | null;
  private texture?: CanvasTexture;
  /** The board's six-face material set, built once and reused across rotations. */
  private boardMaterials?: MeshStandardMaterial[];
  /** White splat silhouette with luminance baked into alpha; built once. */
  private maskCanvas!: HTMLCanvasElement;
  private maskCtx!: CanvasRenderingContext2D | null;
  private maskReady = false;
  /**
   * The same, for the web silhouette. Round 5 put web ammo on the palette, so
   * webbing can land on the canvas; without a second mask a web would have
   * stamped a paint-shaped blob and the easel would have quietly lied about
   * what hit it.
   */
  private webMaskCanvas!: HTMLCanvasElement;
  private webMaskCtx!: CanvasRenderingContext2D | null;
  private webMaskReady = false;
  /** Per-stamp tinting surface, so the mask itself is never recoloured. */
  private tintCanvas!: HTMLCanvasElement;
  private tintCtx!: CanvasRenderingContext2D | null;

  // Scratch.
  private inverseBoard!: Matrix4;
  private hitPoint!: Vector3;
  private headPosition!: Vector3;
  private headOrientation!: Quaternion;
  private headForward!: Vector3;
  private yawRotation!: Quaternion;
  private pitchRotation!: Quaternion;
  private pixel!: Float32Array;
  private measureBox!: Box3;
  private measureSize!: Vector3;
  private measureCenter!: Vector3;

  private stampCount = 0;
  private saveCount = 0;

  /** Board + painting dimensions for the orientation currently on the stand. */
  private dims: EaselDims = orientationDims(false, EASEL);
  private portrait = false;

  init() {
    this.events = this.globals.gameEvents as GameEventBuffer;
    this.gamePhase = this.globals.gamePhase as Signal<GamePhase>;

    this.inverseBoard = new Matrix4();
    this.hitPoint = new Vector3();
    this.headPosition = new Vector3();
    this.headOrientation = new Quaternion();
    this.headForward = new Vector3();
    this.yawRotation = new Quaternion();
    this.pitchRotation = new Quaternion();
    this.pixel = new Float32Array(2);
    this.measureBox = new Box3();
    this.measureSize = new Vector3();
    this.measureCenter = new Vector3();

    this.createSurfaces();

    this.cleanupFuncs.push(
      this.gamePhase.subscribe((phase) => {
        if (phase === GamePhase.Chill) {
          this.enterChill();
        } else {
          this.hideEasel();
        }
      }),
    );
  }

  update() {
    // Cheapest possible gate first: outside Chill there is no easel to paint,
    // and this keeps the query lookup below (which allocates a Set iterator)
    // off the hot path during a round.
    if (this.gamePhase.peek() !== GamePhase.Chill) return;

    const events = this.events;
    const count = events.count;
    if (count === 0) return;

    const entity = this.currentEasel();
    const object3D = entity?.object3D;
    if (!entity || !object3D || !object3D.visible) return;

    const halfW = this.dims.boardWidth / 2;
    const halfH = this.dims.boardHeight / 2;
    let inverseReady = false;

    for (let i = 0; i < count; i++) {
      if (events.typeAt(i) !== GameEvent.BallImpact) continue;

      if (!inverseReady) {
        // The easel is grabbable, so its matrix can have moved this frame.
        object3D.updateWorldMatrix(true, false);
        this.inverseBoard.copy(object3D.matrixWorld).invert();
        inverseReady = true;
      }

      // The entity's own frame IS the board frame: the board mesh sits at the
      // group's origin and the legs hang below it.
      this.hitPoint
        .set(events.xAt(i), events.yAt(i), events.zAt(i))
        .applyMatrix4(this.inverseBoard);

      if (
        Math.abs(this.hitPoint.x) > halfW ||
        Math.abs(this.hitPoint.y) > halfH ||
        Math.abs(this.hitPoint.z) > EASEL.hitDepthTolerance
      ) {
        continue;
      }

      boardLocalToPixel(
        this.hitPoint.x,
        this.hitPoint.y,
        halfW,
        halfH,
        this.dims.canvasPxW,
        this.dims.canvasPxH,
        this.pixel,
      );

      // Webbing overrides the packed colour as well as the mask: web balls are
      // white, and white paint on an off-white canvas is an invisible stamp.
      const data = events.dataAt(i);
      const web = unpackImpactStyle(data) === BallStyle.Web;
      this.stamp(
        entity,
        this.pixel[0],
        this.pixel[1],
        web ? EASEL.webStampColor : rgbToCss(unpackImpactRgb(data)),
        web,
      );
    }
  }

  /**
   * Export the painting as a PNG through the browser's download manager.
   * Quest Browser honours a programmatic anchor click the same way desktop
   * Chrome does, so this is one file per press with no extra UI.
   */
  savePainting(): void {
    const canvas = this.painting;
    if (!canvas?.toBlob) return;
    const index = this.saveCount + 1;

    try {
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `paintblast-painting-${index}.png`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        // Revoked late: revoking immediately can cancel a download that the
        // browser has not started fetching yet.
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }, 'image/png');
    } catch {
      // Blob export blocked (tainted canvas, exotic browser) — never throw
      // out of a button handler.
      return;
    }

    this.saveCount = index;
    this.currentEasel()?.setValue(Easel, 'saveCount', this.saveCount);
  }

  /**
   * Wipe the painting back to blank. Deliberately leaves the room's splats
   * alone — CLEAR PAINT is the button for those.
   */
  newCanvas(): void {
    this.fillCanvas();
    this.stampCount = 0;
    this.currentEasel()?.setValue(Easel, 'stampCount', 0);
    if (this.texture) this.texture.needsUpdate = true;
  }

  /**
   * Swap the canvas between landscape and portrait.
   *
   * Four things have to move together or the picture stretches: the board
   * mesh, the physics box balls bounce off, the Easel component's half-extents
   * (which the impact-to-pixel mapping reads) and the offscreen 2D canvas.
   * {@link orientationDims} hands out all four numbers so they cannot drift.
   *
   * Resizing the 2D canvas wipes it — a browser canvas clears on any width or
   * height write — so this necessarily starts a new painting. HudSystem says so
   * in the status line rather than pretending otherwise.
   *
   * Physics is rebuilt rather than resized: PhysicsShape dimensions are read
   * once when Havok creates the body and are not re-read afterwards, so the
   * shape is removed, then the body, then both are added fresh — the same
   * remove-shape-then-body order PhysicsSystem uses for its own cleanup.
   *
   * @returns true when the new orientation is portrait.
   */
  rotateCanvas(): boolean {
    this.portrait = !this.portrait;
    this.dims = orientationDims(this.portrait, EASEL);

    // New surface first: buildBoard() below reads the canvas for its texture.
    this.painting.width = this.dims.canvasPxW;
    this.painting.height = this.dims.canvasPxH;
    this.fillCanvas();
    this.stampCount = 0;
    if (this.texture) this.texture.needsUpdate = true;

    const entity = this.currentEasel();
    if (!entity) return this.portrait;

    const group = entity.object3D;
    if (group) {
      // Swap the mesh rather than the geometry: BoxGeometry bakes its extents
      // into vertex data, so a resize is a rebuild either way, and disposing
      // the old one keeps the GPU buffer count flat across repeated rotations.
      const old = group.getObjectByName(BOARD_MESH_NAME) as Mesh | undefined;
      if (old) {
        group.remove(old);
        old.geometry?.dispose();
      }
      group.add(this.buildBoard());
    }

    entity.setValue(Easel, 'halfWidth', this.dims.boardWidth / 2);
    entity.setValue(Easel, 'halfHeight', this.dims.boardHeight / 2);
    entity.setValue(Easel, 'stampCount', 0);

    // Only worth rebuilding while the easel is actually in the room; hideEasel
    // has already stripped both components otherwise, and showEasel re-adds
    // them at the current dimensions on the next entry into Chill.
    if (entity.hasComponent(PhysicsShape) || entity.hasComponent(PhysicsBody)) {
      if (entity.hasComponent(PhysicsShape)) entity.removeComponent(PhysicsShape);
      if (entity.hasComponent(PhysicsBody)) entity.removeComponent(PhysicsBody);
      this.addCollider(entity);
    }

    return this.portrait;
  }

  /** True when the canvas is currently stood on its short edge. */
  get isPortrait(): boolean {
    return this.portrait;
  }

  /** Stamps laid on the current canvas — for tests and MCP smoke checks. */
  get debugStampCount(): number {
    return this.stampCount;
  }

  /** The one easel, or undefined before the player has ever chilled. */
  private currentEasel(): Entity | undefined {
    for (const entity of this.queries.easels.entities) return entity;
    return undefined;
  }

  // ---- Canvas plumbing -----------------------------------------------------

  /** Build the painting, both alpha masks and the tint scratch surface once. */
  private createSurfaces(): void {
    this.painting = document.createElement('canvas');
    this.painting.width = this.dims.canvasPxW;
    this.painting.height = this.dims.canvasPxH;
    this.paintCtx = this.painting.getContext('2d');
    this.fillCanvas();

    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = EASEL.maskPx;
    this.maskCanvas.height = EASEL.maskPx;
    this.maskCtx = this.maskCanvas.getContext('2d');

    this.webMaskCanvas = document.createElement('canvas');
    this.webMaskCanvas.width = EASEL.maskPx;
    this.webMaskCanvas.height = EASEL.maskPx;
    this.webMaskCtx = this.webMaskCanvas.getContext('2d');

    this.tintCanvas = document.createElement('canvas');
    this.tintCanvas.width = EASEL.maskPx;
    this.tintCanvas.height = EASEL.maskPx;
    this.tintCtx = this.tintCanvas.getContext('2d');

    this.loadMask(EASEL.maskUrl, this.maskCtx, (ready) => {
      this.maskReady = ready;
    });
    this.loadMask(EASEL.webMaskUrl, this.webMaskCtx, (ready) => {
      this.webMaskReady = ready;
    });
  }

  /** Blank the whole painting. Reads the canvas's own size, which rotates. */
  private fillCanvas(): void {
    const ctx = this.paintCtx;
    if (!ctx) return;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = EASEL.canvasColor;
    ctx.fillRect(0, 0, this.painting.width, this.painting.height);
  }

  /**
   * The mask PNGs are white silhouettes on black with no alpha channel — drawn
   * straight into a tint pass they would stamp opaque squares. So the luminance
   * is baked into alpha exactly once here, and every later stamp is two cheap
   * composite operations against the result.
   *
   * Parameterised over url/context/flag since round 5, when webbing joined
   * paint on the canvas and there were two of these to bake. Failure is fine
   * and per-mask: without one, its stamps fall back to soft discs, the same way
   * SplatterSystem falls back without its texture.
   */
  private loadMask(
    url: string,
    ctx: CanvasRenderingContext2D | null,
    onDone: (ready: boolean) => void,
  ): void {
    if (!ctx) return;

    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      try {
        const size = EASEL.maskPx;
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(image, 0, 0, size, size);
        const pixels = ctx.getImageData(0, 0, size, size);
        const data = pixels.data;
        for (let i = 0; i < data.length; i += 4) {
          // Greyscale mask: the red channel is the coverage. Colour is thrown
          // away so 'source-in' can paint any paint colour through it.
          const coverage = data[i];
          data[i] = 255;
          data[i + 1] = 255;
          data[i + 2] = 255;
          data[i + 3] = coverage;
        }
        ctx.putImageData(pixels, 0, 0);
        onDone(true);
      } catch {
        // Cross-origin taint would make getImageData throw; discs it is.
        onDone(false);
      }
    };
    image.src = url;
  }

  /**
   * Lay one tinted stamp on the painting at a canvas pixel.
   *
   * @param web Use the web silhouette rather than the paint splat. The colour
   *   is still the caller's — a web stamp arrives pre-tinted near-white.
   */
  private stamp(
    entity: Entity,
    px: number,
    py: number,
    cssColor: string,
    web = false,
  ): void {
    const ctx = this.paintCtx;
    if (!ctx) return;

    const size =
      EASEL.stampMinPx +
      Math.random() * (EASEL.stampMaxPx - EASEL.stampMinPx);

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(Math.random() * Math.PI * 2);

    const tint = this.tintCtx;
    const maskCanvas = web ? this.webMaskCanvas : this.maskCanvas;
    const maskReady = web ? this.webMaskReady : this.maskReady;
    if (maskReady && tint) {
      const mask = EASEL.maskPx;
      tint.globalCompositeOperation = 'source-over';
      tint.clearRect(0, 0, mask, mask);
      tint.drawImage(maskCanvas, 0, 0);
      // Keep the mask's alpha, replace its colour with this ball's paint.
      tint.globalCompositeOperation = 'source-in';
      tint.fillStyle = cssColor;
      tint.fillRect(0, 0, mask, mask);
      tint.globalCompositeOperation = 'source-over';
      ctx.drawImage(this.tintCanvas, -size / 2, -size / 2, size, size);
    } else {
      ctx.fillStyle = cssColor;
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.42, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
    if (this.texture) this.texture.needsUpdate = true;

    this.stampCount++;
    entity.setValue(Easel, 'stampCount', this.stampCount);
  }

  // ---- Easel lifecycle -----------------------------------------------------

  private enterChill(): void {
    // buildEasel() adds the Easel component, which qualifies the entity for
    // the query synchronously, so the very next lookup finds it.
    const entity = this.currentEasel() ?? this.buildEasel();
    this.placeInFrontOfHead(entity);
    this.showEasel(entity);
  }

  /**
   * Give the easel its collider back. Added body-then-shape because the
   * physics query needs both, and only then does PhysicsSystem build a Havok
   * body — at the pose we just placed it in.
   */
  private showEasel(entity: Entity): void {
    const object3D = entity.object3D;
    if (!object3D) return;

    object3D.visible = true;
    this.addCollider(entity);
  }

  /**
   * Body-then-shape, because the physics query needs both before PhysicsSystem
   * builds a Havok body — and it builds it at whatever pose and dimensions are
   * current at that moment, which is why rotateCanvas() can reuse this.
   */
  private addCollider(entity: Entity): void {
    if (!entity.hasComponent(PhysicsBody)) {
      // Kinematic, not Static: TwoHandsGrabbable drives the body through
      // PhysicsSystem's Pressed branch (HP_Body_SetTargetQTransform), which a
      // static body ignores — the easel would snap back on release.
      entity.addComponent(PhysicsBody, {
        state: PhysicsState.Kinematic,
        gravityFactor: 0,
      });
    }
    if (!entity.hasComponent(PhysicsShape)) {
      entity.addComponent(PhysicsShape, {
        shape: PhysicsShapeType.Box,
        // Full extents, and only the canvas: balls fly straight through the
        // legs, which is what you want when the legs are not the target.
        dimensions: [
          this.dims.boardWidth,
          this.dims.boardHeight,
          EASEL.boardDepth,
        ],
        density: 1,
        restitution: 0.15,
        friction: 0.6,
      });
    }
  }

  /** Hide the easel and take its collider out of the room with it. */
  private hideEasel(): void {
    const entity = this.currentEasel();
    if (!entity) return;

    // Shape first, matching PhysicsSystem's own cleanup order.
    if (entity.hasComponent(PhysicsShape)) entity.removeComponent(PhysicsShape);
    if (entity.hasComponent(PhysicsBody)) entity.removeComponent(PhysicsBody);
    if (entity.object3D) entity.object3D.visible = false;
  }

  /** Plant the easel a comfortable distance ahead, facing the player. */
  private placeInFrontOfHead(entity: Entity): void {
    const object3D = entity.object3D;
    if (!object3D) return;

    const head = this.player?.head;
    if (head) {
      head.getWorldPosition(this.headPosition);
      head.getWorldQuaternion(this.headOrientation);
    } else {
      this.headPosition.set(0, 1.6, 0);
      this.headOrientation.identity();
    }

    // Head spaces look along their local -Z; flatten so the easel stands
    // upright however the player was tilting their head.
    this.headForward.set(0, 0, -1).applyQuaternion(this.headOrientation);
    this.headForward.y = 0;
    if (this.headForward.lengthSq() < 1e-6) {
      this.headForward.set(0, 0, -1);
    }
    this.headForward.normalize();

    object3D.position.set(
      this.headPosition.x + this.headForward.x * EASEL.spawnDistance,
      EASEL.boardCentreHeight,
      this.headPosition.z + this.headForward.z * EASEL.spawnDistance,
    );

    // Yaw so the board's +Z face looks back down the player's own forward
    // axis, then pitch about the easel's local X so it leans away like a real
    // A-frame (negative X rotation tips the top backwards).
    this.yawRotation.setFromAxisAngle(
      UP,
      Math.atan2(-this.headForward.x, -this.headForward.z),
    );
    this.pitchRotation.setFromAxisAngle(RIGHT, -EASEL.tiltDeg * DEG_TO_RAD);
    object3D.quaternion.copy(this.yawRotation).multiply(this.pitchRotation);
  }

  /**
   * Build the easel: our canvas board at the group's origin, plus a frame
   * below it — the optional `easel` GLB if one was registered, otherwise
   * primitive legs and a crossbar.
   */
  private buildEasel(): Entity {
    const group = new Group();
    group.name = 'Easel';
    group.visible = false;

    const wood = new MeshStandardMaterial({
      color: new Color(EASEL.woodColor),
      roughness: EASEL.woodRoughness,
      metalness: 0,
    });

    const frame = this.buildModelledFrame() ?? this.buildPrimitiveFrame(wood);
    group.add(frame);
    group.add(this.buildBoard());

    const entity = this.world.createTransformEntity(group, {
      parent: this.world.sceneEntity,
      persistent: true,
    });
    entity.addComponent(Easel, {
      halfWidth: this.dims.boardWidth / 2,
      halfHeight: this.dims.boardHeight / 2,
      stampCount: this.stampCount,
      saveCount: this.saveCount,
    });
    // Grabbable, but deliberately NOT Interactable: putting the easel in the
    // ray-intersection set would make BallSpawnSystem treat "aiming at the
    // canvas" as "clicking UI" and swallow the shot.
    entity.addComponent(TwoHandsGrabbable, {
      translate: true,
      rotate: true,
      scale: false,
    });
    return entity;
  }

  /** The paintable canvas: a thin box whose +Z face carries the painting. */
  private buildBoard(): Object3D {
    const geometry = new BoxGeometry(
      this.dims.boardWidth,
      this.dims.boardHeight,
      EASEL.boardDepth,
    );

    // One CanvasTexture for the life of the system: resizing the backing 2D
    // canvas and flagging needsUpdate makes three re-upload at the new size,
    // so rotating never leaks a texture.
    if (!this.texture) {
      this.texture = new CanvasTexture(this.painting);
      // 2D canvas pixels are sRGB. Without this the paint renders washed out,
      // because three treats an unmarked texture's data as linear.
      this.texture.colorSpace = SRGBColorSpace;
    }
    this.texture.needsUpdate = true;

    // Materials outlive the mesh for the same reason the texture does: ROTATE
    // CANVAS rebuilds the board, and reallocating a material set per rotation
    // would leak one per press.
    if (!this.boardMaterials) {
      const blank = new MeshStandardMaterial({
        color: new Color(EASEL.canvasColor),
        roughness: 0.85,
        metalness: 0,
      });
      const painted = new MeshStandardMaterial({
        map: this.texture,
        roughness: 0.9,
        metalness: 0,
      });
      // BoxGeometry material order is [+X, -X, +Y, -Y, +Z, -Z]; only the front
      // face shows the painting.
      this.boardMaterials = [blank, blank, blank, blank, painted, blank];
    }

    const board = new Mesh(geometry, this.boardMaterials);
    board.name = BOARD_MESH_NAME;
    return board;
  }

  /** Three legs and a crossbar, sized so the feet land on the floor. */
  private buildPrimitiveFrame(wood: MeshStandardMaterial): Object3D {
    const frame = new Group();
    frame.name = 'EaselFrame';

    const halfH = EASEL.boardHeight / 2;
    const halfW = EASEL.boardWidth / 2;
    const thickness = EASEL.frameThickness;
    // The whole easel is pitched, so a vertical drop of boardCentreHeight
    // needs a slightly longer leg to still reach the floor.
    const legLength =
      EASEL.boardCentreHeight / Math.cos(EASEL.tiltDeg * DEG_TO_RAD) - halfH;
    const legY = -halfH - legLength / 2;

    const legGeometry = new BoxGeometry(thickness, legLength, thickness);
    for (const x of [-halfW + thickness, halfW - thickness]) {
      const leg = new Mesh(legGeometry, wood);
      leg.position.set(x, legY, 0);
      frame.add(leg);
    }
    const rearLeg = new Mesh(legGeometry, wood);
    rearLeg.position.set(0, legY, -EASEL.rearLegOffset);
    frame.add(rearLeg);

    // The ledge the canvas rests on, proud of the board's front face.
    const crossbar = new Mesh(
      new BoxGeometry(
        EASEL.boardWidth + thickness * 2,
        thickness,
        thickness * 1.6,
      ),
      wood,
    );
    crossbar.position.set(0, -halfH - thickness * 0.6, EASEL.boardDepth);
    frame.add(crossbar);

    return frame;
  }

  /**
   * Use the optional `easel` GLB for the frame, measured and rescaled so its
   * top meets the canvas — the same measure-the-art trick TargetSystem uses,
   * so swapping the model never needs a code change. Returns undefined when
   * no such asset is registered, which is the shipping case today.
   */
  private buildModelledFrame(): Object3D | undefined {
    let source: Object3D | undefined;
    try {
      source = AssetManager.getGLTF(EASEL_ASSET_KEY)?.scene;
    } catch {
      // AssetManager not initialised (unit tests) or key absent.
      return undefined;
    }
    if (!source) return undefined;

    const model = source.clone(true);
    this.measureBox.setFromObject(model);
    this.measureBox.getSize(this.measureSize);
    this.measureBox.getCenter(this.measureCenter);

    const targetHeight = EASEL.boardCentreHeight + EASEL.boardHeight / 2;
    const fit = targetHeight / (this.measureSize.y || 1);
    model.scale.setScalar(fit);
    // Re-seat the art so its top edge lands at the board's top edge and its
    // feet at the floor, whatever origin the exporter chose.
    model.position.set(
      -this.measureCenter.x * fit,
      EASEL.boardHeight / 2 - targetHeight / 2 - this.measureCenter.y * fit,
      -this.measureCenter.z * fit,
    );

    const holder = new Group();
    holder.name = 'EaselFrame';
    holder.add(model);
    return holder;
  }
}
