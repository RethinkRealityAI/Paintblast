import { InputComponent, VisibilityState, createSystem } from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import { CHILL, GAME } from '../config';
import {
  GameEvent,
  GameEventBuffer,
  GamePhase,
  INITIAL_HUD_STATE,
  copyRoundStats,
  createRoundStats,
  recordRoundEvent,
  resetRoundStats,
  unpackPopPoints,
} from '../types';
import type { RoundStats } from '../types';

/**
 * Base points a TargetPopped event is worth before the combo multiplier.
 *
 * Round 8: the Splotbots are worth different amounts (Duster Duke far more
 * than a Mopsy), and TargetSystem packs each pop's points into the event's
 * `data` word ({@link packPopData}). A word carrying no points — any producer
 * that predates the cast — falls back to the classic `GAME.scoreTargetHit`.
 * Pure and exported for tests.
 */
export function popBasePoints(data: number): number {
  const packed = unpackPopPoints(data);
  return packed > 0 ? packed : GAME.scoreTargetHit;
}

/** localStorage key holding the all-time best score. */
export const BEST_SCORE_STORAGE_KEY = 'paintblast.bestScore';

/** The slice of GAME that advancePhase() reads. @see advancePhase */
export interface PhaseTimings {
  readonly countdownSec: number;
  readonly roundSec: number;
  readonly gameOverSec: number;
}

/**
 * Everything one advancePhase() call decided, written into a caller-owned
 * object so the state machine can be ticked every frame without allocating.
 */
export interface PhaseTick {
  /** Phase to be in after this tick. */
  phase: GamePhase;
  /** Seconds spent in `phase`. Reset to 0 whenever the phase changes. */
  phaseElapsed: number;
  /** Seconds left in the round. */
  timeLeft: number;
  /** True when `phase` differs from the phase passed in. */
  changed: boolean;
  /** Countdown second just crossed (3, 2, 1). 0 means "no tick this frame". */
  countdownTick: number;
}

/** A zero-filled PhaseTick to hand to advancePhase(). */
export function createPhaseTick(): PhaseTick {
  return {
    phase: GamePhase.Idle,
    phaseElapsed: 0,
    timeLeft: 0,
    changed: false,
    countdownTick: 0,
  };
}

/** Whole seconds still to go in the countdown, floored at 0. */
function countdownSecondsLeft(countdownSec: number, elapsed: number): number {
  return Math.max(0, Math.ceil(countdownSec - elapsed));
}

/**
 * Advance the round state machine by one frame.
 *
 * Pure: no signals, no World, no clock of its own — just
 * `(phase, elapsed, timeLeft, delta) → out`. That is what makes the whole
 * Idle → Countdown → Playing → GameOver → Idle cycle unit-testable at any
 * frame rate, including pathological ones.
 *
 * Idle never leaves on its own; only {@link GameStateSystem.startGame} or
 * {@link GameStateSystem.startChill} does that, and Chill likewise only ends
 * when the player presses EXIT CHILL. Both fall through to the default branch
 * below, so neither runs a clock. Every other phase leaves on a timer.
 *
 * `countdownTick` fires on integer *crossings* only, so the very first number
 * of the countdown is emitted by startGame() at the moment of entry.
 */
export function advancePhase(
  phase: GamePhase,
  phaseElapsed: number,
  timeLeft: number,
  delta: number,
  cfg: PhaseTimings,
  out: PhaseTick,
): void {
  out.phase = phase;
  out.phaseElapsed = phaseElapsed + delta;
  out.timeLeft = timeLeft;
  out.changed = false;
  out.countdownTick = 0;

  switch (phase) {
    case GamePhase.Countdown: {
      const before = countdownSecondsLeft(cfg.countdownSec, phaseElapsed);
      const after = countdownSecondsLeft(cfg.countdownSec, out.phaseElapsed);
      if (after !== before && after >= 1) {
        out.countdownTick = after;
      }
      if (out.phaseElapsed >= cfg.countdownSec) {
        out.phase = GamePhase.Playing;
        out.phaseElapsed = 0;
        out.timeLeft = cfg.roundSec;
        out.changed = true;
      }
      break;
    }

    case GamePhase.Playing: {
      out.timeLeft = Math.max(0, timeLeft - delta);
      if (out.timeLeft <= 0) {
        out.phase = GamePhase.GameOver;
        out.phaseElapsed = 0;
        out.changed = true;
      }
      break;
    }

    case GamePhase.GameOver: {
      if (out.phaseElapsed >= cfg.gameOverSec) {
        out.phase = GamePhase.Idle;
        out.phaseElapsed = 0;
        out.timeLeft = cfg.roundSec;
        out.changed = true;
      }
      break;
    }

    default:
      // Idle and Chill: the elapsed counter runs but the round clock is frozen
      // and nothing transitions until a button says so.
      break;
  }
}

