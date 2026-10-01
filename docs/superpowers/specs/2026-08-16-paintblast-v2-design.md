# PaintBlast MR 2.0 — Finish-the-Game Design

**Status:** Approved for implementation (user delegated full product control this session)
**Date:** 2026-08-16
**Author:** Claude (PM/orchestrator), building on `2026-04-10-iwsdk-migration-design.md`

## Where we are

Phase 1 (foundation) shipped: ECS port, palette slots, grab-throw balls, room-geometry
colliders, instanced splat pool, static HUD. **Phases 2–3 never landed.** Today the game
has no paint (nothing calls `addSplat`), no targets, no score, no game loop, leaking
balls, and unused assets (robot.gltf, chime.mp3).

**API reality check (verified against @iwsdk/core 0.3.1 source):**
- `PhysicsSystem` exposes **no collision events**. It steps Havok, syncs transforms, and
  writes per-frame `_linearVelocity` / `_angularVelocity` back onto `PhysicsBody`.
- Therefore: impact detection = per-ball velocity-delta watch. `Δv = v_now − v_prev`;
  `|Δv| > threshold` while free-flying ⇒ impact at ball position, **contact normal ≈
  normalize(Δv)** (impulse from a static surface points along its normal). Pure math,
  unit-testable, works for planes, meshes, and stuck balls alike.
- Haptics: raw WebXR `gamepad.hapticActuators[0].pulse(intensity, ms)` via the
  StatefulGamepad's underlying gamepad.
- UI events: `PanelDocument.data.document[entity.index].getElementById(id)` +
  `addEventListener('click', …)`; text via element `setProperties`/text API.
- One-shot impulses: `PhysicsManipulation` (auto-removed by PhysicsSystem).

## Vision

Pick-up-and-play MR arcade shooter: your real room is the arena. Rogue robots
materialize around you; blast them with paintballs; paint splats stick to your real
walls and furniture. 90-second rounds, combos, best score. One config file to tune
everything; one QR scan to play on Quest.

## Product decisions (PM calls made this session)

| # | Decision | Rationale |
|---|---|---|
| 1 | **Pinch/trigger = fire** from the pointing ray; palette slot press now **selects ammo** (color + kind) instead of spawning a ball to grab | Two-step spawn-then-grab-then-throw was clunky; instant fire is the fun loop. Grab-throw still works on any live ball as a bonus. |
| 2 | Suppress fire while that hand is hovering an Interactable/UI | Prevents stray shots when clicking palette/HUD. |
| 3 | Targets = pooled clones of the existing `robot.gltf`, kinematic hover-bob on a spawn ring (1.2–3.0 m, heights 0.7–2.0 m), no per-robot XRAnchor | Uses the asset we own; anchor budget stays reserved for the splat field; 90 s drift is negligible. |
| 4 | Hit detection ball↔robot = sphere overlap test in update (N×M small) | No Havok sensors exist in IWSDK; overlap math is trivial and testable. |
| 5 | Game loop: `Idle → Countdown(3 s) → Playing(90 s) → GameOver(8 s) → Idle`, driven by signals in `world.globals`; Start/Restart via HUD button **and** A-button/either-trigger in Idle | Voice commands (old Phase 3) are cut: mic permission + Web Speech flakiness on Quest isn't worth it for v2. HUD "Clear Paint" button replaces the clear gesture. |
| 6 | Scoring: robot pop = 100 × combo (combo window 3 s, cap ×5); wall splat = +5; best score persisted to localStorage | Rewards both marksmanship and painting the room. |
| 7 | Ball kinds keep the original table: Normal (splat+despawn), Bouncy (3 bounces, splat each), Sticky (sticks as static terrain ball, fades after 10 s), Splash (1+8 radial splats) | Original design was good; it was just never built. |
| 8 | Perf: shared sphere geometry, 4 cached materials (per palette color), live-ball cap 20 (oldest culled), lifetime 15 s, floor-cull y < −2; robots pooled & reused; `entity.destroy()` for balls (shared GPU resources), never `dispose()` | 72–90 FPS budget; zero allocations in `update()`. |
| 9 | Splat polish: per-splat size jitter (0.55–1.4×), random roll, 2–4 mm normal offset (anti z-fight), capacity 512, per-kind size multiplier; alpha-tested splat texture if asset generation succeeds, else procedural irregular disc | Flat uniform circles read as "programmer art". |
| 10 | Audio/haptics: fire tick, splat, robot pop, countdown beep, game-over sting; chime.mp3 = combo milestone. SFX via Higgsfield generation with graceful fallback (missing file ⇒ skip sound, never crash) | Feel is half the game. |
| 11 | Launch: `netlify.toml` + `npm run launch` (build → `netlify deploy --prod` → terminal QR) + `npm run qr` (QR for deployed URL) + `npm run qr:dev` (LAN dev-server QR). Quest 3 passthrough camera scans the QR → opens in Quest Browser → Enter AR | This is "Meta's QR system" in practice: the headset's built-in QR scanning. Deployed HTTPS URL is the zero-friction path; LAN QR covers dev iteration. |
| 12 | Editability: every tunable lives in `src/config.ts` with comments; `GAME_GUIDE.md` maps each knob to gameplay effect | The user asked for "easy for me to edit" — this is that deliverable. |

## Architecture (one system per file, components co-located; no barrels)

```
src/
├── main.ts                      # World.create + AssetManifest + registration + seeding
├── config.ts                    # ALL tunables (pure data, no IWSDK imports, unit-tested)
├── types.ts                     # enums/shared types (extend: GamePhase, GameEvent)
├── systems/
│   ├── WorldCollisionSystem.ts  # unchanged (priority 5)
│   ├── BallSpawnSystem.ts       # rework: trigger-fire, ammo selection, caps, caches (priority 10)
│   ├── BallFlightSystem.ts      # NEW: impact detect, per-kind behavior, splats, despawn (priority 12)
│   ├── TargetSystem.ts          # NEW: robot pool, ring spawn, hover, overlap hits (priority 14)
│   ├── SplatterSystem.ts        # extend: jitter, texture, per-kind size (priority 15)
│   ├── GameStateSystem.ts       # NEW: phase machine, timer, score/combo, best score (priority 30)
│   ├── HudSystem.ts             # NEW: signals→PanelDocument, buttons, phase sections (priority 35)
│   └── FeedbackSystem.ts        # NEW: game events → AudioSource + haptics (priority 36)
├── ui/  → ui/hud.uikitml        # expanded: title/start section, playing HUD, game-over section
└── tests (vitest, pure logic only): impact math, combo/score, state machine, timer fmt,
    ring spawn constraints, kind table integrity, splat pool (existing), palette order
```

**Cross-system state:** `world.globals` signals — `gamePhase`, `score`, `bestScore`,
`combo`, `timeLeft`, `targetsAlive`, `activeKind`, `activeColor`, plus a tiny
fixed-size game-event queue (`globals.gameEvents`) drained by FeedbackSystem/HudSystem
(no per-frame allocation).

## Explicitly out of scope (v2)

Voice commands, multiplayer, cross-session splat persistence, Quest 2/Vision Pro,
per-robot anchors, custom MCP tools.

## Definition of done

1. `npx tsc --noEmit` clean; `npm test` green (existing + new suites).
2. IWER emulator run-through: enter AR, fire → splat appears, robot pops, score/combo/timer
   update on HUD, round completes to GameOver and restarts, Clear Paint works.
3. iwsdk-project-code-reviewer pass with findings addressed.
4. Deployed to Netlify over HTTPS; `npm run launch` / `npm run qr` print a scannable QR;
   GAME_GUIDE.md + README updated.
