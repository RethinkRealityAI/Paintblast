import { describe, it, expect } from 'vitest';
import {
  BALLS,
  BALL_KIND_CONFIG,
  CHILL,
  EASEL,
  FIRE,
  FLOOR,
  GAME,
  HAPTICS,
  HUD,
  IMPACT,
  MENU,
  ROOM,
  SPLAT,
  TARGETS,
  WEB,
  AUDIO,
  AUDIO_VOLUME,
} from '../../src/config';
import { BallKind, BALL_KIND_NAMES } from '../../src/types';
import { REST_SPLAT_MULT } from '../../src/systems/BallFlightSystem';
import { FLOOR_GUARD_CENTRE_Y } from '../../src/systems/FloorGuardSystem';

const ALL_KINDS = [
  BallKind.Normal,
  BallKind.Bouncy,
  BallKind.Sticky,
  BallKind.Splash,
] as const;

describe('BALL_KIND_CONFIG', () => {
  it('covers every BallKind exactly once', () => {
    const keys = Object.keys(BALL_KIND_CONFIG).map(Number).sort();
    expect(keys).toEqual([...ALL_KINDS].sort());
    expect(keys).toHaveLength(Object.keys(BALL_KIND_NAMES).length);
  });

  it('keeps restitution in the physically meaningful 0..1 range', () => {
    for (const kind of ALL_KINDS) {
      const { restitution } = BALL_KIND_CONFIG[kind];
      expect(restitution).toBeGreaterThanOrEqual(0);
      expect(restitution).toBeLessThanOrEqual(1);
    }
  });

  it('uses non-negative damping and positive splat sizes', () => {
    for (const kind of ALL_KINDS) {
      const config = BALL_KIND_CONFIG[kind];
      expect(config.linearDamping).toBeGreaterThanOrEqual(0);
      expect(config.splatSizeMult).toBeGreaterThan(0);
      expect(Number.isInteger(config.maxBounces)).toBe(true);
      expect(config.maxBounces).toBeGreaterThanOrEqual(0);
    }
  });

  it('makes Bouncy the only kind that survives an impact', () => {
    expect(BALL_KIND_CONFIG[BallKind.Bouncy].maxBounces).toBeGreaterThan(0);
    expect(BALL_KIND_CONFIG[BallKind.Normal].maxBounces).toBe(0);
    expect(BALL_KIND_CONFIG[BallKind.Sticky].maxBounces).toBe(0);
    expect(BALL_KIND_CONFIG[BallKind.Splash].maxBounces).toBe(0);
  });

  it('makes Bouncy bouncier than Normal and Sticky perfectly dead', () => {
    expect(BALL_KIND_CONFIG[BallKind.Bouncy].restitution).toBeGreaterThan(
      BALL_KIND_CONFIG[BallKind.Normal].restitution,
    );
    expect(BALL_KIND_CONFIG[BallKind.Sticky].restitution).toBe(0);
  });
});

describe('BALLS', () => {
  it('uses a sane ball size and population cap', () => {
    expect(BALLS.radius).toBeGreaterThan(0);
    expect(Number.isInteger(BALLS.maxLive)).toBe(true);
    expect(BALLS.maxLive).toBeGreaterThan(0);
  });

  it('culls balls on a positive timer and below the floor', () => {
    expect(BALLS.lifetimeSec).toBeGreaterThan(0);
    expect(BALLS.stickyLifetimeSec).toBeGreaterThan(0);
    expect(BALLS.killFloorY).toBeLessThan(0);
  });
});

describe('FIRE', () => {
  it('has a positive muzzle velocity and cooldown', () => {
    expect(FIRE.speed).toBeGreaterThan(0);
    expect(FIRE.cooldownMs).toBeGreaterThan(0);
  });

  it('clears the hand without spawning inside it', () => {
    expect(FIRE.muzzleOffset).toBeGreaterThan(BALLS.radius);
  });
});

