import { describe, it, expect, vi } from 'vitest';
import { signal } from '@preact/signals-core';
import {
  TargetSystem,
  archetypeConfig,
  archetypePoolCounts,
  bossDue,
  clamp01,
  deflectVelocity,
  dropOffset,
  easeOutBack,
  easeOutCubic,
  easeInCubic,
  easeInOutSine,
  faceYaw,
  hideSpotBehind,
  peekHittable,
  peekLift,
  pickLane,
  pickWeighted,
  popPose,
  shieldBlocks,
  shieldBypassed,
  splitPositions,
  squashWobble,
  stepYawToward,
  waveIndexAt,
  wrapAngle,
} from '../../src/systems/TargetSystem';
import { popBasePoints } from '../../src/systems/GameStateSystem';
import { GAME, NEATNIKS, TARGETS } from '../../src/config';
import type { NeatnikWave } from '../../src/config';
import {
  BallKind,
  GameEvent,
  GameEventBuffer,
  GamePhase,
  Neatnik,
  NEATNIK_COUNT,
  packPopData,
  unpackPopArchetype,
  unpackPopPoints,
  unpackPopSlot,
  unpackTetherSlot,
} from '../../src/types';

const DEG = Math.PI / 180;

describe('Neatnik config', () => {
  it('builds exactly TARGETS.poolSize slots across the archetypes', () => {
    const counts = archetypePoolCounts();
    expect(counts).toHaveLength(NEATNIK_COUNT);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(TARGETS.poolSize);
    for (const n of counts) expect(Number.isInteger(n) && n >= 1).toBe(true);
  });

  it('has enough Mopsys for a full wave plus the boss split', () => {
    const maxAlive = Math.max(...NEATNIKS.waves.map((w) => w.maxAlive));
    expect(NEATNIKS.archetypes.mopsy.pool).toBeGreaterThanOrEqual(
      Math.min(maxAlive, TARGETS.maxConcurrent) + 2,
    );
  });

  it('maps each archetype to its own tuning, unknown values to Mopsy', () => {
    expect(archetypeConfig(Neatnik.Mopsy)).toBe(NEATNIKS.archetypes.mopsy);
    expect(archetypeConfig(Neatnik.Squeegee)).toBe(NEATNIKS.archetypes.squeegee);
    expect(archetypeConfig(Neatnik.Peekaboo)).toBe(NEATNIKS.archetypes.peekaboo);
    expect(archetypeConfig(Neatnik.DusterDuke)).toBe(NEATNIKS.archetypes.duke);
    expect(archetypeConfig(99)).toBe(NEATNIKS.archetypes.mopsy);
  });

  it('makes the boss the toughest and most valuable robot', () => {
    const duke = NEATNIKS.archetypes.duke;
    for (const a of [Neatnik.Mopsy, Neatnik.Squeegee, Neatnik.Peekaboo]) {
      expect(duke.hp).toBeGreaterThan(archetypeConfig(a).hp);
      expect(duke.points).toBeGreaterThan(archetypeConfig(a).points);
      expect(duke.heightMeters).toBeGreaterThan(archetypeConfig(a).heightMeters);
    }
    // Round 10: 11 (was 6) - a patrolling boss with an HP bar.
    expect(duke.hp).toBeGreaterThanOrEqual(10);
    // A tether haul must not be able to one-shot a fresh boss.
    expect(NEATNIKS.boss.tetherDamage).toBeLessThan(duke.hp);
  });

  it('gives every archetype a distinct asset key and a .glb under /gltf/neatniks/', () => {
    const keys = new Set<string>();
    for (const cfg of [
      ...Object.values(NEATNIKS.archetypes),
      NEATNIKS.pip,
    ]) {
      expect(cfg.url.startsWith('/gltf/neatniks/')).toBe(true);
      expect(cfg.url.endsWith('.glb')).toBe(true);
      keys.add(cfg.assetKey);
    }
    expect(keys.size).toBe(5);
  });

  it('has sorted waves that start at 0 and fit the round', () => {
    const waves = NEATNIKS.waves;
    expect(waves[0].startSec).toBe(0);
    for (let i = 1; i < waves.length; i++) {
      expect(waves[i].startSec).toBeGreaterThan(waves[i - 1].startSec);
      expect(waves[i].startSec).toBeLessThan(GAME.roundSec);
    }
    for (const w of waves) {
      expect(w.weights).toHaveLength(3);
      expect(w.maxAlive).toBeGreaterThan(0);
    }
    // The warm-up wave is Mopsys only.
    expect(waves[0].weights[1]).toBe(0);
    expect(waves[0].weights[2]).toBe(0);
  });

  it('brings the boss on inside the round', () => {
    expect(NEATNIKS.boss.enterAtSecLeft).toBeGreaterThan(0);
    expect(NEATNIKS.boss.enterAtSecLeft).toBeLessThan(GAME.roundSec);
  });

  it('keeps a deflected ball slower than it arrived (gotcha 22)', () => {
    expect(NEATNIKS.shield.deflectRestitution).toBeLessThan(1);
    expect(NEATNIKS.shield.deflectRestitution).toBeGreaterThan(0);
  });
});

