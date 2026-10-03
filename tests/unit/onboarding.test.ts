import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

import { COACH, GAME, HUD, INTRO, TUTORIAL } from '../../src/config';
import {
  GameEvent,
  GamePhase,
  NEATNIK_NAMES,
  NEATNIK_SHORT_NAMES,
  PipFocus,
  NEATNIK_COUNT,
  Neatnik,
  TUTORIAL_STEP_COUNT,
  TutorialStep,
  accuracyPercent,
  copyRoundStats,
  createRoundStats,
  isPrintableAscii,
  markSeen,
  nextGoalLine,
  nextMilestone,
  nextTutorialStep,
  packPopData,
  readFlag,
  readMask,
  recordRoundEvent,
  resetRoundStats,
  shouldCoach,
  totalPops,
  tutorialStepNeedsBots,
  tutorialStepNumber,
  writeFlag,
  writeMask,
} from '../../src/types';
import {
  createObservation,
  resetObservation,
  ringHit,
  shouldAutoStart,
  stepPhaseValid,
  stepSkipHold,
  tutorialLineFor,
  tutorialRegress,
  tutorialStepDone,
} from '../../src/systems/TutorialSystem';
import { coachLineFor, coachingActive } from '../../src/systems/CoachSystem';
import { apparentScale, isWallNormal, yawFacingNormal } from '../../src/room-probe';
import { bubbleWidth, focusHoverPoint } from '../../src/systems/PipSystem';
import { tutorialCardShown, tutorialCounterLabel } from '../../src/systems/HudSystem';
import { introAllowedInPhase } from '../../src/systems/IntroSystem';

/** Round 9: first-run tutorial, coaching, results card, copy pass. */

