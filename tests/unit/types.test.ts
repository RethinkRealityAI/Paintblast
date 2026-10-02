import { describe, it, expect } from 'vitest';
import {
  BallKind,
  BallStyle,
  BALL_KIND_NAMES,
  GameEvent,
  GamePhase,
  PALETTE_COLORS,
  PALETTE_CHIP_ORDER,
  PALETTE_DAB_ORDER,
  PALETTE_KIND_ORDER,
  PALETTE_DAB_COUNT,
  PALETTE_CHIP_COUNT,
  PALETTE_PRESSABLE_COUNT,
  INITIAL_PALETTE_SELECTION,
  INITIAL_HUD_STATE,
  WEB_BALL_COLOR,
  packFiredData,
  packImpactData,
  unpackFiredHand,
  unpackFiredStyle,
  unpackImpactKind,
  unpackImpactRgb,
  unpackImpactStyle,
  srgbToLinear,
  syncBlasterMode,
  BlasterMode,
  BLASTER_MODE_ORDER,
  BLASTER_MODE_LABELS,
} from '../../src/types';

describe('BallKind', () => {
  it('maps the four ball kinds to sequential integers 0..3', () => {
    expect(BallKind.Normal).toBe(0);
    expect(BallKind.Bouncy).toBe(1);
    expect(BallKind.Sticky).toBe(2);
    expect(BallKind.Splash).toBe(3);
  });

  it('names every ball kind', () => {
    expect(BALL_KIND_NAMES[BallKind.Normal]).toBe('normal');
    expect(BALL_KIND_NAMES[BallKind.Bouncy]).toBe('bouncy');
    expect(BALL_KIND_NAMES[BallKind.Sticky]).toBe('sticky');
    expect(BALL_KIND_NAMES[BallKind.Splash]).toBe('splash');
  });
});

