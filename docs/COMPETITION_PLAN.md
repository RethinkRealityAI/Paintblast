# Splotopia — Meta VR Start Developer Competition 2026 plan

> Splotopia was "PaintBlast MR" until Round 9 (2026-10-03). Written 2026-10-01 alongside Round 7;
> status refreshed after Round 9. Competition: <https://start-developer-competition-26.devpost.com/>
> Deadline **Nov 18 2026, 12:00 PT**. Judging Nov 18 – Dec 9; winners ~Dec 11. Build must stay live and
> unchanged until then. This file is the strategy; `docs/STATE.md` stays the source of truth for
> what the code does today, and `docs/SUBMISSION.md` holds the Devpost copy and pre-submit checklist.

## 1. The entry, in one paragraph

**Track: Gaming. Division: Adapted / Significantly Updated.** You can only pick one track per
submission, and you only get one entry. Entertainment is defined as *lean-back media* (spatial
cinema, music visualisation, interactive video). Splotopia is active play, so it would be judged
against those and lose on "relevance to the chosen track". Gaming explicitly wants "hands-first …
casual … genres that thrive seated", which is a direct fit. Chill mode is still part of the entry:
it is the "creative, come back tomorrow" half of the pitch inside the Gaming track, not a second
entry. The game existed before Sep 24, so the New Experience division is out. The prizes are
identical anyway: $100k winner / $50k runner-up.

**The proof for "Adapted" already exists.** The Netlify production deploy of the pre-competition
build is dated **2026-08-19** and has an immutable permalink:
<https://6a8538f321c2e38c9f5fa08e--paintblast-mr.netlify.app> (shipped as "PaintBlast MR").
Screenshot that deploy page now.
Never delete that deploy. The repo history alone cannot prove anything: it is a single squashed
commit dated Oct 1.

## 2. How we'll be judged

Four criteria, each worth 25%:

| Criterion | What judges look for | Where we are | What wins it |
|---|---|---|---|
| Innovation & Creativity | Originality, ambition, fit to the track, use of hands, gaze, passthrough and scene understanding | Strong concept: your real room is the paint canvas | One signature room-aware mechanic: robots that come *out of* your walls and furniture and hide behind your couch |
| Experience Design | Intuitive from the first second, clear onboarding, a habit-forming purpose, seated and hands-first, and the room should meaningfully change the experience | R9: Pip's ~1-minute hands-only tutorial (ring on your own wall → palette → pop → GOO tether haul), first-encounter coaching, results card with a next goal; FLICK finger-curl off, so pinch + thrust are the gestures. **No progression / return loop yet** | Daily challenge, a mural that persists in your room, streaks |
| Technical Implementation | 60 fps minimum, solid and bug-free, strategic use of hands, passthrough, MRUK and anchors, FoV-aware | Solid ECS core, 763 unit tests, room colliders (walls + ceilings thickened). R9: robot-only depth occlusion (optional feature, self-disabling, **unverified on device**). On IWSDK 0.3.1 | IWSDK 1.0 upgrade, depth occlusion proven on Quest 3/3S, a proven 72 fps, anchors |
| Polish & Presentation | UI/UX, art direction, sound, a video of real gameplay | R8 cast + gauntlets + techno-paint HUD; R9 rebrand (Splotopia logo, Neatniks), HUD copy/legibility pass. Sound still reuses R4–R8 cues | A sound pass, and a tight trailer cut from real footage |

**Special awards ($25k each) to aim for**, in order of fit:

