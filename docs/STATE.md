# PaintBlast MR — Living State Document

> **Read this first in every new session.** It is the single source of truth for
> what the platform is, how it got here, and what is still open. The rules for
> keeping it alive are in [CLAUDE.md](../CLAUDE.md) (top section, "Documentation
> protocol"). Last updated: **2026-08-19 (Round 6 shipped)**.

## What this is

A mixed-reality paintball arcade for Meta Quest 3/3S built on Meta's Immersive
Web SDK (`@iwsdk/core` 0.3.1). The player's real room is the arena. Live at
**https://paintblast-mr.netlify.app** (Netlify site `paintblast-mr`, team
`rethinkrealityai`, folder is linked). A 2D landing page with an interactive
paint-splatter hero fronts the WebXR app.

## Current feature inventory (post Round 6)

| Area | State |
|---|---|
| **Firing** | Trigger / hand-pinch, **thwip gesture** (middle+ring curl), **forward thrust** — all three fire whatever ammo is loaded, in Idle sandbox, Playing, and Chill. Per-hand shared cooldowns. Hold-to-spray in Chill only. |
| **Ammo** | Wrist palette (left grip): 4 paint **dabs** (color) + 5 **chips** — NORMAL / BOUNCY / STICKY / SPLASH (kind) and **WEB** (style). Tap (poke), squeeze/pinch, all also covered by a pipeline-independent proximity-squeeze fallback. Chips have identity colors + baked text labels. |
| **Web** | White web balls, wrist shooter GLBs on both hands (palm-up mount), strand from wrist to impact, web-pattern decals (2nd instanced pool, 192). Sub-modes: **SPLAT** / **TETHER** via holo pads on the left shooter or the **B button**. Tether: latch a robot, yank (≥1.3 m/s) or hold-squeeze to reel, pops within 0.7 m of the head through normal scoring. |
| **Game loop** | Idle → Countdown(3s) → Playing(90s) → GameOver(8s) → Idle. Robots (pooled GLB clones) on a room-clamped spawn ring, hp/pop/respawn, combo scoring (window 3s, cap ×5), best score in localStorage `paintblast.bestScore`. |
| **Chill** | No timer/robots/score. Easel (empty-easel GLB + code-built canvas board): balls stamp a real 1024×768 canvas (webs stamp with the web mask), SAVE PAINTING → PNG download, NEW CANVAS, ROTATE CANVAS (landscape⇄portrait, rebuilds physics), two-hand grab to move. Lofi music loop. **WEB MODE** title button = shortcut into Chill with web preloaded. |
| **Room collision** | XRPlane → static colliders (**vertical planes thickened to 6 cm** — see gotcha #1), labeled XRMesh → colliders (registry set: table, desk, couch, bed, shelf, screen, lamp, plant, other), **global room mesh → static TriMesh** (detected via `isBounded3D === false`, NOT label). Invisible **FloorGuard** slab (30 m × 0.5 m thick, top at y=−1 mm) guarantees a floor everywhere. One-time census log: `[PaintBlast] room colliders: P planes, M meshes (labels: …)`. |
| **Room scanning** | Never automatic. `SceneScanSystem` raises `sceneScanMissing` after 6 s of zero planes+meshes → idle notice + **SCAN ROOM** button → `initiateRoomCapture()` (Meta: once per session, ≥2–3 s after start). Guardian ≠ scene data. |
| **HUD** | One UIKitML panel: liquid glass, per-letter multicolor title, phase sections (idle / playing / gameover / chill) + persistent footer (CLEAR PAINT + ammo readout). Docks low+small during Playing/Chill (face-target follower), centers in menus. All buttons have hover/press states + click SFX. |
| **Balls** | 4 kinds per original design; style axis Paint/Web; shared geometry + per-color material cache (destroy(), never dispose()); cap 20 live; lifetime/kill-floor culls; **rest = dissolve into a splat** (no inert bubbles). |
| **Landing page** | `src/landing/` + `index.html` overlay: hero art, click-to-splatter canvas, feature cards (Higgsfield art), ENTER AR, QR card for desktop. Hidden during immersive sessions. |

## Architecture map

One system per file in `src/systems/`, components co-located, no barrels.
Cross-system state = signals in `world.globals` + a fixed 64-slot
`GameEventBuffer` (emitted < priority 90, flushed at 90).

| System | Prio | Owns |
|---|---|---|
| FloorGuardSystem | 6 | Invisible floor slab |
| SceneScanSystem | 7 | `sceneScanMissing` detection |
| WristPaletteSystem | 8 | Palette root ← left grip pose |
| WebShooterSystem | 9 | Shooter models, thwip/thrust triggers, strands, tether driving, holo sub-mode pads |
| BallSpawnSystem | 10 | Fire paths (trigger + `fireFromGesture`), ammo selection (Pressed + proximity), ball cap, `resolveShot`/`canFireInPhase` |
| BallFlightSystem | 12 | Velocity-delta impact detection (no collision events exist!), per-kind behavior, dissolve-on-rest |
| TargetSystem | 14 | Robot pool, ring spawn (room-clamped), overlap hits, tether API (`beginTether`/`reelTether`/`endTether`) |
| SplatterSystem | 15 | Two instanced decal pools (paint 512 / web 192), jitter, alphaMap masks |
| EaselSystem | 16 | Chill easel, CanvasTexture painting, save/rotate |
| GameStateSystem | 30 | Phase machine, timer, score/combo, best score, status copy |
| HudSystem | 35 | Signals → panel, buttons, dock switching |
| FeedbackSystem | 36 | Events → SFX + haptics, chill music |
| EventFlushSystem | 90 | Clears the event buffer |

Globals contract (seeded in `main.ts` **before** `registerSystem` — init() binds
synchronously): `gamePhase, score, bestScore, combo, timeLeft, targetsAlive,
activeKind, activeStyle, activeColor, webSubMode, sceneScanMissing, hudScore,
hudTimer, hudStatus, gameEvents`.

All tunables: `src/config.ts` (sections BALLS, FIRE, IMPACT, SPLAT,
BALL_KIND_CONFIG, GAME, TARGETS, HUD, PALETTE, ROOM, CHILL, EASEL, WEB, FLOOR,
AUDIO*, HAPTICS). Player-facing knob map: [GAME_GUIDE.md](../GAME_GUIDE.md).

## Asset inventory & generation pipeline

All generated with the Higgsfield MCP; recipes that worked:

| Asset | Path | Recipe |
|---|---|---|
| Splat mask | `public/textures/splat.png` | `nano_banana_pro` white-splat-on-black → used as **alphaMap** (no alpha channel in PNGs — luminance IS the alpha; landing page converts luminance→alpha sprite in JS) |
| Web masks | `public/textures/web-splat.png` (+ `-burst` spare) | same white-on-black technique |
| Robot | `public/gltf/robot/robot.gltf` | pre-existing; measured & rescaled at runtime |
| Easel | `public/gltf/easel.glb` | image (**"empty easel, NO canvas"** — a canvas in the source photo bakes a phantom board into the model) → `image_to_3d` `should_texture: true` |
| Palette board | `public/gltf/palette-board.glb` | kidney palette product shot → `image_to_3d` |
| Web shooter | `public/gltf/web-shooter.glb` | product shot → `image_to_3d`; band hole runs along model X (hence `shooterYawDeg 90`) |
| SFX ×8 | `public/audio/*.mp3` | `mirelo_text_to_audio` (1–3 s prompts, "no music, no voice") |
| Chill music | `public/audio/chill-music.mp3` | `sonilo_music` 60 s (outputs m4a → `ffmpeg -codec:a libmp3lame`) |
| Landing art | `public/landing/*` | `nano_banana_pro` hero + 4 card images (downscaled to 640 px), QR via `scripts/gen-qr-asset.mjs` |

GLB manifest pattern: models are measured (`Box3.setFromObject`) and rescaled at
runtime, so **swapping any GLB never needs a code change**. New GLB entries that
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

Full specs: `docs/superpowers/specs/`. Session-level detail lives in the
orchestrating agent's memory, but this file must stand alone.

## Open items / on-device checklist

- [ ] Tether attach → yank-reel → pop against a live robot (emulator cannot
      collide a robot; state machine is unit-tested).
- [ ] Palm-up mount legibility on a real forearm (`WEB.shooter*Deg` knobs).
- [ ] Thwip thresholds on real hands (`WEB.curlThreshold` / `extendThreshold`).
- [ ] SCAN ROOM button on a never-scanned room; collider census line after a
      fresh Space Setup (screenshot it — it decides every collision debate).
- [ ] SAVE PAINTING download while immersed (Quest Browser download manager).
- [ ] Wrist palette placement in hand-tracking mode (gripSpace may fall back to
      ray origin per Meta docs).
- Voice commands: deliberately cut (Quest Web Speech reliability). Multiplayer,
  cross-session splat persistence: out of scope so far.
