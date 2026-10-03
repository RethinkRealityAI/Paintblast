import { describe, expect, it } from 'vitest';

import { paletteLabelText } from '../../src/systems/WristPaletteSystem';
import { BLASTER_MODE_LABELS, BlasterMode, PALETTE_CHIP_ORDER } from '../../src/types';

describe('paletteLabelText (round 9 rebrand)', () => {
  it('prints the web launcher and chip as GOO, the gesture as FLICK', () => {
    expect(paletteLabelText('WEB')).toBe('GOO');
    expect(paletteLabelText('THWIP')).toBe('FLICK');
  });

  it('leaves every other label alone', () => {
    for (const l of ['HAND', 'BLASTER', 'NORMAL', 'BOUNCY', 'STICKY', 'SPLASH', 'GOO']) {
      expect(paletteLabelText(l)).toBe(l);
    }
  });

  it('never prints WEB anywhere on the board, and stays ASCII', () => {
    const printed = [
      ...PALETTE_CHIP_ORDER.map((c) => paletteLabelText(c.label)),
      paletteLabelText(BLASTER_MODE_LABELS[BlasterMode.Web]),
    ];
    for (const text of printed) {
      expect(text).not.toMatch(/WEB|THWIP/);
      expect(/^[\x20-\x7E]+$/.test(text)).toBe(true);
    }
  });
});