const memory = () => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
};
const hostile = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('tutorial step machine', () => {
  it('walks Fire -> Palette -> Pop -> Goo -> Tether -> Haul -> Ready -> Off', () => {
    const order: number[] = [];
    let s: number = TutorialStep.Fire;
    while (s !== TutorialStep.Off) {
      order.push(s);
      s = nextTutorialStep(s);
    }
    expect(order).toEqual([
      TutorialStep.Fire,
      TutorialStep.Palette,
      TutorialStep.Pop,
      TutorialStep.Goo,
      TutorialStep.Tether,
      TutorialStep.Haul,
      TutorialStep.Ready,
    ]);
    expect(nextTutorialStep(TutorialStep.Off)).toBe(TutorialStep.Off);
    expect(nextTutorialStep(99)).toBe(TutorialStep.Off);
  });

  it('numbers steps 1..5 for the player (the tether sub-steps are one)', () => {
    expect(tutorialStepNumber(TutorialStep.Fire)).toBe(1);
    expect(tutorialStepNumber(TutorialStep.Palette)).toBe(2);
    expect(tutorialStepNumber(TutorialStep.Pop)).toBe(3);
    expect(tutorialStepNumber(TutorialStep.Goo)).toBe(4);
    expect(tutorialStepNumber(TutorialStep.Tether)).toBe(4);
    expect(tutorialStepNumber(TutorialStep.Haul)).toBe(4);
    expect(tutorialStepNumber(TutorialStep.Ready)).toBe(TUTORIAL_STEP_COUNT);
    expect(tutorialStepNumber(TutorialStep.Off)).toBe(0);
    expect(tutorialCounterLabel(TutorialStep.Tether)).toBe('STEP 4 OF 5');
  });

  it('only the bot steps need the practice round', () => {
    expect(tutorialStepNeedsBots(TutorialStep.Fire)).toBe(false);
    expect(tutorialStepNeedsBots(TutorialStep.Palette)).toBe(false);
    expect(tutorialStepNeedsBots(TutorialStep.Pop)).toBe(true);
    expect(tutorialStepNeedsBots(TutorialStep.Goo)).toBe(true);
    expect(tutorialStepNeedsBots(TutorialStep.Haul)).toBe(true);
    expect(tutorialStepNeedsBots(TutorialStep.Ready)).toBe(false);
  });

  it('completes each step on exactly its own deed', () => {
    const o = createObservation();
    expect(tutorialStepDone(TutorialStep.Fire, o, TUTORIAL)).toBe(false);
    o.ringHit = true;
    expect(tutorialStepDone(TutorialStep.Fire, o, TUTORIAL)).toBe(true);
    expect(tutorialStepDone(TutorialStep.Palette, o, TUTORIAL)).toBe(false);
    o.ammoPicked = true;
    expect(tutorialStepDone(TutorialStep.Palette, o, TUTORIAL)).toBe(true);
    expect(tutorialStepDone(TutorialStep.Pop, o, TUTORIAL)).toBe(false);
    o.pops = 1;
    expect(tutorialStepDone(TutorialStep.Pop, o, TUTORIAL)).toBe(true);
    expect(tutorialStepDone(TutorialStep.Goo, o, TUTORIAL)).toBe(false);
    o.gooLoaded = true;
    expect(tutorialStepDone(TutorialStep.Goo, o, TUTORIAL)).toBe(true);
    expect(tutorialStepDone(TutorialStep.Tether, o, TUTORIAL)).toBe(false);
    o.tetherLoaded = true;
    expect(tutorialStepDone(TutorialStep.Tether, o, TUTORIAL)).toBe(true);
    // A plain pop is not a haul.
    expect(tutorialStepDone(TutorialStep.Haul, o, TUTORIAL)).toBe(false);
    o.hauled = true;
    expect(tutorialStepDone(TutorialStep.Haul, o, TUTORIAL)).toBe(true);
    expect(tutorialStepDone(TutorialStep.Ready, o, TUTORIAL)).toBe(false);
    o.elapsed = TUTORIAL.readySec;
    expect(tutorialStepDone(TutorialStep.Ready, o, TUTORIAL)).toBe(true);
    expect(tutorialStepDone(TutorialStep.Off, o, TUTORIAL)).toBe(false);
  });

  it('never strands a player who cannot hit the ring', () => {
    const o = createObservation();
    o.impacts = TUTORIAL.fireAnyImpacts - 1;
    expect(tutorialStepDone(TutorialStep.Fire, o, TUTORIAL)).toBe(false);
    o.impacts = TUTORIAL.fireAnyImpacts;
    expect(tutorialStepDone(TutorialStep.Fire, o, TUTORIAL)).toBe(true);
    expect(tutorialStepDone(TutorialStep.Fire, o, { fireAnyImpacts: 0, readySec: 1 })).toBe(false);
  });

  it('a step reset forgets deeds but keeps the loadout', () => {
    const o = createObservation();
    o.ringHit = true;
    o.pops = 3;
    o.gooLoaded = true;
    o.elapsed = 5;
    resetObservation(o);
    expect(o.ringHit).toBe(false);
    expect(o.pops).toBe(0);
    expect(o.elapsed).toBe(0);
    expect(o.gooLoaded).toBe(true);
  });

  it('steps back when the player undoes GOO or TETHER', () => {
    expect(tutorialRegress(TutorialStep.Haul, false, true)).toBe(TutorialStep.Goo);
    expect(tutorialRegress(TutorialStep.Tether, false, false)).toBe(TutorialStep.Goo);
    expect(tutorialRegress(TutorialStep.Haul, true, false)).toBe(TutorialStep.Tether);
    expect(tutorialRegress(TutorialStep.Haul, true, true)).toBe(TutorialStep.Haul);
    expect(tutorialRegress(TutorialStep.Pop, false, false)).toBe(TutorialStep.Pop);
  });

  it('ring hits are a sphere test around the centre', () => {
    expect(ringHit(0, 1.2, -2, 0, 1.2, -2, 0.35)).toBe(true);
    expect(ringHit(0.3, 1.2, -2, 0, 1.2, -2, 0.35)).toBe(true);
    expect(ringHit(0.3, 1.45, -2, 0, 1.2, -2, 0.35)).toBe(false);
    expect(TUTORIAL.ringHitRadius).toBeGreaterThanOrEqual(TUTORIAL.ringRadius);
  });

  it('skip-hold accumulates only while both pinches are held', () => {
    let h = 0;
    for (let i = 0; i < 10; i++) h = stepSkipHold(h, true, 0.1);
    expect(h).toBeCloseTo(1, 6);
    expect(stepSkipHold(h, false, 0.1)).toBe(0);
    expect(stepSkipHold(0, true, -1)).toBe(0);
    // Long enough not to trip during a two-handed burst.
    expect(TUTORIAL.skipHoldSec).toBeGreaterThanOrEqual(1.5);
  });

  it('auto-starts once, only on the title, only when enabled', () => {
    expect(shouldAutoStart(true, true, false, GamePhase.Idle)).toBe(true);
    expect(shouldAutoStart(true, true, true, GamePhase.Idle)).toBe(false);
    expect(shouldAutoStart(true, true, false, GamePhase.Playing)).toBe(false);
    expect(shouldAutoStart(true, false, false, GamePhase.Idle)).toBe(false);
    expect(shouldAutoStart(false, true, false, GamePhase.Idle)).toBe(false);
  });

  it('aborts when the game leaves the phase a step lives in', () => {
    expect(stepPhaseValid(TutorialStep.Fire, GamePhase.Idle, false)).toBe(true);
    expect(stepPhaseValid(TutorialStep.Fire, GamePhase.Countdown, false)).toBe(false);
    expect(stepPhaseValid(TutorialStep.Pop, GamePhase.Playing, true)).toBe(true);
    // A real round is not the practice round.
    expect(stepPhaseValid(TutorialStep.Pop, GamePhase.Playing, false)).toBe(false);
    expect(stepPhaseValid(TutorialStep.Haul, GamePhase.Idle, false)).toBe(false);
    expect(stepPhaseValid(TutorialStep.Ready, GamePhase.Idle, false)).toBe(true);
    expect(stepPhaseValid(TutorialStep.Off, GamePhase.Chill, false)).toBe(true);
  });

  it('remembers completion without ever throwing', () => {
    const s = memory();
    expect(readFlag(s, TUTORIAL.storageKey)).toBe(false);
    expect(writeFlag(s, TUTORIAL.storageKey, true)).toBe(true);
    expect(readFlag(s, TUTORIAL.storageKey)).toBe(true);
    expect(readFlag(hostile, 'k')).toBe(false);
    expect(writeFlag(hostile, 'k', true)).toBe(false);
    expect(readFlag(undefined, 'k')).toBe(false);
    expect(writeFlag(undefined, 'k', true)).toBe(false);
  });
});