describe('IMPACT', () => {
  it('arms above the rest threshold so settled balls cannot register hits', () => {
    expect(IMPACT.restSpeed).toBeGreaterThan(0);
    expect(IMPACT.armSpeed).toBeGreaterThan(IMPACT.restSpeed);
    expect(IMPACT.impactDeltaV).toBeGreaterThan(0);
  });

  it('needs a whole number of settled frames', () => {
    expect(Number.isInteger(IMPACT.restFrames)).toBe(true);
    expect(IMPACT.restFrames).toBeGreaterThan(0);
  });

  it('stays soft enough to catch a gently lobbed ball landing', () => {
    // Round 3 field feedback: soft landings never crossed the round-2 gates
    // (0.8 / 1.2) and sat on the floor as inert bubbles. Ratcheting these back
    // up re-breaks that, so the old values are the ceiling.
    expect(IMPACT.armSpeed).toBeLessThan(0.8);
    expect(IMPACT.impactDeltaV).toBeLessThan(1.2);
  });

  it('still needs a bigger jolt than the arming speed itself', () => {
    // A deltaV under armSpeed would let a ball merely decelerating through the
    // gate paint a splat in mid-air.
    expect(IMPACT.impactDeltaV).toBeGreaterThan(IMPACT.armSpeed);
  });

  it('leaves the rest splat smaller than a real hit', () => {
    expect(REST_SPLAT_MULT).toBeGreaterThan(0);
    expect(REST_SPLAT_MULT).toBeLessThan(1);
  });
});

describe('SPLAT', () => {
  it('has a positive pool capacity and decal radius', () => {
    expect(Number.isInteger(SPLAT.capacity)).toBe(true);
    expect(SPLAT.capacity).toBeGreaterThan(0);
    expect(SPLAT.baseRadius).toBeGreaterThan(0);
  });

  it('declares ordered jitter and normal-offset ranges', () => {
    expect(SPLAT.sizeJitterMin).toBeGreaterThan(0);
    expect(SPLAT.sizeJitterMax).toBeGreaterThan(SPLAT.sizeJitterMin);
    expect(SPLAT.normalOffsetMin).toBeGreaterThan(0);
    expect(SPLAT.normalOffsetMax).toBeGreaterThan(SPLAT.normalOffsetMin);
  });

  it('throws a real ring of satellite splats', () => {
    expect(SPLAT.splashRadius).toBeGreaterThan(0);
    expect(Number.isInteger(SPLAT.splashCount)).toBe(true);
    expect(SPLAT.splashCount).toBeGreaterThan(0);
    // A whole Splash burst must fit in the pool.
    expect(SPLAT.splashCount + 1).toBeLessThan(SPLAT.capacity);
  });
});

describe('GAME', () => {
  it('has positive phase durations', () => {
    expect(GAME.countdownSec).toBeGreaterThan(0);
    expect(GAME.roundSec).toBeGreaterThan(0);
    expect(GAME.gameOverSec).toBeGreaterThan(0);
    expect(GAME.comboWindowSec).toBeGreaterThan(0);
  });

  it('caps the combo at a whole multiplier of at least one', () => {
    expect(Number.isInteger(GAME.comboCap)).toBe(true);
    expect(GAME.comboCap).toBeGreaterThanOrEqual(1);
  });

  it('rewards target hits more than wall paint', () => {
    expect(GAME.scoreTargetHit).toBeGreaterThan(GAME.scoreWallSplat);
    expect(GAME.scoreWallSplat).toBeGreaterThan(0);
  });
});

describe('TARGETS', () => {
  it('declares an ordered spawn ring and height band', () => {
    expect(TARGETS.ringMinR).toBeGreaterThan(0);
    expect(TARGETS.ringMaxR).toBeGreaterThan(TARGETS.ringMinR);
    expect(TARGETS.heightMin).toBeGreaterThan(0);
    expect(TARGETS.heightMax).toBeGreaterThan(TARGETS.heightMin);
  });

  it('never needs more concurrent robots than the pool holds', () => {
    expect(Number.isInteger(TARGETS.poolSize)).toBe(true);
    expect(Number.isInteger(TARGETS.maxConcurrent)).toBe(true);
    expect(TARGETS.maxConcurrent).toBeGreaterThan(0);
    expect(TARGETS.maxConcurrent).toBeLessThanOrEqual(TARGETS.poolSize);
  });

  it('takes at least one hit to pop and respawns after a delay', () => {
    expect(Number.isInteger(TARGETS.baseHp)).toBe(true);
    expect(TARGETS.baseHp).toBeGreaterThanOrEqual(1);
    expect(TARGETS.respawnDelaySec).toBeGreaterThanOrEqual(0);
  });

  it('hovers and turns by non-negative amounts', () => {
    expect(TARGETS.bobAmplitude).toBeGreaterThanOrEqual(0);
    expect(TARGETS.bobHz).toBeGreaterThanOrEqual(0);
    expect(TARGETS.turnDegPerSec).toBeGreaterThanOrEqual(0);
  });
});

