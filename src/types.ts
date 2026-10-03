// Shared enums and constants for Splotopia (repo: PaintBlast-MR).
// No IWSDK imports — this file is pure TS data used by both systems
// (which run inside the World) and unit tests (which do not).

export const BallKind = {
  Normal: 0,
  Bouncy: 1,
  Sticky: 2,
  Splash: 3,
} as const;

export type BallKind = typeof BallKind[keyof typeof BallKind];

export const BALL_KIND_NAMES: Record<BallKind, string> = {
  [BallKind.Normal]: 'normal',
  [BallKind.Bouncy]: 'bouncy',
  [BallKind.Sticky]: 'sticky',
  [BallKind.Splash]: 'splash',
};

/**
 * What a ball leaves behind when it lands. Orthogonal to BallKind, which is
 * about *physics* (bounce, stick, burst).
 *
 * Round 4 needed webbing that flies exactly like a paintball but paints from a
 * different pool with a different mask. Rather than inventing a fifth BallKind
 * — which would have needed an entry in BALL_KIND_CONFIG and a physics profile
 * nobody wanted — style is a second, independent axis. Paint is 0 so every ball
 * ever spawned without one is unchanged.
 *
 * Round 5 promoted it from an implementation detail of the deleted Web *phase*
 * to the thing the player actually chooses: `globals.activeStyle` is the fifth
 * chip on the wrist palette, so webbing is ammo you can load in any mode rather
 * than a room you have to walk into. It lives here rather than in
 * BallSpawnSystem because {@link packImpactData} now carries it.
 */
export const BallStyle = {
  /** Palette paint. Splats into SplatterSystem's colour pool. */
  Paint: 0,
  /** Webbing. White, splats into the web pool, never bounces. */
  Web: 1,
} as const;

export type BallStyle = typeof BallStyle[keyof typeof BallStyle];

/**
 * Which *kind* of web comes out of the shooter. Only meaningful while
 * {@link BallStyle.Web} is loaded; paint ignores it entirely.
 *
 * Round 6's headline. A web that splats is a paint pool with a different mask —
 * useful, but it does nothing a colour cannot. A web that **latches onto a
 * robot and lets you reel it in** is a second verb, and the one people mime the
 * moment they put a shooter on their wrist. Rather than a sixth palette chip
 * (the row is already five wide on a 22 cm board) it is a sub-mode of web ammo,
 * chosen on a two-pad holo gadget that appears above the left shooter.
 *
 * Splat is 0 so a zero-initialised Ball field, a fresh signal and every shot
 * fired before this existed all mean "the round-5 web", unchanged.
 */
export const WebSubMode = {
  /** The round-5 web: flies, splats, paints from the web decal pool. */
  Splat: 0,
  /** Latches onto a robot. Yank or hold-squeeze to reel it in; it pops close. */
  Tether: 1,
} as const;

export type WebSubMode = typeof WebSubMode[keyof typeof WebSubMode];

/**
 * Which launcher the player's gauntlets are in (round 8). The fourth loadout
 * axis, chosen on the palette's mode pads (HAND / BLASTER / WEB) and in the
 * Armory.
 *
 * - **Hand**: no hardware. Paint flies from the bare hand along the pointer —
 *   the original game, kept for players who want nothing on their arms.
 * - **Paint**: the paint-blaster gauntlet. Same paint, a visible launcher with
 *   a canister glowing in the loaded colour, and hold-to-auto-fire.
 * - **Web**: the web gauntlet. Exactly equivalent to `activeStyle === Web`;
 *   BallSpawnSystem keeps the two in sync whichever one is written.
 */
export const BlasterMode = {
  Hand: 0,
  Paint: 1,
  Web: 2,
} as const;

export type BlasterMode = typeof BlasterMode[keyof typeof BlasterMode];

/** Labels for the mode pads and the HUD. ASCII caps (gotcha 24). */
export const BLASTER_MODE_LABELS: Readonly<Record<BlasterMode, string>> = {
  [BlasterMode.Hand]: 'HAND',
  [BlasterMode.Paint]: 'BLASTER',
  // Round 9 rebrand: the web launcher is GOO (sticky paint strands). The
  // identifier stays BlasterMode.Web until the identifier-rename pass.
  [BlasterMode.Web]: 'GOO',
};

/** Mode pads on the palette, left to right. */
export const BLASTER_MODE_ORDER: ReadonlyArray<BlasterMode> = [
  BlasterMode.Hand,
  BlasterMode.Paint,
  BlasterMode.Web,
];

/**
 * Where a palette/HUD/style change leaves the blaster mode and the paint
 * style — the single rule every writer goes through, so the two axes can
 * never disagree.
 *
 * - Picking WEB (pad, chip or the title button) means Web style.
 * - Picking HAND or BLASTER means Paint style, and remembers it as the mode
 *   to return to.
 * - Going back to paint any other way (a dab, a paint chip) returns to the
 *   remembered paint mode, never to Hand by surprise.
 *
 * Pure and exported for tests.
 */
export function syncBlasterMode(
  mode: BlasterMode,
  styleIsWeb: boolean,
  lastPaintMode: BlasterMode,
): BlasterMode {
  if (styleIsWeb) return BlasterMode.Web;
  if (mode === BlasterMode.Web) {
    return lastPaintMode === BlasterMode.Web ? BlasterMode.Paint : lastPaintMode;
  }
  return mode;
}

/**
 * The other sub-mode. The B button and the two selector pads both come down to
 * this, so "what does the toggle do" has exactly one answer.
 *
 * Pure and exported for tests.
 */
export function nextWebSubMode(mode: WebSubMode): WebSubMode {
  return mode === WebSubMode.Tether ? WebSubMode.Splat : WebSubMode.Tether;
}

/** Every web ball is white, whatever the palette says. Not configurable. */
export const WEB_BALL_COLOR: readonly [number, number, number, number] = [
  1, 1, 1, 1,
];

