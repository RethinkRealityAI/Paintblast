# PaintBlast MR — Tuning & Editing Guide

Everything you'd want to tweak lives in **[`src/config.ts`](src/config.ts)** — one file,
plain numbers, hot-reloaded by the dev server. Change a value, save, and the running
game picks it up on reload. No system code needs touching for balance changes.

## The 60-second edit loop

```bash
npm run dev
```

Open `https://localhost:8083`, click **Enter AR** (the desktop emulator runs a fake
Quest 3 in a living room), edit `src/config.ts`, save, reload the page. To play on
your headset instead, see **Launching on Quest** below.

## What each config section does

| Section | Controls | Try changing |
|---|---|---|
| `FIRE` | Muzzle velocity, fire rate, sandbox firing in the menu, **aim assist** | `speed` 8.5 → 12 for flatter shots; `cooldownMs` 220 → 120 for a faster trigger; `aimAssistDeg` 4 → 0 for purist aiming |
| `BALLS` | Ball size, live-ball cap, lifetimes, kill floor | `maxLive` if you want more chaos on screen |
| `BALL_KIND_CONFIG` | Per-ammo feel: bounciness, drag, splat size, max bounces | `Bouncy.maxBounces` 3 → 6 for pinball rooms |
| `IMPACT` | Impact-detection thresholds (advanced) | Leave alone unless splats appear mid-air (raise `impactDeltaV`) or don't appear (lower it) |
| `CHILL` | Chill status line, spray rate, ambient music on/off | `sprayCooldownMs` 120 → 60 for a firehose; `music: false` for a silent studio |
| `SPLAT` | Decal capacity, base size, size/rotation jitter, splash pattern | `capacity` 512 → 1024 to paint longer before old splats recycle; `baseRadius` for bigger paint |
| `GAME` | Round length, countdown, combo window/cap, **scoring values**, pause copy | `roundSec` 90 → 60 for arcade-tight rounds; `scoreWallSplat` 5 → 0 if only robots should score |
| `TARGETS` | Pool size, alive cap, spawn arc/ring radii/**heights**, respawn pace, pop/hit animation timing | `spawnArcDeg` 150 → 360 for the old surround ring (standing play); `heightMax` 1.7 → 2.0 if nobody plays seated; `maxConcurrent` 5 → 6 and `respawnDelaySec` 1.5 → 0.8 for a harder game. `poolSize` must equal the Splotbot pools' sum (a test checks) |
| `SPLOTBOTS` | **The robot cast** (round 8): per-character size, HP, points, idle motion; the waves; the boss; the shield; the peek cycle; spawn/hit/pop animation; Pip | `waves` for pacing; `boss.enterAtSecLeft` 20 → 0 to switch the boss off; `shield.coneDeg` 140 → 100 to make flanking easier; `peek.upSec` 1.5 → 2.5 for slower peekers |
| `BLASTER` | **Gauntlet blasters** (round 8): skins, deploy speed, auto-fire rate, barrel muzzle, back-of-hand plate, recoil, glow, mode-switch cue | `autoFireCooldownMs` 150 → 100 for a hose, → 250 for a semi-auto feel; `transitionSec` 0.3 → 0 for instant swaps; `modeSwitchVolume` 0 to silence the swap cue |
| `INTRO` | The enter-AR logo intro (round 8): timing, size, burst, tagline, sounds | `enabled: false` to drop straight to the title; `exitStartSec` 2.7 → 1.8 for a shorter hold; `tagline` (ASCII only) |
| `HUD` | Where the panel sits in menus vs. mid-round, how lazily it follows, and (round 8) the button/section micro-animations and the urgent clock | `playOffset` `[0, -0.52, -0.95]` — drop the middle number further if the HUD still crosses your aim; `sectionFadeSec` 0 for instant section swaps; `timerUrgentSec` 10 → 15 |
| `PALETTE` | Wrist palette: **board style** (holo / glb / wood) and the holo look, dab arc, chip row + labels, mode pads, controller mount (grip offsets, tilt), **hand mount** (lift/forward/outward), poke-park lock, pinch reach, appear / hide-on-lost | `boardStyle: 'wood'` for the old look; controllers: `wristOffsetY` 0.11 to float it higher. Hands: `handLift` (0.08) / `handForward` to move it; `lockRadius` 0.16 → 0.2 if it still moves under your finger; `hideAfterLostSec` 0.5 → 1.5 if it blinks out mid-poke |
| `WEB` | Web ammo: hand aim source, spinneret/bracer size/offsets/smoothing (shared by every gauntlet mode), web speed/gravity/aim assist, the two gesture triggers, strands, web splats, **the tether reel** and the wrist selector | `handAimSource` 'ray' ↔ 'hand' if the barrel does not follow your arm; `shooterOffsetZ` to slide it along the forearm; `thrustSpeed` 1.7 → 1.3 if thrusting never fires; `pullGain` 2.2 → 3 if reeling feels stiff |
| `ROOM` | How far robots are held off real walls, **how thick wall colliders are**, and the room-scan notice | `wallThicknessMeters` 0.06 → 0.1 if paint still goes through walls; `spawnWallMargin` 0.45 → 0.7 in a cluttered room |
| `FLOOR` | The invisible backstop floor: how wide, how thick, how far under y=0 | `extentMeters` 30 if you somehow play in a bigger space than that |
| `EASEL` | Canvas size (both orientations), board height/tilt, spawn distance, painting resolution, stamp sizes, grab smoothing | `spawnDistance` 1.4 → 0.7 for seated painting; `grabSmoothingSec` for a heavier/lighter easel |
| `AUDIO` / `AUDIO_VOLUME` / `AUDIO_SPATIAL` | Which mp3 plays for what, how loud, spatializing (round 8: `shieldPing` 0.45 for a Squeegee bounce, `bossEnter` 0.75 for the Duke's entrance) | Drop replacement mp3s into `public/audio/` with the same names |
| `HAPTICS` | Rumble intensity/duration per event | — |
| `RENDER` | Image-based lighting, tone mapping, ball clearcoat, robot rim | `iblIntensity` 1.0 → 0.8 if objects look too bright against your room; `ballClearcoat` 0 for a cheaper matte ball |
| `VFX` | Particle pool size and every burst (pop confetti, droplets, sparks, muzzle puff) | `muzzle.count` 0 if the puff clutters your hands; `pop.count` for bigger pops |

### The painter's palette

It rides your **left hand**, tilted toward your face. Round 8 made it a
**holo board**: a dark glass slab with a glowing neon edge, liquid paint wells
under the dabs and holo sockets under every chip and pad, built entirely in code
(nothing to stream, nothing to fail). `PALETTE.boardStyle` picks it: `'holo'`
(default), `'glb'` (the old modelled board, `public/gltf/palette-board.glb`) or
`'wood'` (the round-3 primitive oval). The `holo*`, `well*`, `socket*` and
`shimmer*` knobs are the look; the board is decoration only, so no style can
break selection.

- **Four paint dabs** curve around the far edge — glossy, flattened blobs in the
  four palette colors. Touching one sets the **color**, and drops you back to
  paint if you were throwing webs.
- **Five ammo chips** sit in a row along the near edge, by your wrist. Four load
  a paint kind; the fifth loads **WEB**. Exactly one chip is lit at a time.
- **Three mode pads** (round 8) across the middle — **HAND / BLASTER / WEB** —
  pick the launcher your gauntlets are in. See **Gauntlets and the Armory**.

Each chip has three ways to tell it apart, because round 4 shipped only the
first one and the field report was that the row looked bad and read as nothing:

| Chip | Shape | Color | Label |
|---|---|---|---|
| NORMAL | plain sphere | `#f5f2ec` off-white | NORMAL |
| BOUNCY | sphere in a hoop | `#ffca57` amber | BOUNCY |
| STICKY | cube | `#ff6b6b` coral | STICKY |
| SPLASH | faceted rock | `#48dbfb` sky | SPLASH |
| WEB | ball caged in two crossed rings | `#e8e8ee` web-grey | WEB |

The labels are tiny printed planes lying flat on the board just behind their
chip, baked once into a canvas texture at startup. They are **not** pressable —
plain meshes with no interaction components — so a fingertip aimed at STICKY can
never be swallowed by the word underneath it.

**Just tap.** Reach across with your right index finger and touch a dab or a
chip — the thing you touched swells to 1.3× *and* lights up in its own color
(`PALETTE.chipSelectedEmissive`, 0.35) to show it is loaded. Squeezing or
pinching still works as a fallback (it is how rounds 1–2 did it), and
ray-clicking still does nothing, by design.

That is twelve things to press (nine before the mode pads), still fewer than the
old sixteen, because color, ammo and launcher are separate choices rather than
one control per combination. The 4 colors live
in [`src/types.ts`](src/types.ts) (`PALETTE_COLORS`, RGBA 0–1 floats) and the
chip row is `PALETTE_CHIP_ORDER` in the same file — change a color there and the
chip, its glow and the HUD footer all follow.

If the palette sits awkwardly on your hand, `PALETTE.wristOffsetX/Y/Z` and
`PALETTE.tiltDeg` are the four numbers to nudge. The layout is `dabArcRadius` /
`dabArcStartDeg` / `dabArcEndDeg` for the paint and `chipSpacing` /
`chipRowOffset` / `chipLabelWidth` / `chipLabelGap` for the chips. One
constraint is load-bearing: `chipLabelWidth` must stay under `chipSpacing` or
neighbouring captions overlap. `PALETTE.grabSelectRadius` (9 cm) is how close a
squeeze has to be to count — it is a plain distance test, deliberately immune
to the pointer-priority quirks around the wrist.

To use a modelled board instead, drop it at `public/gltf/palette-board.glb` (it
is already in the manifest) and set `PALETTE.boardStyle: 'glb'`; until it has
streamed in, the holo board stands in. The dabs, chips and pads are always built
in code, so tapping keeps working whatever the art is.

**It appears and hides with your hand.** The board pops in (`appearSec`,
`appearFromScale`) when your left hand is tracked and hides after
`hideAfterLostSec` (0.5 s) without it, so it never hangs frozen in mid-air where
your hand used to be. It never hides while it is parked under your poking
finger.

One ergonomic side effect worth knowing: because the palette lives on the left
hand, that hand's laser is reserved for the palette — **click menu buttons with
your right hand** (painter's palette in the left, brush hand does the
pointing).

Round 6 hangs a tenth pressable off the left wrist, but not on the board: the
two-pad web sub-mode selector floats above the left **shooter**, and so exists
only while web ammo is loaded. It wears the same three pointer tags as a chip
and answers to the same squeeze-proximity fallback. See **TETHER WEB** below.

### Gauntlets and the Armory (round 8)

Both forearms wear a **gauntlet**, and it has three launchers. Pick one on the
palette's mode pads or in the **Armory** (title screen → **BLASTERS >**):

| Launcher | What you wear | How it fires |
|---|---|---|
| **HAND** | Nothing | Paint from your bare hand along the pointer, one ball per pull — the pre-round-8 game |
| **BLASTER** (default) | Bracer, back-of-hand plate, a barrel and a canister over the wrist that glows in your loaded paint colour | **Hold to auto-fire**, one ball every `BLASTER.autoFireCooldownMs` (150 ms) per hand, in every phase that allows firing. Shots leave the barrel you can see |
| **WEB** | Bracer, plate, and the web spinneret underneath | Webs, one per pull; SPLAT / TETHER pads ride the left spinneret |

WEB mode and the WEB chip are the same thing seen from two places: load either
and the other follows; load paint and you go back to whichever paint launcher
you had (BLASTER or HAND). Swapping plays a short deploy animation
(`BLASTER.transitionSec`, 0.3 s — it never blocks a shot), a chime when hardware
deploys, a soft click when it stows to bare hands, and a buzz on both hands
(`modeSwitchVolume`, `modeSwitchHapticIntensity` / `Ms`).

**The Armory** is a sub-screen of the title, not a game phase: three launcher
cards (HAND / BLASTER / WEB, with a one-line description), a skin picker
(`<` `>` arrows plus five dots), **BACK** and **PLAY**. Opening and closing it does
not move the panel. Starting a round from anywhere simply closes it.

**Skins** recolour the gauntlet's shell, trim and glow: NEON CORAL, CYBER LIME,
ULTRAVIOLET, CHROME ICE, GOLD RUSH (`BLASTER.skins`). Your choice is saved on
the device (localStorage `paintblast.blasterSkin`, `BLASTER.skinStorageKey`).
Add a skin by **appending** to the list — the saved value is an index, so
reordering changes everybody's pick; an index that no longer exists falls back
to the first skin.

| Knob | Ships as | What it does |
|---|---|---|
| `BLASTER.autoFireCooldownMs` | 150 | Auto-fire rate. Ball speed is still `FIRE.speed`; the wall-tunnelling cap does not move |
| `BLASTER.muzzleLocal` / `muzzleOffset` | [0, 0.058, −0.014] / 0.05 | Where on the wrist the barrel's muzzle sits, and how far past it a ball is born |
| `BLASTER.plateOffsetHand` / `plateOffsetController` | see config | The back-of-hand plate's position on a tracked hand / over a held controller |
| `BLASTER.controllerRollDeg` | 90 | Controllers are held thumb-up, so the hardware is rolled to put the barrel over the thumb side. 0 = anatomical (barrel sticks out sideways) |
| `BLASTER.recoilMeters` / `recoilPitchDeg` / `recoilDecaySec` | 0.012 / 6 / 0.07 | The kick per shot |
| `BLASTER.canisterSwirlHz` / `canisterPulseHz` / `muzzleFlashScale` | 0.35 / 0.6 / 1 | Canister life and the muzzle flash |

The bracer follows your **aim** and the plate follows your **hand**. If the OS
pointer ray and your hand disagree, they can look misaligned — `WEB.handAimSource:
'hand'` or wider `WEB.rayBlendNearDeg` / `FarDeg` (see the forearm gauntlet table)
are the fixes to try.

### The Splotbots (round 8)

The robots are now a cast of cleaning bots that want your paint gone. Every
round draws from a pool of 14:

| Bot | How many | Hits | Points | How to beat it |
|---|---|---|---|---|
| **Mopsy** | 7 | 1 | 100 | Point and shoot. Bobs and sways on a mop-string skirt |
| **Squeegee** | 3 | 1 | 150 | Its wiper-blade shield always turns to face you and **bounces** shots that arrive inside its front cone (no damage, a cyan ping). Get past it four ways: a **BOUNCY** ball banked off a wall (any ball that has already bounced), a **TETHER** web, **SPLASH** ammo, or a shot from the **side** |
| **Peekaboo** | 3 | 1 | 200 | Hides behind your real furniture and periscopes up for ~1.5 s. Only hittable while up, so watch the furniture and fire as it rises. With no furniture scanned it peeks up from low down |
| **Duster Duke** | 1 | 6 | 600 | The boss. Drops in with **20 s left** (once per round), stomps about, and **splits into two Mopsys** when popped. A tether haul takes 2 HP instead of popping him, then he walks back |

Points are multiplied by your combo as always. **Pip**, the little palette
drone, is the mascot, not a target: he hovers beside the HUD in menus, flies
away when a round starts, and does a double spin when you set a new best.

**Pacing** is `SPLOTBOTS.waves`: Mopsys only for the first 22 s (so the first
thing anyone learns is point, pinch, pop), then the cast arrives, then mixed
pressure until the boss. Each wave has `startSec`, `maxAlive` (capped by
`TARGETS.maxConcurrent`, 5) and `weights` for [Mopsy, Squeegee, Peekaboo].
Robots spread across `lanes` (5) of the forward arc.

| Knob | Ships as | What it does |
|---|---|---|
| `SPLOTBOTS.archetypes.<bot>.hp` / `points` / `heightMeters` | see table above | Toughness, value, size. Change `pool` only together with `TARGETS.poolSize` (a test checks the sum) |
| `...faceRate` / `bobAmplitude` / `swayRad` / `swayHz` | per bot | How fast it turns to you and how it idles |
| `SPLOTBOTS.boss.enterAtSecLeft` | 20 | When the Duke arrives; 0 = no boss |
| `SPLOTBOTS.boss.tetherDamage` / `companionsMax` / `distance` / `standHeight` | 2 / 2 / 2.0 m / 0.4 m | Tether damage, other bots allowed alongside him, where he lands |
| `SPLOTBOTS.shield.coneDeg` | 140 | Width of Squeegee's blocking cone. Lower = easier to flank |
| `SPLOTBOTS.shield.maxDeflectSpeed` | 9 m/s | Keep under ~10: a faster bounced ball tunnels walls (a test pins it) |
| `SPLOTBOTS.peek.upSec` / `hiddenSec` / `hittableLift` | 1.5 / 1.6 / 0.6 | How long a Peekaboo shows, hides, and how far up it must be to count |
| `SPLOTBOTS.peek.furnitureMinTop` / `MaxTop` | 0.35 / 1.4 m | Which furniture counts as cover (not rugs, not wardrobes) |
| `SPLOTBOTS.anim.*` | — | Spawn pop, hit squash and flash, pop spin |
| `SPLOTBOTS.pip.*` | — | Pip's size, where he sits beside the HUD, bob, happy spin, fly-off |

### The intro (round 8)

The first time each session turns visible, the PAINTBLAST logo bursts out of a
neon paint splat about 1.5 m in front of you, a ring of splats flies out, the
tagline **YOUR ROOM IS THE ARENA** lands, and then it lifts away and the title
HUD appears — about three and a half seconds in all. **Pinch or pull the
trigger to skip** (the press still does whatever it normally would). It waits
while the Quest menu is open, and plays again only after you leave AR and come
back.

`INTRO.enabled: false` turns it off. `exitStartSec` (2.7) is the hold,
`distance` / `heightOffset` / `logoWidth` place it, `particleCount` (56) is the
burst, `tagline` is the text (ASCII only), and the three `*Volume` keys mute or
level its whoosh, splat and chime. `hideHud` keeps the title HUD (and Pip) out
of the way until `hudRevealAt` of the exit.

### Paint never just sits there

Every ball ends as paint. A ball that hits something splats on contact as it
always has; a ball that lands softly — lobbed onto the canvas, dribbled onto the
floor — **dissolves into a splat where it comes to rest** and disappears.

Round 2 left those soft landings lying around as inert bubbles for a full 15
seconds, because a gentle contact never crossed the impact thresholds. Round 3
lowered the thresholds (`IMPACT.armSpeed`, `IMPACT.impactDeltaV`) so more soft
hits register properly, and made settling itself paint, so nothing can slip
through both. Sticky is unaffected — a welded sticky ball is meant to hang
there.

### The HUD gets out of your way

In the menu the panel sits comfortably in front of you. The moment a round (or
chill mode) starts it ducks low, shrinks to 75%, and follows your head lazily so
it stops eating your shots. Both placements are in the `HUD` config section.

Round 8 restyled it techno-paint: dark glass, neon frame, paint drips, the
brand logo on the title. The title screen has **PLAY**, **CHILL MODE**, **WEB
MODE**, three how-to tiles, a **LOADOUT** readout (launcher + skin) and
**BLASTERS >**, which opens the **Armory** (below). Mid-round the clock turns
coral in the last `HUD.timerUrgentSec` (10) seconds, and a round that beats the
best score standing when it began gets a **NEW BEST** badge (a tie does not).
`HUD.baseHeight` went 0.4 → 0.46 because the two-column title is nearly square.

One catch worth knowing before you retune it: `playFaceTarget` has to stay
`true`. IWSDK's other follow mode pins the panel to head *height* and throws the
vertical offset away, so with it off the panel climbs straight back into your
sight line no matter what `playOffset` says.

### Chill mode and the easel

**CHILL MODE** on the title screen drops the round entirely — no clock, no
robots, no score. An easel appears about 1.4 m in front of you; paint that
canvas and the splats land on a real 1024×768 image, not just a decal. Ambient
music plays for as long as you stay (`CHILL.music: false` turns it off).

**Hold the trigger to spray.** In Chill a held trigger keeps firing whatever
launcher you have out, at `CHILL.sprayCooldownMs` (120) per hand. Outside Chill
only the **BLASTER** auto-fires (`BLASTER.autoFireCooldownMs`, 150); HAND and
WEB want one pull per ball. With both, the shorter cooldown wins.

- **SAVE PAINTING** downloads it as `paintblast-painting-1.png` (Quest Browser
  puts it in the usual downloads folder).
- **NEW CANVAS** wipes the painting. Room splats are untouched — that is what
  **CLEAR PAINT** is for.
- **ROTATE CANVAS** stands the canvas on its short edge and back again
  (0.62 × 0.465 m / 1024×768 px landscape ⇄ 0.465 × 0.62 m / 768×1024 px
  portrait). This **clears the painting**: a browser canvas wipes itself
  whenever its width or height is written, so there is no rotating a picture in
  place. Save first if you want to keep it.
- **Grab the easel with both hands** to move or turn it.
- **EXIT CHILL** goes back to the title screen.

The easel model at `public/gltf/easel.glb` must be an **empty** easel. Round 2's
was generated from a photo of an easel *holding* a canvas, which baked a second,
unpaintable board into the stand right behind the real one. Swapping the file
fixes it — the paintable canvas is always built in code, so the picture keeps
working whatever the art is (and falls back to a primitive frame if the GLB is
missing).

### Buttons that answer you

Every HUD button lights up and swells to `HUD.buttonHoverScale` (1.04) as you
point at it, squashes to `buttonPressScale` (0.93) in a darker press color for
`pressFlashMs` (140 ms) when you click, and plays a tick. Filled pills brighten
12% on hover and darken 18% on press; outline pills bring their accent tint up
from 8% to 24% to 42%; the Armory's skin dots swell more (`skinDotHoverScale`
1.18). Whole sections fade and rise into place over `sectionFadeSec` (0.22 s). There is no separate opacity property in uikit — the alpha rides in the
background color — so all three states are just `rgba()` strings with a bigger
last number. The whole thing is one `wireInteractiveButton` helper in
[`src/systems/HudSystem.ts`](src/systems/HudSystem.ts); a new button gets the
treatment by being wired through it.

### Web ammo

Round 4 shipped webbing as a **mode** you entered from the title screen, which
hid the palette and made everything white. The field report was "I want web mode
AND chill mode — same interactions", plus "still want regular mode". A mode you
have to leave cannot give you that, so round 5 deleted it: **webbing is ammo
now.** Load the **WEB** chip (or the WEB mode pad) on your wrist palette and both
gauntlets switch to web spinneret, wherever you happen to be. Load any paint chip
— or touch any dab — and they go back to the launcher you had before (BLASTER or
HAND).

That means webbing works **everywhere firing works**: the Idle sandbox, mid-round
in a real game (web wall-splats score exactly like paint wall-splats, through the
same event), and in Chill, where you can web the easel and the ambient music
keeps playing. Spray-on-hold is still Chill-only, and it sprays webs there too.

Round 6 added a **WEB MODE button on the title screen**, because "one chip in a
row of five on your own wrist" turned out to be somewhere nobody looks. It is
not a phase — `GamePhase.Web` stays deleted. Pressing it does two things you
could already do by hand: it drops you into **Chill mode** and loads **web
ammo**. Shooters on both wrists, easel in front of you, EXIT CHILL leaves the
way it always did, and touching any paint dab or chip switches ammo the way it
always did. Nothing about it is exclusive, so there is nothing to get stuck in.

**Three ways to fire, and they all do the same thing:**

- **Pull the trigger** (or pinch, on hand tracking). One shot per pull. This
  goes through the ordinary firing path, so it obeys the same cooldown, the same
  spray-on-hold in Chill and the same don't-shoot-the-HUD rule as paint.
- **Finger curl** ("thwip" in the code). Curl your **middle and ring fingers**
  into your palm while your index and pinky stay out. Hand tracking only — it reads your actual finger
  joints. It fires once when you make the shape and re-arms when you release
  it, so holding the pose does not empty the room.
- **Thrust** your hand forward, hard, along the way it is pointing (round 7:
  along the gauntlet's barrel, which on hands was previously the thumb
  direction). Sideways waving and pulling back are ignored on purpose, so
  ordinary arm movement does not set it off. Off while that hand hauls a tether.

Three rather than one because it has to work for whoever picks up the headset:
controllers have no fingers to curl, hand tracking has no trigger, and the
thrust is the one people find by accident.

### The gestures are not a web feature any more

Round 5's thwip and thrust threw **webbing specifically**, which meant they only
worked with the WEB chip loaded. Round 6 makes them fire **whatever is loaded**:
a thwip with red splash paint on throws red splash paint, and a thwip with a
tether web on throws a tether web. They are a second trigger now, not a mode.

Two consequences worth knowing:

- **What you see on your arm is the launcher, not the ammo** (round 8). In
  BLASTER mode a paint thwip, thrust or trigger leaves the barrel on top of your
  wrist; in WEB mode, the spinneret underneath; in HAND mode there is no device
  and paint flies from your bare hand, as it did before round 8.
- **The trigger and the gestures now share a cooldown.** Round 5 kept them
  separate and said so in this file, on the grounds that they were separate
  inputs firing different ammo. Now that a thwip and a trigger pull produce an
  identical ball, keeping them apart was just a way to double your rate of fire
  by doing both at once.

They stay exempt from the don't-shoot-the-HUD rule. A finger curl cannot press a
button, so there is nothing to disambiguate.

If the finger gesture is not firing for you, `WEB.curlThreshold` (7 cm) and
`WEB.extendThreshold` (13 cm) are fingertip-to-wrist distances — widen the gap
between them to be stricter, narrow it to be more forgiving. `WEB.thrustSpeed`
(1.7 m/s) is the thrust, and lowering it makes it twitchier, not better.
`WEB.gestureEnabled: false` turns the finger gesture off entirely and leaves the
other two.

Webs are their own paint: a **second** decal pool (`WEB.splatCapacity`, 192)
with its own mask at `public/textures/web-splat.png`, so webbing never pushes
your paint out of the room and vice versa. On the easel canvas the same mask is
stamped in `EASEL.webStampColor` near-white, so web art works there too.
**CLEAR PAINT clears both** — it is the one "undo the mess" button and it would
be a strange button that only removed half the mess.

Strands are pooled eight deep (`WEB.strandPool`). Each one stretches from your
nozzle to its ball every frame while the ball flies, freezes at the splat, then
fades over `WEB.strandLingerSec` (0.6 s). Fire faster than the pool can drain
and the oldest strand retires early. Every web ball gets one however it was
thrown — the strand pool watches balls appear rather than being asked for one.

### TETHER WEB

Web ammo has **two sub-modes**, and the second one is round 6's headline. A
**splat** web is the round-5 web: it flies, it lands, it paints. A **tether**
web latches onto a robot so you can haul it in and pop it in your face.

**Choosing.** A small holo gadget sits on the palm side of your **left** gauntlet,
visible only while web ammo is loaded — a round pad wearing the web mask
(splat) and a cyan hook (tether). The selected one swells and lights up. Poke
it, squeeze near it, or press **B on the right controller**. The HUD footer
says `WEB` or `TETHER` so you can check without looking at your arm.

**Attaching.** Fire at a robot during a round. In the air a tether is
indistinguishable from a splat web — same white ball, same arc, same strand —
and if it misses it leaves an ordinary web decal on the wall. There are no dud
shots. Hit a robot, though, and instead of damaging it the line **latches**: the
robot stops bobbing, stops turning, and hangs there on a thread from your wrist.

**Reeling (round 7).** Round 6 hauled the robot in fixed 0.55 m jumps on a fast
yank — it *teleported* each chunk, which is what "the hook feels janky" meant.
Now every way of hauling adds line to a per-hand **queue**, and the robot
**glides** along the line at up to `WEB.reelGlideSpeed` (4.5 m/s). Three ways
to haul, all live at once:

- **PULL.** Move your hand away from the robot. Line comes in in proportion:
  speed past `WEB.pullDeadband` (0.2 m/s, tracking noise) × `WEB.pullGain`
  (2.2). A 30 cm haul brings it about 65 cm. Pushing back toward the robot takes
  in nothing, so hand-over-hand hauling just works.
- **PINCH or TRIGGER held** on the hand that owns the line, at `WEB.reelSpeed`
  (1.8 m/s). That hand **stops firing** while it holds a tether — the press
  that used to shoot (and break the line) reels instead. This is the
  hand-tracking player's "hold to reel", which round 6 did not have.
- **SQUEEZE held** (controllers), same speed.

A *tap* (released within `WEB.releaseTapMs`) lets go instead — see below.

`WEB.reelQueueMax` (1.2 m) caps how far it keeps gliding after you stop; a
light haptic tick fires at most every `WEB.reelFeedbackMs` (110 ms). A tether
web also latches from `WEB.tetherLatchBonus` (12 cm) further out than paint
hits, and a hooked robot **struggles** (`tetherStruggleRad` / `tetherStruggleHz`).
The thrust gesture is off on a hauling hand (the recovery stroke of a haul
looked like a punch); the finger-curl gesture still fires, and is the
deliberate "let go".

**Popping.** When the robot gets within `WEB.tetherKillRadius` (0.7 m) **of your
head** it pops — normal score, normal combo, normal pop sound, plus the hardest
rumble in the game. Measured off the head rather than the hand so an arm held
out at full stretch does not pop things across the room.

**Letting go.** **Tap** — a pinch or trigger on the tethered hand, released
within `WEB.releaseTapMs` (250 ms) — lets go; holding the same press reels. The
line also ends without a pop when `WEB.tetherMaxSec` (8 s, paused while the game
is paused) runs out, that hand fires a gesture shot, you switch off web ammo,
the round ends, or somebody shoots the robot off the end of it. The strand
fades out rather than blinking away.

Outside a round there are no robots, so a tether shot is just a web. That falls
out of the wall rule rather than being a special case.

One ergonomic note: holding the squeeze is how you reel, and squeezing near your
wrist is also how you pick ammo. While a hand is holding a line, that hand's
proximity-select is suppressed — otherwise starting a reel next to the palette
would change your loadout.

### The forearm gauntlet (round 7)

Field report, round 7: *"they're perpendicular to the wrist instead of parallel
and aligned with the forearm, so they actually shoot properly in the right
direction."* The cause was not a bad knob. Rounds 4-6 posed the shooter, the
gesture aim and the palette off the raw WebXR **grip** space, assuming its −Z was
"where the hand points". For a **tracked hand** the spec defines grip −Z as
*toward the thumb* — across the wrist. So the cuff sat across the arm and a
gesture web flew out sideways, whatever the mount angles said.

Round 7 builds the frames explicitly (`src/wrist-pose.ts`): the **wrist joint**
for hands (−Z toward the fingers, +Y out of the back of the hand), the
**target ray** plus the mirrored grip X for controllers. The shooter is now a
code-built **gauntlet authored along the direction webs fly**: straps round the
forearm, a graphite body on the palm side, a glowing cartridge (white = splat,
sky = tether) and a nozzle at the wrist crease. What you see is where it shoots,
by construction — webs fire along the *shown* barrel.

Round 8 moved all of this into **GauntletSystem**, which now poses both arms
for every launcher; the web device is the **spinneret** under the bracer, and
these `WEB.shooter*` knobs still place it.

| Knob | Ships as | What it does |
|---|---|---|
| `WEB.handAimSource` | `'ray'` | Tracked-hand aim: the OS pointer ray (steady, same ray the pinch fires along) or `'hand'` (exactly where the back of your hand points; a bent-back wrist aims high). Controllers always use their ray. |
| `WEB.rayBlendNearDeg` / `FarDeg` | 30 / 65 | With `'ray'`: within 30° of the hand's own axis the ray is used outright; past 65° (hand turned up to look at it) the hand's axis takes over, so the gauntlet never peels off your arm. Smoothstep between. |
| `WEB.shooterSmoothingSec` | 0.03 | Pose smoothing. Kills hand-tracking shimmer; above ~0.06 the barrel trails your arm. |
| `WEB.shooterOffsetY` | −0.034 | Negative = palm side of the forearm. |
| `WEB.shooterOffsetZ` | +0.05 | Positive = up the forearm from the wrist joint. |
| `WEB.shooterLengthMeters` / `BandMeters` | 0.11 / 0.075 | Gauntlet length and the forearm diameter the straps wrap. |
| `WEB.muzzleLocal` | [0, 0, −0.082] | The spinneret's needle tip, on the barrel axis. Spawn point and strand start. |
| `WEB.controllerWristBack` | 0.07 | Controllers have no wrist joint: how far behind the grip the wrist is assumed. |
| `WEB.shooterUseGlb` + yaw/pitch/roll | false, 0/0/0 | Swap in a modelled gauntlet. Author it long axis = model −Z, nozzle at −Z, back of hand +Y; the three angles fix an exporter's axes. The old ring-cuff GLB cannot lie along a forearm and is no longer loaded. |

Everything X-ish is still declared in the **right** hand's frame and mirrored
for the left (yaw and roll flip, pitch does not).

**Webs zip now.** `WEB.webGravityFactor` (0.35) makes a web read as a line, not
a lob; `WEB.webSpeedMult` (1.15 × paint speed) adds a little pace. Do not push
the speed past ~1.15: with no continuous collision detection, anything covering
more than 14 cm per frame starts passing through 6 cm walls (a test pins it).

**Tracking dropouts.** A hand that vanishes and reappears more than
`WEB.reacquireJumpMeters` (30 cm) away in one frame is treated as a new hand —
no fake thrust, no phantom haul, and the gauntlet snaps rather than gliding.

### Aim assist (round 7)

A shot within `FIRE.aimAssistDeg` (4°, paint) or `WEB.aimAssistDeg` (9°, webs)
of a live robot is bent onto the ballistic arc that hits it. "Within" is
measured against whichever is closer — the straight line to the robot or the
arc — because paint drops ~12° over three metres, and both the newcomer who
points straight at it and the regular who leads the drop deserve the hit. Only
live robots during a round attract; walls, the easel and the floor never do.
`FIRE.aimAssistMaxRange` (6 m) ignores anything further. 0 disables either.
Robot hits are also **swept** along each ball's last-frame path, so a fast web
cannot step through a robot on a slow frame.

### The wrist palette on bare hands (round 7)

Controllers keep the tuned grip-frame mount (the four `wristOffset*` knobs and
`tiltDeg`). On **hands** the palette is posed in world terms: it floats
`PALETTE.handLift` (8 cm since round 8, so it clears the gauntlet) straight up from the wrist joint, `handForward`
(11 cm) out over the hand and `handOutward` (3 cm) away from your body — so it
never covers the gauntlet's pads — and turns to **face your eyes**, dab edge
toward your fingers, in any wrist roll.

It also **holds still while you poke it**: when your right index fingertip comes
within `PALETTE.lockRadius` (16 cm) the board parks in world space, and rejoins
the wrist `lockReleaseSec` (0.35 s) after the finger leaves, gliding back over
`reattachSec`. If your left hand drops out of tracking while it is parked, the
lock still releases on schedule rather than pinning the board in mid-air. A **pinch** within `PALETTE.pinchSelectRadius` (4.5 cm) of a dab,
chip or pad selects it — and that pinch never also fires a ball.

The palette GLB is a slab authored thin along Z; the loader now lays its
thinnest axis flat (it had stood on edge against its own dabs since round 3).

### Pause, and playing seated (round 7)

Open the Quest menu (or lose focus any other way) mid-round and everything
freezes — timer, countdown, combo window, robots, tethers, strands — with a
PAUSED pill; it resumes exactly where it was. A frame longer than
`GAME.pauseGapSec` (0.5 s) counts as a pause even if the browser never said so.
`GAME.pausedStatusText` is the copy.

Robots spawn in a **forward arc**, `TARGETS.spawnArcDeg` (150°) wide, centred on
where you faced when the round started — nobody has to turn round in their
seat. 360 restores the old full ring. Round 8 also caps spawn height at
`TARGETS.heightMax` **1.7 m** (was 2.0): the nearest ring then sits within ~23°
above a seated eye line, inside the comfortable ±30° band.

### Rendering and particles (round 7)

`RENDER` is the look: an image-based light (`iblSource: 'room'`,
`iblIntensity`) that only lights — nothing is drawn over passthrough — and
`toneMapping: 'neutral'` (Khronos PBR Neutral keeps paint saturated; ACES and
AgX washed it out). Balls are clearcoat wet paint (`ballRoughness`,
`ballClearcoat`; 0 falls back to the cheaper standard material and avoids the
one-off first-shot shader compile). Robots get a cool rim (`robotRim*`).
There is **no depth occlusion**: real furniture never hides virtual objects, so
a hiding Peekaboo can be seen through your couch.

`VFX` is the juice: one pooled 256-particle draw call — confetti on a pop,
droplets on an impact, spray on a hit, sparks when a tether catches, a muzzle
puff (set `VFX.muzzle.count = 0` if it reads as clutter by your hands).

Palette colours are **sRGB** — the same values the HUD swatch shows. Until round
7 they reached the 3D scene as linear values and rendered pastel; balls, splats,
dabs and confetti now match the swatch.

### There is always a floor

Everything a paintball can hit used to come from scene understanding — the
walls, furniture and floor your headset has scanned. Which meant that in a room
that had **never** been scanned there was nothing to hit at all: balls flew
through the world, never splatted, and quietly died at the kill floor. That is
the "shooting into thin air" report from round 3.

There is now one invisible static slab under you at all times, 30 m across, its
top face a millimetre below the floor. Paint always has somewhere to land. A
real floor plane arriving later just sits a millimetre above it and takes the
contact instead, so scanning your room still improves things — it is no longer
the difference between the game working and not.

It is deliberately half a metre thick rather than a sheet: Havok gets one
discrete step per frame with no continuous collision detection, and a ball at
muzzle velocity covers ~12 cm between steps.

### Room scanning, and why paint would not stick to your walls

**Guardian is not a room scan.** That one sentence is the whole of the
three-round "still no wall splats" bug. You draw a Guardian boundary, you can
see it, and you reasonably assume the headset now knows where your walls are.
It does not. The planes and meshes this game turns into colliders come from
**Space Setup** — the saved room scan behind *Settings → Boundary → Mixed
Reality* — which is a different thing you may never have run. In a room that was
never set up, WebXR hands the app an empty list, with no error and nothing to
react to, and the only thing paint can land on is the invisible backstop floor.
A floor, and no walls.

Round 2 handled that by calling `initiateRoomCapture()` off a timer, and round 3
field feedback killed it: it fought the headset's own flow and made the barriers
weird. Round 4 removed the call entirely — which fixed the fighting and left an
unscanned room with **no route at all** to ever getting walls.

Round 5 splits the difference. **Nothing fires automatically.** The app counts:
after `ROOM.scanCheckDelaySec` (6 s) of immersive session, if not one plane or
mesh has turned up, the title screen grows an amber notice —

> No room scan found - paint has no walls to stick to    **[SCAN ROOM]**

— and pressing that button is the only thing that ever calls
`XRSession.initiateRoomCapture()`. That matches what Meta's own Browser docs
advise: call it "when you are sure that there are no planes", after waiting "2
to 3 seconds", and note that it "can only be called once per session". Their
scene guidance is to *suggest* a capture, not to drag the player into one.

Three things can come back, and the notice says which:

- capture started → *"Space Setup requested - finish it, then come back"*
- no such API (an older browser, a non-Quest runtime, the desktop emulator) →
  *"Run Space Setup in Quest Settings, then reopen"*
- already asked once this session → the same "requested" line, because a second
  call genuinely cannot work.

The notice disappears the moment any plane or mesh shows up, including long
afterwards, so walking out to run Space Setup and coming back clears it without
a reload. It only ever appears on the title screen: mid-round it would be an
amber strip you cannot act on, and the button drops you out of the session.

`planeDetection` / `meshDetection` stay on in `xr.features` (both map to WebXR
*optionalFeatures*, so an unscanned room reports nothing rather than failing the
session), and FloorGuardSystem means paint has a floor either way.

### Why paint kept going *through* your walls

Field report after round 5, and this is the one that finally has a mechanism
rather than a theory: wall collision was **weak**. Not absent — weak. Paint
stuck to walls *sometimes*. That "sometimes" is the whole diagnosis. Two
separate causes, both found by reading what IWSDK actually builds:

**1. Wall colliders were one millimetre thick.** IWSDK visualises every detected
plane as `BoxGeometry(width, 0.001, height)`, and `PhysicsShapeType.Auto`
faithfully turns that into a one-millimetre Havok box. Havok is stepped once per
frame with no continuous collision detection, so a ball at muzzle velocity
*teleports* about 12 cm per step at 72 Hz. It only registers the wall if a step
happens to land within (its own radius + half the wall's thickness) of it —
about 8 cm of a 12 cm stride, so roughly a third of shots went straight through,
and more at oblique angles.

This is the same bug the invisible backstop floor was built to dodge, applied to
the walls it was never applied to. Vertical planes now get an explicit box
`ROOM.wallThicknessMeters` (6 cm) deep, which widens the capture band to 14 cm —
wider than one stride, so no ordinary shot can miss. Floors and ceilings stay on
`Auto`: the floor already has half a metre of backstop slab a millimetre under
it, and thickening it would lift every floor splat 3 cm off the carpet. The
trade-off on walls is exactly that: the collider grows symmetrically, so paint
lands 3 cm proud of the wall you see. Under a ball's own radius, and invisible
in passthrough. Push the number past ~0.12 and the paint starts to float.

**2. The whole-room mesh was being thrown away.** Quest's Space Setup produces
one unbounded `XRMesh` — the **global mesh** — covering the entire room: floor,
walls, furniture, the lot. Round 5 skipped it, and skipping it was not really a
decision, because it has no label to match on. IWSDK recognises `'global mesh'`
itself and then adds the component *without copying the label across*, so from
the app's side its `semanticLabel` is the empty string. Any app matching on the
label matches nothing, forever, silently. The flag that survives is
`isBounded3D === false`, and that is what the game now tests.

It becomes a static **TriMesh**, which is what Meta's own scene guidance
advocates the scene mesh for — "Fast Collisions", projectiles, bouncing balls.
`Auto` would have been actively harmful here, and it is the default: it maps a
generic BufferGeometry to **ConvexHull**, so the room would have become one
solid convex blob with the player, the robots and every ball sealed inside it.

**And the furniture list was wrong.** WebXR's semantic labels are a *different,
shorter* vocabulary than the native Meta one — Space Setup's `STORAGE` arrives
as `shelf`, `WALL_FACE` as `wall`, `CHAIR` as `couch`. Round 5's set was
`{table, couch, chair, other}`: `chair` is a string Quest can never send (it is
not in the registry at all, and Meta's own IWSDK example has the same dead
branch), while `desk`, `shelf`, `bed`, `screen`, `lamp` and `plant` were all
missing. `wall`, `floor` and `ceiling` are still deliberately absent — in a real
capture those carry only a 2D bound, so they arrive as planes and can never show
up in the mesh list.

**The diagnostic line.** Every wall report so far has had to be debugged by
inference, because the one fact that settles it — what the headset actually
handed over — is invisible from inside the headset. Three seconds into a
session the console now prints:

```
[PaintBlast] room colliders: 17 planes, 9 meshes (labels: couch, global mesh, lamp, shelf, table)
```

That is a real line from the emulator's living room, and it is also the
evidence for the paragraph above: `global mesh`, `lamp` and `shelf` are three
colliders round 5 silently did not create. If walls are still not catching
paint on your device, this line is the first thing to send.

### Robots that stay in your room

Spawn positions are probed against the walls and furniture your headset has
scanned, and pulled back in front of anything they would have spawned through.
If your room has never been scanned there is nothing to probe, and the ring
behaves as it always did. `ROOM` holds both knobs.

### Swapping a Splotbot

Each character's art is the GLB at `SPLOTBOTS.archetypes.<bot>.url` (Pip's at
`SPLOTBOTS.pip.url`), under `public/gltf/splotbots/`. Drop a new file at that
path: TargetSystem measures it and rescales it to `heightMeters`, and swaps it in
at the next Countdown (PipSystem does the same for Pip, to `sizeMeters`). If the
face points the wrong way, set `yawOffsetDeg` (0 if the model faces +Z, 180 if
−Z, ±90 if sideways). Until a GLB has streamed — or if one is missing — a bot
wears `public/gltf/robot/robot.gltf`, the old robot, at the character's size,
and Pip a small code-built drone. Animation is all procedural, so an unrigged mesh
is fine.

### Swapping the splat look

`public/textures/splat.png` is a white-on-black mask (used as an alphaMap and
tinted per-splat by ball color). Replace it with any white-on-black silhouette.
Delete it and the game falls back to clean flat discs.

`public/textures/web-splat.png` is the same idea for webbing, and the same
rules apply — white-on-black, and a missing file degrades to discs rather than
to nothing. It is used twice: as the alphaMap for room web decals, and as the
stamp mask for webbing that lands on the easel canvas.

## How the game is wired (30-second tour)

One system per file in `src/systems/`, data flows through signals + a per-frame
event buffer in `world.globals`:

- **WorldCollisionSystem** (5) — turns scanned planes, furniture and the global room mesh into static colliders, and prints the census line
- **FloorGuardSystem** (6) — lays the one invisible backstop floor collider, once, at startup
- **SceneScanSystem** (7) — counts detected planes and meshes; raises `sceneScanMissing` when a room turns out never to have been scanned, and owns the one user-pressed call to `initiateRoomCapture()`
- **WristPaletteSystem** (8) — poses the palette on the left hand (grip for controllers, wrist joint facing your eyes for hands), parks it under a poking finger, pops it in on tracking and hides it on loss, and animates the holo board
- **GauntletSystem** (9) — both arms' poses, the gauntlet hardware for HAND / BLASTER / WEB, deploy/stow, skins, recoil, and where each arm's shots leave from this frame
- **WebShooterSystem** (10) — the two gesture triggers (finger curl / thrust), the web sub-mode pads, the pooled strands, and the per-hand tether line
- **BallSpawnSystem** (11) — the one place a ball is launched from (trigger, thwip or thrust), out of the gauntlet's barrel or the bare hand; auto-fire in BLASTER, spray in Chill; dabs set the color, chips the kind and style, mode pads the launcher, selector pads the web sub-mode
- **BallFlightSystem** (12) — detects impacts from velocity deltas (IWSDK exposes no collision events), applies per-kind behavior, paints splats or webs, and dissolves settled balls into paint
- **TargetSystem** (14) — the Splotbot pool, the wave director and lanes, Squeegee's shield, Peekaboo's hiding, Duster Duke, swept hits, pops, and the whole tether lease
- **SplatterSystem** (15) — two InstancedMeshes and two ring-buffer decal pools, one for paint and one for webbing
- **EaselSystem** (16) — the chill-mode easel; stamps impacts onto a real 2D canvas with the paint or the web mask, rotates it, and exports it
- **GameStateSystem** (30) — Idle → Countdown → Playing → GameOver (plus Idle ⇄ Chill), timer, score (each bot's own points × combo), best score (localStorage), pause
- **HudSystem** (35) — signals → panel text/sections, the Armory, phase-docked panel placement, button animation; PLAY / CHILL MODE / WEB MODE / BLASTERS / PLAY AGAIN / SCAN ROOM / CLEAR PAINT / SAVE PAINTING / NEW CANVAS / ROTATE CANVAS / EXIT CHILL and the Armory's cards, arrows, dots, BACK and PLAY
- **FeedbackSystem** (36) — events → sound + rumble (a web plays the thwip and web hit, paint the trigger and splat; mode swap, shield ping, boss entrance). Plus the Chill ambient loop
- **VfxSystem** (37) — events → pooled particle bursts (confetti, droplets, sparks, shield sparks)
- **IntroSystem** (38) — the enter-AR logo intro
- **PipSystem** (39) — Pip the mascot
- **EventFlushSystem** (90) — clears the event buffer each frame

Design + rationale: [`docs/superpowers/specs/2026-08-16-paintblast-v2-design.md`](docs/superpowers/specs/2026-08-16-paintblast-v2-design.md)

## Quality gates (run before shipping changes)

```bash
npx tsc --noEmit
```

```bash
npm test
```

## Launching on Quest (the QR flow)

**Play the deployed build (easiest):**

```bash
npm run qr
```

Scan the terminal QR with your Quest (just look at it in passthrough and tap the
"Open link" pill), then press **Enter AR** in Quest Browser.

**Ship a new build, then get the QR:**

```bash
npm run launch
```

**Play against your dev server (same Wi-Fi, live reload):**

```bash
npm run qr:dev
```

Quest Browser will warn once about the self-signed local certificate — choose
Advanced → Proceed.

Production URL: **https://paintblast-mr.netlify.app**

## Known trade-offs

- Palette dabs and chips respond to a fingertip poke or a squeeze/pinch (reach
  toward them), not to a ray click — matching how you naturally pick paint off a
  wrist palette.
- Because the palette is always within poke range of your *own* left fingertip,
  IWSDK's touch pointer stays latched onto it on that side. Hand-tracking pinch
  is routed straight to the grab pointer and is unaffected, but a **left
  controller** squeeze near the palette is swallowed. Grab the easel with hands,
  or with your right hand leading.
- Voice commands from the original design were cut deliberately (mic permission +
  Web Speech reliability on Quest); the CLEAR PAINT button covers the main use.
- Room splats persist per-session only (the splat field is XR-anchored, but not
  saved). Easel paintings survive as PNGs, if you press SAVE PAINTING.
- Only the easel's canvas has a collider, not its legs — paintballs fly straight
  through the frame.
- The THWIP finger gesture needs hand tracking. On controllers the trigger and
  the thrust are the two you get, which is why there are three.
- The trigger and the gesture triggers now share one per-hand cooldown, which
  reverses round 5. They fire identical ammo since round 6, so separate
  cooldowns had stopped being a principled distinction and started being a way
  to fire twice as fast by pulling and thwipping together.
- The web chip loads webbing but leaves your paint choice untouched underneath.
  That is deliberate — picking any paint chip hands the old loadout straight
  back — but it does mean the footer says WEB while a color is still selected.
- The sub-mode selector is on the **left** wrist only, and there is one of it
  rather than one per hand. It is a setting, and two of them would raise the
  question of what happens when they disagree.
- A tethered robot still counts as alive and is still shootable. Shoot the one
  on your own line and it pops normally; the line just goes slack.
- One hand can hold one line. Firing again with that hand lets go of it, which
  also means you cannot tether two robots with one arm.
- Web splats and tether shots score identically to paint, through the same
  BallImpact event. That is the point of the style being a bit rather than a
  separate pipeline.
- SCAN ROOM can only fire once per session, because that is what Quest Browser
  allows. Press it, cancel Space Setup, and the button will not work again until
  you reopen the page; the notice says so rather than failing silently.
- The SCAN ROOM notice cannot be exercised in the desktop emulator: IWER's
  living-room environment always supplies planes, so `sceneScanMissing` never
  goes true there and `initiateRoomCapture` does not exist to call.
- ROTATE CANVAS resizes the canvas but leaves the primitive fallback frame at
  its landscape proportions. The shipping easel is the GLB, which is decorative
  and unaffected either way.
- Robot spawns are clamped against detected planes and meshes. In a room that
  has never been scanned there is nothing to clamp against, so the ring behaves
  exactly as it did before; scan the room to get the fix.
- The backstop floor is a floor, not a room. Without a scan there are still no
  walls, so a shot fired horizontally flies off into the distance and is culled
  on its lifetime. Paint that lands, lands.
- Thickened wall colliders bulge half their thickness into the room, so paint on
  a wall sits ~3 cm proud of it. That is under a ball's own radius and reads as
  contact in passthrough; it is the price of not tunnelling, and
  `ROOM.wallThicknessMeters` is the dial if your walls read differently.
- Peekaboo hides behind your real furniture, but the game has no depth
  occlusion, so you can see it through the couch while it is "hidden". It cannot
  be hit until it peeks, so this is a look problem, not a fairness one.
- Pip and the Splotbots are unrigged meshes animated in code (bob, sway,
  squash, spin) — there are no skeletal animations.
- Meta's guidance warns that the global mesh has unreliable surface normals and
  is meant for *fast* collisions rather than resting contacts. Paintballs are
  fast and dissolve into paint shortly after settling, so this suits us — but a
  ball that comes to rest against scanned geometry can sit a centimetre or two
  off where the wall looks.
