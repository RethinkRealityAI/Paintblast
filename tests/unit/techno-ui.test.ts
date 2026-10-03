import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

import { BLASTER, HUD, PALETTE } from '../../src/config';
import {
  BLASTER_MODE_DESCRIPTIONS,
  BLASTER_MODE_LABELS,
  BLASTER_MODE_ORDER,
  appearFrame,
  botsLabel,
  clampIndex,
  cycleIndex,
  easeOutBack,
  easeOutCubic,
  formatScore,
  hexToInt,
  isNewBest,
  isPrintableAscii,
  parseStoredSkin,
  rampColor,
  readSkin,
  skinCounterLabel,
  superellipsePoint,
  writeSkin,
} from '../../src/types';

/** Round 8: the techno-paint HUD, the Armory and the holo palette. */

describe('skin cycling (Armory < >)', () => {
  it('steps forward and wraps past the end', () => {
    expect(cycleIndex(0, 1, 5)).toBe(1);
    expect(cycleIndex(4, 1, 5)).toBe(0);
  });

  it('steps back and wraps past the start', () => {
    expect(cycleIndex(0, -1, 5)).toBe(4);
    expect(cycleIndex(3, -1, 5)).toBe(2);
  });

  it('handles big jumps and junk starts', () => {
    expect(cycleIndex(1, 12, 5)).toBe(3);
    expect(cycleIndex(1, -12, 5)).toBe(4);
    expect(cycleIndex(99, 1, 5)).toBe(0); // clamped to 4 first
    expect(cycleIndex(Number.NaN, 1, 5)).toBe(1);
  });

  it('an empty ring always answers 0', () => {
    expect(cycleIndex(3, 1, 0)).toBe(0);
    expect(clampIndex(3, 0)).toBe(0);
  });

  it('clamps into range', () => {
    expect(clampIndex(-2, 5)).toBe(0);
    expect(clampIndex(7, 5)).toBe(4);
    expect(clampIndex(2.9, 5)).toBe(2);
  });
});

describe('skin persistence', () => {
  const memory = () => {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  };

  it('parses only clean in-range integers, else 0', () => {
    expect(parseStoredSkin('3', 5)).toBe(3);
    expect(parseStoredSkin(' 2 ', 5)).toBe(2);
    expect(parseStoredSkin('5', 5)).toBe(0); // stale value from a longer list
    expect(parseStoredSkin('-1', 5)).toBe(0);
    expect(parseStoredSkin('2.5', 5)).toBe(0);
    expect(parseStoredSkin('abc', 5)).toBe(0);
    expect(parseStoredSkin(null, 5)).toBe(0);
    expect(parseStoredSkin('1', 0)).toBe(0);
  });

  it('round-trips through storage', () => {
    const storage = memory();
    expect(writeSkin(storage, BLASTER.skinStorageKey, 3)).toBe(true);
    expect(storage.map.get(BLASTER.skinStorageKey)).toBe('3');
    expect(readSkin(storage, BLASTER.skinStorageKey, BLASTER.skins.length)).toBe(3);
  });

  it('never throws when storage is blocked (private mode)', () => {
    const hostile = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(readSkin(hostile, 'k', 5)).toBe(0);
    expect(writeSkin(hostile, 'k', 2)).toBe(false);
    expect(readSkin(undefined, 'k', 5)).toBe(0);
    expect(writeSkin(undefined, 'k', 2)).toBe(false);
  });

  it('labels the counter 1-based', () => {
    expect(skinCounterLabel(0, 5)).toBe('SKIN 1 OF 5');
    expect(skinCounterLabel(4, 5)).toBe('SKIN 5 OF 5');
    expect(skinCounterLabel(9, 5)).toBe('SKIN 5 OF 5');
  });
});

