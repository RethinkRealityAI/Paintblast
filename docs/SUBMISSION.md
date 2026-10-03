# Splotopia — competition submission pack

Meta **VR Start Developer Competition 2026** (Devpost). Deadline **Nov 18 2026,
12:00 PT**. Track: **Gaming**. Division: **Adapted** (pre-existing project with a
meaningful new feature shipped in the window).

Everything here is draft copy for the Devpost form plus the checklists that
gate submission. Facts about the build must match `docs/STATE.md`; update both
together.

---

## 1. Form fields

**Project name:** Splotopia

**Tagline (max 140 chars):**

> Splatter neon paint across your real room and outsmart the Neatniks, neat-freak robots hiding behind your furniture. Hands only.

(128 characters.)

**Build link (judges):** `https://paintblast-mr.netlify.app` — must stay free and
reachable until the winner announcement (Dec 11 2026). Rename the Netlify site
to a Splotopia URL *before* submitting if we want the new name in the link; the
old URL then stops working, so update the QR asset (`npm run qr` /
`scripts/gen-qr-asset.mjs`) and the OG tags in the same deploy.

**Baseline (Adapted-division proof):** Aug 19 2026 deploy permalink
`https://6a8538f321c2e38c9f5fa08e--paintblast-mr.netlify.app` (shipped as
"PaintBlast MR", before the competition window). Keep this deploy; never delete it.

## 2. Description (~500 words; English)

> **Inspiration.** Every mixed-reality demo we tried treated the room as a
> backdrop. We wanted the opposite: a game that only works *because* it is in
> your room. The idea was simple and a little mischievous — what if your living
> room were a paint arena, and the enemy were tidy little robots desperate to
> clean up your mess? That became Splotopia: neon paint that sticks to your real
> walls, couch and floor, and the Neatniks — Mopsy, Squeegee, Peekaboo and the
> boss, Duster Duke — who hide behind your actual furniture and try to scrub
> your masterpiece away.
>
> **What you do.** You wear forearm gauntlets with three launchers: bare HAND,
> the paint BLASTER (hold to auto-fire, a glass canister glowing in your loaded
> colour) and GOO, sticky paint strands that splat or tether — hook a Neatnik
> and haul it in. A holographic palette on your left wrist swaps colour and
> ammo with a tap. Each Neatnik needs its own answer: Squeegee blocks frontal
> shots with a shield, so you flank it or bank a shot off your wall; Peekaboo
> hides behind your sofa and is only hittable mid-peek; Duster Duke drops in for
> the final 20 seconds and has to be worn down or hauled in. Pip, your
> palette-drone sidekick, teaches you everything in a 60-second hands-only
> tutorial — no wall of text. Chill mode turns it into a calm room-scale paint
> studio with an easel you can grab and export.
>
> **How we built it.** Splotopia is a WebXR app built on Meta's Immersive Web
> SDK (IWSDK) with an entity-component-system architecture, three.js rendering
> and Havok physics, running in the Quest browser — nothing to install. It is
> hands-first end to end and fully playable seated. Scene understanding turns
> your Space Setup planes and room mesh into colliders, so paint lands on your
> real surfaces and Peekaboo picks real furniture to hide behind; depth
> occlusion lets your couch actually hide it. Characters were concepted with
> generative image tools, turned into 3D with Meshy, and animated procedurally
> in code (squash, sway, peeks, the boss drop). Under the hood: a wrist-frame
> solver that keeps the gauntlets aligned with your forearm on both hand
> tracking and controllers, swept hit tests and velocity caps so nothing
> tunnels through thin walls, pause/resume on focus loss, and 670+ unit tests.
>
> **What's new in this round (Adapted division).** Since our August baseline we
> rebuilt the game hands-first (pinch to fire, tap-to-select palette,
> gesture shots), added the three-mode gauntlet system with skins, the
> room-aware Neatnik roster with distinct behaviours and a boss, the GOO
> tether, the guided tutorial and first-encounter coaching, depth occlusion,
> seated play, a results screen, and a full visual rebrand.
>
> **What's next.** Daily challenges and streaks, persistent murals anchored to
> your walls between sessions, shared-room co-op so two players can paint the
> same room, more Neatniks, and left-handed/one-handed layouts.
>
> **Target launch:** _TBD — owner to set (suggest Q1 2027 on the Meta Horizon
> Store as a PWA)._

## 3. Testing instructions for judges