// Palette colors as [r, g, b, a] tuples (Types.Color shape IWSDK uses).
// Round 3 split colour from ammo kind: these four are the paint DABS on the
// board, and PALETTE_CHIP_ORDER below is the ammo CHIP row. Colour and ammo are
// chosen independently, so four dabs plus five chips replace the old 4x4 grid
// of sixteen combined orbs.
export const PALETTE_COLORS: ReadonlyArray<readonly [number, number, number, number]> = [
  [1.0, 0.42, 0.42, 1.0], // red
  [1.0, 0.79, 0.34, 1.0], // amber
  [0.28, 0.86, 0.98, 1.0], // sky blue
  [0.30, 0.80, 0.52, 1.0], // green
];

/**
 * One sRGB channel (0..1) to linear light, the curve three.js uses.
 *
 * Round 7: every palette colour in this file is an **sRGB** value — the same
 * numbers the HUD swatch and the easel's 2D canvas display — but rounds 1-6
 * handed them to three as linear, so every ball, splat, dab and confetti chip
 * rendered washed-out pastel next to the HUD's saturated swatch (0.42 linear
 * is ~0.68 on screen). Material colours now go through
 * `Color.setRGB(r, g, b, SRGBColorSpace)`; raw instance-colour buffers, which
 * three never converts, go through this.
 */
