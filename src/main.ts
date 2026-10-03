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
  IBLTexture,
  NoToneMapping,
  NeutralToneMapping,
  ACESFilmicToneMapping,
  AgXToneMapping,
  AdditiveBlending,
  BufferAttribute,
  CatmullRomCurve3,
  CircleGeometry,
  ExtrudeGeometry,
  MeshPhysicalMaterial,
  Path,
  Shape,
  ShapeGeometry,
  TubeGeometry,
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
import {
  Target,
  TargetSystem,
  RobotDepthSensingSystem,
  ROBOT_ASSET_KEY,
} from './systems/TargetSystem';
import { GameStateSystem } from './systems/GameStateSystem';
import { HudSystem } from './systems/HudSystem';
import { TutorialSystem } from './systems/TutorialSystem';
import { CoachSystem } from './systems/CoachSystem';
import { FeedbackSystem } from './systems/FeedbackSystem';
import {
  PaletteRoot,
  WristPaletteSystem,
  PALETTE_BOARD_ASSET_KEY,
  PALETTE_VISUALS_KEY,
  paletteLabelText,
  thinnestAxis,
} from './systems/WristPaletteSystem';
import type { PaletteVisuals } from './systems/WristPaletteSystem';
import { Easel, EaselSystem, EASEL_ASSET_KEY } from './systems/EaselSystem';
import { SceneScanSystem } from './systems/SceneScanSystem';
import { VfxSystem } from './systems/VfxSystem';
import { IntroSystem, INTRO_LOGO_KEY } from './systems/IntroSystem';
import { PipSystem } from './systems/PipSystem';
import { initLanding } from './landing/landing';
import { AUDIO, BLASTER, GAME, HUD, PALETTE, RENDER, SPLOTBOTS, TARGETS, WEB } from './config';
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
  isPrintableAscii,
  rampColor,
  srgbToLinear,
  superellipsePoint,
  PipFocus,
  TutorialStep,
} from './types';
import type { PaletteChipSpec, RoundStats } from './types';
import {
  LEGACY_SKIN_STORAGE_KEY,
  readWithLegacyFallback,
  safeStorage,
} from './storage-migrate';

const DEG_TO_RAD = Math.PI / 180;

