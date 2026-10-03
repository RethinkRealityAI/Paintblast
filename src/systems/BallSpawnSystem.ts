import {
  createComponent,
  createSystem,
  Types,
  Mesh,
  SphereGeometry,
  MeshStandardMaterial,
  MeshPhysicalMaterial,
  Color,
  Vector3,
  Quaternion,
  Matrix4,
  Interactable,
  Hovered,
  InputComponent,
  Pressed,
  PanelUI,
  PanelDocument,
  PhysicsBody,
  PhysicsShape,
  PhysicsManipulation,
  PhysicsState,
  PhysicsShapeType,
  SRGBColorSpace,
} from '@iwsdk/core';
import type { Entity, Material, Object3D } from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import {
  BALLS,
  BALL_KIND_CONFIG,
  BLASTER,
  CHILL,
  FIRE,
  PALETTE,
  RENDER,
  WEB,
} from '../config';
import { pickAssistedAim } from '../wrist-frame';
import type { AimAssistConfig } from '../wrist-frame';
import { signal } from '@preact/signals-core';
import {
  AimTargets,
  BlasterMode,
  syncBlasterMode,
  BallKind,
  BallStyle,
  GameEvent,
  GameEventBuffer,
  GamePhase,
  GauntletMuzzles,
  WEB_BALL_COLOR,
  WebSubMode,
  nextWebSubMode,
  packFiredData,
} from '../types';
import { Easel } from './EaselSystem';

const DEG_TO_RAD = Math.PI / 180;

/**
 * Havok's world gravity, m/s^2 — IWSDK's PhysicsSystem default. Aim assist
 * solves the ballistic arc with it, scaled by each style's gravity factor.
 */
const GRAVITY = 9.81;

/** Values of Ball.flightState. Drives which per-frame checks BallFlightSystem runs. */
export const BallFlightState = {
  /** In the air, impact-tested every frame. */
  Flying: 0,
  /** Settled on a surface; still culled by lifetime, no longer impact-tested. */
  Resting: 1,
  /** Sticky ball welded in place — physics components stripped, fades on a timer. */
  Stuck: 2,
} as const;

export type BallFlightState =
  typeof BallFlightState[keyof typeof BallFlightState];

/**
 * Ball entity component. One of these per spawned paint ball.
 * Color is RGBA (IWSDK stores it as 4 floats).
 *
 * `prevVelocity` mirrors last frame's PhysicsBody._linearVelocity. IWSDK's
 * PhysicsSystem raises no collision events, so BallFlightSystem infers impacts
 * from the frame-to-frame velocity delta and needs somewhere zero-allocation
 * to keep the previous sample.
 */
export const Ball = createComponent('Ball', {
  kind: { type: Types.Int8, default: BallKind.Normal },
  /** @see BallStyle — which paint pool this ball lands in. */
  style: { type: Types.Int8, default: BallStyle.Paint },
  /**
   * @see WebSubMode — only read when `style` is Web, and only by TargetSystem,
   * which latches a robot instead of damaging it when this says Tether.
   *
   * A field on the ball rather than a signal read at impact time, because the
   * sub-mode can be toggled while a web is still in the air: what matters is
   * what was loaded when the trigger went, not what is loaded when it lands.
   * Splat is 0, so every ball spawned by code that predates this is a plain
   * round-5 web.
   */
  subStyle: { type: Types.Int8, default: WebSubMode.Splat },
  /**
   * Hand that launched it: 0 left, 1 right, -1 nobody in particular.
   *
   * Round 5 needs it because the strand a web ball trails is now attached by
   * WebShooterSystem watching balls appear, rather than by the firing code
   * reaching sideways into the strand pool. That inversion is what lets the
   * trigger fire webbing through BallSpawnSystem's ordinary path (and get a
   * strand) without the two systems importing each other in a cycle.
   */
  firedBy: { type: Types.Int8, default: -1 },
  color: { type: Types.Color, default: [1, 1, 1, 1] },
  radius: { type: Types.Float32, default: BALLS.radius },
  spawnTime: { type: Types.Float64, default: 0 },
  bounceCount: { type: Types.Int8, default: 0 },
  prevVelocity: { type: Types.Vec3, default: [0, 0, 0] },
  flightState: { type: Types.Int8, default: BallFlightState.Flying },
  /** performance.now()/1000 at the moment a Sticky ball welded itself. */
  landedAt: { type: Types.Float64, default: 0 },
  /** Consecutive near-zero-speed frames; promotes the ball to Resting. */
  restFrames: { type: Types.Int16, default: 0 },
});

/**
 * One blob of paint on the palette board. Four are seeded at startup (see
 * `seedWristPalette` in src/main.ts). Pressing one sets the paint COLOUR and
 * nothing else.
 *
 * Rounds 1-2 had a single `PaletteSlot` component carrying both a colour and a
 * kind, which meant sixteen orbs to cover every combination. Splitting the two
 * axes turns that into four dabs plus four chips, and makes each press mean
 * exactly one thing.
 */
export const PaintDab = createComponent('PaintDab', {
  color: { type: Types.Color, default: [1, 1, 1, 1] },
});

/**
 * One ammo chip in the row along the palette's near edge. Five of them since
 * round 5: NORMAL / BOUNCY / STICKY / SPLASH pick a {@link BallKind}, and WEB
 * picks a {@link BallStyle}. Pressing any of them sets both signals at once —
 * a paint chip loads its kind *and* puts the style back to Paint — so the row
 * behaves as one five-way choice with exactly one chip lit.
 *
 * The component keeps its round-3 name because renaming it would rename the
 * ECS component id the MCP debugging tools query by, and "the chip that picks
 * what kind of thing comes out" is still what it is.
 *
 * @see PALETTE_CHIP_ORDER in types.ts — the table main.ts builds these from.
 */
export const KindChip = createComponent('KindChip', {
  kind: { type: Types.Int8, default: BallKind.Normal },
  /** @see BallStyle — Paint on the four kind chips, Web on the web chip. */
  style: { type: Types.Int8, default: BallStyle.Paint },
});

/**
 * One pad on the wrist sub-mode selector — the little two-button holo gadget
 * WebShooterSystem floats above the left shooter while web ammo is loaded.
 *
 * The pads are built and posed by WebShooterSystem (it owns the shooter they
 * hang off), but the component and the selection logic live here with
 * {@link PaintDab} and {@link KindChip} for two reasons. One is that this
 * system is where "things you press to change what comes out of the barrel"
 * already lives, and the sub-mode is exactly that. The other is concrete:
 * WebShooterSystem imports this module, so declaring the component there and
 * pressing it from here would close an import cycle.
 */
export const WebModePad = createComponent('WebModePad', {
  /** @see WebSubMode */
  mode: { type: Types.Int8, default: WebSubMode.Splat },
});

/**
 * One of the palette's three launcher pads — HAND / BLASTER / WEB (round 8).
 * Built in main.ts's `seedWristPalette`; pressed, proximity-selected and
 * relit here with the dabs and chips, through the same paths.
 */
export const BlasterModePad = createComponent('BlasterModePad', {
  /** @see BlasterMode */
  mode: { type: Types.Int8, default: BlasterMode.Paint },
});

/** Scale applied to the currently selected paint dab / ammo chip. */
export const SELECTED_SLOT_SCALE = 1.3;

/**
 * Scale applied to the selected sub-mode pad. Gentler than the chips' 1.3:
 * two pads sitting 3 cm apart have far less room to swell into than a chip
 * with a whole board behind it.
 *
 * Re-exported from config rather than declared, so the number a test asserts
 * and the number the pad is built at cannot drift.
 */
export const SELECTED_PAD_SCALE = WEB.selectorSelectedScale;

/**
 * Everything one trigger pull needs to know, written into a caller-owned object
 * so resolving a shot allocates nothing.
 */
export interface ShotLoadout {
  kind: BallKind;
  style: BallStyle;
  color: readonly [number, number, number, number];
  /** @see WebSubMode — always Splat on a paint shot. */
  subStyle: WebSubMode;
}

/** A zero-filled ShotLoadout to hand to {@link resolveShot}. */
export function createShotLoadout(): ShotLoadout {
  return {
    kind: BallKind.Normal,
    style: BallStyle.Paint,
    color: WEB_BALL_COLOR,
    subStyle: WebSubMode.Splat,
  };
}

