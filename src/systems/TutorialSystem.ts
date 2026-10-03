import {
  AudioSource,
  AudioUtils,
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PanelUI,
  PlaybackMode,
  RingGeometry,
  SRGBColorSpace,
  Vector3,
  VisibilityState,
  XRMesh,
  XRPlane,
  createSystem,
  eq,
} from '@iwsdk/core';
import type { Entity, Object3D } from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import { TUTORIAL } from '../config';
import { RoomProbe, isWallNormal, yawFacingNormal } from '../room-probe';
import {
  AimTargets,
  BlasterMode,
  GameEvent,
  GameEventBuffer,
  GamePhase,
  PipFocus,
  TutorialStep,
  WebSubMode,
  nextTutorialStep,
  readFlag,
  tutorialStepNeedsBots,
  writeFlag,
} from '../types';
import type { FlagStorage } from '../types';
import { GameStateSystem } from './GameStateSystem';
import { IntroSystem } from './IntroSystem';

/** Must match the PanelUI.config main.ts seeds the HUD entity with. */
const HUD_CONFIG_PATH = './ui/hud.json';

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests). Allocation free.
// ---------------------------------------------------------------------------

/** What the player has done since the current step began. */
export interface TutorialObservation {
  /** A paint impact landed within the ring's hit radius. */
  ringHit: boolean;
  /** Impacts anywhere (walls, floor, furniture). */
  impacts: number;
  /** A palette dab / chip / pad was tapped. */
  ammoPicked: boolean;
  /** Neatniks popped. */
  pops: number;
  /** GOO is the loaded launcher. */
  gooLoaded: boolean;
  /** The TETHER sub-mode is selected. */
  tetherLoaded: boolean;
  /** A tethered Neatnik was hauled in and popped. */
  hauled: boolean;
  /** Seconds in this step. */
  elapsed: number;
}

export function createObservation(): TutorialObservation {
  return {
    ringHit: false,
    impacts: 0,
    ammoPicked: false,
    pops: 0,
    gooLoaded: false,
    tetherLoaded: false,
    hauled: false,
    elapsed: 0,
  };
}

/** Back to a fresh step, keeping the loadout facts (they are state, not deeds). */
export function resetObservation(obs: TutorialObservation): void {
  obs.ringHit = false;
  obs.impacts = 0;
  obs.ammoPicked = false;
  obs.pops = 0;
  obs.hauled = false;
  obs.elapsed = 0;
}

/** The slice of TUTORIAL the step machine reads. */
export interface TutorialRules {
  readonly fireAnyImpacts: number;
  readonly readySec: number;
}

/** Has the player done what `step` asks? */
export function tutorialStepDone(
  step: number,
  obs: TutorialObservation,
  rules: TutorialRules,
): boolean {
  switch (step) {
    case TutorialStep.Fire:
      return (
        obs.ringHit ||
        (rules.fireAnyImpacts > 0 && obs.impacts >= rules.fireAnyImpacts)
      );
    case TutorialStep.Palette:
      return obs.ammoPicked;
    case TutorialStep.Pop:
      return obs.pops > 0;
    case TutorialStep.Goo:
      return obs.gooLoaded;
    case TutorialStep.Tether:
      return obs.gooLoaded && obs.tetherLoaded;
    case TutorialStep.Haul:
      return obs.hauled;
    case TutorialStep.Ready:
      return obs.elapsed >= rules.readySec;
    default:
      return false;
  }
}

/**
 * Step back when the player undid a prerequisite: leaving GOO during the
 * tether steps returns to "tap GOO", leaving TETHER mid-haul to "tap TETHER".
 */
export function tutorialRegress(
  step: number,
  gooLoaded: boolean,
  tetherLoaded: boolean,
): TutorialStep {
  if ((step === TutorialStep.Tether || step === TutorialStep.Haul) && !gooLoaded) {
    return TutorialStep.Goo;
  }
  if (step === TutorialStep.Haul && !tetherLoaded) return TutorialStep.Tether;
  return step as TutorialStep;
}

