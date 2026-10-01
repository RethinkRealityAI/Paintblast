import { describe, it, expect } from 'vitest';
import {
  ComboTracker,
  advancePhase,
  createPhaseTick,
  formatTimer,
} from '../../src/systems/GameStateSystem';
import type { PhaseTick, PhaseTimings } from '../../src/systems/GameStateSystem';
import { GAME } from '../../src/config';
import { GamePhase } from '../../src/types';

/** Short, exact durations keep the frame-by-frame tests cheap and readable. */
const CFG: PhaseTimings = { countdownSec: 3, roundSec: 5, gameOverSec: 2 };

/** Mirrors what GameStateSystem.update() does with a PhaseTick, minus signals. */
class PhaseDriver {
  phase: GamePhase = GamePhase.Idle;
  phaseElapsed = 0;
  timeLeft = CFG.roundSec;
  readonly ticks: number[] = [];
  readonly transitions: GamePhase[] = [];

  private readonly out: PhaseTick = createPhaseTick();

  constructor(private readonly cfg: PhaseTimings = CFG) {}

  /** Enter Countdown the way startGame() does. */
  start(): void {
    this.phase = GamePhase.Countdown;
    this.phaseElapsed = 0;
    this.timeLeft = this.cfg.roundSec;
    this.ticks.push(Math.ceil(this.cfg.countdownSec));
  }

  /** Enter Chill the way startChill() does — Idle only, no clock touched. */
  startChill(): boolean {
    if (this.phase !== GamePhase.Idle) return false;
    this.phase = GamePhase.Chill;
    this.phaseElapsed = 0;
    return true;
  }

  /** Leave Chill the way exitChill() does — rearms the round clock. */
  exitChill(): boolean {
    if (this.phase !== GamePhase.Chill) return false;
    this.phase = GamePhase.Idle;
    this.phaseElapsed = 0;
    this.timeLeft = this.cfg.roundSec;
    return true;
  }

  step(delta: number): void {
    advancePhase(
      this.phase,
      this.phaseElapsed,
      this.timeLeft,
      delta,
      this.cfg,
      this.out,
    );
    this.phaseElapsed = this.out.phaseElapsed;
    this.timeLeft = this.out.timeLeft;
    if (this.out.countdownTick > 0) this.ticks.push(this.out.countdownTick);
    if (this.out.changed) {
      this.phase = this.out.phase;
      this.transitions.push(this.out.phase);
    }
  }

  run(seconds: number, delta: number): void {
    const frames = Math.round(seconds / delta);
    for (let i = 0; i < frames; i++) this.step(delta);
  }
}

describe('advancePhase', () => {
  it('leaves Idle alone no matter how long it runs', () => {
    const out = createPhaseTick();
    advancePhase(GamePhase.Idle, 12, CFG.roundSec, 1, CFG, out);

    expect(out.phase).toBe(GamePhase.Idle);
    expect(out.changed).toBe(false);
    expect(out.countdownTick).toBe(0);
    expect(out.timeLeft).toBe(CFG.roundSec);
    expect(out.phaseElapsed).toBe(13);
  });

  it('ticks the countdown on integer crossings only', () => {
    const out = createPhaseTick();

    // 0.0 → 0.5 s: still "3 to go", no tick.
    advancePhase(GamePhase.Countdown, 0, 0, 0.5, CFG, out);
    expect(out.countdownTick).toBe(0);

    // 0.5 → 1.0 s: crosses into "2 to go".
    advancePhase(GamePhase.Countdown, 0.5, 0, 0.5, CFG, out);
    expect(out.countdownTick).toBe(2);

    // 1.5 → 2.0 s: crosses into "1 to go".
    advancePhase(GamePhase.Countdown, 1.5, 0, 0.5, CFG, out);
    expect(out.countdownTick).toBe(1);
  });

  it('never emits a zero tick on the frame the round starts', () => {
    const out = createPhaseTick();
    advancePhase(GamePhase.Countdown, 2.5, 0, 0.5, CFG, out);

    expect(out.countdownTick).toBe(0);
    expect(out.phase).toBe(GamePhase.Playing);
  });

  it('starts the round clock when the countdown expires', () => {
    const out = createPhaseTick();
    advancePhase(GamePhase.Countdown, 2.9, 0, 0.2, CFG, out);

    expect(out.phase).toBe(GamePhase.Playing);
    expect(out.changed).toBe(true);
    expect(out.phaseElapsed).toBe(0);
    expect(out.timeLeft).toBe(CFG.roundSec);
  });

  it('burns down the round clock without changing phase', () => {
    const out = createPhaseTick();
    advancePhase(GamePhase.Playing, 1, 5, 0.25, CFG, out);

    expect(out.phase).toBe(GamePhase.Playing);
    expect(out.changed).toBe(false);
    expect(out.timeLeft).toBeCloseTo(4.75, 6);
  });

  it('ends the round at zero and never reports negative time', () => {
    const out = createPhaseTick();
    advancePhase(GamePhase.Playing, 5, 0.1, 0.4, CFG, out);

    expect(out.phase).toBe(GamePhase.GameOver);
    expect(out.changed).toBe(true);
    expect(out.timeLeft).toBe(0);
    expect(out.phaseElapsed).toBe(0);
  });

  it('returns to Idle after the summary and rearms the clock', () => {
    const out = createPhaseTick();

    advancePhase(GamePhase.GameOver, 1, 0, 0.5, CFG, out);
    expect(out.phase).toBe(GamePhase.GameOver);
    expect(out.changed).toBe(false);

    advancePhase(GamePhase.GameOver, 1.8, 0, 0.5, CFG, out);
    expect(out.phase).toBe(GamePhase.Idle);
    expect(out.changed).toBe(true);
    expect(out.timeLeft).toBe(CFG.roundSec);
  });

  it('reuses the caller-owned out object rather than allocating', () => {
    const out = createPhaseTick();
    const before = out;
    advancePhase(GamePhase.Playing, 0, 5, 1, CFG, out);
    expect(out).toBe(before);
  });
});