/**
 * Turn the two palette signals into the ball a shot actually fires.
 *
 * Webbing overrides both of the paint choices rather than blending with them:
 * it is always white (there is no such thing as red webbing) and always flies
 * Normal (a bouncing web that ricocheted round the room would be a different,
 * much sillier toy, and BALL_KIND_CONFIG has no entry that means "web"). So the
 * palette keeps whatever colour and kind the player had loaded, untouched and
 * waiting, and picking any paint chip or dab hands it straight back.
 *
 * Round 6 added the sub-mode, and it is subject to the same override in the
 * other direction: a paint shot is always `Splat`, whatever the wrist selector
 * happens to be showing, because there is no such thing as a tethering
 * paintball. Keeping that rule here rather than at the spawn site means the
 * one function decides everything about what leaves the barrel.
 *
 * `subMode` is appended after `out` rather than slotted in beside the other two
 * palette axes, deliberately: this signature shipped in round 5 and the default
 * reproduces round-5 behaviour exactly, so every existing caller — and every
 * test written against them — keeps working untouched.
 *
 * Pure apart from writing `out`, and exported so the contract is unit-tested
 * without a World.
 */
export function resolveShot(
  style: BallStyle,
  kind: BallKind,
  color: readonly [number, number, number, number],
  out: ShotLoadout,
  subMode: WebSubMode = WebSubMode.Splat,
): void {
  const web = style === BallStyle.Web;
  out.style = web ? BallStyle.Web : BallStyle.Paint;
  out.kind = web ? BallKind.Normal : kind;
  out.color = web ? WEB_BALL_COLOR : color;
  out.subStyle = web ? subMode : WebSubMode.Splat;
}

/**
 * May a shot be fired in this phase at all?
 *
 * Shared with WebShooterSystem, which has to agree exactly: round 5 deleted the
 * Web phase, so the gesture triggers are live in whatever phase the player is
 * standing in, and "whatever phase" has to mean the same list of phases on both
 * sides or a thwip fires webbing during the game-over summary.
 *
 * Pure and exported for tests.
 */
export function canFireInPhase(
  phase: GamePhase,
  sandboxFireInIdle: boolean,
): boolean {
  return (
    phase === GamePhase.Playing ||
    // Chill mode is nothing but firing: no round, no robots, just paint.
    phase === GamePhase.Chill ||
    (sandboxFireInIdle && phase === GamePhase.Idle)
  );
}

/** How the trigger/pinch path fires this frame. Caller-owned. */
export interface FireGate {
  /** True: fire while held (getSelecting). False: once per press (getSelectStart). */
  level: boolean;
  /** Minimum milliseconds between shots from one hand. */
  cooldownMs: number;
}

/** A default FireGate to hand to {@link resolveFireGate}. */
export function createFireGate(): FireGate {
  return { level: false, cooldownMs: 0 };
}

/**
 * Decide how the trigger/pinch fires (round 8).
 *
 * - **BLASTER mode** auto-fires: hold to keep shooting at
 *   `autoFireCooldownMs`, in every phase where firing is allowed at all.
 * - **Chill** sprays on hold at `sprayCooldownMs`, whatever the mode.
 * - Both at once: the shorter cooldown wins.
 * - Otherwise one ball per press at `cooldownMs` (HAND and WEB — a held
 *   pinch on a tethered hand reels instead, see WebShooterSystem).
 *
 * Pure apart from writing `out`; exported for tests.
 */
export function resolveFireGate(
  mode: BlasterMode,
  chilling: boolean,
  cooldownMs: number,
  sprayCooldownMs: number,
  autoFireCooldownMs: number,
  out: FireGate,
): FireGate {
  const auto = mode === BlasterMode.Paint;
  out.level = chilling || auto;
  if (chilling && auto) {
    out.cooldownMs = Math.min(sprayCooldownMs, autoFireCooldownMs);
  } else if (chilling) {
    out.cooldownMs = sprayCooldownMs;
  } else if (auto) {
    out.cooldownMs = autoFireCooldownMs;
  } else {
    out.cooldownMs = cooldownMs;
  }
  return out;
}

/**
 * Paint one chip as selected or not: the swell, plus an emissive lift in the
 * chip's own identity colour.
 *
 * The lift is why every chip owns its material rather than sharing one — a
 * shared material would light the whole row at once. Within a chip the material
 * *is* shared across child meshes (the Bouncy hoop, the web ball's rings), which
 * is exactly what you want: those parts light together.
 *
 * Only `emissiveIntensity` moves. The emissive colour itself is baked at build
 * time in main.ts, so this never has to know what colour a chip is.
 *
 * Round 6 made the scale and the two intensities arguments so the wrist
 * sub-mode pads can wear the identical treatment: a pad is a chip in every way
 * that matters here, it is just smaller and it glows faintly even when it is
 * not the one selected (a dark holo panel reads as broken).
 */
function paintChipSelection(
  object3D: Object3D | undefined,
  selected: boolean,
  // Explicitly `number`, not inferred: config is declared `as const`, so an
  // inferred default narrows the parameter to the literal 0.35 and the pads'
  // brighter lift becomes a type error.
  selectedScale: number = SELECTED_SLOT_SCALE,
  onIntensity: number = PALETTE.chipSelectedEmissive,
  offIntensity = 0,
): void {
  if (!object3D) return;
  object3D.scale.setScalar(selected ? selectedScale : 1);

  const intensity = selected ? onIntensity : offIntensity;
  const lift = (material: Material) => {
    const standard = material as MeshStandardMaterial;
    // Unlit materials (the labels, if one ever ends up under a chip) have no
    // emissive channel at all; skip rather than inventing one.
    if (!standard.emissive) return;
    standard.emissiveIntensity = intensity;
  };

  object3D.traverse((child) => {
    const material = (child as Mesh).material as
      | Material
      | Material[]
      | undefined;
    if (!material) return;
    if (Array.isArray(material)) material.forEach(lift);
    else lift(material);
  });
}

/**
 * Is this object actually on screen, ancestors included?
 *
 * `Object3D.visible` is per-node, so an object whose own flag is true can still
 * be invisible because something above it is hidden — which is exactly the
 * shape of the wrist selector, whose pads hang off a shooter holder that
 * WebShooterSystem hides when paint is loaded. Walks a chain three or four deep
 * on a squeeze-down edge.
 */
export function visibleInWorld(
  object3D: Object3D | null | undefined,
): boolean {
  let node: Object3D | null | undefined = object3D;
  if (!node) return false;
  while (node) {
    if (!node.visible) return false;
    node = node.parent;
  }
  return true;
}

/** How a visible UI panel swallows trigger pulls. @see panelBlockMode */
export const PanelBlockMode = {
  /** Anywhere on the panel's visible (laid-out) rectangle. */
  Rect: 0,
  /** Only over one of its visible buttons. */
  ButtonsOnly: 1,
} as const;
export type PanelBlockMode = typeof PanelBlockMode[keyof typeof PanelBlockMode];

/**
 * Round 9: which part of a visible panel blocks a shot in `phase`.
 *
 * In Countdown and Playing the HUD is docked low in front of the player
 * (HUD.playOffset) and is a scoreboard, not a menu: blocking its whole
 * rectangle silently ate every shot at a low robot (Duster Duke stands at
 * 0.4 m, 2 m out). There only a ray over a real button (CLEAR PAINT) is a
 * click. Everywhere else the panel is a menu, and pointing anywhere on it
 * still takes precedence over shooting.
 */
export function panelBlockMode(phase: GamePhase): PanelBlockMode {
  return phase === GamePhase.Playing || phase === GamePhase.Countdown
    ? PanelBlockMode.ButtonsOnly
    : PanelBlockMode.Rect;
}

/**
 * Does a world-space ray (origin o, unit direction d) cross the rectangle
 * |x| <= halfW, |y| <= halfH of a local z = 0 plane within `maxT` metres?
 * `inv` is the column-major inverse of that plane's world matrix (any
 * affine scale is fine: the ray parameter survives an affine map, so `t`
 * stays in world metres). Pure; exported for tests.
 */
export function rayHitsLocalRect(
  inv: ArrayLike<number>,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  halfW: number,
  halfH: number,
  maxT: number,
): boolean {
  const m = inv;
  const lox = m[0] * ox + m[4] * oy + m[8] * oz + m[12];
  const loy = m[1] * ox + m[5] * oy + m[9] * oz + m[13];
  const loz = m[2] * ox + m[6] * oy + m[10] * oz + m[14];
  const ldx = m[0] * dx + m[4] * dy + m[8] * dz;
  const ldy = m[1] * dx + m[5] * dy + m[9] * dz;
  const ldz = m[2] * dx + m[6] * dy + m[10] * dz;
  if (Math.abs(ldz) < 1e-9) return false;
  const t = -loz / ldz;
  if (!(t >= 0) || t > maxT) return false;
  return (
    Math.abs(lox + ldx * t) <= halfW && Math.abs(loy + ldy * t) <= halfH
  );
}