1. **Best First Five Minutes**: build onboarding as a feature, not a text panel. *(R9: Pip's tutorial, coaching, results card — shipped.)*
2. **Best Reason to Come Back**: daily challenge, persistent room murals, painting gallery.
3. **Best Accessibility Forward**: seated by default, aim assist, a one-handed mode, colour-blind-safe ammo (shape + label + colour already exist), and no timer in Chill.
4. **Boldest Original Concept**: "your living room is the arena and the canvas."

Only chase Social/Multiplayer (colocated paint battle) if Phase 2 finishes early. It is the
largest scope item on this list. **Still undecided** (§9).

## 3. Hard requirements: status after Round 9

| Requirement | Status | Remaining work |
|---|---|---|
| Fully usable with hands, end-to-end | ✅ in code: pinch PLAY, R10 summonable poke wrist menu (gem on the left wrist), pinch-hold reel, hands-only copy, hands-only tutorial with SKIP / two-pinch skip | **Prove it on device.** Quest Browser treats a *left* palm pinch as the menu button (exits the session), so test that the left-palm-down menu pose never triggers it |
| Seated / "airplane seat" (2 ft radius) | ✅ in code: 150° forward spawn arc, 1.7 m height cap, released bots drift back out, R10 continuous spawns with a 1 s thinning breather; R9 easel at 0.7 m with the board at eye height; R10 Studio canvas on the wall or floating 1.3 m ahead | Prove seated reach on device |
| Quick entry/exit, clean pause/resume | ✅ Pause on focus loss (timer, robots, tethers freeze and resume) | Measure cold start; consider resuming a round after the session is fully exited and re-entered |
| 60 fps minimum | ❓ Not measured on device since R6 | On-screen perf meter (dev flag), test a double pop with full VFX on Quest 3 **and 3S** |
| Purposeful passthrough + scene understanding | 🟡 Room mesh colliders, paint sticks to real walls, Peekaboo hides behind real furniture, intro logo and tutorial ring land on your real wall; R9 robot-only depth occlusion (`RobotDepthSensingSystem`; splats excluded because the occlusion shader ignores `instanceMatrix`) | **Verify occlusion and wall snap on Quest 3/3S** — the emulator has neither depth nor scene data |
| FoV-aware design (Glasses are 70×66°) | 🟡 HUD docks low during play | Run the `metavr device fov-sim` check. IWSDK 1.0 adds `fieldOfViewMask`. Keep robots and the HUD inside ±30° |
| Original content / IP | ✅ R9 rebrand done (§5) | Trademark knockout for "Splotopia"; confirm asset licences (SUBMISSION.md §6) |
| Video under 3 min, real footage, on YouTube or Vimeo | ⬜ | §7 |
| Build live through Dec 11, frozen after the deadline | ⬜ | Production deploy on Nov 17. **No deploys after Nov 18** |

## 4. Roadmap to Nov 18

Each phase ends with tsc clean, tests green, `scripts/headless-verify.mjs` shots reviewed, and a
headset session.

**Phase 0: Rounds 7–9 (done 2026-10-01 → 10-03).** R8 shipped the characters, gauntlets and HUD (§6). R9 shipped the rebrand (§5), an adversarial mechanics audit's fixes, robot depth occlusion, the seated easel, and the whole Phase 3 onboarding item (Pip's tutorial with a practice round, first-encounter coaching, results card). R7: Shooters now lie along the forearm and shoot where they point. Tether reels smoothly with pull, pinch and hold. Palette is readable and holds still while you poke it. Pinch-to-select no longer fires. Easel grab is smoothed. Pause/resume works. Seated spawn arc. IBL, tone mapping, wet-paint balls, VFX, vivid sRGB colours, and a swept hit test.

**Phase 1: foundation and compliance (Oct 2 – Oct 14)**
- Device-test R7–R9 on Quest 3 and 3S using the STATE.md checklist (depth occlusion, wall snap, tutorial haul are new). Tune `WEB.handAimSource`, the `rayBlend*`, `MENU.hand*` and `ARMFIT.*` knobs (R10 added the wrist menu and arm fit).
- Upgrade to **IWSDK 1.0.x** on its own branch, using the headless harness as the regression gate. This brings gaze+pinch, `fieldOfViewMask`, Glasses support, and is what the rules recommend.
- ~~Turn on depth occlusion for robots~~ (R9, robots only; splats excluded). Prove it on device.
- ~~Make the seated easel distance the default~~ (R9, 0.7 m). Add a perf meter.
- ~~Decide the rebrand (§5) and consolidate gestures~~ (R9: Splotopia / Neatniks / GOO / FLICK; finger-curl off, pinch + thrust remain).

**Phase 2: the hook (Oct 15 – Oct 28)**
- *Room Raid*: robots emerge from **your** walls and furniture (scene mesh and planes), hide behind real objects (occlusion), and peek out. Paint reveals hidden ones.
- ~~Four new characters with distinct behaviours (§6). A boss finale.~~ (R8.)
- ~~A short round structure with a results card.~~ (R8 waves in a 90 s round; R9 results card.)

**Phase 3: first five minutes and the return loop (Oct 29 – Nov 8)**
- ~~**Onboarding by doing**, led by a guide character~~ — **done in R9**: Pip's tutorial (ring on your wall → tap the palette → pop a Mopsy → GOO > TETHER haul → "you're ready"), skippable, remembered, replayable from the title; plus first-encounter coaching.
- **Reason to come back**:
  - a daily challenge seeded by date (colour + kind + target count);
  - your Chill mural persisted to the room with anchors, so it is still on your wall tomorrow;
  - a painting gallery (saved PNGs, with thumbnails in the HUD);
  - best-of-day and streak tracking, all stored locally.
- **Accessibility panel**: aim-assist strength, one-handed mode (both palette and firing on one hand), seated or standing, colour-blind patterns on splats.

