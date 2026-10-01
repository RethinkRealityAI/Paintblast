# PaintBlast MR — Living State Document

> **Read this first in every new session.** It is the single source of truth for
> what the platform is, how it got here, and what is still open. The rules for
> keeping it alive are in [CLAUDE.md](../CLAUDE.md) (top section, "Documentation
> protocol"). Last updated: **2026-10-01 (Round 7 on branch, not yet deployed)**.
>
> **Competition:** the game is being entered in the Meta VR Start Developer
> Competition 2026 (Gaming / Adapted, deadline Nov 18). Strategy, requirement gap
> matrix, roadmap and art bible: [COMPETITION_PLAN.md](COMPETITION_PLAN.md). The
> pre-competition production deploy (Aug 19) is the "Adapted" baseline — never
> delete it: https://6a8538f321c2e38c9f5fa08e--paintblast-mr.netlify.app

## What this is

A mixed-reality paintball arcade for Meta Quest 3/3S built on Meta's Immersive
Web SDK (`@iwsdk/core` 0.3.1). The player's real room is the arena. Live at
**https://paintblast-mr.netlify.app** (Netlify site `paintblast-mr`, team
`rethinkrealityai`, folder is linked). A 2D landing page with an interactive
paint-splatter hero fronts the WebXR app.

## Current feature inventory (post Round 7)

