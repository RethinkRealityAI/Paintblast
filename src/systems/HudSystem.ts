import {
  FollowBehavior,
  Follower,
  PanelDocument,
  PanelUI,
  createSystem,
  eq,
} from '@iwsdk/core';
import type { Entity, UIKitDocument } from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import { BLASTER, HUD, ROOM } from '../config';
import {
  BallKind,
  BallStyle,
  BlasterMode,
  BLASTER_MODE_DESCRIPTIONS,
  BLASTER_MODE_LABELS,
  GameEvent,
  GameEventBuffer,
  GamePhase,
  NEATNIK_COUNT,
  StudioActivity,
  TUTORIAL_STEP_COUNT,
  TutorialStep,
  WEB_BALL_COLOR,
  WebSubMode,
  accuracyPercent,
  ammoLabel,
  botsLabel,
  clampIndex,
  cycleIndex,
  formatScore,
  hexToInt,
  isNewBest,
  nextGoalLine,
  skinCounterLabel,
  tutorialStepNumber,
  writeSkin,
} from '../types';
import type { RoundStats, SkinStorage } from '../types';
import { EaselSystem } from './EaselSystem';
import { GameStateSystem, isTimedPhase } from './GameStateSystem';
import { SceneScanSystem } from './SceneScanSystem';
import { SplatterSystem } from './SplatterSystem';
import { StudioSystem } from './StudioSystem';
import { TutorialSystem } from './TutorialSystem';

/** Must match the PanelUI.config main.ts seeds the HUD entity with. */
const HUD_CONFIG_PATH = './ui/hud.json';

/**
 * The techno-paint accents, as 0xRRGGBB. Kept here as well as in the markup
 * because several things repaint at runtime: the combo pill climbs through
 * them, every button derives its hover / pressed shades from its own accent,
 * and the Armory lights whichever launcher and skin are loaded.
 */
const ACCENT_CORAL = 0xff4f81;
const ACCENT_AMBER = 0xffd23f;
const ACCENT_CYAN = 0x48dbfb;
const ACCENT_LIME = 0xb6ff3b;
const ACCENT_VIOLET = 0xb84dff;
const ACCENT_WHITE = 0xffffff;
/** HAND mode's identity: the bare-metal silver of the palette's HAND pad. */
const ACCENT_SILVER = 0xc9d2dc;

/** How many skin dots the markup declares (btn-skin-0 .. btn-skin-N-1). */
const SKIN_DOT_COUNT = 5;

/** Progress dots the tutorial card declares (tut-dot-0 .. N-1). */
const TUT_DOT_COUNT = TUTORIAL_STEP_COUNT;

/**
 * Round 9: is the tutorial card up for this step? Fire..Haul show the docked
 * card; Ready hands back to the title (PLAY pulsing); Off is no tutorial.
 * Pure and exported for tests.
 */
export function tutorialCardShown(step: number): boolean {
  return step >= TutorialStep.Fire && step <= TutorialStep.Haul;
}

/** "STEP 2 OF 5" for the tutorial card. Pure and exported for tests. */
export function tutorialCounterLabel(step: number): string {
  return `STEP ${tutorialStepNumber(step)} OF ${TUTORIAL_STEP_COUNT}`;
}

/** Round 10: Studio activity tabs, in markup order, with their accents. */
const STUDIO_TABS: ReadonlyArray<{ id: string; activity: StudioActivity; accent: number }> = [
  { id: 'btn-studio-canvas', activity: StudioActivity.Canvas, accent: ACCENT_AMBER },
  { id: 'btn-studio-stencil', activity: StudioActivity.Stencil, accent: ACCENT_LIME },
  { id: 'btn-studio-targets', activity: StudioActivity.Targets, accent: ACCENT_CORAL },
];

/** Inner width of the stencil meter's track, cm (track 26 minus padding). */
const METER_TRACK_CM = 25.6;

/** LOADOUT launcher cards, in markup order. */
const MODE_CARDS: ReadonlyArray<{ id: string; mode: BlasterMode }> = [
  { id: 'btn-mode-hand', mode: BlasterMode.Hand },
  { id: 'btn-mode-blaster', mode: BlasterMode.Paint },
  { id: 'btn-mode-web', mode: BlasterMode.Web },
];

/**
 * The slice of the UIKit element API this system uses.
 *
 * `UIKitDocument.getElementById` hands back a `Component<any>` whose generics
 * fight any attempt to describe it precisely; this structural type keeps the
 * calls we make honest without dragging uikit's property algebra in.
 *
 * `setProperties({ text })` is how a UIKitML element's text is replaced — the
 * compiler turns a text node into a Text child whose content is bound to the
 * *parent* container's `text` property, so writing it on the element that
 * carries the id is correct. `setProperties` merges into the element's current
 * properties, so each call only has to name what changed.
 *
 * A uikit `Component` extends three's `Mesh`, and @pmndrs/pointer-events
 * dispatches straight onto an object's three listener map, so every name in
 * `HudPointerEvent` reaches an `addEventListener` here exactly the way `click`
 * always has. `pointerenter` / `pointerleave` are the pair to use rather than
 * `pointerover` / `pointerout`: the latter re-fire when the pointer crosses
 * between a button and its own text child, which reads as a hover flicker.
 */
type HudPointerEvent =
  | 'click'
  | 'pointerenter'
  | 'pointerleave'
  | 'pointerdown';

interface HudElement {
  addEventListener(type: HudPointerEvent, listener: () => void): void;
  setProperties(properties: Record<string, unknown>): void;
}

/** The three looks one button cycles through. Border is optional. */
interface ButtonStates {
  base: number | string;
  hover: number | string;
  active: number | string;
  border?: { base: number | string; hover: number | string; active: number | string };
}