/**
 * The score multiplier and the window that keeps it alive.
 *
 * Pure and clock-injected (`nowSec` is always passed in) so combo behaviour
 * can be tested without faking timers.
 */
export class ComboTracker {
  /** Seconds of quiet before the multiplier falls back to ×1. */
  readonly windowSec: number;
  /** Multiplier ceiling. */
  readonly cap: number;

  private _current = 1;
  private _lastHitSec = Number.NEGATIVE_INFINITY;

  constructor(windowSec: number, cap: number) {
    this.windowSec = windowSec;
    this.cap = Math.max(1, Math.floor(cap));
  }

  /** Multiplier that the next pop will score at. Always ≥ 1. */
  get current(): number {
    return this._current;
  }

  /** Timestamp of the most recent hit(), or -Infinity if there was none. */
  get lastHitSec(): number {
    return this._lastHitSec;
  }

  /**
   * Register a pop and refresh the window.
   *
   * @returns the multiplier that applies to *this* pop — the value before the
   * increment, so the first pop of a round scores ×1 rather than ×2.
   */
  hit(nowSec: number): number {
    const applied = this._current;
    this._current = Math.min(this._current + 1, this.cap);
    this._lastHitSec = nowSec;
    return applied;
  }

  /** True when the window has lapsed on a multiplier that is above ×1. */
  expired(nowSec: number): boolean {
    return this._current > 1 && nowSec - this._lastHitSec > this.windowSec;
  }

  /** Drop to ×1 if the window lapsed. @returns true when it actually decayed. */
  decay(nowSec: number): boolean {
    if (!this.expired(nowSec)) return false;
    this._current = 1;
    return true;
  }

  /** Back to a cold ×1 with no history. */
  reset(): void {
    this._current = 1;
    this._lastHitSec = Number.NEGATIVE_INFINITY;
  }
}

/**
 * Does this visibility state mean the player can no longer see and act on the
 * game? Everything but `Visible` does.
 *
 * `VisibleBlurred` is the Quest system menu (or any OS overlay): the scene is
 * still drawn, dimmed, but input goes to the overlay. `Hidden` is the headset
 * coming off or the browser backgrounding the session. `NonImmersive` is no
 * session at all — the landing page, or a session that ended mid-round, which
 * is a pause too: ENTER AR again and the round carries on.
 */
export function isFocusLost(state: VisibilityState): boolean {
  return state !== VisibilityState.Visible;
}

/**
 * The phases a pause actually freezes: the three that run on a clock.
 *
 * Idle and Chill have no clock to stop, so losing focus in them changes
 * nothing visible — which matters for Chill in particular, whose status line
 * HudSystem may have rewritten (ROTATE CANVAS) and must not be clobbered by a
 * trip to the system menu.
 */
export function isTimedPhase(phase: GamePhase): boolean {
  return (
    phase === GamePhase.Countdown ||
    phase === GamePhase.Playing ||
    phase === GamePhase.GameOver
  );
}

/**
 * Wall-clock bookkeeping for a game that can be frozen.
 *
 * Pure and clock-injected like {@link ComboTracker}: every method takes
 * `nowSec` (or a frame delta) from the caller, so a whole pause/resume cycle
 * — including the frame that comes back after minutes with no warning — is
 * unit-testable without timers or a World.
 *
 * Two jobs:
 *
 * 1. **Game time.** {@link now} is the wall clock minus every second spent
 *    paused, and it stands still while paused. Anything that measures "how
 *    long since X" against a timestamp it took from here (the combo window)
 *    therefore cannot lapse while the player is in the system menu.
 * 2. **Frame budget.** {@link consumeFrame} says how much of a frame's delta
 *    the round clock may spend: none while paused, none on the first frame
 *    back (its delta spans the pause), and none for a stall longer than
 *    `gapSec` — the case where the session went hidden, the browser stopped
 *    delivering frames, and no visibility change was ever observed. A stall
 *    is credited to the paused total, so game time does not jump either.
 *
 * TargetSystem keeps its own instance and drives it through {@link sync},
 * which reports how far to push its absolute deadlines on the frame a freeze
 * ends.
 */
