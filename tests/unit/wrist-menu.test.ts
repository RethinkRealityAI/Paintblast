import { describe, it, expect } from 'vitest';

import { MENU, TUTORIAL } from '../../src/config';
import {
  BlasterMode,
  GameEvent,
  GamePhase,
  PALETTE_CHIP_ORDER,
  PALETTE_DAB_ORDER,
  TutorialStep,
  WebSubMode,
  WristMenuState,
  isPrintableAscii,
} from '../../src/types';
import {
  MENU_ROW_CAPTIONS,
  MENU_SUBMODE_LABELS,
  MenuCloseReason,
  MenuItemKind,
  PokePhase,
  buildMenuLayout,
  controllerMenuToggle,
  createGemPokeState,
  createPokeState,
  hitTestMenu,
  inPokeZone,
  inverseRotate,
  menuAutoClose,
  menuClosesAfterPick,
  menuInteractive,
  menuRayHit,
  stepGemPoke,
  stepOpenProgress,
  stepPoke,
} from '../../src/wrist-menu';
import { tutorialLineFor } from '../../src/systems/TutorialSystem';

const POKE = {
  hoverMeters: 0.03,
  selectDepthMeters: 0.006,
  rearmMeters: 0.012,
  maxBehindMeters: 0.05,
};

describe('menu layout', () => {
  const short = buildMenuLayout(false, MENU);
  const tall = buildMenuLayout(true, MENU);

  it('has every launcher, both GOO verbs, every colour and every ammo kind', () => {
    const count = (kind: number) => tall.items.filter((i) => i.kind === kind).length;
    expect(count(MenuItemKind.Launcher)).toBe(3);
    expect(count(MenuItemKind.SubMode)).toBe(2);
    expect(count(MenuItemKind.Colour)).toBe(PALETTE_DAB_ORDER.length);
    expect(count(MenuItemKind.Ammo)).toBe(PALETTE_CHIP_ORDER.length);
    // No GOO / WEB chip in the ammo row: GOO is a launcher.
    for (const it of tall.items.filter((i) => i.kind === MenuItemKind.Ammo)) {
      expect(PALETTE_CHIP_ORDER[it.value].label).not.toBe('WEB');
    }
  });

  it('shows the GOO row only in the tall (GOO loaded) layout', () => {
    for (const it of short.items) {
      expect(it.shown).toBe(it.kind !== MenuItemKind.SubMode);
    }
    for (const it of tall.items) expect(it.shown).toBe(true);
    expect(tall.height).toBeGreaterThan(short.height);
    expect(tall.width).toBeCloseTo(short.width, 9);
  });

  it('keeps the launcher row the same distance from the top in both layouts', () => {
    const launcherTop = (l: typeof short) =>
      l.height / 2 - l.items.find((i) => i.kind === MenuItemKind.Launcher)!.y;
    expect(launcherTop(tall)).toBeCloseTo(launcherTop(short), 9);
  });

  it('orders rows top to bottom: launcher, GOO, colour, ammo', () => {
    const y = (k: number) => tall.items.find((i) => i.kind === k)!.y;
    expect(y(MenuItemKind.Launcher)).toBeGreaterThan(y(MenuItemKind.SubMode));
    expect(y(MenuItemKind.SubMode)).toBeGreaterThan(y(MenuItemKind.Colour));
    expect(y(MenuItemKind.Colour)).toBeGreaterThan(y(MenuItemKind.Ammo));
  });

  it('fits every button inside the panel', () => {
    for (const l of [short, tall]) {
      for (const it of l.items.filter((i) => i.shown)) {
        expect(Math.abs(it.x) + it.w / 2).toBeLessThanOrEqual(l.width / 2 + 1e-9);
        expect(Math.abs(it.y) + it.h / 2).toBeLessThanOrEqual(l.height / 2 + 1e-9);
      }
    }
  });

  it('is wrist sized: under 20 cm either way', () => {
    expect(tall.width).toBeLessThan(0.2);
    expect(tall.height).toBeLessThan(0.21);
  });

  it('labels and captions are ASCII', () => {
    for (const t of Object.values(MENU_ROW_CAPTIONS)) expect(isPrintableAscii(t)).toBe(true);
    for (const t of Object.values(MENU_SUBMODE_LABELS)) expect(isPrintableAscii(t)).toBe(true);
  });
});

