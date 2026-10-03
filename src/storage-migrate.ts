// Round 9 rebrand (PaintBlast MR -> Splotopia): localStorage keys moved from
// `paintblast.*` to `splotopia.*`. Reads go through here so a returning player
// keeps their best score and blaster skin: the new key wins, otherwise the old
// key's value is copied forward under the new key and returned.

/** The minimal Storage surface the migration touches. */
export interface MigratingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Pre-rebrand key for the all-time best score. Read-only fallback. */
export const LEGACY_BEST_SCORE_STORAGE_KEY = 'paintblast.bestScore';
/** Pre-rebrand key for the selected blaster skin. Read-only fallback. */
export const LEGACY_SKIN_STORAGE_KEY = 'paintblast.blasterSkin';

/**
 * `storage.getItem(key)`, falling back to `legacyKey` (and copying that value
 * forward to `key`) when the new key has never been written.
 *
 * Never throws: blocked storage (private mode, third-party context) reads as
 * null, and a refused copy-forward still returns the legacy value.
 */
export function readWithLegacyFallback(
  storage: MigratingStorage | undefined | null,
  key: string,
  legacyKey: string,
): string | null {
  if (!storage) return null;
  let current: string | null;
  try {
    current = storage.getItem(key);
  } catch {
    return null;
  }
  if (current !== null) return current;

  let legacy: string | null;
  try {
    legacy = storage.getItem(legacyKey);
  } catch {
    return null;
  }
  if (legacy === null) return null;
  try {
    storage.setItem(key, legacy);
  } catch {
    // Copy-forward refused; the value is still good for this session.
  }
  return legacy;
}

/** `globalThis.localStorage`, or undefined where touching it throws. */
export function safeStorage(): MigratingStorage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}
