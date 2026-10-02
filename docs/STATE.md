# PaintBlast MR — Living State Document

> **Read this first in every new session.** It is the single source of truth for
> what the platform is, how it got here, and what is still open. The rules for
> keeping it alive are in [CLAUDE.md](../CLAUDE.md) (top section, "Documentation
> protocol"). Last updated: **2026-10-02 (Round 8 merged on branch
> `claude/pensive-sagan-h7mair`)**.
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
`rethinkrealityai`, folder is linked). A techno-paint 2D landing page fronts the
WebXR app; entering AR plays a logo intro, then the title HUD.

## Current feature inventory (post Round 8)

| Area | State |
|---|---|
| **Launchers (R8)** | `globals.blasterMode` = `BlasterMode` {Hand 0, Paint 1 (label BLASTER), Web 2}; default BLASTER. Chosen on the palette's 3 mode pads or the HUD **Armory**. Kept in lockstep with `activeStyle` by `syncBlasterMode` (Web style ⇔ Web mode; leaving WEB returns to the last paint mode). |
| **Gauntlets (R8)** | **GauntletSystem** owns both arms' `WristPose` (moved from WebShooterSystem). Code-built, per arm: forearm **bracer** in the aim frame + **back-of-hand plate** in the wrist frame (BLASTER & WEB); BLASTER adds a barrel + canister on top glowing `activeColor` (recoil, muzzle flash, swirl); WEB adds the spinneret underneath (tip = `WEB.muzzleLocal` [0,0,−0.082]; parent of the SPLAT/TETHER pads). HAND shows nothing. Deploy/stow over `BLASTER.transitionSec`; controllers roll the hardware `controllerRollDeg` 90. 5 skins (`BLASTER.skins`), index persisted in localStorage `BLASTER.skinStorageKey` (`paintblast.blasterSkin`). Mode change emits `BlasterModeChanged` (chime on deploy / UI click on stow + haptic, `modeSwitchVolume`). |
| **Firing** | Trigger / hand-pinch; in BLASTER/WEB they launch from `globals.gauntletMuzzles` (the shown barrel), in HAND from the target ray. **BLASTER holds to auto-fire** at `autoFireCooldownMs` 150 in every firing phase (`resolveFireGate`; Chill spray = shorter cooldown wins). Never fires while `paused`. Thrust + finger-curl gestures fire whatever is loaded. Per-hand shared cooldowns. **Aim assist** (`FIRE.aimAssistDeg` 4°, `WEB.aimAssistDeg` 9°, straight or ballistic) and **swept** robot hits. |
| **Ammo / palette** | Left wrist: 4 paint **dabs**, 5 **chips** (NORMAL/BOUNCY/STICKY/SPLASH + WEB), 3 **mode pads** (HAND/BLASTER/WEB). Select by poke, controller squeeze (`trySelectByProximity`), or right-hand fingertip **pinch** (consumed, never fires). sRGB colours. |
| **Holo palette (R8)** | `PALETTE.boardStyle` `'holo'` (default: code-built glass squircle, neon ramp edge + shimmer, paint wells, holo sockets) / `'glb'` / `'wood'`. Pops in on (re)tracking, **hides** after `hideAfterLostSec` 0.5 s of an untracked left hand (never while parked). Hands: `handLift` 0.08 (was 0.06, clears the gauntlet), faces the eyes, parks under the poking finger (`lockRadius`); the lock now steps on lost-hand frames too, so it always releases. |
| **Web / tether** | Webs ×1.15 speed (capped vs tunnelling), 0.35 gravity, strands, web decals (pool 192). Sub-modes SPLAT / TETHER via pads on the left spinneret or **B**. Tether: tap releases, hold reels; per-hand reel queue (pull ratchet / pinch / squeeze, glide ≤ `reelGlideSpeed`); pops within 0.7 m of the head. |
| **Splotbots (R8)** | TargetSystem rewrite. Pool of 14 slots fixed per archetype: **Mopsy** ×7 (1 HP, 100), **Squeegee** ×3 (1 HP, 150), **Peekaboo** ×3 (1 HP, 200), **Duster Duke** ×1 (6 HP, 600). Points ride the pop event (`packPopData`), scored × combo by GameStateSystem. Meshy GLBs stream in background, slots wear robot.gltf until the next **Countdown** swaps the art. Procedural animation only (pop-in, face-the-player, sway, squash, hit flash, pop spin). |
| **Spawning (R8)** | Wave director (`SPLOTBOTS.waves`: 0 s Mopsy-only ×3; 22 s and 48 s mixed ×4), emptiest of `lanes` 5 across the 150° forward arc, room-clamped, `maxConcurrent` 5. `TARGETS.heightMax` **1.7** (was 2.0) for seated comfort. |
| **Bot behaviours (R8)** | **Squeegee** faces you; shots inside its 140° front cone are deflected (no damage; `ShieldDeflected` → UI tick + cyan sparks) unless the ball already bounced, is a TETHER web, or is SPLASH — or you flank it. Deflect speed capped `maxDeflectSpeed` 9 m/s (test-pinned, gotcha 22). **Peekaboo** hides behind bounded `XRMesh` furniture (top 0.35–1.4 m), peeks 1.5 s, hittable only when lift ≥ 0.6; low peeks with no furniture. **Duster Duke** drops in at 20 s left (once/round, `BossEntered` → countdown blip + haptic), stomps; tether haul = 2 dmg then he walks home; pops into 2 Mopsys. Boss flag set only on a successful spawn. |
| **Pip (R8)** | PipSystem mascot beside the HUD in Idle / GameOver / Chill; flies off in Countdown/Playing; double happy spin on a new best; hidden while the HUD is hidden. No Interactable, no physics. |
| **Intro (R8)** | IntroSystem: first visible frame of each session, logo bursts from a neon splat 1.5 m ahead + particle ring + tagline "YOUR ROOM IS THE ARENA", lifts away (~3.4 s). Pinch/trigger skips (does not consume the input); holds while blurred; hides the HUD object3D until `hudRevealAt`. `INTRO.enabled` switch. |
| **HUD (R8 restyle)** | Dark glass + neon + drips + brand logo; title = PLAY / CHILL MODE / WEB MODE + how-to tiles + LOADOUT readout + **BLASTERS >** (Armory). **Armory** section (Idle sub-screen, not a phase): HAND/BLASTER/WEB cards, skin `<` `>` + 5 dots, BACK / PLAY; open/close does not re-dock the panel. Button hover swell / press squash (`pressFlashMs`), section fade-rise, grouped score, timer turns coral at 10 s, NEW BEST badge, footer launcher chip. `baseHeight` 0.46. Docks low in play; PAUSED pill. |
| **Game loop** | Idle → Countdown(3s) → Playing(90s) → GameOver(8s) → Idle. Pause/resume freezes everything (`PauseClock`). Best score in localStorage. |
| **Chill** | No timer/robots/score. Easel canvas painting, SAVE / NEW / ROTATE, two-hand grab (smoothed). Lofi music. WEB MODE title shortcut. ⚠️ Easel spawns 1.4 m away — out of reach seated. |
| **Room collision / scan** | XRPlane → colliders (vertical 6 cm boxes), labeled XRMesh → colliders, global mesh → static TriMesh (`isBounded3D === false`), FloorGuard slab; census log `[PaintBlast] room colliders: …`. SCAN ROOM only user-initiated after 6 s. |
| **Rendering** | Room IBL, PBR Neutral tone mapping, clearcoat balls, robot rim, VfxSystem (256-particle pool). ⚠️ **No depth occlusion** (`DepthSensingSystem` never registered) — Peekaboo is visible *through* real furniture. |
| **Landing page (R8)** | `src/landing/` rebuild: key-art hero + logo, neon click-to-splat layer with drips (`splatter.ts`), blaster-reticle cursor, Splotbots roster, HAND/BLASTER/WEB, 3 hands-only steps, Chill section, CTA + QR, footer; reduced-motion aware, lazy WebP; OG/Twitter meta → `/brand/og.jpg`. Same `initLanding` contract (`bindWorld` / `setVisible`). |

