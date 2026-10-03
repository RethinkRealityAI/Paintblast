/**
 * Round 10: the summonable wrist menu's pure logic — layout, hit testing, the
 * Quest-native poke state machine, the summon-gem poke, open/close rules, the
 * controller button mapping and the "a closed menu does nothing" invariants.
 *
 * No three.js, no ECS: WristMenuSystem feeds these numbers it has already
 * transformed into the panel's frame (+X right, +Y up, +Z out of the face
 * toward the eyes, origin at the panel centre), and the tests drive them
 * directly. Everything here is allocation free except the layout builder,
 * which runs once at startup.
 */
import {
  BLASTER_MODE_ORDER,
  BlasterMode,
  GamePhase,
  PALETTE_CHIP_ORDER,
  PALETTE_DAB_ORDER,
  WebSubMode,
} from './types';
import type { WristMenuState } from './types';

// ---------------------------------------------------------------------------
// Items and layout
// ---------------------------------------------------------------------------

/** What a menu button sets. */
export const MenuItemKind = {
  /** HAND / BLASTER / GOO — writes `blasterMode`. */
  Launcher: 0,
  /** SPLAT / TETHER — writes `webSubMode`. Only shown while GOO is loaded. */
  SubMode: 1,
  /** A paint colour — writes `activeColor`. */
  Colour: 2,
  /** A paint kind — writes `activeKind` (and returns to paint). */
  Ammo: 3,
} as const;
export type MenuItemKind = typeof MenuItemKind[keyof typeof MenuItemKind];

/** Row captions, ASCII caps (the menu bakes them to canvas textures). */
export const MENU_ROW_CAPTIONS: Readonly<Record<MenuItemKind, string>> = {
  [MenuItemKind.Launcher]: 'LAUNCHER',
  [MenuItemKind.SubMode]: 'GOO MODE',
  [MenuItemKind.Colour]: 'COLOUR',
  [MenuItemKind.Ammo]: 'AMMO',
};

/** SPLAT / TETHER, left to right. */
export const MENU_SUBMODE_ORDER: ReadonlyArray<WebSubMode> = [
  WebSubMode.Splat,
  WebSubMode.Tether,
];

/** Labels for the GOO row. */
export const MENU_SUBMODE_LABELS: Readonly<Record<WebSubMode, string>> = {
  [WebSubMode.Splat]: 'SPLAT',
  [WebSubMode.Tether]: 'TETHER',
};

/** One button: what it sets, and where it sits in the panel's XY plane. */
export interface MenuItem {
  readonly kind: MenuItemKind;
  /**
   * The value it sets: a BlasterMode, a WebSubMode, an index into
   * PALETTE_DAB_ORDER, or an index into PALETTE_CHIP_ORDER.
   */
  readonly value: number;
  /** Position in its row, left to right. */
  readonly column: number;
  /** Centre, metres, panel frame. */
  x: number;
  y: number;
  /** Full width / height, metres. */
  w: number;
  h: number;
  /** False when its row is hidden in this layout (the GOO row without GOO). */
  shown: boolean;
}

/** A row caption's centre line. */
export interface MenuCaption {
  readonly kind: MenuItemKind;
  y: number;
  shown: boolean;
}

/** The whole panel in one pose of the layout. */
export interface MenuLayout {
  /** Every button, in a fixed order (index = button id), shown or not. */
  readonly items: MenuItem[];
  readonly captions: MenuCaption[];
  /** Panel size, metres. */
  readonly width: number;
  readonly height: number;
}

/** The slice of MENU the layout reads. */
export interface MenuLayoutConfig {
  readonly padding: number;
  readonly cellWidth: number;
  readonly columns: number;
  readonly buttonGap: number;
  readonly rowGap: number;
  readonly captionHeight: number;
  readonly captionGap: number;
  readonly launcherHeight: number;
  readonly subModeHeight: number;
  readonly colourHeight: number;
  readonly ammoHeight: number;
}

/** The fixed button order every layout shares. */
function menuRowValues(kind: MenuItemKind): number[] {
  switch (kind) {
    case MenuItemKind.Launcher:
      return BLASTER_MODE_ORDER.map((m) => m as number);
    case MenuItemKind.SubMode:
      return MENU_SUBMODE_ORDER.map((m) => m as number);
    case MenuItemKind.Colour:
      return PALETTE_DAB_ORDER.map((_, i) => i);
    default:
      return PALETTE_CHIP_ORDER.map((_, i) => i);
  }
}

