import {
  AudioSource,
  AudioUtils,
  Group,
  PlaybackMode,
  createSystem,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import {
  AUDIO,
  AUDIO_SPATIAL,
  AUDIO_VOLUME,
  BLASTER,
  CHILL,
  HAPTICS,
} from '../config';
import {
  BallStyle,
  BlasterMode,
  GameEvent,
  GameEventBuffer,
  GamePhase,
  unpackFiredHand,
  unpackFiredStyle,
  unpackImpactStyle,
} from '../types';

/**
 * The raw WebXR haptic actuator, which `lib.dom`'s `Gamepad` does not declare
 * (it only knows `vibrationActuator`). `StatefulGamepad.gamepad` is public, so
 * this is the one narrow cast needed to reach the rumble motors.
 */
interface HapticPulseActuator {
  pulse?: (intensity: number, duration: number) => Promise<boolean> | void;
}

interface HapticGamepad {
  hapticActuators?: ArrayLike<HapticPulseActuator>;
}

/**
 * Turns this frame's game events into sound and rumble.
 *
 * One persistent audio entity per cue is built in init() and replayed forever,
 * rather than spawning a one-shot entity per sound: a Splash ball can fire
 * several impacts in a frame, and entity churn at 90 FPS is exactly what the
 * pooling elsewhere in this project exists to avoid. Holding that fixed set of
 * entity references is the same pool exception TargetSystem makes.
 *
 * The positional cues (splat, pop, web hit) are moved to the event's world
 * position immediately before playing, so paint lands where you hear it.
 *
 * Two cues are chosen by the event's own payload: BallFired and BallImpact
 * carry a style bit, and webbing plays the thwip and the web hit instead of the
 * paint trigger and the splat. See update().
 *
 * One cue is not event-driven at all: the Chill ambient loop follows the phase
 * signal, starting when the player drops into Chill and stopping when they
 * leave. Round 5 made that simpler rather than harder — with the Web phase
 * gone, loading web ammo in Chill keeps the music playing, which is what "web
 * mode AND chill mode" was asking for.
 *
 * Runs at priority 36 — after every producer, before EventFlushSystem at 90.
 */
export class FeedbackSystem extends createSystem({}) {
  private events!: GameEventBuffer;
  private gamePhase!: Signal<GamePhase>;

  private fireCue!: Entity;
  private splatCue!: Entity;
  private popCue!: Entity;
  private countdownCue!: Entity;
  private gameOverCue!: Entity;
  private chimeCue!: Entity;
  private uiClickCue!: Entity;
  private thwipCue!: Entity;
  private webHitCue!: Entity;
  private chillMusicCue?: Entity;

  init() {
    this.events = this.globals.gameEvents as GameEventBuffer;
    this.gamePhase = this.globals.gamePhase as Signal<GamePhase>;

    // Restart for the rapid-fire cues so a held trigger stays crisp; Overlap
    // for splats because a Splash burst genuinely is several impacts at once.
    this.fireCue = this.createCue(
      AUDIO.fire,
      AUDIO_VOLUME.fire,
      false,
      PlaybackMode.Restart,
    );
    this.splatCue = this.createCue(
      AUDIO.splat,
      AUDIO_VOLUME.splat,
      true,
      PlaybackMode.Overlap,
    );
    this.popCue = this.createCue(
      AUDIO.pop,
      AUDIO_VOLUME.pop,
      true,
      PlaybackMode.Overlap,
    );
    this.countdownCue = this.createCue(
      AUDIO.countdown,
      AUDIO_VOLUME.countdown,
      false,
      PlaybackMode.Restart,
    );
    this.gameOverCue = this.createCue(
      AUDIO.gameOver,
      AUDIO_VOLUME.gameOver,
      false,
      PlaybackMode.Restart,
    );
    this.chimeCue = this.createCue(
      AUDIO.chime,
      AUDIO_VOLUME.chime,
      false,
      PlaybackMode.Restart,
    );
    // Restart, not Overlap: rattling down a row of buttons should sound like
    // one tick per press, not a pile-up.
    this.uiClickCue = this.createCue(
      AUDIO.uiClick,
      AUDIO_VOLUME.uiClick,
      false,
      PlaybackMode.Restart,
    );
    // Non-positional, like the paint trigger it stands in for: the shooter is
    // strapped to your own wrist, so spatialising it buys nothing.
    this.thwipCue = this.createCue(
      AUDIO.flick,
      AUDIO_VOLUME.flick,
      false,
      PlaybackMode.Restart,
    );
    // Positional and overlapping, like the splat it stands in for.
    this.webHitCue = this.createCue(
      AUDIO.webHit,
      AUDIO_VOLUME.webHit,
      true,
      PlaybackMode.Overlap,
    );

    if (CHILL.music) {
      this.chillMusicCue = this.createCue(
        AUDIO.chillMusic,
        AUDIO_VOLUME.chillMusic,
        false,
        PlaybackMode.Restart,
        true,
      );
      this.cleanupFuncs.push(
        this.gamePhase.subscribe((phase) => this.applyChillMusic(phase)),
      );
    }
  }

  /**
   * Start the ambient bed on entering Chill, stop it on leaving.
   *
   * `AudioUtils.stop` is a real API (unlike a raw pause, it rewinds), so the
   * loop restarts from the top on the next visit rather than resuming
   * mid-phrase. Guarded on isPlaying so the repeated Idle writes that
   * GameStateSystem makes never stack up stop calls.
   *
   * Chill is the whole test, and deliberately still only the phase: what ammo
   * is loaded has nothing to do with whether the room should have music in it,
   * so webbing the easel keeps the bed running.
   */
  private applyChillMusic(phase: GamePhase): void {
    const cue = this.chillMusicCue;
    if (!cue?.active) return;

    if (phase === GamePhase.Chill) {
      AudioUtils.setVolume(cue, AUDIO_VOLUME.chillMusic);
      AudioUtils.play(cue);
    } else if (AudioUtils.isPlaying(cue)) {
      AudioUtils.stop(cue);
    }
  }

  update() {
    const events = this.events;
    const count = events.count;

    // Webbing reuses the paint pipeline wholesale — BallFired and BallImpact
    // mean the same things, they just need to sound like webbing rather than
    // paint. Round 4 decided that by looking at the game phase; round 5 deleted
    // the Web phase and made webbing ammo, so the answer now rides on the
    // *event*. Per event, not per frame: with web ammo on the palette, one
    // frame can genuinely contain a web landing and a paintball landing.
    for (let i = 0; i < count; i++) {
      switch (events.typeAt(i)) {
        case GameEvent.BallFired: {
          // BallSpawnSystem and WebShooterSystem both pack the firing hand into
          // bit 8 of `data` (0 = left, 1 = right) and the style into bit 9.
          const data = events.dataAt(i);
          const side = unpackFiredHand(data);
          if (unpackFiredStyle(data) === BallStyle.Web) {
            this.playCue(this.thwipCue, AUDIO_VOLUME.flick);
            this.pulse(side, HAPTICS.thwipIntensity, HAPTICS.thwipMs);
          } else {
            this.playCue(this.fireCue, AUDIO_VOLUME.fire);
            this.pulse(side, HAPTICS.fireIntensity, HAPTICS.fireMs);
          }
          break;
        }

        case GameEvent.BallImpact:
          if (unpackImpactStyle(events.dataAt(i)) === BallStyle.Web) {
            this.playCueAt(this.webHitCue, i, AUDIO_VOLUME.webHit);
          } else {
            this.playCueAt(this.splatCue, i, AUDIO_VOLUME.splat);
          }
          break;

        case GameEvent.TargetHit:
          this.playCueAt(this.splatCue, i, AUDIO_VOLUME.splatTarget);
          this.pulseBoth(HAPTICS.hitIntensity, HAPTICS.hitMs);
          break;

        case GameEvent.TargetPopped:
          this.playCueAt(this.popCue, i, AUDIO_VOLUME.pop);
          this.pulseBoth(HAPTICS.popIntensity, HAPTICS.popMs);
          break;

        // ---- Tether (round 6) -------------------------------------------
        //
        // No new audio files: a tether is made of webbing, so it lands with
        // the web hit, and a tethered robot pops with the ordinary pop —
        // TargetPopped fires in the same frame as TetherPopped and carries
        // that cue. What the three events buy is the *rumble*, which is the
        // only channel that can tell a player their arm is connected to
        // something without them having to look at it.
        case GameEvent.TetherAttached:
          this.playCueAt(this.webHitCue, i, AUDIO_VOLUME.webHit);
          this.pulse(
            unpackFiredHand(events.dataAt(i)),
            HAPTICS.tetherAttachIntensity,
            HAPTICS.tetherAttachMs,
          );
          break;

        case GameEvent.TetherReeled:
          // Silent by design. It repeats several times a second while hauling,
          // and a sound at that rate stops being feedback and becomes noise.
          this.pulse(
            unpackFiredHand(events.dataAt(i)),
            HAPTICS.yankIntensity,
            HAPTICS.yankMs,
          );
          break;

        case GameEvent.TetherPopped:
          this.pulseBoth(HAPTICS.tetherPopIntensity, HAPTICS.tetherPopMs);
          break;

        case GameEvent.CountdownTick:
          this.playCue(this.countdownCue, AUDIO_VOLUME.countdown);
          break;

        case GameEvent.RoundEnd:
          this.playCue(this.gameOverCue, AUDIO_VOLUME.gameOver);
          break;

        case GameEvent.ComboMilestone:
          this.playCue(this.chimeCue, AUDIO_VOLUME.chime);
          break;

        case GameEvent.UiClick:
          this.playCue(this.uiClickCue, AUDIO_VOLUME.uiClick);
          break;

        // Round 8: the gauntlets deploy or stow. No new audio: deploying
        // hardware gets the chime (a "locked on"), stowing back to bare hands
        // the softer UI click — both at their own BLASTER volume so neither
        // reads as a combo or a button. Both arms buzz: both gauntlets moved.
        case GameEvent.BlasterModeChanged:
          if (events.dataAt(i) === BlasterMode.Hand) {
            this.playCue(this.uiClickCue, BLASTER.modeSwitchVolume);
          } else {
            this.playCue(this.chimeCue, BLASTER.modeSwitchVolume);
          }
          this.pulseBoth(
            BLASTER.modeSwitchHapticIntensity,
            BLASTER.modeSwitchHapticMs,
          );
          break;

        // Round 8 Neatniks. The deflected ball still lands (BallImpact
        // carries the splat); this adds the shield's own tick at the blade so
        // the player hears *why* it did not count.
        case GameEvent.ShieldDeflected:
          this.playCueAt(this.uiClickCue, i, AUDIO_VOLUME.shieldPing);
          break;

        case GameEvent.BossEntered:
          this.playCue(this.countdownCue, AUDIO_VOLUME.bossEnter);
          this.pulseBoth(HAPTICS.hitIntensity, HAPTICS.hitMs);
          break;

        default:
          break;
      }
    }
  }

  /**
   * One persistent, reusable audio entity. Parented to the scene entity so its
   * local position is already its world position — no transform chain to walk
   * before playing a positional cue.
   */
  private createCue(
    src: string,
    volume: number,
    positional: boolean,
    playbackMode: (typeof PlaybackMode)[keyof typeof PlaybackMode],
    loop = false,
  ): Entity {
    const entity = this.world.createTransformEntity(new Group(), {
      parent: this.world.sceneEntity,
      persistent: true,
    });
    entity.addComponent(AudioSource, {
      src,
      volume,
      positional,
      loop,
      autoplay: false,
      playbackMode,
      refDistance: AUDIO_SPATIAL.refDistance,
      // A looping bed only ever needs one voice; stealing between two would
      // audibly restart the track.
      maxInstances: positional ? AUDIO_SPATIAL.maxInstances : loop ? 1 : 2,
    });
    return entity;
  }

  /** Set the gain for this hit, then trigger it. */
  private playCue(cue: Entity, volume: number): void {
    if (!cue?.active) return;
    // The splat cue is shared between wall paint and robot hits at different
    // gains, so volume is always written rather than assumed.
    AudioUtils.setVolume(cue, volume);
    AudioUtils.play(cue);
  }

  /** Move a positional cue onto the event's world position, then play it. */
  private playCueAt(cue: Entity, eventIndex: number, volume: number): void {
    cue?.object3D?.position.set(
      this.events.xAt(eventIndex),
      this.events.yAt(eventIndex),
      this.events.zAt(eventIndex),
    );
    this.playCue(cue, volume);
  }

  /**
   * Buzz one controller. Silently does nothing in hand-tracking mode, where
   * there is no gamepad and no actuator to reach.
   */
  private pulse(
    side: 'left' | 'right',
    intensity: number,
    durationMs: number,
  ): void {
    const gamepad = this.input?.gamepads?.[side]?.gamepad as unknown as
      | HapticGamepad
      | undefined;
    const actuator = gamepad?.hapticActuators?.[0];
    if (!actuator?.pulse) return;

    try {
      const result = actuator.pulse(intensity, durationMs);
      // Chrome returns a promise; a rejection here must not escape as an
      // unhandled rejection in the middle of a frame.
      if (result && typeof (result as Promise<boolean>).catch === 'function') {
        (result as Promise<boolean>).catch(() => {});
      }
    } catch {
      // Actuator disappeared between the check and the call.
    }
  }

  private pulseBoth(intensity: number, durationMs: number): void {
    this.pulse('left', intensity, durationMs);
    this.pulse('right', intensity, durationMs);
  }
}