export class PauseClock {
  /** Longest frame, seconds, that still counts as play. */
  readonly gapSec: number;

  private _paused = false;
  private _pausedAtSec = 0;
  private _pausedTotalSec = 0;
  private _resumePending = false;

  constructor(gapSec: number = GAME.pauseGapSec) {
    this.gapSec = gapSec;
  }

  /** True between a pause() and the matching resume(). */
  get paused(): boolean {
    return this._paused;
  }

  /** Every second spent paused so far, completed pauses and stalls only. */
  get pausedTotalSec(): number {
    return this._pausedTotalSec;
  }

  /** Freeze. Idempotent: a second call does not move the pause start. */
  pause(nowSec: number): void {
    if (this._paused) return;
    this._paused = true;
    this._pausedAtSec = nowSec;
  }

  /**
   * Unfreeze, banking the span just ended. Idempotent.
   *
   * @returns the seconds that pause lasted, or 0 when nothing was paused.
   */
  resume(nowSec: number): number {
    if (!this._paused) return 0;
    const span = Math.max(0, nowSec - this._pausedAtSec);
    this._paused = false;
    this._pausedTotalSec += span;
    this._resumePending = true;
    return span;
  }

  /**
   * Game time in seconds: wall clock less every paused second. Frozen at the
   * moment of the pause until resume() is called, then continuous with it.
   */
  now(nowSec: number): number {
    return (this._paused ? this._pausedAtSec : nowSec) - this._pausedTotalSec;
  }

  /**
   * The share of this frame's `delta` that game clocks may advance by. Call it
   * exactly once per frame, paused or not.
   *
   * - **Paused:** 0.
   * - **First frame after resume():** 0, once. That frame's delta was
   *   measured across the pause; resume() already banked the time.
   * - **Stall** (`delta > gapSec`): 0, and the delta is banked as paused time
   *   so now() does not leap forward by it.
   * - **Nonsense** (negative, NaN): 0.
   * - Otherwise the delta, untouched.
   */
  consumeFrame(delta: number): number {
    if (this._paused) return 0;
    if (this._resumePending) {
      this._resumePending = false;
      return 0;
    }
    if (!(delta > 0)) return 0;
    if (delta > this.gapSec) {
      this._pausedTotalSec += delta;
      return 0;
    }
    return delta;
  }

  /**
   * The whole per-frame protocol for a system that polls `paused` rather than
   * subscribing to visibility, and keeps its deadlines on the raw clock
   * (TargetSystem): pause or resume to match, spend the frame, and report how
   * much time just came out of the freeze.
   *
   * The report is the growth of {@link pausedTotalSec} across the call, which
   * is what makes the awkward case come out right: a pause whose last frames
   * were also a stall (blurred, then hidden, then back) is banked once by
   * resume(), and the stall-sized delta on the resume frame is then discarded
   * rather than banked a second time.
   *
   * @returns seconds to push every absolute deadline forward by — the span of
   *   a pause that ended on this frame, or of a stall — or 0 on an ordinary
   *   frame and on every frame that is still paused.
   */
  sync(paused: boolean, nowSec: number, delta: number): number {
    if (paused) {
      this.pause(nowSec);
      return 0;
    }
    const before = this._pausedTotalSec;
    this.resume(nowSec);
    this.consumeFrame(delta);
    return this._pausedTotalSec - before;
  }
}

/**
 * Seconds → `m:ss`. Rounds up, so the last visible second is `0:01` and
 * `0:00` appears exactly when the round is over. Negatives clamp to `0:00`.
 */
export function formatTimer(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
}

/** Best score from a previous session, or 0 outside a browser. */
function readBestScore(): number {
  try {
    const raw = globalThis.localStorage?.getItem(BEST_SCORE_STORAGE_KEY);
    const parsed = raw == null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    // No DOM, or storage blocked (private mode / third-party context).
    return 0;
  }
}