/** The stored skin index, or 0. Never throws (private mode, blocked storage). */
function readStoredSkin(): number {
  try {
    // Round 9: falls back to the pre-rebrand key and copies it forward.
    const raw = readWithLegacyFallback(
      safeStorage(),
      BLASTER.skinStorageKey,
      LEGACY_SKIN_STORAGE_KEY,
    );
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

  // Round 9: onboarding + coaching + results.
  // TutorialSystem owns tutorialStep / tutorialLine / pipFocus; the HUD card
  // and Pip's speech bubble read them. GameStateSystem owns `practice` (the
  // tutorial's clock-stopped Playing) and `roundStats` (the GameOver card's
  // numbers). CoachSystem owns `coachLine` (first-encounter tips).
  globals.tutorialStep = signal<number>(TutorialStep.Off);
  globals.tutorialLine = signal('');
  globals.pipFocus = new PipFocus();
  globals.practice = signal(false);
  globals.roundStats = signal<RoundStats | null>(null);
  globals.coachLine = signal('');
}

/**
 * The palette board, in the style PALETTE.boardStyle asks for.
 *
 * - 'holo' (round 8 default): the techno-paint glass slab, built here.
 * - 'glb': the Higgsfield palette-board.glb if it has streamed in, else holo.
 * - 'wood': the round-3 primitive oval.
 *
 * The board is decoration only — every pressable is a sibling entity under
 * the same root — so swapping styles can never break selection.
 */
function buildPaletteBoard(visuals: PaletteVisuals): Object3D {
  if (PALETTE.boardStyle === 'glb') {
    const modelled = loadPaletteBoardModel();
    if (modelled) return modelled;
  }
  if (PALETTE.boardStyle === 'wood') return buildWoodenBoard();
  return buildHoloBoard(visuals);
}

/**
 * The round-3 board: a cylinder squashed into an oval. The squash is baked
 * into the geometry rather than a mesh scale so the normals stay right.
 */
function buildWoodenBoard(): Object3D {
  const geometry = new CylinderGeometry(
    PALETTE.boardRadius,
    PALETTE.boardRadius,
    PALETTE.boardThickness,
    48,
  );
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

/** Outline points of the holo board (a superellipse), `inset` metres in. */
function holoOutline(inset: number, count: number): Array<[number, number]> {
  const a = PALETTE.boardRadius - inset;
  const b = PALETTE.boardRadius * PALETTE.boardOvalScale - inset;
  const points: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    points.push(
      superellipsePoint((i / count) * Math.PI * 2, a, b, PALETTE.holoSquareness, [0, 0]),
    );
  }
  return points;
}

/**
 * A closed neon tube along the board's outline, coloured along its length by
 * PALETTE.holoEdgeColors. Outline (x, y) maps to board (x, -z): the shape's
 * +Y is the board's far (-Z) edge, the same mapping the extruded slab uses.
 */
function buildNeonTube(
  outline: Array<[number, number]>,
  y: number,
  radius: number,
  material: MeshBasicMaterial,
): Mesh {
  const curve = new CatmullRomCurve3(
    outline.map(([x, z]) => new Vector3(x, y, -z)),
    true,
  );
  const tubular = 220;
  const radial = 6;
  const geometry = new TubeGeometry(curve, tubular, radius, radial, true);
  const colors = new Float32Array(geometry.attributes.position.count * 3);
  const rgb: [number, number, number] = [1, 1, 1];
  for (let i = 0; i <= tubular; i++) {
    rampColor(i / tubular, PALETTE.holoEdgeColors, rgb);
    // Vertex colours are linear in three; the ramp is authored in sRGB.
    const r = srgbToLinear(rgb[0]);
    const g = srgbToLinear(rgb[1]);
    const b = srgbToLinear(rgb[2]);
    for (let j = 0; j <= radial; j++) {
      const k = (i * (radial + 1) + j) * 3;
      colors[k] = r;
      colors[k + 1] = g;
      colors[k + 2] = b;
    }
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  return new Mesh(geometry, material);
}

/** A cartoon paint splat: a body, lobes and a couple of flung droplets. */
function splatShapes(radius: number, seed: number): Shape[] {
  // Deterministic jitter, so every boot draws the same splat.
  let state = seed;
  const rand = () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
  const shapes: Shape[] = [];
  const disc = (x: number, y: number, r: number) => {
    const s = new Shape();
    s.absarc(x, y, r, 0, Math.PI * 2, false);
    shapes.push(s);
  };
  disc(0, 0, radius * 0.62);
  const lobes = 7;
  for (let i = 0; i < lobes; i++) {
    const angle = (i / lobes) * Math.PI * 2 + rand() * 0.6;
    const dist = radius * (0.55 + rand() * 0.25);
    disc(Math.cos(angle) * dist, Math.sin(angle) * dist, radius * (0.16 + rand() * 0.14));
  }
  for (let i = 0; i < 3; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = radius * (1.05 + rand() * 0.35);
    disc(Math.cos(angle) * dist, Math.sin(angle) * dist, radius * (0.06 + rand() * 0.07));
  }
  return shapes;
}

/**
 * The round-8 holo board: a translucent dark-glass squircle with a graphite
 * bezel, a neon line running round its face (crisp line + additive halo, the
 * halo shimmers — see WristPaletteSystem), and paint splats on the far corners.
 */
function buildHoloBoard(visuals: PaletteVisuals): Object3D {
  const t = PALETTE.boardThickness;
  const group = new Group();
  group.name = 'PaletteBoard';

  // ---- The slab --------------------------------------------------------------
  const shape = new Shape();
  holoOutline(0, 128).forEach(([x, y], i) =>
    i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y),
  );
  shape.closePath();
  const slabGeometry = new ExtrudeGeometry(shape, {
    depth: t,
    bevelEnabled: false,
    curveSegments: 1,
  });
  // Extrusion runs along +Z from 0; stand it on +Y, centred like the old
  // cylinder (face at +t/2) so every height in PALETTE still holds.
  slabGeometry.rotateX(-Math.PI / 2);
  slabGeometry.translate(0, -t / 2, 0);
  const face = new MeshPhysicalMaterial({
    color: new Color(PALETTE.holoFaceColor),
    // Satin rather than mirror: a sharp clearcoat picked up the IBL's light
    // panels as a white smear across half the board.
    roughness: 0.42,
    metalness: 0.1,
    clearcoat: 0.45,
    clearcoatRoughness: 0.38,
    transparent: true,
    opacity: PALETTE.holoFaceOpacity,
  });
  const bezel = new MeshStandardMaterial({
    color: new Color(PALETTE.holoBezelColor),
    roughness: 0.32,
    metalness: 0.75,
  });
  // ExtrudeGeometry groups: 0 = the two caps, 1 = the side wall.
  const slab = new Mesh(slabGeometry, [face, bezel]);
  slab.name = 'PaletteSlab';
  group.add(slab);

  // ---- Neon edge -------------------------------------------------------------
  const outline = holoOutline(PALETTE.holoEdgeInset, 160);
  const lineMaterial = new MeshBasicMaterial({
    vertexColors: true,
    toneMapped: false,
    transparent: true,
    opacity: 1,
  });
  const glowMaterial = new MeshBasicMaterial({
    vertexColors: true,
    toneMapped: false,
    transparent: true,
    opacity: PALETTE.holoGlowOpacity,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const line = buildNeonTube(outline, t / 2 + PALETTE.holoEdgeRadius * 0.5, PALETTE.holoEdgeRadius, lineMaterial);
  line.name = 'PaletteNeonLine';
  const glow = buildNeonTube(outline, t / 2 + PALETTE.holoEdgeRadius * 0.5, PALETTE.holoGlowRadius, glowMaterial);
  glow.name = 'PaletteNeonGlow';
  glow.renderOrder = 1;
  group.add(line, glow);
  visuals.edgeLine = lineMaterial;
  visuals.edgeGlow = glowMaterial;

  // ---- Paint splats on the far corners ---------------------------------------
  const corner = superellipsePoint(
    Math.PI / 4,
    PALETTE.boardRadius,
    PALETTE.boardRadius * PALETTE.boardOvalScale,
    PALETTE.holoSquareness,
    [0, 0],
  );
  PALETTE.holoSplatColors.slice(0, 2).forEach((hex, i) => {
    const side = i === 0 ? 1 : -1;
    const splat = new Mesh(
      new ShapeGeometry(splatShapes(0.011, 11 + i * 7)),
      new MeshBasicMaterial({
        color: new Color(hex),
        toneMapped: false,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      }),
    );
    splat.name = `PaletteSplat_${i}`;
    splat.rotation.x = -Math.PI / 2;
    // Tucked in from the far corner, clear of the end dabs.
    splat.position.set(side * corner[0] * 0.86, t / 2 + 0.0004, -corner[1] * 0.86);
    splat.renderOrder = 1;
    group.add(splat);
  });

  return group;
}

/**
 * The optional `paletteBoard` GLB, measured and rescaled to the same footprint
 * as the primitive oval — the measure-the-art trick TargetSystem and
 * EaselSystem both use, so swapping the model never needs a code change.
 * Returns undefined when the asset is absent or has not streamed in yet.
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
  // GLB is a slab thin along Z (round 7). Then re-measure in the rotated pose.
  const thin = thinnestAxis(size.x, size.y, size.z);
  if (thin === 2) model.rotation.x = -Math.PI / 2;
  else if (thin === 0) model.rotation.z = Math.PI / 2;
  model.updateMatrixWorld(true);
  box.setFromObject(model);
  box.getSize(size);
  const centre = box.getCenter(new Vector3());

  const fit = (PALETTE.boardRadius * 2) / (size.x || 1);
  model.scale.setScalar(fit);
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
 * Shape is the third cue behind an identity colour and a printed label —
 * three redundant ways to tell five small objects apart, which is about right
 * for something you glance at on your own wrist mid-throw.
 */
function buildChipShape(
  spec: PaletteChipSpec,
  material: MeshStandardMaterial,
): Object3D {
  const r = PALETTE.chipRadius;

  // Style first: a web chip is a web chip whatever kind it nominally carries.
  if (spec.style === BallStyle.Web) {
    // A web ball: a small sphere caged in two crossed rings.
    const group = new Group();
    group.add(new Mesh(new SphereGeometry(r * 0.6, 20, 14), material));
    const ringGeometry = new TorusGeometry(r * 1.0, r * 0.1, 8, 28);
    for (let i = 0; i < 2; i++) {
      const ring = new Mesh(ringGeometry, material);
      ring.rotation.y = i === 0 ? 0 : Math.PI / 2;
      group.add(ring);
    }
    return group;
  }

  switch (spec.kind) {
    case BallKind.Bouncy: {
      // A ball wearing a hoop: reads as "this one comes back at you".
      const group = new Group();
      group.add(new Mesh(new SphereGeometry(r * 0.72, 20, 14), material));
      const ring = new Mesh(
        new TorusGeometry(r * 1.05, r * 0.16, 10, 32),
        material,
      );
      ring.rotation.x = -Math.PI / 2;
      group.add(ring);
      return group;
    }

    case BallKind.Sticky: {
      // Flat faces read as "this one stops dead where it lands". Softened
      // corners (a rounded box) so it sits in the same family as the rest.
      const geometry = new BoxGeometry(r * 1.7, r * 1.7, r * 1.7, 2, 2, 2);
      return new Mesh(geometry, material);
    }

    case BallKind.Splash:
      // Faceted and spiky: a burst, mid-shatter.
      return new Mesh(new IcosahedronGeometry(r * 1.15, 0), material);

    default:
      return new Mesh(new SphereGeometry(r, 20, 14), material);
  }
}

/**
 * A tiny printed label to lie on the board behind one chip or pad.
 *
 * Baked **once, at startup** into a CanvasTexture: white condensed caps with a
 * soft neon glow in the slot's own accent (the techno-paint look) and a thin
 * dark keyline, so it reads over the glass and over passthrough alike. Unlit,
 * because a label that dimmed when you turned from a window would stop working.
 *
 * Returns a plain Object3D and **never an entity**: labels must not be
 * pokeable or the fingertip aimed at STICKY would land on the word.
 */
function buildChipLabel(text: string, accent = '#48dbfb'): Object3D | undefined {
  if (!isPrintableAscii(text)) {
    console.warn(`[Splotopia] palette label "${text}" is not plain ASCII`);
  }
  const canvas = document.createElement('canvas');
  canvas.width = PALETTE.chipLabelPxW;
  canvas.height = PALETTE.chipLabelPxH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.font = `800 ${Math.round(h * 0.62)}px "Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  // Neon bloom first (two passes build it up), then the keyline, then the
  // white face on top.
  ctx.shadowColor = accent;
  ctx.shadowBlur = Math.round(h * 0.28);
  ctx.fillStyle = accent;
  ctx.fillText(text, w / 2, h / 2);
  ctx.fillText(text, w / 2, h / 2);
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(2, Math.round(h * 0.1));
  ctx.strokeStyle = 'rgba(6, 7, 12, 0.85)';
  ctx.strokeText(text, w / 2, h / 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, w / 2, h / 2);

  const texture = new CanvasTexture(canvas);
  // 2D canvas pixels are sRGB; unmarked, three would treat them as linear.
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;

  const mesh = new Mesh(
    new PlaneGeometry(PALETTE.chipLabelWidth, PALETTE.chipLabelHeight),
    new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  mesh.name = `ChipLabel_${text}`;
  // PlaneGeometry faces +Z; lay it on the board's +Y face, text-up toward the
  // far (-Z) edge — "up" when you look at your own palm.
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 2;
  return mesh;
}

/**
 * A glowing ring lying flat on the board face (well rims, chip and pad
 * sockets). Unlit and transparent so its opacity can carry selection and the
 * appear fade; never an entity.
 */
function buildGlowRing(
  radius: number,
  tube: number,
  color: Color,
  opacity: number,
): { mesh: Mesh; material: MeshBasicMaterial } {
  const material = new MeshBasicMaterial({
    color,
    toneMapped: false,
    transparent: true,
    opacity,
    depthWrite: false,
  });
  const mesh = new Mesh(new TorusGeometry(radius, tube, 6, 56), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 1;
  return { mesh, material };
}

/** A soft additive colour pool lying on the board face. */
function buildGlowDisc(
  radius: number,
  color: Color,
  opacity: number,
): { mesh: Mesh; material: MeshBasicMaterial } {
  const material = new MeshBasicMaterial({
    color,
    toneMapped: false,
    transparent: true,
    opacity,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new Mesh(new CircleGeometry(radius, 40), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 1;
  return { mesh, material };
}

/** A rounded capsule from (x, y0) to (x, y1), `w` wide, as one Shape. */
function capsuleShape(x: number, y0: number, y1: number, w: number): Shape {
  const r = w / 2;
  const s = new Shape();
  s.moveTo(x - r, y0);
  s.lineTo(x - r, y1);
  s.absarc(x, y1, r, Math.PI, 0, true);
  s.lineTo(x + r, y0);
  s.absarc(x, y0, r, 0, Math.PI, true);
  return s;
}

/** A filled polygon Shape from [x, y] pairs. */
function polyShape(points: ReadonlyArray<readonly [number, number]>): Shape {
  const s = new Shape();
  points.forEach(([x, y], i) => (i === 0 ? s.moveTo(x, y) : s.lineTo(x, y)));
  s.closePath();
  return s;
}

/**
 * The white icon printed on a launcher pad, authored in a unit box centred
 * on the origin (+Y = the icon's up). HAND is an open palm, BLASTER a paint
 * gun in profile, WEB a web.
 */
function modeIconShapes(mode: BlasterMode): Shape[] {
  if (mode === BlasterMode.Hand) {
    const palm = new Shape();
    palm.moveTo(-0.28, 0.04);
    palm.lineTo(0.28, 0.04);
    palm.lineTo(0.28, -0.22);
    palm.absarc(0.1, -0.22, 0.18, 0, -Math.PI / 2, true);
    palm.lineTo(-0.12, -0.4);
    palm.absarc(-0.12, -0.24, 0.16, -Math.PI / 2, -Math.PI, true);
    palm.closePath();
    const thumb = polyShape([
      [-0.28, -0.16],
      [-0.5, 0.04],
      [-0.42, 0.13],
      [-0.2, -0.04],
    ]);
    return [
      palm,
      thumb,
      capsuleShape(-0.215, 0.0, 0.3, 0.1),
      capsuleShape(-0.07, 0.0, 0.42, 0.1),
      capsuleShape(0.075, 0.0, 0.38, 0.1),
      capsuleShape(0.215, 0.0, 0.24, 0.1),
    ];
  }
  if (mode === BlasterMode.Paint) {
    const canister = new Shape();
    canister.absarc(-0.05, 0.3, 0.13, 0, Math.PI * 2, false);
    return [
      polyShape([
        [-0.45, -0.02],
        [0.3, -0.02],
        [0.3, 0.2],
        [-0.45, 0.2],
      ]),
      polyShape([
        [0.3, 0.03],
        [0.48, 0.03],
        [0.48, 0.15],
        [0.3, 0.15],
      ]),
      polyShape([
        [-0.33, -0.02],
        [-0.12, -0.02],
        [-0.2, -0.45],
        [-0.42, -0.45],
      ]),
      canister,
    ];
  }
  // Web: two concentric rings and four spokes.
  const ring = (outer: number, inner: number) => {
    const s = new Shape();
    s.absarc(0, 0, outer, 0, Math.PI * 2, false);
    const hole = new Path();
    hole.absarc(0, 0, inner, 0, Math.PI * 2, true);
    s.holes.push(hole);
    return s;
  };
  const shapes = [ring(0.46, 0.38), ring(0.25, 0.18)];
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 4;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const half = 0.035;
    const len = 0.48;
    shapes.push(
      polyShape([
        [c * len - s * half, s * len + c * half],
        [c * len + s * half, s * len - c * half],
        [-c * len + s * half, -s * len - c * half],
        [-c * len - s * half, -s * len + c * half],
      ]),
    );
  }
  return shapes;
}

/**
 * Creates the wrist palette: one root entity carrying the holo board, four
 * glossy paint dabs in glowing wells round its far edge, three launcher pads
 * across the middle and a row of five ammo chips with printed labels along
 * the near edge by the wrist. Everything is laid out in the root's own XZ
 * plane, face up, so it all inherits whatever pose WristPaletteSystem copies
 * from the wrist each frame.
 *
 * History: round 1 pinned sixteen orbs to world coordinates; round 2 strapped
 * them to the wrist; round 3 made an actual palette you tap; round 5 added the
 * WEB chip and printed labels; round 8 added the launcher pads and the
 * techno-paint restyle (holo glass, neon edge, liquid wells, holo sockets,
 * appear pop + shimmer — see WristPaletteSystem).
 *
 * Every pressable carries PokeInteractable as well as the ray and grab tags,
 * so a fingertip touch selects exactly like a squeeze. Decoration (board,
 * wells, sockets, labels, icons' glow) is never an entity, so a poke aimed at
 * a chip can never be swallowed by its caption or its socket.
 *
 * The first dab and the first chip are pre-highlighted, and both lists are
 * built in PALETTE_DAB_ORDER / PALETTE_CHIP_ORDER from the same constants
 * INITIAL_PALETTE_SELECTION seeds the signals from, so the highlight and the
 * ammo agree by construction on frame one.
 */
function seedWristPalette(world: World) {
  const rootGroup = new Group();
  rootGroup.name = 'WristPalette';
  const visuals: PaletteVisuals = { wells: [], chipSockets: [], padSockets: [] };
  rootGroup.userData[PALETTE_VISUALS_KEY] = visuals;
  // Decoration, not an entity: nothing queries the board, and keeping it a
  // plain child of the root means it can never be poked by accident.
  rootGroup.add(buildPaletteBoard(visuals));
  const faceY = PALETTE.boardThickness / 2;

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
    // RayInteractable for completeness, PokeInteractable so a fingertip within
    // 2 cm auto-presses, and OneHandGrabbable so the squeeze/pinch still works
    // as a fallback. All three funnel into the `Pressed` tag BallSpawnSystem
    // selects off — so every route lands in the same place.
    entity.addComponent(Interactable);
    entity.addComponent(PokeInteractable);
    entity.addComponent(OneHandGrabbable, { rotate: false, translate: false });
    return entity;
  };

  // ---- Paint dabs: liquid paint in glowing wells, on the far-edge arc --------
  //
  // One flattened sphere geometry shared by all four; only the material
  // differs. Flattening is baked in rather than applied as a mesh scale,
  // because the selection highlight overwrites the mesh scale outright.
  const dabGeometry: BufferGeometry = new SphereGeometry(
    PALETTE.dabRadius,
    32,
    20,
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
    // sRGB, like the HUD swatch (round 7) — see srgbToLinear in types.ts.
    const paintColor = new Color().setRGB(color[0], color[1], color[2], SRGBColorSpace);
    const paint = new MeshPhysicalMaterial({
      color: paintColor,
      roughness: Math.min(PALETTE.dabRoughness, 0.08),
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      // Lit from within: WristPaletteSystem breathes this intensity.
      emissive: paintColor.clone(),
      emissiveIntensity: PALETTE.dabEmissive,
    });
    const mesh = new Mesh(dabGeometry, paint);
    // Angle 0 points at the far (-Z) edge and sweeps toward +X.
    const x = Math.sin(angle) * PALETTE.dabArcRadius;
    const z = -Math.cos(angle) * PALETTE.dabArcRadius;
    mesh.position.set(x, faceY, z);
    if (i === 0) mesh.scale.setScalar(SELECTED_SLOT_SCALE);

    makePressable(mesh).addComponent(PaintDab, {
      color: [color[0], color[1], color[2], color[3]],
    });

    // The well: a soft pool of the paint's colour and a neon rim round it.
    const pool = buildGlowDisc(
      PALETTE.dabRadius * PALETTE.wellGlowScale,
      paintColor,
      PALETTE.wellGlowOpacity,
    );
    pool.mesh.position.set(x, faceY + 0.0003, z);
    const rim = buildGlowRing(
      PALETTE.dabRadius * PALETTE.wellRimScale,
      PALETTE.wellRimTube,
      paintColor,
      PALETTE.wellRimOpacity,
    );
    rim.mesh.position.set(x, faceY + PALETTE.wellRimTube, z);
    rootGroup.add(pool.mesh, rim.mesh);
    visuals.wells.push({ color, rim: rim.material, glow: pool.material, paint });
  }

  // ---- Ammo chips, in a row along the board's near edge ---------------------
  //
  // One material per chip, never a shared one: each chip carries its own
  // identity colour, and the selected chip's emissive lift is a property of
  // that material — share it and picking BOUNCY would light the whole row.
  const chipCount = PALETTE_CHIP_ORDER.length;
  const labelZ =
    PALETTE.chipRowOffset -
    PALETTE.chipRadius -
    PALETTE.chipLabelGap -
    PALETTE.chipLabelHeight / 2;

  for (let i = 0; i < chipCount; i++) {
    const spec = PALETTE_CHIP_ORDER[i];
    const chipColor = new Color(spec.color);
    const material = new MeshPhysicalMaterial({
      color: chipColor,
      roughness: PALETTE.chipRoughness * 0.6,
      metalness: 0.1,
      clearcoat: 0.8,
      clearcoatRoughness: 0.2,
      // Baked here and never changed; BallSpawnSystem only moves the intensity,
      // so a chip always glows in its own colour rather than a generic white.
      emissive: chipColor.clone(),
      emissiveIntensity: i === 0 ? PALETTE.chipSelectedEmissive : 0,
    });

    const x = (i - (chipCount - 1) / 2) * PALETTE.chipSpacing;
    const shape = buildChipShape(spec, material);
    shape.position.set(
      x,
      faceY + PALETTE.chipRadius * PALETTE.chipLift,
      PALETTE.chipRowOffset,
    );
    if (i === 0) shape.scale.setScalar(SELECTED_SLOT_SCALE);

    makePressable(shape).addComponent(KindChip, {
      kind: spec.kind,
      style: spec.style,
    });

    // Holo socket under the chip; lights up when this chip is loaded.
    const socket = buildGlowRing(
      PALETTE.chipRadius * PALETTE.socketRimScale,
      0.0008,
      chipColor,
      PALETTE.socketRimOpacity,
    );
    socket.mesh.position.set(x, faceY + 0.0008, PALETTE.chipRowOffset);
    rootGroup.add(socket.mesh);
    visuals.chipSockets.push({ kind: spec.kind, style: spec.style, rim: socket.material });

    // The label is decoration, not an entity, so nothing can poke it.
    const label = buildChipLabel(paletteLabelText(spec.label), spec.color);
    if (label) {
      label.position.set(x, faceY + PALETTE.chipLabelLift, labelZ);
      rootGroup.add(label);
    }
  }

  // ---- Launcher mode pads (round 8): HAND / BLASTER / GOO -------------------
  //
  // Three dark-glass buttons across the middle of the board, each with a white
  // icon, a neon rim in its identity colour and a holo socket. Same three
  // pointer tags as everything else; BallSpawnSystem selects and relights them
  // (scale + emissive) from globals.blasterMode.
  const modeCount = BLASTER_MODE_ORDER.length;
  const modeGeometry = new CylinderGeometry(
    PALETTE.modePadRadius,
    PALETTE.modePadRadius,
    PALETTE.modePadHeight,
    36,
  );
  const iconSize = PALETTE.modePadRadius * 2 * PALETTE.modePadIconScale;
  const iconMaterial = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  for (let i = 0; i < modeCount; i++) {
    const mode = BLASTER_MODE_ORDER[i];
    const accent = new Color(PALETTE.modePadColors[i]);
    const mesh = new Mesh(
      modeGeometry,
      new MeshStandardMaterial({
        color: new Color(PALETTE.modePadBodyColor),
        roughness: 0.25,
        metalness: 0.35,
        emissive: accent.clone(),
        emissiveIntensity: 0,
      }),
    );
    const x = (i - (modeCount - 1) / 2) * PALETTE.modePadSpacing;
    mesh.position.set(x, faceY + PALETTE.modePadHeight / 2, PALETTE.modePadRowOffset);

    // Children of the pad, so they swell with it when it is selected.
    const icon = new Mesh(new ShapeGeometry(modeIconShapes(mode), 6), iconMaterial);
    icon.scale.setScalar(iconSize);
    icon.rotation.x = -Math.PI / 2;
    icon.position.y = PALETTE.modePadHeight / 2 + 0.0003;
    icon.renderOrder = 2;
    const padRim = buildGlowRing(PALETTE.modePadRadius * 0.96, 0.0008, accent, 0.95);
    padRim.mesh.position.y = PALETTE.modePadHeight / 2;
    mesh.add(icon, padRim.mesh);

    makePressable(mesh).addComponent(BlasterModePad, { mode });

    const socket = buildGlowRing(
      PALETTE.modePadRadius * PALETTE.socketRimScale,
      0.0008,
      accent,
      PALETTE.socketRimOpacity,
    );
    socket.mesh.position.set(x, faceY + 0.0008, PALETTE.modePadRowOffset);
    rootGroup.add(socket.mesh);
    visuals.padSockets.push({ mode, rim: socket.material });

    const label = buildChipLabel(
      paletteLabelText(BLASTER_MODE_LABELS[mode]),
      PALETTE.modePadColors[i],
    );
    if (label) {
      label.position.set(
        x,
        faceY + PALETTE.chipLabelLift,
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
  // No DepthOccludable (round 9): IWSDK's occlusion shader ignores
  // instanceMatrix, so every instanced splat would test depth at the field's
  // origin (CLAUDE.md gotcha 20). Only the robots are occluded.
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
    flick: { url: AUDIO.flick, type: AssetType.Audio, priority: 'background' },
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
    // ROUND8-SPLOTBOTS — the Meshy-generated cast (unrigged, one textured
    // PBR mesh each, WebP textures). Background: TargetSystem builds its pool
    // from robot.gltf at registerSystem and swaps each archetype's real art in
    // at the next Countdown once it has streamed (PipSystem polls for Pip), so
    // they never block boot and a missing file only logs a warning.
    ...Object.fromEntries(
      [
        SPLOTBOTS.archetypes.mopsy,
        SPLOTBOTS.archetypes.squeegee,
        SPLOTBOTS.archetypes.peekaboo,
        SPLOTBOTS.archetypes.duke,
        SPLOTBOTS.pip,
      ].map((bot) => [
        bot.assetKey,
        { url: bot.url, type: AssetType.GLTF, priority: 'background' as const },
      ]),
    ),
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
      // Round 9: OPTIONAL, with the usage/format preferences the WebXR spec
      // wants alongside the feature (the bare `true` sent none, so browsers
      // could drop it). A device without depth simply starts without it, and
      // DepthSensingSystem stays a no-op. Off entirely with the config flag.
      depthSensing: RENDER.depthOcclusion
        ? {
            required: false,
            usage: RENDER.depthUsage,
            format: RENDER.depthFormat,
          }
        : false,
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
  // Round 9: depth occlusion for the robots. Registered BEFORE TargetSystem
  // (whose init builds the pool and installs the first art): the system
  // patches a DepthOccludable entity's materials on its query's qualify, so it
  // must be listening first. World.create never registers it (gotcha 20).
  if (RENDER.depthOcclusion) {
    world.registerSystem(RobotDepthSensingSystem, { priority: 50 });
  }

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
    // Round 9: the tutorial reads this frame's events and drives
    // GameStateSystem's practice round; the coach reads spawn events. Both
    // write signals the HUD (35) and Pip (39) paint this same frame.
    .registerSystem(TutorialSystem, { priority: 32 })
    .registerSystem(CoachSystem, { priority: 33 })
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
    // Round 8: Pip the mascot. Reads the HUD panel's pose (moved by its
    // Follower) and the phase; writes nothing anyone else reads.
    .registerSystem(PipSystem, { priority: 39 })
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
