import {
  World,
  SessionMode,
  VisibilityState,
  AssetManager,
  AssetType,
  Box3,
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  SRGBColorSpace,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  MeshStandardMaterial,
  Color,
  Interactable,
  PokeInteractable,
  OneHandGrabbable,
  PanelUI,
  Follower,
  FollowBehavior,
  XRAnchor,
  DepthOccludable,
  IBLTexture,
  NoToneMapping,
  NeutralToneMapping,
  ACESFilmicToneMapping,
  AgXToneMapping,
} from '@iwsdk/core';
import type { BufferGeometry, ToneMapping } from '@iwsdk/core';
import { signal } from '@preact/signals-core';

import {
  SplatterField,
  SplatterSystem,
  SPLAT_TEXTURE_KEY,
  WEB_SPLAT_TEXTURE_KEY,
} from './systems/SplatterSystem';
import {
  Ball,
  PaintDab,
  KindChip,
  WebModePad,
  BlasterModePad,
  BallSpawnSystem,
  SELECTED_SLOT_SCALE,
} from './systems/BallSpawnSystem';
import { BallFlightSystem } from './systems/BallFlightSystem';
import { EventFlushSystem } from './systems/EventFlushSystem';
import { WorldCollisionSystem } from './systems/WorldCollisionSystem';
import { FloorGuard, FloorGuardSystem } from './systems/FloorGuardSystem';
import {
  WebShooterSystem,
  WebStrand,
  WEB_SHOOTER_ASSET_KEY,
} from './systems/WebShooterSystem';
import { Gauntlet, GauntletSystem } from './systems/GauntletSystem';
import { Target, TargetSystem, ROBOT_ASSET_KEY } from './systems/TargetSystem';
import { GameStateSystem } from './systems/GameStateSystem';
import { HudSystem } from './systems/HudSystem';
import { FeedbackSystem } from './systems/FeedbackSystem';
import {
  PaletteRoot,
  WristPaletteSystem,
  PALETTE_BOARD_ASSET_KEY,
  thinnestAxis,
} from './systems/WristPaletteSystem';
import { Easel, EaselSystem, EASEL_ASSET_KEY } from './systems/EaselSystem';
import { SceneScanSystem } from './systems/SceneScanSystem';
import { VfxSystem } from './systems/VfxSystem';
import { IntroSystem, INTRO_LOGO_KEY } from './systems/IntroSystem';
import { initLanding } from './landing/landing';
import { AUDIO, BLASTER, GAME, HUD, PALETTE, RENDER, TARGETS, WEB } from './config';
import type { ToneMappingName } from './config';
import {
  BallKind,
  BallStyle,
  PALETTE_CHIP_ORDER,
  PALETTE_DAB_ORDER,
  INITIAL_PALETTE_SELECTION,
  INITIAL_HUD_STATE,
  GamePhase,
  GameEventBuffer,
  WebSubMode,
  AimTargets,
  BlasterMode,
  BLASTER_MODE_LABELS,
  BLASTER_MODE_ORDER,
} from './types';
import type { PaletteChipSpec } from './types';

const DEG_TO_RAD = Math.PI / 180;