describe('HUD readouts', () => {
  it('groups score digits like the title art', () => {
    expect(formatScore(0)).toBe('0');
    expect(formatScore(950)).toBe('950');
    expect(formatScore(15400)).toBe('15,400');
    expect(formatScore(1234567)).toBe('1,234,567');
    expect(formatScore(-5)).toBe('0');
    expect(formatScore(Number.NaN)).toBe('0');
  });

  it('pluralises Neatniks (round 9 rebrand)', () => {
    expect(botsLabel(1)).toBe('1 Neatnik');
    expect(botsLabel(0)).toBe('0 Neatniks');
    expect(botsLabel(4)).toBe('4 Neatniks');
    expect(botsLabel(Number.NaN)).toBe('0 Neatniks');
  });

  it('only a strictly higher score is a NEW BEST', () => {
    expect(isNewBest(1200, 1000)).toBe(true);
    expect(isNewBest(1000, 1000)).toBe(false);
    expect(isNewBest(0, 0)).toBe(false);
  });

  it('parses hex colours, defaulting to white', () => {
    expect(hexToInt('#ff4f81')).toBe(0xff4f81);
    expect(hexToInt('48dbfb')).toBe(0x48dbfb);
    expect(hexToInt('not a colour')).toBe(0xffffff);
  });
});

describe('ASCII-only copy (gotcha 24)', () => {
  const markup = readFileSync('ui/hud.uikitml', 'utf8');
  const body = markup.slice(markup.indexOf('</style>'));

  it('detects non-ASCII', () => {
    expect(isPrintableAscii('PLAY AGAIN x3 - ok')).toBe(true);
    expect(isPrintableAscii('x×3')).toBe(false);
    expect(isPrintableAscii('wait…')).toBe(false);
  });

  it('every text node in the HUD markup is printable ASCII', () => {
    // Text between tags, svg path data excluded (it is geometry, not glyphs).
    const texts = body
      .replace(/<svg[\s\S]*?<\/svg>/g, '')
      .split(/<[^>]*>/)
      .map((t) => t.trim())
      .filter(Boolean);
    expect(texts.length).toBeGreaterThan(20);
    for (const text of texts) expect(isPrintableAscii(text), text).toBe(true);
  });

  it('every label, description and skin name the HUD writes is ASCII', () => {
    for (const mode of BLASTER_MODE_ORDER) {
      expect(isPrintableAscii(BLASTER_MODE_LABELS[mode])).toBe(true);
      expect(isPrintableAscii(BLASTER_MODE_DESCRIPTIONS[mode])).toBe(true);
      expect(BLASTER_MODE_DESCRIPTIONS[mode].length).toBeGreaterThan(0);
    }
    for (const skin of BLASTER.skins) expect(isPrintableAscii(skin.name)).toBe(true);
  });
});

describe('HUD markup contract', () => {
  const markup = readFileSync('ui/hud.uikitml', 'utf8');
  const body = markup.slice(markup.indexOf('</style>'));
  const source = readFileSync('src/systems/HudSystem.ts', 'utf8');

  it('declares every element id HudSystem looks up', () => {
    const ids = new Set<string>();
    for (const m of source.matchAll(/element\(document, '([a-z0-9-]+)'\)/g)) ids.add(m[1]);
    for (const m of source.matchAll(/document,\s*'([a-z0-9-]+)'/g)) ids.add(m[1]);
    for (const m of source.matchAll(/id: '([a-z0-9-]+)'/g)) ids.add(m[1]);
    expect(ids.size).toBeGreaterThan(25);
    for (const id of ids) expect(body, id).toContain(`id="${id}"`);
  });

  it('has one skin dot per skin (spares are hidden at runtime, never missing)', () => {
    const dots = body.match(/id="btn-skin-\d+"/g) ?? [];
    expect(dots.length).toBeGreaterThanOrEqual(BLASTER.skins.length);
  });

  it('reaches the Armory from the title and back', () => {
    const idle = body.slice(
      body.indexOf('id="section-idle"'),
      body.indexOf('id="section-playing"'),
    );
    expect(idle).toContain('id="btn-armory"');
    const armory = body.slice(body.indexOf('id="section-armory"'));
    expect(armory).toContain('id="btn-armory-back"');
    expect(armory).toContain('id="btn-mode-hand"');
    expect(armory).toContain('id="btn-mode-blaster"');
    expect(armory).toContain('id="btn-mode-web"');
    expect(armory).toContain('id="btn-skin-prev"');
    expect(armory).toContain('id="btn-skin-next"');
  });

  it('ships every non-title section hidden', () => {
    for (const id of ['section-playing', 'section-gameover', 'section-chill', 'section-armory']) {
      expect(body).toMatch(new RegExp(`id="${id}" class="section-hidden"`));
    }
  });

  it('keeps micro-interaction tunables sane', () => {
    expect(HUD.sectionFadeSec).toBeGreaterThanOrEqual(0);
    expect(HUD.sectionFadeSec).toBeLessThan(0.6);
    expect(HUD.buttonHoverScale).toBeGreaterThanOrEqual(1);
    expect(HUD.buttonPressScale).toBeLessThan(1);
    expect(HUD.buttonPressScale).toBeGreaterThan(0.8);
    expect(HUD.pressFlashMs).toBeGreaterThan(50);
    expect(HUD.timerUrgentSec).toBeGreaterThan(0);
  });
});