export function srgbToLinear(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/** Paint dabs on the board, in arc order. One per palette colour. */
export const PALETTE_DAB_ORDER: ReadonlyArray<
  readonly [number, number, number, number]
> = PALETTE_COLORS;

/** One chip in the row along the board's near edge. @see PALETTE_CHIP_ORDER */
export interface PaletteChipSpec {
  /** Ball kind this chip loads. Ignored for Web chips, which always fly Normal. */
  readonly kind: BallKind;
  /** Which paint pool this chip's ammo lands in. */
  readonly style: BallStyle;
  /** Floating label above the chip. ASCII, uppercase, short enough to read. */
  readonly label: string;
  /** Identity colour, `#rrggbb`. Tints the chip and its selected emissive lift. */
  readonly color: string;
}

/**
 * The chip row along the board's near edge, left to right.
 *
 * Rounds 3-4 relied on silhouette alone — sphere, ringed sphere, cube, faceted
 * rock — because the board was thought too small to letter. Field feedback,
 * round 4: "chips look bad", nobody could tell them apart. So round 5 gives
 * each chip an identity **colour** and a tiny floating **label**, and the
 * silhouettes stay as a third redundant cue rather than the only one.
 *
 * Round 5 added a fifth WEB chip ("web is ammo, not a mode"); round 8 made
 * GOO a launcher as well, and round 10 removed the chip: on the wrist menu GOO
 * lives in the LAUNCHER row and this table is the AMMO row, paint kinds only.
 * Picking one of these while GOO is loaded returns to the last paint launcher
 * (BallSpawnSystem's `syncBlasterMode` subscription).
 */
export const PALETTE_CHIP_ORDER: ReadonlyArray<PaletteChipSpec> = [
  // Plain sphere. Warm off-white, so "default" does not read as "disabled".
  {
    kind: BallKind.Normal,
    style: BallStyle.Paint,
    label: 'NORMAL',
    color: '#f5f2ec',
  },
  // Sphere in a hoop, amber: "this one comes back at you".
  {
    kind: BallKind.Bouncy,
    style: BallStyle.Paint,
    label: 'BOUNCY',
    color: '#ffca57',
  },
  // Cube, coral: flat faces read as "this one stops dead where it lands".
  {
    kind: BallKind.Sticky,
    style: BallStyle.Paint,
    label: 'STICKY',
    color: '#ff6b6b',
  },
  // Faceted rock, sky: a burst, mid-shatter.
  {
    kind: BallKind.Splash,
    style: BallStyle.Paint,
    label: 'SPLASH',
    color: '#48dbfb',
  },
  // Round 10: the fifth chip (WEB / GOO) is gone. GOO is a LAUNCHER on the
  // wrist menu's top row, so the ammo row is the four paint kinds only.
];

/**
 * Paint kinds in chip order. Derived rather than declared so the chip row and
 * the kind list can never drift apart — config.test.ts asserts the row covers
 * every BallKind, and that assertion is only worth anything if there is one
 * source of truth.
 */
export const PALETTE_KIND_ORDER: ReadonlyArray<BallKind> = PALETTE_CHIP_ORDER
  .filter((chip) => chip.style === BallStyle.Paint)
  .map((chip) => chip.kind);

export const PALETTE_DAB_COUNT = PALETTE_DAB_ORDER.length;
export const PALETTE_CHIP_COUNT = PALETTE_CHIP_ORDER.length;
/** Colour + ammo buttons on the wrist menu (launchers excluded). Was 16 in rounds 1-2. */
export const PALETTE_PRESSABLE_COUNT = PALETTE_DAB_COUNT + PALETTE_CHIP_COUNT;

/**
 * What the HUD footer says is loaded, in ASCII caps.
 *
 * Three axes collapse to one word, and the precedence is the same one
 * `resolveShot` applies to the ball itself: webbing overrides the paint kind
 * (a footer reading STICKY while you throw white webbing would be a lie), and
 * the sub-mode overrides the word WEB (TETHER and WEB fly the same but do
 * completely different things on contact, which is exactly what a footer is
 * for).
 *
 * Lives here rather than in HudSystem so it can be tested without dragging the
 * panel, the easel and four other systems into a unit test — and because every
 * enum it reads is declared in this file.
 */
export function ammoLabel(
  style: BallStyle,
  subMode: WebSubMode,
  kind: BallKind,
): string {
  if (style === BallStyle.Web) {
    // Round 9: GOO is the player-facing name for web ammo; TETHER stays.
    return subMode === WebSubMode.Tether ? 'TETHER' : 'GOO';
  }
  return (BALL_KIND_NAMES[kind] ?? BALL_KIND_NAMES[BallKind.Normal])
    .toUpperCase();
}

// Game HUD reactive state — stored as @preact/signals-core signals on
// world.globals in the main entry point; this interface just documents
// the shape expected by the HUD binding system.
export interface GameHudState {
  score: number;        // current score
  timer: string;        // 'm:ss' formatted remaining time
  status: string;       // one-line status text shown under score/timer
}

// Placeholder values only: GameStateSystem.init() rewrites hudTimer/hudStatus
// (from GAME.roundSec and the real Idle copy) before the first frame renders.
export const INITIAL_HUD_STATE: GameHudState = {
  score: 0,
  timer: '0:00',
  // Round 9: matches the PLAY button (was a stale "Press START").
  status: 'Press PLAY to start, or CHILL MODE to just paint',
};

/**
 * The loadout the player starts with — the first dab and the first chip.
 * main.ts pre-highlights those two elements and seeds the matching signals, so
 * the highlight and the ammo agree from frame one.
 */
export const INITIAL_PALETTE_SELECTION = {
  color: PALETTE_DAB_ORDER[0],
  kind: PALETTE_CHIP_ORDER[0].kind,
  style: PALETTE_CHIP_ORDER[0].style,
  /**
   * Splat, so the first web anyone throws behaves the way webbing has behaved
   * since round 4. The tether is the interesting one, but discovering it should
   * be a decision, not an ambush the first time you load the WEB chip.
   */
  subMode: WebSubMode.Splat,
  /** Round 8: the paint blaster is what people came for. */
  blasterMode: BlasterMode.Paint as BlasterMode,
} as const;

// Round state machine. Stored as a signal on world.globals.gamePhase and read
// by every system that must behave differently between "sandbox" and "round".
//
// Chill is a sibling of Playing, not a step on the way to it: entered from Idle
// by the CHILL MODE button and left again by EXIT CHILL. It has no clock, no
// robots and no scoring — firing and the easel are the whole feature.
//
// There used to be a sixth phase here. Round 4 shipped `Web: 5`, a second
// sandbox you entered from the title screen to throw webbing, and round 5
// deleted it outright: field feedback was "I want web mode AND chill mode —
// same interactions", which a mutually exclusive phase can never give you.
// Webbing became {@link BallStyle}, a chip on the wrist palette, so it works in
// every firing phase at once. Nothing was renumbered — 5 is simply gone — so
// every phase number ever persisted still means what it used to.
export const GamePhase = {
  Idle: 0,
  Countdown: 1,
  Playing: 2,
  GameOver: 3,
  Chill: 4,
} as const;

export type GamePhase = typeof GamePhase[keyof typeof GamePhase];

/**
 * Things that happened this frame, worth reacting to elsewhere.
 *
 * Producers write into world.globals.gameEvents; HUD/feedback/scoring systems
 * read it later in the same frame; EventFlushSystem clears it at priority 90.
 * This is deliberately a value enum rather than string events so the buffer
 * can stay a TypedArray.
 */
export const GameEvent = {
  BallFired: 0,
  BallImpact: 1,
  SplatPainted: 2,
  BallStuck: 3,
  AmmoSelected: 4,
  TargetHit: 5,
  TargetPopped: 6,
  RoundStart: 7,
  RoundEnd: 8,
  CountdownTick: 9,
  ComboMilestone: 10,
  /**
   * A HUD button was activated. Emitted by HudSystem for every button, purely
   * so FeedbackSystem can put a click under the finger — field feedback was
   * that presses had no confirmation at all. `data` is always 0.
   */
  UiClick: 11,

  // ---- Tether (round 6) ----------------------------------------------------
  //
  // Three rather than two because every cue in this game is FeedbackSystem's to
  // play, and a tether has three distinct moments that each want a different
  // one. Reaching into the haptics from WebShooterSystem would have saved an
  // event and split the feedback across two files.
  /**
   * A tether web latched onto a robot. `data` is {@link packTetherData} — pool
   * slot in the low byte, firing hand in bit 8. Sounds like a web landing,
   * because it is one.
   */
  TetherAttached: 12,
  /**
   * One reel step happened this frame — a yank, or a tick of hold-reeling.
   * `data` is the hand in bit 8, same layout, so {@link unpackFiredHand} reads
   * it. Silent: it is a haptic tick, not a sound, and it repeats several times
   * a second.
   */
  TetherReeled: 13,
  /**
   * A tethered robot was reeled inside the kill radius and popped. Emitted
   * *alongside* the ordinary TargetPopped (which carries the score and the pop
   * cue), purely so the rumble can be the harder one that a kill you dragged in
   * by hand deserves. `data` is {@link packTetherData}.
   */
  TetherPopped: 14,

  // ---- Gauntlet blasters (round 8) -----------------------------------------
  /**
   * The gauntlets changed mode (HAND / BLASTER / WEB). Emitted by
   * GauntletSystem as it starts the deploy/stow animation, so FeedbackSystem
   * can put a click and a buzz under it. `data` is the new {@link BlasterMode};
   * the position is unused (the cue is non-positional).
   */
  BlasterModeChanged: 15,

  // ---- Neatniks (round 8) -------------------------------------------------
  //
  // Numbered from 20 so parallel round-8 streams adding events of their own
  // (15+) cannot collide with these in a merge.
  /**
   * A Squeegee's shield bounced a ball away with no damage. Position = the
   * shield, `data` = pool slot. The ball keeps flying (deflected).
   */
  ShieldDeflected: 20,
  /**
   * Duster Duke has started his entrance drop. Position = his landing spot,
   * `data` = pool slot. A cue for an announcer bark / boss music sting.
   */
  BossEntered: 21,

  // ---- Onboarding + coaching (round 9) ---------------------------------------
  /**
   * A Neatnik woke up (spawn director, boss split, debug spawn). Position =
   * where it appeared; `data` = {@link packPopData}(slot, archetype, 0), so
   * {@link unpackPopSlot} / {@link unpackPopArchetype} read it. CoachSystem's
   * first-encounter tips key off it.
   */
  BotSpawned: 22,
  /**
   * The first-run tutorial finished a step. `data` = the step just completed
   * ({@link TutorialStep}). Emitted by TutorialSystem for any cue that wants it.
   */
  TutorialStepDone: 23,

  // ---- Wrist menu (round 10) -------------------------------------------------
  /**
   * The summonable wrist menu opened (`data` 1) or closed (`data` 0).
   * Position = the summon gem. Emitted by WristMenuSystem alongside a UiClick
   * (the audible cue); the tutorial's menu step keys off it.
   */
  MenuToggled: 24,
} as const;

export type GameEvent = typeof GameEvent[keyof typeof GameEvent];

/**
 * Pack a BallFired event's `data` word: ball kind in the low byte, the firing
 * hand in bit 8 (0 left, 1 right), the paint style in bit 9.
 *
 * FeedbackSystem is the only consumer and needs all three: the kind for nothing
 * yet, the hand to buzz the right controller, and the style to choose between
 * the paint trigger and the thwip. Round 4 chose that last one by looking at
 * the game phase, which stopped being possible the moment webbing became ammo
 * you can load in any phase.
 */
export function packFiredData(
  kind: BallKind,
  hand: number,
  style: BallStyle,
): number {
  return (
    (kind & 0xff) |
    ((hand & 1) << 8) |
    ((style === BallStyle.Web ? 1 : 0) << 9)
  );
}

/** Firing hand out of a {@link packFiredData} word: 'left' or 'right'. */
export function unpackFiredHand(data: number): 'left' | 'right' {
  return (data >> 8) & 1 ? 'right' : 'left';
}

/** Paint style out of a {@link packFiredData} word. */
export function unpackFiredStyle(data: number): BallStyle {
  return (data >> 9) & 1 ? BallStyle.Web : BallStyle.Paint;
}

/**
 * Pack a tether event's `data` word: robot pool slot in the low byte, the hand
 * holding the line in bit 8.
 *
 * Deliberately the *same* bit-8 hand convention {@link packFiredData} uses, so
 * {@link unpackFiredHand} reads a tether event without a second unpacker. The
 * slot sits where the ball kind sits on a fired word — both are "which one of
 * a small pool", and neither ever exceeds 255.
 */
export function packTetherData(slot: number, hand: number): number {
  return (slot & 0xff) | ((hand & 1) << 8);
}

/** Robot pool slot out of a {@link packTetherData} word. */
export function unpackTetherSlot(data: number): number {
  return data & 0xff;
}

/**
 * Bit of a {@link packImpactData} word that means "this was webbing, not paint".
 *
 * It lives inside the kind byte rather than above the colour because the colour
 * already fills the top 24 bits and there is nowhere else to go. BallKind only
 * ever reaches 3, so bits 2..6 are spare and bit 7 is free real estate — which
 * is why {@link unpackImpactKind} masks 0x7f and not 0xff.
 */
export const IMPACT_STYLE_BIT = 0x80;

/**
 * Pack a BallImpact event's `data` word: ball kind in bits 0..6, the paint
 * style in bit 7, the paint colour as 0xRRGGBB in the upper 24 bits.
 *
 * The event buffer carries one integer per event, and three consumers need
 * different slices of it: scoring wants nothing but the event, EaselSystem
 * needs the colour and the mask to stamp with, FeedbackSystem needs to pick the
 * splat or the web hit. Packing beats widening the buffer, and it mirrors the
 * existing BallFired convention (hand in bit 8, style in bit 9).
 *
 * Channels are 0..1 floats; the result is a signed int32 (the top bit of a
 * bright colour makes it negative), which Int32Array round-trips exactly —
 * {@link unpackImpactRgb} uses an unsigned shift to read it back.
 */
export function packImpactData(
  kind: BallKind,
  r: number,
  g: number,
  b: number,
  style: BallStyle = BallStyle.Paint,
): number {
  const channel = (value: number) =>
    Math.round(Math.min(1, Math.max(0, value)) * 255);
  const rgb = (channel(r) << 16) | (channel(g) << 8) | channel(b);
  const styleBit = style === BallStyle.Web ? IMPACT_STYLE_BIT : 0;
  return (kind & 0x7f) | styleBit | (rgb << 8);
}

/** Ball kind out of a {@link packImpactData} word. */
export function unpackImpactKind(data: number): BallKind {
  return (data & 0x7f) as BallKind;
}

/** Paint style out of a {@link packImpactData} word. */
export function unpackImpactStyle(data: number): BallStyle {
  return (data & IMPACT_STYLE_BIT) !== 0 ? BallStyle.Web : BallStyle.Paint;
}

/** Paint colour (0xRRGGBB) out of a {@link packImpactData} word. */
export function unpackImpactRgb(data: number): number {
  return data >>> 8;
}

/** Events past this many in one frame are dropped rather than allocating. */
export const GAME_EVENT_CAPACITY = 64;

/**
 * Fixed-capacity, struct-of-arrays event buffer shared across systems.
 *
 * Allocates its four TypedArrays once at construction and never again — the
 * whole point is that emitting an event during a 90 FPS frame costs no GC
 * pressure. Each event carries an optional world position (impact site, target
 * position) and one integer payload (ball kind, score delta, combo level).
 *
 * Overflow is dropped silently rather than growing: 64 events in a single
 * frame already means something is wrong, and a dropped cosmetic event is
 * cheaper than a frame-time spike.
 */
export class GameEventBuffer {
  readonly capacity: number;

  private _count = 0;
  private readonly types: Int16Array;
  private readonly positions: Float32Array;
  private readonly data: Int32Array;

  constructor(capacity: number = GAME_EVENT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(
        `GameEventBuffer capacity must be a positive integer, got ${capacity}`,
      );
    }
    this.capacity = capacity;
    this.types = new Int16Array(capacity);
    this.positions = new Float32Array(capacity * 3);
    this.data = new Int32Array(capacity);
  }

  /** Number of events emitted since the last clear(). */
  get count(): number {
    return this._count;
  }

  /**
   * Append one event. Returns false when the buffer is full (event dropped).
   */
  emit(
    type: GameEvent,
    x = 0,
    y = 0,
    z = 0,
    data = 0,
  ): boolean {
    if (this._count >= this.capacity) {
      return false;
    }
    const slot = this._count++;
    const base = slot * 3;
    this.types[slot] = type;
    this.positions[base] = x;
    this.positions[base + 1] = y;
    this.positions[base + 2] = z;
    this.data[slot] = data;
    return true;
  }

  typeAt(index: number): GameEvent {
    return this.types[index] as GameEvent;
  }

  xAt(index: number): number {
    return this.positions[index * 3];
  }

  yAt(index: number): number {
    return this.positions[index * 3 + 1];
  }

  zAt(index: number): number {
    return this.positions[index * 3 + 2];
  }

  dataAt(index: number): number {
    return this.data[index];
  }

  /**
   * Drop every event. Only the count is reset — stale bytes past `count` are
   * never read, so zeroing the arrays would be wasted work every frame.
   */
  clear(): void {
    this._count = 0;
  }
}