describe('the full round cycle at 60 FPS', () => {
  const DELTA = 1 / 60;

  it('walks Countdown → Playing → GameOver → Idle on the configured timings', () => {
    const driver = new PhaseDriver();
    driver.start();

    const seen: Array<{ phase: GamePhase; at: number }> = [];
    let previous = driver.phase;
    let elapsed = 0;
    const frames = Math.round(
      (CFG.countdownSec + CFG.roundSec + CFG.gameOverSec + 1) / DELTA,
    );

    for (let frame = 0; frame < frames; frame++) {
      driver.step(DELTA);
      elapsed += DELTA;
      if (driver.phase !== previous) {
        seen.push({ phase: driver.phase, at: elapsed });
        previous = driver.phase;
      }
    }

    expect(seen.map((entry) => entry.phase)).toEqual([
      GamePhase.Playing,
      GamePhase.GameOver,
      GamePhase.Idle,
    ]);

    // advancePhase resets phaseElapsed to 0 on a transition rather than
    // carrying the overshoot, so each phase can run up to one frame long and
    // the error accumulates across the cycle. Budget a frame per boundary
    // crossed (plus one for float accumulation) rather than a flat epsilon.
    const boundaries = [
      CFG.countdownSec,
      CFG.countdownSec + CFG.roundSec,
      CFG.countdownSec + CFG.roundSec + CFG.gameOverSec,
    ];
    boundaries.forEach((nominal, index) => {
      expect(Math.abs(seen[index].at - nominal)).toBeLessThanOrEqual(
        (index + 2) * DELTA,
      );
    });

    // Back in Idle the clock is rearmed for the next round.
    expect(driver.timeLeft).toBe(CFG.roundSec);
  });

  it('counts down exactly once per second, high to low', () => {
    const driver = new PhaseDriver();
    driver.start();
    driver.run(3.2, DELTA);

    expect(driver.ticks).toEqual([3, 2, 1]);
  });

  it('does not restart itself once it is back in Idle', () => {
    const driver = new PhaseDriver();
    driver.start();
    driver.run(20, DELTA);

    expect(driver.phase).toBe(GamePhase.Idle);
    expect(driver.transitions).toHaveLength(3);
  });

  it('handles a giant delta (a backgrounded tab) without skipping a phase', () => {
    const driver = new PhaseDriver();
    driver.start();

    driver.step(60);
    expect(driver.phase).toBe(GamePhase.Playing);
    driver.step(60);
    expect(driver.phase).toBe(GamePhase.GameOver);
    driver.step(60);
    expect(driver.phase).toBe(GamePhase.Idle);
  });
});