**Phase 4: polish and proof (Nov 9 – Nov 15)**
- Sound pass: an original GOO launch sound (R9 only renamed the file to `flick.mp3`), hit and pop variety, robot voice barks, and adaptive music.
- Art pass and performance pass.
- **Five external playtesters** (seated, hands only, never seen the game). Fix the top three issues.

**Phase 5: ship (Nov 16 – Nov 17)**
- Code freeze Nov 16. Final production deploy and smoke test (HEAD requests on assets) Nov 17.
- Submit **Nov 17**, a day early: Devpost forms queue up on deadline day.

## 5. IP and originality — resolved in Round 9

**Decision taken (R9):** the game is **Splotopia** (PaintBlast clashed with mobile "Paint Blast"
games), the enemies are **the Neatniks** (the working name "Splotbots" was too close to
*Splatterbot*, a 2025 Steam/Switch game), the web launcher is **GOO** (strands in your paint
colour) and the finger gesture is **FLICK**, **off by default** (`WEB.gestureEnabled: false`).
Thrust and pinch remain. Every player-facing label, the sound file and the storage keys were
renamed; some code identifiers still say web/thwip. Still open: a real trademark knockout
search for "Splotopia", and the Netlify URL (still `paintblast-mr`). The original analysis
follows for the record.

The web mechanic is our biggest compliance risk. The rules require original content: no brand
names, no commercial artwork, nothing that infringes third-party rights. Today the game has:

- a "thwip" gesture and sound;
- the middle-and-ring-curled hand sign, which this repo's own guide calls "the Spider-Man pose";
- white webbing fired from wrist "web shooters".

Three separate problems follow from that:

1. Judges at Meta will read it as derivative.
2. That hand sign is the *mano cornuta*, which is insulting in parts of Southern Europe. Meta's gesture guidance says not to use culturally loaded gestures.
3. Curled middle and ring fingers track poorly and occlude themselves.

**Recommendation:** keep the mechanic and change its identity so it belongs to a paint game.

- **"Goo Lines" / "Ink Grapple"**: wrist **paint launchers** that fire coloured goo strands in your loaded paint colour, never plain white.
- The hero gesture becomes the **punch-thrust**, which Meta says tracks better than a chop. The finger-curl gesture is retired.
- Rename the sound, the copy and every config label a player can see.

This costs about a day: it is mostly naming, strand colour and the gesture default. It removes
the risk entirely. *(Done — see the decision above.)*

## 6. Characters and assets: art bible for Meshy and Higgsfield

**Direction:** the Neatniks (working name "Splotbots" until R9): chunky, toy-like cleaning robots that hate mess and that you
cover in paint. Glossy vinyl bodies, one big expressive face screen (an emissive texture swap
for emotions), and rounded silhouettes that read at 3 m. They must not look like The Nanauts,
the 2025 IWSDK winner's cute robots. Ours are domestic appliances gone rogue: mop heads,
spray nozzles, vacuum skirts.

![Neatniks lineup concept v1](concepts/splotbots-lineup-v1.jpg)

*Concept v1, generated with Higgsfield `nano_banana_pro` (2 credits) from the template below.
Left to right: Mopsy, Squeegee, Peekaboo, Duster Duke, Pip. This shows a direction only.
Approved; R8 built it as Meshy GLBs (unrigged, procedural animation).*

| Character | Role | Silhouette and behaviour | Hit and pop |
|---|---|---|---|
| **Mopsy** | Basic hover target | Squat dome with a mop skirt. Drifts and bobs. | Mop fringe flicks; face shows 😵 |
| **Squeegee** | Shielded | Flat wiper-blade shield on its front arm that always turns to face you. Needs a Bouncy shot off a wall, a tether, SPLASH or a flank; R10: the shield breaks after 3 blocked hits, then 2 HP. | The shield gets painted over and falls off |
| **Peekaboo** | Room-aware | Hides behind your real furniture (scene mesh) and peeks out for 1.5 s | The surprised face is the tell |
| **Duster Duke** | Boss (last 20 s) | Tall feather-duster crown, 11 HP (R10), patrols the forward arc, splits into two Mopsys | Crown feathers fly off as confetti |
| **Pip** | Onboarding guide and mascot | A floating paint-palette drone with brush arms that speaks short lines (R9: speech bubble in the tutorial) | Never shot. Celebrates a new best |

**Pipeline** (this extends the asset table in STATE.md):