describe('HUD', () => {
  it('declares a three-component offset for both placements', () => {
    expect(HUD.menuOffset).toHaveLength(3);
    expect(HUD.playOffset).toHaveLength(3);
  });

  it('docks the play panel below the menu panel', () => {
    expect(HUD.playOffset[1]).toBeLessThan(HUD.menuOffset[1]);
    // Both sit in front of the player, not behind them.
    expect(HUD.menuOffset[2]).toBeLessThan(0);
    expect(HUD.playOffset[2]).toBeLessThan(0);
  });

  it('makes the docked panel smaller, looser and lazier', () => {
    expect(HUD.playScale).toBeLessThan(HUD.menuScale);
    expect(HUD.playTolerance).toBeGreaterThan(HUD.menuTolerance);
    expect(HUD.playSpeed).toBeLessThan(HUD.menuSpeed);
    expect(HUD.playScale).toBeGreaterThan(0);
    expect(HUD.playSpeed).toBeGreaterThan(0);
  });

  it('derives both panel sizes from a positive base', () => {
    expect(HUD.baseWidth).toBeGreaterThan(0);
    expect(HUD.baseHeight).toBeGreaterThan(0);
    // The docked panel must stay big enough to read a two-digit timer on.
    expect(HUD.baseWidth * HUD.playScale).toBeGreaterThan(0.2);
  });

  it('follows the head by face-target while docked, or the Y offset is dropped', () => {
    // FollowBehavior.PivotY pins the panel to head height and discards
    // offsetPosition[1]; a low dock is only possible with face-target.
    expect(HUD.playFaceTarget).toBe(true);
  });

  it('allows more look-away than the dock angle itself, or it re-aims forever', () => {
    const dockAngleDeg =
      (Math.atan2(Math.abs(HUD.playOffset[1]), Math.abs(HUD.playOffset[2])) *
        180) /
      Math.PI;
    expect(HUD.playMaxAngle).toBeGreaterThan(dockAngleDeg);
    expect(HUD.menuMaxAngle).toBeGreaterThan(0);
  });
});

describe('MENU (round 10 wrist menu)', () => {
  it('opens and closes quickly, and closes when the hand is gone', () => {
    expect(MENU.openSec).toBeGreaterThan(0.05);
    expect(MENU.openSec).toBeLessThan(0.4);
    expect(MENU.openFromScale).toBeGreaterThan(0);
    expect(MENU.openFromScale).toBeLessThan(1);
    expect(MENU.closeAfterLostSec).toBeGreaterThan(0.2);
    expect(MENU.closeAfterLostSec).toBeLessThan(2);
    expect(MENU.autoCloseIdleSec).toBeGreaterThanOrEqual(0);
  });

  it('gem poke has hysteresis and a debounce', () => {
    expect(MENU.gemPokeExitRadius).toBeGreaterThan(MENU.gemPokeEnterRadius);
    expect(MENU.gemPokeEnterRadius).toBeGreaterThan(MENU.gemRadius);
    expect(MENU.gemDebounceSec).toBeGreaterThan(0.1);
  });

  it('poke re-arms in front of the face, beyond the select depth', () => {
    expect(MENU.selectDepthMeters).toBeGreaterThan(0);
    expect(MENU.rearmMeters).toBeGreaterThan(0);
    expect(MENU.hoverMeters).toBeGreaterThan(MENU.rearmMeters);
    expect(MENU.maxBehindMeters).toBeGreaterThan(MENU.selectDepthMeters);
    // The visible sink never pushes a button below the panel face.
    expect(MENU.sinkMaxMeters).toBeLessThanOrEqual(MENU.buttonLift);
  });

  it('hit slop stays well inside the gaps between buttons', () => {
    expect(2 * MENU.hitMarginMeters).toBeLessThan(MENU.buttonGap);
  });

  it('keeps the first-open flag under the splotopia namespace', () => {
    expect(MENU.firstOpenStorageKey.startsWith('splotopia.')).toBe(true);
  });
});

