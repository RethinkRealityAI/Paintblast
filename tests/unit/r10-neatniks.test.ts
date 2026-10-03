import { describe, it, expect, vi } from 'vitest';
import { signal } from '@preact/signals-core';
import {
  DIRECTOR_TUNING,
  PipLook,
  TargetSystem,
  archetypePoolCounts,
  bossDue,
  chipShield,
  directorCap,
  directorReady,
  hudBandWeight,
  inWaveBreather,
  nextPatrolIndex,
  patrolLegLength,
  patrolOffsets,
  patrolPathPoint,
  pickWeighted,
  pipLook,
  pipX,
  shieldStillUp,
  strafeOffset,
  waveIndexAt,
  wearsHpBar,
} from '../../src/systems/TargetSystem';
import type { DirectorTuning } from '../../src/systems/TargetSystem';
import { COACH, GAME, NEATNIKS, ROOM, TARGETS } from '../../src/config';
import type { NeatnikWave } from '../../src/config';
import {
  GameEvent,
  GameEventBuffer,
  GamePhase,
  Neatnik,
} from '../../src/types';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Pacing: a pure simulation of the spawn director over a whole round.
// ---------------------------------------------------------------------------

/** Tiny deterministic PRNG (mulberry32) so the simulation is repeatable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimBot {
  arch: number;
  slot: number;
  popAt: number;
}

interface SimResult {
  /** Longest stretch, seconds, with zero bots alive (after t = 0). */
  maxEmptyGap: number;
  spawns: number;
  pops: number;
  /** Most bots alive at once, boss split excluded from the cap. */
  peakAlive: number;
  bossSpawned: boolean;
}

/**
 * Mirrors TargetSystem.directSpawns + popSlot + the pool cooldown, with a
 * player who pops every small bot `popAfterSec` after it appears (0 =
 * instantly: the worst case for an empty arena) and the boss after
 * `bossHits` hits at `bossHitEverySec`.
 */
function simulateRound(
  popAfterSec: number,
  seed: number,
  t: DirectorTuning = DIRECTOR_TUNING,
  waves: ReadonlyArray<NeatnikWave> = NEATNIKS.waves,
  dt = 1 / 72,
): SimResult {
  const rand = rng(seed);
  const pools = archetypePoolCounts();
  // Per archetype, per slot: busy until (absolute seconds).
  const busyUntil = pools.map((n) => new Array<number>(n).fill(-1));
  const alive: SimBot[] = [];
  let nextSpawnAt = 0;
  let lastPopAt = 0;
  let bossSpawned = false;
  let emptySince = -1;
  let maxEmptyGap = 0;
  let spawns = 0;
  let pops = 0;
  let peakAlive = 0;
  const cooldown = TARGETS.popDurationSec + TARGETS.respawnDelaySec;
  const bossHits = NEATNIKS.archetypes.duke.hp;

  const freeSlot = (arch: number, now: number): number => {
    const slots = busyUntil[arch];
    for (let i = 0; i < slots.length; i++) if (slots[i] < 0 || now >= slots[i]) return i;
    return -1;
  };
  const spawn = (arch: number, now: number, popAt: number): boolean => {
    const slot = freeSlot(arch, now);
    if (slot < 0) return false;
    busyUntil[arch][slot] = Infinity;
    alive.push({ arch, slot, popAt });
    spawns++;
    return true;
  };

  for (let now = 0; now < GAME.roundSec; now += dt) {
    const timeLeft = GAME.roundSec - now;
    // The player pops whatever is due.
    for (let i = alive.length - 1; i >= 0; i--) {
      const bot = alive[i];
      if (now < bot.popAt) continue;
      alive.splice(i, 1);
      busyUntil[bot.arch][bot.slot] = now + cooldown;
      nextSpawnAt = Math.max(nextSpawnAt, now + t.refillDelaySec);
      lastPopAt = now;
      pops++;
      if (bot.arch === Neatnik.DusterDuke) {
        spawn(Neatnik.Mopsy, now, now + popAfterSec);
        spawn(Neatnik.Mopsy, now, now + popAfterSec);
      }
    }
    if (bossDue(timeLeft, t.bossEnterAtSecLeft, bossSpawned)) {
      bossSpawned = spawn(
        Neatnik.DusterDuke,
        now,
        now + NEATNIKS.boss.dropSec + bossHits * 0.4,
      );
    }
    const dukeAlive = alive.filter((b) => b.arch === Neatnik.DusterDuke).length;
    const elapsed = GAME.roundSec - timeLeft;
    const cap = directorCap(elapsed, timeLeft, waves, dukeAlive, t);
    if (directorReady(now, alive.length, cap, nextSpawnAt, lastPopAt, t.emptyRefillSec)) {
      const inBoss = timeLeft <= t.bossEnterAtSecLeft;
      const weights = inBoss
        ? NEATNIKS.boss.companionWeights
        : waves[waveIndexAt(elapsed, waves)].weights;
      const arch = pickWeighted(weights, rand());
      if (!spawn(arch, now, now + popAfterSec)) {
        for (const other of [Neatnik.Mopsy, Neatnik.Squeegee, Neatnik.Peekaboo]) {
          if (other !== arch && spawn(other, now, now + popAfterSec)) break;
        }
      }
      nextSpawnAt = now + t.spawnStaggerSec;
    }
    peakAlive = Math.max(peakAlive, alive.length);

    if (alive.length === 0) {
      if (emptySince < 0) emptySince = now;
      maxEmptyGap = Math.max(maxEmptyGap, now - emptySince + dt);
    } else {
      emptySince = -1;
    }
  }
  return { maxEmptyGap, spawns, pops, peakAlive, bossSpawned };
}

