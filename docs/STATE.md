# Splotopia — Living State Document

> **Splotopia was called PaintBlast MR until Round 9.** Identifiers, folders and
> the hosting URL that still say "paintblast" are deliberate leftovers (see below).
>
> **Read this first in every new session.** It is the single source of truth for
> what the platform is, how it got here, and what is still open. The rules for
> keeping it alive are in [CLAUDE.md](../CLAUDE.md) (top section, "Documentation
> protocol"). Last updated: **2026-10-03 (Round 10 merged on branch
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
gesture: **FLICK** (code keeps `isThwipPose`, `HAPTICS.thwip*`). Chill mode's
screen is the **STUDIO** (R10; phase still `GamePhase.Chill`, title button still
CHILL MODE). Console prefix `[Splotopia]`. localStorage `splotopia.*`.

## Current feature inventory (post Round 10)

| Area | State |
|---|---|
| **Launchers** | `globals.blasterMode` = `BlasterMode` {Hand 0, Paint 1 (label BLASTER), Web 2 (label **GOO**)}; default BLASTER. Chosen on the wrist menu's LAUNCHER row or the HUD **LOADOUT** screen. Kept in lockstep with `activeStyle` by `syncBlasterMode` (leaving GOO returns to the last paint mode). |
| **Wrist menu (R10)** | Replaces the always-on palette (playtest: constant accidental presses). **WristMenuSystem** + pure `src/wrist-menu.ts`, config `MENU`. **Closed** (default): only a glowing **gem** on the left gauntlet sleeve (core = loaded colour, ring = launcher/GOO verb; `ARMFIT.gem*` socket via `GauntletSystem.menuGemInto`, fallback `MENU.gemOffset*`; shown in HAND mode on a slim band). Closed = inert: no Interactable, no proximity/pinch select, never blocks a shot. **Toggle**: right index tip pokes the gem (enter 2 cm / exit 3.8 cm hysteresis, 0.45 s debounce, ignored mid-pinch) or **Y** on the left controller. First-run pulse until `splotopia.menuOpened`. **Open**: dark-glass panel above the left forearm facing the eyes — LAUNCHER (HAND/BLASTER/GOO), GOO MODE (SPLAT/TETHER, only with GOO; the tall layout keeps the launcher row fixed), COLOUR (4), AMMO (NORMAL/BOUNCY/STICKY/SPLASH; dimmed under GOO). Poke = hover glow 3 cm, select 6 mm past the face, button sinks, one select per poke, re-arm 12 mm back out, sweep-through ignored; right controller ray (≤ 1.2 m) + trigger. Parks in world space while the tip is in the poke zone. **Closes** on gem/Y, a launcher pick except GOO, a SPLAT/TETHER pick (`closeOnPick`), 6 s idle, 0.6 s left-hand loss, and a round entering Countdown or GameOver (practice Playing keeps it). Only a tracked right **hand** pokes (a controller's frozen index-tip space is ignored, gotcha 21). While open: left fire paused (`pauseLeftFireWhileOpen`), the right ray at the panel is blocked, spent presses never fire (`consumeMask`). Emits `MenuToggled` + UiClick. The WEB chip and under-wrist SPLAT/TETHER pads are gone. |
| **Gauntlets** | **GauntletSystem** owns both arms' `WristPose`. **R10 arm fit** (`ARMFIT`): hand length + palm width measured from joints (radii via `XRFrame.fillJointRadii`, gotcha 32), 15 Hz, steady hands only, median-filtered 24-sample windows with outlier rejection, persisted in `splotopia.armFit` (first window of a session weighted 0.7); ANSUR-II ratios estimate wrist/forearm circumference and forearm length. An **enclosing tapered elliptical sleeve** (65 % of the forearm, 8 mm skin margin) posed along the forearm axis, blended toward an IK elbow estimate (head→neck→shoulder model) past a 15–40° dead zone, ≤ 50° from the hand. A **turret** on top carries the BLASTER barrel+canister or the **GOO launcher** (both on top now; GOO has a SPLAT coral-white / TETHER cyan state light), clamped 35° off the sleeve; puck hidden in HAND. Back-of-hand plate scales with the hand. Controllers use the default fit. 5 skins (`splotopia.blasterSkin`). `BlasterModeChanged` on swap. |
| **Firing** | Trigger / hand-pinch; BLASTER/GOO launch from `globals.gauntletMuzzles`, HAND from the target ray. BLASTER holds to auto-fire (150 ms). Never fires while `paused`. Thrust fires whatever is loaded; **FLICK off by default** (R9). Aim assist (4° paint / 9° goo), swept robot hits. |
| **HUD shot-blocking** | `panelBlockMode`: a hidden panel never blocks; Idle / GameOver / Chill block over the laid-out panel rect; Countdown / Playing and the tutorial block only over visible `btn-` buttons (slop 0.01). Gestures exempt. Plus the open wrist menu (above). |
| **GOO / tether** | Goo ×1.15 speed (tunnelling cap), 0.35 gravity, paint-tinted strands, goo decals (pool 192). Sub-modes SPLAT / TETHER on the menu's GOO MODE row or **B**. Tap releases, hold reels (pull / pinch / squeeze queue). Pops within 0.7 m of the head. Released non-boss bots drift back out over 1.0 s. |
| **Neatniks** | TargetSystem, pool 14: **Mopsy** ×7 (1 HP, 100, R10 strafes 0.1 m @ 0.16 Hz), **Squeegee** ×3 (R10 **2 HP, 250**), **Peekaboo** ×3 (1 HP, 200), **Duster Duke** ×1 (R10 **11 HP, 1000**). R10 **HP pip bars** (billboard, shared materials, flash + punch on hit) over any bot with hp > 1, plus a cyan shield row. Points ride the pop event. Meshy GLBs stream in background (robot.gltf until the next Countdown). `BotSpawned` per spawn. |
| **Spawning / pacing (R10)** | Director refills a pop gap after `refillDelaySec` 0.35 (was 1.5 s), an empty arena after `emptyRefillSec` 0.2, stagger 0.3; slot cooldown `TARGETS.respawnDelaySec` 0.6 only. Waves 0 s Mopsy ×3 / 15 s +Squeegee ×4 / 30 s +Peekaboo ×4 / 48 s mixed ×5; each boundary has a **1 s breather that only thins to 2** (never empties). Test: 90 s instant-pop sim, max zero-bot gap 0.21 s. Emptiest of 5 lanes in the 150° arc, room-clamped, `maxConcurrent` 5, `heightMax` 1.7. |
| **Bot behaviours** | **Squeegee** front-cone shield (140°) deflects unless bounced / TETHER / SPLASH / flanked; R10 **shield HP 3**: blocked shots chip it, the third **shatters** it (`ShieldBroken`, crunch + both-hand buzz + cyan burst), then hittable from anywhere, no regen. **Peekaboo** hides behind bounded furniture (top 0.35–1.4 m), peeks 1.5 s, spacing 0.3 m. **Duster Duke** drops in at 20 s left (`BossEntered`); R10 **patrols** 3 points over a 100° arc at 0.5 m/s (pauses 1.3 s + jitter), bulging to 2.6 m inside ±18° so he stays above the docked HUD; up to 3 companions (85 % Mopsy) keep spawning; tether haul = 2 dmg then walks back onto patrol; pops into 2 Mopsys (split away from the face). |
| **Depth occlusion (R9)** | `RENDER.depthOcclusion`: optional `depth-sensing` (`gpu-optimized` / `float32`); **RobotDepthSensingSystem** occludes robots only and self-disables per session without a depth API (one `[Splotopia] depth occlusion off` warning). **Unverified on Quest.** |
| **Tutorial** | **TutorialSystem**, Pip-led, hands-only, seated, ~1 min, auto-runs until done/skipped (`splotopia.tutorialDone`); TUTORIAL replays. Steps: 1 **Fire** at a wall ring (`room-probe.ts`). 2 **Menu** — "Tap the gem on your left wrist" → "Now tap a colour" (any menu pick). 3 **Pop** a Mopsy. 4 **Goo → Tether → Haul** ("Open the menu, tap GOO" / "Tap GOO" → TETHER lines swap with menu open state; done on `TetherPopped`). 5 **Ready** → title with PLAY pulsing. Steps 3–4 in a **practice round** (`startPractice`, clock held, Mopsys only, no score/Duke). Skip: SKIP button or both pinches 2.5 s; PLAY / A / X / CHILL mid-tutorial counts as skip. |
| **Pip** | Mascot beside the HUD in Idle / GameOver / Chill; flies off in rounds; double spin on a new best. Tutorial: follows `globals.pipFocus` (ring, the open menu panel or the gem, a Mopsy) with a speech bubble. |
| **Coaching** | First Squeegee / Peekaboo / Duke in a real round: tip for 3.2 s on the status line + floating label (`labelAbove` 0.58, clears the HP bars). R10 Squeegee tip "Shield! Hit it 3x to break it, or flank". Seen = `splotopia.coachSeen`. |
| **Results card** | Score, NEW BEST / BEST, pops per Neatnik, SHOTS, HITS, ACCURACY, BEST COMBO, one `nextGoalLine`; 12 s. |
| **Intro** | Logo burst + "YOUR ROOM IS THE ARENA" (~3.4 s), Idle only, snaps to the nearest real wall (0.9–3.2 m) else floats 1.5 m. |
| **HUD** | Dark glass + neon, 3:1 logo, min font 1.8. Title: PLAY, CHILL MODE + TUTORIAL, loadout + LOADOUT >. Playing: score, timer, combo, Neatniks pill, status / coach. Tutorial card, results card. `playScale` 0.9. |
| **Game loop** | Idle → Countdown(3s) → Playing(90s) → GameOver(12s) → Idle; Idle ⇄ Chill; practice Playing. Pause freezes everything. Best in `splotopia.bestScore`. |
| **STUDIO (Chill, R10)** | **StudioSystem** + pure `src/studio.ts`, config `STUDIO`. No timer/robots/score. HUD card: generated STUDIO sign, tabs **CANVAS / STENCIL / TARGETS**, status line, meter + 3 stars, action row, EXIT. **CANVAS**: framed board (generated frames, transparent centre) hung on the nearest real wall (RoomProbe fan of yaws 0/±25/±50°, 0.6–3.5 m, ≤ 30° tilt, 6 cm standoff, grows with distance ×1–2.2) or floating 1.3 m ahead; **TO EASEL / TO WALL** moves it to the round-2 easel (0.7 m, two-hand grab); **SHAPE** cycles landscape / portrait / round; SAVE → `splotopia-painting-N.png`; CLEAR wipes the canvas. **STENCIL**: square board + silhouette guide (STAR/HEART/SPLAT/PIP/MOPSY, NEXT cycles); stamps rasterised into a 128² CPU coverage grid; score = fill − 0.5 × spill, stars at 35/60/82 %; SAVE exports the lifted shape (`splotopia-stencil-<id>-N.png`). **TARGETS**: 4 bullseyes / paint balloons in a 110° arc 1.3–2.6 m, swept hits (no colliders: misses paint the room), each pop throws 5 splats onto walls behind it, streak/best/pops line, **HARD** adds drift + spin. Easel collider 6 cm (`EASEL.colliderDepth`), CanvasTexture disposed on resize (gotcha 31). Cues: tab click, star/save chime. Easel pinch-grab never sprays. |
| **Balls** | Not grabbable (R9). |
| **Room collision / scan** | XRPlane → colliders (vertical + ceilings get 6 cm boxes), labeled XRMesh → colliders, global mesh → TriMesh, FloorGuard slab; census `[Splotopia] room colliders: …`. SCAN ROOM only user-initiated after 6 s. |
| **Rendering** | Room IBL, PBR Neutral, clearcoat balls, robot rim, VfxSystem (256 particles), robot-only depth occlusion. |
| **Landing page** | `src/landing/`: key art, roster, HAND/BLASTER/GOO, hands-only steps, Chill, CTA + QR. **Copy still describes the wrist palette / squeeze-to-pick and the old Chill easel — needs an R10 pass (orchestrator-owned).** |

## Persistence (localStorage)

All try/catch (`readFlag`/`writeFlag`/`readMask`/`writeMask`). `splotopia.bestScore`,
`splotopia.blasterSkin` read through `readWithLegacyFallback`
(`src/storage-migrate.ts`; old `paintblast.*` copied forward once).
`splotopia.tutorialDone` ('1'), `splotopia.coachSeen` (bitmask by archetype),
R10 `splotopia.menuOpened` ('1' after the first menu open; stops the gem
pulse) and `splotopia.armFit` (JSON calibration; `ARMFIT.storageKey`).

## Architecture map

One system per file in `src/systems/`, components co-located, no barrels.
Cross-system state = signals in `world.globals` + a fixed 64-slot
`GameEventBuffer` (emitted < priority 90, flushed at 90).

| System | Prio | Owns |
|---|---|---|
| WorldCollisionSystem | 5 | Planes (walls + ceilings thickened) / meshes / global mesh → static colliders, census |
| FloorGuardSystem | 6 | Invisible floor slab |
| SceneScanSystem | 7 | `sceneScanMissing` detection |
| WristMenuSystem (R10) | 8 | Gem + panel pose, gem poke / Y toggle, poke state machine, controller ray, auto-close, loadout writes, `wristMenu`. Reads last frame's gem socket from GauntletSystem (runs after it) |
| GauntletSystem | 9 | Both `WristPose`s, arm fit + calibration, sleeve/turret/plate, deploy/stow, skins, recoil, menu-gem socket, `gauntletMuzzles`. **Registered before** WebShooter |
| WebShooterSystem | 10 | Gesture triggers, goo strands, tether reel queue (R10: pads removed) |
| BallSpawnSystem | 11 | Fire paths, `resolveFireGate`, `panelBlockMode`, menu block + `consumeMask` + left-fire pause, easel-grab pinch consumption, B = SPLAT/TETHER, aim assist |
| BallFlightSystem | 12 | Velocity-delta impact detection, per-kind behaviour, dissolve-on-rest |
| TargetSystem | 14 | Neatnik pool + art swap, director (refill/breather/waves/lanes), shield HP + shatter, HP bars, Mopsy drift, Duke patrol + split, release drift, swept hits, tether API, `aimTargets` |
| SplatterSystem | 15 | Instanced decal pools (paint 512 / goo 192) |
| EaselSystem | 16 | Paintable board: shapes, frame art, stencil guide, wall/float/easel placement, collider, `onStamp`, PNG export |
| StudioSystem (R10) | 17 | Studio activities, wall probe, stencil coverage + stars, target range, `studio*` signals |
| GameStateSystem | 30 | Phase machine, timer, score, combo, best, `paused`, practice round, `roundStats` |
| TutorialSystem | 32 | Step machine, wall ring, skip hold, menu-aware lines, `tutorialStep`/`tutorialLine`/`pipFocus` |
| CoachSystem | 33 | First-encounter tips, floating label, `coachLine` |
| HudSystem | 35 | Signals → panel, LOADOUT, tutorial card, results card, Studio card, PLAY pulse, docking |
| FeedbackSystem | 36 | Events → SFX + haptics (R10: shield shatter, Studio cues), chill music |
| VfxSystem | 37 | Events → pooled particle bursts (R10: cyan shatter burst) |
| IntroSystem | 38 | Enter-AR logo intro; HUD object3D visibility |
| PipSystem | 39 | Mascot, tutorial focus + speech bubble |
| RobotDepthSensingSystem | 50 | Robot occlusion; self-disables without a depth API. **Registered first**, only when `RENDER.depthOcclusion` |
| EventFlushSystem | 90 | Clears the event buffer |

Globals contract (seeded in `main.ts` **before** `registerSystem`): `gamePhase,
score, bestScore, combo, timeLeft, targetsAlive, paused, activeKind,
activeStyle, activeColor, webSubMode, blasterMode, blasterSkin, tetheredHands,
sceneScanMissing, hudScore, hudTimer, hudStatus, gameEvents, aimTargets`; R9
`tutorialStep`, `tutorialLine`, `pipFocus` (struct), `practice`, `roundStats`,
`coachLine`; R10 **`wristMenu`** (`WristMenuState` struct: `open`, `opening`,
`center`, `quaternion`, `halfW/H`, `tipNear`, `gemVisible`, `gem`,
`consumeMask`), **`studioActivity`** (`StudioActivity` 0/1/2), **`studioLine`**,
**`studioMeter`** (stencil score %, −1 hidden), **`studioStars`** (0–3).
Exception: `gauntletMuzzles` is created in `GauntletSystem.init()`. Structs
instead of system calls where a reverse import would close a module cycle.

Game events: R8 `BlasterModeChanged` 15, `ShieldDeflected` 20, `BossEntered` 21;
R9 `BotSpawned` 22 (data = `packPopData(slot, archetype, 0)`),
`TutorialStepDone` 23; R10 **`MenuToggled` 24** (pos = gem, data 1 open / 0
closed), **`ShieldBroken` 30** (pos = blade, data = slot),
**`StudioActivityChanged` 31** (data = activity), **`StudioTargetPopped` 32**
(data = streak; rides alongside a TargetPopped with data 0),
**`StudioStencilScored` 33** (data = stars), **`StudioArtSaved` 34** (data =
save count). 25–29 unused. `TargetPopped` data = `packPopData(slot, archetype,
points)`.

Shared non-system modules: `src/wrist-frame.ts`, `src/wrist-pose.ts`,
`src/types.ts` (enums, events, structs, pure UI/tutorial/results/Studio
helpers), `src/room-probe.ts` (spawn-time raycasts: intro, tutorial ring,
Studio wall), `src/storage-migrate.ts`, R10 **`src/wrist-menu.ts`** (layout,
hit test, poke + gem-poke state machines, close rules, Y mapping, ray hit) and
**`src/studio.ts`** (coverage grid, stars, placement, target spawn helpers).
Arm-fit math (`computeArmFit`, `ArmFitCalibrator`, `blendForearmAxis`, …) is
exported from `GauntletSystem.ts`.

All tunables: `src/config.ts` (BALLS, FIRE, IMPACT, SPLAT, BALL_KIND_CONFIG,
GAME, TARGETS, HUD, **MENU** (replaced PALETTE), ROOM, FLOOR, CHILL, EASEL,
**STUDIO**, WEB, AUDIO*, HAPTICS, RENDER, VFX, BLASTER, **ARMFIT**, INTRO,
TUTORIAL, COACH, NEATNIKS). Knob map: [GAME_GUIDE.md](../GAME_GUIDE.md).
`TARGETS.poolSize` must equal the sum of `NEATNIKS.archetypes.*.pool`
(test-pinned); `TARGETS.heightMeters`, `bobAmplitude`, `turnDegPerSec` are
legacy/unused.

Headless verification (no IWER MCP relay): `npx vite --config
vite.verify.config.ts` (port 8090, no mkcert) then
`PW_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node
scripts/headless-verify.mjs [url] [outDir] [hand|controller] [default|gauntlet]`.
Env: `ALIGN=1` (`handAimSource 'hand'`), `IKW=` (override
`forearmIkWeight`), `SHOTS=`/`MODES=` (subset), `NOSIZES=1`. The harness
injects `scripts/swiftshader-smoothstep-patch.js`, waits out the intro, hides
IWSDK's cursor, opens the wrist menu for its palm-up shot. ~5 fps: trust poses,
not timing. Level IWER's default hand before judging forearm fit (gotcha 33).
IWER has **no scene data for wall snap / Studio wall hang**, **no depth API**
and **no real joint radii**, so those are on-device only.

## Asset inventory & generation pipeline

| Asset | Path | Recipe |
|---|---|---|
| Splat mask | `public/textures/splat.png` | Higgsfield `nano_banana_pro` white-on-black → **alphaMap** |
| Goo masks | `public/textures/web-splat.png` (+ `-burst` spare) | same technique |
| **Neatniks** | `public/gltf/neatniks/{mopsy,squeegee,peekaboo,duster-duke,pip}.glb` — ~5 MB | Concepts (`docs/concepts/*.jpg`, Higgsfield) → **Meshy image-to-3D**, unrigged textured PBR, 1024 WebP. Measured/rescaled to `heightMeters`/`sizeMeters`; facing via `yawOffsetDeg` |
| Robot (fallback) | `public/gltf/robot/robot.gltf` | pre-existing; `critical` (pool built from it). **Believed to be an IWSDK starter-template asset — unconfirmed** |
| Plant (unused) | `public/gltf/plantSansevieria/` | not loaded; same unconfirmed provenance |
| Easel | `public/gltf/easel.glb` | **"empty easel, NO canvas"** image → Higgsfield `image_to_3d` |
| Palette board (unused) | `public/gltf/palette-board.glb` | Higgsfield `image_to_3d`; **not loaded since R10** (palette removed) |
| Web shooter (unused) | `public/gltf/web-shooter.glb` | Not loaded (`WEB.shooterUseGlb: false`) |
| **Studio (R10)** | `public/studio/`: `frame-{rect,square,round}.webp` (transparent centres; opening measured into `STUDIO.frames.*.innerW/innerH/offX/offY`), `stencil-{star,heart,splat,pip,mopsy}.png` (1024² grayscale, white-on-black, luminance = inside), `target-{bullseye,balloon}.webp` (cut-outs), `studio-sign.webp` (800×332, HUD `<img>`) — ~430 KB | Higgsfield **`gpt_image_2_5`**; frames/targets in the manifest as background textures, stencils loaded as pixel data by StudioSystem |
| **Brand (R9)** | `public/brand/logo.png` (3:1), `logo-512.png`, `logo-on-black.jpg`, `icon-256.png`; R8 `keyart.jpg`, `og.jpg`, `ui-bg.jpg` | Logo: Higgsfield `gpt_image_2_5` with the R8 logo as style reference, background removed |
| Landing | `public/landing/` keyart, logos, ui-bg, gauntlets, chill, masks, `bots/*.webp`, `qr-play.png` | WebP downscales; QR via `scripts/gen-qr-asset.mjs` |
| SFX ×9 / music | `public/audio/*.mp3` (`flick.mp3` since R9) | Higgsfield `mirelo_text_to_audio` / `sonilo_music`. Tutorial chime, Studio star/save reuse `chime.mp3` |

Models are measured and rescaled at runtime, so **swapping any GLB never needs
a code change**; Studio frame openings are config fractions, so a new frame
needs only its four numbers. Entries read during `init()` must be `priority:
'critical'`; Neatnik GLBs and Studio art are not. Licence confirmation for
every generated asset is tracked in SUBMISSION.md §6.

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
   BLASTER / WEB, skins, auto-fire); the robot cast with wave director, shield,
   furniture hiding, boss; PipSystem; techno-paint HUD + Armory; holo palette;
   `heightMax` 1.7. 670 tests.
9. **R9 (2026-10-03, rebrand + audit + onboarding)** — *Why: the name and the
   web mechanic carried IP risk, an audit found silently failing mechanics,
   and judging weighs the first five minutes.* PaintBlast MR → **Splotopia**,
   Splotbots → **Neatniks**, WEB → **GOO**, THWIP → **FLICK** (off by default);
   storage migrated; URL unchanged. Audit fixes (HUD shot-blocking, easel grab
   never sprays, Duke split/release drift, Peekaboo spacing, balls not
   grabbable, ceilings thickened, seated easel, 3 s breather, intro Idle-only,
   robot depth occlusion). Pip tutorial + practice round, coaching, results
   card, HUD copy pass, wall snap. Submission pack. 763 tests.
10. **R10 (2026-10-03, owner Quest playtest)** — *Why: on device the
    always-on palette caused constant accidental presses, the gauntlets looked
    small and sat on top of the arm, GOO was not discoverable, rounds had dead
    waits between spawns, the owner could not tell how to beat the Squeegee,
    and Chill had nothing to do.* **Summonable wrist menu** (gem + Y, poke
    panel, inert when closed) replaces the palette, WEB chip and pads.
    **Arm fit**: measured, persisted per-person sizing, enclosing tapered
    sleeve on the forearm axis, top turret (35° clamp) carrying BLASTER or the
    GOO launcher with a SPLAT/TETHER light, gem socket. **Neatniks**:
    continuous director (refill 0.35 s, empty 0.2 s, thinning 1 s breather,
    waves 0/15/30/48 s), HP pips, Squeegee 2 HP + 3-hit shield that shatters,
    Duke 11 HP / 1000 patrolling with Mopsys still coming, Mopsy drift.
    **STUDIO** replaces the bare Chill easel: wall-hung framed CANVAS, scored
    STENCIL, TARGETS range; new Higgsfield `gpt_image_2_5` art. Gotchas 31–33
    (CanvasTexture resize, joint radii, IWER wrist bend). **877 tests.**
    Verified by tsc and tests; the committed headless harness covers the menu
    and arm-fit poses (no Studio script). Real radii, wall hang and feel are
    on-device only.

Full specs: `docs/superpowers/specs/`. Concept art: `docs/concepts/`.

## Open items / on-device checklist

R8–R10 are verified by tsc, 877 unit tests and the headless IWER harness only —
**every item below needs a headset** (Quest 3 *and* 3S).

**Round 10**
- [ ] **Menu poke feel**: hover/press/re-arm depths (6 mm / 12 mm), one select
      per poke, no double picks; panel parks under the finger.
- [ ] **Gem reach**: right index finds the gem (enter 2 cm) with the left palm
      down and seated; **no accidental gem pokes** during play (two-handed
      aim, reels, both-pinch skip); first-run pulse noticed.
- [ ] Open panel **height vs sightline** (`handLift`/`controllerLift`) — not
      over the target you are aiming at; auto-close (6 s) not too eager.
- [ ] **Y button** opens/closes on the left controller; right ray + trigger
      clicks; no fire on menu clicks; left fire paused while open.
- [ ] **Arm fit**: real per-person radii from `fillJointRadii` (Quest privacy
      settings may deliver a static/default hand — check sizes differ between
      two people and persist in `splotopia.armFit`); elbow IK estimate while
      **seated**; sleeve bulk / skin never showing; **1-frame gem lag** on fast
      wrist turns; turret 35° clamp reads attached.
- [ ] **Pacing feel**: never waiting, never swamped; 1 s breather noticeable.
- [ ] **HP pip legibility** at 2–3 m on passthrough; shield row vs body row.
- [ ] **Duke patrol pace** and HUD dodge (stays above the docked strip);
      companions not crowding him.
- [ ] **Shield shatter cue** reads (sound, buzz, burst); players discover
      "hit it 3x".
- [ ] **Studio wall hang** with real Space Setup: right wall picked, standoff,
      scale, no z-fight; float fallback; TO EASEL / TO WALL round trip.
- [ ] **Target pop splats** land on real walls (cone/range); target hit feel;
      HARD drift readable.
- [ ] Stencil coverage stars feel fair; frame art legible.
- [ ] **SAVE downloads in Quest Browser** (painting + lifted stencil PNGs).
- [ ] Landing copy updated for the wrist menu and Studio (orchestrator).

**Round 9 (still open)**
- [ ] **Depth occlusion** occludes robots (else `[Splotopia] depth occlusion
      off`; try `cpu-optimized` / `luminance-alpha`); 72 fps cost; edge halos.
- [ ] **Wall snap** for the intro logo and tutorial ring with real Space Setup.
- [ ] Tutorial tether haul with a real reel; menu-step lines swap correctly.
- [ ] Skip hold never fires by accident during two-handed auto-fire.
- [ ] Pip bubble readability; Pip not hiding the menu he points at
      (`TUTORIAL.pipWrist*`).
- [ ] Docked HUD at `playScale` 0.9 below the sight line; coach label readable.
- [ ] Ceiling collisions (no tunnelling, no shelf misclassified ≥ 1.9 m).
- [ ] HUD shot-blocking in play: low shots under the strip reach the Duke.
- [ ] Results card in 12 s; storage migration from a PaintBlast MR headset.

**Carried from R7–R8**
- [ ] Sleeve vs back-plate alignment when the OS ray disagrees with the hand
      (`WEB.rayBlendNearDeg/FarDeg`, `handAimSource: 'hand'`).
- [ ] Auto-fire feel (150 ms); Squeegee deflect feel; Peekaboo peek at 2–3 m.
- [ ] **72 fps** with both gauntlets + menu + full cast + boss + HP bars +
      double pop (+ depth occlusion).
- [ ] LOADOUT skin dots (3.4 cm) reliability; intro timing and skip.
- [ ] Wrist-bent-back pose: OS ray stays on target? Left-palm pose never
      triggers Quest's palm-pinch system menu.
- [ ] Tether latch → reel → pop; tether on the Duke = 2 dmg mid-patrol.
- [ ] Aim assist feel; pause mid-round and mid-tether resumes exactly.
- [ ] Seated round within the 1.7 m height cap; IBL vs passthrough.
- [ ] SCAN ROOM on a never-scanned room; census after Space Setup.

**Known gaps / owner decisions** (COMPETITION_PLAN.md): Netlify URL rename (keep
`paintblast-mr` or move to a Splotopia URL + QR/OG); trademark knockout search
for "Splotopia"; asset licence confirmation (SUBMISSION.md §6, incl. R10 Studio
art); IWSDK 0.3.1 (1.0.x is current); Neatniks unrigged; no progression /
daily challenge yet; multiplayer open; voice commands out of scope.