describe('waveIndexAt (wave composition by time)', () => {
  const waves: NeatnikWave[] = [
    { startSec: 0, maxAlive: 3, weights: [1, 0, 0] },
    { startSec: 20, maxAlive: 4, weights: [1, 1, 0] },
    { startSec: 50, maxAlive: 4, weights: [1, 1, 1] },
  ];

  it('picks the last wave that has started', () => {
    expect(waveIndexAt(0, waves)).toBe(0);
    expect(waveIndexAt(19.99, waves)).toBe(0);
    expect(waveIndexAt(20, waves)).toBe(1);
    expect(waveIndexAt(49, waves)).toBe(1);
    expect(waveIndexAt(50, waves)).toBe(2);
    expect(waveIndexAt(1e6, waves)).toBe(2);
  });

  it('reads negative time and an empty table as wave 0', () => {
    expect(waveIndexAt(-5, waves)).toBe(0);
    expect(waveIndexAt(10, [])).toBe(0);
  });

  it('opens the shipped round with Mopsys only, then adds the cast', () => {
    const w = NEATNIKS.waves;
    const early = w[waveIndexAt(5, w)];
    expect(pickWeighted(early.weights, 0.99)).toBe(Neatnik.Mopsy);
    const late = w[waveIndexAt(GAME.roundSec - 25, w)];
    expect(late.weights[Neatnik.Squeegee]).toBeGreaterThan(0);
    expect(late.weights[Neatnik.Peekaboo]).toBeGreaterThan(0);
  });
});

describe('pickWeighted', () => {
  it('splits the unit interval by weight', () => {
    const w = [1, 2, 1];
    expect(pickWeighted(w, 0)).toBe(0);
    expect(pickWeighted(w, 0.24)).toBe(0);
    expect(pickWeighted(w, 0.26)).toBe(1);
    expect(pickWeighted(w, 0.74)).toBe(1);
    expect(pickWeighted(w, 0.76)).toBe(2);
    expect(pickWeighted(w, 1)).toBe(2);
  });

  it('never picks a zero, negative or NaN weight', () => {
    const w = [0, -3, Number.NaN, 2];
    for (const r of [0, 0.3, 0.6, 0.999]) expect(pickWeighted(w, r)).toBe(3);
  });

  it('falls back to 0 (Mopsy) for an all-zero table', () => {
    expect(pickWeighted([0, 0, 0], 0.5)).toBe(0);
    expect(pickWeighted([], 0.5)).toBe(0);
  });

  it('matches the weights statistically', () => {
    const w = [0.5, 0.3, 0.2];
    const counts = [0, 0, 0];
    const n = 10000;
    for (let i = 0; i < n; i++) counts[pickWeighted(w, (i + 0.5) / n)]++;
    expect(counts[0] / n).toBeCloseTo(0.5, 2);
    expect(counts[1] / n).toBeCloseTo(0.3, 2);
    expect(counts[2] / n).toBeCloseTo(0.2, 2);
  });
});

describe('bossDue', () => {
  it('fires once the clock reaches the cue', () => {
    expect(bossDue(30, 20, false)).toBe(false);
    expect(bossDue(20, 20, false)).toBe(true);
    expect(bossDue(5, 20, false)).toBe(true);
  });

  it('fires only once per round', () => {
    expect(bossDue(10, 20, true)).toBe(false);
  });

  it('never fires on the final zero or when disabled', () => {
    expect(bossDue(0, 20, false)).toBe(false);
    expect(bossDue(10, 0, false)).toBe(false);
  });
});

