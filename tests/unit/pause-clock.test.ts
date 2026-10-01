import { describe, it, expect } from 'vitest';
import { VisibilityState } from '@iwsdk/core';
import {
  ComboTracker,
  PauseClock,
  advancePhase,
  createPhaseTick,
  isFocusLost,
  isTimedPhase,
} from '../../src/systems/GameStateSystem';
import type { PhaseTimings } from '../../src/systems/GameStateSystem';
import { GAME } from '../../src/config';
import { GamePhase } from '../../src/types';

const FRAME = 1 / 72;
const GAP = 0.5;

/** Short, exact durations keep the frame-by-frame tests cheap and readable. */
const CFG: PhaseTimings = { countdownSec: 3, roundSec: 10, gameOverSec: 2 };

/**
 * Mirrors the clock half of GameStateSystem.update(): one consumeFrame() per
 * frame, nothing advances while paused, and advancePhase() only ever sees the
 * budget the PauseClock hands out. `wall` is the injected performance.now().
 */
class PausableRound {
  wall = 100;
  phase: GamePhase = GamePhase.Countdown;
  phaseElapsed = 0;
  timeLeft = CFG.roundSec;
  paused = false;
  readonly ticks: number[] = [];
  readonly clock = new PauseClock(GAP);
  readonly combo = new ComboTracker(GAME.comboWindowSec, GAME.comboCap);
  private readonly out = createPhaseTick();

  /** The visibility subscription: fires at the top of a frame. */
  setFocus(lost: boolean): void {
    if (lost) this.clock.pause(this.wall);
    else this.clock.resume(this.wall);
    this.paused = lost;
  }

  frame(delta = FRAME): void {
    this.wall += delta;
    const step = this.clock.consumeFrame(delta);
    if (this.paused) return;
    advancePhase(
      this.phase,
      this.phaseElapsed,
      this.timeLeft,
      step,
      CFG,
      this.out,
    );
    this.phaseElapsed = this.out.phaseElapsed;
    this.timeLeft = this.out.timeLeft;
    if (this.out.countdownTick > 0) this.ticks.push(this.out.countdownTick);
    if (this.out.changed) this.phase = this.out.phase;
  }

  run(seconds: number, delta = FRAME): void {
    const frames = Math.round(seconds / delta);
    for (let i = 0; i < frames; i++) this.frame(delta);
  }

  gameNow(): number {
    return this.clock.now(this.wall);
  }
}

describe('isFocusLost', () => {
  it('treats only Visible as in focus', () => {
    expect(isFocusLost(VisibilityState.Visible)).toBe(false);
    expect(isFocusLost(VisibilityState.VisibleBlurred)).toBe(true);
    expect(isFocusLost(VisibilityState.Hidden)).toBe(true);
    expect(isFocusLost(VisibilityState.NonImmersive)).toBe(true);
  });
});

describe('isTimedPhase', () => {
  it('freezes the three phases that run on a clock, and nothing else', () => {
    expect(isTimedPhase(GamePhase.Countdown)).toBe(true);
    expect(isTimedPhase(GamePhase.Playing)).toBe(true);
    expect(isTimedPhase(GamePhase.GameOver)).toBe(true);
    expect(isTimedPhase(GamePhase.Idle)).toBe(false);
    expect(isTimedPhase(GamePhase.Chill)).toBe(false);
  });
});

describe('PauseClock', () => {
  it('runs at wall-clock speed when never paused', () => {
    const clock = new PauseClock(GAP);
    expect(clock.paused).toBe(false);
    expect(clock.now(12.5)).toBe(12.5);
    expect(clock.consumeFrame(FRAME)).toBe(FRAME);
    expect(clock.pausedTotalSec).toBe(0);
  });

  it('stands still while paused and carries on seamlessly after', () => {
    const clock = new PauseClock(GAP);
    expect(clock.now(10)).toBe(10);

    clock.pause(10);
    expect(clock.paused).toBe(true);
    expect(clock.now(10)).toBe(10);
    expect(clock.now(25)).toBe(10);
    expect(clock.now(70)).toBe(10);

    expect(clock.resume(70)).toBe(60);
    expect(clock.paused).toBe(false);
    expect(clock.pausedTotalSec).toBe(60);
    // Continuous at the seam, then wall-clock speed again.
    expect(clock.now(70)).toBe(10);
    expect(clock.now(71.5)).toBeCloseTo(11.5, 10);
  });

  it('accumulates several pauses', () => {
    const clock = new PauseClock(GAP);
    clock.pause(1);
    clock.resume(4); // 3 s
    clock.pause(10);
    clock.resume(10.5); // 0.5 s
    expect(clock.pausedTotalSec).toBeCloseTo(3.5, 10);
    expect(clock.now(20)).toBeCloseTo(16.5, 10);
  });

  it('is idempotent in both directions', () => {
    const clock = new PauseClock(GAP);
    expect(clock.resume(5)).toBe(0);
    expect(clock.pausedTotalSec).toBe(0);

    clock.pause(5);
    clock.pause(8); // must not move the pause start
    expect(clock.resume(9)).toBe(4);
    expect(clock.resume(30)).toBe(0);
    expect(clock.pausedTotalSec).toBe(4);
  });

  it('never banks a negative span from an out-of-order clock', () => {
    const clock = new PauseClock(GAP);
    clock.pause(10);
    expect(clock.resume(9)).toBe(0);
    expect(clock.pausedTotalSec).toBe(0);
  });

  it('hands out no frame budget while paused', () => {
    const clock = new PauseClock(GAP);
    clock.pause(0);
    for (let i = 0; i < 10; i++) expect(clock.consumeFrame(FRAME)).toBe(0);
  });

  it('discards exactly one frame after a resume', () => {
    const clock = new PauseClock(GAP);
    clock.pause(0);
    clock.resume(30);
    // The resume frame's delta spans the whole pause — even a huge one must
    // not be double-banked as a stall on top of what resume() already banked.
    expect(clock.consumeFrame(30)).toBe(0);
    expect(clock.pausedTotalSec).toBe(30);
    expect(clock.consumeFrame(FRAME)).toBe(FRAME);
  });

  it('treats an unannounced stall as paused time', () => {
    const clock = new PauseClock(GAP);
    const before = clock.now(50);
    // No pause() at all: the session went hidden, frames stopped, and the
    // first frame back arrives 42 s late.
    expect(clock.consumeFrame(42)).toBe(0);
    expect(clock.pausedTotalSec).toBe(42);
    expect(clock.now(92)).toBe(before);
  });

  it('lets a hitch below the gap count as play time', () => {
    const clock = new PauseClock(GAP);
    expect(clock.consumeFrame(GAP)).toBe(GAP);
    expect(clock.consumeFrame(0.3)).toBe(0.3);
    expect(clock.pausedTotalSec).toBe(0);
  });

  it('rejects nonsense deltas', () => {
    const clock = new PauseClock(GAP);
    expect(clock.consumeFrame(0)).toBe(0);
    expect(clock.consumeFrame(-1)).toBe(0);
    expect(clock.consumeFrame(Number.NaN)).toBe(0);
    expect(clock.pausedTotalSec).toBe(0);
  });

  it('defaults its gap to GAME.pauseGapSec', () => {
    expect(new PauseClock().gapSec).toBe(GAME.pauseGapSec);
  });
});

