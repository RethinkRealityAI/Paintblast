import { describe, it, expect } from 'vitest';
import {
  ammoLabel,
  nextWebSubMode,
  packTetherData,
  unpackFiredHand,
  unpackTetherSlot,
  BallKind,
  BallStyle,
  GameEvent,
  INITIAL_PALETTE_SELECTION,
  WebSubMode,
  WEB_BALL_COLOR,
} from '../../src/types';
import { reelDistance,
  segmentPointDistSq,
} from '../../src/systems/TargetSystem';
import {
  createShotLoadout,
  resolveShot,
} from '../../src/systems/BallSpawnSystem';
import { TARGETS, WEB } from '../../src/config';

describe('WebSubMode', () => {
  it('numbers two modes without collisions', () => {
    const values = Object.values(WebSubMode);
    expect(values).toHaveLength(2);
    expect(new Set(values).size).toBe(2);
  });

  it('makes Splat the zero value', () => {
    // Ball.subStyle is an Int8 with a zero default and the signal is seeded
    // from the same constant, so a ball spawned by code that predates the
    // sub-mode has to mean "the round-5 web".
    expect(WebSubMode.Splat).toBe(0);
    expect(INITIAL_PALETTE_SELECTION.subMode).toBe(WebSubMode.Splat);
  });
});

describe('nextWebSubMode', () => {
  it('flips between the two modes', () => {
    expect(nextWebSubMode(WebSubMode.Splat)).toBe(WebSubMode.Tether);
    expect(nextWebSubMode(WebSubMode.Tether)).toBe(WebSubMode.Splat);
  });

  it('is its own inverse, so a double press is a no-op', () => {
    for (const mode of Object.values(WebSubMode)) {
      expect(nextWebSubMode(nextWebSubMode(mode))).toBe(mode);
    }
  });
});

describe('resolveShot with a sub-mode', () => {
  const shoot = (style: BallStyle, subMode?: WebSubMode) => {
    const out = createShotLoadout();
    if (subMode === undefined) {
      resolveShot(style, BallKind.Sticky, WEB_BALL_COLOR, out);
    } else {
      resolveShot(style, BallKind.Sticky, WEB_BALL_COLOR, out, subMode);
    }
    return out;
  };

  it('carries the sub-mode onto a web shot', () => {
    expect(shoot(BallStyle.Web, WebSubMode.Tether).subStyle).toBe(
      WebSubMode.Tether,
    );
    expect(shoot(BallStyle.Web, WebSubMode.Splat).subStyle).toBe(
      WebSubMode.Splat,
    );
  });

  it('forces paint to Splat however the selector is set', () => {
    // There is no such thing as a tethering paintball, and the wrist selector
    // is still sitting on whatever it was last set to while paint is loaded.
    expect(shoot(BallStyle.Paint, WebSubMode.Tether).subStyle).toBe(
      WebSubMode.Splat,
    );
  });

  it('defaults to Splat when no sub-mode is passed at all', () => {
    // The parameter is appended after `out` precisely so round-5 call sites
    // keep compiling AND keep behaving.
    expect(shoot(BallStyle.Web).subStyle).toBe(WebSubMode.Splat);
  });

  it('leaves a tether shot flying as an ordinary white web', () => {
    // In the air a tether is indistinguishable from a splat web: same colour,
    // same Normal physics, same strand. Only the robot contact differs.
    const tether = shoot(BallStyle.Web, WebSubMode.Tether);
    expect(tether.style).toBe(BallStyle.Web);
    expect(tether.kind).toBe(BallKind.Normal);
    expect(tether.color).toEqual(WEB_BALL_COLOR);
  });
});

describe('packTetherData', () => {
  it('round-trips every pool slot on both hands', () => {
    for (let slot = 0; slot < TARGETS.poolSize; slot++) {
      for (const hand of [0, 1]) {
        const data = packTetherData(slot, hand);
        expect(unpackTetherSlot(data)).toBe(slot);
        expect(unpackFiredHand(data)).toBe(hand === 1 ? 'right' : 'left');
      }
    }
  });

  it('shares the hand bit with the fired-data layout', () => {
    // Deliberate: FeedbackSystem reads the hand out of a tether event with the
    // same unpacker it uses on BallFired, so there is one convention, not two.
    expect(unpackFiredHand(packTetherData(0, 1))).toBe('right');
    expect(unpackFiredHand(packTetherData(7, 0))).toBe('left');
  });
});