1. Meta Quest 3 or 3S, Quest browser. Run **Space Setup** first (Settings >
   Physical space > Space setup) — the game works without it, but paint and
   hiding Neatniks are best with your walls and furniture captured.
2. Open the build link, press **ENTER AR**, allow spatial data when asked.
3. No controllers needed: **pinch** to fire, look at your **left wrist** for the
   palette and **tap** it with your right index finger, press menu buttons by
   pointing with your **right hand** and pinching.
4. First launch runs Pip's tutorial (about 60 s, skippable). Then press **PLAY**
   for a 90-second round. **LOADOUT** picks launcher and gauntlet skin.
5. Seated play is supported; everything spawns in front of you.
6. Pause: press the Quest button; the round freezes and resumes when you return.

## 4. Video (< 3 min, captured on Quest; YouTube/Vimeo, public)

Rule: "as viewed on a Meta Quest device or via XR Simulator"; don't let AI video
carry the pitch. Shot list:

| t | Shot |
|---|---|
| 0:00–0:08 | Cold open: ENTER AR, logo splats onto the real wall, "YOUR ROOM IS THE ARENA" |
| 0:08–0:30 | Pip tutorial: first pinch paints the wall, tap the wrist palette |
| 0:30–1:10 | Round: BLASTER auto-fire, colour swap, Mopsys popping, combo |
| 1:10–1:30 | Squeegee deflect → flank shot; Peekaboo hiding behind the couch (occluded) |
| 1:30–1:55 | GOO tether: hook and haul; Duster Duke drop, split |
| 1:55–2:15 | Results card, NEW BEST; LOADOUT skins |
| 2:15–2:40 | Chill mode: paint, grab the easel, export |
| 2:40–2:55 | Seated + hands-only callout, logo, URL |

## 5. Adapted-division changelog (baseline → now)

Lead with features, not fixes. Pair each with a before/after screenshot (the
baseline permalink above is the "before").

1. **Hands-first interaction rebuild** — pinch fire, tap-to-select wrist palette,
   gesture shots, right-hand menus; baseline copy said "Hold trigger to spray".
2. **Gauntlet launcher system** — HAND / BLASTER / GOO with deploy animation,
   auto-fire, five skins, LOADOUT screen.
3. **Room-aware Neatniks** — four archetypes with distinct behaviours (shield,
   furniture hiding, boss with HP/split), wave director, seated spawn arc.
4. **Depth occlusion** — real furniture hides Neatniks.
5. **GOO tether** — hook and haul with proportional pull.
6. **Onboarding** — Pip's tutorial, first-encounter coaching, results card.
7. **Comfort/accessibility** — seated play, pause/resume, vertical comfort band,
   larger text, colour-independent ammo cues.

## 6. Asset provenance (IP rules: original or authorised)

| Asset | Source | Status |
|---|---|---|
| Neatnik GLBs (`public/gltf/splotbots/`) | Meshy image-to-3D from our Higgsfield concepts | **Confirm** the Meshy plan grants commercial rights; keep receipts |
| Concepts, key art, OG, landing art, logo (`docs/concepts/`, `public/brand/`, `public/landing/`) | Higgsfield image models (logo: `gpt_image_2_5`, R9) | **Confirm** plan terms; keep generation IDs |
| Easel, palette board | Higgsfield `image_to_3d` | Confirm plan terms |
| SFX / music (`public/audio/`) | Higgsfield `mirelo_text_to_audio` / `sonilo_music` | Confirm plan terms |
| Fallback robot (`public/gltf/robot/`), plant (`public/gltf/plantSansevieria/`, unused) | Believed to be the IWSDK starter-template assets (Meta) | **Confirm** origin and licence, or replace the fallback robot with a Neatnik GLB |
| Code | Ours + IWSDK / three.js / Havok (open-source licences) | OK — list licences in README |

## 7. Pre-submit checklist

- [ ] On-device pass on Quest 3 **and** 3S: all items in STATE.md's checklist
- [ ] Measured **≥ 60 fps** (target 72) with full cast + boss + both gauntlets
- [ ] Hands-only run from landing to game over with no controller
- [ ] Netlify URL decision (keep or rename) + QR/OG updated
- [ ] Baseline screenshots captured from the permalink
- [ ] Video recorded on device, uploaded public, < 3:00
- [ ] Asset licences confirmed (table above)
- [ ] Target launch date set in the description
- [ ] Real trademark knockout search for "Splotopia" (USPTO/EUIPO)