describe('hitTestMenu', () => {
  const short = buildMenuLayout(false, MENU);
  const tall = buildMenuLayout(true, MENU);

  it('finds every shown button at its centre', () => {
    tall.items.forEach((it, i) => {
      expect(hitTestMenu(tall, it.x, it.y, 0)).toBe(i);
    });
  });

  it('never hits a hidden GOO button', () => {
    short.items.forEach((it, i) => {
      if (it.shown) return;
      expect(hitTestMenu(short, it.x, it.y, 0)).not.toBe(i);
    });
  });

  it('misses in the gaps and off the panel', () => {
    const a = tall.items[0];
    const b = tall.items[1];
    const gapX = (a.x + a.w / 2 + (b.x - b.w / 2)) / 2;
    expect(hitTestMenu(tall, gapX, a.y, MENU.hitMarginMeters)).toBe(-1);
    expect(hitTestMenu(tall, 1, 1, MENU.hitMarginMeters)).toBe(-1);
  });
});

describe('stepPoke (Quest-native press)', () => {
  it('hovers in front, selects once on crossing, re-arms only after backing out', () => {
    const s = createPokeState();
    expect(stepPoke(s, 0.05, 3, true, POKE)).toBe(-1);
    expect(s.phase).toBe(PokePhase.Idle);
    expect(stepPoke(s, 0.02, 3, true, POKE)).toBe(-1);
    expect(s.phase).toBe(PokePhase.Hover);
    expect(s.target).toBe(3);
    expect(stepPoke(s, -0.002, 3, true, POKE)).toBe(-1);
    expect(s.phase).toBe(PokePhase.Pressing);
    expect(s.depth).toBeCloseTo(0.002, 9);
    expect(stepPoke(s, -0.007, 3, true, POKE)).toBe(3);
    expect(s.phase).toBe(PokePhase.Spent);
    // Resting / wiggling inside: no repeat.
    expect(stepPoke(s, -0.01, 3, true, POKE)).toBe(-1);
    expect(stepPoke(s, 0.005, 3, true, POKE)).toBe(-1);
    expect(stepPoke(s, -0.01, 3, true, POKE)).toBe(-1);
    // Back out past the re-arm distance, then a second poke selects again.
    expect(stepPoke(s, 0.02, 3, true, POKE)).toBe(-1);
    expect(s.phase).toBe(PokePhase.Hover);
    expect(stepPoke(s, -0.008, 3, true, POKE)).toBe(3);
  });

  it('selects a fast poke that crosses the whole depth in one frame', () => {
    const s = createPokeState();
    stepPoke(s, 0.015, 1, true, POKE);
    expect(stepPoke(s, -0.02, 1, true, POKE)).toBe(1);
  });

  it('ignores a fingertip that arrives from behind (a hand swept through)', () => {
    const s = createPokeState();
    expect(stepPoke(s, -0.01, 2, true, POKE)).toBe(-1);
    expect(s.phase).toBe(PokePhase.Behind);
    expect(stepPoke(s, -0.02, 2, true, POKE)).toBe(-1);
    // Coming forward through the face does not select either.
    expect(stepPoke(s, 0.005, 2, true, POKE)).toBe(-1);
    expect(stepPoke(s, -0.01, 2, true, POKE)).toBe(-1);
  });

  it('ignores a pass that jumps far behind the face in one frame', () => {
    const s = createPokeState();
    stepPoke(s, 0.02, 4, true, POKE);
    expect(stepPoke(s, -0.08, 4, true, POKE)).toBe(-1);
    expect(s.phase).toBe(PokePhase.Behind);
  });

  it('cancels when the finger slides onto another button mid-press', () => {
    const s = createPokeState();
    stepPoke(s, 0.02, 5, true, POKE);
    stepPoke(s, -0.002, 5, true, POKE);
    expect(stepPoke(s, -0.008, 6, true, POKE)).toBe(-1);
    expect(s.phase).toBe(PokePhase.Behind);
  });

  it('drops everything when the hand is not tracked', () => {
    const s = createPokeState();
    stepPoke(s, 0.02, 5, true, POKE);
    expect(stepPoke(s, -0.01, 5, false, POKE)).toBe(-1);
    expect(s.phase).toBe(PokePhase.Idle);
    expect(s.target).toBe(-1);
  });
});