/**
 * Where the live robots are, for aim assist (round 7).
 *
 * TargetSystem writes it every frame of a round; BallSpawnSystem reads it when
 * a shot is taken. A shared struct in `world.globals` rather than a system
 * call because TargetSystem imports BallSpawnSystem (for the Ball component),
 * and importing it back would close a module cycle that throws at load time —
 * the same reason `tetheredHands` is a signal.
 *
 * Fixed capacity, allocated once: `positions` is xyz per pool slot, and
 * `active[slot]` is 1 for a robot that can currently be shot. Slots past the
 * pool size simply stay inactive.
 */
export class AimTargets {
  readonly positions: Float32Array;
  readonly active: Uint8Array;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = Math.max(0, Math.floor(capacity));
    this.positions = new Float32Array(this.capacity * 3);
    this.active = new Uint8Array(this.capacity);
  }

  /** Mark every slot inactive — a round ended, or the pool was reset. */
  clear(): void {
    this.active.fill(0);
  }
}

/**
 * Where each hand's gauntlet launches from this frame (round 8).
 *
 * Written by GauntletSystem (priority 9) after it poses the hardware, read by
 * BallSpawnSystem (11) when the trigger or pinch fires in BLASTER or WEB mode,
 * so the shot leaves the barrel the player can see. A struct on
 * `world.globals.gauntletMuzzles` rather than a system call for the same
 * reason as {@link AimTargets}: GauntletSystem imports BallSpawnSystem (for
 * the Ball component), and importing it back would close a module cycle.
 *
 * Index 0 = left hand, 1 = right; vectors are xyz triples.
 */
