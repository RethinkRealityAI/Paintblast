import { describe, expect, it } from 'vitest';

import { BLASTER } from '../../src/config';
import {
  LEGACY_BEST_SCORE_STORAGE_KEY,
  LEGACY_SKIN_STORAGE_KEY,
  readWithLegacyFallback,
} from '../../src/storage-migrate';
import { BEST_SCORE_STORAGE_KEY } from '../../src/systems/GameStateSystem';

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe('Splotopia storage keys', () => {
  it('uses splotopia.* keys, with the old paintblast.* keys as fallbacks', () => {
    expect(BEST_SCORE_STORAGE_KEY).toBe('splotopia.bestScore');
    expect(BLASTER.skinStorageKey).toBe('splotopia.blasterSkin');
    expect(LEGACY_BEST_SCORE_STORAGE_KEY).toBe('paintblast.bestScore');
    expect(LEGACY_SKIN_STORAGE_KEY).toBe('paintblast.blasterSkin');
  });
});

describe('readWithLegacyFallback', () => {
  it('prefers the new key when it is set', () => {
    const s = memoryStorage({ new: '7', old: '3' });
    expect(readWithLegacyFallback(s, 'new', 'old')).toBe('7');
  });

  it('falls back to the legacy key and copies it forward', () => {
    const s = memoryStorage({ 'paintblast.bestScore': '4200' });
    expect(
      readWithLegacyFallback(s, BEST_SCORE_STORAGE_KEY, LEGACY_BEST_SCORE_STORAGE_KEY),
    ).toBe('4200');
    expect(s.map.get(BEST_SCORE_STORAGE_KEY)).toBe('4200');
  });

  it('returns null when neither key exists, without writing', () => {
    const s = memoryStorage();
    expect(readWithLegacyFallback(s, 'new', 'old')).toBeNull();
    expect(s.map.size).toBe(0);
  });

  it('returns null for missing or throwing storage', () => {
    expect(readWithLegacyFallback(undefined, 'new', 'old')).toBeNull();
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readWithLegacyFallback(throwing, 'new', 'old')).toBeNull();
  });

  it('still returns the legacy value when the copy-forward is refused', () => {
    const s = {
      getItem: (k: string) => (k === 'old' ? '2' : null),
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(readWithLegacyFallback(s, 'new', 'old')).toBe('2');
  });
});