describe('ROOM', () => {
  it('still has no AUTOMATIC room-capture knob', () => {
    // Round 2 called initiateRoomCapture() off a timer and round 3 field
    // feedback was that it fought Quest's own space-setup flow. Round 5 brought
    // the call back but only behind the SCAN ROOM button, so the thing that
    // must stay gone is the delay-then-fire knob, not room capture itself.
    expect('captureDelaySec' in ROOM).toBe(false);
  });

  it('waits longer than Quest needs to report its first plane', () => {
    // Meta's Browser docs say to wait 2-3 seconds after session creation before
    // deciding detectedPlanes is really empty. Under that and every scanned
    // room flashes the notice on the way in.
    expect(ROOM.scanCheckDelaySec).toBeGreaterThanOrEqual(3);
    // ...but a player who genuinely has no scan should not be left wondering.
    expect(ROOM.scanCheckDelaySec).toBeLessThan(20);
  });

  it('has ASCII-only scan copy (the MSDF font has no typographic glyphs)', () => {
    for (const line of [
      ROOM.scanNoticeText,
      ROOM.scanUnavailableText,
      ROOM.scanRequestedText,
    ]) {
      expect(line.length).toBeGreaterThan(0);
      // eslint-disable-next-line no-control-regex
      expect(/^[\x20-\x7E]+$/.test(line)).toBe(true);
      // Three distinct outcomes the player has to tell apart; a shared string
      // would make "nothing happened" indistinguishable from "go and do it".
      expect(line).not.toBe('');
    }
    expect(new Set([
      ROOM.scanNoticeText,
      ROOM.scanUnavailableText,
      ROOM.scanRequestedText,
    ]).size).toBe(3);
  });

  it('holds robots off the wall without shoving them into the player', () => {
    expect(ROOM.spawnWallMargin).toBeGreaterThan(0);
    expect(ROOM.spawnMinDist).toBeGreaterThan(0);
    // A robot at arm's length is unhittable in a different way.
    expect(ROOM.spawnMinDist).toBeGreaterThan(0.5);
  });

  it('resamples a whole number of times and probes a real distance', () => {
    expect(Number.isInteger(ROOM.spawnAttempts)).toBe(true);
    expect(ROOM.spawnAttempts).toBeGreaterThan(0);
    expect(ROOM.spawnRayMaxDist).toBeGreaterThan(TARGETS.ringMaxR);
  });
});

describe('FLOOR', () => {
  it('covers more than the whole robot spawn ring', () => {
    // The slab is the backstop for a room with no scan data at all, so it has
    // to reach at least as far as anything the game can put in front of you.
    expect(FLOOR.extentMeters / 2).toBeGreaterThan(TARGETS.ringMaxR);
    expect(FLOOR.thicknessMeters).toBeGreaterThan(0);
  });

  it('is thicker than the walls, which have a backstop of their own', () => {
    // The slab is the only thing under a room that was never scanned, so it
    // gets a full half metre. A wall plane only has to beat one frame of
    // travel, and every centimetre of it bulges visibly into the room.
    expect(FLOOR.thicknessMeters).toBeGreaterThan(ROOM.wallThicknessMeters);
  });

  it('is thick enough that a muzzle-velocity ball cannot tunnel it', () => {
    // IWSDK steps Havok once per frame with no CCD, so a ball that crosses
    // more than the slab's thickness in one step passes through it. 72 Hz is
    // the Quest's floor frame rate, i.e. the longest ordinary step; the factor
    // of two is margin for a frame that runs late.
    const travelPerFrame = FIRE.speed / 72;
    expect(FLOOR.thicknessMeters).toBeGreaterThan(2 * travelPerFrame);
  });

  it('sinks the top face just below the local-floor origin', () => {
    const topFace = FLOOR_GUARD_CENTRE_Y + FLOOR.thicknessMeters / 2;
    // Below y=0, so a real detected floor plane always wins the contact...
    expect(topFace).toBeLessThan(0);
    // ...but only just, or paint lands visibly under the actual floor.
    expect(topFace).toBeGreaterThan(-0.01);
    expect(topFace).toBeCloseTo(-FLOOR.sinkMeters, 6);
  });

  it('sits well above the kill floor, or balls die before they land', () => {
    expect(FLOOR_GUARD_CENTRE_Y).toBeGreaterThan(BALLS.killFloorY);
  });

  it('behaves like a detected plane rather than a trampoline', () => {
    expect(FLOOR.restitution).toBeGreaterThanOrEqual(0);
    expect(FLOOR.restitution).toBeLessThan(0.5);
    expect(FLOOR.friction).toBeGreaterThan(0);
  });
});