1. **Concept art**: Higgsfield `nano_banana_pro`, one image per character. Use a front 3/4 view on a plain light-grey background, show the full body, and include no text, no logos and no other characters. Lock the style by reusing the first approved image as a reference.
2. **3D**:
   - **Meshy** image-to-3D for the characters, because it does auto-rigging and stock animations (idle, hit, flee) that Higgsfield's `generate_3d` does not.
   - Higgsfield `generate_3d` is fine for static props: a new gauntlet, the easel, the palette.
3. **Mesh budget**: one GLB per character, 5–10k triangles, a single 1–2k PBR material, and the face screen as a separate emissive material. Export in A-pose, facing −Z, at real-world scale or larger (the code measures and rescales at runtime). Compress with KTX2 textures and Draco or meshopt.
4. **Gauntlet replacement**: author the long axis along model −Z with the nozzle at the −Z end and the back of the hand at +Y, then set `WEB.shooterUseGlb`. No code change is needed.

**Prompt template** (concept art):

> "Stylized 3D toy robot character, glossy vinyl and soft rubber, chunky rounded proportions,
> household cleaning appliance theme: {ROLE DETAILS}. One large rounded face screen showing a
> simple emissive {EXPRESSION} face. Colour palette: off-white body, {ACCENT} accents, chrome
> joints. Full body, front three-quarter view, neutral light-grey studio background, soft key
> light, no text, no logos, no other objects. Clean silhouette readable at a distance. Game asset
> concept, Pixar-meets-designer-toy."

Substitute these for `{ROLE DETAILS}`:
- **Mopsy:** "a squat dome body floating above a skirt of thick mop strands, two stubby arms"
- **Squeegee:** "a slim upright body, one arm ending in a wide flat rubber squeegee blade used as a shield"
- **Peekaboo:** "a tall narrow body like a vacuum wand, a periscope head on a telescoping neck"
- **Duster Duke:** "a tall regal body, a crown of fluffy feather-duster plumes, a cape made of a cleaning cloth"
- **Pip:** "a small flying painter's-palette drone with four tiny propellers and two brush-tipped arms, a friendly face screen"

**Licensing:** confirm that the Higgsfield and Meshy plans in use grant commercial rights to their
outputs, and keep the receipts. The rules allow third-party assets only with authorisation, and
they say nothing against AI-generated 3D. They only ban AI-generated *video* in the pitch.

## 7. The video (under 3 minutes, real footage only)

Capture on device with Quest casting or MQDH recording. Use a seated player, hands only, in a
real living room.

| Time | Shot |
|---|---|
| 0:00–0:10 | Cold open: the player pinches, and paint explodes on their real wall. Title card |
| 0:10–0:35 | First five minutes, cut tight: Pip's tutorial (built in R9) |
| 0:35–1:20 | A Room Raid round: robots emerge from the walls, the player hooks one, hauls it in and pops it |
| 1:20–1:50 | Chill mode: painting on the easel, saving the canvas, the mural staying on the wall |
| 1:50–2:20 | Accessibility and seated play: one-handed mode, aim assist |
| 2:20–2:45 | The return loop: daily challenge, streak, gallery. End card with the live URL and QR code |

## 8. Submission checklist

The live version, with form copy, is `docs/SUBMISSION.md` §7; this list is the original.

- [ ] Devpost: name, tagline (≤140 chars), track **Gaming**, division **Adapted**, description (≤500 words), target launch date, team.
- [ ] "Summary of new features", with the Aug 19 permalink as the "before" and screenshots and changelog for the "after". STATE.md's round history is the source.
- [ ] Optional hand-interaction description: pinch to fire and select, punch-thrust, pull and pinch reel, a summonable wrist menu with Quest-style poke buttons that holds still while poked, aim assist, two-pinch tutorial skip.
- [ ] Live URL (Netlify production), working on Quest 3 and 3S. Keep the QR code on the landing page.
- [ ] Video on YouTube or Vimeo, public, under 3:00.
- [ ] Start Program membership active. Meta developer account in good standing.

## 9. Decisions

1. ~~**Rebrand the web mechanic** (§5)~~ — **resolved R9**: Splotopia / Neatniks / GOO / FLICK; finger-curl off by default.
2. ~~**Characters**~~ — **resolved R8**: the cast was approved and built (Meshy, unrigged, procedural animation; renamed Neatniks in R9).
3. **IWSDK 1.0 upgrade**? **Open.** Recommended: yes, behind a branch with the headless harness as the gate.
4. **Multiplayer** (the Social award) as a stretch goal, or deliberately out of scope? **Open.** Recommended: out of scope unless Phase 2 finishes by Oct 24.
5. **Netlify URL** — keep `paintblast-mr.netlify.app` or move to a Splotopia URL (breaks the old link; update QR + OG in the same deploy)? **Open.**
