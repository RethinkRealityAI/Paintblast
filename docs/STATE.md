# Splotopia — Living State Document

> **Splotopia was called PaintBlast MR until Round 9.** Identifiers, folders and
> the hosting URL that still say "paintblast" are deliberate leftovers (see below).
>
> **Read this first in every new session.** It is the single source of truth for
> what the platform is, how it got here, and what is still open. The rules for
> keeping it alive are in [CLAUDE.md](../CLAUDE.md) (top section, "Documentation
> protocol"). Last updated: **2026-10-03 (Round 9 merged on branch
> `claude/pensive-sagan-h7mair`)**.
>
> **Competition:** the game is entered in the Meta VR Start Developer
> Competition 2026 (Gaming / Adapted, deadline Nov 18). Strategy and roadmap:
> [COMPETITION_PLAN.md](COMPETITION_PLAN.md). Devpost copy, judge steps, video
> shot list, provenance and pre-submit checklist: [SUBMISSION.md](SUBMISSION.md).
> The pre-competition production deploy (Aug 19) is the "Adapted" baseline —
> never delete it: https://6a8538f321c2e38c9f5fa08e--paintblast-mr.netlify.app

## What this is

A mixed-reality paint arcade for Meta Quest 3/3S built on Meta's Immersive Web
SDK (`@iwsdk/core` 0.3.1). The player's real room is the arena; the enemy is
**the Neatniks**, neat-freak cleaning robots. Live at
**https://paintblast-mr.netlify.app** (Netlify site `paintblast-mr`, team
`rethinkrealityai`, folder linked; URL kept through the rebrand **pending an
owner decision** — renaming breaks the old link, QR and OG tags). A techno-paint
2D landing page fronts the WebXR app; entering AR plays a logo intro, then the
title HUD, then (first run only) Pip's tutorial.

**Names (R9 rebrand) — player-facing vs code.** Game: Splotopia (package
`splotopia`). Enemies: Neatniks (config `NEATNIKS`, enum `Neatnik`, art in
`public/gltf/neatniks/`). Web launcher/ammo: **GOO** in every label (code keeps
`BlasterMode.Web`, `BallStyle.Web`, `WEB.*`, `WebShooterSystem`). Finger-curl
gesture: **FLICK** (code keeps `isThwipPose`, `HAPTICS.thwip*`). Console prefix
`[Splotopia]`. localStorage `splotopia.*` (see Persistence).

## Current feature inventory (post Round 9)