export class GauntletMuzzles {
  /** 1 while that hand has a posed gauntlet whose mode launches from it. */
  readonly valid = new Uint8Array(2);
  /** World-space launch point (muzzle plus clearance), xyz per hand. */
  readonly origin = new Float32Array(6);
  /** Unit launch direction (the shown barrel's -Z), xyz per hand. */
  readonly direction = new Float32Array(6);
}

/**
 * The Neatnik cast members TargetSystem spawns (round 8). Pip is not here:
 * the mascot is never a target. Order matches the wave weight triples in
 * `NEATNIKS.waves` (mopsy, squeegee, peekaboo); the boss comes last.
 */
export const Neatnik = {
  Mopsy: 0,
  Squeegee: 1,
  Peekaboo: 2,
  DusterDuke: 3,
} as const;

export type Neatnik = typeof Neatnik[keyof typeof Neatnik];

/** Number of Neatnik archetypes. */
export const NEATNIK_COUNT = 4;

/**
 * Pack a TargetPopped event's `data` word (round 8): pool slot in the low
 * byte — exactly what the word held before, so any reader of the slot is
 * unchanged — the archetype in bits 8..11, and the robot's base points in
 * bits 12..30.
 *
 * Points ride on the event so GameStateSystem can score a boss pop higher
 * without importing TargetSystem or the archetype table. A word with 0 points
 * (anything emitted by older code) scores the classic `GAME.scoreTargetHit`.
 */
export function packPopData(
  slot: number,
  archetype: number,
  points: number,
): number {
  const pts = Math.max(0, Math.min(0x7ffff, Math.round(points)));
  return (slot & 0xff) | ((archetype & 0xf) << 8) | (pts << 12);
}

/** Pool slot out of a {@link packPopData} word. */
export function unpackPopSlot(data: number): number {
  return data & 0xff;
}

/** Archetype ({@link Neatnik}) out of a {@link packPopData} word. */
export function unpackPopArchetype(data: number): number {
  return (data >> 8) & 0xf;
}

/** Base points out of a {@link packPopData} word; 0 = "use the default". */
export function unpackPopPoints(data: number): number {
  return (data >>> 12) & 0x7ffff;
}

// ---------------------------------------------------------------------------
// Round 8: HUD / Armory / palette presentation helpers. Pure, so they test
// without a panel or a World.
// ---------------------------------------------------------------------------

/**
 * One line per launcher for the LOADOUT screen's description row. ASCII
 * (gotcha 24), short enough for one line at the round-9 minimum font size.
 */
export const BLASTER_MODE_DESCRIPTIONS: Readonly<Record<BlasterMode, string>> = {
  [BlasterMode.Hand]: 'Bare hands. Paint flies from your fingertips.',
  [BlasterMode.Paint]: 'Paint gauntlet. Hold the pinch to auto-fire.',
  [BlasterMode.Web]: 'Sticky goo. SPLAT walls or TETHER a Neatnik.',
};

/**
 * Step an index round a ring of `count` slots (the Armory's < > arrows).
 * Wraps both ways; a non-integer or out-of-range start is clamped first, and
 * an empty ring always answers 0.
 */
