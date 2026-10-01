import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { signal } from '@preact/signals-core';
import {
  TargetSystem,
  rewindPhase,
  shiftTimestamps,
} from '../../src/systems/TargetSystem';
import { PauseClock } from '../../src/systems/GameStateSystem';
import { TARGETS } from '../../src/config';
import { GameEventBuffer, GamePhase } from '../../src/types';

describe('shiftTimestamps', () => {
  it('moves every set deadline forward by the paused span', () => {
    const stamps = Float64Array.from([10, 0, 12.5, 0, 3]);
    shiftTimestamps(stamps, 7);
    expect(Array.from(stamps)).toEqual([17, 0, 19.5, 0, 10]);
  });

  it('leaves unset (0) slots alone so idle slots gain no phantom deadline', () => {
    const stamps = new Float64Array(8);
    shiftTimestamps(stamps, 42);
    expect(Array.from(stamps)).toEqual(new Array(8).fill(0));
  });

  it('ignores a zero, negative or NaN span', () => {
    const stamps = Float64Array.from([5, 6]);
    shiftTimestamps(stamps, 0);
    shiftTimestamps(stamps, -3);
    shiftTimestamps(stamps, Number.NaN);
    expect(Array.from(stamps)).toEqual([5, 6]);
  });

  it('preserves time-to-deadline exactly across a pause', () => {
    // A robot popped at t=100 with a 1.5 s respawn, frozen at t=100.4 with
    // 1.1 s to go, away for 90 s.
    const pausedAt = 100.4;
    const respawnAt = Float64Array.from([100 + TARGETS.respawnDelaySec]);
    const remainingBefore = respawnAt[0] - pausedAt;

    const away = 90;
    shiftTimestamps(respawnAt, away);
    const resumedAt = pausedAt + away;
    expect(respawnAt[0] - resumedAt).toBeCloseTo(remainingBefore, 9);
  });

  it('allocates nothing and returns nothing', () => {
    const stamps = Float64Array.from([1, 2, 3]);
    const result = shiftTimestamps(stamps, 1) as unknown;
    expect(result).toBeUndefined();
    expect(stamps).toBeInstanceOf(Float64Array);
  });
});

describe('rewindPhase', () => {
  const omega = TARGETS.bobHz * Math.PI * 2;

  it('makes the bob continue from where it froze', () => {
    for (const phase of [0, 0.7, Math.PI, 5.9]) {
      for (const paused of [0.01, 1, 13.37, 600]) {
        const frozeAt = 250.25;
        const before = Math.sin(frozeAt * omega + phase);
        const after = Math.sin(
          (frozeAt + paused) * omega + rewindPhase(phase, paused, omega),
        );
        expect(after).toBeCloseTo(before, 6);
      }
    }
  });

  it('keeps the phase wrapped into [0, 2pi)', () => {
    for (const paused of [0, 0.3, 7, 1e5]) {
      const next = rewindPhase(1, paused, omega);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThan(Math.PI * 2);
    }
  });

  it('is a no-op for a zero-length pause', () => {
    expect(rewindPhase(1.25, 0, omega)).toBeCloseTo(1.25, 12);
  });
});

/** PauseClock.sync is TargetSystem's whole per-frame pause protocol. */
describe('PauseClock.sync (the TargetSystem pause guard)', () => {
  const frame = 1 / 72;

  it('reports nothing to shift on ordinary frames', () => {
    const clock = new PauseClock(0.5);
    let now = 10;
    for (let i = 0; i < 100; i++) {
      now += frame;
      expect(clock.sync(false, now, frame)).toBe(0);
    }
  });

  it('reports nothing while still paused', () => {
    const clock = new PauseClock(0.5);
    expect(clock.sync(true, 10, frame)).toBe(0);
    expect(clock.sync(true, 50, frame)).toBe(0);
    expect(clock.paused).toBe(true);
  });

  it('reports the full span once, on the frame focus returns', () => {
    const clock = new PauseClock(0.5);
    expect(clock.sync(false, 10, frame)).toBe(0);
    expect(clock.sync(true, 10 + frame, frame)).toBe(0);
    expect(clock.sync(true, 20, frame)).toBe(0);
    // Focus back at t=40: frozen from the first paused frame onward.
    expect(clock.sync(false, 40, frame)).toBeCloseTo(40 - (10 + frame), 9);
    expect(clock.sync(false, 40 + frame, frame)).toBe(0);
  });

  it('does not double-count a pause whose last frame was also a stall', () => {
    // Blurred (frames continue), then hidden (frames stop), then visible: the
    // resume frame carries a huge delta that resume() has already banked.
    const clock = new PauseClock(0.5);
    clock.sync(true, 10, frame);
    clock.sync(true, 11, frame);
    expect(clock.sync(false, 71, 60)).toBeCloseTo(61, 9);
    expect(clock.pausedTotalSec).toBeCloseTo(61, 9);
  });

  it('reports an unannounced stall as frozen time', () => {
    const clock = new PauseClock(0.5);
    clock.sync(false, 10, frame);
    expect(clock.sync(false, 25, 15)).toBe(15);
  });

  it('keeps a respawn exactly as far off as it was, end to end', () => {
    // Pop at t=100; the deadline is stamped off the raw clock like popSlot
    // and animatePop do. Pause at t=100.4, resume at t=190.4.
    const clock = new PauseClock(0.5);
    const respawnAt = Float64Array.from([100 + TARGETS.respawnDelaySec, 0]);
    clock.sync(false, 100.4 - frame, frame);
    const remaining = respawnAt[0] - 100.4;

    clock.sync(true, 100.4, frame);
    clock.sync(true, 150, frame);
    const frozen = clock.sync(false, 190.4, frame);
    shiftTimestamps(respawnAt, frozen);

    expect(respawnAt[0] - 190.4).toBeCloseTo(remaining, 9);
    expect(respawnAt[1]).toBe(0);
  });
});

