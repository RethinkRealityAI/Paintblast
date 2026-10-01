import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { signal } from '@preact/signals-core';
import type { Signal } from '@preact/signals-core';
import { VisibilityState } from '@iwsdk/core';
import { GameStateSystem } from '../../src/systems/GameStateSystem';
import { CHILL, GAME } from '../../src/config';
import { GameEvent, GameEventBuffer, GamePhase } from '../../src/types';

/**
 * The real GameStateSystem, wired to real signals, with performance.now()
 * under the test's control. The IWSDK base class is the vitest stub, so the
 * World-facing fields (globals, world, input) are planted by hand — exactly
 * the ones init() and update() read.
 */
interface Harness {
  sys: GameStateSystem;
  visibility: Signal<VisibilityState>;
  globals: {
    gamePhase: Signal<GamePhase>;
    timeLeft: Signal<number>;
    combo: Signal<number>;
    hudStatus: Signal<string>;
    hudTimer: Signal<string>;
    targetsAlive: Signal<number>;
    paused: Signal<boolean>;
    gameEvents: GameEventBuffer;
  } & Record<string, unknown>;
  /** One frame: advance the fake clock, update, then flush like priority 90. */
  frame(delta?: number): void;
  run(seconds: number): void;
}

const FRAME = 1 / 72;
let nowMs = 0;