/** Rows top to bottom. */
const ROW_ORDER: readonly MenuItemKind[] = [
  MenuItemKind.Launcher,
  MenuItemKind.SubMode,
  MenuItemKind.Colour,
  MenuItemKind.Ammo,
];

function rowHeight(kind: MenuItemKind, cfg: MenuLayoutConfig): number {
  switch (kind) {
    case MenuItemKind.Launcher:
      return cfg.launcherHeight;
    case MenuItemKind.SubMode:
      return cfg.subModeHeight;
    case MenuItemKind.Colour:
      return cfg.colourHeight;
    default:
      return cfg.ammoHeight;
  }
}

/**
 * Lay the menu out: LAUNCHER, then (only with `showSubMode`) GOO MODE, then
 * COLOUR, then AMMO, each under a caption. Every row spans the same inner
 * width (the 4-across rows set it), so the 3 launchers and 2 GOO verbs come
 * out wider — bigger targets for the things that change the most.
 *
 * Built once per variant at startup; never called per frame.
 */
export function buildMenuLayout(
  showSubMode: boolean,
  cfg: MenuLayoutConfig,
): MenuLayout {
  const inner = cfg.columns * cfg.cellWidth + (cfg.columns - 1) * cfg.buttonGap;
  const width = inner + 2 * cfg.padding;
  const block = cfg.captionHeight + cfg.captionGap;

  let height = 2 * cfg.padding;
  let rows = 0;
  for (const kind of ROW_ORDER) {
    if (kind === MenuItemKind.SubMode && !showSubMode) continue;
    height += block + rowHeight(kind, cfg);
    rows++;
  }
  height += Math.max(0, rows - 1) * cfg.rowGap;

  const items: MenuItem[] = [];
  const captions: MenuCaption[] = [];
  let top = height / 2 - cfg.padding;
  for (const kind of ROW_ORDER) {
    const values = menuRowValues(kind);
    const shown = kind !== MenuItemKind.SubMode || showSubMode;
    const h = rowHeight(kind, cfg);
    const n = values.length;
    const w = (inner - (n - 1) * cfg.buttonGap) / n;
    const captionY = top - cfg.captionHeight / 2;
    const y = top - block - h / 2;
    captions.push({ kind, y: captionY, shown });
    for (let c = 0; c < n; c++) {
      items.push({
        kind,
        value: values[c],
        column: c,
        x: -inner / 2 + w / 2 + c * (w + cfg.buttonGap),
        y,
        w,
        h,
        shown,
      });
    }
    if (shown) top -= block + h + cfg.rowGap;
  }
  return { items, captions, width, height };
}

/**
 * The shown button under panel-frame point (x, y), with `margin` metres of
 * slop round every rect. -1 when none. Allocation free.
 */
