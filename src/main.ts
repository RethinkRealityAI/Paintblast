import {
  World,
  SessionMode,
  VisibilityState,
  AssetType,
  CylinderGeometry,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
  Interactable,
  PanelUI,
  Follower,
  FollowBehavior,
  XRAnchor,
  IBLTexture,
  NoToneMapping,
  NeutralToneMapping,
  ACESFilmicToneMapping,
  AgXToneMapping,
} from '@iwsdk/core';
import type { ToneMapping } from '@iwsdk/core';
import { signal } from '@preact/signals-core';

import {
  SplatterField,
  SplatterSystem,
  SPLAT_TEXTURE_KEY,
  WEB_SPLAT_TEXTURE_KEY,
} from './systems/SplatterSystem';
import { Ball, BallSpawnSystem } from './systems/BallSpawnSystem';
import { BallFlightSystem } from './systems/BallFlightSystem';
import { EventFlushSystem } from './systems/EventFlushSystem';
import { WorldCollisionSystem } from './systems/WorldCollisionSystem';
import { FloorGuard, FloorGuardSystem } from './systems/FloorGuardSystem';
import {
  WebShooterSystem,
  WebStrand,
  WEB_SHOOTER_ASSET_KEY,
} from './systems/WebShooterSystem';
import { Gauntlet, GauntletSystem } from './systems/GauntletSystem';
import {
  Target,
  TargetSystem,
  RobotDepthSensingSystem,
  ROBOT_ASSET_KEY,
} from './systems/TargetSystem';
import { GameStateSystem } from './systems/GameStateSystem';
import { HudSystem } from './systems/HudSystem';
import { TutorialSystem } from './systems/TutorialSystem';
import { CoachSystem } from './systems/CoachSystem';
import { FeedbackSystem } from './systems/FeedbackSystem';
import {
  MENU_VISUALS_KEY,
  WristMenuGem,
  WristMenuRoot,
  WristMenuSystem,
  buildWristMenuGem,
  buildWristMenuPanel,
} from './systems/WristMenuSystem';
import { Easel, EaselSystem, EASEL_ASSET_KEY } from './systems/EaselSystem';
import { SceneScanSystem } from './systems/SceneScanSystem';
import { VfxSystem } from './systems/VfxSystem';
import { IntroSystem, INTRO_LOGO_KEY } from './systems/IntroSystem';
import { PipSystem } from './systems/PipSystem';
import { StudioSystem } from './systems/StudioSystem';
import { initLanding } from './landing/landing';
import { AUDIO, BLASTER, GAME, HUD, RENDER, NEATNIKS, STUDIO, TARGETS, WEB } from './config';
import type { ToneMappingName } from './config';
import {
  BallStyle,
  INITIAL_PALETTE_SELECTION,
  INITIAL_HUD_STATE,
  GamePhase,
  GameEventBuffer,
  WebSubMode,
  AimTargets,
  BlasterMode,
  PipFocus,
  TutorialStep,
  WristMenuState,
} from './types';
import type { RoundStats } from './types';
import {
  LEGACY_SKIN_STORAGE_KEY,
  readWithLegacyFallback,
  safeStorage,
} from './storage-migrate';

const DEG_TO_RAD = Math.PI / 180;