describe('round 10 pacing: the arena never sits empty', () => {
  it('keeps every zero-bot gap under 0.8 s over a 90 s round of instant pops', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const r = simulateRound(0, seed);
      expect(r.maxEmptyGap).toBeLessThan(0.8);
      expect(r.bossSpawned).toBe(true);
    }
  });

  it('stays under 0.8 s for a fast human too (pops 0.6 s after each spawn)', () => {
    for (let seed = 1; seed <= 8; seed++) {
      expect(simulateRound(0.6, seed).maxEmptyGap).toBeLessThan(0.8);
    }
  });

  it('round 9 tuning failed the same test (3 s breather, 1.5 s refill)', () => {
    const r9: DirectorTuning = {
      ...DIRECTOR_TUNING,
      refillDelaySec: 1.5,
      emptyRefillSec: 1.5,
      spawnStaggerSec: 0.45,
      waveBreatherSec: 3,
      breatherKeepAlive: 0,
      bossCompanionsMax: 2,
    };
    // breatherKeepAlive 0 is clamped to 1 by directorCap, so model R9's hard
    // stop by checking its refill gap alone: it is already over budget.
    expect(simulateRound(0, 3, r9).maxEmptyGap).toBeGreaterThan(0.8);
  });

  it('keeps refilling while a slow player leaves bots up (never over the cap)', () => {
    const r = simulateRound(4, 5);
    expect(r.peakAlive).toBeLessThanOrEqual(TARGETS.maxConcurrent + 2);
    expect(r.spawns).toBeGreaterThan(20);
  });

  it('budgets the empty refill well inside the 0.8 s target', () => {
    expect(NEATNIKS.emptyRefillSec + 1 / 72).toBeLessThan(0.8);
    expect(NEATNIKS.refillDelaySec).toBeLessThan(0.8);
    expect(NEATNIKS.spawnStaggerSec).toBeGreaterThan(0.1); // still staggered
    expect(NEATNIKS.waveBreatherSec).toBeLessThanOrEqual(1);
    expect(NEATNIKS.breatherKeepAlive).toBeGreaterThanOrEqual(1);
  });
});

