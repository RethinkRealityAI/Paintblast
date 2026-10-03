import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { signal } from '@preact/signals-core';
import { VisibilityState } from '@iwsdk/core';
import { GameStateSystem } from '../../src/systems/GameStateSystem';
import { GAME } from '../../src/config';
import {
  GameEvent,
  GameEventBuffer,
  GamePhase,
  Neatnik,
  packPopData,
} from '../../src/types';
import type { RoundStats } from '../../src/types';

/**
 * Round 9: the tutorial's practice round (Playing with the clock held) and
 * the GameOver results snapshot, on the real GameStateSystem. Same harness
 * shape as game-state-pause.test.ts.
 */

const FRAME = 1 / 72;
let nowMs = 0;

beforeEach(() => {
  nowMs = 1_000_000;
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  globalThis.localStorage?.clear?.();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function harness() {
  const visibility = signal<VisibilityState>(VisibilityState.Visible);
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
    practice: signal(false),
    roundStats: signal<RoundStats | null>(null),
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
  const frame = (emit?: (b: GameEventBuffer) => void) => {
    nowMs += FRAME * 1000;
    emit?.(globals.gameEvents);
    sys.update(FRAME);
    globals.gameEvents.clear();
  };
  const run = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds / FRAME); i++) frame();
  };
  return { sys, globals, frame, run };
}

describe('practice round', () => {
  it('is Playing with a frozen clock, no score, and no RoundStart', () => {
    const h = harness();
    expect(h.sys.startPractice()).toBe(true);
    expect(h.globals.gamePhase.value).toBe(GamePhase.Playing);
    expect(h.globals.practice.value).toBe(true);
    expect(h.sys.inPractice).toBe(true);

    let roundStarts = 0;
    h.frame((b) => {
      b.emit(GameEvent.TargetPopped, 0, 0, 0, packPopData(0, Neatnik.Mopsy, 100));
    });
    for (let i = 0; i < 72 * 120; i++) {
      h.frame();
      for (let e = 0; e < h.globals.gameEvents.count; e++) {
        if (h.globals.gameEvents.typeAt(e) === GameEvent.RoundStart) roundStarts++;
      }
    }
    expect(h.globals.timeLeft.value).toBe(GAME.roundSec);
    expect(h.globals.gamePhase.value).toBe(GamePhase.Playing);
    expect(h.globals.score.value).toBe(0);
    expect(roundStarts).toBe(0);
  });

  it('only starts from the title', () => {
    const h = harness();
    h.sys.startGame();
    expect(h.sys.startPractice()).toBe(false);
    expect(h.globals.practice.value).toBe(false);
  });

  it('endPractice (and endRound) go back to the title, no results card', () => {
    const h = harness();
    h.sys.startPractice();
    h.sys.endPractice();
    expect(h.globals.gamePhase.value).toBe(GamePhase.Idle);
    expect(h.globals.practice.value).toBe(false);
    expect(h.globals.roundStats.value).toBeNull();

    h.sys.startPractice();
    h.sys.endRound();
    expect(h.globals.gamePhase.value).toBe(GamePhase.Idle);
    expect(h.globals.practice.value).toBe(false);
    expect(h.globals.roundStats.value).toBeNull();
  });

  it('a phase change from elsewhere ends the practice', () => {
    const h = harness();
    h.sys.startPractice();
    h.globals.gamePhase.value = GamePhase.Idle;
    h.frame();
    expect(h.sys.inPractice).toBe(false);
    expect(h.globals.practice.value).toBe(false);
  });
});

describe('results snapshot', () => {
  it('publishes pops, shots, hits and best combo at GameOver', () => {
    const h = harness();
    h.globals.bestScore.value = 50;
    h.sys.startGame();
    h.run(GAME.countdownSec + 0.1);
    expect(h.globals.gamePhase.value).toBe(GamePhase.Playing);
    h.frame((b) => {
      for (let i = 0; i < 4; i++) b.emit(GameEvent.BallFired, 0, 0, 0, 0);
      b.emit(GameEvent.TargetHit, 0, 0, 0, 0);
      b.emit(GameEvent.TargetPopped, 0, 0, 0, packPopData(0, Neatnik.Mopsy, 100));
      b.emit(GameEvent.TargetHit, 0, 0, 0, 0);
      b.emit(GameEvent.TargetPopped, 0, 0, 0, packPopData(8, Neatnik.Squeegee, 150));
    });
    h.sys.endRound();
    const stats = h.globals.roundStats.value;
    expect(stats).not.toBeNull();
    expect(stats!.shots).toBe(4);
    expect(stats!.hits).toBe(2);
    expect(stats!.pops).toEqual([1, 1, 0, 0]);
    expect(stats!.bestCombo).toBe(3);
    expect(stats!.bestBefore).toBe(50);
    expect(stats!.score).toBe(h.globals.score.value);
    expect(stats!.score).toBeGreaterThan(50);

    // The next round starts clean and does not touch the published card.
    h.sys.startGame();
    expect(h.globals.roundStats.value!.shots).toBe(4);
  });

  it('the live status line names the Neatniks, not "bots"', () => {
    const h = harness();
    h.sys.startGame();
    h.run(GAME.countdownSec + 0.1);
    expect(h.globals.hudStatus.value).toBe(GAME.playingStatusText);
    expect(h.globals.hudStatus.value).not.toMatch(/bots/);
  });
});