describe('stepGemPoke (summon gem)', () => {
  const cfg = MENU;
  const inside = MENU.gemPokeEnterRadius * 0.5;
  const outside = MENU.gemPokeExitRadius * 1.5;

  it('toggles on entry, once, and re-arms only after leaving', () => {
    const s = createGemPokeState();
    expect(stepGemPoke(s, outside, 0, false, cfg)).toBe(false);
    expect(stepGemPoke(s, inside, 1, false, cfg)).toBe(true);
    expect(stepGemPoke(s, inside, 1.1, false, cfg)).toBe(false);
    // Between the radii: not re-armed yet.
    expect(stepGemPoke(s, (MENU.gemPokeEnterRadius + MENU.gemPokeExitRadius) / 2, 2, false, cfg)).toBe(false);
    expect(stepGemPoke(s, inside, 2.1, false, cfg)).toBe(false);
    stepGemPoke(s, outside, 3, false, cfg);
    expect(stepGemPoke(s, inside, 3.1, false, cfg)).toBe(true);
  });

  it('debounces a quick double-tap', () => {
    const s = createGemPokeState();
    stepGemPoke(s, outside, 0, false, cfg);
    expect(stepGemPoke(s, inside, 1, false, cfg)).toBe(true);
    stepGemPoke(s, outside, 1.05, false, cfg);
    expect(stepGemPoke(s, inside, 1.1, false, cfg)).toBe(false);
  });

  it('never toggles mid-pinch, and the spent entry does not fire on release', () => {
    const s = createGemPokeState();
    stepGemPoke(s, outside, 0, false, cfg);
    expect(stepGemPoke(s, inside, 1, true, cfg)).toBe(false);
    expect(stepGemPoke(s, inside, 1.2, false, cfg)).toBe(false);
  });

  it('needs to see the finger outside first (tracking resumes on the gem)', () => {
    const s = createGemPokeState();
    expect(stepGemPoke(s, inside, 0, false, cfg)).toBe(false);
    stepGemPoke(s, Number.POSITIVE_INFINITY, 1, false, cfg);
    expect(stepGemPoke(s, inside, 2, false, cfg)).toBe(false);
  });
});

describe('open / close rules', () => {
  it('auto-closes on idle and on a lost left hand (lost wins)', () => {
    expect(menuAutoClose(0, 0, MENU)).toBe(MenuCloseReason.None);
    expect(menuAutoClose(MENU.autoCloseIdleSec, 0, MENU)).toBe(MenuCloseReason.Idle);
    expect(menuAutoClose(0, MENU.closeAfterLostSec + 0.01, MENU)).toBe(MenuCloseReason.LostHand);
    expect(menuAutoClose(99, 99, MENU)).toBe(MenuCloseReason.LostHand);
    expect(menuAutoClose(999, 0, { autoCloseIdleSec: 0, closeAfterLostSec: 0.6 })).toBe(
      MenuCloseReason.None,
    );
  });

  it('closes after a launcher pick but stays open after GOO (its row just appeared)', () => {
    expect(menuClosesAfterPick(MenuItemKind.Launcher, BlasterMode.Paint, MENU)).toBe(true);
    expect(menuClosesAfterPick(MenuItemKind.Launcher, BlasterMode.Hand, MENU)).toBe(true);
    expect(menuClosesAfterPick(MenuItemKind.Launcher, BlasterMode.Web, MENU)).toBe(false);
    expect(menuClosesAfterPick(MenuItemKind.SubMode, WebSubMode.Tether, MENU)).toBe(true);
    expect(menuClosesAfterPick(MenuItemKind.Colour, 0, MENU)).toBe(false);
    expect(menuClosesAfterPick(MenuItemKind.Ammo, 0, MENU)).toBe(false);
  });

  it('animates open and closed over openSec', () => {
    let t = 0;
    t = stepOpenProgress(t, true, MENU.openSec / 2, MENU.openSec);
    expect(t).toBeCloseTo(0.5, 6);
    t = stepOpenProgress(t, true, MENU.openSec, MENU.openSec);
    expect(t).toBe(1);
    t = stepOpenProgress(t, false, MENU.openSec * 2, MENU.openSec);
    expect(t).toBe(0);
    expect(stepOpenProgress(0.3, true, 0.01, 0)).toBe(1);
  });
});

describe('controller mapping', () => {
  it('Y on the left controller toggles the menu in every phase', () => {
    for (const phase of Object.values(GamePhase)) {
      expect(controllerMenuToggle(true, false, phase)).toBe(true);
    }
  });

  it('X never toggles (it starts rounds, practice included)', () => {
    for (const phase of Object.values(GamePhase)) {
      expect(controllerMenuToggle(false, true, phase)).toBe(false);
    }
  });
});