describe('palette constants', () => {
  it('declares 4 base colors', () => {
    expect(PALETTE_COLORS).toHaveLength(4);
  });

  it('stores each color as an RGBA tuple in [0,1]', () => {
    for (const color of PALETTE_COLORS) {
      expect(color).toHaveLength(4);
      for (const channel of color) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is 4 dabs plus 5 chips = 9 pressables, down from the old 16-orb grid', () => {
    // Round 3 split colour from kind: choosing them separately is far fewer
    // controls than one per combination. Round 5 added the fifth chip, WEB.
    expect(PALETTE_DAB_COUNT).toBe(4);
    expect(PALETTE_CHIP_COUNT).toBe(5);
    expect(PALETTE_PRESSABLE_COUNT).toBe(9);
  });

  it('gives every paint colour exactly one dab', () => {
    expect(PALETTE_DAB_ORDER).toHaveLength(PALETTE_COLORS.length);
    const seen = new Set(PALETTE_DAB_ORDER.map((color) => color.join(',')));
    expect(seen.size).toBe(PALETTE_DAB_ORDER.length);
  });

  it('gives every ball kind exactly one paint chip', () => {
    const kinds = [
      BallKind.Normal,
      BallKind.Bouncy,
      BallKind.Sticky,
      BallKind.Splash,
    ];
    expect([...PALETTE_KIND_ORDER].sort()).toEqual([...kinds].sort());
    expect(new Set(PALETTE_KIND_ORDER).size).toBe(kinds.length);
  });

  it('starts the player on the first dab and the first chip', () => {
    // BallSpawnSystem adopts the first dab to qualify as its colour selection
    // and main.ts pre-highlights the first chip, so the seeded signals have to
    // match or the highlight lies about what is loaded.
    expect(INITIAL_PALETTE_SELECTION.color).toBe(PALETTE_DAB_ORDER[0]);
    expect(INITIAL_PALETTE_SELECTION.kind).toBe(PALETTE_CHIP_ORDER[0].kind);
    expect(INITIAL_PALETTE_SELECTION.style).toBe(PALETTE_CHIP_ORDER[0].style);
    // ...and it must be a PAINT chip, or the game opens loaded with webbing.
    expect(INITIAL_PALETTE_SELECTION.style).toBe(BallStyle.Paint);
  });
});

describe('PALETTE_CHIP_ORDER', () => {
  it('is the four paint kinds plus exactly one web chip', () => {
    expect(PALETTE_CHIP_ORDER).toHaveLength(5);
    const web = PALETTE_CHIP_ORDER.filter(
      (chip) => chip.style === BallStyle.Web,
    );
    expect(web).toHaveLength(1);
    expect(web[0].label).toBe('WEB');
  });

  it('gives every chip its own identity colour, as a full hex triple', () => {
    // Round 4 shipped one neutral colour for the whole row and the field said
    // the chips looked bad. Duplicates here would put that back one chip at a
    // time, so uniqueness is asserted rather than assumed.
    const colors = PALETTE_CHIP_ORDER.map((chip) => chip.color.toLowerCase());
    for (const color of colors) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(new Set(colors).size).toBe(PALETTE_CHIP_ORDER.length);
  });

  it('labels every chip in short unique ASCII caps', () => {
    const labels = PALETTE_CHIP_ORDER.map((chip) => chip.label);
    for (const label of labels) {
      // The label is baked into a CanvasTexture rather than the MSDF font, so
      // it is not strictly ASCII-bound — but the row is 3.6 cm wide per chip
      // and anything long or exotic simply will not fit or render.
      expect(label).toMatch(/^[A-Z]{2,7}$/);
    }
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('derives PALETTE_KIND_ORDER from the same table, in the same order', () => {
    expect([...PALETTE_KIND_ORDER]).toEqual(
      PALETTE_CHIP_ORDER.filter((chip) => chip.style === BallStyle.Paint).map(
        (chip) => chip.kind,
      ),
    );
  });
});

describe('BallStyle', () => {
  it('leaves paint at 0, so every pre-round-4 ball is unchanged', () => {
    // The Ball component defaults `style` to Paint. Anything that spawns a ball
    // without naming a style must still get paint routing, and that only holds
    // if Paint is the zero value.
    expect(BallStyle.Paint).toBe(0);
    expect(BallStyle.Web).toBe(1);
  });

  it('is a separate axis from BallKind, not a fifth kind', () => {
    // Style says which splat pool the ball lands in; kind says how it flies.
    // Collapsing them would have forced webbing into BALL_KIND_CONFIG and
    // BALL_KIND_NAMES, neither of which has anything useful to say about it.
    expect(new Set(Object.values(BallStyle)).size).toBe(2);
    expect(Object.keys(BALL_KIND_NAMES)).toHaveLength(4);
  });

  it('makes web ammo plain white', () => {
    expect(WEB_BALL_COLOR).toEqual([1, 1, 1, 1]);
  });
});

describe('GameEvent', () => {
  it('numbers every event uniquely', () => {
    const values = Object.values(GameEvent);
    expect(new Set(values).size).toBe(values.length);
  });

  it('appended UiClick rather than renumbering the round-2 events', () => {
    // Anything that persisted or asserted an event number still means what it
    // used to; FeedbackSystem switches on these values directly.
    expect(GameEvent.BallFired).toBe(0);
    expect(GameEvent.AmmoSelected).toBe(4);
    expect(GameEvent.ComboMilestone).toBe(10);
    expect(GameEvent.UiClick).toBe(11);
  });
});

describe('INITIAL_HUD_STATE', () => {
  it('starts at score 0 and points at both ways in', () => {
    expect(INITIAL_HUD_STATE.score).toBe(0);
    expect(INITIAL_HUD_STATE.timer).toMatch(/^\d+:\d{2}$/);
    expect(INITIAL_HUD_STATE.status).toContain('START');
    expect(INITIAL_HUD_STATE.status).toContain('CHILL');
  });

  it('stays ASCII — the bundled MSDF font has no typographic glyphs', () => {
    // A curly quote or an em-dash here renders as a hole in the panel.
    expect(/^[\x20-\x7E]+$/.test(INITIAL_HUD_STATE.status)).toBe(true);
    expect(/^[\x20-\x7E]+$/.test(INITIAL_HUD_STATE.timer)).toBe(true);
  });
});

describe('GamePhase', () => {
  it('numbers the five phases without collisions', () => {
    const values = Object.values(GamePhase);
    expect(values).toHaveLength(5);
    expect(new Set(values).size).toBe(5);
  });

  it('keeps the round phases at their original values', () => {
    // Chill (round 3) was appended rather than inserted, and round 5 deleted
    // the phase after it rather than renumbering: anything that persisted a
    // phase number still means what it used to.
    expect(GamePhase.Idle).toBe(0);
    expect(GamePhase.Countdown).toBe(1);
    expect(GamePhase.Playing).toBe(2);
    expect(GamePhase.GameOver).toBe(3);
    expect(GamePhase.Chill).toBe(4);
  });

  it('has no Web phase - webbing is ammo, not a mode', () => {
    // Round 5's headline change, and asserted as an absence because the whole
    // field report was that a mode you enter and leave cannot give you "web
    // mode AND chill mode, same interactions". Re-adding the phase is the first
    // step back toward that. @see BallStyle
    expect('Web' in GamePhase).toBe(false);
    expect(Object.values(GamePhase)).not.toContain(5);
  });
});

describe('BallImpact data packing', () => {
  it('round-trips every palette colour with every ball kind', () => {
    for (const color of PALETTE_COLORS) {
      for (const kind of [
        BallKind.Normal,
        BallKind.Bouncy,
        BallKind.Sticky,
        BallKind.Splash,
      ]) {
        const packed = packImpactData(kind, color[0], color[1], color[2]);
        expect(unpackImpactKind(packed)).toBe(kind);

        const rgb = unpackImpactRgb(packed);
        expect((rgb >> 16) & 0xff).toBe(Math.round(color[0] * 255));
        expect((rgb >> 8) & 0xff).toBe(Math.round(color[1] * 255));
        expect(rgb & 0xff).toBe(Math.round(color[2] * 255));
      }
    }
  });

  it('survives white, where the packed word goes negative', () => {
    const packed = packImpactData(BallKind.Splash, 1, 1, 1);
    expect(packed).toBeLessThan(0);
    expect(unpackImpactKind(packed)).toBe(BallKind.Splash);
    expect(unpackImpactRgb(packed)).toBe(0xffffff);
  });

  it('survives the Int32Array round trip the event buffer does', () => {
    const storage = new Int32Array(1);
    storage[0] = packImpactData(BallKind.Bouncy, 0.28, 0.86, 0.98);
    expect(unpackImpactKind(storage[0])).toBe(BallKind.Bouncy);
    expect(unpackImpactRgb(storage[0])).toBe(0x47dbfa);
  });

  it('handles black and clamps out-of-range channels', () => {
    expect(unpackImpactRgb(packImpactData(BallKind.Normal, 0, 0, 0))).toBe(0);
    expect(unpackImpactRgb(packImpactData(BallKind.Normal, 5, -3, 0.5))).toBe(
      0xff0080,
    );
  });

  it('defaults to paint, so a caller that names no style is unchanged', () => {
    const packed = packImpactData(BallKind.Sticky, 0.5, 0.5, 0.5);
    expect(unpackImpactStyle(packed)).toBe(BallStyle.Paint);
    expect(unpackImpactKind(packed)).toBe(BallKind.Sticky);
  });

  it('carries the style without disturbing the kind or the colour', () => {
    // The style bit lives inside the kind byte (bit 7), because the colour
    // already fills the top 24. Every kind has to survive that.
    for (const kind of [
      BallKind.Normal,
      BallKind.Bouncy,
      BallKind.Sticky,
      BallKind.Splash,
    ]) {
      for (const style of [BallStyle.Paint, BallStyle.Web]) {
        const packed = packImpactData(kind, 0.28, 0.86, 0.98, style);
        expect(unpackImpactKind(packed)).toBe(kind);
        expect(unpackImpactStyle(packed)).toBe(style);
        expect(unpackImpactRgb(packed)).toBe(0x47dbfa);
      }
    }
  });

  it('survives the Int32Array round trip with the style bit set', () => {
    const storage = new Int32Array(1);
    storage[0] = packImpactData(BallKind.Normal, 1, 1, 1, BallStyle.Web);
    expect(unpackImpactStyle(storage[0])).toBe(BallStyle.Web);
    expect(unpackImpactKind(storage[0])).toBe(BallKind.Normal);
    expect(unpackImpactRgb(storage[0])).toBe(0xffffff);
  });
});

describe('BallFired data packing', () => {
  it('round-trips every hand and style combination', () => {
    for (const [hand, side] of [
      [0, 'left'],
      [1, 'right'],
    ] as const) {
      for (const style of [BallStyle.Paint, BallStyle.Web]) {
        const packed = packFiredData(BallKind.Bouncy, hand, style);
        expect(unpackFiredHand(packed)).toBe(side);
        expect(unpackFiredStyle(packed)).toBe(style);
        expect(packed & 0xff).toBe(BallKind.Bouncy);
      }
    }
  });

  it('keeps the round-2 hand bit exactly where it was', () => {
    // FeedbackSystem has read bit 8 as the firing hand since Wave B; round 5
    // added the style above it rather than repacking, so a paint shot's word
    // is byte-identical to what round 4 emitted.
    expect(packFiredData(BallKind.Splash, 1, BallStyle.Paint)).toBe(
      BallKind.Splash | (1 << 8),
    );
    expect(packFiredData(BallKind.Splash, 0, BallStyle.Paint)).toBe(
      BallKind.Splash,
    );
  });
});

describe('srgbToLinear', () => {
  it('pins black and white', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 10);
  });

  it('matches the sRGB transfer curve on both branches', () => {
    expect(srgbToLinear(0.04)).toBeCloseTo(0.04 / 12.92, 8);
    // Mid-grey 0.5 sRGB is ~0.214 linear.
    expect(srgbToLinear(0.5)).toBeCloseTo(0.2140, 3);
  });

  it('darkens every palette channel that is not 0 or 1', () => {
    // The round-7 pastel bug in one line: treated as linear, these rendered
    // brighter (washed out) than the HUD swatch that shows them as sRGB.
    for (const colour of PALETTE_COLORS) {
      for (let c = 0; c < 3; c++) {
        const v = colour[c];
        if (v > 0 && v < 1) expect(srgbToLinear(v)).toBeLessThan(v);
      }
    }
  });
});

describe('syncBlasterMode', () => {
  it('web style always means web mode', () => {
    expect(syncBlasterMode(BlasterMode.Hand, true, BlasterMode.Hand)).toBe(
      BlasterMode.Web,
    );
  });

  it('leaving web returns to the remembered paint mode', () => {
    expect(syncBlasterMode(BlasterMode.Web, false, BlasterMode.Hand)).toBe(
      BlasterMode.Hand,
    );
    expect(syncBlasterMode(BlasterMode.Web, false, BlasterMode.Paint)).toBe(
      BlasterMode.Paint,
    );
  });

  it('never returns to web as a paint mode', () => {
    expect(syncBlasterMode(BlasterMode.Web, false, BlasterMode.Web)).toBe(
      BlasterMode.Paint,
    );
  });

  it('leaves a paint mode alone while style stays paint', () => {
    expect(syncBlasterMode(BlasterMode.Hand, false, BlasterMode.Paint)).toBe(
      BlasterMode.Hand,
    );
  });

  it('has an ASCII label per mode, in pad order', () => {
    for (const mode of BLASTER_MODE_ORDER) {
      expect(/^[A-Z]+$/.test(BLASTER_MODE_LABELS[mode])).toBe(true);
    }
  });
});