function writeBestScore(score: number): void {
  try {
    globalThis.localStorage?.setItem(BEST_SCORE_STORAGE_KEY, String(score));
  } catch {
    // Losing the high score is not worth throwing mid-frame over.
  }
}

/**
 * The referee: owns the phase machine, the round clock, the score, and the
 * combo. Every other system reacts to the signals this one writes.
 *
 * Writes `gamePhase`, `score`, `bestScore`, `combo`, `timeLeft`, `paused` and
 * the three HUD strings (`hudScore`, `hudTimer`, `hudStatus`); reads
 * `targetsAlive`.
 *
 * Runs at priority 30, i.e. after every event producer (BallFlightSystem at
 * 12, TargetSystem at 14) and before EventFlushSystem at 90, so scoring sees
 * a complete frame of events exactly once.
 *
 * ### Pause
 *
 * The competition brief asks for "clean pause/resume": open the Quest menu
 * mid-round, come back, and the round is exactly where you left it. This
 * system owns that decision. It mirrors `world.visibilityState` into the
 * `paused` global (true whenever the session is not `Visible`), and while it
 * is set the round clock, the countdown, the game-over timer and the combo
 * window all stand still. TargetSystem freezes its robots off the same signal.
 *
 * The render loop writes visibilityState at the top of each frame, before
 * any system updates, so the subscription below has already flipped `paused`
 * by the time TargetSystem (priority 14) reads it — both systems freeze and
 * thaw on the same frame regardless of priority.
 */
export class GameStateSystem extends createSystem({}) {
  private events!: GameEventBuffer;
  private gamePhase!: Signal<GamePhase>;
  private score!: Signal<number>;
  private bestScore!: Signal<number>;
  private combo!: Signal<number>;
  private timeLeft!: Signal<number>;
  private targetsAlive!: Signal<number>;
  private hudScore!: Signal<number>;
  private hudTimer!: Signal<string>;
  private hudStatus!: Signal<string>;
  private paused!: Signal<boolean>;
  /** Round 9: true during the tutorial's practice round. Optional in tests. */
  private practice?: Signal<boolean>;
  /** Round 9: the results card's numbers, published at GameOver. Optional in tests. */
  private roundStats?: Signal<RoundStats | null>;

  /** This round's running stats (reset at startGame). @see recordRoundEvent */
  private readonly stats: RoundStats = createRoundStats();
  /** Round 9: a practice round is running. @see startPractice */
  private practiceActive = false;

  private comboTracker!: ComboTracker;
  private tick!: PhaseTick;
  /** Game time and the per-frame budget. @see PauseClock */
  private pauseClock!: PauseClock;

  private phaseElapsed = 0;
  /** Last whole second published to hudTimer — guards per-frame formatting. */
  private lastTimerSecond = -1;