/** The stored skin index, or 0. Never throws (private mode, blocked storage). */
function readStoredSkin(): number {
  try {
    const raw = window.localStorage.getItem(BLASTER.skinStorageKey);
    const n = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 && n < BLASTER.skins.length ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Seeds every world.globals signal the game reads.
 *
 * This is the cross-system contract: systems never talk to each other
 * directly, they read and write these. Must run BEFORE registerSystem —
 * elics calls System.init() synchronously during registration, and the
 * systems bind these signals there.
 */
function seedGlobals(world: World) {
  const globals = world.globals as Record<string, unknown>;

  // Round state machine + scoring (GameStateSystem owns writes in Wave B).
  globals.gamePhase = signal(GamePhase.Idle);
  globals.score = signal(0);
  globals.bestScore = signal(0);
  globals.combo = signal(1);
  globals.timeLeft = signal(GAME.roundSec);
  globals.targetsAlive = signal(0);
  // True whenever the immersive session is not in focus: the Quest system
  // menu is open (VisibleBlurred), the headset is off (Hidden), or there is no
  // session at all (NonImmersive — so it reads true on the landing page too).
  // GameStateSystem owns every write, mirroring world.visibilityState, and
  // decides per phase what that freezes: the round clock, countdown, game-over
  // timer and combo window stop, and TargetSystem holds its robots. Idle and
  // Chill carry on untouched. Seeded false; GameStateSystem.init() corrects it
  // from the live visibility state the moment it registers.
  globals.paused = signal(false);

  // Selected ammo (BallSpawnSystem owns writes). Three independent axes since
  // round 5: the paint colour from a dab, the ball kind from a chip, and the
  // paint STYLE — paint or webbing — from the same chip row. activeStyle is
  // what replaced GamePhase.Web: web shooters follow the ammo, not the mode.
  globals.activeKind = signal(INITIAL_PALETTE_SELECTION.kind);
  globals.activeStyle = signal<BallStyle>(INITIAL_PALETTE_SELECTION.style);
  globals.activeColor = signal(INITIAL_PALETTE_SELECTION.color);
  // Round 6's fourth loadout axis: which KIND of web. Only meaningful while
  // activeStyle is Web, chosen on the two-pad selector above the left shooter
  // or with the right controller's B button. BallSpawnSystem owns every write.
  globals.webSubMode = signal<WebSubMode>(INITIAL_PALETTE_SELECTION.subMode);
  // Round 8: which launcher the gauntlets are in (HAND / BLASTER / WEB), and
  // which cosmetic skin they wear. BallSpawnSystem keeps blasterMode and
  // activeStyle in sync (Web <=> Web); the skin is picked in the Armory and
  // persisted per device.
  globals.blasterMode = signal<BlasterMode>(
    INITIAL_PALETTE_SELECTION.blasterMode,
  );
  globals.blasterSkin = signal<number>(readStoredSkin());

  // Bitmask of hands currently holding a tether: bit 0 left, bit 1 right.
  // TargetSystem owns the writes (it owns the tether); BallSpawnSystem reads it
  // so a squeeze that is reeling a robot in cannot also re-pick ammo. A signal
  // rather than a system call because TargetSystem imports BallSpawnSystem, and
  // reaching back the other way would close an import cycle.
  globals.tetheredHands = signal(0);

  // Raised by SceneScanSystem when the headset reports no planes and no meshes
  // after a grace period, i.e. the room was never put through Space Setup.
  // HudSystem turns it into the idle screen's SCAN ROOM notice.
  globals.sceneScanMissing = signal(false);

  // Rendered HUD strings (HudSystem owns writes in Wave B).
  globals.hudScore = signal(INITIAL_HUD_STATE.score);
  globals.hudTimer = signal(INITIAL_HUD_STATE.timer);
  globals.hudStatus = signal(INITIAL_HUD_STATE.status);

  // One-frame event mailbox, drained by EventFlushSystem at priority 90.
  globals.gameEvents = new GameEventBuffer();

  // Round 7: live robot positions for aim assist. TargetSystem writes it every
  // frame of a round, BallSpawnSystem reads it per shot. A struct rather than
  // a system call for the same import-cycle reason as tetheredHands.
  globals.aimTargets = new AimTargets(TARGETS.poolSize);
}

/**
 * The palette board: the modelled GLB if one was registered, otherwise a
 * flattened wooden oval built here.
 *
 * The oval is a cylinder squashed on its near-far axis rather than a scaled
 * mesh, because the squash is baked into the geometry — a non-uniform object
 * scale on the board would be inherited by nothing (the dabs are siblings, not
 * children) but would still make the mesh's normals wrong under lighting.
 */
function buildPaletteBoard(): Object3D {
  const modelled = loadPaletteBoardModel();
  if (modelled) return modelled;

  const geometry = new CylinderGeometry(
    PALETTE.boardRadius,
    PALETTE.boardRadius,
    PALETTE.boardThickness,
    48,
  );
  // Cylinders stand on +Y, so the face is already the XZ plane the dabs and
  // chips are laid out in; this just pulls the near-far axis in to an oval.
  geometry.scale(1, 1, PALETTE.boardOvalScale);

  const board = new Mesh(
    geometry,
    new MeshStandardMaterial({
      color: new Color(PALETTE.boardColor),
      roughness: PALETTE.boardRoughness,
      metalness: 0,
    }),
  );
  board.name = 'PaletteBoard';
  return board;
}

/**
 * The optional `paletteBoard` GLB, measured and rescaled to the same footprint
 * as the primitive oval — the measure-the-art trick TargetSystem and
 * EaselSystem both use, so swapping the model never needs a code change.
 * Returns undefined when no such asset is registered, which is the shipping
 * case until the ROUND3-PALETTE-ASSET manifest entry below is uncommented.
 */
function loadPaletteBoardModel(): Object3D | undefined {
  let source: Object3D | undefined;
  try {
    source = AssetManager.getGLTF(PALETTE_BOARD_ASSET_KEY)?.scene;
  } catch {
    // AssetManager not initialised, or the key is absent.
    return undefined;
  }
  if (!source) return undefined;

  const model = source.clone(true);
  const box = new Box3().setFromObject(model);
  const size = box.getSize(new Vector3());

  // Lay the model's thinnest axis onto the board normal (+Y) — the shipped
  // GLB is a slab thin along Z, and loading it as-is stood the board on edge
  // against its own dabs (round 7). Then re-measure in the rotated pose.
  const thin = thinnestAxis(size.x, size.y, size.z);
  if (thin === 2) model.rotation.x = -Math.PI / 2;
  else if (thin === 0) model.rotation.z = Math.PI / 2;
  model.updateMatrixWorld(true);
  box.setFromObject(model);
  box.getSize(size);
  const centre = box.getCenter(new Vector3());

  const fit = (PALETTE.boardRadius * 2) / (size.x || 1);
  model.scale.setScalar(fit);
  // Re-seat the art so its centre is the root's origin and its top face is the
  // plane the dabs sit on, whatever origin the exporter happened to choose.
  model.position.set(
    -centre.x * fit,
    -centre.y * fit + PALETTE.boardThickness / 2 - (size.y * fit) / 2,
    -centre.z * fit,
  );

  const holder = new Group();
  holder.name = 'PaletteBoard';
  holder.add(model);
  return holder;
}

/**
 * The silhouette for one ammo chip.
 *
 * Shape was the *only* cue in rounds 3-4 ("the board is far too small to
 * letter") and the field report was that the row looked bad and read as
 * nothing. Round 5 keeps the silhouettes but demotes them to the third cue
 * behind an identity colour and an actual printed label — three redundant ways
 * to tell five small objects apart, which is about right for something you
 * glance at on your own wrist mid-throw.
 */
function buildChipShape(
  spec: PaletteChipSpec,
  material: MeshStandardMaterial,
): Object3D {
  const r = PALETTE.chipRadius;

  // Style first: a web chip is a web chip whatever kind it nominally carries.
  if (spec.style === BallStyle.Web) {
    // A web ball: a small sphere caged in two crossed rings, i.e. the thing
    // that comes out of the shooter rather than the shooter itself. The
    // shooter would have been unreadable at 13 mm.
    const group = new Group();
    group.add(new Mesh(new SphereGeometry(r * 0.6, 16, 12), material));
    const ringGeometry = new TorusGeometry(r * 1.0, r * 0.1, 6, 20);
    for (let i = 0; i < 2; i++) {
      const ring = new Mesh(ringGeometry, material);
      // Torus is authored in the XY plane. One ring stands upright across the
      // board, the other stands upright along it; crossed, they read as a cage.
      ring.rotation.y = i === 0 ? 0 : Math.PI / 2;
      group.add(ring);
    }
    return group;
  }

  switch (spec.kind) {
    case BallKind.Bouncy: {
      // A ball wearing a hoop: reads as "this one comes back at you".
      const group = new Group();
      group.add(new Mesh(new SphereGeometry(r * 0.72, 16, 12), material));
      const ring = new Mesh(
        new TorusGeometry(r * 1.05, r * 0.16, 8, 24),
        material,
      );
      // Torus is authored in the XY plane; lay it flat in the board's plane.
      ring.rotation.x = -Math.PI / 2;
      group.add(ring);
      return group;
    }

    case BallKind.Sticky:
      // Flat faces read as "this one stops dead where it lands".
      return new Mesh(new BoxGeometry(r * 1.7, r * 1.7, r * 1.7), material);

    case BallKind.Splash:
      // Faceted and spiky: a burst, mid-shatter.
      return new Mesh(new IcosahedronGeometry(r * 1.15, 0), material);

    default:
      return new Mesh(new SphereGeometry(r, 16, 12), material);
  }
}

/**
 * A tiny printed label to lie on the board behind one chip.
 *
 * Everything here happens **once, at startup**, which is the licence for the
 * offscreen canvas, the string work and the per-label material: five labels
 * baked during World.create cost nothing a player can perceive, and the
 * alternative (an MSDF text mesh per chip) would drag the whole uikit text
 * pipeline into an object 9 mm tall.
 *
 * White with a soft dark outline, on transparency, so it stays legible over the
 * warm wooden board and over whatever passthrough is behind it. Unlit
 * (MeshBasicMaterial), because a label that dimmed when the player turned away
 * from a window would be a label that stopped working.
 *
 * Returns a plain Object3D and **never an entity**: labels must not be pokeable
 * or the fingertip aimed at STICKY would land on the word instead of the cube.
 */
function buildChipLabel(text: string): Object3D | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = PALETTE.chipLabelPxW;
  canvas.height = PALETTE.chipLabelPxH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  // Condensed first, because SPLASH and NORMAL have to fit the same 36 mm as
  // WEB; the fallbacks are only there so a headset browser without the
  // condensed faces still renders something rather than a default serif.
  ctx.font = `bold ${Math.round(h * 0.66)}px "Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Rounded joins stop the outline growing spikes off the corners of the caps.
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = Math.max(2, Math.round(h * 0.16));
  ctx.strokeStyle = 'rgba(10, 10, 14, 0.85)';
  ctx.strokeText(text, w / 2, h / 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, w / 2, h / 2);

  const texture = new CanvasTexture(canvas);
  // 2D canvas pixels are sRGB; unmarked, three would treat them as linear and
  // the white would come out grey.
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;

  const mesh = new Mesh(
    new PlaneGeometry(PALETTE.chipLabelWidth, PALETTE.chipLabelHeight),
    new MeshBasicMaterial({
      map: texture,
      transparent: true,
      // The board is right underneath and the chip is right next to it; writing
      // depth would make the label punch a hole in one or the other depending
      // on draw order.
      depthWrite: false,
    }),
  );
  mesh.name = `ChipLabel_${text}`;
  // PlaneGeometry faces +Z; the board's face is +Y, so lay it down. The quarter
  // turn also maps the text's own up-axis onto the board's -Z, i.e. toward the
  // far edge — which is "up" when you are looking at your own palm.
  mesh.rotation.x = -Math.PI / 2;
  // Drawn after the board and the chips, so the outline never loses a fight
  // with a co-planar surface.
  mesh.renderOrder = 2;
  return mesh;
}

/**
 * Creates the wrist palette: one root entity carrying a flat board, four
 * glossy paint dabs curving round its far edge, and a row of five ammo chips
 * with printed labels along the near edge by the wrist. Everything is laid out
 * in the root's own XZ plane, face up, so it all inherits whatever pose
 * WristPaletteSystem copies from the left grip each frame.
 *
 * Round 1 pinned sixteen combined colour+kind orbs to fixed world coordinates,
 * out of reach for anyone not standing where the developer stood. Round 2
 * strapped that grid to the wrist. Round 3 made it an actual palette you tap:
 * four dabs for colour, four chips for kind. Round 5 adds the fifth chip —
 * WEB, which loads webbing instead of paint and is the whole reason there is no
 * Web *phase* any more — plus the colours and labels the field asked for after
 * round 4's silhouette-only row "looked bad".
 *
 * Nine pressables now, and every one carries PokeInteractable as well as the
 * ray and grab tags, so a fingertip touch selects exactly like a squeeze always
 * has. The labels are deliberately NOT pressable: they are plain meshes hung
 * off the root, so a poke aimed at a chip can never be swallowed by its caption.
 *
 * The first dab and the first chip are pre-highlighted, and both lists are
 * built in PALETTE_DAB_ORDER / PALETTE_CHIP_ORDER from the same constants
 * INITIAL_PALETTE_SELECTION seeds the signals from, so the highlight and the
 * ammo agree by construction on frame one.
 */
function seedWristPalette(world: World) {
  const rootGroup = new Group();
  rootGroup.name = 'WristPalette';
  // Decoration, not an entity: nothing queries the board, and keeping it a
  // plain child of the root means it can never be poked by accident.
  rootGroup.add(buildPaletteBoard());

  const root = world
    .createTransformEntity(rootGroup, {
      parent: world.sceneEntity,
      persistent: true,
    })
    .addComponent(PaletteRoot);

  /** Persistent like the root, so palette parts and root share a lifetime. */
  const attach = (object: Object3D) =>
    world.createTransformEntity(object, { parent: root, persistent: true });

  /** Every pressable wears all three pointer tags. */
  const makePressable = (object: Object3D) => {
    const entity = attach(object);
    // RayInteractable for completeness (GrabSystem denies the ray pointer on
    // grabbables anyway), PokeInteractable so a fingertip within 2 cm
    // auto-presses, and OneHandGrabbable so the round-2 squeeze/pinch still
    // works as a fallback. All three funnel into the single `pointerdown`
    // listener InputSystem attaches, which is what adds the `Pressed` tag
    // BallSpawnSystem selects off — so every route lands in the same place.
    entity.addComponent(Interactable);
    entity.addComponent(PokeInteractable);
    entity.addComponent(OneHandGrabbable, { rotate: false, translate: false });
    return entity;
  };

  // ---- Paint dabs, on an arc around the board's far edge --------------------
  //
  // One flattened sphere geometry shared by all four; only the material
  // differs. Flattening is baked in rather than applied as a mesh scale,
  // because the selection highlight overwrites the mesh scale outright.
  const dabGeometry: BufferGeometry = new SphereGeometry(
    PALETTE.dabRadius,
    20,
    14,
  );
  dabGeometry.scale(1, PALETTE.dabFlatten, 1);

  const dabCount = PALETTE_DAB_ORDER.length;
  const arcSpan = PALETTE.dabArcEndDeg - PALETTE.dabArcStartDeg;
  for (let i = 0; i < dabCount; i++) {
    const color = PALETTE_DAB_ORDER[i];
    const angle =
      (PALETTE.dabArcStartDeg +
        (dabCount > 1 ? (arcSpan * i) / (dabCount - 1) : arcSpan / 2)) *
      DEG_TO_RAD;

    const mesh = new Mesh(
      dabGeometry,
      new MeshStandardMaterial({
        // sRGB, like the HUD swatch (round 7) — see srgbToLinear in types.ts.
        color: new Color().setRGB(color[0], color[1], color[2], SRGBColorSpace),
        roughness: PALETTE.dabRoughness,
        metalness: 0,
      }),
    );
    // Angle 0 points at the far (-Z) edge and sweeps toward +X.
    mesh.position.set(
      Math.sin(angle) * PALETTE.dabArcRadius,
      PALETTE.boardThickness / 2,
      -Math.cos(angle) * PALETTE.dabArcRadius,
    );
    if (i === 0) mesh.scale.setScalar(SELECTED_SLOT_SCALE);

    makePressable(mesh).addComponent(PaintDab, {
      color: [color[0], color[1], color[2], color[3]],
    });
  }

  // ---- Ammo chips, in a row along the board's near edge ---------------------
  //
  // One material per chip, never a shared one. Two reasons, both round 5: each
  // chip carries its own identity colour, and the selected chip's emissive lift
  // is a property of that material — share it and picking BOUNCY would light
  // the whole row.
  const chipCount = PALETTE_CHIP_ORDER.length;
  const labelZ =
    PALETTE.chipRowOffset -
    PALETTE.chipRadius -
    PALETTE.chipLabelGap -
    PALETTE.chipLabelHeight / 2;

  for (let i = 0; i < chipCount; i++) {
    const spec = PALETTE_CHIP_ORDER[i];
    const chipColor = new Color(spec.color);
    const material = new MeshStandardMaterial({
      color: chipColor,
      roughness: PALETTE.chipRoughness,
      metalness: 0,
      // Baked here and never changed; BallSpawnSystem only moves the intensity,
      // so a chip always glows in its own colour rather than a generic white.
      emissive: chipColor.clone(),
      emissiveIntensity: i === 0 ? PALETTE.chipSelectedEmissive : 0,
    });

    const x = (i - (chipCount - 1) / 2) * PALETTE.chipSpacing;
    const shape = buildChipShape(spec, material);
    shape.position.set(
      x,
      PALETTE.boardThickness / 2 + PALETTE.chipRadius * PALETTE.chipLift,
      PALETTE.chipRowOffset,
    );
    if (i === 0) shape.scale.setScalar(SELECTED_SLOT_SCALE);

    makePressable(shape).addComponent(KindChip, {
      kind: spec.kind,
      style: spec.style,
    });

    // The label is a plain child of the root group, exactly like the board:
    // decoration, not an entity, so nothing can poke it by accident.
    const label = buildChipLabel(spec.label);
    if (label) {
      label.position.set(x, PALETTE.boardThickness / 2 + PALETTE.chipLabelLift, labelZ);
      rootGroup.add(label);
    }
  }

  // ---- Launcher mode pads (round 8): HAND / BLASTER / WEB -------------------
  //
  // Three pads across the middle of the board, between the dab arc and the
  // chip labels. Same three pointer tags as everything else on the palette;
  // BallSpawnSystem selects and relights them from globals.blasterMode.
  const modeCount = BLASTER_MODE_ORDER.length;
  const modeGeometry = new CylinderGeometry(
    PALETTE.modePadRadius,
    PALETTE.modePadRadius,
    PALETTE.modePadHeight,
    24,
  );
  for (let i = 0; i < modeCount; i++) {
    const mode = BLASTER_MODE_ORDER[i];
    const accent = new Color(PALETTE.modePadColors[i]);
    const mesh = new Mesh(
      modeGeometry,
      new MeshStandardMaterial({
        color: accent,
        roughness: 0.3,
        metalness: 0.2,
        emissive: accent.clone(),
        emissiveIntensity: 0,
      }),
    );
    const x = (i - (modeCount - 1) / 2) * PALETTE.modePadSpacing;
    mesh.position.set(
      x,
      PALETTE.boardThickness / 2 + PALETTE.modePadHeight / 2,
      PALETTE.modePadRowOffset,
    );
    makePressable(mesh).addComponent(BlasterModePad, { mode });

    const label = buildChipLabel(BLASTER_MODE_LABELS[mode]);
    if (label) {
      label.position.set(
        x,
        PALETTE.boardThickness / 2 + PALETTE.chipLabelLift,
        PALETTE.modePadRowOffset +
          PALETTE.modePadRadius +
          PALETTE.chipLabelGap +
          PALETTE.chipLabelHeight / 2,
      );
      rootGroup.add(label);
    }
  }
}

/**
 * Creates the singleton SplatterField entity. It gets an XRAnchor so the
 * pool of decal quads stays locked to the real room across WebXR tracking
 * drift. SplatterSystem.init() attaches the InstancedMesh under this entity.
 */
function seedSplatterField(world: World) {
  const entity = world.createTransformEntity();
  entity.addComponent(SplatterField, {});
  entity.addComponent(XRAnchor);
  // Whole instanced splat mesh under this entity gets depth-occluded by
  // real-world geometry when running on a device with depth-sensing.
  entity.addComponent(DepthOccludable);
}

/**
 * Creates the UIKitML HUD panel entity, head-locked via Follower so it stays
 * visible regardless of look direction.
 *
 * The panel now carries the whole front-end — title screen, live HUD, round
 * summary, chill controls, and a persistent footer — so it is both taller and
 * further away than the Wave A strip. PanelUISystem fits the document inside
 * maxWidth × maxHeight preserving aspect, and only one phase section is ever
 * displayed, so the rendered panel shrinks by itself once a round is running.
 *
 * Seeded with the menu placement from config; HudSystem re-docks it low and
 * small the moment a round (or Chill mode) starts, so the panel stops sitting
 * in the firing line.
 */
function seedHud(world: World) {
  const entity = world
    .createTransformEntity()
    .addComponent(PanelUI, {
      config: './ui/hud.json',
      // HudSystem rewrites these per phase (see HUD.menuScale / HUD.playScale);
      // this is the menu size the panel opens at.
      maxWidth: HUD.baseWidth * HUD.menuScale,
      maxHeight: HUD.baseHeight * HUD.menuScale,
    })
    // Required for XR clicks: InputSystem only feeds RayInteractable entities
    // to the controller ray's intersection set, so without this the panel's
    // buttons work with a mouse in 2D but are unreachable in the headset.
    .addComponent(Interactable)
    .addComponent(Follower, {
      target: world.player.head,
      offsetPosition: [
        HUD.menuOffset[0],
        HUD.menuOffset[1],
        HUD.menuOffset[2],
      ],
      behavior: HUD.menuFaceTarget
        ? FollowBehavior.FaceTarget
        : FollowBehavior.PivotY,
      maxAngle: HUD.menuMaxAngle,
      tolerance: HUD.menuTolerance,
      speed: HUD.menuSpeed,
    });
  if (entity.object3D) {
    entity.object3D.position.set(0, 1.6, HUD.menuOffset[2]);
  }
}

/** RENDER.toneMapping spellings → three's renderer constants. */
const TONE_MAPPINGS: Record<ToneMappingName, ToneMapping> = {
  none: NoToneMapping,
  neutral: NeutralToneMapping,
  aces: ACESFilmicToneMapping,
  agx: AgXToneMapping,
};

/**
 * Round 7: the scene's lighting and tone curve.
 *
 * IWSDK's `defaultLighting` (left on in World.create below) attaches a
 * DomeGradient + IBLGradient pair to the level root. The dome is a background
 * that EnvironmentSystem already hides in passthrough AR; the gradient IBL is
 * nearly uniform, which is why every PBR material used to read as flat pastel
 * plastic — a uniform environment has no structure to shade or reflect.
 *
 * Adding an IBLTexture to the same root replaces only the *lighting*:
 * EnvironmentSystem prefers IBLTexture over IBLGradient, and IBLTexture writes
 * `scene.environment` and nothing else — no background, no dome, nothing drawn
 * over the real room. 'room' is three's RoomEnvironment, PMREM'd once by IWSDK
 * itself (a few ms at boot, no download); its world-locked rotation is kept
 * stable across headset recentres by EnvironmentSystem.
 *
 * Per-frame cost: none beyond what the gradient already cost — the shaders
 * sample one PMREM either way. Tone mapping is a handful of ALU per fragment.
 *
 * Must run after World.create resolves: that is when LevelSystem has made the
 * real level root (the one carrying LevelRoot, which EnvironmentSystem queries).
 */
function setupEnvironment(world: World) {
  const renderer = world.renderer;
  renderer.toneMapping = TONE_MAPPINGS[RENDER.toneMapping] ?? NoToneMapping;
  renderer.toneMappingExposure = RENDER.exposure;

  // Empty source = keep IWSDK's gradient, i.e. the pre-round-7 lighting.
  if (!RENDER.iblSource) return;
  world.activeLevel.value.addComponent(IBLTexture, {
    src: RENDER.iblSource,
    intensity: RENDER.iblIntensity,
    rotation: [0, RENDER.iblRotationYDeg * DEG_TO_RAD, 0],
  });
}

// The landing overlay renders immediately — World.create takes seconds to
// boot Havok and stream critical assets, and the page should never look dead.
const landing = initLanding();

World.create(document.getElementById('scene-container') as HTMLDivElement, {
  render: {
    fov: 60,
    near: 0.05,
    far: 100,
    defaultLighting: true,
  },
  // Every URL here must exist on disk — a missing one makes World.create
  // reject. Critical assets block World.create; background ones stream in
  // behind it.
  //
  // robot and splatTexture are critical because both are read synchronously
  // during registerSystem: TargetSystem measures the GLTF to size its pool and
  // SplatterSystem probes for the texture when it builds its material. The
  // audio buffers only have to be warm by the time a cue first plays.
  assets: {
    [ROBOT_ASSET_KEY]: {
      url: '/gltf/robot/robot.gltf',
      type: AssetType.GLTF,
      priority: 'critical',
    },
    [SPLAT_TEXTURE_KEY]: {
      url: '/textures/splat.png',
      type: AssetType.Texture,
      priority: 'critical',
    },
    // Critical for the same reason as splat.png: SplatterSystem probes for it
    // synchronously when it builds the web pool's material in init().
    [WEB_SPLAT_TEXTURE_KEY]: {
      url: '/textures/web-splat.png',
      type: AssetType.Texture,
      priority: 'critical',
    },
    fire: { url: AUDIO.fire, type: AssetType.Audio, priority: 'background' },
    splat: { url: AUDIO.splat, type: AssetType.Audio, priority: 'background' },
    pop: { url: AUDIO.pop, type: AssetType.Audio, priority: 'background' },
    countdown: {
      url: AUDIO.countdown,
      type: AssetType.Audio,
      priority: 'background',
    },
    gameOver: {
      url: AUDIO.gameOver,
      type: AssetType.Audio,
      priority: 'background',
    },
    chime: { url: AUDIO.chime, type: AssetType.Audio, priority: 'background' },
    uiClick: {
      url: AUDIO.uiClick,
      type: AssetType.Audio,
      priority: 'background',
    },
    chillMusic: {
      url: AUDIO.chillMusic,
      type: AssetType.Audio,
      priority: 'background',
    },
    thwip: { url: AUDIO.thwip, type: AssetType.Audio, priority: 'background' },
    webHit: {
      url: AUDIO.webHit,
      type: AssetType.Audio,
      priority: 'background',
    },
    // Round 8 enter-AR intro. Background: IntroSystem only reads it when the
    // session first turns visible, by which time it has long streamed in (and
    // the intro still plays its splat + tagline if it somehow has not).
    [INTRO_LOGO_KEY]: {
      url: '/brand/logo.png',
      type: AssetType.Texture,
      priority: 'background',
    },
    // ROUND2-EASEL-ASSET — a Higgsfield-generated easel (image_to_3d). Must be
    // an EMPTY easel: round 2's model was generated from a photo of an easel
    // holding a canvas, which baked a second, unpaintable board into the stand.
    // The paintable canvas is always built in code, so the painting keeps
    // working even if this asset is removed (EaselSystem falls back to its
    // primitive frame when the GLTF is not loaded yet or missing).
    [EASEL_ASSET_KEY]: {
      url: '/gltf/easel.glb',
      type: AssetType.GLTF,
      priority: 'background',
    },
    // ROUND3-PALETTE-ASSET — a Higgsfield-modelled kidney-shaped wooden
    // palette board (image_to_3d). The dabs and chips are always built in
    // code and parented to the same root, so tapping keeps working whatever
    // the art is (buildPaletteBoard falls back to a primitive oval if this
    // is ever removed).
    [PALETTE_BOARD_ASSET_KEY]: {
      url: '/gltf/palette-board.glb',
      type: AssetType.GLTF,
      priority: 'background',
    },
    // ROUND4-WEBSHOOTER-ASSET — Higgsfield-modelled wrist web shooter
    // (image_to_3d). Round 7 ships a code-built forearm gauntlet instead
    // (the GLB is a ring cuff, which cannot lie along the forearm), so the
    // model is only streamed when WEB.shooterUseGlb asks for it.
    //
    // Must be 'critical' when it is used, unlike the easel and the palette
    // board: the shooters are built in WebShooterSystem.init(), which runs
    // during registerSystem, so a background-streamed model would always miss
    // its own construction.
    ...(WEB.shooterUseGlb
      ? {
          [WEB_SHOOTER_ASSET_KEY]: {
            url: '/gltf/web-shooter.glb',
            type: AssetType.GLTF,
            priority: 'critical' as const,
          },
        }
      : {}),
  },
  xr: {
    sessionMode: SessionMode.ImmersiveAR,
    offer: 'always',
    features: {
      handTracking: true,
      anchors: true,
      planeDetection: true,
      meshDetection: true,
      depthSensing: true,
      layers: true,
    },
  },
  features: {
    locomotion: false,
    // Object form is load-bearing: the boolean shorthand leaves GrabSystem's
    // useHandPinchForGrab at its false default, which silently kills
    // hand-tracking pinch-to-grab — i.e. wrist-palette ammo selection and
    // easel grabbing for hand users (firing uses the separate select action
    // and never noticed).
    grabbing: { useHandPinchForGrab: true },
    physics: true,
    sceneUnderstanding: true,
    // environmentRaycast deliberately off: robots spawn on a ring around the
    // player, not via hit-test placement, so the system would be pure overhead.
    spatialUI: {
      forwardHtmlEvents: true,
      preferredColorScheme: 'dark',
    },
  },
}).then((world) => {
  // Register custom components the ECS needs to know about before the first
  // entity is created.
  world
    .registerComponent(Ball)
    .registerComponent(PaintDab)
    .registerComponent(KindChip)
    // Built by WebShooterSystem.init() during registerSystem below, so it has
    // to be known to the ECS before that runs.
    .registerComponent(WebModePad)
    .registerComponent(BlasterModePad)
    .registerComponent(PaletteRoot)
    .registerComponent(SplatterField)
    .registerComponent(Target)
    .registerComponent(Easel)
    .registerComponent(FloorGuard)
    .registerComponent(Gauntlet)
    .registerComponent(WebStrand);

  // Signals first: registerSystem runs each System.init() synchronously, and
  // those inits bind the globals below.
  seedGlobals(world);

  // Lighting + tone curve. EnvironmentSystem picks the IBLTexture up on its
  // next update and PMREMs it once.
  setupEnvironment(world);

  // Register custom systems with explicit priorities so they run in a
  // predictable order after IWSDK's built-in simulation/input systems:
  // read real-world geometry, lay the backstop floor, notice an unscanned room,
  // move the wrist palette, aim the web shooters, fire, simulate flight, hit
  // robots, paint the room, paint the easel, score, draw the HUD, play the
  // feedback, flush events.
  //
  // The scoring/HUD/feedback trio sits above every event producer and below
  // EventFlushSystem, so each frame's events are produced, consumed once, and
  // cleared in that order. EaselSystem joins that group of consumers at 16.
  //
  // Every one of these is above IWSDK's InputSystem (priority -4), which is
  // what WebShooterSystem depends on for same-frame hand joint transforms.
  world
    .registerSystem(WorldCollisionSystem, { priority: 5 })
    .registerSystem(FloorGuardSystem, { priority: 6 })
    .registerSystem(SceneScanSystem, { priority: 7 })
    .registerSystem(WristPaletteSystem, { priority: 8 })
    // Round 8: the gauntlets pose both arms first (9) and publish this frame's
    // muzzles; gestures/strands (10) and the trigger (11) read them. Gauntlet
    // must also be REGISTERED before WebShooter: its init builds the spinneret
    // the web selector pads are parented into.
    .registerSystem(GauntletSystem, { priority: 9 })
    .registerSystem(WebShooterSystem, { priority: 10 })
    .registerSystem(BallSpawnSystem, { priority: 11 })
    .registerSystem(BallFlightSystem, { priority: 12 })
    .registerSystem(TargetSystem, { priority: 14 })
    .registerSystem(SplatterSystem, { priority: 15 })
    .registerSystem(EaselSystem, { priority: 16 })
    .registerSystem(GameStateSystem, { priority: 30 })
    .registerSystem(HudSystem, { priority: 35 })
    .registerSystem(FeedbackSystem, { priority: 36 })
    // Round 7 particle juice: another read-only event consumer, so it sits in
    // the same consumer band, after the sound it decorates and before the flush.
    .registerSystem(VfxSystem, { priority: 37 })
    // Round 8 enter-AR intro. A pure consumer like the trio above: it reads
    // input edge state (pinch/trigger = skip) and the visibility signal, and
    // only ever toggles the HUD's visibility — never its state or input — so
    // it runs after HudSystem (35) has written the panel this frame and
    // before the event flush. Emits no events.
    .registerSystem(IntroSystem, { priority: 38 })
    .registerSystem(EventFlushSystem, { priority: 90 });

  seedWristPalette(world);
  seedSplatterField(world);
  seedHud(world);

  // Landing overlay: ENTER AR now works, and the overlay hides while an
  // immersive session runs (it returns when the player exits to the browser).
  landing.bindWorld(world);
  world.visibilityState.subscribe((state) => {
    landing.setVisible(state === VisibilityState.NonImmersive);
  });

  // Dev builds only: expose the world so a headless Playwright run (see
  // scripts/headless-verify.mjs) can drive state the IWER emulator cannot
  // reach — the cloud sessions this repo is worked in have no MCP relay.
  // Vite statically replaces import.meta.env.DEV, so production strips it.
  if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
    const debug = window as unknown as {
      __PB_WORLD?: World;
      __PB_THREE?: Record<string, unknown>;
    };
    debug.__PB_WORLD = world;
    // The same three.js instance the app renders with, so a harness can add
    // debug geometry (e.g. joint markers when the hand meshes cannot stream).
    debug.__PB_THREE = {
      Mesh,
      SphereGeometry,
      CylinderGeometry,
      MeshBasicMaterial,
      Vector3,
    };
  }
});