describe('GameEvent tether additions', () => {
  it('appends the three tether events without renumbering anything', () => {
    expect(GameEvent.UiClick).toBe(11);
    expect(GameEvent.TetherAttached).toBe(12);
    expect(GameEvent.TetherReeled).toBe(13);
    expect(GameEvent.TetherPopped).toBe(14);
  });

  it('keeps every event value unique', () => {
    const values = Object.values(GameEvent);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('reelDistance', () => {
  const MIN = TARGETS.tetherMinReach;

  it('takes in exactly the metres asked for', () => {
    expect(reelDistance(3, 0.55, MIN)).toBeCloseTo(2.45, 6);
  });

  it('never drags the robot past the hand', () => {
    // Overshooting would sail it out behind the player, where the head-relative
    // kill test would still not have fired.
    expect(reelDistance(0.5, 10, MIN)).toBe(MIN);
    expect(reelDistance(MIN + 0.01, 5, MIN)).toBe(MIN);
  });

  it('leaves a robot already inside the minimum exactly where it is', () => {
    // Clamping to the minimum here would SHOVE it away, which is the opposite
    // of reeling.
    expect(reelDistance(MIN - 0.1, 1, MIN)).toBeCloseTo(MIN - 0.1, 6);
  });

  it('ignores a zero or negative pull rather than pushing', () => {
    expect(reelDistance(2, 0, MIN)).toBe(2);
    expect(reelDistance(2, -5, MIN)).toBe(2);
  });

  it('refuses to do anything with a degenerate distance', () => {
    expect(reelDistance(0, 1, MIN)).toBe(0);
    expect(reelDistance(-1, 1, MIN)).toBe(-1);
  });

  it('converges on the minimum under repeated hauls, and stops', () => {
    let d = WEB.tetherKillRadius + 3;
    for (let i = 0; i < 200; i++) d = reelDistance(d, WEB.reelQueueMax, MIN);
    expect(d).toBeCloseTo(MIN, 6);
  });

  it('brings a robot inside the kill radius before it hits the floor', () => {
    // If tetherMinReach were ever set above tetherKillRadius the reel would
    // stall just outside popping range and the tether could never resolve.
    expect(TARGETS.tetherMinReach).toBeLessThan(WEB.tetherKillRadius);
  });
});

describe('ammoLabel', () => {
  it('names each paint kind', () => {
    expect(ammoLabel(BallStyle.Paint, WebSubMode.Splat, BallKind.Normal)).toBe(
      'NORMAL',
    );
    expect(ammoLabel(BallStyle.Paint, WebSubMode.Splat, BallKind.Bouncy)).toBe(
      'BOUNCY',
    );
    expect(ammoLabel(BallStyle.Paint, WebSubMode.Splat, BallKind.Sticky)).toBe(
      'STICKY',
    );
    expect(ammoLabel(BallStyle.Paint, WebSubMode.Splat, BallKind.Splash)).toBe(
      'SPLASH',
    );
  });

  it('lets webbing override the paint kind', () => {
    expect(ammoLabel(BallStyle.Web, WebSubMode.Splat, BallKind.Sticky)).toBe(
      'GOO',
    );
  });

  it('lets the sub-mode override the word GOO', () => {
    expect(ammoLabel(BallStyle.Web, WebSubMode.Tether, BallKind.Sticky)).toBe(
      'TETHER',
    );
  });

  it('ignores the sub-mode entirely while paint is loaded', () => {
    // The selector keeps its setting under the paint, so the footer must not
    // start saying TETHER the moment someone picks a colour.
    expect(ammoLabel(BallStyle.Paint, WebSubMode.Tether, BallKind.Normal)).toBe(
      'NORMAL',
    );
  });

  it('is ASCII and uppercase everywhere (the MSDF font has no fancy glyphs)', () => {
    for (const style of Object.values(BallStyle)) {
      for (const subMode of Object.values(WebSubMode)) {
        for (const kind of Object.values(BallKind)) {
          const label = ammoLabel(style, subMode, kind);
          expect(label.length).toBeGreaterThan(0);
          // eslint-disable-next-line no-control-regex
          expect(/^[\x20-\x7E]+$/.test(label)).toBe(true);
          expect(label).toBe(label.toUpperCase());
        }
      }
    }
  });
});

describe('segmentPointDistSq (swept robot hit test)', () => {
  it('is the plain point distance for a zero-length segment', () => {
    expect(segmentPointDistSq(1, 2, 3, 1, 2, 3, 1, 2, 5)).toBeCloseTo(4);
  });

  it('catches a ball that stepped clean through the robot this frame', () => {
    // 2.6 m in one frame, passing 5 cm from the robot centre: a point test at
    // either end misses by metres; the swept test does not.
    const d = segmentPointDistSq(0, 1, 0, 0, 1, -2.6, 0.05, 1, -1.3);
    expect(Math.sqrt(d)).toBeCloseTo(0.05, 6);
  });

  it('clamps to the ends of the segment', () => {
    expect(segmentPointDistSq(0, 0, 0, 1, 0, 0, -1, 0, 0)).toBeCloseTo(1);
    expect(segmentPointDistSq(0, 0, 0, 1, 0, 0, 3, 0, 0)).toBeCloseTo(4);
  });
});