beforeEach(() => {
  nowMs = 1_000_000;
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function harness(): Harness {
  const visibility = signal<VisibilityState>(VisibilityState.NonImmersive);
  const globals = {
    gamePhase: signal<GamePhase>(GamePhase.Idle),
    score: signal(0),
    bestScore: signal(0),
    combo: signal(1),
    timeLeft: signal<number>(GAME.roundSec),
    targetsAlive: signal(0),
    hudScore: signal(0),
    hudTimer: signal('0:00'),
    hudStatus: signal(''),
    paused: signal(false),
    gameEvents: new GameEventBuffer(),
  };

  const Ctor = GameStateSystem as unknown as new () => GameStateSystem;
  const sys = new Ctor();
  Object.assign(sys as object, {
    globals,
    world: { visibilityState: visibility },
    input: { gamepads: { left: undefined, right: undefined } },
  });
  sys.init();

  const frame = (delta = FRAME) => {
    nowMs += delta * 1000;
    sys.update(delta);
    globals.gameEvents.clear();
  };
  return {
    sys,
    visibility,
    globals,
    frame,
    run(seconds: number) {
      const frames = Math.round(seconds / FRAME);
      for (let i = 0; i < frames; i++) frame();
    },
  };
}

/** Focus changes land at the top of a frame, before any system updates. */
function setVisibility(h: Harness, state: VisibilityState): void {
  h.visibility.value = state;
}

describe('GameStateSystem pause', () => {
  it('starts paused on the landing page and thaws when the session is Visible', () => {
    const h = harness();
    expect(h.globals.paused.value).toBe(true);
    setVisibility(h, VisibilityState.Visible);
    expect(h.globals.paused.value).toBe(false);
  });

  it('freezes Playing on the system menu and resumes with the same time left', () => {
    const h = harness();
    setVisibility(h, VisibilityState.Visible);
    h.frame();
    h.sys.startGame();
    h.run(GAME.countdownSec + 0.1);
    expect(h.globals.gamePhase.value).toBe(GamePhase.Playing);
    h.run(5);

    const left = h.globals.timeLeft.value;
    const timer = h.globals.hudTimer.value;
    const playingStatus = h.globals.hudStatus.value;

    setVisibility(h, VisibilityState.VisibleBlurred);
    expect(h.globals.paused.value).toBe(true);
    expect(h.globals.hudStatus.value).toBe(GAME.pausedStatusText);
    h.run(200); // longer than the whole round
    expect(h.globals.gamePhase.value).toBe(GamePhase.Playing);
    expect(h.globals.timeLeft.value).toBe(left);
    expect(h.globals.hudTimer.value).toBe(timer);

    setVisibility(h, VisibilityState.Visible);
    expect(h.globals.paused.value).toBe(false);
    expect(h.globals.hudStatus.value).toBe(playingStatus);
    h.frame(); // resume frame: discarded
    expect(h.globals.timeLeft.value).toBe(left);
    h.run(1);
    expect(h.globals.timeLeft.value).toBeCloseTo(left - 1, 1);
  });

  it('survives a hidden stall that no visibility change announced', () => {
    const h = harness();
    setVisibility(h, VisibilityState.Visible);
    h.frame();
    h.sys.startGame();
    h.run(GAME.countdownSec + 0.1);
    const left = h.globals.timeLeft.value;

    h.frame(600); // ten minutes with the headset on the desk
    expect(h.globals.gamePhase.value).toBe(GamePhase.Playing);
    expect(h.globals.timeLeft.value).toBe(left);
  });

  it('holds the countdown and emits no ticks while paused', () => {
    const h = harness();
    setVisibility(h, VisibilityState.Visible);
    h.frame();
    h.sys.startGame();
    h.run(0.5);

    setVisibility(h, VisibilityState.Hidden);
    expect(h.globals.hudStatus.value).toBe(GAME.pausedStatusText);
    let ticks = 0;
    for (let i = 0; i < 72 * 10; i++) {
      nowMs += FRAME * 1000;
      h.sys.update(FRAME);
      for (let e = 0; e < h.globals.gameEvents.count; e++) {
        if (h.globals.gameEvents.typeAt(e) === GameEvent.CountdownTick) ticks++;
      }
      h.globals.gameEvents.clear();
    }
    expect(ticks).toBe(0);
    expect(h.globals.gamePhase.value).toBe(GamePhase.Countdown);

    setVisibility(h, VisibilityState.Visible);
    h.run(GAME.countdownSec);
    expect(h.globals.gamePhase.value).toBe(GamePhase.Playing);
  });

  it('pauses when the session ends mid-round and resumes on re-entry', () => {
    const h = harness();
    setVisibility(h, VisibilityState.Visible);
    h.frame();
    h.sys.startGame();
    h.run(GAME.countdownSec + 2);
    const left = h.globals.timeLeft.value;

    setVisibility(h, VisibilityState.NonImmersive);
    h.run(30);
    setVisibility(h, VisibilityState.Visible);
    h.frame();
    expect(h.globals.gamePhase.value).toBe(GamePhase.Playing);
    expect(h.globals.timeLeft.value).toBe(left);
  });

  it('keeps a combo alive through a pause longer than its window', () => {
    const h = harness();
    setVisibility(h, VisibilityState.Visible);
    h.frame();
    h.sys.startGame();
    h.run(GAME.countdownSec + 0.1);

    // Two pops in one frame: x1 then x2, leaving the multiplier at x3.
    h.globals.gameEvents.emit(GameEvent.TargetPopped, 0, 0, 0, 0);
    h.globals.gameEvents.emit(GameEvent.TargetPopped, 0, 0, 0, 1);
    h.frame();
    expect(h.globals.combo.value).toBe(3);

    setVisibility(h, VisibilityState.VisibleBlurred);
    h.run(GAME.comboWindowSec * 5);
    setVisibility(h, VisibilityState.Visible);
    h.frame();
    h.run(GAME.comboWindowSec / 2);
    expect(h.globals.combo.value).toBe(3);

    // The window still runs out on game time once play resumes.
    h.run(GAME.comboWindowSec);
    expect(h.globals.combo.value).toBe(1);
  });

  it('leaves Chill and its status line alone', () => {
    const h = harness();
    setVisibility(h, VisibilityState.Visible);
    h.frame();
    h.sys.startChill();
    expect(h.globals.hudStatus.value).toBe(CHILL.statusText);
    // HudSystem's ROTATE CANVAS notice, meant to stay up for the visit.
    h.globals.hudStatus.value = CHILL.rotatedText;

    setVisibility(h, VisibilityState.VisibleBlurred);
    h.run(2);
    setVisibility(h, VisibilityState.Visible);
    h.run(1);
    expect(h.globals.gamePhase.value).toBe(GamePhase.Chill);
    expect(h.globals.hudStatus.value).toBe(CHILL.rotatedText);
  });

  it('keeps the round-over summary up while away', () => {
    const h = harness();
    setVisibility(h, VisibilityState.Visible);
    h.frame();
    h.sys.startGame();
    h.run(GAME.countdownSec + 0.1);
    h.sys.endRound();
    expect(h.globals.gamePhase.value).toBe(GamePhase.GameOver);

    setVisibility(h, VisibilityState.VisibleBlurred);
    h.run(GAME.gameOverSec * 3);
    expect(h.globals.gamePhase.value).toBe(GamePhase.GameOver);

    setVisibility(h, VisibilityState.Visible);
    h.run(GAME.gameOverSec + 0.2);
    expect(h.globals.gamePhase.value).toBe(GamePhase.Idle);
  });
});
