import { describe, it, expect } from 'vitest';
import {
  canFireInPhase,
  createShotLoadout,
  resolveShot,
} from '../../src/systems/BallSpawnSystem';
import {
  BallKind,
  BallStyle,
  GamePhase,
  PALETTE_CHIP_ORDER,
  PALETTE_COLORS,
  WEB_BALL_COLOR,
} from '../../src/types';
import { FIRE } from '../../src/config';

const RED = PALETTE_COLORS[0];

describe('resolveShot', () => {
  const shoot = (style: BallStyle, kind: BallKind, color = RED) => {
    const out = createShotLoadout();
    resolveShot(style, kind, color, out);
    return out;
  };

  it('passes paint straight through, both axes untouched', () => {
    for (const color of PALETTE_COLORS) {
      for (const kind of [
        BallKind.Normal,
        BallKind.Bouncy,
        BallKind.Sticky,
        BallKind.Splash,
      ]) {
        const shot = shoot(BallStyle.Paint, kind, color);
        expect(shot.style).toBe(BallStyle.Paint);
        expect(shot.kind).toBe(kind);
        expect(shot.color).toBe(color);
      }
    }
  });

  it('overrides both paint axes when webbing is loaded', () => {
    // There is no such thing as red webbing, and a bouncing web that
    // ricocheted round the room would be a different toy. So the loaded colour
    // and kind are ignored for the shot — but see the next test.
    for (const kind of [BallKind.Bouncy, BallKind.Sticky, BallKind.Splash]) {
      const shot = shoot(BallStyle.Web, kind);
      expect(shot.style).toBe(BallStyle.Web);
      expect(shot.kind).toBe(BallKind.Normal);
      expect(shot.color).toEqual(WEB_BALL_COLOR);
    }
  });

  it('does not disturb the paint the player had loaded', () => {
    // The palette keeps its selection while webbing, so picking a paint chip
    // hands the old loadout straight back rather than resetting it.
    const paint = shoot(BallStyle.Paint, BallKind.Sticky, RED);
    shoot(BallStyle.Web, BallKind.Sticky, RED);
    const again = shoot(BallStyle.Paint, BallKind.Sticky, RED);
    expect(again).toEqual(paint);
  });

  it('reuses the caller-owned out object rather than allocating', () => {
    const out = createShotLoadout();
    const before = out;
    resolveShot(BallStyle.Web, BallKind.Splash, RED, out);
    expect(out).toBe(before);
  });

  it('resolves every chip on the palette to a firable loadout', () => {
    for (const chip of PALETTE_CHIP_ORDER) {
      const shot = shoot(chip.style, chip.kind);
      expect(shot.style).toBe(chip.style);
      expect(shot.color).toHaveLength(4);
      // Kind always has to be a real BALL_KIND_CONFIG key, web chip included.
      expect([
        BallKind.Normal,
        BallKind.Bouncy,
        BallKind.Sticky,
        BallKind.Splash,
      ]).toContain(shot.kind);
    }
  });
});

describe('canFireInPhase', () => {
  it('allows firing in the round, in Chill, and in the Idle sandbox', () => {
    expect(canFireInPhase(GamePhase.Playing, true)).toBe(true);
    expect(canFireInPhase(GamePhase.Chill, true)).toBe(true);
    expect(canFireInPhase(GamePhase.Idle, true)).toBe(true);
  });

  it('never allows firing during the countdown or the summary', () => {
    // With the Web phase gone, this list is the only thing standing between a
    // thwip and webbing thrown across the round-over screen.
    expect(canFireInPhase(GamePhase.Countdown, true)).toBe(false);
    expect(canFireInPhase(GamePhase.GameOver, true)).toBe(false);
  });

  it('honours the sandbox switch for Idle only', () => {
    expect(canFireInPhase(GamePhase.Idle, false)).toBe(false);
    expect(canFireInPhase(GamePhase.Playing, false)).toBe(true);
    expect(canFireInPhase(GamePhase.Chill, false)).toBe(true);
  });

  it('agrees with the shipped config, which opens the Idle sandbox', () => {
    expect(FIRE.sandboxFireInIdle).toBe(true);
    expect(canFireInPhase(GamePhase.Idle, FIRE.sandboxFireInIdle)).toBe(true);
  });

  it('covers every phase without falling through to a truthy default', () => {
    // A phase added later must default to "no firing" until someone decides
    // otherwise, rather than silently inheriting the sandbox.
    const allowed = Object.values(GamePhase).filter((phase) =>
      canFireInPhase(phase, true),
    );
    expect(allowed.sort()).toEqual(
      [GamePhase.Idle, GamePhase.Playing, GamePhase.Chill].sort(),
    );
  });
});