describe('appear animation easing', () => {
  it('easeOutBack runs 0 -> 1 with a small overshoot', () => {
    expect(easeOutBack(0)).toBeCloseTo(0, 6);
    expect(easeOutBack(1)).toBeCloseTo(1, 6);
    let peak = 0;
    for (let i = 0; i <= 100; i++) peak = Math.max(peak, easeOutBack(i / 100));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(1.15);
    expect(easeOutBack(-1)).toBeCloseTo(0, 6);
    expect(easeOutBack(2)).toBeCloseTo(1, 6);
  });

  it('easeOutCubic is monotonic 0 -> 1', () => {
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const v = easeOutCubic(i / 20);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  it('appearFrame pops from the start scale and settles exactly on 1', () => {
    const out = { scale: 0, glow: 0 };
    expect(appearFrame(0, 0.3, 0.35, out)).toBe(true);
    expect(out.scale).toBeCloseTo(0.35, 6);
    expect(out.glow).toBeCloseTo(0, 6);
    expect(appearFrame(0.15, 0.3, 0.35, out)).toBe(true);
    expect(out.scale).toBeGreaterThan(0.35);
    expect(appearFrame(0.3, 0.3, 0.35, out)).toBe(false);
    expect(out.scale).toBe(1);
    expect(out.glow).toBe(1);
    // A zero duration means no animation at all.
    expect(appearFrame(0, 0, 0.35, out)).toBe(false);
    expect(out.scale).toBe(1);
  });

  it('config keeps the pop quick and visible', () => {
    expect(PALETTE.appearSec).toBeGreaterThan(0);
    expect(PALETTE.appearSec).toBeLessThan(0.6);
    expect(PALETTE.appearFromScale).toBeGreaterThan(0);
    expect(PALETTE.appearFromScale).toBeLessThan(1);
    expect(PALETTE.hideAfterLostSec).toBeGreaterThan(0.1);
  });
});

describe('holo board geometry', () => {
  it('superellipse hits its axes and squares off with n', () => {
    const p = superellipsePoint(0, 2, 1, 3);
    expect(p[0]).toBeCloseTo(2, 6);
    expect(p[1]).toBeCloseTo(0, 6);
    const q = superellipsePoint(Math.PI / 2, 2, 1, 3);
    expect(q[0]).toBeCloseTo(0, 6);
    expect(q[1]).toBeCloseTo(1, 6);
    // At 45 degrees a squarer curve reaches further out than the ellipse.
    const round = superellipsePoint(Math.PI / 4, 1, 1, 2);
    const square = superellipsePoint(Math.PI / 4, 1, 1, 4);
    expect(square[0]).toBeGreaterThan(round[0]);
    // ...and stays on its own curve.
    expect(Math.abs(square[0]) ** 4 + Math.abs(square[1]) ** 4).toBeCloseTo(1, 6);
  });

  it('the holo outline contains the old oval, so every dab, chip and pad stays on the board', () => {
    // n >= 2 superellipse with the same semi-axes encloses the ellipse that
    // config.test's onBoard() checks layout against.
    expect(PALETTE.holoSquareness).toBeGreaterThanOrEqual(2);
  });

  it('ramps edge colours and closes the loop', () => {
    const out: [number, number, number] = [0, 0, 0];
    rampColor(0, ['#ff0000', '#0000ff'], out);
    expect(out).toEqual([1, 0, 0]);
    rampColor(1, ['#ff0000', '#0000ff'], out);
    expect(out).toEqual([0, 0, 1]);
    rampColor(0.5, ['#ff0000', '#0000ff'], out);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[2]).toBeCloseTo(0.5, 6);
    rampColor(0.3, ['#00ff00'], out);
    expect(out).toEqual([0, 1, 0]);
    rampColor(0.3, [], out);
    expect(out).toEqual([1, 1, 1]);
    // The configured ramp starts and ends on the same colour: no seam.
    const stops = PALETTE.holoEdgeColors;
    expect(stops[0]).toBe(stops[stops.length - 1]);
  });
});

describe('palette touch targets (Meta hands guidance)', () => {
  const MIN_TARGET = 0.022;
  const MIN_GAP = 0.01;

  it('every pressable is at least ~22 mm across', () => {
    expect(PALETTE.dabRadius * 2).toBeGreaterThanOrEqual(MIN_TARGET);
    expect(PALETTE.chipRadius * 2).toBeGreaterThanOrEqual(MIN_TARGET);
    expect(PALETTE.modePadRadius * 2).toBeGreaterThanOrEqual(MIN_TARGET);
  });

  it('neighbouring chips and pads keep ~10 mm of air between them', () => {
    expect(PALETTE.chipSpacing - PALETTE.chipRadius * 2).toBeGreaterThanOrEqual(MIN_GAP - 1e-9);
    expect(PALETTE.modePadSpacing - PALETTE.modePadRadius * 2).toBeGreaterThanOrEqual(MIN_GAP - 1e-9);
  });

  it('holo sockets never touch their neighbours', () => {
    const tube = 0.0008;
    expect(
      PALETTE.chipSpacing - 2 * (PALETTE.chipRadius * PALETTE.socketRimScale + tube),
    ).toBeGreaterThan(0.0015);
    expect(
      PALETTE.modePadSpacing - 2 * (PALETTE.modePadRadius * PALETTE.socketRimScale + tube),
    ).toBeGreaterThan(0.0015);
  });

  it('well rims ring the dab without overlapping the next well', () => {
    const span = ((PALETTE.dabArcEndDeg - PALETTE.dabArcStartDeg) * Math.PI) / 180;
    const spacing = (PALETTE.dabArcRadius * span) / 3;
    expect(PALETTE.wellRimScale).toBeGreaterThan(1);
    expect(spacing).toBeGreaterThan(2 * PALETTE.dabRadius * PALETTE.wellRimScale);
  });

  it('opacities are real opacities', () => {
    for (const v of [
      PALETTE.holoFaceOpacity,
      PALETTE.holoGlowOpacity,
      PALETTE.wellRimOpacity,
      PALETTE.wellRimSelectedOpacity,
      PALETTE.wellGlowOpacity,
      PALETTE.wellGlowSelectedOpacity,
      PALETTE.socketRimOpacity,
      PALETTE.socketRimSelectedOpacity,
    ]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(PALETTE.wellRimSelectedOpacity).toBeGreaterThan(PALETTE.wellRimOpacity);
    expect(PALETTE.socketRimSelectedOpacity).toBeGreaterThan(PALETTE.socketRimOpacity);
  });
});