describe('tutorial copy (no wall of text)', () => {
  const steps = [
    TutorialStep.Fire,
    TutorialStep.Palette,
    TutorialStep.Pop,
    TutorialStep.Goo,
    TutorialStep.Tether,
    TutorialStep.Haul,
    TutorialStep.Ready,
  ];

  it('one short ASCII line per step', () => {
    for (const step of steps) {
      const line = tutorialLineFor(step, TUTORIAL.lines);
      expect(line.length, line).toBeGreaterThan(0);
      expect(line.length, line).toBeLessThanOrEqual(40);
      expect(isPrintableAscii(line), line).toBe(true);
    }
    expect(tutorialLineFor(TutorialStep.Off, TUTORIAL.lines)).toBe('');
  });

  it('teaches hands-first verbs and the round-9 names', () => {
    expect(TUTORIAL.lines.fire.toLowerCase()).toContain('pinch');
    expect(TUTORIAL.lines.palette.toLowerCase()).toContain('wrist');
    expect(TUTORIAL.lines.goo).toContain('GOO');
    expect(TUTORIAL.lines.tether).toContain('TETHER');
    expect(TUTORIAL.lines.ready).toContain('PLAY');
  });

  it('the HUD card is up from Fire to Haul, the title is back for Ready', () => {
    expect(tutorialCardShown(TutorialStep.Off)).toBe(false);
    expect(tutorialCardShown(TutorialStep.Fire)).toBe(true);
    expect(tutorialCardShown(TutorialStep.Haul)).toBe(true);
    expect(tutorialCardShown(TutorialStep.Ready)).toBe(false);
  });

  it('places the ring in a comfortable range', () => {
    expect(TUTORIAL.ringMinDist).toBeGreaterThan(0.5);
    expect(TUTORIAL.ringMaxDist).toBeGreaterThan(TUTORIAL.ringFallbackDist);
    expect(TUTORIAL.ringFallbackDist).toBeGreaterThan(TUTORIAL.ringMinDist);
    expect(Math.abs(TUTORIAL.ringHeightOffset)).toBeLessThan(0.4);
  });
});