export function cycleIndex(index: number, delta: number, count: number): number {
  if (!(count > 0)) return 0;
  const n = Math.floor(count);
  const start = clampIndex(index, n);
  const step = Math.trunc(delta) % n;
  return (((start + step) % n) + n) % n;
}

/** An index forced into [0, count), with anything non-finite becoming 0. */
export function clampIndex(index: number, count: number): number {
  if (!(count > 0) || !Number.isFinite(index)) return 0;
  return Math.min(Math.floor(count) - 1, Math.max(0, Math.floor(index)));
}

/**
 * A stored skin index (localStorage hands back a string or null) as a valid
 * slot. Anything unparsable or out of range falls back to 0 rather than being
 * clamped to the end of the list: a stale value from a longer skin list says
 * nothing about which of today's skins the player wanted.
 */
export function parseStoredSkin(raw: string | null | undefined, count: number): number {
  if (raw == null || !(count > 0)) return 0;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return 0;
  const n = Number.parseInt(trimmed, 10);
  return n < count ? n : 0;
}

/** The minimal Storage surface the skin persistence touches. */
export interface SkinStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Read the persisted skin. Never throws (private mode, blocked storage). */
export function readSkin(
  storage: SkinStorage | undefined,
  key: string,
  count: number,
): number {
  try {
    return parseStoredSkin(storage?.getItem(key), count);
  } catch {
    return 0;
  }
}

/** Persist the skin. Never throws; returns false when storage refused it. */
export function writeSkin(
  storage: SkinStorage | undefined,
  key: string,
  index: number,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, String(Math.max(0, Math.floor(index))));
    return true;
  } catch {
    return false;
  }
}

/** "SKIN 2 OF 5" — the Armory card's counter. */
export function skinCounterLabel(index: number, count: number): string {
  const n = Math.max(0, Math.floor(count));
  return `SKIN ${n === 0 ? 0 : clampIndex(index, n) + 1} OF ${n}`;
}

/** 15400 -> "15,400": the score numerals the title art promises. ASCII. */
export function formatScore(score: number): string {
  const n = Number.isFinite(score) ? Math.max(0, Math.round(score)) : 0;
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Neatnik count with the right plural (round 9 rebrand; was "bots"). */
export function botsLabel(alive: number): string {
  const n = Number.isFinite(alive) ? Math.max(0, Math.round(alive)) : 0;
  return n === 1 ? '1 Neatnik' : `${n} Neatniks`;
}

/** Strictly beat the best that stood when the round began (a tie is not a record). */
export function isNewBest(score: number, bestAtRoundStart: number): boolean {
  return score > 0 && score > bestAtRoundStart;
}

/**
 * True when every character is printable ASCII (space..tilde). The HUD's MSDF
 * font has nothing else (gotcha 24), and the palette's canvas labels follow the
 * same rule so a label never renders differently in one place than another.
 */
export function isPrintableAscii(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text);
}

/** '#ff4f81' -> 0xff4f81. Malformed input gives white, never NaN. */
export function hexToInt(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  return m ? Number.parseInt(m[1], 16) : 0xffffff;
}

/**
 * A point on a superellipse ("squircle") outline: |x/a|^n + |y/b|^n = 1.
 * n = 2 is the ellipse, larger n squares it off. `angle` in radians; writes
 * into `out` ([x, y]) and returns it.
 */
export function superellipsePoint(
  angle: number,
  a: number,
  b: number,
  n: number,
  out: [number, number] = [0, 0],
): [number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const e = 2 / Math.max(0.1, n);
  out[0] = a * Math.sign(c) * Math.pow(Math.abs(c), e);
  out[1] = b * Math.sign(s) * Math.pow(Math.abs(s), e);
  return out;
}

/**
 * Sample a piecewise-linear colour ramp through `stops` (sRGB hex) at t in
 * [0, 1] (clamped). Writes 0..1 sRGB floats into `out` and returns it. A single
 * stop is a flat colour; no stops is white.
 */
export function rampColor(
  t: number,
  stops: readonly string[],
  out: [number, number, number] = [1, 1, 1],
): [number, number, number] {
  if (stops.length === 0) {
    out[0] = out[1] = out[2] = 1;
    return out;
  }
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  if (i < 0) {
    const c = hexToInt(stops[0]);
    out[0] = ((c >> 16) & 0xff) / 255;
    out[1] = ((c >> 8) & 0xff) / 255;
    out[2] = (c & 0xff) / 255;
    return out;
  }
  const f = x - i;
  const c0 = hexToInt(stops[i]);
  const c1 = hexToInt(stops[i + 1]);
  for (let k = 0; k < 3; k++) {
    const shift = 16 - 8 * k;
    const v0 = ((c0 >> shift) & 0xff) / 255;
    const v1 = ((c1 >> shift) & 0xff) / 255;
    out[k] = v0 + (v1 - v0) * f;
  }
  return out;
}

/**
 * Ease-out with a small overshoot (the "pop" of the palette appear animation).
 * 0 at t=0, 1 at t=1, peaks a few percent above 1 just before the end.
 * `t` is clamped to [0, 1].
 */
export function easeOutBack(t: number, overshoot = 1.70158): number {
  const x = Math.min(1, Math.max(0, t)) - 1;
  return 1 + (overshoot + 1) * x * x * x + overshoot * x * x;
}

/** Smooth 0 -> 1 ease for fades. `t` clamped to [0, 1]. */
export function easeOutCubic(t: number): number {
  const x = 1 - Math.min(1, Math.max(0, t));
  return 1 - x * x * x;
}

/**
 * Scale and glow of the palette's appear animation `elapsed` seconds after it
 * (re)appeared, over `duration` seconds: scale pops up from `fromScale` with a
 * slight overshoot, glow fades in on a plain ease. Writes into `out` so the
 * per-frame caller allocates nothing; returns true while still animating.
 */
