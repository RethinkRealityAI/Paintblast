import { InputComponent, createSystem } from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import { CHILL, GAME } from '../config';
import {
  GameEvent,
  GameEventBuffer,
  GamePhase,
  INITIAL_HUD_STATE,
} from '../types';

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
 * Writes `gamePhase`, `score`, `bestScore`, `combo`, `timeLeft` and the three
 * HUD strings (`hudScore`, `hudTimer`, `hudStatus`); reads `targetsAlive`.
 *
 * Runs at priority 30, i.e. after every event producer (BallFlightSystem at
 * 12, TargetSystem at 14) and before EventFlushSystem at 90, so scoring sees
 * a complete frame of events exactly once.
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

  private comboTracker!: ComboTracker;
  private tick!: PhaseTick;

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

    this.comboTracker = new ComboTracker(GAME.comboWindowSec, GAME.comboCap);
    this.tick = createPhaseTick();

    this.bestScore.value = readBestScore();

    // The Playing status line quotes targetsAlive, so rebuild it when robots
    // spawn or pop rather than re-deriving the string every frame.
    this.cleanupFuncs.push(this.targetsAlive.subscribe(() => this.refreshStatus()));

    this.hudScore.value = this.score.peek();
    this.publishTimer(this.timeLeft.peek());
    this.refreshStatus();
  }

  update(delta: number) {
    const phase = this.gamePhase.peek();

    if (
      (phase === GamePhase.Idle || phase === GamePhase.GameOver) &&
      this.startPressed()
    ) {
      this.startGame();
      return;
    }

    if (phase === GamePhase.Playing) {
      this.scoreFrameEvents();
      if (this.comboTracker.decay(performance.now() / 1000)) {
        this.combo.value = this.comboTracker.current;
      }
    }

    advancePhase(
      phase,
      this.phaseElapsed,
      this.timeLeft.peek(),
      delta,
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
   * Cut the round short and go straight to the summary. Valid from Countdown
   * or Playing; a no-op anywhere else.
   */
  endRound(): void {
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
      switch (events.typeAt(i)) {
        case GameEvent.BallImpact:
          // One point award per contact, not per decal — a Splash ball paints
          // nine SplatPainted events off a single BallImpact.
          gained += GAME.scoreWallSplat;
          break;

        case GameEvent.TargetPopped: {
          const multiplier = this.comboTracker.hit(performance.now() / 1000);
          gained += GAME.scoreTargetHit * multiplier;
          if (this.comboTracker.current !== this.combo.peek()) {
            this.combo.value = this.comboTracker.current;
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

  /** Write hudTimer only when the displayed second actually changes. */
  private publishTimer(secondsLeft: number): void {
    const whole = Math.max(0, Math.ceil(secondsLeft));
    if (whole === this.lastTimerSecond) return;
    this.lastTimerSecond = whole;
    this.hudTimer.value = formatTimer(secondsLeft);
  }

  /** One line of context under the score, per phase. */
  private refreshStatus(): void {
    switch (this.gamePhase.peek()) {
      case GamePhase.Countdown:
        // '...', not '…' — the bundled MSDF font has no ellipsis glyph.
        this.hudStatus.value = 'Get ready...';
        break;
      case GamePhase.Playing:
        this.hudStatus.value = `${this.targetsAlive.peek()} bots active`;
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