describe('first-encounter coaching', () => {
  it('coaches Squeegee, Peekaboo and the Duke once each, never Mopsy', () => {
    let seen = 0;
    expect(shouldCoach(Neatnik.Mopsy, seen)).toBe(false);
    for (const a of [Neatnik.Squeegee, Neatnik.Peekaboo, Neatnik.DusterDuke]) {
      expect(shouldCoach(a, seen)).toBe(true);
      seen = markSeen(seen, a);
      expect(shouldCoach(a, seen)).toBe(false);
    }
    expect(shouldCoach(-1, 0)).toBe(false);
    expect(shouldCoach(NEATNIK_COUNT, 0)).toBe(false);
    expect(markSeen(seen, 99)).toBe(seen);
  });

  it('remembers seen types on the device, junk-proof', () => {
    const s = memory();
    expect(readMask(s, COACH.storageKey)).toBe(0);
    writeMask(s, COACH.storageKey, markSeen(0, Neatnik.Peekaboo));
    expect(shouldCoach(Neatnik.Peekaboo, readMask(s, COACH.storageKey))).toBe(false);
    s.map.set('k', 'banana');
    expect(readMask(s, 'k')).toBe(0);
    expect(readMask(hostile, 'k')).toBe(0);
    expect(writeMask(hostile, 'k', 3)).toBe(false);
  });

  it('only in a real round', () => {
    expect(coachingActive(GamePhase.Playing, false)).toBe(true);
    expect(coachingActive(GamePhase.Playing, true)).toBe(false);
    expect(coachingActive(GamePhase.Idle, false)).toBe(false);
    expect(coachingActive(GamePhase.Chill, false)).toBe(false);
  });

  it('ships the briefed tips, short and ASCII', () => {
    expect(coachLineFor(Neatnik.Squeegee, COACH.lines)).toBe('Shield! Hit it 3x to break it, or flank');
    expect(coachLineFor(Neatnik.Peekaboo, COACH.lines)).toBe('Hiding! Hit it when it peeks');
    expect(coachLineFor(Neatnik.DusterDuke, COACH.lines)).toBe('BOSS! GOO > TETHER hauls him in');
    expect(coachLineFor(Neatnik.Mopsy, COACH.lines)).toBe('');
    expect(coachLineFor(9, COACH.lines)).toBe('');
    for (const line of COACH.lines) {
      expect(isPrintableAscii(line)).toBe(true);
      expect(line.length).toBeLessThanOrEqual(40);
    }
    expect(COACH.showSec).toBeGreaterThanOrEqual(2);
    expect(COACH.showSec).toBeLessThanOrEqual(5);
  });

  it('names the cast in ASCII caps', () => {
    expect(NEATNIK_NAMES.length).toBe(NEATNIK_COUNT);
    expect(NEATNIK_SHORT_NAMES.length).toBe(NEATNIK_COUNT);
    for (const n of [...NEATNIK_NAMES, ...NEATNIK_SHORT_NAMES]) {
      expect(/^[A-Z ]+$/.test(n)).toBe(true);
    }
  });
});

