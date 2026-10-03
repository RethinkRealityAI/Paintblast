import { describe, it, expect } from 'vitest';
import { RENDER } from '../../src/config';

const inUnit = (v: number) => v >= 0 && v <= 1;

describe('RENDER config', () => {
  it('uses a tone curve main.ts knows how to apply', () => {
    expect(['none', 'neutral', 'aces', 'agx']).toContain(RENDER.toneMapping);
  });

  it('keeps the IBL and exposure positive', () => {
    expect(RENDER.iblIntensity).toBeGreaterThan(0);
    expect(RENDER.exposure).toBeGreaterThan(0);
    expect(Number.isFinite(RENDER.iblRotationYDeg)).toBe(true);
  });

  it('keeps every ball material factor in 0..1', () => {
    for (const v of [
      RENDER.ballRoughness,
      RENDER.ballClearcoat,
      RENDER.ballClearcoatRoughness,
      RENDER.webBallRoughness,
      RENDER.webBallClearcoatRoughness,
      ...RENDER.webBallColor,
      ...RENDER.webBallEmissive,
    ]) {
      expect(inUnit(v)).toBe(true);
    }
  });

  it('keeps the web ball white-ish and its self-light faint', () => {
    for (const channel of RENDER.webBallColor) {
      expect(channel).toBeGreaterThan(0.85);
    }
    for (const channel of RENDER.webBallEmissive) {
      expect(channel).toBeLessThan(0.2);
    }
  });

  it('keeps the robot polish subtle', () => {
    expect(RENDER.robotEnvBoost).toBeGreaterThan(0);
    expect(RENDER.robotEnvBoost).toBeLessThanOrEqual(2);
    expect(RENDER.robotRimStrength).toBeGreaterThanOrEqual(0);
    expect(RENDER.robotRimStrength).toBeLessThan(0.6);
    expect(RENDER.robotRimPower).toBeGreaterThan(0);
    for (const channel of RENDER.robotRimColor) {
      expect(inUnit(channel)).toBe(true);
    }
  });
});