/**
 * The real TargetSystem.update() pause guard, against the vitest stub base
 * class. The robot pool stays empty (no GLTF in unit tests), so the round
 * never activates — but the guard runs first on every frame regardless, and
 * the per-slot timer arrays it re-bases are allocated by init() all the same.
 */
describe('TargetSystem.update pause guard', () => {
  let nowMs = 0;

  beforeEach(() => {
    nowMs = 5_000_000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function harness() {
    const paused = signal(false);
    const Ctor = TargetSystem as unknown as new () => TargetSystem;
    const sys = new Ctor();
    Object.assign(sys as object, {
      globals: {
        gameEvents: new GameEventBuffer(),
        gamePhase: signal<GamePhase>(GamePhase.Idle),
        targetsAlive: signal(0),
        tetheredHands: signal(0),
        paused,
      },
    });
    sys.init();
    const slots = sys as unknown as {
      respawnAt: Float64Array;
      popStartedAt: Float64Array;
      hitFlashUntil: Float64Array;
      slotBobPhase: Float32Array;
    };
    const frame = (delta = 1 / 72) => {
      nowMs += delta * 1000;
      sys.update(delta);
    };
    return { sys, paused, slots, frame };
  }

  const now = () => nowMs / 1000;

  it('re-bases every deadline by the time spent paused', () => {
    const h = harness();
    h.frame();
    h.slots.respawnAt[0] = now() + 1.1;
    h.slots.popStartedAt[1] = now() - 0.05;
    h.slots.hitFlashUntil[2] = now() + 0.08;
    const before = [
      h.slots.respawnAt[0] - now(),
      h.slots.popStartedAt[1] - now(),
      h.slots.hitFlashUntil[2] - now(),
    ];

    h.paused.value = true;
    for (let i = 0; i < 72 * 45; i++) h.frame();
    // Nothing is re-based while still paused.
    expect(h.slots.respawnAt[0] - now()).toBeLessThan(before[0] - 40);

    h.paused.value = false;
    h.frame();
    // One frame of slack: the guard banks from the first frame it SAW paused,
    // and the frame before that was an ordinary one.
    const slack = 1 / 72 + 1e-6;
    expect(Math.abs(h.slots.respawnAt[0] - now() - before[0])).toBeLessThanOrEqual(slack);
    expect(Math.abs(h.slots.popStartedAt[1] - now() - before[1])).toBeLessThanOrEqual(slack);
    expect(Math.abs(h.slots.hitFlashUntil[2] - now() - before[2])).toBeLessThanOrEqual(slack);
    // Unset slots stay unset.
    expect(h.slots.respawnAt[3]).toBe(0);
  });

  it('keeps the hover bob continuous across the pause', () => {
    const h = harness();
    const omega = TARGETS.bobHz * Math.PI * 2;
    h.slots.slotBobPhase[0] = 1.234;
    h.frame();
    const before = Math.sin(now() * omega + h.slots.slotBobPhase[0]);

    h.paused.value = true;
    for (let i = 0; i < 72 * 7; i++) h.frame();
    h.paused.value = false;
    h.frame();

    const after = Math.sin(now() * omega + h.slots.slotBobPhase[0]);
    // Within a few frames' worth of bob: Float32 phase storage plus the
    // frames either side of the seam.
    expect(Math.abs(after - before)).toBeLessThan(omega * (3 / 72));
  });

  it('re-bases after an unannounced stall too', () => {
    const h = harness();
    h.frame();
    h.slots.respawnAt[0] = now() + 1;
    h.frame(120);
    expect(h.slots.respawnAt[0] - now()).toBeCloseTo(1, 6);
  });

  it('leaves deadlines alone on ordinary frames', () => {
    const h = harness();
    h.frame();
    h.slots.respawnAt[0] = 777;
    for (let i = 0; i < 100; i++) h.frame();
    expect(h.slots.respawnAt[0]).toBe(777);
  });
});