| Area | State |
|---|---|
| **Firing** | Trigger / hand-pinch fire along the target ray; **thrust** (forward punch, measured along the aim) and the finger-curl gesture fire along the *shown gauntlet barrel* — all fire whatever ammo is loaded, in Idle sandbox, Playing, and Chill. Per-hand shared cooldowns. Hold-to-spray in Chill only. **Aim assist** (R7): a shot within `FIRE.aimAssistDeg` (paint, 4°) / `WEB.aimAssistDeg` (webs, 9°) of a live robot — straight line *or* ballistic arc — is bent onto the arc that hits it. Robot hit test is **swept** along the ball's last-frame path. |
| **Ammo** | Wrist palette (left): 4 paint **dabs** (color) + 5 **chips** — NORMAL / BOUNCY / STICKY / SPLASH (kind) and **WEB** (style). Tap (poke), controller squeeze, and (R7) **pinch at the fingertip** (`PALETTE.pinchSelectRadius`), which consumes that pinch so it never also fires. Palette colours are **sRGB** everywhere (R7 fixed pastel rendering). |
| **Hand-mode palette (R7)** | Controllers: unchanged grip-frame mount. Hands: floats `PALETTE.handLift` straight up from the wrist joint, out over the hand, **facing the eyes** in any wrist roll. **Parks in world space** while the right index fingertip is within `PALETTE.lockRadius` (Meta: don't move a menu under the poking finger), glides back after `lockReleaseSec`. Palette GLB now lies flat (it is thin along Z; it stood on edge R3-R6). |
| **Web** | Code-built **forearm gauntlet** on both arms (R7; replaces the ring-cuff GLB, which is no longer loaded): authored along the aim axis, palm side of the forearm, straps round the arm, glowing cartridge (white = splat, sky = tether), nozzle at the wrist. Pose from `WristPose` (wrist joint for hands, ray + grip for controllers), smoothed 30 ms. Webs fly ×1.45 faster, 0.35 gravity. Strand from nozzle to impact, web-pattern decals (pool 192). Sub-modes **SPLAT** / **TETHER** via holo pads on the left gauntlet or the **B button**. |
| **Tether (R7 rework)** | Latch radius +`WEB.tetherLatchBonus` for tether webs. Reel = a per-hand **queue** paid out at ≤`reelGlideSpeed` (glide, no teleports) fed by: proportional **pull** (hand speed away from robot past a deadband × `pullGain`, ratchet), **pinch / trigger held** on the owning hand (that hand stops firing while tethered), **squeeze held**. Thrust disabled while hauling; the finger-curl gesture is the deliberate release. Hooked robots **struggle**. Pops within 0.7 m of the head through normal scoring. |
| **Game loop** | Idle → Countdown(3s) → Playing(90s) → GameOver(8s) → Idle. Robots spawn in a **150° forward arc** centred on the player's facing at round start (`TARGETS.spawnArcDeg`; 360 = old ring) — seated-friendly. **Pause/resume** (R7): losing session focus freezes timer, countdown, combo, robots, tethers and strands; resumes exactly (`PauseClock`, PAUSED pill). Combo scoring, best score in localStorage. |
| **Chill** | No timer/robots/score. Easel: balls stamp a 1024×768 canvas, SAVE / NEW / ROTATE CANVAS, two-hand grab to move (**drawn pose smoothed**, `EASEL.grabSmoothingSec`). Lofi music. **WEB MODE** title shortcut. ⚠️ Easel spawns 1.4 m away — out of reach seated (Phase 1). |
| **Room collision** | XRPlane → static colliders (vertical planes 6 cm thick), labeled XRMesh → colliders, global room mesh → static TriMesh (`isBounded3D === false`), FloorGuard slab. Census log `[PaintBlast] room colliders: …`. |
| **Room scanning** | Never automatic. `sceneScanMissing` after 6 s → SCAN ROOM → `initiateRoomCapture()`. |
| **Rendering (R7)** | `IBLTexture('room')` on the level root (lighting only — no background in passthrough), Khronos **PBR Neutral** tone mapping (`RENDER`). Clearcoat wet-paint balls, pearly webs, robot rim light. **VfxSystem**: pooled 256-particle InstancedMesh — pop confetti, impact droplets, hit spray, tether sparks, muzzle puff (`VFX`). ⚠️ **No depth occlusion**: `DepthSensingSystem` is never registered, so `DepthOccludable` tags are inert (and IWSDK's occlusion ignores instanceMatrix — splats would need a fix). |
| **HUD** | One UIKitML panel; per-phase sections + footer; docks low during play; PAUSED pill; hands-first copy ("point at a button, then pinch"). |
| **Balls** | 4 kinds; style Paint/Web; shared geometry + per-colour material cache (destroy(), never dispose()); cap 20; rest = dissolve into a splat. |
| **Landing page** | `src/landing/`: hero, click-to-splatter, feature cards, ENTER AR, QR card. Controls line is hands-first. |

## Architecture map

One system per file in `src/systems/`, components co-located, no barrels.
Cross-system state = signals in `world.globals` + a fixed 64-slot
`GameEventBuffer` (emitted < priority 90, flushed at 90).

| System | Prio | Owns |
|---|---|---|
| FloorGuardSystem | 6 | Invisible floor slab |
| SceneScanSystem | 7 | `sceneScanMissing` detection |
| WristPaletteSystem | 8 | Palette root ← left grip (controllers) / wrist joint, facing the eyes (hands); poke-park lock |
| WebShooterSystem | 9 | Gauntlets (aim frame), gesture triggers, strands, tether reel queue, holo sub-mode pads, pause shift |
| BallSpawnSystem | 10 | Fire paths (trigger + `fireFromGesture`), ammo selection (Pressed + squeeze + fingertip pinch), aim assist, ball cap, `resolveShot`/`canFireInPhase` |
| BallFlightSystem | 12 | Velocity-delta impact detection (no collision events exist!), per-kind behavior, dissolve-on-rest |
| TargetSystem | 14 | Robot pool, forward-arc spawn (room-clamped), swept overlap hits, tether API, publishes `aimTargets`, pause re-basing |
| SplatterSystem | 15 | Two instanced decal pools (paint 512 / web 192), jitter, alphaMap masks |
| EaselSystem | 16 | Chill easel, CanvasTexture painting, save/rotate |
| GameStateSystem | 30 | Phase machine, timer, score/combo, best score, status copy, `paused` (session focus) |
| HudSystem | 35 | Signals → panel, buttons, dock switching, PAUSED pill |
| FeedbackSystem | 36 | Events → SFX + haptics, chill music |
| VfxSystem | 37 | Events → pooled particle bursts (one InstancedMesh) |
| EventFlushSystem | 90 | Clears the event buffer |

Globals contract (seeded in `main.ts` **before** `registerSystem` — init() binds
synchronously): `gamePhase, score, bestScore, combo, timeLeft, targetsAlive,
activeKind, activeStyle, activeColor, webSubMode, tetheredHands, paused,
sceneScanMissing, hudScore, hudTimer, hudStatus, gameEvents, aimTargets`.
`paused` (R7) mirrors session focus; `aimTargets` (R7) is a fixed-capacity
struct TargetSystem writes and BallSpawnSystem reads (a struct, not a system
call, because TargetSystem imports BallSpawnSystem — the reverse import throws
at module load).

Shared non-system modules (R7): `src/wrist-frame.ts` (pure, tested: aim/facing
bases, quaternion from basis, smoothing, ballistic aim assist, reel queue math,
`blendAim`) and `src/wrist-pose.ts` (`WristPose`: per-hand anchor / wristQ /
aim / aimQ / palm from the wrist joint or grip+ray).

All tunables: `src/config.ts` (sections BALLS, FIRE, IMPACT, SPLAT,
BALL_KIND_CONFIG, GAME, TARGETS, HUD, PALETTE, ROOM, CHILL, EASEL, WEB, FLOOR,
AUDIO*, HAPTICS, RENDER, VFX). Player-facing knob map: [GAME_GUIDE.md](../GAME_GUIDE.md).

Headless verification (R7, for sessions without the IWER MCP relay):
`npx vite --config vite.verify.config.ts` (no mkcert, port 8090) then
`PW_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node
scripts/headless-verify.mjs [url] [outDir] [hand|controller]` → screenshots of
the forearm gauntlet (first person + side), palm-up palette, a web in flight, a
seated round and an aimed hit. It draws tracked joints + a forearm proxy because
the emulator's hand meshes stream from a CDN. Headless runs at ~5 fps — fine
for poses, meaningless for timing.

## Asset inventory & generation pipeline

All generated with the Higgsfield MCP; recipes that worked:

| Asset | Path | Recipe |
|---|---|---|
| Splat mask | `public/textures/splat.png` | `nano_banana_pro` white-splat-on-black → used as **alphaMap** (no alpha channel in PNGs — luminance IS the alpha; landing page converts luminance→alpha sprite in JS) |
| Web masks | `public/textures/web-splat.png` (+ `-burst` spare) | same white-on-black technique |
| Robot | `public/gltf/robot/robot.gltf` | pre-existing; measured & rescaled at runtime |
| Easel | `public/gltf/easel.glb` | image (**"empty easel, NO canvas"** — a canvas in the source photo bakes a phantom board into the model) → `image_to_3d` `should_texture: true` |
| Palette board | `public/gltf/palette-board.glb` | kidney palette product shot → `image_to_3d`. Authored **thin along Z**; the loader lays the thinnest axis onto +Y (`thinnestAxis`, R7) |
| Web shooter | `public/gltf/web-shooter.glb` | product shot → `image_to_3d`. **Not loaded since R7** (`WEB.shooterUseGlb: false`): it is a ring cuff that cannot lie along the forearm. A replacement must be authored long axis = model −Z, nozzle at −Z, back of hand +Y |
| SFX ×8 | `public/audio/*.mp3` | `mirelo_text_to_audio` (1–3 s prompts, "no music, no voice") |
| Chill music | `public/audio/chill-music.mp3` | `sonilo_music` 60 s (outputs m4a → `ffmpeg -codec:a libmp3lame`) |
| Landing art | `public/landing/*` | `nano_banana_pro` hero + 4 card images (downscaled to 640 px), QR via `scripts/gen-qr-asset.mjs` |

GLB manifest pattern: models are measured (`Box3.setFromObject`) and rescaled at
runtime, so **swapping any GLB never needs a code change**. Characters planned
for the competition (Meshy for rigged characters, Higgsfield for concepts and
static props): see the art bible in [COMPETITION_PLAN.md](COMPETITION_PLAN.md) §6. New GLB entries that
systems read during `init()` must be `priority: 'critical'` in the manifest.

## Round history (why things are the way they are)

1. **R1 (2026-08-16)** — Finished the half-built Phase-1 migration into a full
   game; Netlify + QR launch tooling; discovered elics `getValue` throws on
   vector fields and that IWSDK has **no physics collision events** (→
   velocity-delta impact detection, Δv ≈ contact normal).
2. **R2** — Landing page; HUD phase-docking (PivotY discards Y offsets →
   face-target; PanelUISystem cancels object3D scale → resize via maxWidth);
   wrist palette; found **PanelUI needs `Interactable` for XR ray clicks** and
   panels never receive `Hovered` (→ geometric shot-blocking); `grabbing:
   { useHandPinchForGrab: true }` is load-bearing; chill mode + easel painting.
3. **R3** — Painter's-palette redesign (dabs+chips, poke-tap); discovered the
   **touch>grab>ray pointer priority swallows squeezes near the wrist** (→
   `trySelectByProximity`); rest-dissolve rule; empty-easel regeneration;
   ROTATE CANVAS; button micro-interactions; chill music + spray.
4. **R4** — Removed the auto room-capture (fought the OS); FloorGuard slab
   (0.5 m thick — **no CCD**, thin sheets tunnel); Web Mode v1 (shooters,
   thwip via `input.visualAdapters.hand[side].jointTransforms`, strands, web
   pool, style axis on Ball).
5. **R5** — Learned **Guardian ≠ scene data** and the OS never auto-prompts
   Space Setup for WebXR (→ user-initiated SCAN ROOM); web merged into the
   palette as ammo (phase deleted); shooter band-plane fit + mirroring (grip
   frames are right-handed on BOTH hands); chip colors + text labels.
6. **R6** — **Barrier root causes**: 1 mm plane colliders (→ 6 cm wall boxes)
   and the unlabeled global mesh (→ `isBounded3D===false` TriMesh; `Auto`
   would have made a sealed ConvexHull room). Universal gestures; tether web +
   holo selector; palm-up mount (roll 180); WEB MODE title shortcut; collider
   census log. 334 unit tests.
7. **R7 (2026-10-01, competition kickoff)** — **Hands are not controllers**: the
   WebXR grip of a tracked hand points −Z at the *thumb*, so shooters, gesture
   aim and the palette (all posed off grip −Z) sat perpendicular to the forearm
   and webs flew sideways. New wrist/aim frames (`WristPose`: wrist joint for
   hands, ray + mirrored grip X for controllers); code-built forearm gauntlet
   along the aim; tether reel queue (pull ratchet / pinch / squeeze, glide not
   teleport); fingertip pinch-select that never fires; palette faces the eyes
   and parks while poked; easel grab smoothing; aim assist; swept robot hits;
   palette GLB laid flat; sRGB palette colours (pastel bug since R1).
   Parallel streams merged: pause/resume + seated forward arc + hands-first
   copy; IBL + PBR Neutral tone mapping, clearcoat balls, VfxSystem. Headless
   IWER harness for cloud sessions. 497 unit tests.

Full specs: `docs/superpowers/specs/`. Session-level detail lives in the
orchestrating agent's memory, but this file must stand alone.

## Open items / on-device checklist

R7 is verified by tsc, 497 unit tests and the headless IWER harness only — **every
item below needs a headset** (Quest 3 *and* 3S) before it ships.

- [ ] **Forearm gauntlet** on real hands: lies along the forearm, nozzle at the
      wrist, webs leave along the barrel. Tune `WEB.handAimSource`
      ('ray' vs 'hand'), `rayBlendNearDeg/FarDeg`, `shooterOffsetY/Z`.
- [ ] Wrist-bent-back ("web-shooter") pose: does the OS ray stay on target?
- [ ] **Tether**: latch → pull-reel → pinch-hold reel → pop against a live robot;
      the reeling hand never fires; finger-curl gesture releases. Tune
      `pullDeadband`, `pullGain`, `reelGlideSpeed`.
- [ ] **Hand-mode palette**: above the wrist facing you in palm-down and palm-up;
      parks while the right fingertip approaches; pinch on a chip selects and
      does not fire. Tune `PALETTE.handLift/handForward/handOutward`, `lockRadius`.
      Confirm the left-palm pose never triggers Quest's palm-pinch menu (exits the session).
- [ ] Aim assist feel (`FIRE.aimAssistDeg`, `WEB.aimAssistDeg`) — invisible when
      aiming well, forgiving when not.
- [ ] Pause: open the Quest menu mid-round and mid-tether; take the headset off
      for a minute; resume is exact.
- [ ] Seated round: all robots in front; tether pops in your lap.
- [ ] Rendering: IBL brightness vs passthrough (`RENDER.iblIntensity`), first-shot
      hitch from the clearcoat program compile, rim strength, particle sizes,
      **72 fps during a double pop**.
- [ ] Vivid colours: balls/splats/dabs now match the HUD swatch.
- [ ] Easel two-hand grab feels weighty, not laggy (`EASEL.grabSmoothingSec`).
- [ ] (Carried) SCAN ROOM on a never-scanned room; census line after Space Setup;
      SAVE PAINTING download while immersed.
- Known gaps (planned, COMPETITION_PLAN.md): depth occlusion off; easel too far
  for seated play; IWSDK 0.3.1 (1.0.1 is current); web mechanic / gesture IP
  rebrand; onboarding; progression. Voice commands and multiplayer: out of scope.