## Architecture map

One system per file in `src/systems/`, components co-located, no barrels.
Cross-system state = signals in `world.globals` + a fixed 64-slot
`GameEventBuffer` (emitted < priority 90, flushed at 90).

| System | Prio | Owns |
|---|---|---|
| WorldCollisionSystem | 5 | Planes / meshes / global mesh → static colliders, census log |
| FloorGuardSystem | 6 | Invisible floor slab |
| SceneScanSystem | 7 | `sceneScanMissing` detection |
| WristPaletteSystem | 8 | Palette pose (grip for controllers / wrist joint facing the eyes for hands), poke-park lock, holo appear/hide/shimmer, loaded-slot lighting |
| GauntletSystem (R8) | 9 | Both `WristPose`s (one smoothed aim per arm), bracer/plate/barrel/spinneret, deploy/stow, skins, recoil, writes `gauntletMuzzles`, emits `BlasterModeChanged`. **Registered before** WebShooter (its init builds the spinneret the pads parent to) |
| WebShooterSystem | 10 | Gesture triggers (reads GauntletSystem's pose), strands, tether reel queue, SPLAT/TETHER pads, pause shift |
| BallSpawnSystem | 11 | Fire paths (`fireFrom` → gauntlet muzzle or ray, `fireFromGesture`), `resolveFireGate`, ammo/mode selection, aim assist, ball cap |
| BallFlightSystem | 12 | Velocity-delta impact detection (no collision events!), per-kind behaviour, dissolve-on-rest |
| TargetSystem | 14 | Splotbot pool + art swap, wave director/lanes, shield, peek, boss, swept hits, tether API, writes `aimTargets`, pause re-basing |
| SplatterSystem | 15 | Instanced decal pools (paint 512 / web 192) |
| EaselSystem | 16 | Chill easel canvas |
| GameStateSystem | 30 | Phase machine, timer, score (`popBasePoints`), combo, best, `paused` |
| HudSystem | 35 | Signals → panel, Armory, button animation, section fades, dock switching |
| FeedbackSystem | 36 | Events → SFX + haptics, chill music |
| VfxSystem | 37 | Events → pooled particle bursts |
| IntroSystem (R8) | 38 | Enter-AR logo intro; toggles HUD object3D visibility only; emits nothing |
| PipSystem (R8) | 39 | Mascot drone beside the HUD |
| EventFlushSystem | 90 | Clears the event buffer |

Globals contract (seeded in `main.ts` **before** `registerSystem` — init() binds
synchronously): `gamePhase, score, bestScore, combo, timeLeft, targetsAlive,
paused, activeKind, activeStyle, activeColor, webSubMode, blasterMode,
blasterSkin, tetheredHands, sceneScanMissing, hudScore, hudTimer, hudStatus,
gameEvents, aimTargets`. Exception: **`gauntletMuzzles`** (R8, `GauntletMuzzles`
struct: per-hand `valid`, `origin`, `direction`) is created in
`GauntletSystem.init()` (its only writer, registered before its reader
BallSpawnSystem). `aimTargets` and `gauntletMuzzles` are structs rather than
system calls because TargetSystem / GauntletSystem import BallSpawnSystem — the
reverse import closes a module cycle.

Game events added in R8: `BlasterModeChanged` 15 (data = new mode),
`ShieldDeflected` 20 (pos = shield, data = slot), `BossEntered` 21 (pos =
landing spot). Splotbot events start at 20 so parallel streams could not collide.
`TargetPopped` data = `packPopData(slot, archetype, points)` (slot still in the
low byte; 0 points → `GAME.scoreTargetHit`).

Shared non-system modules: `src/wrist-frame.ts` (pure aim/facing bases,
smoothing, ballistic aim assist, reel queue math), `src/wrist-pose.ts`
(`WristPose`, `isTracked`), `src/types.ts` (enums, events, R8 pure UI helpers:
`cycleIndex`, `readSkin`/`writeSkin`, `formatScore`, `isNewBest`,
`superellipsePoint`, `rampColor`, `appearFrame`, …).

All tunables: `src/config.ts` (sections BALLS, FIRE, IMPACT, SPLAT,
BALL_KIND_CONFIG, GAME, TARGETS, HUD, PALETTE, ROOM, FLOOR, CHILL, EASEL, WEB,
AUDIO*, HAPTICS, RENDER, VFX, **BLASTER, INTRO, SPLOTBOTS**). Player-facing knob
map: [GAME_GUIDE.md](../GAME_GUIDE.md). `TARGETS.poolSize` must equal the sum of
`SPLOTBOTS.archetypes.*.pool` (test-pinned); `TARGETS.heightMeters`,
`bobAmplitude`, `turnDegPerSec` are legacy/unused since R8.

Headless verification (for sessions without the IWER MCP relay):
`npx vite --config vite.verify.config.ts` (no mkcert, port 8090; `fs.allow`
includes the main checkout so worktrees' symlinked Havok wasm loads) then
`PW_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node
scripts/headless-verify.mjs [url] [outDir] [hand|controller] [default|gauntlet]`.
`default` = forearm/palette/web/seated-round/hit shots; `gauntlet` (R8) =
BLASTER/WEB/HAND × 6 views + skin swap + fired shot. `ALIGN=1` sets
`WEB.handAimSource = 'hand'` (IWER's pointer ray sits ~33° above the emulated
hand). The harness injects `scripts/swiftshader-smoothstep-patch.js` — **without
it uikit renders nothing under SwiftShader** (`smoothstep(e, e, x)` is undefined)
— waits out the intro, and hides IWSDK's pointer cursor (its lerp diverges under
~15 fps). Headless runs at ~5 fps: trust poses, not timing.

## Asset inventory & generation pipeline

| Asset | Path | Recipe |
|---|---|---|
| Splat mask | `public/textures/splat.png` | Higgsfield `nano_banana_pro` white-splat-on-black → **alphaMap** (luminance IS the alpha) |
| Web masks | `public/textures/web-splat.png` (+ `-burst` spare) | same white-on-black technique |
| **Splotbots (R8)** | `public/gltf/splotbots/{mopsy,squeegee,peekaboo,duster-duke,pip}.glb` — **5.2 MB total** | Concepts (`docs/concepts/*.jpg`, Higgsfield) → **Meshy image-to-3D**, unrigged single textured PBR mesh, textures 1024 WebP. Background-loaded; measured and rescaled to `heightMeters` / `sizeMeters`; facing fixed by `yawOffsetDeg` (Meshy's facing is not fixed) |
| Robot (fallback) | `public/gltf/robot/robot.gltf` | pre-existing; `critical` (pool is built from it at registerSystem) |
| Easel | `public/gltf/easel.glb` | image (**"empty easel, NO canvas"**) → Higgsfield `image_to_3d` |
| Palette board | `public/gltf/palette-board.glb` | Higgsfield `image_to_3d`; only used with `PALETTE.boardStyle: 'glb'` since R8 (thin along Z; `thinnestAxis` lays it flat) |
| Web shooter | `public/gltf/web-shooter.glb` | Not loaded (`WEB.shooterUseGlb: false`) — a ring cuff. A replacement must be long axis = −Z, nozzle at −Z, back of hand +Y |
| Brand (R8) | `public/brand/` logo.png (intro texture), logo-512.png (favicon), logo-on-black.jpg, keyart.jpg, og.jpg (OG/Twitter), ui-bg.jpg | generator not recorded in the commits |
| Landing (R8) | `public/landing/` keyart-1100/1920, logo-360/1100, ui-bg, gauntlets, chill, mask-splat-1/2 (`.webp`), `bots/*.webp` (5 character portraits), `qr-play.png` | WebP downscales; QR via `scripts/gen-qr-asset.mjs` |
| SFX ×8 / music | `public/audio/*.mp3` | Higgsfield `mirelo_text_to_audio` / `sonilo_music` (m4a → `ffmpeg -codec:a libmp3lame`). R8 added no audio: intro, mode switch, shield and boss reuse existing cues |

Models are measured (`Box3.setFromObject`) and rescaled at runtime, so
**swapping any GLB never needs a code change**. Entries a system reads during
`init()` must be `priority: 'critical'`; the Splotbot GLBs deliberately are not
(swapped at Countdown; PipSystem polls). Art bible: [COMPETITION_PLAN.md](COMPETITION_PLAN.md) §6
(it plans Meshy *rigged* characters; R8 shipped unrigged + procedural animation).

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
   aim and the palette sat perpendicular to the forearm. New frames
   (`WristPose`); code-built forearm gauntlet; tether reel queue; fingertip
   pinch-select that never fires; palette faces the eyes and parks while
   poked; easel grab smoothing; aim assist; swept robot hits; sRGB palette
   colours. Parallel: pause/resume + seated forward arc + hands-first copy;
   IBL + PBR Neutral, clearcoat balls, VfxSystem. Headless IWER harness. Review
   caught: webs at ×1.45 tunnelled (capped ×1.15 + test), tracking loss never
   detected (→ `isTracked`), palette lock stranding, tap-to-release. 502 tests.
8. **R8 (2026-10-02, competition content round)** — *Why: the R7 game had one
   generic robot, web-only hardware and a plain UI — the competition needs
   characters, a signature "gauntlet" fantasy and a branded first impression.*
   Landing revamp + brand pack + enter-AR **IntroSystem**; **GauntletSystem**
   (HAND / BLASTER / WEB launchers on both arms, skins, BLASTER hold-to-auto-fire,
   shots leave the shown barrel; owns the WristPoses now); **Splotbots** cast
   (Meshy GLBs, wave director, Squeegee shield, Peekaboo furniture hiding,
   Duster Duke boss, per-archetype points) + **PipSystem** mascot; techno-paint
   HUD restyle with the **Armory** and the holo wrist palette; seated comfort
   (`heightMax` 1.7). Review fixes: palette lock stepped on lost hand, no
   auto-fire while paused, Armory open/close no longer re-docks (snapped the
   panel), deflect cap moved to config + test, boss flag only on spawn success.
   Harness: `gauntlet` suite, `ALIGN=1`, SwiftShader smoothstep patch, cursor
   hide. 670 unit tests.

Full specs: `docs/superpowers/specs/`. Concept art: `docs/concepts/`.

## Open items / on-device checklist

R8 is verified by tsc, 670 unit tests and the headless IWER harness only —
**every item below needs a headset** (Quest 3 *and* 3S) before it ships.

**Round 8**
- [ ] **Bracer vs back-plate alignment** when the OS ray disagrees with the hand
      axis (the bracer follows the aim, the plate follows the wrist). Tune
      `WEB.rayBlendNearDeg/FarDeg`, or `WEB.handAimSource: 'hand'`.
- [ ] Gauntlet fit on real forearms, both hands and controllers
      (`BLASTER.plateOffset*`, `controllerRollDeg`, `WEB.shooterOffset*`).
- [ ] Left-hand BLASTER shots: does the barrel spawn balls **through the palette
      board**? (`BLASTER.muzzleOffset`, `PALETTE.handLift/handForward`.)
- [ ] Auto-fire feel (`autoFireCooldownMs` 150); confirm no pinch-fire while
      selecting on the palette or grabbing the easel.
- [ ] **72 fps** with ~18 gauntlet meshes per arm + full Splotbot cast + boss
      (+ a double pop).
- [ ] Squeegee shield deflect feel (cone 140°, ping volume, readable cyan flash).
- [ ] Peekaboo behind real furniture: no depth occlusion, so it shows *through*
      the couch; readability of a 1.5 s peek at 2–3 m.
- [ ] Duster Duke's landing (2 m ahead, `standHeight`) vs the docked HUD.
- [ ] Pip placement beside the HUD (`SPLOTBOTS.pip.besidePanel/abovePanel`).
- [ ] Palette vs gauntlet clearance on hands (`PALETTE.handLift` 0.08 /
      `handForward`).
- [ ] Holo board + neon glow on passthrough; chip/pad label legibility.
- [ ] Armory skin dots (3.4 cm) — pinch/ray reliability.
- [ ] Intro timing (~3.4 s, `INTRO.exitStartSec`) and skip; mode-switch cue
      volume (`BLASTER.modeSwitchVolume`).

**Carried from R7**
- [ ] Wrist-bent-back pose: does the OS ray stay on target?
- [ ] Tether: latch → pull-reel → pinch-hold reel → pop; reeling hand never
      fires; tether on the Duke = 2 dmg + walk home.
- [ ] Hand palette in palm-down and palm-up; left-palm pose never triggers
      Quest's palm-pinch system menu (exits the session); hides/reappears
      cleanly on tracking loss.
- [ ] Aim assist feel; pause mid-round and mid-tether resumes exactly.
- [ ] Seated round: everything in front and within the 1.7 m height cap.
- [ ] Rendering: IBL brightness vs passthrough, first-shot clearcoat compile hitch.
- [ ] (Carried) SCAN ROOM on a never-scanned room; census line after Space
      Setup; SAVE PAINTING download while immersed; easel grab weight.
- Known gaps (planned, COMPETITION_PLAN.md): depth occlusion off; easel too far
  for seated play; IWSDK 0.3.1 (1.0.1 is current); Splotbots unrigged
  (procedural animation only); web mechanic / gesture IP rebrand; onboarding;
  progression. Voice commands and multiplayer: out of scope.