export function appearFrame(
  elapsed: number,
  duration: number,
  fromScale: number,
  out: { scale: number; glow: number },
): boolean {
  if (!(duration > 0) || elapsed >= duration) {
    out.scale = 1;
    out.glow = 1;
    return false;
  }
  const t = Math.max(0, elapsed) / duration;
  out.scale = fromScale + (1 - fromScale) * easeOutBack(t, 1.4);
  out.glow = easeOutCubic(t);
  return true;
}

// ---------------------------------------------------------------------------
// Round 9: onboarding, coaching and the results card. Pure, so they test
// without a panel or a World. Player-facing copy follows the round-9 rebrand:
// the game is Splotopia, the robot gang are the Neatniks (identifiers such as
// `Neatnik` keep their old names until the identifier-rename pass).
// ---------------------------------------------------------------------------

/** Neatnik names as the results card prints them, indexed by {@link Neatnik}. */
export const NEATNIK_SHORT_NAMES: readonly string[] = [
  'MOPSY',
  'SQUEEGEE',
  'PEEKABOO',
  'DUKE',
];

/** Full Neatnik names (coaching labels), indexed by {@link Neatnik}. */
export const NEATNIK_NAMES: readonly string[] = [
  'MOPSY',
  'SQUEEGEE',
  'PEEKABOO',
  'DUSTER DUKE',
];

/**
 * The first-run tutorial's steps (TutorialSystem). Off = no tutorial running.
 * Goo / Tether / Haul are one player-facing step ("use the goo tether") split
 * so each sub-action gets its own one-line instruction.
 */
export const TutorialStep = {
  Off: 0,
  /** Pinch to fire at the ring on your wall. */
  Fire: 1,
  /** Open the wrist menu (tap the gem) and tap a colour. */
  Palette: 2,
  /** Pop one Mopsy. */
  Pop: 3,
  /** Load GOO from the wrist menu's LAUNCHER row. */
  Goo: 4,
  /** Pick the TETHER sub-mode. */
  Tether: 5,
  /** Hook a Mopsy and pull it in. */
  Haul: 6,
  /** "You're ready" - hands over to the title with PLAY lit. */
  Ready: 7,
} as const;

export type TutorialStep = typeof TutorialStep[keyof typeof TutorialStep];

/** How many player-facing steps the tutorial has (Goo+Tether+Haul are one). */
export const TUTORIAL_STEP_COUNT = 5;

/** 1-based player-facing step number for the HUD's "STEP 2 OF 5" (0 when off). */
export function tutorialStepNumber(step: number): number {
  switch (step) {
    case TutorialStep.Fire:
      return 1;
    case TutorialStep.Palette:
      return 2;
    case TutorialStep.Pop:
      return 3;
    case TutorialStep.Goo:
    case TutorialStep.Tether:
    case TutorialStep.Haul:
      return 4;
    case TutorialStep.Ready:
      return 5;
    default:
      return 0;
  }
}

/** The step after `step` (Ready is last; anything unknown ends the tutorial). */
export function nextTutorialStep(step: number): TutorialStep {
  switch (step) {
    case TutorialStep.Fire:
      return TutorialStep.Palette;
    case TutorialStep.Palette:
      return TutorialStep.Pop;
    case TutorialStep.Pop:
      return TutorialStep.Goo;
    case TutorialStep.Goo:
      return TutorialStep.Tether;
    case TutorialStep.Tether:
      return TutorialStep.Haul;
    case TutorialStep.Haul:
      return TutorialStep.Ready;
    default:
      return TutorialStep.Off;
  }
}

/** Steps that need live Neatniks, i.e. run inside a practice round. */
export function tutorialStepNeedsBots(step: number): boolean {
  return (
    step === TutorialStep.Pop ||
    step === TutorialStep.Goo ||
    step === TutorialStep.Tether ||
    step === TutorialStep.Haul
  );
}

/** The minimal Storage surface the round-9 flags touch (same as skins). */
export type FlagStorage = SkinStorage;