describe('pickLane', () => {
  it('takes the emptiest lane', () => {
    expect(pickLane([1, 0, 1, 1, 1], 5, 0)).toBe(1);
    expect(pickLane([2, 1, 2, 0, 2], 5, 0.9)).toBe(3);
  });

  it('spreads ties by the random start', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 5; i++) seen.add(pickLane([0, 0, 0, 0, 0], 5, i / 5));
    expect(seen.size).toBe(5);
  });

  it('stays in range for any draw', () => {
    for (const r of [-1, 0, 0.5, 0.9999, 1, 7]) {
      const lane = pickLane([0, 0, 0], 3, r);
      expect(lane).toBeGreaterThanOrEqual(0);
      expect(lane).toBeLessThan(3);
    }
  });
});

describe('shieldBlocks (Squeegee front cone)', () => {
  // Robot at the origin facing +Z (toward a player at +Z).
  const fwdX = 0;
  const fwdZ = 1;

  it('blocks a shot arriving head-on', () => {
    // The ball travels toward -Z, i.e. into the robot's face.
    expect(shieldBlocks(fwdX, fwdZ, 0, -12, 140)).toBe(true);
  });

  it('blocks inside the cone and lets the flank through', () => {
    const at = (deg: number) => {
      // Ball arriving FROM direction `deg` off the facing, travelling inward.
      const fromX = Math.sin(deg * DEG);
      const fromZ = Math.cos(deg * DEG);
      return shieldBlocks(fwdX, fwdZ, -fromX * 10, -fromZ * 10, 140);
    };
    expect(at(0)).toBe(true);
    expect(at(60)).toBe(true);
    expect(at(-69)).toBe(true);
    expect(at(71)).toBe(false);
    expect(at(90)).toBe(false);
    expect(at(180)).toBe(false);
  });

  it('never blocks a ball dropping straight down or standing still', () => {
    expect(shieldBlocks(fwdX, fwdZ, 0, 0, 140)).toBe(false);
  });

  it('works for any facing', () => {
    const yaw = 2.2;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    expect(shieldBlocks(fx, fz, -fx * 8, -fz * 8, 100)).toBe(true);
    expect(shieldBlocks(fx, fz, fx * 8, fz * 8, 100)).toBe(false);
  });
});

describe('shieldBypassed', () => {
  it('lets a bounced ball, a tether web or SPLASH through', () => {
    expect(shieldBypassed(1, BallKind.Bouncy, false)).toBe(true);
    expect(shieldBypassed(0, BallKind.Normal, true)).toBe(true);
    expect(shieldBypassed(0, BallKind.Splash, false)).toBe(true);
  });

  it('stops a fresh ordinary shot of any other kind', () => {
    expect(shieldBypassed(0, BallKind.Normal, false)).toBe(false);
    expect(shieldBypassed(0, BallKind.Bouncy, false)).toBe(false);
    expect(shieldBypassed(0, BallKind.Sticky, false)).toBe(false);
  });
});

describe('deflectVelocity', () => {
  const out = new Float32Array(3);

  it('mirrors a head-on shot back, slower, with a lift', () => {
    deflectVelocity(0, 0, -10, 0, 1, 0.5, 1.2, out);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(1.2, 6);
    expect(out[2]).toBeCloseTo(5, 6);
  });

  it('reflects an angled shot about the face', () => {
    deflectVelocity(3, 0, -4, 0, 1, 1, 0, out);
    expect(out[0]).toBeCloseTo(3, 6);
    expect(out[2]).toBeCloseTo(4, 6);
  });

  it('only slows a ball already leaving the face', () => {
    deflectVelocity(0, 0, 4, 0, 1, 0.5, 0, out);
    expect(out[2]).toBeCloseTo(2, 6);
  });

  it('never speeds a ball up beyond the lift', () => {
    for (const [vx, vz] of [[5, -9], [-12, -1], [0.3, -14]]) {
      deflectVelocity(vx, -2, vz, 0.6, 0.8, NEATNIKS.shield.deflectRestitution, 0, out);
      const inSpeed = Math.hypot(vx, -2, vz);
      expect(Math.hypot(out[0], out[1], out[2])).toBeLessThanOrEqual(inSpeed + 1e-6);
    }
  });
});

