# Splotopia

**YOUR ROOM IS THE ARENA.** Mixed-reality paint arcade for **Meta Quest 3 / 3S**
(formerly *PaintBlast MR*), built on Meta's
[Immersive Web SDK](https://developers.meta.com/horizon/documentation/web/immersive-web-sdk/)
(`@iwsdk/core`). The Neatniks, a gang of rogue cleaning robots (Mopsy,
Squeegee, Peekaboo and their boss Duster Duke), materialize around you; you
splat them with paint, and the paint sticks to your actual walls and furniture.
Pip, a palette drone, is your sidekick.

**Play it now:** https://paintblast-mr.netlify.app — or run `npm run qr` and
scan the code with your headset.

## Gameplay

- **Fire** — trigger/pinch, or a forward hand thrust. Both fire whatever's
  loaded. (An optional finger-curl **FLICK** gesture ships off; see
  `WEB.gestureEnabled` in `src/config.ts`.)
- **Gauntlets** sized to your measured hands and forearms, with three
  launchers: bare **HAND**, the auto-firing paint **BLASTER**, and **GOO**.
- **Wrist menu** — poke the glowing gem on your left wrist (or press **Y**) to
  pop up launcher · colour · ammo (NORMAL · BOUNCY · STICKY · SPLASH). Closed,
  it never gets in the way.
- **GOO** flings sticky strands in your paint colour: SPLAT goo on the walls,
  or switch to **TETHER** (menu or **B**) — hook a Neatnik, yank to reel it in,
  pop it up close.
- **90-second rounds**: each Neatnik has its own points (Mopsy 100 up to Duster
  Duke 1000) × combo, painting the room = 5 a splat, best score remembered.
  Break the Squeegee's shield in 3 hits or flank it; the Duke patrols the last
  20 s.
- **CHILL MODE** opens the **Studio** (no clock): a framed canvas on your real
  wall, stencils scored by coverage, a target range that splashes your walls;
  save your art as a PNG.
- First visit in a new room: tap **SCAN ROOM** if prompted — walls need Quest's
  Space Setup scan (Guardian alone isn't a room scan).

## Develop

```bash
npm install
npm run dev
```

Opens `https://localhost:8083` with a desktop Quest 3 emulator (IWER) — playable
with mouse/keyboard emulated controllers, and drivable by Claude Code through
the bundled MCP tools.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server + emulator on :8083 |
| `npx tsc --noEmit` | Type check (run before testing — required) |
| `npm test` | Unit tests (Vitest) |
| `npm run build` | Production build to `dist/` |
| `npm run deploy` | Build + deploy to Netlify production |
| `npm run launch` | Deploy, then print the Quest QR code |
| `npm run qr` | QR for the deployed game |
| `npm run qr:dev` | QR for your LAN dev server |

## Tuning & docs

Every gameplay number lives in one commented file: [`src/config.ts`](src/config.ts).

| Doc | For |
|---|---|
| [GAME_GUIDE.md](GAME_GUIDE.md) | Players & tuners — every knob mapped to its effect, asset-swap recipes |
| [docs/STATE.md](docs/STATE.md) | **Current platform state** — features, architecture, asset pipeline, round history, open items |
| [CLAUDE.md](CLAUDE.md) | AI-session onboarding — hard-won framework gotchas, build/test/troubleshoot workflows, documentation rules |

## Stack

IWSDK 0.3.1 (elics ECS + Havok physics + preact signals + UIKitML panels) ·
TypeScript · Vite · Vitest · Netlify. SFX and the splat mask were generated with
Higgsfield (`mirelo_text_to_audio`, `nano_banana`).
