import { describe, it, expect } from 'vitest';
import {
  clamp01,
  createIntroFrame,
  easeInCubic,
  easeOutBack,
  easeOutCubic,
  evaluateIntro,
  faceYaw,
  skipExit,
} from '../../src/systems/IntroSystem';
import { BALLS, INTRO, ROOM } from '../../src/config';

const at = (t: number, reduced = false, exitAt: number = INTRO.exitStartSec, exitSec: number = INTRO.exitSec) =>
  evaluateIntro(t, exitAt, exitSec, INTRO, reduced, createIntroFrame());

describe('intro easing', () => {
  it('clamps and hits both ends', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    for (const f of [easeOutCubic, easeInCubic, (t: number) => easeOutBack(t, 2.2)]) {
      expect(f(0)).toBeCloseTo(0, 6);
      expect(f(1)).toBeCloseTo(1, 6);
    }
  });

  it('easeOutBack overshoots, and does not without overshoot', () => {
    let peak = 0;
    for (let t = 0; t <= 1; t += 0.01) peak = Math.max(peak, easeOutBack(t, 2.2));
    expect(peak).toBeGreaterThan(1.05);
    for (let t = 0; t <= 1; t += 0.01) expect(easeOutBack(t, 0)).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe('intro timeline', () => {
  it('starts empty, before the logo pops', () => {
    const f = at(0);
    expect(f.logoScale).toBe(0);
    expect(f.logoAlpha).toBe(0);
    expect(f.taglineAlpha).toBe(0);
    expect(f.hudVisible).toBe(false);
    expect(f.done).toBe(false);
  });

  it('pops the logo with an overshoot, then settles', () => {
    let peak = 0;
    for (let t = INTRO.logoStartSec; t <= INTRO.logoStartSec + INTRO.logoInSec; t += 0.01) {
      peak = Math.max(peak, at(t).logoScale);
    }
    expect(peak).toBeGreaterThan(1.05);
    expect(at(INTRO.logoStartSec + INTRO.logoInSec + 0.2).logoScale).toBeCloseTo(1, 5);
  });

  it('holds fully visible, HUD still hidden, until the exit', () => {
    const f = at(INTRO.exitStartSec - 0.05);
    expect(f.logoAlpha).toBe(1);
    expect(f.taglineAlpha).toBeCloseTo(1, 5);
    expect(f.fade).toBe(1);
    expect(f.rise).toBe(0);
    expect(f.hudVisible).toBe(false);
  });

  it('lifts, shrinks and fades out, handing the HUD back mid-exit', () => {
    const end = INTRO.exitStartSec + INTRO.exitSec;
    const mid = at(INTRO.exitStartSec + INTRO.exitSec * 0.5);
    expect(mid.rise).toBeGreaterThan(0);
    expect(mid.fade).toBeLessThan(1);
    expect(mid.hudVisible).toBe(true);
    const f = at(end);
    expect(f.done).toBe(true);
    expect(f.fade).toBeCloseTo(0, 6);
    expect(f.rise).toBeCloseTo(INTRO.exitRise, 6);
    expect(f.groupScale).toBeCloseTo(INTRO.exitScale, 6);
  });

  it('runs 3-4 seconds end to end, start delay included', () => {
    const total = INTRO.startDelaySec + INTRO.exitStartSec + INTRO.exitSec;
    expect(total).toBeGreaterThanOrEqual(3);
    expect(total).toBeLessThanOrEqual(4.2);
  });

  it('a skip starts the short exit now, and cannot extend a running exit', () => {
    const t = 1.2;
    const exitAt = skipExit(t, INTRO.exitStartSec);
    expect(exitAt).toBe(t);
    expect(at(t + INTRO.skipExitSec, false, exitAt, INTRO.skipExitSec).done).toBe(true);
    expect(skipExit(INTRO.exitStartSec + 0.1, INTRO.exitStartSec)).toBe(INTRO.exitStartSec);
    expect(INTRO.skipExitSec).toBeLessThan(INTRO.exitSec);
  });

  it('reduced motion: no bounce, no rise, no ring, still fades out', () => {
    let peak = 0;
    for (let t = 0; t < INTRO.exitStartSec; t += 0.02) {
      const f = at(t, true);
      peak = Math.max(peak, f.logoScale, f.splatScale);
      expect(f.ringProgress).toBe(0);
      expect(f.rise).toBe(0);
    }
    expect(peak).toBe(1);
    expect(at(INTRO.exitStartSec + INTRO.exitSec, true).done).toBe(true);
  });

  it('every frame value is finite', () => {
    for (let t = 0; t <= 4; t += 0.05) {
      const f = at(t);
      for (const v of Object.values(f)) {
        if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});

describe('intro placement + tuning', () => {
  it('faceYaw turns a +Z plane toward the viewer', () => {
    // Looking down -Z: the plane needs no turn.
    expect(faceYaw(0, -1)).toBeCloseTo(0, 6);
    // Looking down +X: +Z must map to -X.
    const yaw = faceYaw(1, 0);
    expect(Math.sin(yaw)).toBeCloseTo(-1, 6);
  });

  it('keeps the logo comfortably in front and readable', () => {
    expect(INTRO.distance).toBeGreaterThanOrEqual(1.2);
    expect(INTRO.distance).toBeLessThanOrEqual(2);
    expect(INTRO.logoWidth / INTRO.distance).toBeLessThan(0.8); // ~< 40 deg wide
  });

  it('burst splats are slow enough not to look like tunnelling shots', () => {
    // Not physics, but the same per-step yardstick the rest of the game uses.
    expect(INTRO.particleSpeedMax / 72).toBeLessThan(ROOM.wallThicknessMeters + 2 * BALLS.radius);
  });

  it('palette is five valid hex colours, sounds are existing files', () => {
    expect(INTRO.colors).toHaveLength(5);
    for (const c of INTRO.colors) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    for (const src of [INTRO.whooshSrc, INTRO.splatSrc, INTRO.chimeSrc]) {
      expect(src).toMatch(/^\/audio\/[a-z-]+\.mp3$/);
    }
  });

  it('tagline is ASCII (the MSDF-free canvas does not care, but keep the brand copy plain)', () => {
    expect(/^[\x20-\x7e]+$/.test(INTRO.tagline)).toBe(true);
  });
});
