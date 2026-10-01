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

import { CHILL, HUD, ROOM } from '../config';
import {
  BallKind,
  BallStyle,
  GameEvent,
  GameEventBuffer,
  GamePhase,
  WEB_BALL_COLOR,
  WebSubMode,
  ammoLabel,
} from '../types';
import { EaselSystem } from './EaselSystem';
import { GameStateSystem } from './GameStateSystem';
import { SceneScanSystem } from './SceneScanSystem';
import { SplatterSystem } from './SplatterSystem';

/** Must match the PanelUI.config main.ts seeds the HUD entity with. */
const HUD_CONFIG_PATH = './ui/hud.json';

/**
 * The four paint colours the markup uses, as 0xRRGGBB. Kept here as well as in
 * CSS because two things repaint at runtime: the combo pill climbs through
 * them, and every button derives its hover / pressed shades from its own
 * accent (see {@link filledStates} / {@link outlineStates}).
 */
const ACCENT_CORAL = 0xff6b6b;
const ACCENT_AMBER = 0xffca57;
const ACCENT_SKY = 0x48dbfb;
const ACCENT_LIME = 0x4dcc85;
const ACCENT_WHITE = 0xffffff;

/**
 * Milliseconds a button stays in its pressed colour after a press.
 *
 * Field feedback: "buttons don't highlight, there's no indication you clicked".
 * A trigger pull on Quest is often only two or three frames long, so painting
 * the pressed state for exactly as long as the button is held is invisible.
 * This holds it long enough to register as a flash without feeling laggy.
 */
const PRESS_FLASH_MS = 120;

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
 * carries the id is correct. `setProperties({ display })` is the show/hide
 * idiom used by IWSDK's own panel examples.
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

/** The three background values one button cycles through. */
interface ButtonStates {
  base: number | string;
  hover: number | string;
  active: number | string;
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
 * exactly this `rgba(r, g, b, a)` form (integers 0-255, float alpha). Which is
 * also the form the UIKITML already declares outline pills in, so raising the
 * tint on hover is a like-for-like swap.
 */
function tint(color: number, alpha: number): string {
  return `rgba(${(color >> 16) & 0xff}, ${(color >> 8) & 0xff}, ${color & 0xff}, ${alpha})`;
}

/** Solid pill: brighten on hover, darken on press. */
function filledStates(accent: number): ButtonStates {
  return {
    base: accent,
    hover: shade(accent, 1.12),
    active: shade(accent, 0.9),
  };
}

/** Outline pill: the accent's whisper of a fill comes up as you touch it. */
function outlineStates(accent: number): ButtonStates {
  return {
    base: tint(accent, 0.08),
    hover: tint(accent, 0.2),
    active: tint(accent, 0.35),
  };
}

/**
 * Binds the game's signals to the spatial HUD panel and wires its buttons.
 *
 * Everything here is subscription-driven: nothing is recomputed per frame, and
 * this system has no update() at all. Number-to-string work only happens
 * inside a subscription callback, i.e. when a value actually changed, which is
 * event-rate rather than 90 Hz.
 *
 * Element references are cached as fields — a fixed dozen, resolved once when
 * the panel document qualifies. Subscriptions are registered before the panel
 * exists and are written to tolerate that (`?.` everywhere), so a slow-loading
 * document never drops an update: the qualify handler paints the current state
 * of every signal as soon as the elements appear.
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
  private bestScore!: Signal<number>;
  private combo!: Signal<number>;
  private targetsAlive!: Signal<number>;
  private activeKind!: Signal<BallKind>;
  private activeStyle!: Signal<BallStyle>;
  private webSubMode!: Signal<WebSubMode>;
  private activeColor!: Signal<readonly [number, number, number, number]>;
  private sceneScanMissing!: Signal<boolean>;
  private events!: GameEventBuffer;

  /**
   * Live press-flash timers, so a system teardown never leaves a setTimeout
   * holding a reference to a disposed panel element.
   */
  private readonly flashTimers = new Set<ReturnType<typeof setTimeout>>();