describe('a paused round', () => {
  it('resumes Playing with exactly the time it had left', () => {
    const round = new PausableRound();
    round.run(CFG.countdownSec + 0.05);
    expect(round.phase).toBe(GamePhase.Playing);

    round.run(4);
    const left = round.timeLeft;

    round.setFocus(true);
    round.run(120); // two minutes in the system menu
    expect(round.timeLeft).toBe(left);
    expect(round.phase).toBe(GamePhase.Playing);

    round.setFocus(false);
    round.frame(); // the resume frame: spent, not played
    expect(round.timeLeft).toBe(left);
    round.frame();
    expect(round.timeLeft).toBeCloseTo(left - FRAME, 9);
  });

  it('holds the countdown on its current number', () => {
    const round = new PausableRound();
    round.run(1.5);
    const ticks = round.ticks.length;
    const elapsed = round.phaseElapsed;

    round.setFocus(true);
    round.run(10);
    expect(round.phase).toBe(GamePhase.Countdown);
    expect(round.phaseElapsed).toBe(elapsed);
    expect(round.ticks.length).toBe(ticks);

    round.setFocus(false);
    round.run(CFG.countdownSec - elapsed + 0.1);
    expect(round.phase).toBe(GamePhase.Playing);
  });

  it('keeps the game-over summary up while away', () => {
    const round = new PausableRound();
    round.run(CFG.countdownSec + CFG.roundSec + 0.2);
    expect(round.phase).toBe(GamePhase.GameOver);

    round.setFocus(true);
    round.run(CFG.gameOverSec * 5);
    expect(round.phase).toBe(GamePhase.GameOver);

    round.setFocus(false);
    round.run(CFG.gameOverSec + 0.1);
    expect(round.phase).toBe(GamePhase.Idle);
  });

  it('does not let a long hidden stall eat the round', () => {
    const round = new PausableRound();
    round.run(CFG.countdownSec + 0.05);
    round.run(2);
    const left = round.timeLeft;

    // Hidden sessions get no frames, so no visibility change is ever seen:
    // just one enormous delta.
    round.frame(300);
    expect(round.phase).toBe(GamePhase.Playing);
    expect(round.timeLeft).toBe(left);
  });

  it('keeps a combo alive across a pause longer than its window', () => {
    const round = new PausableRound();
    round.run(CFG.countdownSec + 0.05);

    round.combo.hit(round.gameNow());
    round.combo.hit(round.gameNow());
    expect(round.combo.current).toBe(3);

    round.run(GAME.comboWindowSec / 2);
    round.setFocus(true);
    round.run(GAME.comboWindowSec * 10);
    expect(round.combo.expired(round.gameNow())).toBe(false);

    round.setFocus(false);
    round.frame();
    expect(round.combo.decay(round.gameNow())).toBe(false);
    expect(round.combo.current).toBe(3);

    // ...and the window still lapses on the game clock once play resumes.
    round.run(GAME.comboWindowSec);
    expect(round.combo.decay(round.gameNow())).toBe(true);
    expect(round.combo.current).toBe(1);
  });
});

describe('pause config', () => {
  it('keeps the paused status line ASCII (the MSDF font has no typographic glyphs)', () => {
    expect(/^[\x20-\x7e]+$/.test(GAME.pausedStatusText)).toBe(true);
    expect(GAME.pausedStatusText.toLowerCase()).toContain('paused');
  });

  it('sets the stall gap well above a frame and below a real absence', () => {
    expect(GAME.pauseGapSec).toBeGreaterThan(0.1);
    expect(GAME.pauseGapSec).toBeLessThanOrEqual(2);
  });
});