/** A persisted boolean ("1"). Never throws (private mode, blocked storage). */
export function readFlag(storage: FlagStorage | undefined, key: string): boolean {
  try {
    return storage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

/** Persist a boolean. Never throws; returns false when storage refused it. */
export function writeFlag(
  storage: FlagStorage | undefined,
  key: string,
  value: boolean,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

/** A persisted small bitmask. Junk reads as 0. Never throws. */
export function readMask(storage: FlagStorage | undefined, key: string): number {
  try {
    const raw = storage?.getItem(key);
    if (raw == null || !/^\d{1,4}$/.test(raw.trim())) return 0;
    return Number.parseInt(raw.trim(), 10) & 0xff;
  } catch {
    return 0;
  }
}

/** Persist a small bitmask. Never throws; false when storage refused it. */
export function writeMask(
  storage: FlagStorage | undefined,
  key: string,
  mask: number,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, String(mask & 0xff));
    return true;
  } catch {
    return false;
  }
}

/**
 * First-encounter coaching: should a spawn of `archetype` show its tip?
 * Mopsy never does (the tutorial teaches it); every other Neatnik does once,
 * until its bit is in `seenMask` (this session, or remembered from earlier
 * ones so veterans are not nagged).
 */
export function shouldCoach(archetype: number, seenMask: number): boolean {
  if (archetype <= Neatnik.Mopsy || archetype >= NEATNIK_COUNT) return false;
  return (seenMask & (1 << archetype)) === 0;
}

/** `seenMask` with `archetype` marked seen. */
export function markSeen(seenMask: number, archetype: number): number {
  if (archetype < 0 || archetype >= NEATNIK_COUNT) return seenMask;
  return (seenMask | (1 << archetype)) & 0xff;
}

/**
 * Everything the GameOver results card shows, gathered from one round's
 * GameEvents by {@link recordRoundEvent}. One object per GameStateSystem,
 * reset at each round start; a detached copy is published at GameOver.
 */
export interface RoundStats {
  /** Pops per archetype, indexed by {@link Neatnik}. */
  pops: number[];
  /** Balls fired (paint and goo). */
  shots: number;
  /** Shots that landed on a Neatnik (damage or a tether latch). */
  hits: number;
  /** Highest combo multiplier reached. 1 = never chained. */
  bestCombo: number;
  /** Duster Duke showed up this round. */
  bossSeen: boolean;
  /** Final score. */
  score: number;
  /** Best score that stood when the round began. */
  bestBefore: number;
}

export function createRoundStats(): RoundStats {
  return {
    pops: new Array<number>(NEATNIK_COUNT).fill(0),
    shots: 0,
    hits: 0,
    bestCombo: 1,
    bossSeen: false,
    score: 0,
    bestBefore: 0,
  };
}

/** Zero `stats` in place for a fresh round. */
export function resetRoundStats(stats: RoundStats, bestBefore: number): void {
  stats.pops.fill(0);
  stats.shots = 0;
  stats.hits = 0;
  stats.bestCombo = 1;
  stats.bossSeen = false;
  stats.score = 0;
  stats.bestBefore = bestBefore;
}

/** A detached copy (the published GameOver snapshot). */
export function copyRoundStats(stats: RoundStats): RoundStats {
  return { ...stats, pops: stats.pops.slice() };
}

/** Fold one GameEvent into the round's stats. Unknown events are ignored. */
export function recordRoundEvent(
  stats: RoundStats,
  type: number,
  data: number,
): void {
  switch (type) {
    case GameEvent.BallFired:
      stats.shots++;
      break;
    case GameEvent.TargetHit:
    case GameEvent.TetherAttached:
      stats.hits++;
      break;
    case GameEvent.TargetPopped: {
      const arch = unpackPopArchetype(data);
      if (arch >= 0 && arch < stats.pops.length) stats.pops[arch]++;
      break;
    }
    case GameEvent.ComboMilestone:
      if (data > stats.bestCombo) stats.bestCombo = data;
      break;
    case GameEvent.BossEntered:
      stats.bossSeen = true;
      break;
    default:
      break;
  }
}

/** Accuracy as a whole percentage, 0..100. No shots = 0. */
export function accuracyPercent(hits: number, shots: number): number {
  if (!(shots > 0)) return 0;
  return Math.round((Math.min(Math.max(0, hits), shots) / shots) * 100);
}

/** Total pops across the cast. */
export function totalPops(stats: RoundStats): number {
  let n = 0;
  for (const p of stats.pops) n += p;
  return n;
}

/** The next multiple of `step` strictly above `score` (a tidy target). */
export function nextMilestone(score: number, step = 500): number {
  const s = Math.max(0, Math.floor(Number.isFinite(score) ? score : 0));
  return (Math.floor(s / step) + 1) * step;
}

/**
 * The results card's one "next goal" line (<= ~40 chars, ASCII). First rule
 * that applies wins:
 *
 * 1. Popped nothing: teach the verb.
 * 2. The Duke showed up and walked away: name the tool that beats him.
 * 3. A new best: a tidy milestone above it.
 * 4. Short of the best: exactly how far.
 * 5. Otherwise (a tie): the next milestone.
 */
export function nextGoalLine(stats: RoundStats): string {
  if (totalPops(stats) === 0) return 'Next: pinch at a Neatnik to pop it';
  if (stats.bossSeen && (stats.pops[Neatnik.DusterDuke] ?? 0) === 0) {
    return 'Next: pop the Duke - GOO TETHER helps';
  }
  if (isNewBest(stats.score, stats.bestBefore)) {
    return `Next: crack ${formatScore(nextMilestone(stats.score))}`;
  }
  if (stats.bestBefore > stats.score) {
    return `Next: ${formatScore(stats.bestBefore - stats.score + 1)} more beats your best`;
  }
  return `Next: crack ${formatScore(nextMilestone(stats.score))}`;
}

/**
 * Where Pip should fly to and point at (round 9). Written by TutorialSystem
 * (the active step's subject: the wall ring, the wrist palette, a Mopsy),
 * read by PipSystem. A struct in `world.globals` rather than a system call so
 * PipSystem keeps knowing nothing about the tutorial.
 */
export class PipFocus {
  /** 1 while Pip should leave the HUD and hover by `position`. */
  active = 0;
  /** World-space point of interest, xyz. */
  readonly position = new Float32Array(3);
  /**
   * Where Pip hovers relative to `position`, metres, in the viewer's frame:
   * [to the viewer's left, up, toward the viewer]. So he sits beside the
   * subject, never on top of it or in the line of fire.
   */
  readonly offset = new Float32Array(3);
}

/**
 * Round 10: the summonable wrist menu's live state, in `world.globals.wristMenu`.
 * Written by WristMenuSystem (priority 8) every frame, read the same frame by
 * BallSpawnSystem (shot blocking), TutorialSystem (Pip's focus) and anything
 * else that cares. A struct rather than a system call so readers never import
 * the menu system (and so a closed menu is a plain `open === 0` check).
 */
export class WristMenuState {
  /** 1 while the menu is open and interactive (closed or animating shut = 0). */
  open = 0;
  /** 1 while the open menu is still scaling in (shown, not yet pressable). */
  opening = 0;
  /** Panel centre, world space (valid while `open` or `opening`). */
  readonly center = new Float32Array(3);
  /** Panel orientation (x, y, z, w); its +Z faces the eyes. */
  readonly quaternion = new Float32Array([0, 0, 0, 1]);
  /** Panel half extents, metres, in its own XY plane. */
  halfW = 0;
  halfH = 0;
  /** 1 while the right index fingertip is in the open panel's poke zone. */
  tipNear = 0;
  /** 1 while the summon gem is shown on the left wrist. */
  gemVisible = 0;
  /** Summon gem centre, world space (valid while `gemVisible`). */
  readonly gem = new Float32Array(3);
  /**
   * Hands whose current trigger / pinch press the menu spent (bit 0 left,
   * bit 1 right). BallSpawnSystem folds it into its own consumed-press latch
   * and clears it, so a menu click never also fires.
   */
  consumeMask = 0;
}