describe('WEB', () => {
  it('no longer carries a mode status line', () => {
    // Round 5 deleted GamePhase.Web, and with it the panel section that line
    // was written into. Webbing is ammo now: the footer says WEB and the idle
    // how-to explains the chip. @see GamePhase
    expect('statusText' in WEB).toBe(false);
  });

  it('wears a shooter small enough to sit on a real forearm', () => {
    expect(WEB.shooterLengthMeters).toBeGreaterThan(0.07);
    expect(WEB.shooterLengthMeters).toBeLessThan(0.2);
    // Straps sized to a forearm: adult wrists run 5-7 cm across.
    expect(WEB.shooterBandMeters).toBeGreaterThan(0.05);
    expect(WEB.shooterBandMeters).toBeLessThan(0.11);
  });

  it('mounts the GOO launcher on TOP of the forearm, up the arm from the pivot', () => {
    // Round 10 turret frame: +Y is up off the back of the forearm, +Z is up
    // the arm. Under the wrist (R7-R9) nobody saw it was loaded.
    expect(WEB.shooterOffsetY).toBeGreaterThan(0);
    expect(WEB.shooterOffsetZ).toBeGreaterThan(0);
    // On the arm rather than floating off it.
    expect(Math.abs(WEB.shooterOffsetY)).toBeLessThan(WEB.shooterBandMeters);
    expect(WEB.shooterOffsetZ).toBeLessThan(WEB.shooterLengthMeters);
  });

  it('builds the gauntlet along the aim, so no mount rotation is needed', () => {
    // The round 4-6 ring cuff needed yaw 90 / roll 180 to be coaxed onto an
    // axis the hand-tracking grip did not even have. The round-7 gauntlet is
    // authored along -Z, the direction webs fly: any non-zero default here
    // would turn it off the forearm again.
    expect(WEB.shooterUseGlb).toBe(false);
    expect(WEB.shooterYawDeg).toBe(0);
    expect(WEB.shooterPitchDeg).toBe(0);
    expect(WEB.shooterRollDeg).toBe(0);
  });

  it('keeps the mount angles inside one full turn', () => {
    for (const angle of [
      WEB.shooterYawDeg,
      WEB.shooterPitchDeg,
      WEB.shooterRollDeg,
    ]) {
      expect(Number.isFinite(angle)).toBe(true);
      expect(Math.abs(angle)).toBeLessThanOrEqual(360);
    }
  });

  it('puts the nozzle on the barrel axis, out in front', () => {
    expect(WEB.muzzleLocal).toHaveLength(3);
    // On the axis the webs travel along, so strand and shot leave the tip.
    expect(WEB.muzzleLocal[0]).toBe(0);
    expect(WEB.muzzleLocal[1]).toBe(0);
    // Forward (-Z) of the device centre, past the body, but not out in space.
    expect(WEB.muzzleLocal[2]).toBeLessThan(-WEB.shooterLengthMeters / 2);
    expect(WEB.muzzleLocal[2]).toBeGreaterThan(-WEB.shooterLengthMeters);
  });

  it('aims hands along the OS ray by default, and smooths only a little', () => {
    expect(['ray', 'hand']).toContain(WEB.handAimSource);
    expect(WEB.handAimSource).toBe('ray');
    expect(WEB.shooterSmoothingSec).toBeGreaterThanOrEqual(0);
    // Longer than ~60 ms and the barrel visibly trails the arm.
    expect(WEB.shooterSmoothingSec).toBeLessThan(0.06);
    expect(WEB.controllerWristBack).toBeGreaterThan(0.03);
    expect(WEB.controllerWristBack).toBeLessThan(0.12);
  });

  it('makes webs zip: faster and flatter than paint, never weightless', () => {
    expect(WEB.webSpeedMult).toBeGreaterThan(1);
    expect(WEB.webSpeedMult).toBeLessThan(2.5);
    expect(WEB.webGravityFactor).toBeGreaterThan(0);
    expect(WEB.webGravityFactor).toBeLessThan(1);
  });

  it('gives webs a wider, but still gentle, aim-assist cone than paint', () => {
    expect(FIRE.aimAssistDeg).toBeGreaterThanOrEqual(0);
    expect(WEB.aimAssistDeg).toBeGreaterThan(FIRE.aimAssistDeg);
    // Past ~15 degrees it stops being assist and starts being autoaim.
    expect(WEB.aimAssistDeg).toBeLessThan(15);
    expect(FIRE.aimAssistMaxRange).toBeGreaterThan(TARGETS.ringMaxR);
  });

  it('clears the hand before the web exists', () => {
    expect(WEB.muzzleOffset).toBeGreaterThan(BALLS.radius);
  });

  it('leaves a dead band between curled and extended', () => {
    // A finger drifting through the gap satisfies neither test, so a half-made
    // gesture reads as "no" instead of firing on tracking noise.
    expect(WEB.curlThreshold).toBeGreaterThan(0);
    expect(WEB.extendThreshold).toBeGreaterThan(WEB.curlThreshold);
    expect(WEB.extendThreshold - WEB.curlThreshold).toBeGreaterThan(0.03);
  });

  it('keeps both thresholds inside real human hand geometry', () => {
    // An adult fingertip is roughly 0.05 m from the wrist folded and 0.17 m
    // extended. Thresholds outside that band can never be met.
    expect(WEB.curlThreshold).toBeGreaterThan(0.04);
    expect(WEB.extendThreshold).toBeLessThan(0.17);
  });

  it('rate-limits both gesture triggers', () => {
    expect(WEB.gestureCooldownMs).toBeGreaterThan(0);
    expect(WEB.thrustCooldownMs).toBeGreaterThan(0);
    // Both must outlast a dropped tracking frame at 72 Hz (~14 ms), which is
    // what the cooldowns exist to absorb.
    expect(WEB.gestureCooldownMs).toBeGreaterThan(100);
    expect(WEB.thrustCooldownMs).toBeGreaterThan(100);
  });

  it('needs a real shove, averaged over a real window', () => {
    // Slower than this and ordinary arm movement fires the shooter.
    expect(WEB.thrustSpeed).toBeGreaterThan(1);
    expect(WEB.thrustWindowSec).toBeGreaterThan(0);
    // The window has to span several frames to average out jitter, but stay
    // short enough that the gesture does not feel laggy.
    expect(WEB.thrustWindowSec).toBeGreaterThan(2 / 90);
    expect(WEB.thrustWindowSec).toBeLessThan(0.25);
  });

  it('ships the finger-curl FLICK gesture switched off (round 9)', () => {
    // Reads as the rock sign and misfires; pinch/trigger and thrust still fire.
    expect(WEB.gestureEnabled).toBe(false);
  });

  it('tints GOO strands with the paint colour by default', () => {
    expect(WEB.gooUsesPaintColor).toBe(true);
    expect(WEB.gooTetherLift).toBeGreaterThanOrEqual(0);
    expect(WEB.gooTetherLift).toBeLessThanOrEqual(1);
  });

  it('pools enough strands to cover the balls in the air', () => {
    expect(Number.isInteger(WEB.strandPool)).toBe(true);
    expect(WEB.strandPool).toBeGreaterThan(0);
    expect(WEB.strandRadius).toBeGreaterThan(0);
    // A strand is a thread, not a pipe.
    expect(WEB.strandRadius).toBeLessThan(BALLS.radius);
    expect(WEB.strandLingerSec).toBeGreaterThan(0);
    // Longer than the fire cooldown allows a single hand to refill the pool,
    // which is exactly the case oldest-first eviction has to cover.
    expect(WEB.strandLingerSec).toBeLessThan(BALLS.lifetimeSec);
  });

  it('gives webbing its own decal pool, and a wider splat than paint', () => {
    expect(Number.isInteger(WEB.splatCapacity)).toBe(true);
    expect(WEB.splatCapacity).toBeGreaterThan(0);
    expect(WEB.splatSizeMult).toBeGreaterThan(1);
  });

  it('pops a tether close enough to be in your face, not across the room', () => {
    expect(WEB.tetherKillRadius).toBeGreaterThan(0.3);
    expect(WEB.tetherKillRadius).toBeLessThan(1.5);
  });

  it('lets a tether go long before it can quietly eat a robot slot', () => {
    // A latched robot never respawns, so a line nobody reels in would shrink
    // the ring for the rest of the round.
    expect(WEB.tetherMaxSec).toBeGreaterThan(5);
    expect(WEB.tetherMaxSec).toBeLessThan(GAME.roundSec);
  });

  it('tells a release tap from a hold-to-reel', () => {
    // Longer than a deliberate tap, far shorter than a reel anyone holds.
    expect(WEB.releaseTapMs).toBeGreaterThan(120);
    expect(WEB.releaseTapMs).toBeLessThan(500);
  });

  it('treats only an impossible palm jump as a reacquired hand', () => {
    // A real hand at a hard 4 m/s covers ~6 cm in a 72 Hz frame; a dropout
    // and reacquire jumps tens of centimetres.
    expect(WEB.reacquireJumpMeters).toBeGreaterThan(4 / 72);
    expect(WEB.reacquireJumpMeters).toBeLessThan(1);
  });

  it('catches a tether on a brush, but not from across the room', () => {
    expect(WEB.tetherLatchBonus).toBeGreaterThan(0);
    expect(WEB.tetherLatchBonus).toBeLessThan(0.3);
  });

  it('ignores tracking jitter before the pull ratchet takes in line', () => {
    // A still hand jitters at a few cm/s; a deliberate haul is well over 0.5.
    expect(WEB.pullDeadband).toBeGreaterThan(0.05);
    expect(WEB.pullDeadband).toBeLessThan(0.5);
    expect(WEB.pullGain).toBeGreaterThan(1);
    expect(WEB.pullGain).toBeLessThan(5);
  });

  it('glides the robot in faster than any single haul source queues line', () => {
    // If the glide were slower than the hold-reel, the queue would grow
    // without bound while a pinch is held and the robot would lag the line.
    expect(WEB.reelSpeed).toBeGreaterThan(0);
    expect(WEB.reelGlideSpeed).toBeGreaterThan(WEB.reelSpeed);
    expect(WEB.reelQueueMax).toBeGreaterThan(0);
    // A burst of pulling must settle in well under a second.
    expect(WEB.reelQueueMax / WEB.reelGlideSpeed).toBeLessThan(0.5);
  });

  it('rate-limits the reel rumble to a ratchet, not a buzz', () => {
    expect(WEB.reelFeedbackMs).toBeGreaterThan(1000 / 72);
    expect(WEB.reelFeedbackMs).toBeLessThan(300);
  });

  it('struggles visibly but not violently on the line', () => {
    expect(WEB.tetherStruggleRad).toBeGreaterThan(0);
    expect(WEB.tetherStruggleRad).toBeLessThan(0.6);
    expect(WEB.tetherStruggleHz).toBeGreaterThan(1);
    expect(WEB.tetherStruggleHz).toBeLessThan(20);
  });

  it('no longer declares the round-6 wrist selector pads (round 10 menu)', () => {
    expect('selectorPadMeters' in WEB).toBe(false);
    expect('selectorOffsetY' in WEB).toBe(false);
  });
});