describe('directorCap / directorReady', () => {
  const waves: NeatnikWave[] = [
    { startSec: 0, maxAlive: 3, weights: [1, 0, 0] },
    { startSec: 20, maxAlive: 5, weights: [1, 1, 1] },
  ];
  const t: DirectorTuning = {
    ...DIRECTOR_TUNING,
    waveBreatherSec: 1,
    breatherKeepAlive: 2,
    maxConcurrent: 5,
    bossEnterAtSecLeft: 20,
    bossCompanionsMax: 3,
  };

  it('uses the wave cap, thinned (not zeroed) in a breather', () => {
    expect(directorCap(5, 85, waves, 0, t)).toBe(3);
    expect(directorCap(20.5, 69.5, waves, 0, t)).toBe(2);
    expect(directorCap(21.5, 68.5, waves, 0, t)).toBe(5);
    expect(inWaveBreather(20.5, waves, 1)).toBe(true);
  });

  it('never returns 0 inside a breather, even with keepAlive 0', () => {
    expect(directorCap(20.5, 69.5, waves, 0, { ...t, breatherKeepAlive: 0 })).toBe(1);
  });

  it('boss phase keeps companions + the Duke, capped by maxConcurrent', () => {
    expect(directorCap(75, 15, waves, 1, t)).toBe(4);
    expect(directorCap(75, 15, waves, 0, t)).toBe(3);
    expect(directorCap(75, 15, waves, 1, { ...t, bossCompanionsMax: 9 })).toBe(5);
  });

  it('staggers normal refills but rushes an empty arena', () => {
    // Below cap with bots up: waits for nextSpawnAt.
    expect(directorReady(10, 2, 4, 10.3, 9.9, 0.2)).toBe(false);
    expect(directorReady(10.3, 2, 4, 10.3, 9.9, 0.2)).toBe(true);
    // Empty: ignores nextSpawnAt, waits only emptyRefillSec after the last pop.
    expect(directorReady(10, 0, 4, 11, 9.9, 0.2)).toBe(false);
    expect(directorReady(10.1, 0, 4, 11, 9.9, 0.2)).toBe(true);
    // At cap: never.
    expect(directorReady(99, 4, 4, 0, 0, 0)).toBe(false);
  });

  it('escalates the shipped waves by count and mix, not by gaps', () => {
    const w = NEATNIKS.waves;
    for (let i = 1; i < w.length; i++) {
      expect(w[i].maxAlive).toBeGreaterThanOrEqual(w[i - 1].maxAlive);
      const tough = (x: NeatnikWave) =>
        (x.weights[1] + x.weights[2]) / (x.weights[0] + x.weights[1] + x.weights[2]);
      expect(tough(w[i])).toBeGreaterThanOrEqual(tough(w[i - 1]));
    }
    expect(w[w.length - 1].maxAlive).toBeGreaterThan(w[0].maxAlive);
  });
});

// ---------------------------------------------------------------------------
// Duster Duke's patrol
// ---------------------------------------------------------------------------

