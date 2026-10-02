import { describe, it, expect } from 'vitest';

import {
  decayRecoil,
  deployTargetsFor,
  easeOutBack,
  easeOutCubic,
  resolveSkin,
  stepDeploy,
} from '../../src/systems/GauntletSystem';
import type { DeployTargets } from '../../src/systems/GauntletSystem';
import {
  createFireGate,
  resolveFireGate,
} from '../../src/systems/BallSpawnSystem';
import { fitShooterScale, createShooterFit } from '../../src/systems/WebShooterSystem';
import { BALLS, BLASTER, CHILL, FIRE, ROOM, WEB } from '../../src/config';
import { BlasterMode, GameEvent, GauntletMuzzles } from '../../src/types';

const targets = (): DeployTargets => ({ bracer: -1, paint: -1, web: -1 });

describe('deployTargetsFor', () => {
  it('HAND shows no hardware', () => {
    expect(deployTargetsFor(BlasterMode.Hand, targets())).toEqual({
      bracer: 0,
      paint: 0,
      web: 0,
    });
  });

  it('BLASTER shows the bracer, plate and barrel', () => {
    expect(deployTargetsFor(BlasterMode.Paint, targets())).toEqual({
      bracer: 1,
      paint: 1,
      web: 0,
    });
  });

  it('WEB shows the bracer, plate and spinneret', () => {
    expect(deployTargetsFor(BlasterMode.Web, targets())).toEqual({
      bracer: 1,
      paint: 0,
      web: 1,
    });
  });

  it('an unknown mode shows nothing rather than everything', () => {
    expect(deployTargetsFor(7, targets())).toEqual({ bracer: 0, paint: 0, web: 0 });
  });

  it('the bracer stays deployed across a BLASTER <-> WEB swap', () => {
    const a = deployTargetsFor(BlasterMode.Paint, targets());
    const b = deployTargetsFor(BlasterMode.Web, targets());
    expect(a.bracer).toBe(1);
    expect(b.bracer).toBe(1);
  });
});

describe('stepDeploy', () => {
  it('a full swing takes exactly the transition time', () => {
    const dt = 1 / 72;
    let v = 0;
    let frames = 0;
    while (v < 1 && frames < 1000) {
      v = stepDeploy(v, 1, dt, 0.3);
      frames++;
    }
    expect(v).toBe(1);
    expect(frames).toBe(Math.ceil(0.3 / dt - 1e-9));
  });

  it('retracts at the same rate and clamps at 0', () => {
    expect(stepDeploy(0.1, 0, 0.5, 0.3)).toBe(0);
    expect(stepDeploy(1, 0, 0.15, 0.3)).toBeCloseTo(0.5, 6);
  });

  it('reverses mid-swing without a jump', () => {
    const mid = stepDeploy(0, 1, 0.12, 0.3); // 0.4 deployed
    const back = stepDeploy(mid, 0, 0.012, 0.3);
    expect(Math.abs(back - mid)).toBeLessThanOrEqual(0.04 + 1e-9);
    expect(back).toBeLessThan(mid);
  });

  it('snaps when the duration is zero or negative', () => {
    expect(stepDeploy(0, 1, 0.01, 0)).toBe(1);
    expect(stepDeploy(1, 0, 0.01, -1)).toBe(0);
  });

  it('treats a target >= 0.5 as deployed and survives garbage input', () => {
    expect(stepDeploy(0.2, 0.7, 10, 0.3)).toBe(1);
    expect(stepDeploy(Number.NaN, 1, 0.03, 0.3)).toBeCloseTo(0.1, 6);
    expect(stepDeploy(0.5, 1, Number.NaN, 0.3)).toBe(0.5);
    expect(stepDeploy(0.5, 1, -1, 0.3)).toBe(0.5);
  });

  it('holds still at the target', () => {
    expect(stepDeploy(1, 1, 0.1, 0.3)).toBe(1);
    expect(stepDeploy(0, 0, 0.1, 0.3)).toBe(0);
  });
});