describe('results card stats', () => {
  it('folds a round of events into pops, shots, hits and best combo', () => {
    const s = createRoundStats();
    resetRoundStats(s, 1000);
    for (let i = 0; i < 10; i++) recordRoundEvent(s, GameEvent.BallFired, 0);
    recordRoundEvent(s, GameEvent.TargetHit, 0);
    recordRoundEvent(s, GameEvent.TargetPopped, packPopData(2, Neatnik.Mopsy, 100));
    recordRoundEvent(s, GameEvent.TargetHit, 0);
    recordRoundEvent(s, GameEvent.TargetPopped, packPopData(9, Neatnik.Squeegee, 150));
    recordRoundEvent(s, GameEvent.TetherAttached, 0);
    recordRoundEvent(s, GameEvent.ComboMilestone, 3);
    recordRoundEvent(s, GameEvent.ComboMilestone, 2);
    recordRoundEvent(s, GameEvent.BossEntered, 13);
    recordRoundEvent(s, GameEvent.BallImpact, 0);
    expect(s.shots).toBe(10);
    expect(s.hits).toBe(3);
    expect(s.pops).toEqual([1, 1, 0, 0]);
    expect(totalPops(s)).toBe(2);
    expect(s.bestCombo).toBe(3);
    expect(s.bossSeen).toBe(true);
    expect(s.bestBefore).toBe(1000);

    const snap = copyRoundStats(s);
    resetRoundStats(s, 0);
    expect(snap.pops).toEqual([1, 1, 0, 0]);
    expect(s.pops).toEqual([0, 0, 0, 0]);
  });

  it('accuracy is a capped whole percentage', () => {
    expect(accuracyPercent(0, 0)).toBe(0);
    expect(accuracyPercent(3, 10)).toBe(30);
    expect(accuracyPercent(2, 3)).toBe(67);
    expect(accuracyPercent(12, 10)).toBe(100);
    expect(accuracyPercent(-1, 10)).toBe(0);
  });

  it('milestones are the next tidy number strictly above', () => {
    expect(nextMilestone(0)).toBe(500);
    expect(nextMilestone(499)).toBe(500);
    expect(nextMilestone(500)).toBe(1000);
    expect(nextMilestone(1234)).toBe(1500);
  });

  it('picks one next-goal line by priority', () => {
    const s = createRoundStats();
    expect(nextGoalLine(s)).toMatch(/pop/i);

    s.pops[Neatnik.Mopsy] = 4;
    s.bossSeen = true;
    s.score = 900;
    s.bestBefore = 2000;
    expect(nextGoalLine(s)).toMatch(/Duke/);

    s.pops[Neatnik.DusterDuke] = 1;
    expect(nextGoalLine(s)).toBe('Next: 1,101 more beats your best');

    s.score = 2400;
    expect(nextGoalLine(s)).toBe('Next: crack 2,500');

    s.score = 2000;
    expect(nextGoalLine(s)).toBe('Next: crack 2,500');
  });

  it('every next-goal line fits and is ASCII', () => {
    const s = createRoundStats();
    const cases: Array<Partial<typeof s>> = [
      {},
      { pops: [3, 0, 0, 0], bossSeen: true, score: 300 },
      { pops: [3, 0, 0, 1], score: 123456, bestBefore: 99 },
      { pops: [3, 0, 0, 1], score: 100, bestBefore: 123456 },
    ];
    for (const c of cases) {
      const line = nextGoalLine({ ...createRoundStats(), ...c });
      expect(isPrintableAscii(line), line).toBe(true);
      expect(line.length, line).toBeLessThanOrEqual(40);
    }
  });

  it('gives the card time to be read', () => {
    expect(GAME.gameOverSec).toBeGreaterThanOrEqual(10);
    expect(isPrintableAscii(GAME.playingStatusText)).toBe(true);
  });
});

describe('Pip pointing + speech bubble', () => {
  it('hovers to the viewer\'s left of the subject, up and toward them', () => {
    const out = new Float32Array(3);
    // Viewer at the origin, subject 2 m ahead (-Z): viewer's left is -X.
    focusHoverPoint(0, 1.2, -2, 0, 0, 0.3, 0.1, 0.2, out);
    expect(out[0]).toBeCloseTo(-0.3, 6);
    expect(out[1]).toBeCloseTo(1.3, 6);
    expect(out[2]).toBeCloseTo(-1.8, 6);
    // Viewer on the subject: no NaN.
    focusHoverPoint(1, 1, 1, 1, 1, 0.3, 0.1, 0.2, out);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });

  it('sizes the bubble for its distance, within bounds', () => {
    expect(bubbleWidth(0.4)).toBeCloseTo(0.34, 6);
    expect(bubbleWidth(2.5)).toBeCloseTo(0.65, 6);
    expect(bubbleWidth(10)).toBeCloseTo(0.9, 6);
    expect(bubbleWidth(Number.NaN)).toBeCloseTo(0.34, 6);
  });

  it('PipFocus starts inactive', () => {
    const f = new PipFocus();
    expect(f.active).toBe(0);
    expect(Array.from(f.position)).toEqual([0, 0, 0]);
  });
});