  init() {
    this.events = this.globals.gameEvents as GameEventBuffer;
    this.gamePhase = this.globals.gamePhase as Signal<GamePhase>;
    this.score = this.globals.score as Signal<number>;
    this.bestScore = this.globals.bestScore as Signal<number>;
    this.combo = this.globals.combo as Signal<number>;
    this.timeLeft = this.globals.timeLeft as Signal<number>;
    this.targetsAlive = this.globals.targetsAlive as Signal<number>;
    this.hudScore = this.globals.hudScore as Signal<number>;
    this.hudTimer = this.globals.hudTimer as Signal<string>;
    this.hudStatus = this.globals.hudStatus as Signal<string>;
    this.paused = this.globals.paused as Signal<boolean>;
    this.practice = this.globals.practice as Signal<boolean> | undefined;
    this.roundStats = this.globals.roundStats as
      | Signal<RoundStats | null>
      | undefined;

    this.comboTracker = new ComboTracker(GAME.comboWindowSec, GAME.comboCap);
    this.tick = createPhaseTick();
    this.pauseClock = new PauseClock();

    this.bestScore.value = readBestScore();

    // The Playing status line quotes targetsAlive, so rebuild it when robots
    // spawn or pop rather than re-deriving the string every frame.
    this.cleanupFuncs.push(this.targetsAlive.subscribe(() => this.refreshStatus()));

    this.hudScore.value = this.score.peek();
    this.publishTimer(this.timeLeft.peek());
    this.refreshStatus();

    // Last, because subscribe() runs the callback immediately with the current
    // state and applyFocus() reads the signals bound above. On the landing
    // page that state is NonImmersive, so the game starts out paused and
    // thaws the moment the immersive session becomes Visible.
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => this.applyFocus(state)),
    );
  }

  update(delta: number) {
    const phase = this.gamePhase.peek();
    // Spent every frame, paused or not, so the frame that ends a pause has its
    // delta (which was measured across the pause) discarded exactly once.
    const step = this.pauseClock.consumeFrame(delta);

    // A practice round (the tutorial's bot steps) is Playing with the clock
    // stopped: no timer, no score, no combo, no stats. Its only exits are
    // endPractice() and endRound(); if anything else moved the phase on, the
    // practice is over.
    if (this.practiceActive) {
      if (phase !== GamePhase.Playing) this.clearPractice();
      else return;
    }

    if (this.paused.peek()) {
      // Frozen: no clock, no countdown, no combo decay, no start button. The
      // one thing still honoured is this frame's events — a ball already in
      // the air when focus went can still land and paint, and the splat it
      // leaves is on the wall either way, so its points count.
      if (phase === GamePhase.Playing) this.scoreFrameEvents();
      return;
    }

    if (
      (phase === GamePhase.Idle || phase === GamePhase.GameOver) &&
      this.startPressed()
    ) {
      this.startGame();
      return;
    }

    if (phase === GamePhase.Playing) {
      this.scoreFrameEvents();
      if (this.comboTracker.decay(this.gameNowSec())) {
        this.combo.value = this.comboTracker.current;
      }
    }

    advancePhase(
      phase,
      this.phaseElapsed,
      this.timeLeft.peek(),
      step,
      GAME,
      this.tick,
    );
    this.phaseElapsed = this.tick.phaseElapsed;

    if (phase === GamePhase.Playing) {
      this.timeLeft.value = this.tick.timeLeft;
      this.publishTimer(this.tick.timeLeft);
    }

    if (this.tick.countdownTick > 0) {
      // data = the number the player should be hearing (3, 2, 1).
      this.events.emit(GameEvent.CountdownTick, 0, 0, 0, this.tick.countdownTick);
    }

    if (this.tick.changed) {
      this.enterPhase(this.tick.phase);
    }
  }

  /**
   * Kick off a round. Valid from Idle or GameOver; a no-op anywhere else.
   * Called by the HUD's START / PLAY AGAIN buttons and by the A/X button.
   */
  startGame(): void {
    const phase = this.gamePhase.peek();
    if (phase !== GamePhase.Idle && phase !== GamePhase.GameOver) return;

    this.score.value = 0;
    this.hudScore.value = 0;
    this.comboTracker.reset();
    this.combo.value = 1;
    this.timeLeft.value = GAME.roundSec;
    this.publishTimer(GAME.roundSec);
    this.phaseElapsed = 0;
    resetRoundStats(this.stats, this.bestScore.peek());

    this.gamePhase.value = GamePhase.Countdown;
    // advancePhase only fires on integer crossings, so without this the first
    // number of the countdown would be silent.
    this.events.emit(
      GameEvent.CountdownTick,
      0,
      0,
      0,
      Math.max(1, Math.ceil(GAME.countdownSec)),
    );
    this.refreshStatus();
  }

  /**
   * Drop into Chill mode: no clock, no robots, no score — just the room, the
   * paint and the easel. Valid from Idle only; the CHILL MODE button is the
   * only caller.
   */
  startChill(): void {
    if (this.gamePhase.peek() !== GamePhase.Idle) return;
    this.phaseElapsed = 0;
    this.enterPhase(GamePhase.Chill);
  }

  /** Leave Chill mode and rearm the round clock. A no-op outside Chill. */
  exitChill(): void {
    if (this.gamePhase.peek() !== GamePhase.Chill) return;
    this.phaseElapsed = 0;
    this.enterPhase(GamePhase.Idle);
  }

  /**
   * Round 9: a practice round for the tutorial's bot steps.
   *
   * ### Why "Playing with the clock stopped" and not a new phase
   *
   * TargetSystem only wakes its pool, animates and hit-tests during Playing,
   * and BallSpawnSystem's aim assist is Playing-only. A `GamePhase.Tutorial`
   * would have needed both of them (and every phase subscriber) taught a new
   * phase. Instead the practice round *is* Playing, with this system holding
   * its clock at `GAME.roundSec`: the wave director stays in wave 0
   * (Mopsy-only), the Duke never comes (his cue is 20 s left), nothing scores
   * and no RoundStart / RoundEnd is broadcast. `globals.practice` tells the
   * HUD, Pip and the coach which kind of Playing this is.
   *
   * Valid from Idle only. @returns true when the practice round started.
   */
  startPractice(): boolean {
    if (this.gamePhase.peek() !== GamePhase.Idle) return false;
    this.practiceActive = true;
    if (this.practice && this.practice.peek() !== true) this.practice.value = true;
    this.score.value = 0;
    this.hudScore.value = 0;
    this.comboTracker.reset();
    this.combo.value = 1;
    this.timeLeft.value = GAME.roundSec;
    this.publishTimer(GAME.roundSec);
    this.phaseElapsed = 0;
    // Straight to Playing: TargetSystem wakes its pool on this write.
    this.gamePhase.value = GamePhase.Playing;
    this.refreshStatus();
    return true;
  }

  /** True while a practice round is running. */
  get inPractice(): boolean {
    return this.practiceActive;
  }

  /** End a practice round and return to the title. A no-op otherwise. */
  endPractice(): void {
    if (!this.practiceActive) return;
    this.clearPractice();
    this.score.value = 0;
    this.hudScore.value = 0;
    this.comboTracker.reset();
    this.combo.value = 1;
    this.phaseElapsed = 0;
    if (this.gamePhase.peek() === GamePhase.Playing) {
      this.enterPhase(GamePhase.Idle);
    }
  }

  private clearPractice(): void {
    this.practiceActive = false;
    if (this.practice && this.practice.peek() !== false) this.practice.value = false;
  }

  /**
   * Cut the round short and go straight to the summary. Valid from Countdown
   * or Playing; a no-op anywhere else. A practice round just ends (there is
   * nothing to summarise).
   */
  endRound(): void {
    if (this.practiceActive) {
      this.endPractice();
      return;
    }
    const phase = this.gamePhase.peek();
    if (phase !== GamePhase.Playing && phase !== GamePhase.Countdown) return;

    this.timeLeft.value = 0;
    this.publishTimer(0);
    this.phaseElapsed = 0;
    this.enterPhase(GamePhase.GameOver);
  }

  /** Apply a phase transition and broadcast whatever it implies. */
  private enterPhase(next: GamePhase): void {
    // Writing this fires TargetSystem's subscription synchronously, so the
    // robots are already spawned/hidden by the time refreshStatus() runs.
    this.gamePhase.value = next;

    switch (next) {
      case GamePhase.Playing:
        this.timeLeft.value = GAME.roundSec;
        this.publishTimer(GAME.roundSec);
        // data = round length in whole seconds.
        this.events.emit(
          GameEvent.RoundStart,
          0,
          0,
          0,
          Math.round(GAME.roundSec),
        );
        break;

      case GamePhase.GameOver: {
        const finalScore = this.score.peek();
        // The results card: a detached snapshot, so the next round's running
        // stats can never repaint a card that is still up.
        this.stats.score = finalScore;
        if (this.roundStats) this.roundStats.value = copyRoundStats(this.stats);
        if (finalScore > this.bestScore.peek()) {
          this.bestScore.value = finalScore;
          writeBestScore(finalScore);
        }
        // data = final score.
        this.events.emit(GameEvent.RoundEnd, 0, 0, 0, finalScore);
        break;
      }

      case GamePhase.Idle:
        this.timeLeft.value = GAME.roundSec;
        this.publishTimer(GAME.roundSec);
        break;

      default:
        // Countdown and Chill: nothing to broadcast beyond the phase itself.
        // TargetSystem, EaselSystem and WebShooterSystem all subscribe to
        // gamePhase, so their side of the switch already ran synchronously
        // above.
        break;
    }

    this.refreshStatus();
  }

  /**
   * Turn this frame's events into points. Reads the buffer before
   * EventFlushSystem empties it at priority 90.
   */
  private scoreFrameEvents(): void {
    const events = this.events;
    const count = events.count;
    let gained = 0;

    for (let i = 0; i < count; i++) {
      const type = events.typeAt(i);
      recordRoundEvent(this.stats, type, events.dataAt(i));
      switch (type) {
        case GameEvent.BallImpact:
          // One point award per contact, not per decal — a Splash ball paints
          // nine SplatPainted events off a single BallImpact.
          gained += GAME.scoreWallSplat;
          break;

        case GameEvent.TargetPopped: {
          const multiplier = this.comboTracker.hit(this.gameNowSec());
          gained += popBasePoints(events.dataAt(i)) * multiplier;
          if (this.comboTracker.current !== this.combo.peek()) {
            this.combo.value = this.comboTracker.current;
            // Emitted below, after this loop's count: record it here.
            if (this.comboTracker.current > this.stats.bestCombo) {
              this.stats.bestCombo = this.comboTracker.current;
            }
            // data = the new multiplier.
            this.events.emit(
              GameEvent.ComboMilestone,
              0,
              0,
              0,
              this.comboTracker.current,
            );
          }
          break;
        }

        default:
          break;
      }
    }

    if (gained !== 0) {
      const total = this.score.peek() + gained;
      this.score.value = total;
      this.hudScore.value = total;
    }
  }

  /** A or X on either hand starts a round. The trigger is reserved for firing. */
  private startPressed(): boolean {
    const left = this.input.gamepads.left;
    const right = this.input.gamepads.right;
    return (
      left?.getButtonDown(InputComponent.A_Button) === true ||
      left?.getButtonDown(InputComponent.X_Button) === true ||
      right?.getButtonDown(InputComponent.A_Button) === true ||
      right?.getButtonDown(InputComponent.X_Button) === true
    );
  }

  /**
   * Mirror the session's focus into `paused`, and bank the time spent away.
   *
   * Runs from the visibilityState subscription, i.e. at the top of the frame
   * the change was observed in, before any system's update — so TargetSystem
   * sees the new `paused` on the same frame this system does.
   *
   * The status line is only rewritten in a timed phase. Idle's line is static
   * anyway, and Chill's may be HudSystem's ROTATE CANVAS notice, which is
   * meant to stay up for the rest of the visit and would otherwise be wiped by
   * a trip to the system menu.
   */
  private applyFocus(state: VisibilityState): void {
    const lost = isFocusLost(state);
    const nowSec = performance.now() / 1000;
    if (lost) this.pauseClock.pause(nowSec);
    else this.pauseClock.resume(nowSec);

    if (this.paused.peek() !== lost) this.paused.value = lost;
    if (isTimedPhase(this.gamePhase.peek())) this.refreshStatus();
  }

  /**
   * Seconds on the game clock: performance.now() less every paused second.
   * What the combo window is measured against, so a combo survives the menu.
   */
  private gameNowSec(): number {
    return this.pauseClock.now(performance.now() / 1000);
  }

  /** Write hudTimer only when the displayed second actually changes. */
  private publishTimer(secondsLeft: number): void {
    const whole = Math.max(0, Math.ceil(secondsLeft));
    if (whole === this.lastTimerSecond) return;
    this.lastTimerSecond = whole;
    this.hudTimer.value = formatTimer(secondsLeft);
  }

  /** One line of context under the score, per phase. */
  private refreshStatus(): void {
    const phase = this.gamePhase.peek();
    // A frozen round says so instead of its usual line. The normal copy comes
    // back on its own: applyFocus() calls in here again when focus returns.
    if (this.paused.peek() && isTimedPhase(phase)) {
      this.hudStatus.value = GAME.pausedStatusText;
      return;
    }

    switch (phase) {
      case GamePhase.Countdown:
        // '...', not '…' — the bundled MSDF font has no ellipsis glyph.
        this.hudStatus.value = 'Get ready...';
        break;
      case GamePhase.Playing:
        // Round 9: the Neatnik count has its own pill; coaching tips take
        // this line over for a few seconds (HudSystem).
        this.hudStatus.value = GAME.playingStatusText;
        break;
      case GamePhase.GameOver:
        // ASCII separator: the bundled MSDF font has no em-dash glyph.
        this.hudStatus.value = `Final: ${this.score.peek()} | Best ${this.bestScore.peek()}`;
        break;
      case GamePhase.Chill:
        this.hudStatus.value = CHILL.statusText;
        break;
      default:
        this.hudStatus.value = INITIAL_HUD_STATE.status;
        break;
    }
  }
}