export function hitTestMenu(
  layout: MenuLayout,
  x: number,
  y: number,
  margin: number,
): number {
  const items = layout.items;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.shown) continue;
    if (
      Math.abs(x - it.x) <= it.w / 2 + margin &&
      Math.abs(y - it.y) <= it.h / 2 + margin
    ) {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// The poke state machine (Quest-native press)
// ---------------------------------------------------------------------------

/** Where a fingertip is in its poke. */
export const PokePhase = {
  /** Nowhere near a button. */
  Idle: 0,
  /** In front of a button, within hover range. */
  Hover: 1,
  /** Pushing a button in (past its face, not yet deep enough). */
  Pressing: 2,
  /** This poke already selected; waits for the finger to back out. */
  Spent: 3,
  /** Behind the face without a proper approach; ignored until it backs out. */
  Behind: 4,
} as const;
export type PokePhase = typeof PokePhase[keyof typeof PokePhase];

/** Caller-owned poke state. Stepping allocates nothing. */
export interface PokeState {
  phase: PokePhase;
  /** The button being hovered / pressed / just selected; -1 for none. */
  target: number;
  /** Metres the target is pushed in (0 = at rest), for the sink animation. */
  depth: number;
}

export function createPokeState(): PokeState {
  return { phase: PokePhase.Idle, target: -1, depth: 0 };
}

/** The slice of MENU the poke machine reads. */
export interface PokeConfig {
  readonly hoverMeters: number;
  readonly selectDepthMeters: number;
  readonly rearmMeters: number;
  readonly maxBehindMeters: number;
}

/**
 * Advance one fingertip's poke by a frame.
 *
 * `z` is the fingertip skin's height above the button face (positive = in
 * front, toward the eyes; negative = pushed through); `hit` is the shown
 * button under the fingertip's XY (-1 for none); `tracked` false drops
 * everything.
 *
 * - **Hover** while within `hoverMeters` in front of a button.
 * - **Press** only by crossing the face FROM a hover: the hovered button is
 *   locked as the target and sinks with the finger.
 * - **Select** once the finger is `selectDepthMeters` past the face — once.
 *   The poke is then **Spent** until the finger backs out `rearmMeters` in
 *   front (hysteresis), so a resting finger never repeats.
 * - Sliding off the target mid-press cancels it; turning up behind the face
 *   without an approach (a hand swept through the panel, a fast pass) is
 *   **Behind** and ignored until the finger is back in front.
 *
 * @returns the selected button on the frame it is selected, else -1.
 */
export function stepPoke(
  s: PokeState,
  z: number,
  hit: number,
  tracked: boolean,
  cfg: PokeConfig,
): number {
  if (!tracked || !Number.isFinite(z)) {
    s.phase = PokePhase.Idle;
    s.target = -1;
    s.depth = 0;
    return -1;
  }

  if (s.phase === PokePhase.Spent || s.phase === PokePhase.Behind) {
    if (z > cfg.rearmMeters) {
      s.phase = PokePhase.Idle;
      s.target = -1;
      s.depth = 0;
      // Fall through: this frame may already be a hover.
    } else {
      if (s.phase === PokePhase.Spent) {
        s.depth = z < 0 ? Math.min(-z, cfg.selectDepthMeters) : 0;
      } else {
        s.depth = 0;
      }
      return -1;
    }
  }

  if (z >= 0) {
    if (z <= cfg.hoverMeters && hit >= 0) {
      s.phase = PokePhase.Hover;
      s.target = hit;
    } else {
      s.phase = PokePhase.Idle;
      s.target = -1;
    }
    s.depth = 0;
    return -1;
  }

  // Behind the face.
  const approached =
    (s.phase === PokePhase.Hover || s.phase === PokePhase.Pressing) &&
    s.target >= 0;
  if (!approached || -z > cfg.maxBehindMeters || hit !== s.target) {
    s.phase = PokePhase.Behind;
    s.target = approached && hit === s.target ? s.target : -1;
    s.depth = 0;
    return -1;
  }
  if (-z >= cfg.selectDepthMeters) {
    s.phase = PokePhase.Spent;
    s.depth = cfg.selectDepthMeters;
    return s.target;
  }
  s.phase = PokePhase.Pressing;
  s.depth = -z;
  return -1;
}

// ---------------------------------------------------------------------------
// The summon gem
// ---------------------------------------------------------------------------

/** Caller-owned gem-poke latch. */
export interface GemPokeState {
  /** True once the fingertip has been seen outside the exit radius. */
  armed: boolean;
  /** Clock (seconds) of the last toggle. */
  lastToggleSec: number;
}

export function createGemPokeState(): GemPokeState {
  return { armed: false, lastToggleSec: Number.NEGATIVE_INFINITY };
}

/** The slice of MENU the gem reads. */
export interface GemPokeConfig {
  readonly gemPokeEnterRadius: number;
  readonly gemPokeExitRadius: number;
  readonly gemDebounceSec: number;
}

/**
 * One frame of the summon gem. `dist` is the right index fingertip's distance
 * to the gem (Infinity when the right hand or the gem is not tracked).
 * `blocked` is true while the right hand is mid-pinch (firing) — a pinching
 * hand brushing past the wrist must never toggle the menu.
 *
 * Toggles on ENTRY into `gemPokeEnterRadius`, only if the fingertip was seen
 * outside `gemPokeExitRadius` since the last entry (so it cannot repeat while
 * resting on the gem, and cannot fire the moment tracking resumes with the
 * finger already there), and not within `gemDebounceSec` of the last toggle.
 * An entry while blocked is spent too: releasing a pinch on the gem does not
 * toggle it afterwards.
 *
 * @returns true on the frame the menu should toggle.
 */
export function stepGemPoke(
  s: GemPokeState,
  dist: number,
  nowSec: number,
  blocked: boolean,
  cfg: GemPokeConfig,
): boolean {
  if (!Number.isFinite(dist)) {
    s.armed = false;
    return false;
  }
  if (dist > cfg.gemPokeExitRadius) {
    s.armed = true;
    return false;
  }
  if (dist > cfg.gemPokeEnterRadius || !s.armed) return false;
  s.armed = false;
  if (blocked) return false;
  if (nowSec - s.lastToggleSec < cfg.gemDebounceSec) return false;
  s.lastToggleSec = nowSec;
  return true;
}

// ---------------------------------------------------------------------------
// Open / close rules
// ---------------------------------------------------------------------------

/** Why the open menu should close this frame. */
export const MenuCloseReason = {
  None: 0,
  /** No hover or press for `autoCloseIdleSec`. */
  Idle: 1,
  /** The left hand dropped tracking for longer than `closeAfterLostSec`. */
  LostHand: 2,
} as const;
export type MenuCloseReason = typeof MenuCloseReason[keyof typeof MenuCloseReason];

export interface MenuCloseConfig {
  readonly autoCloseIdleSec: number;
  readonly closeAfterLostSec: number;
}

/** Should the open menu close on its own? Lost hand wins over idle. */
export function menuAutoClose(
  idleSec: number,
  leftLostSec: number,
  cfg: MenuCloseConfig,
): MenuCloseReason {
  if (leftLostSec > cfg.closeAfterLostSec) return MenuCloseReason.LostHand;
  if (cfg.autoCloseIdleSec > 0 && idleSec >= cfg.autoCloseIdleSec) {
    return MenuCloseReason.Idle;
  }
  return MenuCloseReason.None;
}

export interface MenuPickCloseConfig {
  readonly closeOnPick: {
    readonly launcher: boolean;
    readonly gooLauncher: boolean;
    readonly subMode: boolean;
    readonly colour: boolean;
    readonly ammo: boolean;
  };
}

/** Does picking this item close the menu? */
export function menuClosesAfterPick(
  kind: MenuItemKind,
  value: number,
  cfg: MenuPickCloseConfig,
): boolean {
  switch (kind) {
    case MenuItemKind.Launcher:
      return value === BlasterMode.Web
        ? cfg.closeOnPick.gooLauncher
        : cfg.closeOnPick.launcher;
    case MenuItemKind.SubMode:
      return cfg.closeOnPick.subMode;
    case MenuItemKind.Colour:
      return cfg.closeOnPick.colour;
    default:
      return cfg.closeOnPick.ammo;
  }
}

/**
 * Open-animation progress `t` (0 closed .. 1 open) after `dt` seconds toward
 * `open`, over `sec` seconds. Linear here; the caller eases it.
 */
export function stepOpenProgress(
  t: number,
  open: boolean,
  dt: number,
  sec: number,
): number {
  if (!(sec > 0)) return open ? 1 : 0;
  const step = Math.max(0, dt) / sec;
  return open ? Math.min(1, t + step) : Math.max(0, t - step);
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

/**
 * The controller menu button. **Y on the left controller**, in every phase.
 *
 * Why Y: A and X start a round (GameStateSystem, including from the
 * tutorial's practice round), B flips SPLAT / TETHER, the triggers fire and
 * the squeezes grab and reel. Y was the one free face button, and it sits
 * under the left thumb — the hand that wears the menu. X is deliberately
 * NOT a menu key in any phase: in Idle and practice it starts a round, and a
 * button that means two things depending on the phase is a trap.
 */
export function controllerMenuToggle(
  leftYDown: boolean,
  _leftXDown: boolean,
  _phase: GamePhase,
): boolean {
  return leftYDown;
}

// ---------------------------------------------------------------------------
// Invariants: a closed menu is inert
// ---------------------------------------------------------------------------

/** May anything select on the menu right now? Only a fully open one. */
export function menuInteractive(state: Pick<WristMenuState, 'open'>): boolean {
  return state.open === 1;
}

/**
 * Rotate (x, y, z) by the inverse of unit quaternion q = (qx, qy, qz, qw),
 * into `out`. Allocation free.
 */
export function inverseRotate(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  x: number,
  y: number,
  z: number,
  out: Float32Array | number[],
): void {
  // v' = q* v q, with q* = (-qx, -qy, -qz, qw).
  const ix = -qx;
  const iy = -qy;
  const iz = -qz;
  // t = 2 * cross(i, v)
  const tx = 2 * (iy * z - iz * y);
  const ty = 2 * (iz * x - ix * z);
  const tz = 2 * (ix * y - iy * x);
  out[0] = x + qw * tx + (iy * tz - iz * ty);
  out[1] = y + qw * ty + (iz * tx - ix * tz);
  out[2] = z + qw * tz + (ix * ty - iy * tx);
}

/**
 * Does the world ray (origin o, unit direction d) hit the OPEN menu panel
 * within `maxT` metres, `margin` metres of slop included? Always false for a
 * closed (or still-opening) menu — the invariant that a closed menu never
 * blocks a shot. Writes the panel-frame hit point into `outXY` when given.
 */
export function menuRayHit(
  state: WristMenuState,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
  margin: number,
  scratch: Float32Array | number[],
  outXY?: Float32Array | number[],
): boolean {
  if (!menuInteractive(state)) return false;
  const c = state.center;
  const q = state.quaternion;
  inverseRotate(q[0], q[1], q[2], q[3], ox - c[0], oy - c[1], oz - c[2], scratch);
  const lox = scratch[0];
  const loy = scratch[1];
  const loz = scratch[2];
  inverseRotate(q[0], q[1], q[2], q[3], dx, dy, dz, scratch);
  const ldx = scratch[0];
  const ldy = scratch[1];
  const ldz = scratch[2];
  if (Math.abs(ldz) < 1e-9) return false;
  const t = -loz / ldz;
  if (!(t >= 0) || t > maxT) return false;
  const hx = lox + ldx * t;
  const hy = loy + ldy * t;
  if (outXY) {
    outXY[0] = hx;
    outXY[1] = hy;
  }
  return Math.abs(hx) <= state.halfW + margin && Math.abs(hy) <= state.halfH + margin;
}

// ---------------------------------------------------------------------------
// Carried over from the round-7..9 wrist palette
// ---------------------------------------------------------------------------

/**
 * Round 9 rebrand: the printed name a button wears. The internal tables still
 * say WEB / THWIP in places; the player sees GOO and FLICK. ASCII caps only.
 */
const MENU_LABEL_RENAMES: Readonly<Record<string, string>> = {
  WEB: 'GOO',
  THWIP: 'FLICK',
};

export function paletteLabelText(label: string): string {
  return MENU_LABEL_RENAMES[label.trim().toUpperCase()] ?? label;
}

/** The latch {@link stepPaletteLock} drives. Caller-owned; stepping allocates nothing. */
export interface PaletteLock {
  /** True while the panel is parked in world space. */
  locked: boolean;
  /** Seconds (caller's clock) at which the fingertip was last inside the radius. */
  lastNearSec: number;
}

/** A released lock. */
export function createPaletteLock(): PaletteLock {
  return { locked: false, lastNearSec: Number.NEGATIVE_INFINITY };
}

/**
 * Park-while-poking latch (round 7, reused by the round-10 menu). Parks the
 * instant `distance < lockRadius`; lets go only once it has stayed outside for
 * `releaseSec`, so a fingertip at the edge or a frame of lost tracking never
 * drops the panel back onto a moving wrist under the poking finger. Infinity
 * counts as outside.
 *
 * @returns true when the lock was released on this exact call.
 */
export function stepPaletteLock(
  lock: PaletteLock,
  distance: number,
  nowSec: number,
  lockRadius: number,
  releaseSec: number,
): boolean {
  if (distance < lockRadius) {
    lock.locked = true;
    lock.lastNearSec = nowSec;
    return false;
  }
  if (lock.locked && nowSec - lock.lastNearSec >= releaseSec) {
    lock.locked = false;
    return true;
  }
  return false;
}

/**
 * Is a fingertip at panel-frame (x, y, z) inside the poke zone (the panel
 * rect grown by `margin`, from `front` in front to `behind` behind)?
 */
export function inPokeZone(
  x: number,
  y: number,
  z: number,
  halfW: number,
  halfH: number,
  margin: number,
  front: number,
  behind: number,
): boolean {
  return (
    Math.abs(x) <= halfW + margin &&
    Math.abs(y) <= halfH + margin &&
    z <= front &&
    z >= -behind
  );
}
