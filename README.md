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
- **Painter's palette on your left wrist** — tap or squeeze a paint **dab** for
  color, a **chip** for ammo: NORMAL · BOUNCY (3 ricochets) · STICKY (welds) ·
  SPLASH (9-splat flower) · **GOO**.
- **GOO** mounts wrist launchers that fling sticky strands in your paint colour:
  SPLAT goo on the walls, or flip the holo pad / press **B** for **TETHER** —
  hook a Neatnik, yank to reel it in, pop it up close.
- **90-second rounds**: Neatniks = 100 × combo, painting the room = 5 a splat,
  best score remembered. **CHILL MODE**: no clock, easel painting you can save
  as a PNG, lofi loop, hold-to-spray. **GOO MODE**: chill with goo preloaded.
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
