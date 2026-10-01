# PaintBlast MR

Mixed-reality paintball arcade for **Meta Quest 3 / 3S**, built on Meta's
[Immersive Web SDK](https://developers.meta.com/horizon/documentation/web/immersive-web-sdk/)
(`@iwsdk/core`). Your real room is the arena: rogue robots materialize around
you, you blast them with paintballs, and the paint splats stick to your actual
walls and furniture.

**Play it now:** https://paintblast-mr.netlify.app — or run `npm run qr` and
scan the code with your headset.

## Gameplay

- **Fire three ways** — trigger/pinch, the **thwip gesture** (curl middle+ring
  fingers, Spider-style), or a forward hand thrust. All fire whatever's loaded.
- **Painter's palette on your left wrist** — tap or squeeze a paint **dab** for
  color, a **chip** for ammo: NORMAL · BOUNCY (3 ricochets) · STICKY (welds) ·
  SPLASH (9-splat flower) · **WEB**.
- **Web ammo** mounts wrist shooters: splat webs, or flip the holo pad / press
  **B** for **tether webs** — latch a robot, yank to reel it in, pop it up close.
- **90-second rounds**: robots = 100 × combo, painting the room = 5 a splat,
  best score remembered. **CHILL MODE**: no clock, easel painting you can save
  as a PNG, lofi loop, hold-to-spray. **WEB MODE**: chill with webs preloaded.
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