describe('CHILL', () => {
  it('has ASCII-only status lines (the MSDF font has no typographic glyphs)', () => {
    for (const line of [CHILL.statusText, CHILL.rotatedText]) {
      expect(line.length).toBeGreaterThan(0);
      // eslint-disable-next-line no-control-regex
      expect(/^[\x20-\x7E]+$/.test(line)).toBe(true);
    }
  });

  it('teaches both round-3 chill affordances in the status line', () => {
    expect(CHILL.statusText.toLowerCase()).toContain('spray');
    // Round 10: the palette became the summonable wrist menu (tap the gem).
    expect(CHILL.statusText.toLowerCase()).toContain('gem');
  });

  it('sprays faster than the one-per-pull trigger, but not for free', () => {
    expect(CHILL.sprayCooldownMs).toBeGreaterThan(0);
    expect(CHILL.sprayCooldownMs).toBeLessThan(FIRE.cooldownMs);
    // At maxLive balls a whole magazine has to outlive its own spray, or the
    // cap recycles paint before it can land.
    expect(BALLS.maxLive * CHILL.sprayCooldownMs).toBeGreaterThan(1000);
  });
});

describe('EASEL', () => {
  it('describes a board with positive dimensions', () => {
    expect(EASEL.boardWidth).toBeGreaterThan(0);
    expect(EASEL.boardHeight).toBeGreaterThan(0);
    expect(EASEL.boardDepth).toBeGreaterThan(0);
    expect(EASEL.canvasPxW).toBeGreaterThan(0);
    expect(EASEL.canvasPxH).toBeGreaterThan(0);
  });

  it('tolerates impacts across the board thickness but not much further', () => {
    expect(EASEL.hitDepthTolerance).toBeGreaterThan(EASEL.boardDepth / 2);
    expect(EASEL.hitDepthTolerance).toBeLessThan(EASEL.boardHeight / 2);
  });

  it('leans back rather than falling over', () => {
    expect(EASEL.tiltDeg).toBeGreaterThan(0);
    expect(EASEL.tiltDeg).toBeLessThan(45);
  });

  it('points both stamp masks at real texture paths', () => {
    for (const url of [EASEL.maskUrl, EASEL.webMaskUrl]) {
      expect(url.startsWith('/')).toBe(true);
      expect(url.endsWith('.png')).toBe(true);
    }
    // Two genuinely different silhouettes, or webbing on the canvas is just
    // paint that happens to be grey.
    expect(EASEL.webMaskUrl).not.toBe(EASEL.maskUrl);
    expect(EASEL.maskPx).toBeGreaterThan(0);
  });

  it('tints web stamps off-white, so they show on an off-white canvas', () => {
    expect(EASEL.webStampColor).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(EASEL.webStampColor.toLowerCase()).not.toBe('#ffffff');
    expect(EASEL.webStampColor.toLowerCase()).not.toBe(
      EASEL.canvasColor.toLowerCase(),
    );
  });
});