  // Cached element handles — one fixed set, never grows.
  private sectionIdle?: HudElement;
  private sectionPlaying?: HudElement;
  private sectionGameOver?: HudElement;
  private sectionChill?: HudElement;
  private scanNotice?: HudElement;
  private scanNoticeText?: HudElement;
  private scoreText?: HudElement;
  private timerText?: HudElement;
  private comboPill?: HudElement;
  private targetsText?: HudElement;
  private statusText?: HudElement;
  private chillStatusText?: HudElement;
  private finalText?: HudElement;
  private bestText?: HudElement;
  private ammoText?: HudElement;
  private ammoSwatch?: HudElement;

  init() {
    this.gamePhase = this.globals.gamePhase as Signal<GamePhase>;
    this.hudScore = this.globals.hudScore as Signal<number>;
    this.hudTimer = this.globals.hudTimer as Signal<string>;
    this.hudStatus = this.globals.hudStatus as Signal<string>;
    this.bestScore = this.globals.bestScore as Signal<number>;
    this.combo = this.globals.combo as Signal<number>;
    this.targetsAlive = this.globals.targetsAlive as Signal<number>;
    this.activeKind = this.globals.activeKind as Signal<BallKind>;
    this.activeStyle = this.globals.activeStyle as Signal<BallStyle>;
    this.webSubMode = this.globals.webSubMode as Signal<WebSubMode>;
    this.activeColor = this.globals.activeColor as Signal<
      readonly [number, number, number, number]
    >;
    this.sceneScanMissing = this.globals.sceneScanMissing as Signal<boolean>;
    this.events = this.globals.gameEvents as GameEventBuffer;

    this.cleanupFuncs.push(() => {
      for (const timer of this.flashTimers) clearTimeout(timer);
      this.flashTimers.clear();
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
      this.hudStatus.subscribe((status) => this.applyStatus(status)),
      this.bestScore.subscribe((best) =>
        this.setText(this.bestText, `Best ${best}`),
      ),
      this.combo.subscribe((combo) => this.applyCombo(combo)),
      this.targetsAlive.subscribe((alive) =>
        this.setText(this.targetsText, alive === 1 ? '1 bot' : `${alive} bots`),
      ),
      this.activeKind.subscribe(() => this.applyAmmo()),
      this.activeStyle.subscribe(() => this.applyAmmo()),
      this.webSubMode.subscribe(() => this.applyAmmo()),
      this.activeColor.subscribe(() => this.applyAmmo()),
      this.sceneScanMissing.subscribe(() => this.applyScanNotice()),
    );
  }

  /** Resolve every id the markup declares. Missing ids stay undefined. */
  private bindElements(document: UIKitDocument): void {
    this.sectionIdle = element(document, 'section-idle');
    this.sectionPlaying = element(document, 'section-playing');
    this.sectionGameOver = element(document, 'section-gameover');
    this.sectionChill = element(document, 'section-chill');
    this.scanNotice = element(document, 'scan-notice');
    this.scanNoticeText = element(document, 'scan-notice-text');
    this.scoreText = element(document, 'hud-score');
    this.timerText = element(document, 'hud-timer');
    this.comboPill = element(document, 'hud-combo');
    this.targetsText = element(document, 'hud-targets');
    this.statusText = element(document, 'hud-status');
    this.chillStatusText = element(document, 'hud-chill-status');
    this.finalText = element(document, 'hud-final');
    this.bestText = element(document, 'hud-best');
    this.ammoText = element(document, 'hud-ammo');
    this.ammoSwatch = element(document, 'hud-ammo-swatch');
  }

  private releaseElements(): void {
    this.sectionIdle = undefined;
    this.sectionPlaying = undefined;
    this.sectionGameOver = undefined;
    this.sectionChill = undefined;
    this.scanNotice = undefined;
    this.scanNoticeText = undefined;
    this.scoreText = undefined;
    this.timerText = undefined;
    this.comboPill = undefined;
    this.targetsText = undefined;
    this.statusText = undefined;
    this.chillStatusText = undefined;
    this.finalText = undefined;
    this.bestText = undefined;
    this.ammoText = undefined;
    this.ammoSwatch = undefined;
  }

  /** START / CHILL MODE / PLAY AGAIN / SCAN ROOM / EXIT / paint buttons. */
  private wireButtons(document: UIKitDocument): void {
    const start = () => this.world.getSystem(GameStateSystem)?.startGame();

    this.wireInteractiveButton(document, 'btn-start', ACCENT_AMBER, start);
    this.wireInteractiveButton(document, 'btn-restart', ACCENT_LIME, start);
    this.wireInteractiveButton(document, 'btn-chill', ACCENT_SKY, () => {
      this.world.getSystem(GameStateSystem)?.startChill();
    });
    // WEB MODE is a shortcut, not a phase. @see startWebMode
    this.wireInteractiveButton(
      document,
      'btn-web',
      ACCENT_CORAL,
      () => this.startWebMode(),
      // Glass base rather than the coral wash the other outline pills use: the
      // markup declares it white-tinted with a coral border, and hover/press
      // bring the coral up from behind it.
      (accent) => ({
        base: tint(ACCENT_WHITE, 0.1),
        hover: tint(accent, 0.22),
        active: tint(accent, 0.38),
      }),
    );
    // The only thing in the game that ever calls initiateRoomCapture, and it
    // does so from inside a click handler — a user gesture by construction,
    // which is the whole difference between this and round 2's timer.
    this.wireInteractiveButton(
      document,
      'btn-scan-room',
      ACCENT_AMBER,
      () => this.requestRoomScan(),
      outlineStates,
    );
    this.wireInteractiveButton(
      document,
      'btn-exit-chill',
      ACCENT_CORAL,
      () => this.world.getSystem(GameStateSystem)?.exitChill(),
      outlineStates,
    );
    this.wireInteractiveButton(
      document,
      'btn-save-painting',
      ACCENT_AMBER,
      () => this.world.getSystem(EaselSystem)?.savePainting(),
      outlineStates,
    );
    this.wireInteractiveButton(
      document,
      'btn-new-canvas',
      ACCENT_SKY,
      () => this.world.getSystem(EaselSystem)?.newCanvas(),
      outlineStates,
    );
    this.wireInteractiveButton(
      document,
      'btn-orientation',
      ACCENT_LIME,
      () => this.rotateCanvas(),
      outlineStates,
    );
    // The glass footer pill is white-tinted rather than accented, but wears
    // the same three-state treatment so nothing on the panel feels dead.
    this.wireInteractiveButton(
      document,
      'btn-clear',
      ACCENT_WHITE,
      () => this.world.getSystem(SplatterSystem)?.clearAll(),
      (accent) => ({
        base: tint(accent, 0.07),
        hover: tint(accent, 0.16),
        active: tint(accent, 0.28),
      }),
    );
  }

  /**
   * Give one button the full press affordance: hover tint, a timed pressed
   * flash, a click cue, and its action.
   *
   * Every button on the panel goes through here, which is the point — round 2
   * shipped bare `click` handlers and players could not tell a press had
   * landed. A ray click in XR gives no tactile feedback at all, so the panel
   * has to do the confirming: the colour moves under the cursor, snaps darker
   * on the press, and FeedbackSystem puts a tick under it off `UiClick`.
   *
   * The flash timer and the hover flag interact: the timer restores whichever
   * state the pointer is actually in when it fires, so releasing outside the
   * button lands on `base` and releasing inside lands on `hover`.
   */
  private wireInteractiveButton(
    document: UIKitDocument,
    id: string,
    accent: number,
    action: () => void,
    states: (accent: number) => ButtonStates = filledStates,
  ): void {
    const button = element(document, id);
    if (!button) return;

    const { base, hover, active } = states(accent);
    let hovering = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const paint = (background: number | string) =>
      button.setProperties({ backgroundColor: background });

    const flash = () => {
      paint(active);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.flashTimers.delete(timer);
      }
      timer = setTimeout(() => {
        if (timer !== undefined) this.flashTimers.delete(timer);
        timer = undefined;
        paint(hovering ? hover : base);
      }, PRESS_FLASH_MS);
      this.flashTimers.add(timer);
    };

    button.addEventListener('pointerenter', () => {
      hovering = true;
      if (timer === undefined) paint(hover);
    });
    button.addEventListener('pointerleave', () => {
      hovering = false;
      if (timer === undefined) paint(base);
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
  }

  /**
   * The title screen's WEB MODE button: drop into the chill sandbox with web
   * ammo already loaded.
   *
   * ### Why this is a shortcut and not a phase
   *
   * Round 4 shipped a real `GamePhase.Web` — a separate sandbox with the
   * palette hidden — and round 5 deleted it, because a mode you have to leave
   * cannot give you "web mode AND chill mode". That deletion was right and is
   * not being undone. But it also removed the only *signpost*: webbing became
   * something you had to already know about to find, one chip in a row of five
   * on your own wrist. Round 6's field note was exactly that — "I want web on
   * the title screen as well".
   *
   * So the button is two existing things done together, and nothing else:
   * `startChill()` plus `activeStyle = Web`. The player lands in the ordinary
   * chill sandbox with shooters on both wrists, EXIT CHILL leaves the way it
   * always did, and touching any paint dab or chip switches ammo the way it
   * always did. Nothing about it is exclusive, so there is nothing to get
   * stuck in.
   *
   * The sub-mode is deliberately left alone: whichever of splat or tether the
   * player last chose is what they get, because it is a preference and not part
   * of what this button means.
   */
  private startWebMode(): void {
    const game = this.world.getSystem(GameStateSystem);
    if (!game) return;
    game.startChill();
    // Written unconditionally rather than through a peek-and-compare: the
    // signal dedupes identical writes itself, and the point of the button is
    // that pressing it always leaves you holding webbing.
    this.activeStyle.value = BallStyle.Web;
  }

  /**
   * Turn the canvas on its side, and own up to the cost in the status line —
   * a browser canvas clears whenever its width or height is written, so there
   * is no rotating a painting in place.
   */
  private rotateCanvas(): void {
    const easel = this.world.getSystem(EaselSystem);
    if (!easel) return;
    easel.rotateCanvas();
    // GameStateSystem only rewrites hudStatus on a phase change, and Chill has
    // none until EXIT CHILL, so this line stays put for the rest of the visit.
    this.hudStatus.value = CHILL.rotatedText;
  }

  /**
   * Ask Quest to run Space Setup, and say what happened.
   *
   * Three outcomes, all of which the player has to be told apart, because from
   * their side "I pressed the button and nothing changed" looks identical:
   * capture started (go and finish it), no such API (do it from the system
   * menu), or already asked once this session (Meta documents the call as
   * once-per-session, so the second press genuinely cannot work).
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

  /**
   * Show the room-scan notice only when there is both something to say and
   * somewhere to say it: no scene model, and the player standing on the title
   * screen rather than mid-round. Both gates matter — a notice that appeared
   * during a round would be an amber strip nobody can act on, and the SCAN
   * ROOM button drops you out of the session into Space Setup.
   */
  private applyScanNotice(): void {
    const show =
      this.sceneScanMissing.peek() && this.gamePhase.peek() === GamePhase.Idle;
    this.scanNotice?.setProperties({ display: show ? 'flex' : 'none' });
  }

  /** Bring a freshly bound document up to date with every signal at once. */
  private paintEverything(): void {
    const alive = this.targetsAlive.peek();
    this.applyPhase(this.gamePhase.peek());
    this.applyScore(this.hudScore.peek());
    this.applyCombo(this.combo.peek());
    this.applyAmmo();
    this.setText(this.timerText, this.hudTimer.peek());
    this.applyStatus(this.hudStatus.peek());
    this.setText(this.bestText, `Best ${this.bestScore.peek()}`);
    this.setText(this.targetsText, alive === 1 ? '1 bot' : `${alive} bots`);
  }

  /**
   * One status signal, two places to show it: the live-round line and the chill
   * panel. Only one of the two is ever on screen, so writing both is cheaper
   * than deciding which.
   */
  private applyStatus(status: string): void {
    this.setText(this.statusText, status);
    this.setText(this.chillStatusText, status);
  }

  /** Exactly one phase section is visible; the footer never hides. */
  private applyPhase(phase: GamePhase): void {
    this.sectionIdle?.setProperties({
      display: phase === GamePhase.Idle ? 'flex' : 'none',
    });
    // Countdown shares the playing layout so the score/timer do not pop in.
    this.sectionPlaying?.setProperties({
      display:
        phase === GamePhase.Countdown || phase === GamePhase.Playing
          ? 'flex'
          : 'none',
    });
    this.sectionGameOver?.setProperties({
      display: phase === GamePhase.GameOver ? 'flex' : 'none',
    });
    this.sectionChill?.setProperties({
      display: phase === GamePhase.Chill ? 'flex' : 'none',
    });
    // Lives inside the idle section, so it has to follow the phase as well as
    // its own signal.
    this.applyScanNotice();
    this.applyDock(phase);
  }

  /**
   * Move the panel out of the firing line while the player is shooting.
   *
   * Field feedback: a head-locked panel at chest height, one metre out, is
   * exactly where paintballs go — players were hitting their own HUD. So
   * Playing and Chill get a low, small, lazy dock (a watch strip at the bottom
   * of your view) and every menu phase gets the comfortable reading placement
   * back.
   *
   * Follower's fields are written two different ways on purpose: `offsetPosition`
   * is a Vec3, and elics throws on both getValue and setValue for vector types,
   * so it goes through `getVectorView` and three float writes. The scalars go
   * through `setValue`. `needsPositionSync` makes the panel snap to the new
   * placement on the next FollowSystem tick instead of sliding across the room
   * at the docked (deliberately sluggish) speed.
   *
   * The behaviour swap is not cosmetic: `FollowBehavior.PivotY` overwrites the
   * follow target's Y with the head's own Y, which silently discards the whole
   * point of a low dock. Face-target following honours the offset.
   */
  private applyDock(phase: GamePhase): void {
    const docked = phase === GamePhase.Playing || phase === GamePhase.Chill;
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
   * Resize the panel by moving its PanelUI bounds, NOT by scaling its object3D.
   *
   * PanelUISystem re-derives the document's target dimensions every frame as
   * `maxWidth / entity.worldScale.x`, so an object3D scale is divided straight
   * back out and the rendered panel never changes size. Writing the bounds is
   * the size control that actually works.
   *
   * It also fixes the shot-blocking rectangle for free: BallSpawnSystem's
   * ray-vs-panel test measures the same maxWidth × maxHeight, so a smaller
   * panel swallows a proportionally smaller slice of the room.
   */
  private applyPanelSize(entity: Entity, scale: number): void {
    entity.setValue(PanelUI, 'maxWidth', HUD.baseWidth * scale);
    entity.setValue(PanelUI, 'maxHeight', HUD.baseHeight * scale);
  }

  private applyScore(score: number): void {
    const text = String(score);
    this.setText(this.scoreText, text);
    this.setText(this.finalText, text);
  }

  /**
   * The pill only exists visually while the multiplier is actually above ×1,
   * and it heats up through the palette as the streak climbs.
   */
  private applyCombo(combo: number): void {
    const background =
      combo >= 4 ? ACCENT_SKY : combo === 3 ? ACCENT_CORAL : ACCENT_AMBER;
    this.comboPill?.setProperties({
      display: combo > 1 ? 'flex' : 'none',
      // 'x', not '×' — the bundled MSDF font has no glyph for U+00D7.
      text: `x${combo}`,
      backgroundColor: background,
    });
  }

  /**
   * The footer says what is loaded, and since round 6 that is a three-axis
   * question. Web ammo overrides the paint halves — a white swatch — for the
   * same reason {@link resolveShot} does: the paint choice is still sitting
   * there waiting, but it is not what would come out of the barrel, and a
   * footer showing STICKY in red while you throw white webbing would be a lie.
   *
   * The sub-mode then overrides the word itself: WEB and TETHER fly
   * identically and do completely different things on contact, which is
   * precisely what a one-word footer is for. The swatch stays white for both —
   * a tether is still webbing.
   *
   * The rule lives in {@link ammoLabel} over in types.ts rather than here, so
   * it can be tested without a panel.
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
