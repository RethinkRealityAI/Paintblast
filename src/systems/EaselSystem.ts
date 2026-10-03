import {
  AssetManager,
  Box3,
  BoxGeometry,
  CanvasTexture,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PhysicsBody,
  PhysicsShape,
  PhysicsShapeType,
  PhysicsState,
  PlaneGeometry,
  Pressed,
  Quaternion,
  SRGBColorSpace,
  TwoHandsGrabbable,
  Types,
  Vector3,
  createComponent,
  createSystem,
} from '@iwsdk/core';
import type { Entity, Object3D, Texture } from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import { EASEL, STUDIO } from '../config';
import { onBoardSurface, shapeBoard } from '../studio';
import { smoothingAlpha } from '../wrist-frame';
import {
  BallStyle,
  CanvasShape,
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
/** Round 10: the gallery-frame art laid over the board's face. */
const FRAME_ART_NAME = 'EaselFrameArt';
/** Round 10: the stencil guide overlay (dimmed outside + outline). */
const GUIDE_MESH_NAME = 'EaselStencilGuide';
/** The legs / GLB stand group, hidden when the canvas hangs on a wall. */
const STAND_NAME = 'EaselFrame';

/** Round 10: board + painting sizes for the Studio's shapes, from EASEL + STUDIO. */
const SHAPE_BOARD_CONFIG = {
  boardWidth: EASEL.boardWidth,
  boardHeight: EASEL.boardHeight,
  canvasPxW: EASEL.canvasPxW,
  canvasPxH: EASEL.canvasPxH,
  squareBoardSize: STUDIO.squareBoardSize,
  squareCanvasPx: STUDIO.squareCanvasPx,
};

/** Which frame art a shape wears (portrait = the landscape frame turned). */
function frameFor(shape: CanvasShape) {
  return shape === CanvasShape.Round
    ? STUDIO.frames.round
    : shape === CanvasShape.Square
      ? STUDIO.frames.square
      : STUDIO.frames.rect;
}

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
/**
 * Round 9: height of the board's centre for a head at `headY` metres —
 * EASEL.boardBelowEyes under the eyes, clamped to
 * [boardCentreMinHeight, boardCentreMaxHeight]. Seated (~1.2 m) and standing
 * (~1.6 m) players both get the board at their sight line, with its bottom
 * edge above the docked HUD's top edge in either orientation, so leaning in
 * never pushes the HUD (0.95 m ahead of the head) through the board. Non-finite input falls back to EASEL.boardCentreHeight.
 */
export function easelCentreHeight(headY: number): number {
  if (!Number.isFinite(headY)) return EASEL.boardCentreHeight;
  return Math.min(
    EASEL.boardCentreMaxHeight,
    Math.max(EASEL.boardCentreMinHeight, headY - EASEL.boardBelowEyes),
  );
}

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

  /**
   * Round 7 grab smoothing: the pose the easel is *drawn* at while (and just
   * after) it is grabbed. @see smoothGrab
   */
  private grabShownPos!: Vector3;
  private grabShownQ!: Quaternion;
  private grabPrimed = false;

  /** Board + painting dimensions for the orientation currently on the stand. */
  private dims: EaselDims = orientationDims(false, EASEL);
  private portrait = false;

  // ---- Round 10: the Studio ------------------------------------------------
  /** Shape of the surface on the stand (Landscape/Portrait mirror `portrait`). */
  private shape: CanvasShape = CanvasShape.Landscape;
  /** Metres multiplier on the board (a wall canvas grows with distance). */
  private boardScale = 1;
  /**
   * Set by StudioSystem: it decides where the canvas goes and when it shows,
   * so entering Chill only builds the easel instead of planting it. Without a
   * Studio (tests, a stripped build) the round-9 behaviour is unchanged.
   */
  managed = false;
  /**
   * Called for every stamp laid on the painting, in board UV (u right, v
   * down, 0..1) with the stamp's drawn size as a fraction of the canvas
   * width. StudioSystem feeds its stencil coverage grid from it, so coverage
   * always matches the paint actually drawn.
   */
  onStamp?: (u: number, v: number, sizeFrac: number) => void;
  /** Hidden material for the round board's sides and back. */
  private hiddenMaterial?: MeshBasicMaterial;
  private roundMaterials?: Array<MeshStandardMaterial | MeshBasicMaterial>;
  private frameMaterial?: MeshStandardMaterial;
  private frameLoading = new Set<string>();
  private guideCanvas?: HTMLCanvasElement;
  private guideTexture?: CanvasTexture;
  private guideMaterial?: MeshBasicMaterial;
  private guideOn = false;
  private sharedPlane?: PlaneGeometry;

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
    this.grabShownPos = new Vector3();
    this.grabShownQ = new Quaternion();

    this.createSurfaces();

    this.cleanupFuncs.push(
      this.gamePhase.subscribe((phase) => {
        if (phase === GamePhase.Chill) {
          // Round 10: the Studio places and shows the canvas itself.
          if (this.managed) this.ensureEasel();
          else this.enterChill();
        } else {
          this.hideEasel();
        }
      }),
    );
  }

  update(delta: number) {
    // Cheapest possible gate first: outside Chill there is no easel to paint,
    // and this keeps the query lookup below (which allocates a Set iterator)
    // off the hot path during a round.
    if (this.gamePhase.peek() !== GamePhase.Chill) {
      this.grabPrimed = false;
      return;
    }

    // Paint first, against this frame's raw pose — the one the physics
    // collider was just moved to — then smooth what gets drawn.
    this.paintImpacts();
    this.smoothGrab(delta);
  }

  /**
   * Round 7: a two-handed grab used to drag the easel with every tremor of
   * both tracked hands, which on a 60 cm board reads as jitter. IWSDK's
   * GrabSystem (priority -3) writes the raw grabbed pose, PhysicsSystem (-2)
   * moves the kinematic collider to it, and then — here, before render — the
   * pose that is *drawn* is low-passed toward it with time constant
   * {@link EASEL.grabSmoothingSec}. The grab handle recomputes its target from
   * the grab's start every frame, so overwriting the drawn pose never feeds
   * back into it; and after release the physics body holds the raw pose while
   * the drawn one glides the last centimetre onto it, rather than snapping.
   */
  private smoothGrab(delta: number): void {
    const entity = this.currentEasel();
    const object3D = entity?.object3D;
    if (!entity || !object3D || !object3D.visible) {
      this.grabPrimed = false;
      return;
    }

    const grabbed = entity.hasComponent(Pressed);
    if (!this.grabPrimed) {
      if (!grabbed) return;
      this.grabShownPos.copy(object3D.position);
      this.grabShownQ.copy(object3D.quaternion);
      this.grabPrimed = true;
      return;
    }

    const alpha = smoothingAlpha(delta, EASEL.grabSmoothingSec);
    this.grabShownPos.lerp(object3D.position, alpha);
    this.grabShownQ.slerp(object3D.quaternion, alpha);

    // Released and settled: hand the pose back to physics untouched.
    if (
      !grabbed &&
      this.grabShownPos.distanceToSquared(object3D.position) < 1e-6 &&
      this.grabShownQ.angleTo(object3D.quaternion) < 0.002
    ) {
      this.grabPrimed = false;
      return;
    }

    object3D.position.copy(this.grabShownPos);
    object3D.quaternion.copy(this.grabShownQ);
  }

  /** Stamp every ball that hit the canvas this frame onto the painting. */
  private paintImpacts(): void {
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
        !onBoardSurface(this.shape, this.hitPoint.x, this.hitPoint.y, halfW, halfH) ||
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
  savePainting(knockout?: HTMLCanvasElement | null, name = 'painting'): number {
    let canvas: HTMLCanvasElement = this.painting;
    if (!canvas?.toBlob) return this.saveCount;
    const index = this.saveCount + 1;

    // Round 10: a stencil SAVE lifts the stencil - everything outside the
    // shape is knocked out to transparent, like peeling the tape off.
    if (knockout) {
      const lifted = document.createElement('canvas');
      lifted.width = canvas.width;
      lifted.height = canvas.height;
      const ctx = lifted.getContext('2d');
      if (ctx) {
        ctx.drawImage(canvas, 0, 0);
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(knockout, 0, 0, lifted.width, lifted.height);
        ctx.globalCompositeOperation = 'source-over';
        canvas = lifted;
      }
    }

    try {
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `splotopia-${name}-${index}.png`;
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
      return this.saveCount;
    }

    this.saveCount = index;
    this.currentEasel()?.setValue(Easel, 'saveCount', this.saveCount);
    return index;
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
    this.setShape(this.portrait ? CanvasShape.Landscape : CanvasShape.Portrait);
    return this.portrait;
  }

  // ---- Round 10: Studio API --------------------------------------------------

  /** The shape on the stand now. */
  get currentShape(): CanvasShape {
    return this.shape;
  }

  /**
   * Swap the surface's shape. Like ROTATE CANVAS (which now routes here) this
   * wipes the painting: a browser canvas clears whenever its size is written.
   * Four things move together or the picture stretches - the board mesh, the
   * physics box, the Easel component's half-extents and the 2D canvas - and
   * {@link shapeBoard} hands out all of their numbers.
   */
  setShape(shape: CanvasShape): void {
    this.shape = shape;
    this.portrait = shape === CanvasShape.Portrait;
    this.dims = shapeBoard(shape, this.boardScale, SHAPE_BOARD_CONFIG);
    const resized =
      this.painting.width !== this.dims.canvasPxW ||
      this.painting.height !== this.dims.canvasPxH;
    this.painting.width = this.dims.canvasPxW;
    this.painting.height = this.dims.canvasPxH;
    this.fillCanvas();
    this.stampCount = 0;
    if (this.texture) {
      // three r181 allocates immutable texStorage at the first upload's size
      // and later uploads are texSubImage2D into it, so a canvas that changed
      // size silently fails to upload (the board kept showing the old
      // picture). dispose() frees the GPU storage; the next render
      // re-allocates at the new size. Same Texture object, so the material
      // keeps its map.
      if (resized) this.texture.dispose();
      this.texture.needsUpdate = true;
    }
    this.applyGeometry();
  }

  /**
   * Hang the canvas at a world pose with no stand: upright, its painted face
   * turned by `yaw` (about +Y), metres scaled by `scale`. Scale changes only
   * the board's size, never its pixels, so the painting survives a re-hang.
   */
  placeAt(x: number, y: number, z: number, yaw: number, scale: number): void {
    const entity = this.ensureEasel();
    const object3D = entity.object3D;
    if (!object3D) return;
    this.setBoardScale(scale);
    object3D.position.set(x, y, z);
    this.yawRotation.setFromAxisAngle(UP, yaw);
    object3D.quaternion.copy(this.yawRotation);
    this.setStandVisible(entity, false);
    this.grabPrimed = false;
    this.rebuildColliderIfPresent(entity);
  }

  /** Stand the canvas on the round-2 easel within seated reach (scale 1). */
  placeOnEasel(): void {
    const entity = this.ensureEasel();
    this.setBoardScale(1);
    this.placeInFrontOfHead(entity);
    this.setStandVisible(entity, true);
    this.grabPrimed = false;
    this.rebuildColliderIfPresent(entity);
  }

  /** Show the canvas (and its collider). */
  show(): void {
    this.showEasel(this.ensureEasel());
  }

  /** Hide the canvas and take its collider out of the room. */
  hide(): void {
    this.hideEasel();
  }

  /**
   * Lay a stencil guide over the board - the area outside the shape dimmed,
   * a neon outline just outside its edge - or clear it with null. `mask` is
   * a white silhouette with its luminance already baked into alpha (any
   * size; it is stretched over the whole board). Event-rate only.
   */
  setStencilGuide(mask: HTMLCanvasElement | null): void {
    this.guideOn = !!mask;
    const canvas = this.guideCanvas;
    const ctx = canvas?.getContext('2d');
    if (mask && ctx && canvas) {
      const size = canvas.width;
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, size, size);
      // Outline: the mask stamped in a ring of offsets and tinted...
      const r = STUDIO.guideOutlinePx;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        ctx.drawImage(mask, Math.cos(a) * r, Math.sin(a) * r, size, size);
      }
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = STUDIO.guideOutlineColor;
      ctx.fillRect(0, 0, size, size);
      // ...the dimmed outside slid in underneath it...
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = `rgba(10, 12, 22, ${STUDIO.guideOutsideAlpha})`;
      ctx.fillRect(0, 0, size, size);
      // ...and the shape itself punched back out, so only the band just
      // outside the edge and the dim surround stay.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(mask, 0, 0, size, size);
      ctx.globalCompositeOperation = 'source-over';
      if (this.guideTexture) this.guideTexture.needsUpdate = true;
    }
    const guide = this.currentEasel()?.object3D?.getObjectByName(GUIDE_MESH_NAME);
    if (guide) guide.visible = this.guideOn;
  }

  /** The painting itself (read-only use: export, harness checks). */
  get paintingCanvas(): HTMLCanvasElement {
    return this.painting;
  }

  /** Build the easel if this is the first time, without showing it. */
  private ensureEasel(): Entity {
    return this.currentEasel() ?? this.buildEasel();
  }

  private setBoardScale(scale: number): void {
    const next = scale > 0 && Number.isFinite(scale) ? scale : 1;
    if (Math.abs(next - this.boardScale) < 1e-4) return;
    this.boardScale = next;
    this.dims = shapeBoard(this.shape, this.boardScale, SHAPE_BOARD_CONFIG);
    this.applyGeometry();
  }

  private setStandVisible(entity: Entity, visible: boolean): void {
    const stand = entity.object3D?.getObjectByName(STAND_NAME);
    if (stand) stand.visible = visible;
  }

  /**
   * Make the board mesh, the frame art, the guide, the Easel component and
   * (if present) the physics box match `dims`. Physics is rebuilt rather than
   * resized (gotcha 7: shapes are immutable post-creation).
   */
  private applyGeometry(): void {
    const entity = this.currentEasel();
    if (!entity) return;

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
      this.layoutOverlays(group);
    }

    entity.setValue(Easel, 'halfWidth', this.dims.boardWidth / 2);
    entity.setValue(Easel, 'halfHeight', this.dims.boardHeight / 2);
    entity.setValue(Easel, 'stampCount', this.stampCount);
    this.rebuildColliderIfPresent(entity);
  }

  /**
   * Only worth rebuilding while the easel is actually in the room; hideEasel
   * has already stripped both components otherwise, and showEasel re-adds
   * them at the current dimensions and pose. Remove shape then body, add
   * fresh (gotcha 7) - also how a moved, non-grabbed kinematic board gets its
   * Havok body to the new pose.
   */
  private rebuildColliderIfPresent(entity: Entity): void {
    if (entity.hasComponent(PhysicsShape) || entity.hasComponent(PhysicsBody)) {
      if (entity.hasComponent(PhysicsShape)) entity.removeComponent(PhysicsShape);
      if (entity.hasComponent(PhysicsBody)) entity.removeComponent(PhysicsBody);
      this.addCollider(entity);
    }
  }

  /** Size and place the frame art and the stencil guide over the board's face. */
  private layoutOverlays(group: Object3D): void {
    this.sharedPlane ??= new PlaneGeometry(1, 1);
    const front = EASEL.boardDepth / 2;
    const w = this.dims.boardWidth;
    const h = this.dims.boardHeight;

    let frame = group.getObjectByName(FRAME_ART_NAME) as Mesh | undefined;
    if (!frame) {
      this.frameMaterial ??= new MeshStandardMaterial({
        transparent: true,
        alphaTest: 0.04,
        depthWrite: false,
        roughness: 0.35,
        metalness: 0.15,
        emissive: new Color(0xffffff),
        emissiveIntensity: STUDIO.frameEmissive,
        visible: false,
      });
      frame = new Mesh(this.sharedPlane, this.frameMaterial);
      frame.name = FRAME_ART_NAME;
      frame.renderOrder = 2;
      group.add(frame);
    }
    const art = frameFor(this.shape);
    const rotated = this.shape === CanvasShape.Portrait;
    // The art's own axes: its width spans the board's height when turned.
    const artW = (rotated ? h : w) / art.innerW;
    const artH = (rotated ? w : h) / art.innerH;
    frame.scale.set(artW, artH, 1);
    frame.rotation.set(0, 0, rotated ? Math.PI / 2 : 0);
    // Shift so the opening (not the image centre) lands on the board; a
    // quarter turn maps the art's (x, y) to the board's (-y, x).
    const ox = -art.offX * artW;
    const oy = -art.offY * artH;
    frame.position.set(rotated ? -oy : ox, rotated ? ox : oy, front + 0.004);
    this.applyFrameTexture(art.key, art.url);

    let guide = group.getObjectByName(GUIDE_MESH_NAME) as Mesh | undefined;
    if (!guide) {
      this.guideCanvas = document.createElement('canvas');
      this.guideCanvas.width = STUDIO.guidePx;
      this.guideCanvas.height = STUDIO.guidePx;
      this.guideTexture = new CanvasTexture(this.guideCanvas);
      this.guideTexture.colorSpace = SRGBColorSpace;
      this.guideMaterial = new MeshBasicMaterial({
        map: this.guideTexture,
        transparent: true,
        depthWrite: false,
      });
      guide = new Mesh(this.sharedPlane, this.guideMaterial);
      guide.name = GUIDE_MESH_NAME;
      guide.renderOrder = 1;
      group.add(guide);
    }
    guide.scale.set(w, h, 1);
    guide.position.set(0, 0, front + 0.002);
    guide.visible = this.guideOn;
  }

  /**
   * Put a frame's art on the shared frame material, streaming it in through
   * AssetManager the first time (main.ts also lists it as a background asset).
   * Until it arrives the board shows unframed.
   */
  private applyFrameTexture(key: string, url: string): void {
    const material = this.frameMaterial;
    if (!material) return;
    let texture: Texture | null = null;
    try {
      texture = AssetManager.getTexture(key) as Texture | null;
    } catch {
      texture = null;
    }
    if (!texture) {
      material.visible = false;
      if (!this.frameLoading.has(key) && typeof AssetManager.loadTexture === 'function') {
        this.frameLoading.add(key);
        AssetManager.loadTexture(url, key)
          .then(() => {
            // Only if that frame is still the one the board wants.
            if (frameFor(this.shape).key === key) this.applyFrameTexture(key, url);
          })
          .catch(() => {
            // Missing art: the board simply stays unframed.
          });
      }
      return;
    }
    texture.colorSpace = SRGBColorSpace;
    if (material.map !== texture) {
      material.map = texture;
      material.emissiveMap = texture;
      material.needsUpdate = true;
    }
    material.visible = true;
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
    const w = this.painting.width;
    const h = this.painting.height;
    if (this.shape === CanvasShape.Round) {
      // Round 10: a tondo. Transparent corners, so the board's alphaTest
      // cuts the disc and SAVE exports a round picture.
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.fillRect(0, 0, w, h);
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
    if (this.shape === CanvasShape.Round) {
      // Paint never lands on the transparent corners of a round board.
      const w = this.painting.width;
      const h = this.painting.height;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
      ctx.clip();
    }
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
    this.onStamp?.(
      px / this.painting.width,
      py / this.painting.height,
      size / this.painting.width,
    );
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
          EASEL.colliderDepth,
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

    // Round 9: within seated reach, and planted relative to the eyes (seated
    // or standing) rather than at a fixed 1.2 m. @see easelCentreHeight
    object3D.position.set(
      this.headPosition.x + this.headForward.x * EASEL.spawnDistance,
      head ? easelCentreHeight(this.headPosition.y) : EASEL.boardCentreHeight,
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
    this.layoutOverlays(group);

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

    // One CanvasTexture for the life of the system. A resize must dispose it
    // first (see setShape) - three allocates fixed-size storage on upload.
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
        // Round 10: the round board's corners are transparent pixels.
        alphaTest: 0.5,
      });
      // BoxGeometry material order is [+X, -X, +Y, -Y, +Z, -Z]; only the front
      // face shows the painting.
      this.boardMaterials = [blank, blank, blank, blank, painted, blank];
      // The round board shows its painted disc only - square sides and back
      // would poke out past the round frame.
      this.hiddenMaterial = new MeshBasicMaterial({ visible: false });
      const hidden = this.hiddenMaterial;
      this.roundMaterials = [hidden, hidden, hidden, hidden, painted, hidden];
    }

    const board = new Mesh(
      geometry,
      this.shape === CanvasShape.Round && this.roundMaterials
        ? this.roundMaterials
        : this.boardMaterials,
    );
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