describe('easing', () => {
  it('both curves hit 0 and 1 exactly at the ends and clamp outside', () => {
    for (const ease of [easeOutCubic, easeOutBack]) {
      expect(ease(0)).toBe(0);
      expect(ease(1)).toBe(1);
      expect(ease(-0.5)).toBe(0);
      expect(ease(1.5)).toBe(1);
    }
  });

  it('easeOutCubic is monotonic and front-loaded', () => {
    let prev = 0;
    for (let i = 1; i <= 20; i++) {
      const v = easeOutCubic(i / 20);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });

  it('easeOutBack overshoots a little and settles (the panel "locks on")', () => {
    let peak = 0;
    for (let i = 0; i <= 100; i++) peak = Math.max(peak, easeOutBack(i / 100));
    expect(peak).toBeGreaterThan(1.02);
    expect(peak).toBeLessThan(1.15);
  });
});

describe('resolveSkin', () => {
  const skins = ['a', 'b', 'c'] as const;

  it('returns the indexed skin', () => {
    expect(resolveSkin(skins, 0)).toBe('a');
    expect(resolveSkin(skins, 2)).toBe('c');
  });

  it('falls back to the first skin for out-of-range or junk indices', () => {
    expect(resolveSkin(skins, 3)).toBe('a');
    expect(resolveSkin(skins, -1)).toBe('a');
    expect(resolveSkin(skins, 1.5)).toBe('a');
    expect(resolveSkin(skins, Number.NaN)).toBe('a');
    expect(resolveSkin(skins, '1')).toBe('a');
    expect(resolveSkin(skins, undefined)).toBe('a');
  });

  it('an empty list resolves to undefined', () => {
    expect(resolveSkin([], 0)).toBeUndefined();
  });

  it('every shipped skin resolves, with #rrggbb colours', () => {
    for (let i = 0; i < BLASTER.skins.length; i++) {
      const skin = resolveSkin(BLASTER.skins, i);
      expect(skin).toBe(BLASTER.skins[i]);
      for (const c of [skin!.accent, skin!.trim, skin!.shell]) {
        expect(c).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});

describe('decayRecoil', () => {
  it('settles by e every time constant', () => {
    expect(decayRecoil(1, 0.07, 0.07)).toBeCloseTo(Math.exp(-1), 6);
  });

  it('snaps tiny values to zero so the per-frame work stops', () => {
    expect(decayRecoil(0.0011, 0.05, 0.07)).toBe(0);
    expect(decayRecoil(0, 0.01, 0.07)).toBe(0);
  });

  it('zero or negative time constant clears it', () => {
    expect(decayRecoil(1, 0.01, 0)).toBe(0);
  });

  it('a negative delta never grows it', () => {
    expect(decayRecoil(0.5, -1, 0.07)).toBe(0.5);
  });
});

describe('resolveFireGate (auto-fire)', () => {
  const gate = createFireGate();
  const run = (mode: BlasterMode, chilling: boolean) =>
    resolveFireGate(
      mode,
      chilling,
      FIRE.cooldownMs,
      CHILL.sprayCooldownMs,
      BLASTER.autoFireCooldownMs,
      gate,
    );

  it('BLASTER mode holds to auto-fire at its own cooldown', () => {
    const g = run(BlasterMode.Paint, false);
    expect(g.level).toBe(true);
    expect(g.cooldownMs).toBe(BLASTER.autoFireCooldownMs);
  });

  it('HAND and WEB fire once per press at the normal cooldown', () => {
    for (const mode of [BlasterMode.Hand, BlasterMode.Web]) {
      const g = run(mode, false);
      expect(g.level).toBe(false);
      expect(g.cooldownMs).toBe(FIRE.cooldownMs);
    }
  });

  it('Chill sprays in every mode; with BLASTER the shorter cooldown wins', () => {
    expect(run(BlasterMode.Hand, true)).toEqual({
      level: true,
      cooldownMs: CHILL.sprayCooldownMs,
    });
    expect(run(BlasterMode.Paint, true).cooldownMs).toBe(
      Math.min(CHILL.sprayCooldownMs, BLASTER.autoFireCooldownMs),
    );
  });

  it('writes into the caller-owned gate (no allocation)', () => {
    expect(run(BlasterMode.Paint, false)).toBe(gate);
  });
});

describe('BLASTER config', () => {
  it('the transition is a snappy 0.25-0.35 s', () => {
    expect(BLASTER.transitionSec).toBeGreaterThanOrEqual(0.25);
    expect(BLASTER.transitionSec).toBeLessThanOrEqual(0.35);
  });

  it('auto-fire is faster than a tap, but not a hose', () => {
    expect(BLASTER.autoFireCooldownMs).toBeLessThan(FIRE.cooldownMs);
    expect(BLASTER.autoFireCooldownMs).toBeGreaterThanOrEqual(100);
  });

  it('paint keeps FIRE.speed under the wall-tunnelling cap (gotcha 22)', () => {
    const perStep = FIRE.speed / 72;
    expect(perStep).toBeLessThan(ROOM.wallThicknessMeters + 2 * BALLS.radius);
  });

  it('a paint ball is born clear of the barrel', () => {
    expect(BLASTER.muzzleOffset).toBeGreaterThanOrEqual(BALLS.radius);
  });

  it('the muzzle sits over the back of the wrist, toward the hand', () => {
    expect(BLASTER.muzzleLocal[1]).toBeGreaterThan(0.03);
    expect(BLASTER.muzzleLocal[2]).toBeLessThanOrEqual(0);
  });

  it('the web needle tip is forward of the spinneret centre', () => {
    expect(WEB.muzzleLocal[2]).toBeLessThan(0);
  });
});

describe('round-8 plumbing', () => {
  it('BlasterModeChanged is a new, distinct event id', () => {
    const ids = Object.values(GameEvent);
    expect(ids).toContain(GameEvent.BlasterModeChanged);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('GauntletMuzzles starts invalid with xyz per hand', () => {
    const m = new GauntletMuzzles();
    expect(Array.from(m.valid)).toEqual([0, 0]);
    expect(m.origin.length).toBe(6);
    expect(m.direction.length).toBe(6);
  });

  it('fitShooterScale still answers from its old home (re-export)', () => {
    const fit = createShooterFit();
    fitShooterScale(0.73, 1.85, 1.9, 0.075, 0.11, fit);
    expect(fit.bandAxis).toBe(0);
  });
});