/** One wired button: what it is, how to paint it, and where its pointer is. */
interface ButtonRecord {
  element: HudElement;
  /** Re-evaluated on every paint, so a selected card repaints as selected. */
  states: () => ButtonStates;
  hovering: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** RGBA floats → a 0xRRGGBB int, which is what uikit's colour props accept. */
function packColor(color: readonly [number, number, number, number]): number {
  const channel = (value: number) =>
    Math.round(Math.min(1, Math.max(0, value)) * 255);
  return (channel(color[0]) << 16) | (channel(color[1]) << 8) | channel(color[2]);
}

/** Scale every channel of a 0xRRGGBB colour, clamped. >1 brightens, <1 darkens. */
function shade(color: number, factor: number): number {
  const channel = (shift: number) =>
    Math.min(255, Math.round(((color >> shift) & 0xff) * factor));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

/**
 * A 0xRRGGBB colour as a translucent `rgba(...)` string.
 *
 * uikit has no separate background-opacity property — its panel material takes
 * the alpha straight out of the background colour, and its parser accepts
 * exactly this `rgba(r, g, b, a)` form (integers 0-255, float alpha).
 */
function tint(color: number, alpha: number): string {
  return `rgba(${(color >> 16) & 0xff}, ${(color >> 8) & 0xff}, ${color & 0xff}, ${alpha})`;
}

/** Solid pill: brighten on hover, darken on press. */
function filledStates(accent: number): ButtonStates {
  return {
    base: accent,
    hover: shade(accent, 1.12),
    active: shade(accent, 0.82),
  };
}

/** Outline pill: the accent's whisper of a fill comes up as you touch it. */
function outlineStates(accent: number): ButtonStates {
  return {
    base: tint(accent, 0.08),
    hover: tint(accent, 0.24),
    active: tint(accent, 0.42),
    border: { base: accent, hover: shade(accent, 1.25), active: ACCENT_WHITE },
  };
}

/** Neutral glass pill (CLEAR PAINT, BACK). */
function glassStates(): ButtonStates {
  return {
    base: tint(ACCENT_WHITE, 0.06),
    hover: tint(ACCENT_WHITE, 0.16),
    active: tint(ACCENT_WHITE, 0.3),
    border: {
      base: tint(ACCENT_WHITE, 0.24),
      hover: tint(ACCENT_WHITE, 0.6),
      active: ACCENT_WHITE,
    },
  };
}

/** The colour a launcher wears on the HUD. BLASTER wears the gauntlet skin. */
function modeAccent(mode: BlasterMode, skinAccent: number): number {
  if (mode === BlasterMode.Web) return ACCENT_CYAN;
  if (mode === BlasterMode.Hand) return ACCENT_SILVER;
  return skinAccent;
}

/** `window.localStorage`, or undefined where touching it throws. */
function safeLocalStorage(): SkinStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Binds the game's signals to the spatial HUD panel and wires its buttons.
 *
 * Everything that shows state is subscription-driven: number-to-string work
 * only happens inside a subscription callback, i.e. when a value actually
 * changed. The one per-frame job is the section cross-fade, and update()
 * returns on its first line whenever no fade is running.
 *
 * Element references are cached as fields — a fixed set, resolved once when
 * the panel document qualifies. Subscriptions are registered before the panel
 * exists and tolerate that (`?.` everywhere), so a slow-loading document never
 * drops an update: the qualify handler paints the current state of every
 * signal as soon as the elements appear.
 *
 * ### Round 8: techno-paint + the Armory
 *
 * The title screen gained a sub-screen, the ARMORY (round 9: renamed
 * LOADOUT on screen; the ids keep "armory"): pick
 * the launcher (HAND / BLASTER / WEB, i.e. `globals.blasterMode`, which
 * BallSpawnSystem keeps in sync with the paint style) and the gauntlet skin
 * (`globals.blasterSkin`, persisted to localStorage under
 * `BLASTER.skinStorageKey`). It is not a phase — it is the Idle phase showing a
 * different section — so starting a round or leaving Idle any other way simply
 * closes it.
 */
export class HudSystem extends createSystem({
  hudPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, 'config', HUD_CONFIG_PATH)],
  },
}) {
  private gamePhase!: Signal<GamePhase>;
  private hudScore!: Signal<number>;
  private hudTimer!: Signal<string>;
  private hudStatus!: Signal<string>;
  private score!: Signal<number>;
  private bestScore!: Signal<number>;
  private combo!: Signal<number>;
  private targetsAlive!: Signal<number>;
  private timeLeft!: Signal<number>;
  private activeKind!: Signal<BallKind>;
  private activeStyle!: Signal<BallStyle>;
  private webSubMode!: Signal<WebSubMode>;
  private activeColor!: Signal<readonly [number, number, number, number]>;
  private blasterMode!: Signal<BlasterMode>;
  private blasterSkin!: Signal<number>;
  private sceneScanMissing!: Signal<boolean>;
  /** Session out of focus. Written by GameStateSystem. @see applyPaused */
  private paused!: Signal<boolean>;
  private events!: GameEventBuffer;
  // Round 9 (all optional so a world without them still binds).
  private tutorialStep?: Signal<number>;
  private tutorialLine?: Signal<string>;
  private coachLine?: Signal<string>;
  private roundStats?: Signal<RoundStats | null>;

  /** Every wired button, so a selection change can repaint the affected ones. */
  private readonly buttons = new Map<string, ButtonRecord>();

  /** True while the Idle phase is showing the Armory instead of the title. */
  private armoryOpen = false;
  /** Round 9: the tutorial card is what the panel shows (and it is docked). */
  private tutorialCard = false;
  /** Seconds of PLAY-button pulse left (after the tutorial hands over). */
  private playHighlightLeft = 0;
  private playHighlightClock = 0;
  /** Best score when the current round started; NEW BEST compares against it. */
  private bestAtRoundStart = 0;
  /** Last urgency painted on the timer, so the per-tick subscription is a compare. */
  private timerUrgent = false;

  /** The section currently fading in, and how far through it is (seconds). */
  private fadingSection: HudElement | undefined;
  private fadeElapsed = 0;

  // Cached element handles — one fixed set, never grows.
  private sectionIdle?: HudElement;
  private sectionArmory?: HudElement;
  private sectionPlaying?: HudElement;
  private sectionGameOver?: HudElement;
  private sectionChill?: HudElement;
  private shownSection?: HudElement;
  private scanNotice?: HudElement;
  private scanNoticeText?: HudElement;
  private scoreText?: HudElement;
  private timerText?: HudElement;
  private timerBar?: HudElement;
  private comboPill?: HudElement;
  private targetsText?: HudElement;
  private statusText?: HudElement;
  private chillStatusText?: HudElement;
  private finalText?: HudElement;
  private bestText?: HudElement;
  private newBestBadge?: HudElement;
  private ammoText?: HudElement;
  private ammoSwatch?: HudElement;
  private modeChip?: HudElement;
  private loadoutMode?: HudElement;
  private loadoutSkin?: HudElement;
  private loadoutSwatch?: HudElement;
  private armoryModeDesc?: HudElement;
  private armorySkinCard?: HudElement;
  private armorySkinSwatch?: HudElement;
  private armorySkinName?: HudElement;
  private armorySkinIndex?: HudElement;
  private pausedBanner?: HudElement;
  // Round 9: tutorial card, coaching tip, results card.
  private sectionTutorial?: HudElement;
  private tutStepText?: HudElement;
  private tutLineText?: HudElement;
  private readonly tutDots: (HudElement | undefined)[] = [];
  private coachText?: HudElement;
  private readonly resPops: (HudElement | undefined)[] = [];
  private resShots?: HudElement;
  private resHits?: HudElement;
  private resAcc?: HudElement;
  private resCombo?: HudElement;
  private resGoal?: HudElement;
  private startButton?: HudElement;
  // Round 10: the Studio card.
  private studioActivity?: Signal<number>;
  private studioLine?: Signal<string>;
  private studioMeter?: Signal<number>;
  private studioStars?: Signal<number>;
  private studioMeterRow?: HudElement;
  private studioMeterFill?: HudElement;
  private studioMeterText?: HudElement;
  private readonly studioStarOn: (HudElement | undefined)[] = [];
  private readonly studioStarOff: (HudElement | undefined)[] = [];
  private studioPrimary?: HudElement;
  private studioMount?: HudElement;
  private studioSave?: HudElement;
  private studioClear?: HudElement;

  init() {
    this.gamePhase = this.globals.gamePhase as Signal<GamePhase>;
    this.hudScore = this.globals.hudScore as Signal<number>;
    this.hudTimer = this.globals.hudTimer as Signal<string>;
    this.hudStatus = this.globals.hudStatus as Signal<string>;
    this.score = this.globals.score as Signal<number>;
    this.bestScore = this.globals.bestScore as Signal<number>;
    this.combo = this.globals.combo as Signal<number>;
    this.targetsAlive = this.globals.targetsAlive as Signal<number>;
    this.timeLeft = this.globals.timeLeft as Signal<number>;
    this.activeKind = this.globals.activeKind as Signal<BallKind>;
    this.activeStyle = this.globals.activeStyle as Signal<BallStyle>;
    this.webSubMode = this.globals.webSubMode as Signal<WebSubMode>;
    this.activeColor = this.globals.activeColor as Signal<
      readonly [number, number, number, number]
    >;
    this.blasterMode = this.globals.blasterMode as Signal<BlasterMode>;
    this.blasterSkin = this.globals.blasterSkin as Signal<number>;
    this.sceneScanMissing = this.globals.sceneScanMissing as Signal<boolean>;
    this.paused = this.globals.paused as Signal<boolean>;
    this.events = this.globals.gameEvents as GameEventBuffer;
    this.tutorialStep = this.globals.tutorialStep as Signal<number> | undefined;
    this.tutorialLine = this.globals.tutorialLine as Signal<string> | undefined;
    this.coachLine = this.globals.coachLine as Signal<string> | undefined;
    this.roundStats = this.globals.roundStats as Signal<RoundStats | null> | undefined;
    this.studioActivity = this.globals.studioActivity as Signal<number> | undefined;
    this.studioLine = this.globals.studioLine as Signal<string> | undefined;
    this.studioMeter = this.globals.studioMeter as Signal<number> | undefined;
    this.studioStars = this.globals.studioStars as Signal<number> | undefined;

    this.cleanupFuncs.push(() => {
      for (const record of this.buttons.values()) {
        if (record.timer !== undefined) clearTimeout(record.timer);
      }
      this.buttons.clear();
    });

    this.cleanupFuncs.push(
      this.queries.hudPanel.subscribe('qualify', (entity) => {
        const document = PanelDocument.data.document[entity.index] as
          | UIKitDocument
          | undefined;
        if (!document) return;

        this.bindElements(document);
        this.wireButtons(document);
        this.paintEverything();
      }),
      this.queries.hudPanel.subscribe('disqualify', () =>
        this.releaseElements(),
      ),
    );

    this.cleanupFuncs.push(
      this.gamePhase.subscribe((phase) => this.applyPhase(phase)),
      this.hudScore.subscribe((score) => this.applyScore(score)),
      this.hudTimer.subscribe((timer) => this.setText(this.timerText, timer)),
      this.timeLeft.subscribe(() => this.applyTimerUrgency()),
      this.hudStatus.subscribe((status) => this.applyStatus(status)),
      this.score.subscribe(() => this.applyNewBest()),
      this.bestScore.subscribe((best) => {
        this.setText(this.bestText, `BEST ${formatScore(best)}`);
        this.applyNewBest();
      }),
      this.combo.subscribe((combo) => this.applyCombo(combo)),
      this.targetsAlive.subscribe((alive) =>
        this.setText(this.targetsText, botsLabel(alive)),
      ),
      this.activeKind.subscribe(() => this.applyAmmo()),
      this.activeStyle.subscribe(() => this.applyAmmo()),
      this.webSubMode.subscribe(() => this.applyAmmo()),
      this.activeColor.subscribe(() => this.applyAmmo()),
      this.blasterMode.subscribe(() => this.applyLoadout()),
      this.blasterSkin.subscribe(() => this.applyLoadout()),
      this.sceneScanMissing.subscribe(() => this.applyScanNotice()),
      this.paused.subscribe(() => this.applyPaused()),
    );
    if (this.tutorialStep) {
      let last = this.tutorialStep.peek();
      this.cleanupFuncs.push(
        this.tutorialStep.subscribe((step) => {
          const was = last;
          last = step;
          this.applyTutorial(step, was);
        }),
      );
    }
    if (this.tutorialLine) {
      this.cleanupFuncs.push(
        this.tutorialLine.subscribe((line) => this.setText(this.tutLineText, line)),
      );
    }
    if (this.coachLine) {
      this.cleanupFuncs.push(
        this.coachLine.subscribe(() => this.applyCoach()),
      );
    }
    if (this.roundStats) {
      this.cleanupFuncs.push(
        this.roundStats.subscribe((stats) => this.applyResults(stats)),
      );
    }
    // Round 10: the Studio card.
    if (this.studioActivity) {
      this.cleanupFuncs.push(this.studioActivity.subscribe(() => this.applyStudio()));
    }
    if (this.studioLine) {
      this.cleanupFuncs.push(
        this.studioLine.subscribe((line) => {
          this.setText(this.chillStatusText, line || ' ');
          // Every Studio action rewrites the line, so labels follow it too.
          this.applyStudioLabels();
        }),
      );
    }
    if (this.studioMeter) {
      this.cleanupFuncs.push(this.studioMeter.subscribe(() => this.applyStudioMeter()));
    }
    if (this.studioStars) {
      this.cleanupFuncs.push(this.studioStars.subscribe(() => this.applyStudioMeter()));
    }
  }

  /**
   * The section cross-fade: the newly shown section rises into place and
   * fades up over HUD.sectionFadeSec. A handful of frames per phase change;
   * every other frame this returns immediately.
   */
  update(delta: number) {
    if (this.playHighlightLeft > 0) this.stepPlayHighlight(delta);
    const section = this.fadingSection;
    if (!section) return;
    this.fadeElapsed += delta;
    const t = HUD.sectionFadeSec > 0 ? this.fadeElapsed / HUD.sectionFadeSec : 1;
    if (t >= 1) {
      section.setProperties({ opacity: 1, transformTranslateY: 0 });
      this.fadingSection = undefined;
      return;
    }
    const eased = 1 - (1 - t) * (1 - t) * (1 - t);
    section.setProperties({
      opacity: eased,
      transformTranslateY: (1 - eased) * HUD.sectionRiseCm,
    });
  }

  // ---- Round 9: tutorial card, PLAY highlight, coaching, results ------------

  /**
   * The tutorial changed step. The card replaces the phase section from
   * Fire to Haul (and docks low, out of the firing line); Ready hands back to
   * the title with PLAY pulsing.
   */
  private applyTutorial(step: number, was: number): void {
    const card = tutorialCardShown(step);
    const changed = card !== this.tutorialCard;
    this.tutorialCard = card;
    if (card) this.armoryOpen = false;
    this.setText(this.tutStepText, tutorialCounterLabel(step));
    const n = tutorialStepNumber(step);
    for (let i = 0; i < this.tutDots.length; i++) {
      this.tutDots[i]?.setProperties({
        backgroundColor:
          i < n - 1 ? ACCENT_LIME : i === n - 1 ? ACCENT_AMBER : tint(ACCENT_WHITE, 0.18),
      });
    }
    if (step === TutorialStep.Ready && was !== TutorialStep.Ready) this.highlightPlay();
    if (changed) this.applyPhase(this.gamePhase.peek(), true);
  }

  /** Pulse the title's PLAY button for HUD.playHighlightSec. */
  highlightPlay(): void {
    if (!(HUD.playHighlightSec > 0)) return;
    this.playHighlightLeft = HUD.playHighlightSec;
    this.playHighlightClock = 0;
  }

  private stepPlayHighlight(delta: number): void {
    this.playHighlightLeft -= delta;
    this.playHighlightClock += delta;
    const button = this.startButton;
    if (!button) return;
    if (this.playHighlightLeft <= 0 || this.gamePhase.peek() !== GamePhase.Idle) {
      this.playHighlightLeft = 0;
      button.setProperties({ borderColor: 0xfff3b8 });
      this.refreshButton('btn-start');
      return;
    }
    const wave = 0.5 + 0.5 * Math.sin(this.playHighlightClock * Math.PI * 2 * HUD.playHighlightHz);
    const record = this.buttons.get('btn-start');
    const busy = record?.hovering === true || record?.timer !== undefined;
    button.setProperties({ borderColor: wave > 0.5 ? ACCENT_WHITE : ACCENT_CORAL });
    if (!busy) {
      const scale = 1 + 0.035 * wave;
      button.setProperties({ transformScaleX: scale, transformScaleY: scale });
    }
  }

  /** Coaching tip: replaces the status line while it is up. */
  private applyCoach(): void {
    const tip = this.coachLine?.peek() ?? '';
    this.coachText?.setProperties({ display: tip ? 'flex' : 'none', text: tip || ' ' });
    this.statusText?.setProperties({ display: tip ? 'none' : 'flex' });
  }

  /** The results card, from GameStateSystem's GameOver snapshot. */
  private applyResults(stats: RoundStats | null | undefined): void {
    if (!stats) return;
    for (let i = 0; i < this.resPops.length; i++) {
      this.setText(this.resPops[i], String(stats.pops[i] ?? 0));
    }
    this.setText(this.resShots, String(stats.shots));
    this.setText(this.resHits, String(Math.min(stats.hits, stats.shots)));
    this.setText(this.resAcc, `${accuracyPercent(stats.hits, stats.shots)}%`);
    // 'x', not U+00D7 (gotcha 24).
    this.setText(this.resCombo, `x${Math.max(1, stats.bestCombo)}`);
    this.setText(this.resGoal, nextGoalLine(stats));
  }

  // ---- Public API (harness + future callers) -------------------------------

  /** Show the Armory over the title screen. A no-op outside Idle. */
  openArmory(): void {
    if (this.gamePhase.peek() !== GamePhase.Idle) return;
    this.armoryOpen = true;
    this.applyPhase(GamePhase.Idle, false);
  }

  /** Back from the Armory to the title screen. */
  closeArmory(): void {
    if (!this.armoryOpen) return;
    this.armoryOpen = false;
    this.applyPhase(this.gamePhase.peek(), false);
  }

  /** Load a launcher. BallSpawnSystem keeps activeStyle in step. */
  selectMode(mode: BlasterMode): void {
    if (this.blasterMode.peek() !== mode) this.blasterMode.value = mode;
  }

  /** Wear skin `index` (clamped) and remember it on this device. */
  selectSkin(index: number): void {
    const next = clampIndex(index, BLASTER.skins.length);
    if (this.blasterSkin.peek() !== next) this.blasterSkin.value = next;
    writeSkin(safeLocalStorage(), BLASTER.skinStorageKey, next);
  }

  // ---- Binding -------------------------------------------------------------

  /** Resolve every id the markup declares. Missing ids stay undefined. */
  private bindElements(document: UIKitDocument): void {
    this.sectionIdle = element(document, 'section-idle');
    this.sectionArmory = element(document, 'section-armory');
    this.sectionPlaying = element(document, 'section-playing');
    this.sectionGameOver = element(document, 'section-gameover');
    this.sectionChill = element(document, 'section-chill');
    this.scanNotice = element(document, 'scan-notice');
    this.scanNoticeText = element(document, 'scan-notice-text');
    this.scoreText = element(document, 'hud-score');
    this.timerText = element(document, 'hud-timer');
    this.timerBar = element(document, 'hud-timer-bar');
    this.comboPill = element(document, 'hud-combo');
    this.targetsText = element(document, 'hud-targets');
    this.statusText = element(document, 'hud-status');
    this.chillStatusText = element(document, 'hud-chill-status');
    this.finalText = element(document, 'hud-final');
    this.bestText = element(document, 'hud-best');
    this.newBestBadge = element(document, 'hud-newbest');
    this.ammoText = element(document, 'hud-ammo');
    this.ammoSwatch = element(document, 'hud-ammo-swatch');
    this.modeChip = element(document, 'hud-mode');
    this.loadoutMode = element(document, 'hud-loadout-mode');
    this.loadoutSkin = element(document, 'hud-loadout-skin');
    this.loadoutSwatch = element(document, 'hud-loadout-swatch');
    this.armoryModeDesc = element(document, 'armory-mode-desc');
    this.armorySkinCard = element(document, 'armory-skin-card');
    this.armorySkinSwatch = element(document, 'armory-skin-swatch');
    this.armorySkinName = element(document, 'armory-skin-name');
    this.armorySkinIndex = element(document, 'armory-skin-index');
    this.pausedBanner = element(document, 'hud-paused');
    this.sectionTutorial = element(document, 'section-tutorial');
    this.tutStepText = element(document, 'tut-step');
    this.tutLineText = element(document, 'tut-line');
    this.tutDots.length = 0;
    for (let i = 0; i < TUT_DOT_COUNT; i++) {
      this.tutDots.push(element(document, `tut-dot-${i}`));
    }
    this.coachText = element(document, 'hud-coach');
    this.resPops.length = 0;
    for (let i = 0; i < NEATNIK_COUNT; i++) {
      this.resPops.push(element(document, `res-pops-${i}`));
    }
    this.resShots = element(document, 'res-shots');
    this.resHits = element(document, 'res-hits');
    this.resAcc = element(document, 'res-acc');
    this.resCombo = element(document, 'res-combo');
    this.resGoal = element(document, 'res-goal');
    this.startButton = element(document, 'btn-start');
    this.studioMeterRow = element(document, 'studio-meter');
    this.studioMeterFill = element(document, 'studio-meter-fill');
    this.studioMeterText = element(document, 'studio-meter-text');
    this.studioStarOn.length = 0;
    this.studioStarOff.length = 0;
    for (let i = 0; i < 3; i++) {
      this.studioStarOn.push(element(document, `studio-star-on-${i}`));
      this.studioStarOff.push(element(document, `studio-star-off-${i}`));
    }
    this.studioPrimary = element(document, 'btn-studio-primary');
    this.studioMount = element(document, 'btn-studio-mount');
    this.studioSave = element(document, 'btn-save-painting');
    this.studioClear = element(document, 'btn-new-canvas');
    this.shownSection = undefined;
  }

  private releaseElements(): void {
    for (const record of this.buttons.values()) {
      if (record.timer !== undefined) clearTimeout(record.timer);
    }
    this.buttons.clear();
    this.fadingSection = undefined;
    this.shownSection = undefined;
    this.sectionIdle = undefined;
    this.sectionArmory = undefined;
    this.sectionPlaying = undefined;
    this.sectionGameOver = undefined;
    this.sectionChill = undefined;
    this.scanNotice = undefined;
    this.scanNoticeText = undefined;
    this.scoreText = undefined;
    this.timerText = undefined;
    this.timerBar = undefined;
    this.comboPill = undefined;
    this.targetsText = undefined;
    this.statusText = undefined;
    this.chillStatusText = undefined;
    this.finalText = undefined;
    this.bestText = undefined;
    this.newBestBadge = undefined;
    this.ammoText = undefined;
    this.ammoSwatch = undefined;
    this.modeChip = undefined;
    this.loadoutMode = undefined;
    this.loadoutSkin = undefined;
    this.loadoutSwatch = undefined;
    this.armoryModeDesc = undefined;
    this.armorySkinCard = undefined;
    this.armorySkinSwatch = undefined;
    this.armorySkinName = undefined;
    this.armorySkinIndex = undefined;
    this.pausedBanner = undefined;
    this.sectionTutorial = undefined;
    this.tutStepText = undefined;
    this.tutLineText = undefined;
    this.tutDots.length = 0;
    this.coachText = undefined;
    this.resPops.length = 0;
    this.resShots = undefined;
    this.resHits = undefined;
    this.resAcc = undefined;
    this.resCombo = undefined;
    this.resGoal = undefined;
    this.startButton = undefined;
    this.studioMeterRow = undefined;
    this.studioMeterFill = undefined;
    this.studioMeterText = undefined;
    this.studioStarOn.length = 0;
    this.studioStarOff.length = 0;
    this.studioPrimary = undefined;
    this.studioMount = undefined;
    this.studioSave = undefined;
    this.studioClear = undefined;
  }

  /** Every button on the panel, each through the one press affordance. */
  private wireButtons(document: UIKitDocument): void {
    const game = () => this.world.getSystem(GameStateSystem);
    const start = () => {
      this.armoryOpen = false;
      game()?.startGame();
    };

    // ---- Title -------------------------------------------------------------
    this.wireInteractiveButton(document, 'btn-start', () => filledStates(ACCENT_AMBER), start);
    this.wireInteractiveButton(document, 'btn-chill', () => outlineStates(ACCENT_CYAN), () =>
      game()?.startChill(),
    );
    // Round 9: the separate WEB MODE button is gone - GOO is a launcher,
    // picked on the LOADOUT screen or the palette's mode pad.
    this.wireInteractiveButton(document, 'btn-tutorial', () => outlineStates(ACCENT_LIME), () =>
      this.world.getSystem(TutorialSystem)?.start(),
    );
    this.wireInteractiveButton(document, 'btn-armory', () => outlineStates(ACCENT_VIOLET), () =>
      this.openArmory(),
    );

    // ---- Tutorial card -------------------------------------------------------
    this.wireInteractiveButton(document, 'btn-tut-skip', glassStates, () =>
      this.world.getSystem(TutorialSystem)?.skip(),
    );
    // The only thing in the game that ever calls initiateRoomCapture, and it
    // does so from inside a click handler — a user gesture by construction.
    this.wireInteractiveButton(document, 'btn-scan-room', () => outlineStates(ACCENT_AMBER), () =>
      this.requestRoomScan(),
    );

    // ---- Round over ----------------------------------------------------------
    this.wireInteractiveButton(document, 'btn-restart', () => filledStates(ACCENT_LIME), start);

    // ---- Chill: the Studio (round 10) ---------------------------------------
    const studio = () => this.world.getSystem(StudioSystem);
    this.wireInteractiveButton(document, 'btn-exit-chill', () => outlineStates(ACCENT_CORAL), () =>
      game()?.exitChill(),
    );
    for (const tab of STUDIO_TABS) {
      this.wireInteractiveButton(
        document,
        tab.id,
        () => this.studioTabStates(tab.activity, tab.accent),
        () => studio()?.selectActivity(tab.activity),
      );
    }
    this.wireInteractiveButton(document, 'btn-studio-primary', () => outlineStates(ACCENT_LIME), () => {
      studio()?.primaryAction();
      this.applyStudioLabels();
    });
    this.wireInteractiveButton(document, 'btn-studio-mount', () => outlineStates(ACCENT_VIOLET), () => {
      studio()?.secondaryAction();
      this.applyStudioLabels();
    });
    this.wireInteractiveButton(document, 'btn-save-painting', () => outlineStates(ACCENT_AMBER), () => {
      const s = studio();
      if (s) s.save();
      else this.world.getSystem(EaselSystem)?.savePainting();
    });
    this.wireInteractiveButton(document, 'btn-new-canvas', () => outlineStates(ACCENT_CYAN), () => {
      const s = studio();
      if (s) s.clear();
      else this.world.getSystem(EaselSystem)?.newCanvas();
    });

    // ---- Footer --------------------------------------------------------------
    this.wireInteractiveButton(document, 'btn-clear', glassStates, () =>
      this.world.getSystem(SplatterSystem)?.clearAll(),
    );

    // ---- Armory --------------------------------------------------------------
    this.wireInteractiveButton(document, 'btn-armory-back', glassStates, () =>
      this.closeArmory(),
    );
    this.wireInteractiveButton(
      document,
      'btn-armory-play',
      () => filledStates(ACCENT_AMBER),
      start,
    );
    for (const card of MODE_CARDS) {
      this.wireInteractiveButton(
        document,
        card.id,
        () => this.modeCardStates(card.mode),
        () => this.selectMode(card.mode),
      );
    }
    const step = (delta: number) => () =>
      this.selectSkin(cycleIndex(this.blasterSkin.peek(), delta, BLASTER.skins.length));
    this.wireInteractiveButton(document, 'btn-skin-prev', () => outlineStates(ACCENT_VIOLET), step(-1));
    this.wireInteractiveButton(document, 'btn-skin-next', () => outlineStates(ACCENT_VIOLET), step(1));
    for (let i = 0; i < SKIN_DOT_COUNT; i++) {
      const id = `btn-skin-${i}`;
      if (i >= BLASTER.skins.length) {
        // Fewer skins than dots: hide the spare dots instead of wiring them.
        element(document, id)?.setProperties({ display: 'none' });
        continue;
      }
      this.wireInteractiveButton(
        document,
        id,
        () => this.skinDotStates(i),
        () => this.selectSkin(i),
        HUD.skinDotHoverScale,
      );
    }
  }

  /** Launcher card: lit in its own colour when loaded, glass otherwise. */
  private modeCardStates(mode: BlasterMode): ButtonStates {
    const accent = modeAccent(mode, this.skinAccent());
    const selected = this.blasterMode.peek() === mode;
    return {
      base: selected ? tint(accent, 0.2) : tint(ACCENT_WHITE, 0.04),
      hover: selected ? tint(accent, 0.3) : tint(accent, 0.12),
      active: tint(accent, 0.42),
      border: {
        base: selected ? accent : tint(ACCENT_WHITE, 0.18),
        hover: accent,
        active: ACCENT_WHITE,
      },
    };
  }

  /** Skin dot: always its own accent; the worn one wears a white ring. */
  private skinDotStates(index: number): ButtonStates {
    const skin = BLASTER.skins[index];
    const accent = hexToInt(skin?.accent ?? '#ffffff');
    const selected = this.blasterSkin.peek() === index;
    return {
      base: accent,
      hover: shade(accent, 1.15),
      active: shade(accent, 0.8),
      border: {
        base: selected ? ACCENT_WHITE : tint(ACCENT_WHITE, 0.15),
        hover: selected ? ACCENT_WHITE : tint(ACCENT_WHITE, 0.6),
        active: ACCENT_WHITE,
      },
    };
  }

  /**
   * Give one button the full press affordance: hover tint + swell, a timed
   * pressed flash + squash, a click cue, and its action.
   *
   * Every button on the panel goes through here — round 2 shipped bare
   * `click` handlers and players could not tell a press had landed. A ray
   * click in XR gives no tactile feedback at all, so the panel does the
   * confirming: the colour moves and the pill swells under the cursor, snaps
   * darker and squashes on the press, and FeedbackSystem puts a tick under it
   * off `UiClick`.
   *
   * The flash timer and the hover flag interact: the timer restores whichever
   * state the pointer is actually in when it fires, so releasing outside the
   * button lands on `base` and releasing inside lands on `hover`.
   */
  private wireInteractiveButton(
    document: UIKitDocument,
    id: string,
    states: () => ButtonStates,
    action: () => void,
    hoverScale: number = HUD.buttonHoverScale,
  ): void {
    const button = element(document, id);
    if (!button) return;

    const record: ButtonRecord = {
      element: button,
      states,
      hovering: false,
      timer: undefined,
    };
    this.buttons.set(id, record);

    const flash = () => {
      this.paintButton(record, 'active');
      if (record.timer !== undefined) clearTimeout(record.timer);
      record.timer = setTimeout(() => {
        record.timer = undefined;
        this.paintButton(record, record.hovering ? 'hover' : 'base', hoverScale);
      }, HUD.pressFlashMs);
    };

    button.addEventListener('pointerenter', () => {
      record.hovering = true;
      if (record.timer === undefined) this.paintButton(record, 'hover', hoverScale);
    });
    button.addEventListener('pointerleave', () => {
      record.hovering = false;
      if (record.timer === undefined) this.paintButton(record, 'base');
    });
    // Flash on the press itself rather than waiting for the release, so the
    // confirmation is immediate even on a long hold.
    button.addEventListener('pointerdown', flash);
    button.addEventListener('click', () => {
      // Re-armed here too: a poke or an emulated click can reach `click`
      // without ever producing a pointerdown on this element.
      flash();
      this.events.emit(GameEvent.UiClick, 0, 0, 0, 0);
      action();
    });

    this.paintButton(record, 'base');
  }

  /** Paint one button in one of its three states. */
  private paintButton(
    record: ButtonRecord,
    state: 'base' | 'hover' | 'active',
    hoverScale: number = HUD.buttonHoverScale,
  ): void {
    const looks = record.states();
    const scale =
      state === 'active'
        ? HUD.buttonPressScale
        : state === 'hover'
          ? hoverScale
          : 1;
    const properties: Record<string, unknown> = {
      backgroundColor: looks[state],
      transformScaleX: scale,
      transformScaleY: scale,
    };
    if (looks.border) properties.borderColor = looks.border[state];
    record.element.setProperties(properties);
  }

  /** Repaint a wired button in whatever state its pointer leaves it in. */
  private refreshButton(id: string): void {
    const record = this.buttons.get(id);
    if (!record || record.timer !== undefined) return;
    this.paintButton(record, record.hovering ? 'hover' : 'base');
  }

  // ---- Actions ---------------------------------------------------------------

  /**
   * Ask Quest to run Space Setup, and say what happened: capture started, no
   * such API, or already asked once this session (Meta documents the call as
   * once-per-session).
   */
  private requestRoomScan(): void {
    const scanner = this.world.getSystem(SceneScanSystem);
    if (!scanner) return;

    if (scanner.roomCaptureRequested) {
      this.setText(this.scanNoticeText, ROOM.scanRequestedText);
      return;
    }
    this.setText(
      this.scanNoticeText,
      scanner.requestRoomCapture()
        ? ROOM.scanRequestedText
        : ROOM.scanUnavailableText,
    );
  }

  // ---- Painters --------------------------------------------------------------

  /**
   * Show the room-scan notice only on the title screen with no scene model:
   * a notice mid-round is a strip nobody can act on, and SCAN ROOM drops you
   * out of the session into Space Setup.
   */
  private applyScanNotice(): void {
    const show =
      this.sceneScanMissing.peek() &&
      this.gamePhase.peek() === GamePhase.Idle &&
      !this.armoryOpen &&
      !this.tutorialCard;
    this.scanNotice?.setProperties({ display: show ? 'flex' : 'none' });
  }

  /** Bring a freshly bound document up to date with every signal at once. */
  private paintEverything(): void {
    this.applyPhase(this.gamePhase.peek());
    this.applyScore(this.hudScore.peek());
    this.applyCombo(this.combo.peek());
    this.applyAmmo();
    this.applyLoadout();
    this.applyTimerUrgency();
    this.setText(this.timerText, this.hudTimer.peek());
    this.applyStatus(this.hudStatus.peek());
    this.setText(this.bestText, `BEST ${formatScore(this.bestScore.peek())}`);
    this.setText(this.targetsText, botsLabel(this.targetsAlive.peek()));
    if (this.tutorialStep) {
      this.tutorialCard = tutorialCardShown(this.tutorialStep.peek());
      this.applyTutorial(this.tutorialStep.peek(), this.tutorialStep.peek());
    }
    this.setText(this.tutLineText, this.tutorialLine?.peek() ?? '');
    this.applyCoach();
    this.applyResults(this.roundStats?.peek());
    this.setText(this.chillStatusText, this.studioLine?.peek() || ' ');
    this.applyStudio();
  }

  /**
   * The phase status line. Round 10: the chill card's line is the Studio's
   * own (studioLine) - activity instructions and live scores.
   */
  private applyStatus(status: string): void {
    this.setText(this.statusText, status);
  }

  // ---- Round 10: the Studio card ---------------------------------------------

  /** Activity tab: lit in its own accent when active, glass otherwise. */
  private studioTabStates(activity: StudioActivity, accent: number): ButtonStates {
    const selected = (this.studioActivity?.peek() ?? 0) === activity;
    return {
      base: selected ? tint(accent, 0.22) : tint(ACCENT_WHITE, 0.04),
      hover: selected ? tint(accent, 0.32) : tint(accent, 0.12),
      active: tint(accent, 0.42),
      border: {
        base: selected ? accent : tint(ACCENT_WHITE, 0.18),
        hover: accent,
        active: ACCENT_WHITE,
      },
    };
  }

  /** Activity changed: relight the tabs, relabel / show the action buttons. */
  private applyStudio(): void {
    for (const tab of STUDIO_TABS) this.refreshButton(tab.id);
    this.applyStudioLabels();
    this.applyStudioMeter();
  }

  private applyStudioLabels(): void {
    const studio = this.world.getSystem(StudioSystem);
    const activity = this.studioActivity?.peek() ?? 0;
    const painting = activity !== StudioActivity.Targets;
    if (studio) {
      this.setText(this.studioPrimary, studio.primaryLabel);
      this.setText(this.studioMount, studio.secondaryLabel);
    }
    const shown = painting ? 'flex' : 'none';
    this.studioMount?.setProperties({ display: shown });
    this.studioSave?.setProperties({ display: shown });
    this.studioClear?.setProperties({ display: shown });
  }

  /** Stencil score bar, percent and stars (hidden outside the stencil). */
  private applyStudioMeter(): void {
    const meter = this.studioMeter?.peek() ?? -1;
    const show =
      meter >= 0 && (this.studioActivity?.peek() ?? 0) === StudioActivity.Stencil;
    this.studioMeterRow?.setProperties({ display: show ? 'flex' : 'none' });
    if (!show) return;
    const pct = Math.max(0, Math.min(100, meter));
    this.studioMeterFill?.setProperties({ width: Math.max(0.1, (METER_TRACK_CM * pct) / 100) });
    this.setText(this.studioMeterText, `${pct}%`);
    const stars = this.studioStars?.peek() ?? 0;
    for (let i = 0; i < 3; i++) {
      this.studioStarOn[i]?.setProperties({ display: i < stars ? 'flex' : 'none' });
      this.studioStarOff[i]?.setProperties({ display: i < stars ? 'none' : 'flex' });
    }
  }

  /**
   * Exactly one section is visible; the footer never hides.
   *
   * @param redock false for a section swap inside the same phase (Armory open
   *   or close): re-docking forces a Follower position sync, which snaps the
   *   panel to the head-locked offset instead of leaving it where it floats.
   */
  private applyPhase(phase: GamePhase, redock = true): void {
    if (phase !== GamePhase.Idle) this.armoryOpen = false;
    if (phase === GamePhase.Countdown) {
      this.bestAtRoundStart = this.bestScore.peek();
    }

    const target = this.tutorialCard
      ? this.sectionTutorial
      : phase === GamePhase.Idle
        ? this.armoryOpen
          ? this.sectionArmory
          : this.sectionIdle
        : phase === GamePhase.Countdown || phase === GamePhase.Playing
          ? this.sectionPlaying
          : phase === GamePhase.GameOver
            ? this.sectionGameOver
            : this.sectionChill;
    this.showSection(target);

    // Lives inside the idle section, so it follows the phase too.
    this.applyScanNotice();
    this.applyPaused();
    this.applyNewBest();
    this.applyTimerUrgency();
    if (redock) this.applyDock(phase);
  }

  /**
   * Swap the visible section, and fade the newcomer in. Countdown → Playing
   * keeps the same section, so the live HUD never re-fades mid-round.
   */
  private showSection(target: HudElement | undefined): void {
    const sections = [
      this.sectionIdle,
      this.sectionArmory,
      this.sectionPlaying,
      this.sectionGameOver,
      this.sectionChill,
      this.sectionTutorial,
    ];
    for (const section of sections) {
      if (section && section !== target) section.setProperties({ display: 'none' });
    }
    if (!target) return;
    if (this.shownSection === target) {
      target.setProperties({ display: 'flex' });
      return;
    }
    this.shownSection = target;
    if (HUD.sectionFadeSec > 0) {
      target.setProperties({
        display: 'flex',
        opacity: 0,
        transformTranslateY: HUD.sectionRiseCm,
      });
      this.fadingSection = target;
      this.fadeElapsed = 0;
    } else {
      target.setProperties({ display: 'flex', opacity: 1, transformTranslateY: 0 });
    }
  }

  /**
   * The PAUSED pill across the top of the panel, up exactly while a timed
   * phase is frozen for lack of focus. Idle and Chill never show it.
   */
  private applyPaused(): void {
    const show = this.paused.peek() && isTimedPhase(this.gamePhase.peek());
    this.pausedBanner?.setProperties({ display: show ? 'flex' : 'none' });
  }

  /** NEW BEST badge on the round summary, against the best at round start. */
  private applyNewBest(): void {
    const show =
      this.gamePhase.peek() === GamePhase.GameOver &&
      isNewBest(this.score.peek(), this.bestAtRoundStart);
    this.newBestBadge?.setProperties({ display: show ? 'flex' : 'none' });
  }

  /** The clock turns coral for the last HUD.timerUrgentSec of a round. */
  private applyTimerUrgency(): void {
    const urgent =
      this.gamePhase.peek() === GamePhase.Playing &&
      this.timeLeft.peek() <= HUD.timerUrgentSec;
    if (urgent === this.timerUrgent) return;
    this.timerUrgent = urgent;
    const color = urgent ? ACCENT_CORAL : ACCENT_CYAN;
    this.timerText?.setProperties({ color });
    this.timerBar?.setProperties({ backgroundColor: color });
  }

  /**
   * Move the panel out of the firing line while the player is shooting.
   *
   * Playing and Chill get a low, small, lazy dock (a watch strip at the bottom
   * of your view) and every menu phase gets the comfortable reading placement
   * back. `offsetPosition` is a Vec3 — elics throws on getValue/setValue for
   * vector types — so it goes through `getVectorView`. `FollowBehavior.PivotY`
   * discards the Y offset, so the low dock needs face-target following.
   */
  private applyDock(phase: GamePhase): void {
    // Round 9: the tutorial card docks too - its whole point is the room.
    const docked =
      phase === GamePhase.Playing || phase === GamePhase.Chill || this.tutorialCard;
    const offset = docked ? HUD.playOffset : HUD.menuOffset;
    const faceTarget = docked ? HUD.playFaceTarget : HUD.menuFaceTarget;

    for (const entity of this.queries.hudPanel.entities) {
      if (!entity.hasComponent(Follower)) continue;

      const view = entity.getVectorView(
        Follower,
        'offsetPosition',
      ) as Float32Array;
      view[0] = offset[0];
      view[1] = offset[1];
      view[2] = offset[2];

      entity.setValue(
        Follower,
        'tolerance',
        docked ? HUD.playTolerance : HUD.menuTolerance,
      );
      entity.setValue(Follower, 'speed', docked ? HUD.playSpeed : HUD.menuSpeed);
      entity.setValue(
        Follower,
        'maxAngle',
        docked ? HUD.playMaxAngle : HUD.menuMaxAngle,
      );
      entity.setValue(
        Follower,
        'behavior',
        faceTarget ? FollowBehavior.FaceTarget : FollowBehavior.PivotY,
      );
      entity.setValue(Follower, 'needsPositionSync', true);

      this.applyPanelSize(entity, docked ? HUD.playScale : HUD.menuScale);
    }
  }

  /**
   * Resize the panel by moving its PanelUI bounds, NOT by scaling its object3D
   * (PanelUISystem divides an object3D scale straight back out). It also
   * shrinks BallSpawnSystem's shot-blocking rectangle, which measures the same
   * bounds.
   */
  private applyPanelSize(entity: Entity, scale: number): void {
    entity.setValue(PanelUI, 'maxWidth', HUD.baseWidth * scale);
    entity.setValue(PanelUI, 'maxHeight', HUD.baseHeight * scale);
  }

  private applyScore(score: number): void {
    const text = formatScore(score);
    this.setText(this.scoreText, text);
    this.setText(this.finalText, text);
  }

  /**
   * The pill only exists while the multiplier is above x1, and heats up
   * through the accents as the streak climbs: amber, coral, violet.
   */
  private applyCombo(combo: number): void {
    const background =
      combo >= 4 ? ACCENT_VIOLET : combo === 3 ? ACCENT_CORAL : ACCENT_AMBER;
    this.comboPill?.setProperties({
      display: combo > 1 ? 'flex' : 'none',
      // 'x', not U+00D7 — the bundled MSDF font has no glyph for it.
      text: `COMBO x${combo}`,
      backgroundColor: background,
    });
  }

  /**
   * The footer says what is loaded. Web ammo overrides the paint halves — a
   * white swatch — for the same reason {@link resolveShot} does, and the
   * sub-mode overrides the word (WEB vs TETHER). The rule lives in
   * {@link ammoLabel} so it is testable without a panel.
   */
  private applyAmmo(): void {
    const web = this.activeStyle.peek() === BallStyle.Web;
    this.setText(
      this.ammoText,
      ammoLabel(
        this.activeStyle.peek(),
        this.webSubMode.peek(),
        this.activeKind.peek(),
      ),
    );
    this.ammoSwatch?.setProperties({
      backgroundColor: packColor(
        web ? WEB_BALL_COLOR : this.activeColor.peek(),
      ),
    });
  }

  /** The loaded skin's accent as 0xRRGGBB. */
  private skinAccent(): number {
    const skin = BLASTER.skins[clampIndex(this.blasterSkin.peek(), BLASTER.skins.length)];
    return hexToInt(skin?.accent ?? '#ff4f81');
  }

  /**
   * Launcher + skin, everywhere they show: the footer chip, the title's
   * LOADOUT readout, and the Armory's cards, description, skin card and dots.
   */
  private applyLoadout(): void {
    const mode = this.blasterMode.peek();
    const skinIndex = clampIndex(this.blasterSkin.peek(), BLASTER.skins.length);
    const skin = BLASTER.skins[skinIndex];
    const accent = hexToInt(skin?.accent ?? '#ff4f81');
    const trim = hexToInt(skin?.trim ?? '#ffffff');
    const label = BLASTER_MODE_LABELS[mode] ?? 'BLASTER';
    const mAccent = modeAccent(mode, accent);

    this.modeChip?.setProperties({
      text: label,
      color: mAccent,
      borderColor: mAccent,
      backgroundColor: tint(mAccent, 0.1),
    });
    this.setText(this.loadoutMode, label);
    this.setText(this.loadoutSkin, skin?.name ?? '');
    this.loadoutSwatch?.setProperties({ backgroundColor: accent, borderColor: trim });

    this.setText(this.armoryModeDesc, BLASTER_MODE_DESCRIPTIONS[mode] ?? '');
    this.setText(this.armorySkinName, skin?.name ?? '');
    this.setText(
      this.armorySkinIndex,
      skinCounterLabel(skinIndex, BLASTER.skins.length),
    );
    this.armorySkinSwatch?.setProperties({ backgroundColor: accent, borderColor: trim });
    this.armorySkinCard?.setProperties({ borderColor: accent });

    for (const card of MODE_CARDS) this.refreshButton(card.id);
    for (let i = 0; i < SKIN_DOT_COUNT; i++) this.refreshButton(`btn-skin-${i}`);
  }

  private setText(target: HudElement | undefined, text: string): void {
    target?.setProperties({ text });
  }
}

/** getElementById narrowed to the handful of calls HudSystem makes. */
function element(
  document: UIKitDocument,
  id: string,
): HudElement | undefined {
  return (document.getElementById(id) as unknown as HudElement | null) ?? undefined;
}