describe('Duke patrol helpers', () => {
  it('spreads points evenly over the arc with one in the middle', () => {
    const out = new Float32Array(6);
    expect(patrolOffsets(3, 100, out)).toBe(3);
    expect(out[0]).toBeCloseTo(-50 * DEG);
    expect(out[1]).toBeCloseTo(0);
    expect(out[2]).toBeCloseTo(50 * DEG);
    expect(patrolOffsets(1, 100, out)).toBe(1);
    expect(out[0]).toBe(0);
    expect(patrolOffsets(99, 100, out)).toBe(6); // clamped to the buffer
  });

  it('weights the HUD band 1 inside, fading to 0 outside', () => {
    const avoid = 18 * DEG;
    expect(hudBandWeight(0, avoid)).toBe(1);
    expect(hudBandWeight(-avoid, avoid)).toBe(1);
    expect(hudBandWeight(avoid * 1.25, avoid)).toBeCloseTo(0.5);
    expect(hudBandWeight(avoid * 2, avoid)).toBe(0);
    expect(hudBandWeight(0, 0)).toBe(0);
  });

  it('walks a polar path that bulges out past the HUD and never cuts inside', () => {
    const out = new Float32Array(2);
    const avoid = NEATNIKS.boss.hudAvoidDeg * DEG;
    const clear = NEATNIKS.boss.hudClearDist;
    const r = NEATNIKS.boss.distance;
    for (let u = 0; u <= 1.0001; u += 0.02) {
      patrolPathPoint(-50 * DEG, r, 50 * DEG, r, u, avoid, clear, out);
      expect(out[1]).toBeGreaterThanOrEqual(r - 1e-6);
      expect(Math.abs(out[0])).toBeLessThanOrEqual(50 * DEG + 1e-6);
      if (Math.abs(out[0]) <= avoid) expect(out[1]).toBeGreaterThanOrEqual(clear - 1e-6);
    }
    patrolPathPoint(-50 * DEG, r, 50 * DEG, r, 0, avoid, clear, out);
    expect(out[0]).toBeCloseTo(-50 * DEG);
    expect(out[1]).toBeCloseTo(r);
    patrolPathPoint(-50 * DEG, r, 50 * DEG, r, 1, avoid, clear, out);
    expect(out[0]).toBeCloseTo(50 * DEG);
  });

  it('picks a different next point, covering all of them', () => {
    const seen = new Set<number>();
    for (let k = 0; k < 50; k++) {
      const next = nextPatrolIndex(1, 3, k / 50);
      expect(next).not.toBe(1);
      seen.add(next);
    }
    expect([...seen].sort()).toEqual([0, 2]);
    expect(nextPatrolIndex(0, 1, 0.5)).toBe(0);
    expect(nextPatrolIndex(2, 3, 1)).toBe(1);
  });

  it('measures legs roughly by arc + radial change', () => {
    expect(patrolLegLength(0, 2, Math.PI / 2, 2)).toBeCloseTo(Math.PI);
    expect(patrolLegLength(0, 2, 0, 3)).toBeCloseTo(1);
  });

  it('ships a readable, seated-safe patrol', () => {
    const b = NEATNIKS.boss;
    expect(b.patrolPoints).toBeGreaterThanOrEqual(2);
    expect(b.patrolPoints).toBeLessThanOrEqual(4);
    expect(b.patrolArcDeg).toBeLessThanOrEqual(TARGETS.spawnArcDeg);
    expect(b.distance).toBeGreaterThanOrEqual(ROOM.spawnMinDist);
    expect(b.hudClearDist).toBeGreaterThan(b.distance);
    expect(b.patrolSpeed).toBeGreaterThan(0.2);
    expect(b.patrolSpeed).toBeLessThan(1.2); // readable, not twitchy
    expect(b.patrolPauseSec).toBeGreaterThan(0.5);
    // Moving targets stay trivially inside the swept hit test: < 2 cm/frame.
    expect(b.patrolSpeed / 72).toBeLessThan(0.02);
    expect(b.companionsMax).toBeGreaterThanOrEqual(2);
    expect(b.companionWeights[0]).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// HP pips, shield HP, strafe
// ---------------------------------------------------------------------------

describe('HP pips', () => {
  it('lights the remaining pips, flashes them and the one just lost', () => {
    expect(pipLook(0, 2, false)).toBe(PipLook.On);
    expect(pipLook(1, 2, false)).toBe(PipLook.On);
    expect(pipLook(2, 2, false)).toBe(PipLook.Off);
    expect(pipLook(1, 2, true)).toBe(PipLook.Flash);
    expect(pipLook(2, 2, true)).toBe(PipLook.Flash);
    expect(pipLook(3, 2, true)).toBe(PipLook.Off);
  });

  it('centres a row of pips on 0', () => {
    expect(pipX(0, 3, 0.02, 0.01)).toBeCloseTo(-0.03);
    expect(pipX(1, 3, 0.02, 0.01)).toBeCloseTo(0);
    expect(pipX(2, 3, 0.02, 0.01)).toBeCloseTo(0.03);
    expect(pipX(0, 1, 0.02, 0.01)).toBe(0);
  });

  it('puts a bar on the multi-hit bots only', () => {
    expect(wearsHpBar(Neatnik.Squeegee)).toBe(true);
    expect(wearsHpBar(Neatnik.DusterDuke)).toBe(true);
    expect(wearsHpBar(Neatnik.Mopsy)).toBe(false);
    expect(wearsHpBar(Neatnik.Peekaboo)).toBe(false);
  });

  it('keeps the Duke bar a sane width and colours as sRGB tuples in 0..1', () => {
    const hb = NEATNIKS.hpBar;
    const width = NEATNIKS.archetypes.duke.hp * (hb.pipWidth + hb.pipGap);
    expect(width).toBeLessThan(0.5);
    for (const c of [hb.bodyColor, hb.shieldColor, hb.offColor, hb.flashColor]) {
      expect(c).toHaveLength(3);
      for (const v of c) expect(v >= 0 && v <= 1).toBe(true);
    }
  });
});

describe('Squeegee shield HP', () => {
  it('breaks after exactly shield.hp blocked shots and stays broken', () => {
    let hp: number = NEATNIKS.shield.hp;
    expect(hp).toBe(3);
    let blocks = 0;
    while (shieldStillUp(hp)) {
      hp = chipShield(hp);
      blocks++;
    }
    expect(blocks).toBe(3);
    expect(hp).toBe(0);
    expect(chipShield(0)).toBe(0);
    expect(shieldStillUp(0)).toBe(false);
  });

  it('gives the body 1-2 HP behind the shield', () => {
    const hp = NEATNIKS.archetypes.squeegee.hp;
    expect(hp).toBeGreaterThanOrEqual(1);
    expect(hp).toBeLessThanOrEqual(2);
  });

  it('adds ShieldBroken as a fresh, unique event number', () => {
    expect(GameEvent.ShieldBroken).toBe(30);
    const values = Object.values(GameEvent);
    expect(new Set(values).size).toBe(values.length);
  });

  it('coaches the new trick in ASCII, short enough for the strip', () => {
    const line = COACH.lines[Neatnik.Squeegee];
    expect(line).toBe('Shield! Hit it 3x to break it, or flank');
    expect(line.length).toBeLessThanOrEqual(40);
    expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
  });
});

describe('Mopsy strafe', () => {
  it('is a small bounded sine, off when amplitude or hz is 0', () => {
    const { amplitude, hz } = NEATNIKS.mopsyDrift;
    expect(amplitude).toBeGreaterThan(0);
    expect(amplitude).toBeLessThanOrEqual(0.2);
    for (let t = 0; t < 20; t += 0.37) {
      expect(Math.abs(strafeOffset(t, 1.2, amplitude, hz))).toBeLessThanOrEqual(amplitude);
    }
    expect(strafeOffset(3, 1, 0, hz)).toBe(0);
    expect(strafeOffset(3, 1, amplitude, 0)).toBe(0);
    // Slow: well under a metre per second of sideways speed.
    expect(amplitude * 2 * Math.PI * hz).toBeLessThan(0.3);
  });
});

describe('TargetSystem round-10 timers across a pause', () => {
  it('re-bases the refill clock, patrol and pip-flash deadlines', () => {
    let nowMs = 5_000_000;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    try {
      const paused = signal(false);
      const Ctor = TargetSystem as unknown as new () => TargetSystem;
      const sys = new Ctor();
      Object.assign(sys as object, {
        globals: {
          gameEvents: new GameEventBuffer(),
          gamePhase: signal<GamePhase>(GamePhase.Idle),
          targetsAlive: signal(0),
          tetheredHands: signal(0),
          paused,
        },
      });
      sys.init();
      const arrays = sys as unknown as Record<string, Float64Array>;
      const names = [
        'lastPopAt',
        'barFlashUntil',
        'shieldBarFlashUntil',
        'patrolMoveStart',
        'patrolPauseUntil',
      ];
      const frame = (delta = 1 / 72) => {
        nowMs += delta * 1000;
        sys.update(delta);
      };
      const now = () => nowMs / 1000;
      frame();
      for (const name of names) arrays[name][0] = now() + 0.5;
      paused.value = true;
      for (let i = 0; i < 72 * 5; i++) frame();
      paused.value = false;
      frame();
      for (const name of names) {
        expect(Math.abs(arrays[name][0] - now() - 0.5)).toBeLessThanOrEqual(
          1 / 72 + 1e-6,
        );
      }
    } finally {
      spy.mockRestore();
    }
  });
});