/** The stored skin index, or 0. Never throws (private mode, blocked storage). */
function readStoredSkin(): number {
  try {
    // Round 9: falls back to the pre-rebrand key and copies it forward.
    const raw = readWithLegacyFallback(
      safeStorage(),
      BLASTER.skinStorageKey,
      LEGACY_SKIN_STORAGE_KEY,
    );
    const n = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 && n < BLASTER.skins.length ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Seeds every world.globals signal the game reads.
 *
 * This is the cross-system contract: systems never talk to each other
 * directly, they read and write these. Must run BEFORE registerSystem —
 * elics calls System.init() synchronously during registration, and the
 * systems bind these signals there.
 */
function seedGlobals(world: World) {
  const globals = world.globals as Record<string, unknown>;

  // Round state machine + scoring (GameStateSystem owns writes in Wave B).
  globals.gamePhase = signal(GamePhase.Idle);
  globals.score = signal(0);
  globals.bestScore = signal(0);
  globals.combo = signal(1);
  globals.timeLeft = signal(GAME.roundSec);
  globals.targetsAlive = signal(0);
  // True whenever the immersive session is not in focus: the Quest system
  // menu is open (VisibleBlurred), the headset is off (Hidden), or there is no
  // session at all (NonImmersive — so it reads true on the landing page too).
  // GameStateSystem owns every write, mirroring world.visibilityState, and
  // decides per phase what that freezes: the round clock, countdown, game-over
  // timer and combo window stop, and TargetSystem holds its robots. Idle and
  // Chill carry on untouched. Seeded false; GameStateSystem.init() corrects it
  // from the live visibility state the moment it registers.
  globals.paused = signal(false);

  // Selected ammo (BallSpawnSystem owns writes). Three independent axes since
  // round 5: the paint colour from a dab, the ball kind from a chip, and the
  // paint STYLE — paint or webbing — from the same chip row. activeStyle is
  // what replaced GamePhase.Web: web shooters follow the ammo, not the mode.
  globals.activeKind = signal(INITIAL_PALETTE_SELECTION.kind);
  globals.activeStyle = signal<BallStyle>(INITIAL_PALETTE_SELECTION.style);
  globals.activeColor = signal(INITIAL_PALETTE_SELECTION.color);
  // Round 6's fourth loadout axis: which KIND of web. Only meaningful while
  // activeStyle is Web, chosen on the two-pad selector above the left shooter
  // or with the right controller's B button. BallSpawnSystem owns every write.
  globals.webSubMode = signal<WebSubMode>(INITIAL_PALETTE_SELECTION.subMode);
  // Round 8: which launcher the gauntlets are in (HAND / BLASTER / WEB), and
  // which cosmetic skin they wear. BallSpawnSystem keeps blasterMode and
  // activeStyle in sync (Web <=> Web); the skin is picked in the Armory and
  // persisted per device.
  globals.blasterMode = signal<BlasterMode>(
    INITIAL_PALETTE_SELECTION.blasterMode,
  );
  globals.blasterSkin = signal<number>(readStoredSkin());

  // Bitmask of hands currently holding a tether: bit 0 left, bit 1 right.
  // TargetSystem owns the writes (it owns the tether); BallSpawnSystem reads it
  // so a squeeze that is reeling a robot in cannot also re-pick ammo. A signal
  // rather than a system call because TargetSystem imports BallSpawnSystem, and
  // reaching back the other way would close an import cycle.
  globals.tetheredHands = signal(0);

  // Raised by SceneScanSystem when the headset reports no planes and no meshes
  // after a grace period, i.e. the room was never put through Space Setup.
  // HudSystem turns it into the idle screen's SCAN ROOM notice.
  globals.sceneScanMissing = signal(false);

  // Rendered HUD strings (HudSystem owns writes in Wave B).
  globals.hudScore = signal(INITIAL_HUD_STATE.score);
  globals.hudTimer = signal(INITIAL_HUD_STATE.timer);
  globals.hudStatus = signal(INITIAL_HUD_STATE.status);

  // One-frame event mailbox, drained by EventFlushSystem at priority 90.
  globals.gameEvents = new GameEventBuffer();

  // Round 7: live robot positions for aim assist. TargetSystem writes it every
  // frame of a round, BallSpawnSystem reads it per shot. A struct rather than
  // a system call for the same import-cycle reason as tetheredHands.
  globals.aimTargets = new AimTargets(TARGETS.poolSize);

  // Round 9: onboarding + coaching + results.
  // TutorialSystem owns tutorialStep / tutorialLine / pipFocus; the HUD card
  // and Pip's speech bubble read them. GameStateSystem owns `practice` (the
  // tutorial's clock-stopped Playing) and `roundStats` (the GameOver card's
  // numbers). CoachSystem owns `coachLine` (first-encounter tips).
  globals.tutorialStep = signal<number>(TutorialStep.Off);
  globals.tutorialLine = signal('');
  globals.pipFocus = new PipFocus();
  globals.practice = signal(false);
  globals.roundStats = signal<RoundStats | null>(null);
  globals.coachLine = signal('');

  // Round 10: the summonable wrist menu's live state (open, panel pose, gem
  // pose, presses it spent). WristMenuSystem writes it at priority 8;
  // BallSpawnSystem (shot blocking) and TutorialSystem (Pip) read it.
  globals.wristMenu = new WristMenuState();

  // Round 10: the Studio (Chill mode's activities). StudioSystem owns every
  // write; HudSystem's chill card reads them. studioMeter is the stencil
  // score in whole percent, -1 when no meter shows; studioStars 0..3.
  globals.studioActivity = signal<number>(STUDIO.defaultActivity);
  globals.studioLine = signal('');
  globals.studioMeter = signal(-1);
  globals.studioStars = signal(0);
}

/**
 * Round 10: the summonable wrist menu. Two persistent entities: the summon
 * GEM (rides the left wrist, always shown while the hand is tracked) and the
 * menu PANEL (hidden until summoned). Both are plain decoration built by
 * WristMenuSystem's builders — no Interactable, no PokeInteractable, no
 * grabbable — so IWSDK's pointer pipeline never sees them and nothing on the
 * menu can be pressed by accident. WristMenuSystem poses them, hit-tests the
 * right fingertip / controller ray itself, and writes the loadout signals.
 *
 * Replaces round 2-9's `seedWristPalette` (the always-on painter's palette).
 */
function seedWristMenu(world: World) {
  const panel = buildWristMenuPanel();
  panel.group.userData[MENU_VISUALS_KEY] = panel.visuals;
  world
    .createTransformEntity(panel.group, { parent: world.sceneEntity, persistent: true })
    .addComponent(WristMenuRoot);

  const gem = buildWristMenuGem();
  gem.group.userData[MENU_VISUALS_KEY] = gem.visuals;
  world
    .createTransformEntity(gem.group, { parent: world.sceneEntity, persistent: true })
    .addComponent(WristMenuGem);
}

/**
 * Creates the singleton SplatterField entity. It gets an XRAnchor so the
 * pool of decal quads stays locked to the real room across WebXR tracking
 * drift. SplatterSystem.init() attaches the InstancedMesh under this entity.
 */
function seedSplatterField(world: World) {
  const entity = world.createTransformEntity();
  entity.addComponent(SplatterField, {});
  entity.addComponent(XRAnchor);
  // No DepthOccludable (round 9): IWSDK's occlusion shader ignores
  // instanceMatrix, so every instanced splat would test depth at the field's
  // origin (CLAUDE.md gotcha 20). Only the robots are occluded.
}

/**
 * Creates the UIKitML HUD panel entity, head-locked via Follower so it stays
 * visible regardless of look direction.
 *
 * The panel now carries the whole front-end — title screen, live HUD, round
 * summary, chill controls, and a persistent footer — so it is both taller and
 * further away than the Wave A strip. PanelUISystem fits the document inside
 * maxWidth × maxHeight preserving aspect, and only one phase section is ever
 * displayed, so the rendered panel shrinks by itself once a round is running.
 *
 * Seeded with the menu placement from config; HudSystem re-docks it low and
 * small the moment a round (or Chill mode) starts, so the panel stops sitting
 * in the firing line.
 */
function seedHud(world: World) {
  const entity = world
    .createTransformEntity()
    .addComponent(PanelUI, {
      config: './ui/hud.json',
      // HudSystem rewrites these per phase (see HUD.menuScale / HUD.playScale);
      // this is the menu size the panel opens at.
      maxWidth: HUD.baseWidth * HUD.menuScale,
      maxHeight: HUD.baseHeight * HUD.menuScale,
    })
    // Required for XR clicks: InputSystem only feeds RayInteractable entities
    // to the controller ray's intersection set, so without this the panel's
    // buttons work with a mouse in 2D but are unreachable in the headset.
    .addComponent(Interactable)
    .addComponent(Follower, {
      target: world.player.head,
      offsetPosition: [
        HUD.menuOffset[0],
        HUD.menuOffset[1],
        HUD.menuOffset[2],
      ],
      behavior: HUD.menuFaceTarget
        ? FollowBehavior.FaceTarget
        : FollowBehavior.PivotY,
      maxAngle: HUD.menuMaxAngle,
      tolerance: HUD.menuTolerance,
      speed: HUD.menuSpeed,
    });
  if (entity.object3D) {
    entity.object3D.position.set(0, 1.6, HUD.menuOffset[2]);
  }
}

/** RENDER.toneMapping spellings → three's renderer constants. */
const TONE_MAPPINGS: Record<ToneMappingName, ToneMapping> = {
  none: NoToneMapping,
  neutral: NeutralToneMapping,
  aces: ACESFilmicToneMapping,
  agx: AgXToneMapping,
};

/**
 * Round 7: the scene's lighting and tone curve.
 *
 * IWSDK's `defaultLighting` (left on in World.create below) attaches a
 * DomeGradient + IBLGradient pair to the level root. The dome is a background
 * that EnvironmentSystem already hides in passthrough AR; the gradient IBL is
 * nearly uniform, which is why every PBR material used to read as flat pastel
 * plastic — a uniform environment has no structure to shade or reflect.
 *
 * Adding an IBLTexture to the same root replaces only the *lighting*:
 * EnvironmentSystem prefers IBLTexture over IBLGradient, and IBLTexture writes
 * `scene.environment` and nothing else — no background, no dome, nothing drawn
 * over the real room. 'room' is three's RoomEnvironment, PMREM'd once by IWSDK
 * itself (a few ms at boot, no download); its world-locked rotation is kept
 * stable across headset recentres by EnvironmentSystem.
 *
 * Per-frame cost: none beyond what the gradient already cost — the shaders
 * sample one PMREM either way. Tone mapping is a handful of ALU per fragment.
 *
 * Must run after World.create resolves: that is when LevelSystem has made the
 * real level root (the one carrying LevelRoot, which EnvironmentSystem queries).
 */
function setupEnvironment(world: World) {
  const renderer = world.renderer;
  renderer.toneMapping = TONE_MAPPINGS[RENDER.toneMapping] ?? NoToneMapping;
  renderer.toneMappingExposure = RENDER.exposure;

  // Empty source = keep IWSDK's gradient, i.e. the pre-round-7 lighting.
  if (!RENDER.iblSource) return;
  world.activeLevel.value.addComponent(IBLTexture, {
    src: RENDER.iblSource,
    intensity: RENDER.iblIntensity,
    rotation: [0, RENDER.iblRotationYDeg * DEG_TO_RAD, 0],
  });
}

// The landing overlay renders immediately — World.create takes seconds to
// boot Havok and stream critical assets, and the page should never look dead.
const landing = initLanding();

World.create(document.getElementById('scene-container') as HTMLDivElement, {
  render: {
    fov: 60,
    near: 0.05,
    far: 100,
    defaultLighting: true,
  },
  // Every URL here must exist on disk — a missing one makes World.create
  // reject. Critical assets block World.create; background ones stream in
  // behind it.
  //
  // robot and splatTexture are critical because both are read synchronously
  // during registerSystem: TargetSystem measures the GLTF to size its pool and
  // SplatterSystem probes for the texture when it builds its material. The
  // audio buffers only have to be warm by the time a cue first plays.
  assets: {
    [ROBOT_ASSET_KEY]: {
      url: '/gltf/robot/robot.gltf',
      type: AssetType.GLTF,
      priority: 'critical',
    },
    [SPLAT_TEXTURE_KEY]: {
      url: '/textures/splat.png',
      type: AssetType.Texture,
      priority: 'critical',
    },
    // Critical for the same reason as splat.png: SplatterSystem probes for it
    // synchronously when it builds the web pool's material in init().
    [WEB_SPLAT_TEXTURE_KEY]: {
      url: '/textures/web-splat.png',
      type: AssetType.Texture,
      priority: 'critical',
    },
    fire: { url: AUDIO.fire, type: AssetType.Audio, priority: 'background' },
    splat: { url: AUDIO.splat, type: AssetType.Audio, priority: 'background' },
    pop: { url: AUDIO.pop, type: AssetType.Audio, priority: 'background' },
    countdown: {
      url: AUDIO.countdown,
      type: AssetType.Audio,
      priority: 'background',
    },
    gameOver: {
      url: AUDIO.gameOver,
      type: AssetType.Audio,
      priority: 'background',
    },
    chime: { url: AUDIO.chime, type: AssetType.Audio, priority: 'background' },
    uiClick: {
      url: AUDIO.uiClick,
      type: AssetType.Audio,
      priority: 'background',
    },
    chillMusic: {
      url: AUDIO.chillMusic,
      type: AssetType.Audio,
      priority: 'background',
    },
    flick: { url: AUDIO.flick, type: AssetType.Audio, priority: 'background' },
    webHit: {
      url: AUDIO.webHit,
      type: AssetType.Audio,
      priority: 'background',
    },
    // Round 8 enter-AR intro. Background: IntroSystem only reads it when the
    // session first turns visible, by which time it has long streamed in (and
    // the intro still plays its splat + tagline if it somehow has not).
    [INTRO_LOGO_KEY]: {
      url: '/brand/logo.png',
      type: AssetType.Texture,
      priority: 'background',
    },
    // ROUND8-NEATNIKS — the Meshy-generated cast (unrigged, one textured
    // PBR mesh each, WebP textures). Background: TargetSystem builds its pool
    // from robot.gltf at registerSystem and swaps each archetype's real art in
    // at the next Countdown once it has streamed (PipSystem polls for Pip), so
    // they never block boot and a missing file only logs a warning.
    ...Object.fromEntries(
      [
        NEATNIKS.archetypes.mopsy,
        NEATNIKS.archetypes.squeegee,
        NEATNIKS.archetypes.peekaboo,
        NEATNIKS.archetypes.duke,
        NEATNIKS.pip,
      ].map((bot) => [
        bot.assetKey,
        { url: bot.url, type: AssetType.GLTF, priority: 'background' as const },
      ]),
    ),
    // ROUND2-EASEL-ASSET — a Higgsfield-generated easel (image_to_3d). Must be
    // an EMPTY easel: round 2's model was generated from a photo of an easel
    // holding a canvas, which baked a second, unpaintable board into the stand.
    // The paintable canvas is always built in code, so the painting keeps
    // working even if this asset is removed (EaselSystem falls back to its
    // primitive frame when the GLTF is not loaded yet or missing).
    [EASEL_ASSET_KEY]: {
      url: '/gltf/easel.glb',
      type: AssetType.GLTF,
      priority: 'background',
    },
    // ROUND10-STUDIO-ASSETS — Higgsfield gpt_image_2_5 art for the Studio:
    // gallery frames (transparent centres) and the target range's cut-outs.
    // Background: only read once the player enters Chill, and EaselSystem /
    // StudioSystem fall back to AssetManager.loadTexture (or unframed /
    // untextured) if one has not streamed yet. Stencil masks are pixel data,
    // not textures, so StudioSystem loads those itself.
    ...Object.fromEntries(
      [
        STUDIO.frames.rect,
        STUDIO.frames.square,
        STUDIO.frames.round,
        { key: STUDIO.bullseyeKey, url: STUDIO.bullseyeUrl },
        { key: STUDIO.balloonKey, url: STUDIO.balloonUrl },
      ].map((art) => [
        art.key,
        { url: art.url, type: AssetType.Texture, priority: 'background' as const },
      ]),
    ),
    // ROUND4-WEBSHOOTER-ASSET — Higgsfield-modelled wrist web shooter
    // (image_to_3d). Round 7 ships a code-built forearm gauntlet instead
    // (the GLB is a ring cuff, which cannot lie along the forearm), so the
    // model is only streamed when WEB.shooterUseGlb asks for it.
    //
    // Must be 'critical' when it is used, unlike the easel and the palette
    // board: the shooters are built in WebShooterSystem.init(), which runs
    // during registerSystem, so a background-streamed model would always miss
    // its own construction.
    ...(WEB.shooterUseGlb
      ? {
          [WEB_SHOOTER_ASSET_KEY]: {
            url: '/gltf/web-shooter.glb',
            type: AssetType.GLTF,
            priority: 'critical' as const,
          },
        }
      : {}),
  },
  xr: {
    sessionMode: SessionMode.ImmersiveAR,
    offer: 'always',
    features: {
      handTracking: true,
      anchors: true,
      planeDetection: true,
      meshDetection: true,
      // Round 9: OPTIONAL, with the usage/format preferences the WebXR spec
      // wants alongside the feature (the bare `true` sent none, so browsers
      // could drop it). A device without depth simply starts without it, and
      // DepthSensingSystem stays a no-op. Off entirely with the config flag.
      depthSensing: RENDER.depthOcclusion
        ? {
            required: false,
            usage: RENDER.depthUsage,
            format: RENDER.depthFormat,
          }
        : false,
      layers: true,
    },
  },
  features: {
    locomotion: false,
    // Object form is load-bearing: the boolean shorthand leaves GrabSystem's
    // useHandPinchForGrab at its false default, which silently kills
    // hand-tracking pinch-to-grab — i.e. wrist-palette ammo selection and
    // easel grabbing for hand users (firing uses the separate select action
    // and never noticed).
    grabbing: { useHandPinchForGrab: true },
    physics: true,
    sceneUnderstanding: true,
    // environmentRaycast deliberately off: robots spawn on a ring around the
    // player, not via hit-test placement, so the system would be pure overhead.
    spatialUI: {
      forwardHtmlEvents: true,
      preferredColorScheme: 'dark',
    },
  },
}).then((world) => {
  // Register custom components the ECS needs to know about before the first
  // entity is created.
  world
    .registerComponent(Ball)
    // Round 10: the summonable wrist menu (replaces the palette's PaintDab /
    // KindChip / BlasterModePad / WebModePad / PaletteRoot).
    .registerComponent(WristMenuRoot)
    .registerComponent(WristMenuGem)
    .registerComponent(SplatterField)
    .registerComponent(Target)
    .registerComponent(Easel)
    .registerComponent(FloorGuard)
    .registerComponent(Gauntlet)
    .registerComponent(WebStrand);

  // Signals first: registerSystem runs each System.init() synchronously, and
  // those inits bind the globals below.
  seedGlobals(world);

  // Lighting + tone curve. EnvironmentSystem picks the IBLTexture up on its
  // next update and PMREMs it once.
  setupEnvironment(world);

  // Register custom systems with explicit priorities so they run in a
  // predictable order after IWSDK's built-in simulation/input systems:
  // read real-world geometry, lay the backstop floor, notice an unscanned room,
  // move the wrist palette, aim the web shooters, fire, simulate flight, hit
  // robots, paint the room, paint the easel, score, draw the HUD, play the
  // feedback, flush events.
  //
  // The scoring/HUD/feedback trio sits above every event producer and below
  // EventFlushSystem, so each frame's events are produced, consumed once, and
  // cleared in that order. EaselSystem joins that group of consumers at 16.
  //
  // Every one of these is above IWSDK's InputSystem (priority -4), which is
  // what WebShooterSystem depends on for same-frame hand joint transforms.
  // Round 9: depth occlusion for the robots. Registered BEFORE TargetSystem
  // (whose init builds the pool and installs the first art): the system
  // patches a DepthOccludable entity's materials on its query's qualify, so it
  // must be listening first. World.create never registers it (gotcha 20).
  if (RENDER.depthOcclusion) {
    world.registerSystem(RobotDepthSensingSystem, { priority: 50 });
  }

  world
    .registerSystem(WorldCollisionSystem, { priority: 5 })
    .registerSystem(FloorGuardSystem, { priority: 6 })
    .registerSystem(SceneScanSystem, { priority: 7 })
    // Round 10: the summonable wrist menu settles this frame's open state,
    // pose and picks before anything fires (BallSpawnSystem reads
    // globals.wristMenu for shot blocking).
    .registerSystem(WristMenuSystem, { priority: 8 })
    // Round 8: the gauntlets pose both arms first (9) and publish this frame's
    // muzzles; gestures/strands (10) and the trigger (11) read them. Gauntlet
    // must also be REGISTERED before WebShooter: its init builds the spinneret
    // the web selector pads are parented into.
    .registerSystem(GauntletSystem, { priority: 9 })
    .registerSystem(WebShooterSystem, { priority: 10 })
    .registerSystem(BallSpawnSystem, { priority: 11 })
    .registerSystem(BallFlightSystem, { priority: 12 })
    .registerSystem(TargetSystem, { priority: 14 })
    .registerSystem(SplatterSystem, { priority: 15 })
    .registerSystem(EaselSystem, { priority: 16 })
    // Round 10: after EaselSystem (it marks the easel as Studio-managed and
    // takes its stamp feed in init) and BallFlightSystem's impacts.
    .registerSystem(StudioSystem, { priority: 17 })
    .registerSystem(GameStateSystem, { priority: 30 })
    // Round 9: the tutorial reads this frame's events and drives
    // GameStateSystem's practice round; the coach reads spawn events. Both
    // write signals the HUD (35) and Pip (39) paint this same frame.
    .registerSystem(TutorialSystem, { priority: 32 })
    .registerSystem(CoachSystem, { priority: 33 })
    .registerSystem(HudSystem, { priority: 35 })
    .registerSystem(FeedbackSystem, { priority: 36 })
    // Round 7 particle juice: another read-only event consumer, so it sits in
    // the same consumer band, after the sound it decorates and before the flush.
    .registerSystem(VfxSystem, { priority: 37 })
    // Round 8 enter-AR intro. A pure consumer like the trio above: it reads
    // input edge state (pinch/trigger = skip) and the visibility signal, and
    // only ever toggles the HUD's visibility — never its state or input — so
    // it runs after HudSystem (35) has written the panel this frame and
    // before the event flush. Emits no events.
    .registerSystem(IntroSystem, { priority: 38 })
    // Round 8: Pip the mascot. Reads the HUD panel's pose (moved by its
    // Follower) and the phase; writes nothing anyone else reads.
    .registerSystem(PipSystem, { priority: 39 })
    .registerSystem(EventFlushSystem, { priority: 90 });

  seedWristMenu(world);
  seedSplatterField(world);
  seedHud(world);

  // Landing overlay: ENTER AR now works, and the overlay hides while an
  // immersive session runs (it returns when the player exits to the browser).
  landing.bindWorld(world);
  world.visibilityState.subscribe((state) => {
    landing.setVisible(state === VisibilityState.NonImmersive);
  });

  // Dev builds only: expose the world so a headless Playwright run (see
  // scripts/headless-verify.mjs) can drive state the IWER emulator cannot
  // reach — the cloud sessions this repo is worked in have no MCP relay.
  // Vite statically replaces import.meta.env.DEV, so production strips it.
  if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
    const debug = window as unknown as {
      __PB_WORLD?: World;
      __PB_THREE?: Record<string, unknown>;
    };
    debug.__PB_WORLD = world;
    // The same three.js instance the app renders with, so a harness can add
    // debug geometry (e.g. joint markers when the hand meshes cannot stream).
    debug.__PB_THREE = {
      Mesh,
      SphereGeometry,
      CylinderGeometry,
      MeshBasicMaterial,
      Vector3,
    };
  }
});
