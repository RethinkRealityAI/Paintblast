import { describe, it, expect } from 'vitest';
import {
  expSmoothing,
  happySpin,
  lookTilt,
  pipHoverPoint,
  pipShownInPhase,
  stepPresence,
} from '../../src/systems/PipSystem';
import { NEATNIKS } from '../../src/config';
import { GamePhase } from '../../src/types';

describe('pipShownInPhase', () => {
  it('keeps Pip out in the menus and Chill', () => {
    expect(pipShownInPhase(GamePhase.Idle)).toBe(true);
    expect(pipShownInPhase(GamePhase.GameOver)).toBe(true);
    expect(pipShownInPhase(GamePhase.Chill)).toBe(true);
  });

  it('gets him out of the line of fire for a round', () => {
    expect(pipShownInPhase(GamePhase.Countdown)).toBe(false);
    expect(pipShownInPhase(GamePhase.Playing)).toBe(false);
  });
});

describe('expSmoothing', () => {
  it('is 0 with no rate or time and approaches 1', () => {
    expect(expSmoothing(0, 1)).toBe(0);
    expect(expSmoothing(5, 0)).toBe(0);
    expect(expSmoothing(5, 10)).toBeCloseTo(1, 6);
  });

  it('is framerate independent', () => {
    let a = 0;
    for (let i = 0; i < 72; i++) a += (1 - a) * expSmoothing(4, 1 / 72);
    let b = 0;
    for (let i = 0; i < 30; i++) b += (1 - b) * expSmoothing(4, 1 / 30);
    expect(a).toBeCloseTo(b, 6);
  });
});

describe('stepPresence (fly off / fly in)', () => {
  it('covers the trip in flySec and clamps', () => {
    let p = 0;
    for (let i = 0; i < 30; i++) p = stepPresence(p, true, 0.6, 0.02);
    expect(p).toBeCloseTo(1, 6);
    p = stepPresence(p, true, 0.6, 1);
    expect(p).toBe(1);
    for (let i = 0; i < 15; i++) p = stepPresence(p, false, 0.6, 0.02);
    expect(p).toBeCloseTo(0.5, 6);
    p = stepPresence(p, false, 0.6, 5);
    expect(p).toBe(0);
  });

  it('snaps when flySec is 0', () => {
    expect(stepPresence(0, true, 0, 0.01)).toBe(1);
    expect(stepPresence(1, false, 0, 0.01)).toBe(0);
  });
});

describe('happySpin', () => {
  const out = new Float32Array(2);

  it('spins the configured turns and lands back on the facing', () => {
    happySpin(0, 1.3, 2, 0.08, out);
    expect(out[0]).toBeCloseTo(0, 9);
    expect(out[1]).toBeCloseTo(0, 9);
    happySpin(1.3 - 1e-9, 1.3, 2, 0.08, out);
    expect(out[0]).toBeCloseTo(2 * Math.PI * 2, 4);
    happySpin(1.3, 1.3, 2, 0.08, out);
    expect(out[0]).toBe(0);
  });

  it('hops highest in the middle', () => {
    happySpin(0.65, 1.3, 2, 0.08, out);
    expect(out[1]).toBeCloseTo(0.08, 6);
    expect(out[0]).toBeCloseTo(2 * Math.PI, 6);
  });

  it('is inert before it starts (no spin pending at boot)', () => {
    happySpin(-1, 1.3, 2, 0.08, out);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
  });
});

describe('pipHoverPoint', () => {
  const out = new Float32Array(3);

  it('sits past the panel\'s left edge, above centre, toward the viewer', () => {
    // Panel at (0, 1.5, -1) facing +Z, right = +X, viewer toward +Z.
    pipHoverPoint(0, 1.5, -1, 1, 0, 0, 0, 1, 0.25, 0.1, 0.08, 0.06, out);
    expect(out[0]).toBeCloseTo(-0.35, 6);
    expect(out[1]).toBeCloseTo(1.58, 6);
    expect(out[2]).toBeCloseTo(-0.94, 6);
  });

  it('follows a turned panel', () => {
    // Panel turned 90 deg: its right axis is -Z.
    pipHoverPoint(1, 1.4, 0, 0, 0, -1, -1, 0, 0.2, 0.1, 0, 0, out);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[2]).toBeCloseTo(0.3, 6);
  });

  it('uses the shipped knobs sensibly', () => {
    const pip = NEATNIKS.pip;
    expect(pip.besidePanel).toBeGreaterThan(pip.sizeMeters / 2 - 0.05);
    expect(pip.flySec).toBeGreaterThan(0);
  });
});

describe('lookTilt', () => {
  it('leans toward a head above and clamps', () => {
    expect(lookTilt(0, 1, 0.25)).toBeCloseTo(0, 9);
    expect(lookTilt(0.1, 1, 0.25)).toBeCloseTo(Math.atan(0.1), 9);
    expect(lookTilt(5, 1, 0.25)).toBe(0.25);
    expect(lookTilt(-5, 1, 0.25)).toBe(-0.25);
    expect(Number.isFinite(lookTilt(1, 0, 0.25))).toBe(true);
  });
});