describe('HAPTICS', () => {
  it('keeps every intensity in the 0..1 the actuator accepts', () => {
    for (const [name, value] of Object.entries(HAPTICS)) {
      if (name.endsWith('Ms')) {
        expect(value).toBeGreaterThan(0);
        continue;
      }
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('makes the thwip a snap rather than the paint trigger a thud', () => {
    expect(HAPTICS.thwipIntensity).toBeGreaterThan(HAPTICS.fireIntensity);
    expect(HAPTICS.thwipMs).toBeLessThan(HAPTICS.popMs);
  });
});

describe('AUDIO', () => {
  it('maps every cue to an absolute /audio path', () => {
    const paths = Object.values(AUDIO);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.startsWith('/audio/')).toBe(true);
      expect(path.endsWith('.mp3')).toBe(true);
    }
  });

  it('points the combo cue at the one asset that ships today', () => {
    expect(AUDIO.chime).toBe('/audio/chime.mp3');
  });

  it('declares the two round-3 cues', () => {
    expect(AUDIO.uiClick).toBe('/audio/ui-click.mp3');
    expect(AUDIO.chillMusic).toBe('/audio/chill-music.mp3');
  });

  it('declares the two round-4 web cues', () => {
    expect(AUDIO.flick).toBe('/audio/flick.mp3');
    expect(AUDIO.webHit).toBe('/audio/web-hit.mp3');
  });

  it('gives every cue path a matching gain entry, and vice versa', () => {
    // FeedbackSystem pairs the two tables by key; a cue with no gain plays at
    // whatever the last caller left on the entity.
    expect(Object.keys(AUDIO_VOLUME).sort()).toEqual(
      expect.arrayContaining(Object.keys(AUDIO).sort()),
    );
  });

  it('makes the GOO flick carry, since it is the whole point of the mode', () => {
    expect(AUDIO_VOLUME.flick).toBeGreaterThan(AUDIO_VOLUME.fire);
  });

  it('gives every cue a gain, and never a silent or clipping one', () => {
    const volumes = Object.values(AUDIO_VOLUME);
    for (const volume of volumes) {
      expect(volume).toBeGreaterThan(0);
      expect(volume).toBeLessThanOrEqual(1);
    }
    // The ambient bed plays under everything, forever — it has to sit below
    // every one-shot or it drowns the game.
    for (const [name, volume] of Object.entries(AUDIO_VOLUME)) {
      if (name === 'chillMusic') continue;
      expect(AUDIO_VOLUME.chillMusic).toBeLessThan(volume);
    }
  });
});