/** The one-line instruction for `step` ('' when off). */
export function tutorialLineFor(
  step: number,
  lines: typeof TUTORIAL.lines,
): string {
  switch (step) {
    case TutorialStep.Fire:
      return lines.fire;
    case TutorialStep.Palette:
      return lines.palette;
    case TutorialStep.Pop:
      return lines.pop;
    case TutorialStep.Goo:
      return lines.goo;
    case TutorialStep.Tether:
      return lines.tether;
    case TutorialStep.Haul:
      return lines.haul;
    case TutorialStep.Ready:
      return lines.ready;
    default:
      return '';
  }
}

/** Did an impact at p land on the ring centred at c (radius r, a sphere test)? */
export function ringHit(
  px: number,
  py: number,
  pz: number,
  cx: number,
  cy: number,
  cz: number,
  r: number,
): boolean {
  const dx = px - cx;
  const dy = py - cy;
  const dz = pz - cz;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/**
 * The skip gesture: seconds both hands have held a pinch, advanced by `dt`
 * while `bothHeld`, reset the moment either lets go.
 */
export function stepSkipHold(held: number, bothHeld: boolean, dt: number): number {
  return bothHeld ? held + Math.max(0, dt) : 0;
}

/** Should the tutorial start on its own now? Never over a round, never twice. */
export function shouldAutoStart(
  enabled: boolean,
  autoStart: boolean,
  done: boolean,
  phase: GamePhase,
): boolean {
  return enabled && autoStart && !done && phase === GamePhase.Idle;
}

/** Is `phase` one the current step can live in? Anything else aborts the tutorial. */
export function stepPhaseValid(
  step: number,
  phase: GamePhase,
  practice: boolean,
): boolean {
  if (step === TutorialStep.Off) return true;
  if (tutorialStepNeedsBots(step)) return phase === GamePhase.Playing && practice;
  // Fire, Palette and Ready run on the title (Idle sandbox). Fire / Palette
  // may also be replayed by the step machine while the practice round is
  // being torn down, which lands in Idle the same frame.
  return phase === GamePhase.Idle;
}

/** `window.localStorage`, or undefined where touching it throws. */
function safeStorage(): FlagStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

/**
 * Round 9: the first-run tutorial, led by Pip. Hands-only, seated, one short
 * line per step, no wall of text:
 *
 * 1. **Fire** - a neon target ring appears ON the nearest real wall in front
 *    (scene planes/meshes; 1.5 m ahead without them). Pinch to paint it: the
 *    first paint of the session lands on the player's own wall.
 * 2. **Palette** - tap a colour on the left-wrist palette.
 * 3. **Pop** - pop a Mopsy.
 * 4. **Goo / Tether / Haul** - tap GOO, tap TETHER, hook a Mopsy and pull it in.
 * 5. **Ready** - back to the title with PLAY pulsing.
 *
 * Steps 1-2 run in the Idle sandbox (firing is allowed there). Steps 3-4
 * need live Neatniks, which TargetSystem only runs during Playing, so they
 * run in GameStateSystem's *practice round* (Playing with the clock held at
 * wave 0: Mopsys only, no score, no boss). No new GamePhase, no TargetSystem
 * changes: the tutorial only observes GameEvents and loadout signals and
 * drives GameStateSystem's public API.
 *
 * Writes `tutorialStep` + `tutorialLine` (HUD card, Pip's speech bubble) and
 * `pipFocus` (where Pip hovers). Skippable at any time: the HUD's SKIP button,
 * or both pinches held for TUTORIAL.skipHoldSec. Completion and skips are
 * remembered in localStorage; the title's TUTORIAL button replays it, and a
 * returning player is never stopped from pressing PLAY.
 */
export class TutorialSystem extends createSystem({
  hud: { required: [PanelUI], where: [eq(PanelUI, 'config', HUD_CONFIG_PATH)] },
  planes: { required: [XRPlane] },
  meshes: { required: [XRMesh] },
}) {
  private gamePhase!: Signal<GamePhase>;
  private step?: Signal<number>;
  private line?: Signal<string>;
  private practice?: Signal<boolean>;
  private paused?: Signal<boolean>;
  private blasterMode?: Signal<BlasterMode>;
  private webSubMode?: Signal<WebSubMode>;
  private focus?: PipFocus;
  private aim?: AimTargets;
  private events!: GameEventBuffer;

  private readonly obs = createObservation();
  private current: TutorialStep = TutorialStep.Off;
  /** Waiting to auto-start: seconds of delay left once the intro is over. */
  private autoArmed = false;
  private autoWait = 0;
  /** >0 while a finished step's line lingers before the next step. */
  private pauseLeft = 0;
  private skipHeld = 0;
  private visible = false;

  // The wall ring.
  private ring?: Group;
  private ringMaterials: MeshBasicMaterial[] = [];
  private readonly ringCenter = new Vector3();
  private ringPop = -1;
  private ringClock = 0;
  private probe?: RoomProbe;
  private headPos!: Vector3;
  private scratch!: Vector3;
  private chime?: Entity;

  init() {
    this.gamePhase = this.globals.gamePhase as Signal<GamePhase>;
    this.step = this.globals.tutorialStep as Signal<number> | undefined;
    this.line = this.globals.tutorialLine as Signal<string> | undefined;
    this.practice = this.globals.practice as Signal<boolean> | undefined;
    this.paused = this.globals.paused as Signal<boolean> | undefined;
    this.blasterMode = this.globals.blasterMode as Signal<BlasterMode> | undefined;
    this.webSubMode = this.globals.webSubMode as Signal<WebSubMode> | undefined;
    this.focus = this.globals.pipFocus as PipFocus | undefined;
    this.aim = this.globals.aimTargets as AimTargets | undefined;
    this.events = this.globals.gameEvents as GameEventBuffer;
    this.headPos = new Vector3();
    this.scratch = new Vector3();

    if (!TUTORIAL.enabled) return;
    this.buildRing();
    this.chime = this.createCue(TUTORIAL.chimeSrc);

    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        this.visible = state === VisibilityState.Visible;
        if (state === VisibilityState.NonImmersive) {
          // Left AR: drop the tutorial (not marked done) and re-arm.
          if (this.current !== TutorialStep.Off) this.finish(false);
          this.autoArmed = false;
        } else if (
          state === VisibilityState.Visible &&
          this.current === TutorialStep.Off &&
          !this.autoArmed &&
          shouldAutoStart(
            TUTORIAL.enabled,
            TUTORIAL.autoStart,
            readFlag(safeStorage(), TUTORIAL.storageKey),
            this.gamePhase.peek(),
          )
        ) {
          this.autoArmed = true;
          this.autoWait = TUTORIAL.startDelaySec;
        }
      }),
    );
  }

  // ---- Public API (HUD buttons, harness) ------------------------------------

  /** The step running now (Off when none). */
  get activeStep(): TutorialStep {
    return this.current;
  }

  /** Start (or replay) the tutorial from step 1. Title screen only. */
  start(): boolean {
    if (!TUTORIAL.enabled) return false;
    if (this.gamePhase.peek() !== GamePhase.Idle) return false;
    this.autoArmed = false;
    this.pauseLeft = 0;
    this.skipHeld = 0;
    this.enterStep(TutorialStep.Fire);
    return true;
  }

  /** SKIP: end now, remember it, back to the title. */
  skip(): void {
    if (this.current === TutorialStep.Off) return;
    this.finish(true);
  }

  // ---- Frame ----------------------------------------------------------------

  update(delta: number) {
    if (!TUTORIAL.enabled) return;
    const dt = Math.min(Math.max(delta, 0), 0.1);

    if (this.autoArmed && this.current === TutorialStep.Off) {
      this.tickAutoStart(dt);
      return;
    }
    if (this.current === TutorialStep.Off) return;
    if (this.paused?.peek() || !this.visible) return;

    const phase = this.gamePhase.peek();
    const practice = this.practice?.peek() === true;
    if (!stepPhaseValid(this.current, phase, practice)) {
      // Something else moved the game on (PLAY via the A button, CHILL...):
      // the player has chosen, so treat it as a skip.
      this.finish(true, false);
      return;
    }

    this.animateRing(dt);
    this.updateFocus();

    if (this.tickSkipHold(dt)) return;

    if (this.pauseLeft > 0) {
      this.pauseLeft -= dt;
      if (this.pauseLeft <= 0) this.advance();
      return;
    }

    this.observe(dt);
    const regressed = tutorialRegress(
      this.current,
      this.obs.gooLoaded,
      this.obs.tetherLoaded,
    );
    if (regressed !== this.current) {
      this.enterStep(regressed);
      return;
    }
    if (tutorialStepDone(this.current, this.obs, TUTORIAL)) this.completeStep();
  }

  private tickAutoStart(dt: number): void {
    if (!this.visible || this.paused?.peek()) return;
    if (this.gamePhase.peek() !== GamePhase.Idle) {
      // They pressed PLAY before we got going: never block a returning
      // player, never nag mid-round. Re-arms on the next session.
      this.autoArmed = false;
      return;
    }
    const intro = this.world.getSystem(IntroSystem);
    if (intro && !intro.finished) return;
    this.autoWait -= dt;
    if (this.autoWait <= 0) this.start();
  }

  /** Both pinches held long enough = skip. @returns true when it skipped. */
  private tickSkipHold(dt: number): boolean {
    if (!(TUTORIAL.skipHoldSec > 0)) return false;
    const left = this.input?.gamepads?.left;
    const right = this.input?.gamepads?.right;
    const both = left?.getSelecting() === true && right?.getSelecting() === true;
    this.skipHeld = stepSkipHold(this.skipHeld, both, dt);
    if (this.skipHeld >= TUTORIAL.skipHoldSec) {
      this.skip();
      return true;
    }
    return false;
  }

  /** Fold this frame's events and loadout into the observation. */
  private observe(dt: number): void {
    const obs = this.obs;
    obs.elapsed += dt;
    obs.gooLoaded = this.blasterMode?.peek() === BlasterMode.Web;
    obs.tetherLoaded = this.webSubMode?.peek() === WebSubMode.Tether;

    const events = this.events;
    const count = events?.count ?? 0;
    for (let i = 0; i < count; i++) {
      switch (events.typeAt(i)) {
        case GameEvent.BallImpact:
          obs.impacts++;
          if (
            this.current === TutorialStep.Fire &&
            ringHit(
              events.xAt(i),
              events.yAt(i),
              events.zAt(i),
              this.ringCenter.x,
              this.ringCenter.y,
              this.ringCenter.z,
              TUTORIAL.ringHitRadius,
            )
          ) {
            obs.ringHit = true;
          }
          break;
        case GameEvent.AmmoSelected:
        case GameEvent.BlasterModeChanged:
          obs.ammoPicked = true;
          break;
        case GameEvent.TargetPopped:
          obs.pops++;
          break;
        case GameEvent.TetherPopped:
          obs.hauled = true;
          break;
        default:
          break;
      }
    }
  }

  /** Mark the step done: chime, ring pop, linger on the line, then advance. */
  private completeStep(): void {
    this.events?.emit(GameEvent.TutorialStepDone, 0, 0, 0, this.current);
    if (this.current === TutorialStep.Ready) {
      this.finish(true);
      return;
    }
    if (this.current === TutorialStep.Fire) this.ringPop = 0;
    if (this.chime?.active && TUTORIAL.chimeVolume > 0) {
      AudioUtils.setVolume(this.chime, TUTORIAL.chimeVolume);
      AudioUtils.play(this.chime);
    }
    this.pauseLeft = Math.max(0.01, TUTORIAL.stepPauseSec);
  }

  private advance(): void {
    this.enterStep(nextTutorialStep(this.current));
  }

  /** Switch to `step`, starting or ending the practice round as it needs. */
  private enterStep(step: TutorialStep): void {
    const game = this.world.getSystem(GameStateSystem);
    if (tutorialStepNeedsBots(step)) {
      if (!game?.inPractice && !game?.startPractice()) {
        this.finish(false);
        return;
      }
    } else if (game?.inPractice) {
      game.endPractice();
    }

    this.current = step;
    resetObservation(this.obs);
    this.pauseLeft = 0;
    if (step === TutorialStep.Fire) this.placeRing();
    if (this.ring && step !== TutorialStep.Fire && this.ringPop < 0) {
      this.ring.visible = false;
    }
    if (this.step && this.step.peek() !== step) this.step.value = step;
    if (this.line) this.line.value = tutorialLineFor(step, TUTORIAL.lines);
  }

  /**
   * End the tutorial. @param remember store "done" so it never auto-runs
   * again. @param tidy return to the title (end a practice round).
   */
  private finish(remember: boolean, tidy = true): void {
    if (remember) writeFlag(safeStorage(), TUTORIAL.storageKey, true);
    const game = this.world.getSystem(GameStateSystem);
    if (tidy && game?.inPractice) game.endPractice();
    this.current = TutorialStep.Off;
    this.autoArmed = false;
    this.pauseLeft = 0;
    this.skipHeld = 0;
    if (this.ring) this.ring.visible = false;
    this.ringPop = -1;
    if (this.focus) this.focus.active = 0;
    if (this.step && this.step.peek() !== TutorialStep.Off) this.step.value = TutorialStep.Off;
    if (this.line && this.line.peek() !== '') this.line.value = '';
  }

  // ---- Pip ------------------------------------------------------------------

  /** Point Pip at whatever the step is about. */
  private updateFocus(): void {
    const focus = this.focus;
    if (!focus) return;
    const p = focus.position;
    const o = focus.offset;
    switch (this.current) {
      case TutorialStep.Fire:
        focus.active = 1;
        p[0] = this.ringCenter.x;
        p[1] = this.ringCenter.y;
        p[2] = this.ringCenter.z;
        o[0] = TUTORIAL.ringRadius + TUTORIAL.pipBeside;
        o[1] = TUTORIAL.pipAbove;
        o[2] = TUTORIAL.pipToward;
        return;
      case TutorialStep.Palette:
      case TutorialStep.Goo:
      case TutorialStep.Tether: {
        const grip = this.player?.gripSpaces?.left;
        if (!grip) break;
        grip.getWorldPosition(this.scratch);
        focus.active = 1;
        p[0] = this.scratch.x;
        p[1] = this.scratch.y;
        p[2] = this.scratch.z;
        o[0] = 0.12;
        o[1] = TUTORIAL.pipWristAbove;
        o[2] = 0.04;
        return;
      }
      case TutorialStep.Pop:
      case TutorialStep.Haul:
        if (this.nearestBot(this.scratch)) {
          focus.active = 1;
          p[0] = this.scratch.x;
          p[1] = this.scratch.y;
          p[2] = this.scratch.z;
          o[0] = TUTORIAL.pipBeside;
          o[1] = TUTORIAL.pipAbove;
          o[2] = TUTORIAL.pipToward;
          return;
        }
        break;
      default:
        break;
    }
    // Ready, or nothing to point at yet: back beside the HUD.
    focus.active = 0;
  }

  /** The live Neatnik nearest the head, into `out`. @returns false when none. */
  private nearestBot(out: Vector3): boolean {
    const aim = this.aim;
    if (!aim) return false;
    this.player.head.getWorldPosition(this.headPos);
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < aim.capacity; i++) {
      if (!aim.active[i]) continue;
      const x = aim.positions[i * 3];
      const y = aim.positions[i * 3 + 1];
      const z = aim.positions[i * 3 + 2];
      const d =
        (x - this.headPos.x) ** 2 + (y - this.headPos.y) ** 2 + (z - this.headPos.z) ** 2;
      if (d < best) {
        best = d;
        out.set(x, y, z);
      }
    }
    return Number.isFinite(best);
  }

  // ---- The wall ring ----------------------------------------------------------

  private buildRing(): void {
    const ring = new Group();
    ring.name = 'TutorialRing';
    ring.visible = false;
    const r = TUTORIAL.ringRadius;
    const unlit = (hex: string, opacity: number) => {
      const material = new MeshBasicMaterial({
        color: new Color().setStyle(hex, SRGBColorSpace),
        transparent: true,
        opacity,
        depthWrite: false,
        toneMapped: false,
        side: DoubleSide,
      });
      this.ringMaterials.push(material);
      material.userData.baseOpacity = opacity;
      return material;
    };
    const parts: Array<[Mesh, number]> = [
      // Dark backing so the neon reads on a white wall.
      [new Mesh(new CircleGeometry(r * 1.08, 48), unlit('#0b0c14', 0.55)), 0],
      [new Mesh(new RingGeometry(r * 0.86, r, 64), unlit('#ff4f81', 1)), 0.002],
      [new Mesh(new RingGeometry(r * 0.56, r * 0.68, 64), unlit('#ffd23f', 1)), 0.004],
      [new Mesh(new CircleGeometry(r * 0.3, 40), unlit('#48dbfb', 1)), 0.006],
    ];
    for (const [mesh, z] of parts) {
      mesh.position.z = z;
      mesh.renderOrder = 980;
      mesh.raycast = () => {};
      ring.add(mesh);
    }
    this.ring = ring;
    this.world.createTransformEntity(ring, {
      parent: this.world.sceneEntity,
      persistent: true,
    });
  }

  /**
   * Put the ring on the nearest real wall in front, at a comfortable seated
   * height, facing out of the wall; floating TUTORIAL.ringFallbackDist ahead
   * when the room has no scene data (or no wall in range).
   */
  private placeRing(): void {
    const ring = this.ring;
    if (!ring) return;
    const head = this.player?.head;
    let fx = 0;
    let fz = -1;
    if (head) {
      head.updateWorldMatrix(true, false);
      const m = head.matrixWorld.elements;
      this.headPos.set(m[12], m[13], m[14]);
      const len = Math.hypot(m[8], m[10]);
      if (len > 1e-3) {
        fx = -m[8] / len;
        fz = -m[10] / len;
      }
    } else {
      this.headPos.set(0, 1.2, 0);
    }
    const eyeY = this.headPos.y > 0.3 ? this.headPos.y : 1.2;
    const y = eyeY + TUTORIAL.ringHeightOffset;

    this.probe ??= new RoomProbe();
    const objects: Array<Object3D | undefined> = [];
    for (const e of this.queries.planes.entities) objects.push(e.object3D);
    for (const e of this.queries.meshes.entities) objects.push(e.object3D);
    this.scratch.set(fx, 0, fz);
    const origin = new Vector3(this.headPos.x, y, this.headPos.z);
    const dist =
      objects.length > 0
        ? this.probe.cast(
            origin,
            this.scratch,
            objects,
            TUTORIAL.ringMinDist,
            TUTORIAL.ringMaxDist,
            (_x, ny) => isWallNormal(ny, 30),
          )
        : Number.POSITIVE_INFINITY;

    if (Number.isFinite(dist)) {
      const n = this.probe.hitNormal;
      const p = this.probe.point;
      ring.position.set(
        p.x + n.x * TUTORIAL.ringStandoff,
        y,
        p.z + n.z * TUTORIAL.ringStandoff,
      );
      ring.rotation.set(0, yawFacingNormal(n.x, n.z), 0);
    } else {
      ring.position.set(
        this.headPos.x + fx * TUTORIAL.ringFallbackDist,
        y,
        this.headPos.z + fz * TUTORIAL.ringFallbackDist,
      );
      ring.rotation.set(0, Math.atan2(-fx, -fz), 0);
    }
    this.ringCenter.copy(ring.position);
    ring.scale.setScalar(1);
    for (const m of this.ringMaterials) m.opacity = m.userData.baseOpacity as number;
    this.ringPop = -1;
    this.ringClock = 0;
    ring.visible = true;
  }

  /** A gentle pulse while waiting; a quick swell-and-fade when hit. */
  private animateRing(dt: number): void {
    const ring = this.ring;
    if (!ring || !ring.visible) return;
    this.ringClock += dt;
    if (this.ringPop >= 0) {
      this.ringPop += dt;
      const t = Math.min(1, this.ringPop / 0.45);
      ring.scale.setScalar(1 + 0.6 * t);
      for (const m of this.ringMaterials) {
        m.opacity = (m.userData.baseOpacity as number) * (1 - t);
      }
      if (t >= 1) {
        ring.visible = false;
        this.ringPop = -1;
      }
      return;
    }
    ring.scale.setScalar(1 + 0.05 * Math.sin(this.ringClock * 4.2));
  }

  private createCue(src: string): Entity {
    const entity = this.world.createTransformEntity(new Group(), {
      parent: this.world.sceneEntity,
      persistent: true,
    });
    entity.addComponent(AudioSource, {
      src,
      volume: 1,
      positional: false,
      loop: false,
      autoplay: false,
      playbackMode: PlaybackMode.Restart,
      maxInstances: 1,
    });
    return entity;
  }
}