describe('Chill mode', () => {
  const DELTA = 1 / 60;

  it('is a distinct phase, not an alias for Idle', () => {
    expect(GamePhase.Chill).not.toBe(GamePhase.Idle);
    expect(GamePhase.Chill).not.toBe(GamePhase.Playing);
  });

  it('never leaves on its own, however long it runs', () => {
    const out = createPhaseTick();
    advancePhase(GamePhase.Chill, 900, CFG.roundSec, 1, CFG, out);

    expect(out.phase).toBe(GamePhase.Chill);
    expect(out.changed).toBe(false);
    expect(out.countdownTick).toBe(0);
    expect(out.phaseElapsed).toBe(901);
  });

  it('freezes the round clock — there is no timer in Chill', () => {
    const out = createPhaseTick();
    advancePhase(GamePhase.Chill, 0, CFG.roundSec, 10, CFG, out);
    expect(out.timeLeft).toBe(CFG.roundSec);

    // Even entered with a part-spent clock, Chill burns none of it.
    advancePhase(GamePhase.Chill, 0, 1.25, 10, CFG, out);
    expect(out.timeLeft).toBe(1.25);
  });

  it('enters from Idle and leaves back to Idle with the clock rearmed', () => {
    const driver = new PhaseDriver();

    expect(driver.startChill()).toBe(true);
    expect(driver.phase).toBe(GamePhase.Chill);

    driver.timeLeft = 2;
    driver.run(30, DELTA);
    expect(driver.phase).toBe(GamePhase.Chill);
    expect(driver.timeLeft).toBe(2);
    expect(driver.transitions).toHaveLength(0);

    expect(driver.exitChill()).toBe(true);
    expect(driver.phase).toBe(GamePhase.Idle);
    expect(driver.timeLeft).toBe(CFG.roundSec);
  });

  it('cannot be entered mid-round or exited when you are not in it', () => {
    const driver = new PhaseDriver();
    expect(driver.exitChill()).toBe(false);

    driver.start();
    expect(driver.startChill()).toBe(false);
    expect(driver.phase).toBe(GamePhase.Countdown);

    driver.run(4, DELTA);
    expect(driver.phase).toBe(GamePhase.Playing);
    expect(driver.startChill()).toBe(false);
  });

  it('still runs a full round after a chill session', () => {
    const driver = new PhaseDriver();
    driver.startChill();
    driver.run(5, DELTA);
    driver.exitChill();

    driver.start();
    driver.run(20, DELTA);
    expect(driver.phase).toBe(GamePhase.Idle);
    expect(driver.transitions).toEqual([
      GamePhase.Playing,
      GamePhase.GameOver,
      GamePhase.Idle,
    ]);
  });
});

describe('ComboTracker', () => {
  it('starts cold at ×1', () => {
    const combo = new ComboTracker(GAME.comboWindowSec, GAME.comboCap);
    expect(combo.current).toBe(1);
    expect(combo.expired(0)).toBe(false);
    expect(combo.expired(1e6)).toBe(false);
  });

  it('scores the first pop at ×1 and arms the next one', () => {
    const combo = new ComboTracker(3, 5);
    expect(combo.hit(10)).toBe(1);
    expect(combo.current).toBe(2);
    expect(combo.lastHitSec).toBe(10);
  });

  it('climbs one step per pop inside the window', () => {
    const combo = new ComboTracker(3, 5);
    expect(combo.hit(0)).toBe(1);
    expect(combo.hit(1)).toBe(2);
    expect(combo.hit(2)).toBe(3);
    expect(combo.current).toBe(4);
  });

  it('stops climbing at the cap but keeps refreshing the window', () => {
    const combo = new ComboTracker(3, 3);
    combo.hit(0);
    combo.hit(0.5);
    combo.hit(1);
    expect(combo.current).toBe(3);

    expect(combo.hit(1.5)).toBe(3);
    expect(combo.current).toBe(3);
    expect(combo.lastHitSec).toBe(1.5);
  });

  it('never drops below ×1 for a cap under one', () => {
    const combo = new ComboTracker(3, 0);
    expect(combo.cap).toBe(1);
    expect(combo.hit(0)).toBe(1);
    expect(combo.current).toBe(1);
  });

  it('expires only after the window fully lapses', () => {
    const combo = new ComboTracker(3, 5);
    combo.hit(10);

    expect(combo.expired(12.9)).toBe(false);
    expect(combo.expired(13)).toBe(false);
    expect(combo.expired(13.01)).toBe(true);
  });

  it('decays back to ×1 exactly once', () => {
    const combo = new ComboTracker(3, 5);
    combo.hit(0);
    combo.hit(1);
    expect(combo.current).toBe(3);

    expect(combo.decay(2)).toBe(false);
    expect(combo.current).toBe(3);

    expect(combo.decay(5)).toBe(true);
    expect(combo.current).toBe(1);
    expect(combo.decay(9)).toBe(false);
  });

  it('reset() clears both the multiplier and the window', () => {
    const combo = new ComboTracker(3, 5);
    combo.hit(100);
    combo.reset();

    expect(combo.current).toBe(1);
    expect(combo.expired(1000)).toBe(false);
  });
});

describe('formatTimer', () => {
  it('formats the canonical round lengths', () => {
    expect(formatTimer(90)).toBe('1:30');
    expect(formatTimer(5)).toBe('0:05');
    expect(formatTimer(0)).toBe('0:00');
  });

  it('always pads seconds to two digits', () => {
    expect(formatTimer(61)).toBe('1:01');
    expect(formatTimer(70)).toBe('1:10');
    expect(formatTimer(125)).toBe('2:05');
    expect(formatTimer(600)).toBe('10:00');
  });

  it('rounds up so 0:00 only shows when the round is actually over', () => {
    expect(formatTimer(0.2)).toBe('0:01');
    expect(formatTimer(59.2)).toBe('1:00');
    expect(formatTimer(89.999)).toBe('1:30');
  });

  it('clamps negatives to 0:00', () => {
    expect(formatTimer(-0.5)).toBe('0:00');
    expect(formatTimer(-100)).toBe('0:00');
  });

  it('renders the shipped round length', () => {
    expect(formatTimer(GAME.roundSec)).toMatch(/^\d+:\d{2}$/);
  });
});