describe('a closed menu is inert', () => {
  /** A 17 x 15 cm panel 40 cm in front of the origin, facing +Z (toward it). */
  const panel = (open: number) => {
    const s = new WristMenuState();
    s.open = open;
    s.center.set([0, 0, -0.4]);
    s.quaternion.set([0, 0, 0, 1]);
    s.halfW = 0.085;
    s.halfH = 0.075;
    return s;
  };
  const scratch = new Float32Array(3);

  it('an open panel blocks a ray pointed at it, not one pointed away', () => {
    const s = panel(1);
    expect(menuRayHit(s, 0, 0, 0, 0, 0, -1, 1.2, 0, scratch)).toBe(true);
    expect(menuRayHit(s, 0, 0, 0, 0, 0, 1, 1.2, 0, scratch)).toBe(false);
    expect(menuRayHit(s, 0, 0, 0, 1, 0, 0, 1.2, 0, scratch)).toBe(false);
    // Out of range.
    expect(menuRayHit(s, 0, 0, 0, 0, 0, -1, 0.3, 0, scratch)).toBe(false);
  });

  it('a closed (or still opening) panel never blocks, whatever the geometry', () => {
    const s = panel(0);
    expect(menuInteractive(s)).toBe(false);
    expect(menuRayHit(s, 0, 0, 0, 0, 0, -1, 1.2, 0.05, scratch)).toBe(false);
    s.opening = 1;
    expect(menuRayHit(s, 0, 0, 0, 0, 0, -1, 1.2, 0.05, scratch)).toBe(false);
  });

  it('reports the panel-frame hit point for ray clicks', () => {
    const s = panel(1);
    const xy = new Float32Array(2);
    const d = Math.hypot(0.04, 0.4);
    expect(menuRayHit(s, 0, 0, 0, 0.04 / d, 0, -0.4 / d, 1.2, 0, scratch, xy)).toBe(true);
    expect(xy[0]).toBeCloseTo(0.04, 6);
    expect(xy[1]).toBeCloseTo(0, 6);
  });

  it('respects the panel rotation (inverseRotate)', () => {
    // 90 degrees about Y: local +X is world -Z.
    const h = Math.SQRT1_2;
    const out = new Float32Array(3);
    inverseRotate(0, h, 0, h, 0, 0, -1, out);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[2]).toBeCloseTo(0, 6);
  });

  it('poke zone is the grown rect between front and behind limits', () => {
    expect(inPokeZone(0, 0, 0.05, 0.08, 0.07, 0.04, 0.1, 0.05)).toBe(true);
    expect(inPokeZone(0, 0, 0.2, 0.08, 0.07, 0.04, 0.1, 0.05)).toBe(false);
    expect(inPokeZone(0, 0, -0.06, 0.08, 0.07, 0.04, 0.1, 0.05)).toBe(false);
    expect(inPokeZone(0.13, 0, 0, 0.08, 0.07, 0.04, 0.1, 0.05)).toBe(false);
  });

  it('starts closed with nothing spent', () => {
    const s = new WristMenuState();
    expect(s.open).toBe(0);
    expect(s.tipNear).toBe(0);
    expect(s.consumeMask).toBe(0);
  });

  it('numbers MenuToggled after the round-9 events', () => {
    expect(GameEvent.MenuToggled).toBe(24);
  });
});

describe('tutorial menu lines', () => {
  it('asks to open the menu while it is closed, then names the button', () => {
    expect(tutorialLineFor(TutorialStep.Palette, TUTORIAL.lines, false).toLowerCase()).toContain('gem');
    expect(tutorialLineFor(TutorialStep.Palette, TUTORIAL.lines, true).toLowerCase()).toContain('colour');
    expect(tutorialLineFor(TutorialStep.Goo, TUTORIAL.lines, false)).toContain('menu');
    expect(tutorialLineFor(TutorialStep.Goo, TUTORIAL.lines, true)).toContain('GOO');
    expect(tutorialLineFor(TutorialStep.Tether, TUTORIAL.lines, true)).toContain('TETHER');
    for (const open of [false, true]) {
      for (const step of [TutorialStep.Palette, TutorialStep.Goo, TutorialStep.Tether]) {
        const line = tutorialLineFor(step, TUTORIAL.lines, open);
        expect(line.length).toBeLessThanOrEqual(40);
        expect(isPrintableAscii(line)).toBe(true);
      }
    }
  });
});