describe('intro on the real wall + re-entry guard', () => {
  it('only plays over the title (re-entering AR mid-round skips it)', () => {
    expect(introAllowedInPhase(GamePhase.Idle)).toBe(true);
    expect(introAllowedInPhase(GamePhase.Playing)).toBe(false);
    expect(introAllowedInPhase(GamePhase.Countdown)).toBe(false);
    expect(introAllowedInPhase(GamePhase.GameOver)).toBe(false);
    expect(introAllowedInPhase(GamePhase.Chill)).toBe(false);
  });

  it('accepts walls, rejects floors, ceilings and table tops', () => {
    expect(isWallNormal(0, INTRO.wallMaxTiltDeg)).toBe(true);
    expect(isWallNormal(0.3, 30)).toBe(true);
    expect(isWallNormal(0.9, 30)).toBe(false);
    expect(isWallNormal(-1, 30)).toBe(false);
    expect(isWallNormal(Number.NaN, 30)).toBe(false);
  });

  it('faces a +Z plane out along the wall normal', () => {
    expect(yawFacingNormal(0, 1)).toBeCloseTo(0, 6);
    expect(yawFacingNormal(1, 0)).toBeCloseTo(Math.PI / 2, 6);
    expect(Math.abs(yawFacingNormal(0, -1))).toBeCloseTo(Math.PI, 6);
  });

  it('keeps the logo\'s apparent size on a near or far wall, clamped', () => {
    expect(apparentScale(1.5, 1.5, 0.8, 1.7)).toBeCloseTo(1, 6);
    expect(apparentScale(3, 1.5, 0.8, 1.7)).toBeCloseTo(1.7, 6);
    expect(apparentScale(1, 1.5, 0.8, 1.7)).toBeCloseTo(0.8, 6);
    expect(apparentScale(0, 1.5, 0.8, 1.7)).toBe(1);
    expect(INTRO.wallMinDist).toBeLessThan(INTRO.wallMaxDist);
  });
});

describe('HUD legibility pass (round 9)', () => {
  const markup = readFileSync('ui/hud.uikitml', 'utf8');
  const style = markup.slice(0, markup.indexOf('</style>'));
  const body = markup.slice(markup.indexOf('</style>'));

  it('no font in the HUD is below 1.8 units', () => {
    const sizes = [...style.matchAll(/font-size:\s*([\d.]+)/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(20);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(1.8);
  });

  it('one word for the launcher picker: LOADOUT', () => {
    expect(body).toContain('>LOADOUT<');
    expect(body).toContain('LOADOUT &gt;');
    for (const stale of ['ARMORY', 'BLASTERS', 'GAUNTLET LOADOUT', 'LAUNCHER']) {
      expect(body, stale).not.toContain(stale);
    }
  });

  it('keeps the logo path the new art drops into', () => {
    expect(body).toContain('src="./brand/logo.png"');
  });

  it('docks bigger while playing, still smaller than the menu', () => {
    expect(HUD.playScale).toBeGreaterThanOrEqual(0.85);
    expect(HUD.playScale).toBeLessThan(HUD.menuScale);
    expect(HUD.playHighlightSec).toBeGreaterThanOrEqual(0);
  });

  it('ships the tutorial card hidden with its SKIP button', () => {
    expect(body).toMatch(/id="section-tutorial" class="section-hidden"/);
    const card = body.slice(body.indexOf('id="section-tutorial"'));
    expect(card).toContain('id="btn-tut-skip"');
    for (let i = 0; i < TUTORIAL_STEP_COUNT; i++) expect(card).toContain(`id="tut-dot-${i}"`);
  });

  it('the results card has a cell per Neatnik and the stat row', () => {
    for (let i = 0; i < NEATNIK_COUNT; i++) expect(body).toContain(`id="res-pops-${i}"`);
    for (const id of ['res-shots', 'res-hits', 'res-acc', 'res-combo', 'res-goal']) {
      expect(body).toContain(`id="${id}"`);
    }
  });
});