/**
 * The bits of a uikit Component this file reads, typed locally so the
 * firing code does not depend on uikit's types. A uikit component's
 * matrixWorld maps a unit square centred on its origin onto its laid-out
 * rectangle (uikit's own raycast uses exactly that panel matrix).
 */
interface UiComponentLike extends Object3D {
  size?: { peek(): unknown };
  isVisible?: { peek(): boolean };
  properties?: { signal?: { id?: { peek?(): unknown; value?: unknown } } };
}

/** The document IWSDK's PanelUISystem attaches (UIKitDocument), as read here. */
interface PanelDocumentLike {
  rootElement?: UiComponentLike;
}

/**
 * Owns everything that puts a ball into the world:
 *
 * 1. **Ammo selection** — pressing a paint dab writes globals.activeColor,
 *    pressing an ammo chip writes globals.activeKind and globals.activeStyle,
 *    and the row relights to show what is loaded.
 * 2. **Firing** — trigger (controller) or pinch (hand tracking) launches a ball
 *    along that hand's pointing ray, subject to a per-hand cooldown. In Chill
 *    mode a *held* trigger sprays on the shorter CHILL.sprayCooldownMs.
 *
 * Round 5 folded webbing into both halves. The WEB chip is just another chip,
 * and the trigger is just the trigger — a web shot is an ordinary shot whose
 * {@link ShotLoadout} came back white and Web-styled. Round 4 had a whole
 * second firing path in WebShooterSystem for the trigger, guarded by a phase
 * check, precisely so the two would not both fire at once; deleting the phase
 * deleted the need for that, and the trigger now has exactly one owner again.
 *
 * Every ball shares one SphereGeometry and one material per palette colour, so
 * balls are removed with `destroy()` — `dispose()` would free GPU resources
 * that the next ball still needs.
 */