| Area | State |
|---|---|
| **Launchers** | `globals.blasterMode` = `BlasterMode` {Hand 0, Paint 1 (label BLASTER), Web 2 (label **GOO**)}; default BLASTER. Chosen on the palette's 3 mode pads or the HUD **LOADOUT** screen. Kept in lockstep with `activeStyle` by `syncBlasterMode` (GOO ammo ⇔ GOO mode; leaving GOO returns to the last paint mode). |
| **Gauntlets** | **GauntletSystem** owns both arms' `WristPose`. Code-built forearm bracer (aim frame) + back-of-hand plate (wrist frame); BLASTER adds barrel + canister glowing `activeColor`; GOO adds the spinneret underneath (tip `WEB.muzzleLocal`, parent of the SPLAT/TETHER pads). HAND shows nothing. 5 skins, index in `splotopia.blasterSkin`. Mode change emits `BlasterModeChanged`. |
| **Firing** | Trigger / hand-pinch; BLASTER/GOO launch from `globals.gauntletMuzzles`, HAND from the target ray. BLASTER holds to auto-fire (`autoFireCooldownMs` 150). Never fires while `paused`. Thrust gesture fires whatever is loaded; the **FLICK finger-curl is off by default** (R9, `WEB.gestureEnabled: false` — reads as the rock sign, misfires, IP-adjacent). Aim assist (4° paint / 9° goo), swept robot hits. |
| **HUD shot-blocking (R9)** | `panelBlockMode`: a **hidden** panel never blocks (intro hides the HUD object3D). Idle / GameOver / Chill block over the real laid-out panel rect; **Countdown / Playing, and any time the tutorial runs, block only over visible buttons** (ids prefixed `FIRE.uiInteractiveIdPrefix` `btn-`, slop `uiButtonMarginMeters` 0.01) — the docked HUD used to silently eat low shots at the Duke. Gestures stay exempt. |
| **Ammo / palette** | Left wrist: 4 paint dabs, 5 chips (NORMAL/BOUNCY/STICKY/SPLASH + **GOO**), 3 mode pads (HAND/BLASTER/**GOO**); labels mapped at print time by `paletteLabelText`. Poke, controller squeeze (`trySelectByProximity`) or right fingertip pinch (consumed). R9: a **hidden** palette's elements are no longer selectable (`visibleInWorld`). |
| **Holo palette** | `PALETTE.boardStyle` `'holo'` (default) / `'glb'` / `'wood'`. Pops in on tracking, hides after `hideAfterLostSec` 0.5 s untracked (never while parked). `handLift` 0.08, faces the eyes, parks under the poking finger. |
| **GOO / tether** | Goo ×1.15 speed (tunnelling cap), 0.35 gravity, strands, goo decals (pool 192). R9: strands wear the loaded paint colour (`WEB.gooUsesPaintColor`), tether lines lifted toward white (`gooTetherLift` 0.35); the ball and decals are unchanged. Sub-modes SPLAT / TETHER (pads or **B**). Tap releases, hold reels (pull / pinch / squeeze queue). Pops within 0.7 m of the head. R9: a non-boss bot let off the line drifts back out to `ROOM.spawnMinDist` over `NEATNIKS.releaseReturnSec` 1.0 s. |
| **Neatniks** | TargetSystem. Pool of 14 fixed per archetype: **Mopsy** ×7 (1 HP, 100), **Squeegee** ×3 (1 HP, 150), **Peekaboo** ×3 (1 HP, 200), **Duster Duke** ×1 (6 HP, 600). Points ride the pop event (`packPopData`). Meshy GLBs stream in background; slots wear robot.gltf until the next Countdown swaps art. Procedural animation only. R9: emits `BotSpawned` on every spawn. |
| **Spawning** | Wave director (`NEATNIKS.waves`: 0 s Mopsy ×3; 22 s and 48 s mixed ×4), emptiest of 5 lanes in the 150° forward arc, room-clamped, `maxConcurrent` 5, `heightMax` 1.7. R9: **`waveBreatherSec` 3** — no new spawns for 3 s at each wave boundary after the first. |
| **Bot behaviours** | **Squeegee** front-cone shield (140°) deflects unless bounced / TETHER / SPLASH / flanked; deflect ≤ 9 m/s. **Peekaboo** hides behind bounded furniture (top 0.35–1.4 m), peeks 1.5 s, hittable at lift ≥ 0.6; R9 `peek.minSpacing` 0.3 m (slides along the furniture or picks another piece). **Duster Duke** drops in at 20 s left (`BossEntered`), tether haul = 2 dmg then walks home, pops into 2 Mopsys; R9: a Duke popped inside `spawnMinDist` splits around his home slot (`splitCentre`), not in your face. |
| **Depth occlusion (R9)** | `RENDER.depthOcclusion` true: `depth-sensing` requested **optional** with `depthUsage` `'gpu-optimized'` / `depthFormat` `'float32'`; **RobotDepthSensingSystem** (subclass of IWSDK's `DepthSensingSystem`, in `TargetSystem.ts`) occludes **robots only** (`DepthOccludable` re-added after every art install). It checks the runtime really has the depth API and otherwise disables itself for the rest of that XR session with one `[Splotopia] depth occlusion off: …` warning (a new session retries) — IWER grants the feature but has no API, and the stock system threw every frame (aborting the world update). Splats and balls are never occluded (gotcha 20). **Unverified on Quest.** |
| **Tutorial (R9)** | **TutorialSystem**, Pip-led, hands-only, seated, ~1 min. Auto-runs the first time a session reaches the title (`TUTORIAL.autoStart`, `startDelaySec` 0.8 after the intro) until done/skipped (`splotopia.tutorialDone`); the title's **TUTORIAL** button replays it. Steps (HUD "STEP n OF 5"): 1 **Fire** — pinch at a neon ring on the nearest real wall (`room-probe.ts`; floats 1.5 m ahead without scene data); ring hit within 0.35 m, or any 4 impacts. 2 **Palette** — tap a dab/chip/pad. 3 **Pop** a Mopsy. 4 **Goo → Tether → Haul** (three sub-lines; regresses if GOO/TETHER is unloaded; done on `TetherPopped`). 5 **Ready** — 2.2 s, then the title with PLAY pulsing (`HUD.playHighlightSec` 6 / `Hz` 1.6). Steps 1–2 run in the Idle sandbox; 3–4 in a **practice round** (`GameStateSystem.startPractice`: Playing with the clock held at `roundSec` → wave 0, Mopsys only, no score/combo/stats, no Duke, no RoundStart/RoundEnd; `globals.practice`). Skip: docked-card **SKIP** button or both pinches/triggers held `skipHoldSec` 2.5 s. PLAY / A / X (a real round straight from practice) or CHILL mid-tutorial counts as a skip. Leaving AR drops it un-remembered. Step chime; `TutorialStepDone` per step. |
| **Pip** | PipSystem mascot beside the HUD in Idle / GameOver / Chill; flies off in Countdown/Playing; double spin on a new best. R9: during the tutorial follows `globals.pipFocus` (beside the ring, over the wrist palette, by a Mopsy) and shows the step line in a canvas **speech bubble** (`tutorialLine`). No Interactable, no physics. |
| **Coaching (R9)** | **CoachSystem**: first time a Squeegee / Peekaboo / Duster Duke appears in a **real** round (never practice), a tip replaces the status line for `COACH.showSec` 3.2 s (`globals.coachLine`) and floats over the bot (canvas label, no raycast). Seen types = bitmask in `splotopia.coachSeen`. Keys off `BotSpawned` + `BossEntered`. |
| **Results card (R9)** | GameOver shows final score, NEW BEST / BEST, pops per Neatnik, SHOTS, HITS (damage or tether latch), ACCURACY, BEST COMBO and one `nextGoalLine` (pop verb → Duke tip → milestone → points to beat best). From `globals.roundStats` (`recordRoundEvent`). `GAME.gameOverSec` **12** (was 8); PLAY AGAIN works throughout. |
| **Intro** | IntroSystem: logo bursts from a neon splat + particle ring + "YOUR ROOM IS THE ARENA", lifts away (~3.4 s); pinch/trigger skips. R9: **only plays when the phase is Idle** (re-entering AR mid-round used to hide the HUD over a live round); **snaps to the nearest real wall** in 0.9–3.2 m (`INTRO.wallSnap`, normal within 30° of horizontal, 5 cm standoff, apparent size kept, scale clamped 0.8–1.7); floats at 1.5 m otherwise. Exposes `finished` (tutorial waits on it). |
| **HUD** | Dark glass + neon + drips + 3:1 Splotopia logo. R9 copy/legibility pass: min font **1.8** panel units; title = kicker, logo, tagline "The Neatniks are tidying your room. Paint them out!", **PLAY**, **CHILL MODE** + **TUTORIAL**, loadout readout + **LOADOUT >** (the old Armory, now titled LOADOUT), right-hand hint; **WEB MODE button and how-to tiles removed**. Playing: score, timer, combo, "N Neatniks" pill, status `GAME.playingStatusText` / coach tip. Tutorial card (docked): STEP n OF 5, line, 5 dots, SKIP. `playScale` **0.9** (was 0.75). Idle status "Press PLAY to start, or CHILL MODE to just paint". |
| **Game loop** | Idle → Countdown(3s) → Playing(90s) → GameOver(12s) → Idle; plus the tutorial's practice Playing. Pause freezes everything (`PauseClock`). Best score in `splotopia.bestScore`. |
| **Chill** | No timer/robots/score. Easel canvas, SAVE (`splotopia-painting-N.png`) / NEW / ROTATE, two-hand grab (smoothed). R9: easel spawns **0.7 m** ahead (seated reach), board centre at eye height (`boardBelowEyes` 0) clamped 0.85–1.8 m, bottom edge above the docked HUD; **pinch-grabbing the easel never sprays** (`Easel`+`Pressed` consumes active pinches, incl. a second hand joining). |
| **Balls** | R9: no longer `Interactable` / `OneHandGrabbable` (uncapped grab-throws tunnelled walls). |
| **Room collision / scan** | XRPlane → colliders (vertical **and, R9, ceilings** — label `ceiling` or height ≥ `ROOM.ceilingMinHeightMeters` 1.9 — get 6 cm boxes), labeled XRMesh → colliders, global mesh → TriMesh (`isBounded3D === false`), FloorGuard slab; census `[Splotopia] room colliders: …`. SCAN ROOM only user-initiated after 6 s. |
| **Rendering** | Room IBL, PBR Neutral, clearcoat balls, robot rim, VfxSystem (256 particles), robot-only depth occlusion (above). |
| **Landing page** | `src/landing/`: Splotopia key art + logo, click-to-splat, "Meet the Neatniks" roster, HAND/BLASTER/GOO, hands-only steps, Chill, CTA + QR; meta/OG/Twitter rebranded; favicon `/brand/icon-256.png`. |

## Persistence (localStorage)

`splotopia.bestScore` and `splotopia.blasterSkin` read through
`readWithLegacyFallback` (`src/storage-migrate.ts`): the old `paintblast.*` value
is copied forward once. `splotopia.tutorialDone` ('1') and `splotopia.coachSeen`
(bitmask, bit = archetype index) are new in R9 — no legacy key. All access is
try/catch (`readFlag`/`writeFlag`/`readMask`/`writeMask`).

## Architecture map

One system per file in `src/systems/`, components co-located, no barrels.
Cross-system state = signals in `world.globals` + a fixed 64-slot
`GameEventBuffer` (emitted < priority 90, flushed at 90).

| System | Prio | Owns |
|---|---|---|
| WorldCollisionSystem | 5 | Planes (walls + R9 ceilings thickened) / meshes / global mesh → static colliders, census |
| FloorGuardSystem | 6 | Invisible floor slab |
| SceneScanSystem | 7 | `sceneScanMissing` detection |
| WristPaletteSystem | 8 | Palette pose, poke-park lock, holo appear/hide, slot lighting, `paletteLabelText` |
| GauntletSystem | 9 | Both `WristPose`s, hardware, deploy/stow, skins, recoil, `gauntletMuzzles`. **Registered before** WebShooter |
| WebShooterSystem | 10 | Gesture triggers, goo strands (paint-tinted), tether reel queue, SPLAT/TETHER pads |
| BallSpawnSystem | 11 | Fire paths, `resolveFireGate`, `panelBlockMode`/`rayHitsLocalRect`, easel-grab pinch consumption, hidden-palette guard, ammo/mode selection, aim assist |
| BallFlightSystem | 12 | Velocity-delta impact detection, per-kind behaviour, dissolve-on-rest |
| TargetSystem | 14 | Neatnik pool + art swap, waves/breather/lanes, shield, peek spacing, boss + split, release drift, swept hits, tether API, `aimTargets`, `BotSpawned` |
| SplatterSystem | 15 | Instanced decal pools (paint 512 / goo 192) |
| EaselSystem | 16 | Chill easel canvas, `easelCentreHeight` |
| GameStateSystem | 30 | Phase machine, timer, score, combo, best, `paused`, **practice round** (A/X from practice starts a real round), **`roundStats`** |
| TutorialSystem (R9) | 32 | Step machine, wall ring, skip hold, `tutorialStep`/`tutorialLine`/`pipFocus`; drives `startPractice`/`endPractice` |
| CoachSystem (R9) | 33 | First-encounter tips, floating label, `coachLine` |
| HudSystem | 35 | Signals → panel, LOADOUT screen, tutorial card, results card, coach line, PLAY pulse, docking |
| FeedbackSystem | 36 | Events → SFX + haptics, chill music |
| VfxSystem | 37 | Events → pooled particle bursts |
| IntroSystem | 38 | Enter-AR logo intro (Idle only, wall snap); HUD object3D visibility |
| PipSystem | 39 | Mascot, tutorial focus + speech bubble |
| RobotDepthSensingSystem (R9) | 50 | Depth texture + robot occlusion uniforms; self-disables per session without a depth API. **Registered first** (before TargetSystem builds the pool — it patches materials on query qualify), only when `RENDER.depthOcclusion` |
| EventFlushSystem | 90 | Clears the event buffer |

Globals contract (seeded in `main.ts` **before** `registerSystem`): `gamePhase,
score, bestScore, combo, timeLeft, targetsAlive, paused, activeKind,
activeStyle, activeColor, webSubMode, blasterMode, blasterSkin, tetheredHands,
sceneScanMissing, hudScore, hudTimer, hudStatus, gameEvents, aimTargets`, and
R9's `tutorialStep` (TutorialStep), `tutorialLine`, `pipFocus` (`PipFocus`
struct: `active`, `position`, `offset`), `practice`, `roundStats`
(`RoundStats | null`, published at GameOver), `coachLine`. Exception:
`gauntletMuzzles` is created in `GauntletSystem.init()`. Structs instead of
system calls where a reverse import would close a module cycle.

Game events: R8 `BlasterModeChanged` 15, `ShieldDeflected` 20, `BossEntered` 21;
R9 **`BotSpawned` 22** (pos = spawn point, data = `packPopData(slot, archetype,
0)`) and **`TutorialStepDone` 23** (data = step completed). `TargetPopped` data =
`packPopData(slot, archetype, points)`.

Shared non-system modules: `src/wrist-frame.ts`, `src/wrist-pose.ts`,
`src/types.ts` (enums, events, pure UI/tutorial/results helpers:
`tutorialStepNumber`, `nextTutorialStep`, `shouldCoach`, `recordRoundEvent`,
`accuracyPercent`, `nextGoalLine`, `ammoLabel`, …), **`src/room-probe.ts`** (R9:
`RoomProbe` spawn-time raycast against scene planes/meshes, `isWallNormal`,
`yawFacingNormal`, `apparentScale` — used by the intro and the tutorial ring),
**`src/storage-migrate.ts`** (R9).

All tunables: `src/config.ts` (BALLS, FIRE, IMPACT, SPLAT, BALL_KIND_CONFIG,
GAME, TARGETS, HUD, PALETTE, ROOM, FLOOR, CHILL, EASEL, WEB, AUDIO*, HAPTICS,
RENDER, VFX, BLASTER, INTRO, **TUTORIAL, COACH, NEATNIKS**). Knob map:
[GAME_GUIDE.md](../GAME_GUIDE.md). `TARGETS.poolSize` must equal the sum of
`NEATNIKS.archetypes.*.pool` (test-pinned); `TARGETS.heightMeters`,
`bobAmplitude`, `turnDegPerSec` are legacy/unused.

Headless verification (no IWER MCP relay): `npx vite --config
vite.verify.config.ts` (port 8090, no mkcert) then
`PW_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node
scripts/headless-verify.mjs [url] [outDir] [hand|controller] [default|gauntlet]`.
`ALIGN=1` sets `WEB.handAimSource = 'hand'`. The harness injects
`scripts/swiftshader-smoothstep-patch.js` (without it uikit renders nothing),
waits out the intro, hides IWSDK's cursor. ~5 fps: trust poses, not timing.
IWER has **no scene data for wall snap** and **no depth API** (occlusion
self-disables there), so both are on-device only.

## Asset inventory & generation pipeline

| Asset | Path | Recipe |
|---|---|---|
| Splat mask | `public/textures/splat.png` | Higgsfield `nano_banana_pro` white-on-black → **alphaMap** |
| Goo masks | `public/textures/web-splat.png` (+ `-burst` spare) | same technique |
| **Neatniks** | `public/gltf/neatniks/{mopsy,squeegee,peekaboo,duster-duke,pip}.glb` (renamed from `splotbots/` in R9) — ~5 MB | Concepts (`docs/concepts/*.jpg`, Higgsfield) → **Meshy image-to-3D**, unrigged textured PBR, 1024 WebP. Measured/rescaled to `heightMeters`/`sizeMeters`; facing via `yawOffsetDeg` |
| Robot (fallback) | `public/gltf/robot/robot.gltf` | pre-existing; `critical` (pool built from it). **Believed to be an IWSDK starter-template asset — unconfirmed** |
| Plant (unused) | `public/gltf/plantSansevieria/` | not loaded; same unconfirmed starter-template provenance |
| Easel | `public/gltf/easel.glb` | **"empty easel, NO canvas"** image → Higgsfield `image_to_3d` |
| Palette board | `public/gltf/palette-board.glb` | Higgsfield `image_to_3d`; only with `boardStyle: 'glb'` |
| Web shooter | `public/gltf/web-shooter.glb` | Not loaded (`WEB.shooterUseGlb: false`) |
| **Brand (R9)** | `public/brand/logo.png` (1400×472, **3:1**, intro + HUD texture), `logo-512.png` (512×172), `logo-on-black.jpg`, **`icon-256.png`** (square splat favicon); R8 `keyart.jpg`, `og.jpg` (no wordmark), `ui-bg.jpg` | Logo: Higgsfield **`gpt_image_2_5`** with the R8 logo as style reference, background removed |
| Landing | `public/landing/` keyart, logo-360/1100 (R9 3:1), ui-bg, gauntlets, chill, masks, `bots/*.webp`, `qr-play.png` | WebP downscales; QR via `scripts/gen-qr-asset.mjs` |
| SFX ×9 / music | `public/audio/*.mp3` — R9 renamed `thwip.mp3` → **`flick.mp3`** (`AUDIO.flick`) | Higgsfield `mirelo_text_to_audio` / `sonilo_music`. Tutorial chime reuses `chime.mp3` |

Models are measured and rescaled at runtime, so **swapping any GLB never needs
a code change**. Entries read during `init()` must be `priority: 'critical'`;
Neatnik GLBs are not (swapped at Countdown; PipSystem polls). Licence
confirmation for every generated asset is tracked in SUBMISSION.md §6.

## Round history (why things are the way they are)

1. **R1 (2026-08-16)** — Phase-1 migration into a full game; Netlify + QR
   tooling; elics `getValue` throws on vectors; **no physics collision events**
   (→ velocity-delta impacts).
2. **R2** — Landing; HUD docking (PivotY discards Y → face-target; resize via
   maxWidth); wrist palette; **PanelUI needs `Interactable`**, panels never get
   `Hovered`; `useHandPinchForGrab` load-bearing; chill + easel.
3. **R3** — Painter's palette; **touch>grab>ray swallows squeezes** (→
   `trySelectByProximity`); rest-dissolve; empty easel; ROTATE CANVAS.
4. **R4** — Removed auto room-capture; FloorGuard slab (**no CCD**); Web Mode v1.
5. **R5** — **Guardian ≠ scene data** (→ user-initiated SCAN ROOM); web as
   ammo; grip frames right-handed on BOTH hands.
6. **R6** — **Barrier root causes**: 1 mm planes (→ 6 cm boxes), unlabeled
   global mesh (→ TriMesh). Tether web; census log. 334 tests.
7. **R7 (2026-10-01, competition kickoff)** — **Hands are not controllers**
   (hand grip −Z = thumb → `WristPose`); forearm gauntlet; reel queue;
   pinch-select; aim assist; swept hits; sRGB; pause/resume; seated arc; IBL;
   VfxSystem; headless harness. 502 tests.
8. **R8 (2026-10-02, content round)** — *Why: one generic robot and a plain UI
   could not compete.* Landing + brand + IntroSystem; GauntletSystem (HAND /
   BLASTER / WEB, skins, auto-fire); the robot cast (then "Splotbots") with
   wave director, shield, furniture hiding, boss; PipSystem; techno-paint HUD +
   Armory; holo palette; `heightMax` 1.7. 670 tests.
9. **R9 (2026-10-03, rebrand + audit + onboarding)** — *Why: the name and the
   web mechanic carried IP risk, an adversarial audit found mechanics that
   silently failed, and judging weighs the first five minutes.* **Rebrand**:
   PaintBlast MR → **Splotopia** (clashes with mobile "Paint Blast" games);
   Splotbots → **the Neatniks** ("Splatterbot", a 2025 Steam/Switch game); WEB →
   **GOO**, THWIP → **FLICK** (Spider-Man IP); finger-curl off by default;
   identifiers renamed (`NEATNIKS`, `Neatnik`, `public/gltf/neatniks/`); new 3:1
   logo + square favicon; storage keys migrated; hosting URL unchanged.
   **Audit fixes**: HUD no longer silently blocks shots; easel pinch-grab never
   sprays; Duke split away from the face, released bots drift out; Peekaboo
   spacing; balls not grabbable; hidden palette not selectable; ceilings
   thickened; easel 0.7 m (seated reach); 3 s wave breather; intro only over
   Idle; robot depth occlusion (RobotDepthSensingSystem, self-disabling).
   **Onboarding**: Pip-led tutorial with practice round, SKIP + two-pinch hold,
   TUTORIAL replay; CoachSystem first-encounter tips; GameOver results card
   (12 s); HUD copy pass (LOADOUT, WEB MODE removed, min font 1.8, "Press
   PLAY", `playScale` 0.9); intro logo + tutorial ring snap to the real wall.
   Review fixes: A/X from practice starts a real round, depth occlusion retries
   on a new session, the tutorial card blocks shots only over its buttons.
   Submission pack `docs/SUBMISSION.md`. **763 tests.** Verified by tsc, tests
   and the headless harness; depth and wall snap could not be exercised (IWER).

Full specs: `docs/superpowers/specs/`. Concept art: `docs/concepts/`.

## Open items / on-device checklist

R8 and R9 are verified by tsc, 763 unit tests and the headless IWER harness
only — **every item below needs a headset** (Quest 3 *and* 3S).

**Round 9**
- [ ] **Depth occlusion actually occludes** robots behind real furniture: is
      `gpu-optimized` + `float32` accepted (else the console shows `[Splotopia]
      depth occlusion off`; try `cpu-optimized` / `luminance-alpha`)? Frame cost
      at 72 fps; transparent sorting of robot materials vs the occlusion pass;
      camera near/far vs the depth range (robots popping or halo at edges).
- [ ] **Wall snap** for the intro logo and the tutorial ring with real Space
      Setup data (the emulator had none): right wall picked, standoff, no
      z-fight, logo scale reads; float fallback in an unscanned room.
- [ ] Tutorial **tether haul with a real reel** (Goo → Tether → Haul completes on
      `TetherPopped`; regress lines when unloading GOO/TETHER).
- [ ] **Skip hold** (both pinches 2.5 s) never fires by accident during
      two-handed auto-fire in the Pop step; SKIP button reachable on the card.
- [ ] Pip speech-bubble readability (near the wrist and at the ring); Pip not
      hiding the palette he points at (`TUTORIAL.pipWrist*`).
- [ ] Docked HUD at `playScale` 0.9: still below the sight line, card/results
      text legible at min font 1.8; coach floating label readable.
- [ ] **Ceiling collisions**: high lobs splat on the ceiling, no tunnelling; no
      table/shelf misclassified (≥ 1.9 m rule).
- [ ] **Easel seated reach** (0.7 m, eye-height board): grab with both hands,
      board clears the docked HUD when leaning in, no spray on grab.
- [ ] **Release drift** (1.0 s back to 0.9 m) and the **3 s wave breather** feel
      right; Duke split lands away from the face.
- [ ] HUD shot-blocking in play: low shots under the docked strip reach the
      Duke; clicks on the strip's buttons never also fire.
- [ ] Results card in 12 s: readable, PLAY AGAIN works throughout.
- [ ] Storage migration on a headset that played PaintBlast MR (best + skin
      carried forward).

**Carried from R8**
- [ ] Bracer vs back-plate alignment when the OS ray disagrees with the hand
      (`WEB.rayBlendNearDeg/FarDeg`, `handAimSource: 'hand'`).
- [ ] Gauntlet fit on real forearms, hands and controllers.
- [ ] Left-hand BLASTER shots through the palette board?
- [ ] Auto-fire feel (150 ms); no pinch-fire while selecting on the palette.
- [ ] **72 fps** with ~18 gauntlet meshes per arm + full cast + boss + double
      pop (+ depth occlusion now).
- [ ] Squeegee deflect feel; Peekaboo 1.5 s peek readability at 2–3 m.
- [ ] Duster Duke's landing vs the docked HUD; Pip placement beside the HUD.
- [ ] Palette vs gauntlet clearance; holo board + label legibility on passthrough.
- [ ] LOADOUT skin dots (3.4 cm) — pinch/ray reliability.
- [ ] Intro timing (~3.4 s) and skip; mode-switch cue volume.

**Carried from R7**
- [ ] Wrist-bent-back pose: OS ray stays on target?
- [ ] Tether latch → pull-reel → pinch-hold → pop; tether on the Duke = 2 dmg.
- [ ] Hand palette palm-down/up; left-palm pose never triggers Quest's
      palm-pinch system menu; clean hide/reappear on tracking loss.
- [ ] Aim assist feel; pause mid-round and mid-tether resumes exactly.
- [ ] Seated round within the 1.7 m height cap; IBL vs passthrough;
      first-shot clearcoat hitch.
- [ ] SCAN ROOM on a never-scanned room; census after Space Setup; SAVE
      PAINTING while immersed.

**Known gaps / owner decisions** (COMPETITION_PLAN.md): Netlify URL rename (keep
`paintblast-mr` or move to a Splotopia URL + QR/OG); trademark knockout search
for "Splotopia"; asset licence confirmation (SUBMISSION.md §6); IWSDK 0.3.1
(1.0.x is current); Neatniks unrigged; no progression / daily challenge yet;
multiplayer open; voice commands out of scope.