describe('peekLift (Peekaboo cycle)', () => {
  const hidden = 1.6;
  const rise = 0.3;
  const up = 1.5;
  const period = hidden + rise + up + rise;

  it('is hidden, rises, holds, ducks, repeats', () => {
    expect(peekLift(0, hidden, rise, up)).toBe(0);
    expect(peekLift(hidden - 0.01, hidden, rise, up)).toBe(0);
    const mid = peekLift(hidden + rise / 2, hidden, rise, up);
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(1);
    expect(peekLift(hidden + rise + 0.01, hidden, rise, up)).toBe(1);
    expect(peekLift(hidden + rise + up - 0.01, hidden, rise, up)).toBe(1);
    const ducking = peekLift(hidden + rise + up + rise / 2, hidden, rise, up);
    expect(ducking).toBeGreaterThan(0);
    expect(ducking).toBeLessThan(1);
    expect(peekLift(period + 0.5, hidden, rise, up)).toBe(0);
  });

  it('stays in [0, 1] for any time, including negative', () => {
    for (let t = -10; t < 20; t += 0.037) {
      const lift = peekLift(t, hidden, rise, up);
      expect(lift).toBeGreaterThanOrEqual(0);
      expect(lift).toBeLessThanOrEqual(1);
    }
  });

  it('is only hittable for roughly the art-bible 1.5 s per cycle', () => {
    let hittableSec = 0;
    const dt = 0.001;
    for (let t = 0; t < period; t += dt) {
      if (peekHittable(peekLift(t, hidden, rise, up), NEATNIKS.peek.hittableLift)) {
        hittableSec += dt;
      }
    }
    expect(hittableSec).toBeGreaterThan(up);
    expect(hittableSec).toBeLessThan(up + 2 * rise);
  });

  it('is continuous (no pops between phases)', () => {
    let prev = peekLift(0, hidden, rise, up);
    for (let t = 0.002; t < period * 2; t += 0.002) {
      const lift = peekLift(t, hidden, rise, up);
      expect(Math.abs(lift - prev)).toBeLessThan(0.05);
      prev = lift;
    }
  });
});

describe('hideSpotBehind (Peekaboo behind furniture)', () => {
  const out = new Float32Array(2);

  it('lands beyond the far face, on the line from the head', () => {
    // A 1 m x 0.6 m table 2 m ahead (-Z).
    const dist = hideSpotBehind(0, 0, 0, -2, 0.5, 0.3, 0.2, out);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(-2.5, 6);
    expect(dist).toBeCloseTo(2.5, 6);
  });

  it('is always further than the box centre', () => {
    for (const [cx, cz] of [[1, -2], [-2, -1], [0.3, -3], [-1, -1]]) {
      const d = hideSpotBehind(0, 0, cx, cz, 0.4, 0.4, 0.2, out);
      expect(d).toBeGreaterThan(Math.hypot(cx, cz));
      expect(Math.hypot(out[0], out[1])).toBeCloseTo(d, 5);
    }
  });
});