export class BallSpawnSystem extends createSystem({
  dabs: { required: [PaintDab] },
  chips: { required: [KindChip] },
  // Two pressed queries rather than one: a dab press and a chip press write
  // different signals, and neither should touch the other's highlight.
  //
  // Neither requires an interaction tag. The elements carry RayInteractable,
  // PokeInteractable and OneHandGrabbable, and InputSystem's single pointerdown
  // listener adds `Pressed` whichever of the three pointers landed the hit —
  // so keying purely off `Pressed` means a fingertip poke, a squeeze and a
  // pinch all arrive down the same path.
  pressedDabs: { required: [PaintDab, Pressed] },
  pressedChips: { required: [KindChip, Pressed] },
  // The wrist sub-mode selector, on exactly the same footing as the chip row:
  // one query to relight the pair and one to catch a press, whichever pointer
  // landed it.
  pads: { required: [WebModePad] },
  pressedPads: { required: [WebModePad, Pressed] },
  modePads: { required: [BlasterModePad] },
  pressedModePads: { required: [BlasterModePad, Pressed] },
  // Anything under a pointer that is not a ball or part of the palette blocks
  // the trigger, so clicking UI never also fires.
  //
  // Balls must be excluded: a ball we just launched sits directly on our own
  // ray for several frames and would otherwise jam the trigger shut.
  //
  // Dabs and chips must be excluded because the palette rides the left wrist.
  // GrabSystem sets `pointerEventsType = { deny: 'ray' }` on grabbables, so a
  // dab never sees the ray pointer at all — but the *grab* pointer still tags
  // it Hovered, and (since round 3) so does the touch pointer, whose fingertip
  // sphere reaches 15 cm. Both of those live on the very hand the palette is
  // strapped to. That is a hover that never ends, and this check is global, so
  // it would lock BOTH triggers for the whole session.
  hoveredUI: {
    required: [Interactable, Hovered],
    excluded: [Ball, PaintDab, KindChip, WebModePad, BlasterModePad],
  },
  // PanelUI panels run their own pointer pipeline and never receive the
  // Hovered tag, so pointing at the HUD is tested geometrically per shot
  // (ray vs panel rectangle) instead — see isPointingAtPanel().
  panels: { required: [PanelUI] },
  balls: { required: [Ball] },
  // Round 9: a pinch that grabs the easel (TwoHandsGrabbable with
  // useHandPinchForGrab) must not also spray paint in Chill.
  pressedEasel: { required: [Easel, Pressed] },
}) {
  private sharedGeometry!: SphereGeometry;
  private materialCache!: Map<string, MeshStandardMaterial>;

  // Scratch objects — allocated once, reused for every shot.
  private scratchPosition!: Vector3;
  private scratchQuaternion!: Quaternion;
  private scratchDirection!: Vector3;
  private scratchPanelMatrix!: Matrix4;
  private scratchGripPosition!: Vector3;
  private scratchElementPosition!: Vector3;
  /** Round 9: each panel document's buttons, found once. @see panelButtons */
  private readonly buttonCache = new WeakMap<object, UiComponentLike[]>();

  private activeKind!: Signal<BallKind>;
  private activeStyle!: Signal<BallStyle>;
  private activeColor!: Signal<readonly [number, number, number, number]>;
  private webSubMode!: Signal<WebSubMode>;
  /** Round 8: HAND / BLASTER / WEB, kept in sync with activeStyle here. */
  private blasterMode!: Signal<BlasterMode>;
  /** PauseClock's flag; optional so a test world without it never pauses. */
  private pausedSignal?: Signal<boolean>;
  /** The paint mode (Hand or Paint) to return to when leaving Web. */
  private lastPaintMode: BlasterMode = BlasterMode.Paint;
  /**
   * Bitmask of hands currently holding a tether: bit 0 left, bit 1 right.
   * Written by TargetSystem, read here only to keep a reeling squeeze from
   * also re-picking ammo. A signal rather than a `getSystem` call because
   * TargetSystem imports this module, and asking it back would close a cycle.
   */
  private tetheredHands!: Signal<number>;
  private gamePhase!: Signal<GamePhase>;
  private events!: GameEventBuffer;
  /** Scratch for {@link resolveShot} — one shot's worth, reused every shot. */
  private loadout!: ShotLoadout;
  /** Live robot positions, for aim assist. Written by TargetSystem. */
  private aimTargets?: AimTargets;
  /**
   * Aim-assist settings for paint and for webbing, built once: speed and
   * gravity differ by style, and a fresh object per shot is exactly the kind
   * of allocation this file never makes.
   */
  private paintAssist!: AimAssistConfig;
  private webAssist!: AimAssistConfig;
  /** Scratch for {@link pickAssistedAim}: candidate and chosen directions. */
  private assistScratch!: Float32Array;
  private assistOut!: Float32Array;
  /**
   * Per hand, 1 while the current pinch (or trigger) press was spent selecting
   * something on the palette (round 7). Cleared when the press ends. Without
   * it a hand-tracking pinch on a chip also fired a ball at the player's own
   * wrist — and in Chill, sprayed for as long as the pinch was held.
   */
  private pressConsumed!: Uint8Array;

  // Per-hand cooldown timestamps (performance.now() ms) and the entity indices
  // needed to move the "selected" highlights, kept as scalars so the system
  // never holds entity references.
  private lastFireLeftMs = 0;
  private lastFireRightMs = 0;
  /** Scratch for {@link resolveFireGate}, written once per frame. */
  private readonly fireGate: FireGate = createFireGate();
  /**
   * Where each gauntlet launches from (round 8), written by GauntletSystem.
   * Bound on first use: GauntletSystem creates it in its own init().
   */
  private gauntletMuzzles?: GauntletMuzzles;
  private selectedDabIndex = -1;
  private previousDabIndex = -1;

  init() {
    this.sharedGeometry = new SphereGeometry(BALLS.radius, 16, 12);
    this.materialCache = new Map();

    this.scratchPosition = new Vector3();
    this.scratchQuaternion = new Quaternion();
    this.scratchDirection = new Vector3();
    this.scratchPanelMatrix = new Matrix4();
    this.scratchGripPosition = new Vector3();
    this.scratchElementPosition = new Vector3();

    this.activeKind = this.globals.activeKind as Signal<BallKind>;
    this.activeStyle = this.globals.activeStyle as Signal<BallStyle>;
    this.activeColor = this.globals.activeColor as Signal<
      readonly [number, number, number, number]
    >;
    this.webSubMode = this.globals.webSubMode as Signal<WebSubMode>;
    this.blasterMode =
      (this.globals.blasterMode as Signal<BlasterMode> | undefined) ??
      signal<BlasterMode>(BlasterMode.Paint);
    this.tetheredHands = this.globals.tetheredHands as Signal<number>;
    this.pausedSignal = this.globals.paused as Signal<boolean> | undefined;
    this.gamePhase = this.globals.gamePhase as Signal<GamePhase>;
    this.events = this.globals.gameEvents as GameEventBuffer;
    this.loadout = createShotLoadout();
    this.aimTargets = this.globals.aimTargets as AimTargets | undefined;
    this.pressConsumed = new Uint8Array(2);
    this.assistScratch = new Float32Array(3);
    this.assistOut = new Float32Array(3);
    this.paintAssist = {
      speed: FIRE.speed,
      gravity: GRAVITY,
      maxAngleRad: FIRE.aimAssistDeg * DEG_TO_RAD,
      maxRange: FIRE.aimAssistMaxRange,
    };
    this.webAssist = {
      speed: FIRE.speed * WEB.webSpeedMult,
      gravity: GRAVITY * WEB.webGravityFactor,
      maxAngleRad: WEB.aimAssistDeg * DEG_TO_RAD,
      maxRange: FIRE.aimAssistMaxRange,
    };

    // main.ts seeds activeColor from INITIAL_PALETTE_SELECTION and pre-scales
    // the first dab, and dabs are created in PALETTE_DAB_ORDER — so the first
    // one to qualify IS the default colour. Recording the index here (without
    // touching the mesh) means the first real press knows which to shrink.
    //
    // Chips need no such bookkeeping: their highlight is derived from the two
    // ammo signals rather than remembered, so it is correct by construction
    // however the signals were last written. Relighting the row when one
    // qualifies covers the load order, since the entities appear after init().
    this.cleanupFuncs.push(
      this.queries.dabs.subscribe('qualify', (dab) => {
        if (this.selectedDabIndex === -1) {
          this.selectedDabIndex = dab.index;
        }
      }),
      this.queries.chips.subscribe('qualify', () => this.applyChipHighlight()),
      this.queries.pads.subscribe('qualify', () => this.applyPadHighlight()),
      this.queries.pressedDabs.subscribe('qualify', (dab) => {
        this.consumeActivePinches();
        this.selectColor(dab);
      }),
      this.queries.pressedChips.subscribe('qualify', (chip) => {
        this.consumeActivePinches();
        this.selectChip(chip);
      }),
      this.queries.modePads.subscribe('qualify', () =>
        this.applyModePadHighlight(),
      ),
      this.queries.pressedModePads.subscribe('qualify', (pad) => {
        this.consumeActivePinches();
        this.selectBlasterMode(
          (pad.getValue(BlasterModePad, 'mode') ??
            BlasterMode.Paint) as BlasterMode,
        );
      }),
      // The two axes stay in sync whoever writes either: the palette's WEB
      // chip, the HUD's WEB MODE button and a dab all write activeStyle; the
      // mode pads and the Armory write blasterMode. @see syncBlasterMode
      this.activeStyle.subscribe((style) => {
        const next = syncBlasterMode(
          this.blasterMode.peek(),
          style === BallStyle.Web,
          this.lastPaintMode,
        );
        if (next !== this.blasterMode.peek()) this.blasterMode.value = next;
      }),
      this.blasterMode.subscribe((mode) => {
        if (mode !== BlasterMode.Web) this.lastPaintMode = mode;
        this.loadStyle(mode === BlasterMode.Web ? BallStyle.Web : BallStyle.Paint);
        this.applyModePadHighlight();
      }),
      this.queries.pressedPads.subscribe('qualify', (pad) => {
        this.consumeActivePinches();
        this.selectSubMode(
          (pad.getValue(WebModePad, 'mode') ?? WebSubMode.Splat) as WebSubMode,
        );
      }),
      // Like the chip row, the pad pair is derived from its signal rather than
      // remembered — the B button and a poke both move the same value.
      this.webSubMode.subscribe(() => this.applyPadHighlight()),
      // The chip row follows the two ammo signals wherever they are written
      // from, not just from a press on this system's own queries. Round 6
      // needed that: the title screen's WEB MODE button loads web ammo from
      // HudSystem, and without this the WEB chip would stay dark while the
      // shooters were plainly on the player's wrists.
      this.activeStyle.subscribe(() => this.applyChipHighlight()),
      this.activeKind.subscribe(() => this.applyChipHighlight()),
      // Round 9: the pinch that grabs the easel is spent, exactly like a
      // pinch on a dab — Chill's spray is level-triggered, so without this
      // every grab painted a stripe while you moved the easel.
      this.queries.pressedEasel.subscribe('qualify', () => {
        this.consumeActivePinches();
      }),
    );
  }

  update() {
    // A press spent on the palette stays spent until it is released.
    this.releaseConsumedPresses();

    // Palette selection by squeeze works in EVERY phase, and deliberately does
    // not go through the pointer pipeline: near the wrist palette the touch
    // pointer's 15 cm hover sphere outranks the grab pointer (MultiPointer
    // priority is touch > grab > ray), which can swallow squeeze-grabs
    // entirely. A plain nearest-element-within-reach test on the squeeze-down
    // frame cannot be outranked by anything.
    this.trySelectByProximity('left');
    this.trySelectByProximity('right');
    // Round 7: the same guarantee for a tracked hand's pinch, measured at the
    // fingertip — and that pinch is then spent, so it never also fires.
    // Right hand only: the palette and the selector pads both ride the LEFT
    // arm, and the left hand's own fingertip sits a few centimetres from its
    // dabs — so a left pinch (firing, or gripping the easel) would otherwise
    // change ammo and eat the press.
    this.trySelectByPinch('right');
    // Round 9: while the easel is held, a fresh pinch from either tracked
    // hand is the second hand joining the two-handed grab (the Pressed tag is
    // already on, so the qualify above does not fire again): spend it too.
    if (this.queries.pressedEasel.entities.size > 0) this.consumeNewPinches();

    const phase = this.gamePhase.peek();
    const chilling = phase === GamePhase.Chill;
    // Web ammo fires down this same path — see resolveShot. Round 4 had to keep
    // the trigger out of here whenever the (now deleted) Web phase was running,
    // because WebShooterSystem also claimed it and one pull threw two balls.
    if (!canFireInPhase(phase, FIRE.sandboxFireInIdle)) return;
    // Paused (Quest menu, headset off): never fire. BLASTER auto-fire is
    // level-triggered, and GauntletSystem leaves its muzzles at the last
    // (stale) pose while paused — a trigger reported held across a blur
    // would otherwise keep spraying from where the arm used to be.
    if (this.pausedSignal?.peek()) return;

    // The controller shortcut for the wrist selector. Checked before the UI
    // gate on purpose: pointing at the menu is a reason not to *shoot*, never a
    // reason a face button should stop working.
    this.trySubModeButton();

    // Pointing at UI takes precedence over shooting.
    if (this.queries.hoveredUI.entities.size > 0) return;

    const nowMs = performance.now();
    // Round 8: BLASTER mode holds-to-auto-fire; Chill sprays. @see resolveFireGate
    resolveFireGate(
      this.blasterMode.peek(),
      chilling,
      FIRE.cooldownMs,
      CHILL.sprayCooldownMs,
      BLASTER.autoFireCooldownMs,
      this.fireGate,
    );
    this.tryFire('left', nowMs, this.fireGate);
    this.tryFire('right', nowMs, this.fireGate);
  }

  /**
   * Squeeze-to-select that bypasses the pointer pipeline: on the frame this
   * hand's squeeze goes down, pick the nearest dab, chip or sub-mode pad within
   * PALETTE.grabSelectRadius of the grip and select it. Runs only on the
   * squeeze-down edge — eleven squared-distance checks at button-press rate.
   * The Pressed-tag path (fingertip poke, hand pinch) stays as-is; if both
   * land in one frame they agree on the result, so double-firing is harmless.
   *
   * **Not while that hand is reeling in a tether.** Holding the squeeze is how
   * you reel, and the squeeze-DOWN edge at the start of a reel would otherwise
   * change your ammo if the gadget happened to be within 9 cm. The pads live on
   * the left wrist and you reel with whichever hand fired, so the collision is
   * rare — but "rare" is exactly the kind of bug that only shows up on device.
   */
  private trySelectByProximity(side: 'left' | 'right'): void {
    const gamepad = this.input.gamepads[side];
    if (!gamepad || !gamepad.getButtonDown(InputComponent.Squeeze)) return;
    if (this.tetheredHands.peek() & (side === 'right' ? 2 : 1)) return;

    const grip = this.player.gripSpaces[side];
    if (!grip) return;
    grip.getWorldPosition(this.scratchGripPosition);
    this.selectNearest(this.scratchGripPosition, PALETTE.grabSelectRadius);
  }

  /**
   * Pinch-to-select at the fingertip, for tracked hands (round 7).
   *
   * Hands have no squeeze button, so {@link trySelectByProximity} never ran for
   * them: a hand player's only routes were a precise fingertip poke, or a pinch
   * that had to win the pointer-priority fight described there — and when it
   * lost, the same pinch fired a paintball at their own wrist. This is the
   * squeeze path's guarantee, measured from the index fingertip (which meets
   * the thumb in a pinch) with the tighter {@link PALETTE.pinchSelectRadius},
   * and a pinch that selects something is marked spent so {@link tryFire}
   * ignores it until it is released.
   *
   * Not on a hand that holds a tether: its pinch reels (WebShooterSystem).
   */
  private trySelectByPinch(side: 'left' | 'right'): void {
    if (!this.input.isPrimary('hand', side)) return;
    const gamepad = this.input.gamepads[side];
    if (!gamepad?.getSelectStart()) return;
    const hand = side === 'right' ? 1 : 0;
    if (this.tetheredHands.peek() & (hand === 1 ? 2 : 1)) return;

    const tip = this.player.indexTipSpaces?.[side];
    if (!tip) return;
    tip.getWorldPosition(this.scratchGripPosition);
    if (this.selectNearest(this.scratchGripPosition, PALETTE.pinchSelectRadius)) {
      this.pressConsumed[hand] = 1;
    }
  }

  /**
   * A palette element was just pressed through the pointer pipeline (a poke,
   * a ray-pinch, the touch sphere): spend the pinch of every tracked hand that
   * is mid-pinch right now, so the same pinch cannot also fire this frame. The
   * pipeline runs at priority -4, well before {@link tryFire} at 10 — which is
   * how round 7's first cut, which only guarded its own fingertip path, still
   * let a pinch on a chip shoot the player's wrist.
   */
  private consumeActivePinches(): void {
    for (let hand = 0; hand < 2; hand++) {
      const side = hand === 1 ? 'right' : 'left';
      if (!this.input.isPrimary('hand', side)) continue;
      if (this.input.gamepads[side]?.getSelecting()) {
        this.pressConsumed[hand] = 1;
      }
    }
  }

  /** Spend any tracked hand's pinch that started this frame. */
  private consumeNewPinches(): void {
    for (let hand = 0; hand < 2; hand++) {
      const side = hand === 1 ? 'right' : 'left';
      if (!this.input.isPrimary('hand', side)) continue;
      if (this.input.gamepads[side]?.getSelectStart()) {
        this.pressConsumed[hand] = 1;
      }
    }
  }

  /** Un-spend each hand's press once its trigger or pinch has come up. */
  private releaseConsumedPresses(): void {
    for (let hand = 0; hand < 2; hand++) {
      if (!this.pressConsumed[hand]) continue;
      const gamepad = this.input.gamepads[hand === 1 ? 'right' : 'left'];
      if (!gamepad?.getSelecting()) this.pressConsumed[hand] = 0;
    }
  }

  /**
   * Select the nearest dab, chip or (visible) sub-mode pad within `radius` of
   * `point`. Eleven squared-distance checks, on a press edge only.
   *
   * @returns true when something was selected.
   */
  private selectNearest(point: Vector3, radius: number): boolean {
    const radiusSq = radius * radius;
    let bestDab: Entity | undefined;
    let bestChip: Entity | undefined;
    let bestPad: Entity | undefined;
    let bestDistSq = radiusSq;

    // Round 9: dabs and chips get the same visibility test as the pads. The
    // palette hides by `visible = false` + scaling its root to 1e-4, which
    // collapses every element onto the root's origin — still a world position
    // a squeeze or pinch near the wrist could "select" while it is hidden.
    for (const dab of this.queries.dabs.entities) {
      const object3D = dab.object3D;
      if (!object3D || !visibleInWorld(object3D)) continue;
      object3D.getWorldPosition(this.scratchElementPosition);
      const distSq = this.scratchElementPosition.distanceToSquared(
        point,
      );
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestDab = dab;
        bestChip = undefined;
        bestPad = undefined;
      }
    }
    for (const chip of this.queries.chips.entities) {
      const object3D = chip.object3D;
      if (!object3D || !visibleInWorld(object3D)) continue;
      object3D.getWorldPosition(this.scratchElementPosition);
      const distSq = this.scratchElementPosition.distanceToSquared(
        point,
      );
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestChip = chip;
        bestDab = undefined;
        bestPad = undefined;
      }
    }
    // Pads are hidden with the shooters when paint is loaded, and a hidden
    // object3D still reports a world position — so without this a squeeze near
    // the left wrist could toggle a sub-mode the player cannot see. The test
    // has to walk ancestors: WebShooterSystem hides the shooter HOLDER, and the
    // pad hanging off it stays `visible = true` in its own right.
    for (const pad of this.queries.pads.entities) {
      const object3D = pad.object3D;
      if (!object3D || !visibleInWorld(object3D)) continue;
      object3D.getWorldPosition(this.scratchElementPosition);
      const distSq = this.scratchElementPosition.distanceToSquared(
        point,
      );
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestPad = pad;
        bestDab = undefined;
        bestChip = undefined;
      }
    }

    let bestModePad: Entity | undefined;
    for (const pad of this.queries.modePads.entities) {
      const object3D = pad.object3D;
      if (!object3D || !visibleInWorld(object3D)) continue;
      object3D.getWorldPosition(this.scratchElementPosition);
      const distSq = this.scratchElementPosition.distanceToSquared(point);
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestModePad = pad;
      }
    }
    if (bestModePad) {
      this.selectBlasterMode(
        (bestModePad.getValue(BlasterModePad, 'mode') ??
          BlasterMode.Paint) as BlasterMode,
      );
      return true;
    }

    if (bestDab) this.selectColor(bestDab);
    else if (bestChip) this.selectChip(bestChip);
    else if (bestPad) {
      this.selectSubMode(
        (bestPad.getValue(WebModePad, 'mode') ?? WebSubMode.Splat) as WebSubMode,
      );
    } else {
      return false;
    }
    return true;
  }

  /**
   * The right controller's B button flips the web sub-mode.
   *
   * A shortcut, not the primary control: the pads are, because they are visible
   * and a hand-tracking player has no buttons at all. But a controller player
   * mid-round should not have to reach across and poke their own wrist to swap
   * from splat to tether, and B is the one face button this game has never used
   * (A and X start a round, the trigger fires, the squeeze grabs and reels).
   *
   * Silent with paint loaded — there is no sub-mode to flip — rather than
   * quietly arming something the player cannot see.
   */
  private trySubModeButton(): void {
    if (this.activeStyle.peek() !== BallStyle.Web) return;
    const gamepad = this.input.gamepads.right;
    if (!gamepad?.getButtonDown(InputComponent.B_Button)) return;
    this.selectSubMode(nextWebSubMode(this.webSubMode.peek()));
  }

  /**
   * Load a web sub-mode. Writes the signal only on a real change so
   * subscribers (the pad highlight, the HUD footer) see one edge, and always
   * emits the confirmation click — pressing the pad you already had loaded
   * should still feel like a press.
   */
  private selectSubMode(mode: WebSubMode): void {
    if (this.webSubMode.peek() !== mode) this.webSubMode.value = mode;
    this.events.emit(GameEvent.AmmoSelected, 0, 0, 0, this.activeKind.peek());
  }

  /**
   * Public for MCP-driven smoke tests and for WebShooterSystem: spawns one ball
   * with the physics material for its kind. Callers that want it moving must
   * add their own PhysicsManipulation — a freshly spawned ball has no Havok
   * body for two to three frames, and PhysicsSystem holds the manipulation
   * until it does.
   *
   * `style` defaults to Paint, so every existing caller is unchanged; web ammo
   * passes Web to route the landing into the other splat pool.
   *
   * `firedBy` is the hand, and it is load-bearing rather than bookkeeping:
   * WebShooterSystem watches Ball entities appear and hangs a strand off the
   * matching wrist, so a ball with no hand recorded gets no strand.
   *
   * The BALLS.maxLive cap is enforced here rather than at the call site, so it
   * is an invariant of putting a ball in the world instead of a courtesy each
   * caller has to remember. Round 4 is why: webbing fires from a second system
   * entirely, and two hands on a 220 ms cooldown will happily out-run the
   * 15-second lifetime and pile up a hundred live balls if nothing is counting.
   */
  spawnBall(
    kind: number,
    color: readonly [number, number, number, number],
    x: number,
    y: number,
    z: number,
    style: BallStyle = BallStyle.Paint,
    firedBy = -1,
    subStyle: WebSubMode = WebSubMode.Splat,
  ): Entity {
    this.enforceLiveBallCap();

    const kindConfig =
      BALL_KIND_CONFIG[kind as BallKind] ?? BALL_KIND_CONFIG[BallKind.Normal];

    const mesh = new Mesh(this.sharedGeometry, this.getMaterial(color));
    mesh.position.set(x, y, z);

    const ball = this.world.createTransformEntity(mesh);
    // Ball is what WebShooterSystem's strand query keys off, so every field it
    // reads (style, firedBy) must be in this payload rather than written after.
    ball.addComponent(Ball, {
      kind,
      style,
      subStyle,
      firedBy,
      color: [color[0], color[1], color[2], color[3]],
      radius: BALLS.radius,
      spawnTime: performance.now() / 1000,
      bounceCount: 0,
      flightState: BallFlightState.Flying,
    });
    // Round 9: balls are deliberately NOT Interactable / OneHandGrabbable any
    // more. Grabbing one was undocumented, a pinch on a resting ball also
    // fired, and a hand throw has no speed cap — past 14 cm per 72 Hz step it
    // tunnels walls (CLAUDE.md gotcha 22).
    ball.addComponent(PhysicsBody, {
      state: PhysicsState.Dynamic,
      linearDamping: kindConfig.linearDamping,
      angularDamping: 0.05,
      // Webbing flies flatter than paint (round 7) — see WEB.webGravityFactor.
      // Aim assist's ballistic solve reads the same factor, so the two agree.
      gravityFactor: style === BallStyle.Web ? WEB.webGravityFactor : 1.0,
    });
    ball.addComponent(PhysicsShape, {
      shape: PhysicsShapeType.Sphere,
      dimensions: [BALLS.radius, 0, 0],
      density: 10,
      restitution: kindConfig.restitution,
      friction: 0.3,
    });
    // No DepthOccludable: round 9 occludes the robots only. Balls share one
    // material per colour, and the occlusion patch forces `transparent` on
    // every material it touches.

    return ball;
  }

  /**
   * Fire one ball from `side`'s pointing ray, if that hand asked to shoot this
   * frame and its cooldown has elapsed.
   *
   * `gate.level` switches the trigger from edge-triggered to level-triggered:
   * one ball per pull (getSelectStart), or a held trigger that keeps firing
   * (getSelecting) — Chill's spray and, since round 8, BLASTER mode's
   * auto-fire. Both helpers cover the controller trigger AND the hand-tracking
   * pinch, so holding works in either input mode.
   */
  private tryFire(
    side: 'left' | 'right',
    nowMs: number,
    gate: FireGate,
  ): void {
    const gamepad = this.input.gamepads[side];
    if (!gamepad) return;
    const wants = gate.level ? gamepad.getSelecting() : gamepad.getSelectStart();
    if (!wants) return;

    const hand = side === 'right' ? 1 : 0;
    // This press already selected something on the palette (round 7).
    if (this.pressConsumed[hand]) return;
    // This hand is holding a tether: its press reels the line in instead
    // (WebShooterSystem). Firing would also have broken the very line the
    // player is hauling — every ball from a hand lets go of its tether.
    if (this.tetheredHands.peek() & (hand === 1 ? 2 : 1)) return;

    // This hand is clicking the HUD, not shooting. Checked per hand so a
    // left click on the panel never silences the right trigger.
    if (this.isPointingAtPanel(this.player.raySpaces[side])) return;

    const cooldownMs = gate.cooldownMs;
    const lastMs = side === 'left' ? this.lastFireLeftMs : this.lastFireRightMs;
    if (nowMs - lastMs < cooldownMs) return;
    if (side === 'left') {
      this.lastFireLeftMs = nowMs;
    } else {
      this.lastFireRightMs = nowMs;
    }

    this.fireFrom(side, this.player.raySpaces[side]);
  }

  /**
   * Fire one ball from an arbitrary muzzle and direction, on the same per-hand
   * cooldown the trigger uses. The entry point for WebShooterSystem's two
   * gesture triggers.
   *
   * ### Why the gestures come back through here (round 6)
   *
   * Round 5's thwip and thrust threw webbing and nothing else, because they
   * lived in the web system and hard-coded a white Web ball. The field asked
   * for the obvious thing: a thwip should fire **whatever is loaded**. Once it
   * does, the gesture is not a web feature any more — it is a second trigger —
   * and a second trigger has to resolve the loadout through {@link resolveShot}
   * and respect the cap, the events and the cooldown exactly as the first one
   * does. Duplicating that in WebShooterSystem is how the two paths drift.
   *
   * The cooldown timestamps are **shared** with the trigger, which reverses a
   * round-5 decision. Separate cooldowns were defensible while the gesture
   * fired a different kind of ammo; now that a thwip and a trigger pull produce
   * the identical ball, letting a player double their rate of fire by doing
   * both at once is just a bug with a rationale attached.
   *
   * Deliberately **not** subject to the don't-shoot-the-HUD rule. Curling two
   * fingers cannot press a button, so there is nothing to disambiguate — the
   * round-4 reasoning, unchanged.
   *
   * @param nowMs performance.now(); passed in so the caller's frame clock and
   *   this cooldown cannot disagree.
   * @returns the ball, or undefined when the phase or the cooldown refused.
   */
  fireFromGesture(
    side: 'left' | 'right',
    originX: number,
    originY: number,
    originZ: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    nowMs: number,
  ): Entity | undefined {
    if (!canFireInPhase(this.gamePhase.peek(), FIRE.sandboxFireInIdle)) {
      return undefined;
    }

    const lastMs = side === 'left' ? this.lastFireLeftMs : this.lastFireRightMs;
    if (nowMs - lastMs < FIRE.cooldownMs) return undefined;
    if (side === 'left') {
      this.lastFireLeftMs = nowMs;
    } else {
      this.lastFireRightMs = nowMs;
    }

    return this.launch(side, originX, originY, originZ, dirX, dirY, dirZ);
  }

  /**
   * True when `raySpace`'s pointing ray is clicking a UI panel, so its
   * trigger pull must not also shoot.
   *
   * Round 9 rewrote the test (it used to be the panel's full PanelUI
   * maxWidth x maxHeight box, always):
   *
   * - A panel whose object3D is hidden in world (IntroSystem hides the HUD
   *   during the logo intro) never blocks.
   * - The rectangle is the panel's real laid-out root component, not the
   *   generous maxWidth x maxHeight box — uikit gives every component a
   *   matrixWorld that maps a unit square onto its visible rect.
   * - In Countdown / Playing ({@link panelBlockMode}) only a visible button
   *   (`FIRE.uiInteractiveIdPrefix`) blocks: the docked scoreboard sat right
   *   across the line to low robots and silently ate those shots.
   *
   * The query it walks covers every PanelUI in the world, so this never has to
   * know which panels exist. Public since round 4.
   */
  isPointingAtPanel(raySpace: Object3D): boolean {
    raySpace.getWorldPosition(this.scratchPosition);
    raySpace.getWorldQuaternion(this.scratchQuaternion);
    this.scratchDirection.set(0, 0, -1).applyQuaternion(this.scratchQuaternion);
    const mode = panelBlockMode(this.gamePhase.peek());

    for (const panel of this.queries.panels.entities) {
      const object3D = panel.object3D;
      if (!object3D || !visibleInWorld(object3D)) continue;

      const document = panel.hasComponent(PanelDocument)
        ? (panel.getValue(PanelDocument, 'document') as
            | PanelDocumentLike
            | undefined)
        : undefined;
      const root = document?.rootElement;

      if (document && root) {
        if (mode === PanelBlockMode.ButtonsOnly) {
          for (const button of this.panelButtons(document, root)) {
            if (this.rayHitsComponent(button, FIRE.uiButtonMarginMeters)) {
              return true;
            }
          }
        } else if (this.rayHitsComponent(root, 0)) {
          return true;
        }
        continue;
      }

      // No document yet (still loading): the old maxWidth x maxHeight box,
      // menus only — a scoreboard with nothing on it cannot be clicked.
      if (mode !== PanelBlockMode.Rect) continue;
      object3D.updateWorldMatrix(true, false);
      this.scratchPanelMatrix.copy(object3D.matrixWorld).invert();
      const halfW = (panel.getValue(PanelUI, 'maxWidth') ?? 0) / 2;
      const halfH = (panel.getValue(PanelUI, 'maxHeight') ?? 0) / 2;
      if (this.rayHitsMatrixRect(halfW, halfH)) return true;
    }
    return false;
  }

  /** Buttons of a panel document, found once per document and cached. */
  private panelButtons(
    document: PanelDocumentLike,
    root: UiComponentLike,
  ): readonly UiComponentLike[] {
    const cached = this.buttonCache.get(document);
    if (cached) return cached;
    const prefix = FIRE.uiInteractiveIdPrefix;
    const found: UiComponentLike[] = [];
    root.traverse((node) => {
      const idSignal = (node as UiComponentLike).properties?.signal?.id;
      if (!idSignal) return;
      const id = idSignal.peek ? idSignal.peek() : idSignal.value;
      if (typeof id === 'string' && id.startsWith(prefix)) {
        found.push(node as UiComponentLike);
      }
    });
    // An empty list may just mean the document is not indexed yet; only a
    // real answer is worth remembering.
    if (found.length > 0) this.buttonCache.set(document, found);
    return found;
  }

  /**
   * Does this frame's ray (scratchPosition / scratchDirection) cross a uikit
   * component's visible rectangle, grown by `marginMeters` on every side?
   * Skips components that are hidden (`display: none`, clipped) or not laid
   * out yet.
   */
  private rayHitsComponent(
    component: UiComponentLike,
    marginMeters: number,
  ): boolean {
    if (component.isVisible && !component.isVisible.peek()) return false;
    if (component.size && component.size.peek() == null) return false;
    component.updateWorldMatrix(true, false);
    const e = component.matrixWorld.elements;
    // World size of the unit square: the lengths of the X and Y columns.
    const sx = Math.hypot(e[0], e[1], e[2]);
    const sy = Math.hypot(e[4], e[5], e[6]);
    if (!(sx > 1e-6) || !(sy > 1e-6)) return false;
    this.scratchPanelMatrix.copy(component.matrixWorld).invert();
    return this.rayHitsMatrixRect(
      0.5 + marginMeters / sx,
      0.5 + marginMeters / sy,
    );
  }

  /** The ray against a rect in scratchPanelMatrix's (inverse) local frame. */
  private rayHitsMatrixRect(halfW: number, halfH: number): boolean {
    const o = this.scratchPosition;
    const d = this.scratchDirection;
    return rayHitsLocalRect(
      this.scratchPanelMatrix.elements,
      o.x,
      o.y,
      o.z,
      d.x,
      d.y,
      d.z,
      halfW,
      halfH,
      FIRE.uiBlockMaxDistance,
    );
  }

  private fireFrom(side: 'left' | 'right', raySpace: Object3D): void {
    // Round 8: with a gauntlet out (BLASTER or WEB), the shot leaves the
    // barrel the player can see, along its shown aim — the same origin and
    // direction the gestures use. HAND mode (or a hand GauntletSystem could
    // not pose this frame) keeps the bare-hand ray, as since round 1.
    const muzzles = (this.gauntletMuzzles ??= this.globals.gauntletMuzzles as
      | GauntletMuzzles
      | undefined);
    const hand = side === 'right' ? 1 : 0;
    if (
      muzzles &&
      muzzles.valid[hand] === 1 &&
      this.blasterMode.peek() !== BlasterMode.Hand
    ) {
      const b = hand * 3;
      this.launch(
        side,
        muzzles.origin[b],
        muzzles.origin[b + 1],
        muzzles.origin[b + 2],
        muzzles.direction[b],
        muzzles.direction[b + 1],
        muzzles.direction[b + 2],
      );
      return;
    }

    raySpace.getWorldPosition(this.scratchPosition);
    raySpace.getWorldQuaternion(this.scratchQuaternion);
    // XR ray spaces point along their LOCAL -Z; Object3D.getWorldDirection
    // would hand back +Z, i.e. straight backwards.
    this.scratchDirection.set(0, 0, -1).applyQuaternion(this.scratchQuaternion);

    this.launch(
      side,
      this.scratchPosition.x + this.scratchDirection.x * FIRE.muzzleOffset,
      this.scratchPosition.y + this.scratchDirection.y * FIRE.muzzleOffset,
      this.scratchPosition.z + this.scratchDirection.z * FIRE.muzzleOffset,
      this.scratchDirection.x,
      this.scratchDirection.y,
      this.scratchDirection.z,
    );
  }

  /**
   * Put one ball in the world, moving, and tell everyone about it.
   *
   * The single place a shot is actually taken: the trigger arrives here through
   * {@link fireFrom}, the two hand gestures through {@link fireFromGesture},
   * and neither knows anything the other does not. Cooldowns and the phase gate
   * belong to the callers, because the two inputs answer those questions
   * differently; the loadout, the cap, the physics and the event are the same
   * every time and belong here.
   *
   * Takes plain numbers rather than the scratch vectors on purpose — the
   * gesture path's muzzle and direction live in WebShooterSystem's scratch, and
   * copying them into this system's would be an aliasing bug waiting to happen.
   */
  private launch(
    side: 'left' | 'right',
    x: number,
    y: number,
    z: number,
    dirX: number,
    dirY: number,
    dirZ: number,
  ): Entity {
    // Paint or webbing, decided by the palette rather than by the phase — and
    // since round 6, splat or tether, decided by the wrist selector.
    const loadout = this.loadout;
    resolveShot(
      this.activeStyle.peek(),
      this.activeKind.peek(),
      this.activeColor.peek(),
      loadout,
      this.webSubMode.peek(),
    );

    // Round 7: webbing zips — faster and flatter than paint — and both get a
    // gentle aim assist toward live robots during a round.
    const web = loadout.style === BallStyle.Web;
    const speed = web ? FIRE.speed * WEB.webSpeedMult : FIRE.speed;
    let aimX = dirX;
    let aimY = dirY;
    let aimZ = dirZ;
    const targets = this.aimTargets;
    if (targets && this.gamePhase.peek() === GamePhase.Playing) {
      const slot = pickAssistedAim(
        x,
        y,
        z,
        dirX,
        dirY,
        dirZ,
        targets.positions,
        targets.active,
        targets.capacity,
        web ? this.webAssist : this.paintAssist,
        this.assistScratch,
        this.assistOut,
      );
      if (slot >= 0) {
        aimX = this.assistOut[0];
        aimY = this.assistOut[1];
        aimZ = this.assistOut[2];
      }
    }

    // The live-ball cap is spawnBall's job now, not this call site's.
    const hand = side === 'right' ? 1 : 0;
    const ball = this.spawnBall(
      loadout.kind,
      loadout.color,
      x,
      y,
      z,
      loadout.style,
      hand,
      loadout.subStyle,
    );
    ball.addComponent(PhysicsManipulation, {
      linearVelocity: [aimX * speed, aimY * speed, aimZ * speed],
    });

    // BallFired is the one event whose `data` is not just the ball kind:
    // FeedbackSystem needs to know which controller to buzz and whether that
    // was a thwip or a paint trigger, so both ride above the kind —
    // data = kind | (hand << 8) | (style << 9), hand 0 = left, 1 = right.
    this.events.emit(
      GameEvent.BallFired,
      x,
      y,
      z,
      packFiredData(loadout.kind, hand, loadout.style),
    );
    return ball;
  }

  /** Destroy the oldest live ball when the population cap is already reached. */
  private enforceLiveBallCap(): void {
    const balls = this.queries.balls.entities;
    if (balls.size < BALLS.maxLive) return;

    let oldest: Entity | undefined;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const ball of balls) {
      const spawnTime = ball.getValue(Ball, 'spawnTime') ?? 0;
      if (spawnTime < oldestTime) {
        oldestTime = spawnTime;
        oldest = ball;
      }
    }
    // destroy(), never dispose(): geometry and materials are shared.
    oldest?.destroy();
  }

  /**
   * Load a pressed dab's colour and move the colour highlight to it.
   *
   * Also drops web ammo. Round 4 made the dabs inert while webbing was loaded,
   * because a squeeze near the left wrist could silently change a loadout the
   * mode was ignoring anyway. Round 5 inverts that: with no Web phase to leave,
   * touching a colour is one of the two ways *out* of webbing, and a palette
   * that ignored you would be a trap rather than a safeguard.
   */
  private selectColor(dab: Entity): void {
    // Vector/colour fields must be read through a view — getValue throws on them.
    const color = dab.getVectorView(PaintDab, 'color') as Float32Array;
    this.activeColor.value = [color[0], color[1], color[2], color[3]];
    // Dropping web ammo un-lights the WEB chip and re-lights whichever kind
    // chip was waiting — the chip row is derived from the signals, so it has to
    // be told the signals moved even though no chip was touched.
    if (this.loadStyle(BallStyle.Paint)) this.applyChipHighlight();

    // Re-pressing the current dab still confirms the choice (FeedbackSystem
    // plays a click off AmmoSelected) but must not shuffle the highlight onto
    // itself, which would leave the previous index pointing at the selection.
    if (dab.index !== this.selectedDabIndex) {
      this.previousDabIndex = this.selectedDabIndex;
      this.selectedDabIndex = dab.index;
      this.applyDabHighlight();
    }

    // data stays the ball kind, as it has been since Wave B — the colour rides
    // on globals.activeColor, which the HUD swatch already subscribes to.
    this.events.emit(GameEvent.AmmoSelected, 0, 0, 0, this.activeKind.peek());
  }

  /**
   * Load a pressed chip: its style always, and its kind when it is a paint
   * chip. Picking NORMAL after WEB therefore does both halves of what the
   * player means — "back to paint, and make it the plain kind".
   */
  private selectChip(chip: Entity): void {
    const style = (chip.getValue(KindChip, 'style') ??
      BallStyle.Paint) as BallStyle;

    if (style === BallStyle.Paint) {
      const kind = chip.getValue(KindChip, 'kind');
      if (kind === null) return;
      this.activeKind.value = kind as BallKind;
    }
    this.loadStyle(style);
    this.applyChipHighlight();

    this.events.emit(GameEvent.AmmoSelected, 0, 0, 0, this.activeKind.peek());
  }

  /**
   * Write activeStyle only on a real change, so subscribers see one edge.
   *
   * @returns true when the style actually moved, which is the caller's cue to
   *   relight the chip row.
   */
  private loadStyle(style: BallStyle): boolean {
    if (this.activeStyle.peek() === style) return false;
    this.activeStyle.value = style;
    return true;
  }

  /** Grow the selected dab and shrink whichever one it replaced. */
  private applyDabHighlight(): void {
    for (const dab of this.queries.dabs.entities) {
      if (dab.index === this.selectedDabIndex) {
        dab.object3D?.scale.setScalar(SELECTED_SLOT_SCALE);
      } else if (dab.index === this.previousDabIndex) {
        dab.object3D?.scale.setScalar(1);
      }
    }
  }

  /**
   * Relight the chip row from the two ammo signals.
   *
   * Derived rather than remembered, unlike the dabs, because a chip's selected
   * state has two independent ways to change: pressing a chip, or pressing a
   * *dab* (which puts the style back to Paint and therefore un-lights WEB). An
   * index pair cannot track that without one of the two writers knowing about
   * the other's bookkeeping; recomputing from the signals is always right.
   *
   * Five entities, on a press rather than per frame.
   */
  private applyChipHighlight(): void {
    const style = this.activeStyle.peek();
    const kind = this.activeKind.peek();

    for (const chip of this.queries.chips.entities) {
      const chipStyle = chip.getValue(KindChip, 'style') ?? BallStyle.Paint;
      // A web chip is selected on style alone; a paint chip also has to be the
      // loaded kind, since all four share the Paint style.
      const selected =
        chipStyle === style &&
        (chipStyle !== BallStyle.Paint ||
          chip.getValue(KindChip, 'kind') === kind);
      paintChipSelection(chip.object3D, selected);
    }
  }

  /**
   * Load a launcher mode from a pad or the Armory. Writes only on a change
   * (the activeStyle sync rides the subscription) and always clicks, like the
   * other palette presses.
   */
  selectBlasterMode(mode: BlasterMode): void {
    if (this.blasterMode.peek() !== mode) this.blasterMode.value = mode;
    this.events.emit(GameEvent.AmmoSelected, 0, 0, 0, this.activeKind.peek());
  }

  /** Relight the three mode pads from `blasterMode`. Derived, like the chips. */
  private applyModePadHighlight(): void {
    const mode = this.blasterMode.peek();
    for (const pad of this.queries.modePads.entities) {
      paintChipSelection(
        pad.object3D,
        (pad.getValue(BlasterModePad, 'mode') ?? -1) === mode,
      );
    }
  }

  /**
   * Relight the two sub-mode pads from `webSubMode`.
   *
   * Same derived-not-remembered rule as the chip row, and for the same reason:
   * three inputs move this value (a poke, a squeeze, the B button) and none of
   * them should have to know what the others did. Two entities, on a press.
   */
  private applyPadHighlight(): void {
    const mode = this.webSubMode.peek();
    for (const pad of this.queries.pads.entities) {
      const padMode = pad.getValue(WebModePad, 'mode') ?? WebSubMode.Splat;
      paintChipSelection(
        pad.object3D,
        padMode === mode,
        SELECTED_PAD_SCALE,
        WEB.selectorSelectedEmissive,
        WEB.selectorIdleEmissive,
      );
    }
  }

  /**
   * One material per palette colour, created on first use. Five entries in
   * practice (four dabs + webbing); sharing them is what keeps 20 live balls
   * to a handful of draw-call state changes — and why balls are destroy()ed,
   * never dispose()d.
   *
   * Round 7 made them read as wet paint: a low-roughness base under a
   * clearcoat glaze (MeshPhysicalMaterial), so each ball carries a sharp
   * highlight from the room IBL over a still-saturated colour. Every ball
   * material sets the same feature flags (clearcoat on, nothing else), so all
   * colours share ONE shader program — compiled once, on the first ball drawn.
   * RENDER.ballClearcoat = 0 falls back to MeshStandardMaterial, whose program
   * the palette dabs have already compiled.
   *
   * Webbing is identified by colour: WEB_BALL_COLOR is the only white that
   * ever reaches here (resolveShot substitutes it for every web shot, and no
   * palette dab is white). It gets a satin pearl instead — softer base, cooler
   * white, a faint self-light so it never greys out in a dim room.
   */
  private getMaterial(
    color: readonly [number, number, number, number],
  ): MeshStandardMaterial {
    const key = `${color[0]},${color[1]},${color[2]}`;
    let material = this.materialCache.get(key);
    if (!material) {
      const web =
        color[0] === WEB_BALL_COLOR[0] &&
        color[1] === WEB_BALL_COLOR[1] &&
        color[2] === WEB_BALL_COLOR[2];
      const base = web
        ? new Color(
            RENDER.webBallColor[0],
            RENDER.webBallColor[1],
            RENDER.webBallColor[2],
          )
        : // sRGB in, like the HUD swatch — see srgbToLinear in types.ts.
          new Color().setRGB(color[0], color[1], color[2], SRGBColorSpace);
      const roughness = web ? RENDER.webBallRoughness : RENDER.ballRoughness;

      if (RENDER.ballClearcoat > 0) {
        material = new MeshPhysicalMaterial({
          color: base,
          roughness,
          metalness: 0,
          clearcoat: RENDER.ballClearcoat,
          clearcoatRoughness: web
            ? RENDER.webBallClearcoatRoughness
            : RENDER.ballClearcoatRoughness,
        });
      } else {
        material = new MeshStandardMaterial({
          color: base,
          roughness,
          metalness: 0,
        });
      }
      // Emissive is a plain uniform on both material types (no shader
      // variant), so the pearl's self-light costs nothing.
      if (web) {
        material.emissive.setRGB(
          RENDER.webBallEmissive[0],
          RENDER.webBallEmissive[1],
          RENDER.webBallEmissive[2],
        );
      }
      this.materialCache.set(key, material);
    }
    return material;
  }
}