describe('splitPositions (boss split)', () => {
  const out = new Float32Array(4);

  it('puts the two Mopsys either side of the boss, across the line of sight', () => {
    splitPositions(0, -2, 0, 0, 0.6, out);
    // Line of sight is along Z, so the pair spreads along X.
    expect(out[1]).toBeCloseTo(-2, 6);
    expect(out[3]).toBeCloseTo(-2, 6);
    expect(Math.abs(out[0] - out[2])).toBeCloseTo(0.6, 6);
    expect(out[0] + out[2]).toBeCloseTo(0, 6);
  });

  it('keeps both the same distance from the player', () => {
    splitPositions(1.3, -1.7, 0.2, 0.1, 0.5, out);
    const d0 = Math.hypot(out[0] - 0.2, out[1] - 0.1);
    const d1 = Math.hypot(out[2] - 0.2, out[3] - 0.1);
    expect(d0).toBeCloseTo(d1, 6);
  });

  it('survives a boss standing on the player', () => {
    splitPositions(0, 0, 0, 0, 0.5, out);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('easing curves', () => {
  it('hit their endpoints', () => {
    for (const f of [easeOutCubic, easeInCubic, easeInOutSine]) {
      expect(f(0)).toBeCloseTo(0, 9);
      expect(f(1)).toBeCloseTo(1, 9);
      expect(f(-1)).toBeCloseTo(0, 9);
      expect(f(2)).toBeCloseTo(1, 9);
    }
    expect(easeOutBack(0, 1.7)).toBeCloseTo(0, 9);
    expect(easeOutBack(1, 1.7)).toBeCloseTo(1, 9);
    expect(clamp01(0.4)).toBe(0.4);
  });

  it('easeOutBack overshoots, then settles (the pop-in boing)', () => {
    let peak = 0;
    for (let t = 0; t <= 1; t += 0.01) peak = Math.max(peak, easeOutBack(t, 2.2));
    expect(peak).toBeGreaterThan(1.05);
    expect(peak).toBeLessThan(1.4);
  });

  it('squashWobble starts squashed and rings out to exactly 1', () => {
    expect(squashWobble(0, 0.4, 0.28, 7)).toBeCloseTo(0.72, 9);
    expect(squashWobble(0.4, 0.4, 0.28, 7)).toBe(1);
    expect(squashWobble(5, 0.4, 0.28, 7)).toBe(1);
    expect(squashWobble(-1, 0.4, 0.28, 7)).toBe(1);
    for (let t = 0; t < 0.4; t += 0.01) {
      const s = squashWobble(t, 0.4, 0.28, 7);
      expect(s).toBeGreaterThanOrEqual(0.72 - 1e-9);
      expect(s).toBeLessThanOrEqual(1.28 + 1e-9);
    }
  });

  it('popPose squashes, then spins and shrinks to nothing', () => {
    const out = new Float32Array(3);
    popPose(0, 0.35, 1.25, out);
    expect(out[0]).toBeCloseTo(1, 6);
    popPose(0.35 - 1e-6, 0.35, 1.25, out);
    expect(out[0]).toBeCloseTo(0.55, 3);
    expect(out[1]).toBeGreaterThan(1);
    popPose(1, 0.35, 1.25, out);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(0, 6);
    expect(out[2]).toBeCloseTo(1.25 * Math.PI * 2, 6);
  });

  it('dropOffset falls accelerating and lands at 0', () => {
    expect(dropOffset(0, 0.5, 1.6)).toBeCloseTo(1.6, 9);
    const early = 1.6 - dropOffset(0.1, 0.5, 1.6);
    const late = dropOffset(0.4, 0.5, 1.6) - dropOffset(0.5 - 1e-9, 0.5, 1.6);
    expect(late).toBeGreaterThan(early);
    expect(dropOffset(0.5, 0.5, 1.6)).toBe(0);
    expect(dropOffset(9, 0.5, 1.6)).toBe(0);
  });
});

describe('facing yaw', () => {
  it('faceYaw turns +Z toward the target', () => {
    // three: rotation.y = a sends +Z to (sin a, 0, cos a).
    for (const [tx, tz] of [[0, 5], [3, 0], [-2, -2], [0.5, -4]]) {
      const a = faceYaw(0, 0, tx, tz);
      const len = Math.hypot(tx, tz);
      expect(Math.sin(a)).toBeCloseTo(tx / len, 6);
      expect(Math.cos(a)).toBeCloseTo(tz / len, 6);
    }
  });

  it('wrapAngle lands in (-pi, pi]', () => {
    for (const a of [-20, -Math.PI, 0, Math.PI, 7, 100]) {
      const w = wrapAngle(a);
      expect(w).toBeGreaterThan(-Math.PI - 1e-9);
      expect(w).toBeLessThanOrEqual(Math.PI + 1e-9);
      expect(Math.cos(w)).toBeCloseTo(Math.cos(a), 6);
      expect(Math.sin(w)).toBeCloseTo(Math.sin(a), 6);
    }
  });

  it('stepYawToward eases the short way round and converges', () => {
    // From 170 deg to -170 deg is 20 deg the short way, through 180.
    const from = 170 * DEG;
    const to = -170 * DEG;
    const next = stepYawToward(from, to, 5, 1 / 72);
    expect(Math.abs(wrapAngle(next - from))).toBeLessThan(20 * DEG);
    expect(Math.cos(wrapAngle(next - 180 * DEG))).toBeGreaterThan(Math.cos(10 * DEG));
    let yaw = 0;
    for (let i = 0; i < 72 * 3; i++) yaw = stepYawToward(yaw, 2, 3, 1 / 72);
    expect(yaw).toBeCloseTo(2, 3);
  });

  it('is framerate independent', () => {
    let a = 0;
    for (let i = 0; i < 72; i++) a = stepYawToward(a, 1, 2, 1 / 72);
    let b = 0;
    for (let i = 0; i < 36; i++) b = stepYawToward(b, 1, 2, 1 / 36);
    expect(a).toBeCloseTo(b, 6);
  });

  it('never turns at rate 0 or with no time', () => {
    expect(stepYawToward(0.3, 2, 0, 1)).toBe(0.3);
    expect(stepYawToward(0.3, 2, 5, 0)).toBe(0.3);
  });
});

describe('pop scoring payload', () => {
  it('keeps the slot in the low byte (old readers unchanged)', () => {
    for (const slot of [0, 7, 13, 255]) {
      const data = packPopData(slot, Neatnik.DusterDuke, 600);
      expect(unpackPopSlot(data)).toBe(slot);
      expect(unpackTetherSlot(data)).toBe(slot);
    }
  });

  it('round-trips archetype and points', () => {
    const data = packPopData(3, Neatnik.Squeegee, 150);
    expect(unpackPopArchetype(data)).toBe(Neatnik.Squeegee);
    expect(unpackPopPoints(data)).toBe(150);
    expect(Number.isInteger(data)).toBe(true);
    expect(data).toBeGreaterThanOrEqual(0);
  });

  it('scores packed points, and the classic value for an old bare slot', () => {
    expect(popBasePoints(packPopData(2, Neatnik.DusterDuke, 600))).toBe(600);
    expect(popBasePoints(5)).toBe(GAME.scoreTargetHit);
  });

  it('round-trips through the Int32 event buffer', () => {
    const data = packPopData(13, Neatnik.DusterDuke, NEATNIKS.archetypes.duke.points);
    const stored = new Int32Array([data])[0];
    expect(unpackPopPoints(stored)).toBe(NEATNIKS.archetypes.duke.points);
  });

  it('numbers the new events clear of every existing one', () => {
    const values = Object.values(GameEvent);
    expect(new Set(values).size).toBe(values.length);
    expect(GameEvent.ShieldDeflected).toBe(20);
    expect(GameEvent.BossEntered).toBe(21);
  });
});

/** A TargetSystem against the vitest stub base class (no art, no pool). */
function makeSystem(paused = signal(false)) {
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
  return sys;
}

describe('TargetSystem round-8 timers across a pause', () => {
  it('re-bases the spawn, peek, entrance, shield and director deadlines', () => {
    let nowMs = 9_000_000;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    try {
      const paused = signal(false);
      const sys = makeSystem(paused);
      const arrays = sys as unknown as Record<string, Float64Array>;
      const names = [
        'spawnStartedAt',
        'peekStartedAt',
        'entranceStartedAt',
        'shieldFlashUntil',
        'returnStartedAt',
        'hitStartedAt',
        'nextSpawnAt',
      ];
      const frame = (delta = 1 / 72) => {
        nowMs += delta * 1000;
        sys.update(delta);
      };
      const now = () => nowMs / 1000;
      frame();
      for (const name of names) arrays[name][0] = now() + 0.5;
      paused.value = true;
      for (let i = 0; i < 72 * 10; i++) frame();
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

  it('lays the pool out by archetype even with no art loaded', () => {
    const sys = makeSystem();
    const layout = Array.from(
      (sys as unknown as { slotArchetype: Int8Array }).slotArchetype,
    );
    expect(layout).toHaveLength(TARGETS.poolSize);
    const counts = archetypePoolCounts();
    for (let a = 0; a < counts.length; a++) {
      expect(layout.filter((x) => x === a)).toHaveLength(counts[a]);
    }
    expect(layout[layout.length - 1]).toBe(Neatnik.DusterDuke);
    expect(sys.debugSpawn(Neatnik.Mopsy)).toBe(-1);
  });
});
