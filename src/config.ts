// Every gameplay tunable in PaintBlast-MR lives in this file.
//
// Pure data on purpose: no IWSDK imports, so unit tests can assert on these
// values without a live World, and so a designer can retune the game without
// reading a single system. Each knob is commented with what it actually
// changes in play, not with what its name already says.

import { BallKind } from './types';

/**
 * Paint ball lifecycle. The two cull rules (lifetime + kill floor) exist
 * because Havok has no "went out of bounds" callback — balls that miss the
 * room entirely would otherwise fall forever and stay in the live-ball count.
 */
export const BALLS = {
  /** Render + collision radius, metres. Also the shared SphereGeometry radius. */
  radius: 0.04,
  /** Hard population cap. Spawning past it culls the oldest ball first. */
  maxLive: 20,
  /** Seconds a ball may exist before it is culled regardless of what it is doing. */
  lifetimeSec: 15,
  /** Balls whose world Y drops below this have escaped the room; cull them. */
  killFloorY: -2,
  /** Seconds a Sticky ball stays welded to the surface it hit before vanishing. */
  stickyLifetimeSec: 10,
} as const;

/**
 * Trigger/pinch firing. Fire direction is the pointing ray's forward axis, so
 * these values are what separate "flick shot" from "lob".
 */
export const FIRE = {
  /**
   * Muzzle velocity, m/s, applied via PhysicsManipulation.linearVelocity.
   * At 6 a ball dropped ~0.5 m over a 2 m shot — too floaty to aim. 8.5 keeps
   * a visible arc (~0.27 m drop at 2 m) without turning shots into hitscan.
   */
  speed: 8.5,
  /** Minimum milliseconds between shots, tracked per hand. */
  cooldownMs: 220,
  /** Metres along the ray to offset the spawn point, so the ball clears the hand. */
  muzzleOffset: 0.08,
  /** Allow firing in the Idle phase so the room can be painted outside a round. */
  sandboxFireInIdle: true,
  /**
   * A hand whose ray crosses a UI panel within this many metres is clicking,
   * not shooting — its trigger pull is swallowed (see BallSpawnSystem).
   */
  uiBlockMaxDistance: 3,
} as const;

/**
 * Impact detection thresholds. IWSDK's PhysicsSystem exposes no collision
 * events, so an impact is inferred from the per-frame velocity delta that
 * Havok writes back into PhysicsBody._linearVelocity.
 *
 * armSpeed guards against a ball that is merely resting or being nudged
 * registering a hit; impactDeltaV is the jolt size that counts as a contact.
 *
 * Round 3 softened both. Field feedback: gently lobbed paint landed on the
 * canvas or the floor and just sat there as a bubble, because a slow contact
 * never crossed the old thresholds. Lower gates catch those soft landings as
 * real hits — and anything that still slips through now dissolves into paint
 * when it comes to rest (see BallFlightSystem), so no ball ever stays inert.
 */
export const IMPACT = {
  /**
   * Previous-frame speed (m/s) a ball must exceed before impacts can register.
   * Must stay above restSpeed or a settled ball would re-arm itself forever.
   */
  armSpeed: 0.55,
  /** Magnitude of |v - vPrev| (m/s) that counts as hitting something. */
  impactDeltaV: 0.8,
  /** Speed (m/s) below which a ball is a candidate for "come to rest". */
  restSpeed: 0.15,
  /** Consecutive sub-restSpeed frames before a ball stops being impact-tested. */
  restFrames: 20,
} as const;

/**
 * Splat decals. Jitter, roll and normal offset exist purely so the wall does
 * not read as a grid of identical flat circles.
 */
export const SPLAT = {
  /** Instanced decal pool size. Splat 513 recycles slot 0. */
  capacity: 512,
  /** Radius (metres) of the decal geometry; per-splat scale multiplies this. */
  baseRadius: 0.08,
  /** Lower bound of the random per-splat size multiplier. */
  sizeJitterMin: 0.55,
  /** Upper bound of the random per-splat size multiplier. */
  sizeJitterMax: 1.4,
  /** Minimum lift off the surface, metres — prevents z-fighting with the wall. */
  normalOffsetMin: 0.002,
  /** Maximum lift off the surface, metres. */
  normalOffsetMax: 0.004,
  /** Radius (metres) of the ring of satellite splats a Splash ball throws. */
  splashRadius: 0.3,
  /** Number of satellite splats in that ring. */
  splashCount: 8,
} as const;

/** Per-ball-kind physics + paint behaviour. @see BALL_KIND_CONFIG */
export interface BallKindConfig {
  /** PhysicsShape.restitution — 0 dead, 1 perfectly elastic. */
  restitution: number;
  /** PhysicsBody.linearDamping — air drag; higher drops the arc faster. */
  linearDamping: number;
  /** Multiplier on the splat decal size this kind paints. */
  splatSizeMult: number;
  /** Impacts survived before despawn. 0 = splat and die on first contact. */
  maxBounces: number;
}

/**
 * The kind table. Every BallKind must appear here — BallFlightSystem indexes
 * it directly and config.test.ts asserts completeness.
 */
export const BALL_KIND_CONFIG: Readonly<Record<BallKind, BallKindConfig>> = {
  // Workhorse: one splat, gone.
  [BallKind.Normal]: {
    restitution: 0.2,
    linearDamping: 0.02,
    splatSizeMult: 1.0,
    maxBounces: 0,
  },
  // Ricochet ball: paints every surface it touches on the way through a room.
  [BallKind.Bouncy]: {
    restitution: 0.85,
    linearDamping: 0.01,
    splatSizeMult: 0.8,
    maxBounces: 3,
  },
  // Welds itself to whatever it hits; physics components are stripped on impact.
  [BallKind.Sticky]: {
    restitution: 0.0,
    linearDamping: 0.05,
    splatSizeMult: 1.15,
    maxBounces: 0,
  },
  // Bursts into a centre splat plus SPLAT.splashCount satellites.
  [BallKind.Splash]: {
    restitution: 0.1,
    linearDamping: 0.02,
    splatSizeMult: 1.0,
    maxBounces: 0,
  },
};

/**
 * Round structure and scoring. Consumed by Wave B's GameStateSystem; defined
 * here so the whole tuning surface stays in one file.
 */
export const GAME = {
  /** Seconds of "get ready" before Playing starts. */
  countdownSec: 3,
  /** Length of a round, seconds. */
  roundSec: 90,
  /** Seconds the game-over summary stays up before returning to Idle. */
  gameOverSec: 8,
  /** Seconds after a hit during which the next hit extends the combo. */
  comboWindowSec: 3,
  /** Combo multiplier ceiling. */
  comboCap: 5,
  /** Base points for popping a target, before the combo multiplier. */
  scoreTargetHit: 100,
  /** Points for painting the room (per splat) — rewards decorating, not just aim. */
  scoreWallSplat: 5,
} as const;

/**
 * Target (robot) spawning and motion. Consumed by Wave B's TargetSystem.
 * The ring is centred on the player, so radii are "arm's length" to
 * "across a small room".
 */
export const TARGETS = {
  /** Inner spawn-ring radius, metres. */
  ringMinR: 1.2,
  /** Outer spawn-ring radius, metres. */
  ringMaxR: 3.0,
  /** Lowest spawn height, metres above the floor. */
  heightMin: 0.7,
  /** Highest spawn height, metres above the floor. */
  heightMax: 2.0,
  /**
   * Finished robot height, metres. robot.gltf is authored in centimetre-ish
   * units (~53 × 68 × 35), so TargetSystem measures the model and rescales it
   * to this — retexturing or swapping the art never needs a code change.
   */
  heightMeters: 0.35,
  /** Floor under the derived hit sphere, metres — keeps small art hittable. */
  hitRadiusMin: 0.12,
  /**
   * How far a robot may wander off its evenly spaced ring angle, as a fraction
   * of one slice. 0 = perfectly regular ring, 1 = slices may touch.
   */
  spawnAngleJitter: 0.4,
  /** Pooled robot instances allocated up front and reused. */
  poolSize: 8,
  /** How many robots may be alive at once. */
  maxConcurrent: 4,
  /** Hits required to pop a robot. */
  baseHp: 1,
  /** Seconds between a pop and the next spawn taking its slot. */
  respawnDelaySec: 1.5,
  /** Vertical hover amplitude, metres. */
  bobAmplitude: 0.08,
  /** Hover cycles per second. */
  bobHz: 0.5,
  /** Yaw drift, degrees per second — keeps robots from looking frozen. */
  turnDegPerSec: 25,
  /**
   * Closest a tethered robot may be reeled to the hand holding the line,
   * metres.
   *
   * Not a gameplay choice so much as a geometry one: the reel target is the
   * grip, and without a floor the robot would be pulled *through* the player's
   * own hand and out the other side, where the pop test (measured off the head)
   * would still not have fired. 30 cm keeps it in front of the fist.
   */
  tetherMinReach: 0.3,
  /** Seconds a non-lethal hit keeps the robot puffed up. */
  hitFlashSec: 0.12,
  /** Peak scale multiplier at the instant of a non-lethal hit. */
  hitFlashScale: 1.18,
  /** Seconds the shrink-to-nothing pop animation takes. */
  popDurationSec: 0.15,
} as const;

/**
 * Where the HUD panel sits, per phase.
 *
 * Two placements: a **menu** one, parked comfortably in front of your face for
 * reading and clicking, and a **play** one that ducks the panel below the aim
 * line so it stops eating shots (field feedback: the head-locked panel was
 * physically blocking paintballs).
 *
 * `*FaceTarget` picks the Follower behaviour, and it is load-bearing rather
 * than cosmetic: `FollowBehavior.PivotY` pins the panel to head *height* and
 * throws the Y offset away, so a low dock only works with face-target
 * following. Face-target also keeps the panel at the bottom of your view
 * wherever you look, which is the point of a watch-strip HUD.
 *
 * `maxAngle` is the yaw/pitch slack before the panel re-aims. It has to be
 * bigger than the dock's own downward angle (atan(0.52 / 0.95) ~ 29 degrees)
 * or the panel re-targets every single frame and never settles.
 */
export const HUD = {
  /**
   * Panel size at scale 1.0, metres. PanelUISystem fits the document inside
   * these preserving aspect, and BallSpawnSystem's "am I clicking the menu?"
   * test uses the same rectangle, so shrinking the panel shrinks the slice of
   * the room it can swallow a shot in.
   *
   * Note this is deliberately NOT an object3D scale: PanelUISystem divides its
   * targets by the entity's world scale every frame, so scaling the object
   * would be compensated away and change nothing on screen.
   */
  baseWidth: 0.55,
  baseHeight: 0.4,

  /** Offset from the head, metres, in Idle / Countdown / GameOver. */
  menuOffset: [0, -0.02, -1.05],
  /** Size multiplier on baseWidth/baseHeight for the menu placement. */
  menuScale: 1.0,
  /** Metres of slack before the panel catches up, menu placement. */
  menuTolerance: 0.15,
  /** Lerp speed toward the menu placement — higher is snappier. */
  menuSpeed: 6,
  /** Degrees of look-away before the menu panel re-aims. */
  menuMaxAngle: 25,
  /** Level billboard: comfortable to read, ignores the Y offset (see above). */
  menuFaceTarget: false,

  /** Offset from the head, metres, in Playing / Chill. Below the sight line. */
  playOffset: [0, -0.52, -0.95],
  /** Size multiplier while playing — smaller footprint, less occlusion. */
  playScale: 0.75,
  /** Metres of slack while playing — loose, so the panel drifts rather than chases. */
  playTolerance: 0.35,
  /** Lerp speed while playing — low, so it lags behind fast head turns. */
  playSpeed: 3,
  /** Degrees of look-away before the docked panel re-aims. Must exceed ~29. */
  playMaxAngle: 55,
  /** Tilts the docked panel up toward your eyes; required for the low dock. */
  playFaceTarget: true,
} as const;

/**
 * The wrist palette: an actual painter's palette strapped to the left grip.
 *
 * Round 1 seeded sixteen orbs at fixed world coordinates, which put them
 * behind or below half the players who tried it. Round 2 strapped that grid to
 * the wrist. Round 3 threw the grid away: field feedback was "make it look
 * like a real paint palette, and let me just tap a colour". So the board is a
 * flat oval you hold, four glossy **dabs** curve around its outer edge (colour
 * only), and four neutral **chips** sit in a row along the near edge (ammo
 * kind only). Eight pressables instead of sixteen, and each one means one
 * thing.
 *
 * The wrist offsets are in the **left grip's own frame**: +Y is out of the back
 * of the hand (where a watch face sits), -X is thumb-side-away, -Z is the
 * direction the controller points.
 */
export const PALETTE = {
  // ---- Board ---------------------------------------------------------------
  //
  // The board lies flat in the palette root's XZ plane with its face pointing
  // +Y, the way you actually hold a palette. -Z is the far edge (pointing away
  // from you), +Z is the near edge by your wrist.
  /** Board radius, metres, before the oval squash below. */
  boardRadius: 0.11,
  /** Board thickness, metres. A palette is a plank, not a plate. */
  boardThickness: 0.008,
  /** Squash on the board's near-far axis — under 1 turns the disc into an oval. */
  boardOvalScale: 0.85,
  /** Board colour. Warm wood, so the paint on it reads as paint. */
  boardColor: '#8a6a48',
  /** Board roughness — matte, unlike the glossy dabs sitting on it. */
  boardRoughness: 0.6,

  // ---- Paint dabs (colour only) -------------------------------------------
  /** Dab radius, metres, before the flatten below. Big enough to poke. */
  dabRadius: 0.024,
  /** Vertical squash on a dab — a blob of wet paint, not a marble. */
  dabFlatten: 0.4,
  /** Dab material roughness — low is glossy, like paint that has not dried. */
  dabRoughness: 0.15,
  /** Radius of the arc the dabs sit on, metres from the board centre. */
  dabArcRadius: 0.076,
  /** Angle of the first dab on that arc, degrees. 0 points at the far edge. */
  dabArcStartDeg: -72,
  /** Angle of the last dab. The rest are spaced evenly between the two. */
  dabArcEndDeg: 72,

  // ---- Ammo chips (ball kind and paint style) -----------------------------
  //
  // Five of them since round 5: four paint kinds and WEB. Each carries its own
  // identity colour and a floating label — see PALETTE_CHIP_ORDER in types.ts,
  // which is the table, while everything here is the geometry the table is laid
  // out with.
  /** Half-size of a chip, metres. Deliberately smaller than a paint dab. */
  chipRadius: 0.0135,
  /** Chip material roughness — matte, so chips never read as wet paint. */
  chipRoughness: 0.4,
  /** Centre-to-centre spacing along the chip row, metres. */
  chipSpacing: 0.038,
  /** How far toward the board's near (+Z) edge the chip row sits, metres. */
  chipRowOffset: 0.05,
  /** How far a chip floats above the board face, as a fraction of chipRadius. */
  chipLift: 0.55,
  /**
   * Emissive intensity on the selected chip, on top of the 1.3x scale.
   *
   * Deliberately a lift and not a glow: scale alone was ambiguous at a glance
   * on a board this small (which of two nearly-equal blobs is bigger?), while a
   * chip that actually emits light is unmistakable. Push it past ~0.6 and the
   * chip blows out to a white ball in passthrough and loses its identity colour,
   * which defeats the point.
   */
  chipSelectedEmissive: 0.35,

  // ---- Chip labels ---------------------------------------------------------
  //
  // Round 4 shipped silhouettes alone ("the board is far too small to letter").
  // Field feedback said the row was unreadable, so round 5 letters it after all:
  // one tiny plane per chip, lying flat on the board just behind its chip, with
  // a CanvasTexture baked once at startup. Never an entity and never
  // Interactable — a label must not eat the poke aimed at the chip above it.
  /**
   * Label plane width, metres.
   *
   * Must stay under `chipSpacing` or neighbouring labels overlap, which is the
   * one constraint that decides this number: five chips across a 22 cm board
   * leaves 3.8 cm per column and the label has to live inside that.
   */
  chipLabelWidth: 0.036,
  /** Label plane height, metres. Matches the texture's 4:1 aspect. */
  chipLabelHeight: 0.009,
  /**
   * Gap between the chip's near edge and the label's far edge, metres.
   *
   * Tuned in the emulator rather than guessed: the chips stand proud of the
   * board (STICKY's cube is 23 mm on a side), so at a steep viewing angle a
   * tight gap lets the chip occlude its own caption. 5 mm clears it.
   */
  chipLabelGap: 0.005,
  /** Lift off the board face, metres — enough to beat z-fighting, no more. */
  chipLabelLift: 0.0015,
  /** Baked label texture width, pixels. Power of two, read at a hand's length. */
  chipLabelPxW: 256,
  /** Baked label texture height, pixels. */
  chipLabelPxH: 64,

  // ---- Where the whole thing rides ----------------------------------------
  /** Metres left of the left grip (negative = away from the thumb). */
  wristOffsetX: -0.04,
  /** Metres out of the back of the left hand. */
  wristOffsetY: 0.11,
  /** Metres along the controller's pointing axis (negative = forward). */
  wristOffsetZ: -0.02,
  /**
   * Pitch of the palette plane about the grip's X axis, degrees. Negative tips
   * the face up toward your eyes; flip the sign if it faces the floor on your
   * device.
   */
  tiltDeg: -35,
  /**
   * Squeeze-to-select reach, metres from the grip to a dab or chip centre.
   * This path is a plain distance test on the squeeze-down frame, deliberately
   * outside the pointer pipeline — near the palette the touch pointer's hover
   * sphere outranks the grab pointer and can swallow squeeze-grabs.
   */
  grabSelectRadius: 0.09,
} as const;

/**
 * Room awareness: keeping robots inside the walls, and noticing when there are
 * no walls to keep them inside of.
 *
 * Field feedback: robots on the spawn ring materialised *through* the wall of
 * a small room, where they could be seen but never hit. TargetSystem probes
 * the detected planes and meshes along each candidate direction and pulls the
 * spawn back in front of whatever it finds.
 *
 * ### The scan notice (round 5)
 *
 * Field feedback, rounds 3-5: "still no wall splats". The diagnosis is that
 * **Guardian is not a room scan.** Players see their Guardian boundary, assume
 * the headset knows where their walls are, and it does not: WebXR plane data
 * comes from the saved Space Setup scene model, a different thing behind
 * Settings > Boundary > Mixed Reality. Meta's own Browser documentation says an
 * app gets planes because "the browser then requests access to space setup
 * information from the user" — and that in a room that was never set up the
 * array is simply empty, with no error and nothing to react to.
 *
 * Round 2 handled that by firing `initiateRoomCapture()` off a timer, and round
 * 3 field feedback killed it: it fought the headset's own flow and left the
 * barriers behaving strangely. Round 4 removed the call entirely, which left an
 * unscanned room with **no path at all** to ever getting walls.
 *
 * Round 5 splits the difference. The app never calls room capture on its own.
 * It waits {@link ROOM.scanCheckDelaySec}, and if the scene really is empty it
 * puts a notice and a SCAN ROOM button on the idle screen. Pressing the button
 * is the call. That matches what Meta's docs actually advise — call it "when
 * you are sure that there are no planes", after waiting "2 to 3 seconds", and
 * note that it "can only be called once per session" — while leaving the
 * decision with the player, which is the part round 2 got wrong.
 */
export const ROOM = {
  /**
   * How thick a detected **vertical** plane's collider is made, metres.
   *
   * ### The round-6 barrier finding
   *
   * Field feedback after round 5 was still "wall collision is weak" — not
   * absent, weak. Paint stuck to walls *sometimes*. That "sometimes" is the
   * whole diagnosis, and it is the same bug {@link FLOOR.thicknessMeters}
   * already fixed for the floor.
   *
   * `SceneUnderstandingSystem` builds each detected plane's mesh as
   * `BoxGeometry(width, 0.001, height)` — a **one-millimetre** slab — and
   * `PhysicsShapeType.Auto` faithfully turns that into a one-millimetre Havok
   * box. IWSDK steps Havok once per frame with no continuous collision
   * detection, so a ball leaving the muzzle at {@link FIRE.speed} teleports
   * ~12 cm per step at the Quest's 72 Hz floor. A sphere of
   * {@link BALLS.radius} only registers the wall if a step happens to land
   * within (radius + half the thickness) of it: with a 1 mm wall that capture
   * band is 8.1 cm out of a 11.8 cm stride, so roughly a third of shots pass
   * straight through — at oblique angles, more.
   *
   * Thickening the box widens the band. At 6 cm the band is 6 + 8 = 14 cm,
   * comfortably wider than one step, and no ordinary shot can miss.
   *
   * The cost is that the collider bulges half of this — 3 cm — into the room,
   * so paint lands 3 cm proud of the wall you can see. That is under the ball's
   * own radius and invisible in passthrough, which is what sets the ceiling on
   * this number: past ~0.12 the paint visibly floats.
   *
   * Only **vertical** planes are thickened. Floors and ceilings are left on
   * `Auto`: a floor already has FloorGuardSystem's half-metre slab a
   * millimetre underneath it catching everything that tunnels, and thickening
   * it would lift every floor splat 3 cm off the carpet for no gain.
   */
  wallThicknessMeters: 0.06,
  /**
   * Seconds after the session starts before the one-line collider census is
   * logged to the console.
   *
   * Purely diagnostic, and it exists because every wall-collision report so far
   * has had to be debugged by inference. Much longer and it scrolls off the
   * top of a field report; shorter than ~2 s and the planes have not all
   * arrived yet.
   */
  colliderLogDelaySec: 3,
  /** Metres to hold a robot back from the wall its spawn ray hit. */
  spawnWallMargin: 0.45,
  /** Never spawn a robot nearer than this to the player's head, metres. */
  spawnMinDist: 0.9,
  /** Ring angles tried before settling for the roomiest direction found. */
  spawnAttempts: 4,
  /** Longest wall probe, metres. Past this a direction counts as wide open. */
  spawnRayMaxDist: 15,

  /**
   * Seconds of immersive session before an empty scene counts as "unscanned".
   *
   * `XRFrame.detectedPlanes` is not populated on the first frame; Meta's Browser
   * docs say to "wait 2 to 3 seconds after session creation before making that
   * decision". Six is double that, because the cost of waiting is a notice that
   * appears a moment late and the cost of not waiting is telling a player with a
   * perfectly good room scan that they have not scanned their room.
   */
  scanCheckDelaySec: 6,
  /** Idle-screen notice when no planes or meshes exist. ASCII only (MSDF font). */
  scanNoticeText: 'No room scan found - paint has no walls to stick to',
  /**
   * Replaces the notice when `XRSession.initiateRoomCapture` is not there to
   * call — an older Quest Browser, or any other runtime. ASCII only.
   */
  scanUnavailableText: 'Run Space Setup in Quest Settings, then reopen',
  /**
   * Replaces the notice once capture has been requested. Meta documents the
   * call as usable "only once per session", so a second press cannot work and
   * the button says so rather than silently doing nothing.
   */
  scanRequestedText: 'Space Setup requested - finish it, then come back',
} as const;

/**
 * The floor that is always there.
 *
 * Field feedback, round 3: "shooting balls into thin air, they're not splatting
 * against anything". Every collider in this game came from scene understanding,
 * so in a room the headset has never scanned there were **zero** colliders —
 * balls flew through the world untouched and died silently at the kill floor
 * (BALLS.killFloorY) with nothing to show for it.
 *
 * FloorGuardSystem lays one invisible static slab under the player at session
 * scale, so paint always has something to land on. A real detected floor plane
 * arriving later simply coexists: both are static, and the real one is a
 * millimetre higher, so it takes the contact wherever it exists.
 */
export const FLOOR = {
  /**
   * Side length of the square slab, metres, centred on the tracking origin.
   * Big enough to cover any room a standing-scale session can roam.
   */
  extentMeters: 30,
  /**
   * Slab thickness, metres — and it is a slab, not a sheet, on purpose.
   *
   * IWSDK steps Havok once per frame (`HP_World_Step`) with no continuous
   * collision detection anywhere in the physics system, so a body simply
   * teleports from its old position to its new one each step. A ball leaving
   * the muzzle at FIRE.speed covers ~12 cm per frame at the Quest's 72 Hz
   * floor: against a 2 cm sheet it would sail straight through the backstop
   * that exists precisely to stop it. Half a metre leaves ~4x margin.
   *
   * The cost of the extra thickness is nil. Only the top face is reachable —
   * it is the one this game cares about — and the underside is buried where
   * nothing else in the scene lives.
   */
  thicknessMeters: 0.5,
  /**
   * Metres the slab's top face sits BELOW y = 0, the `local-floor` reference
   * height. Deliberately not flush: a detected floor plane sits exactly at 0,
   * and two coincident static faces are how you get contact jitter. One
   * millimetre of clearance is invisible and lets the real plane win.
   */
  sinkMeters: 0.001,
  /** Bounciness. Matched to WorldCollisionSystem's detected-plane material. */
  restitution: 0.1,
  /** Surface friction. Also matched to a detected plane. */
  friction: 0.8,
} as const;

/**
 * Chill mode: no clock, no robots, no score. Just you and a room to paint.
 */
export const CHILL = {
  /** Status line shown under the HUD while chilling. ASCII only (MSDF font). */
  statusText: 'Hold trigger to spray. Tap the palette to change paint.',
  /** Shown for the rest of the session after ROTATE CANVAS wipes the picture. */
  rotatedText: 'Canvas rotated - blank page, fresh start.',
  /** Loop ambient music while chilling. Set false for a silent studio. */
  music: true,
  /**
   * Per-hand milliseconds between sprayed balls while the trigger is held.
   *
   * Chill mode is the only phase that auto-fires: everywhere else a shot needs
   * its own trigger pull (FIRE.cooldownMs). Well under that, because spraying
   * is the point — but not zero, or BALLS.maxLive recycles paint faster than
   * it can land.
   */
  sprayCooldownMs: 120,
} as const;

/**
 * The easel that appears in Chill mode, and the painting on its canvas.
 *
 * Ball impacts that land inside the canvas board are stamped onto an offscreen
 * 2D canvas, which is the board's texture — so the painting is a real image
 * that SAVE PAINTING can hand back as a PNG.
 */
export const EASEL = {
  /** Metres in front of the head the easel is planted on entering Chill. */
  spawnDistance: 1.4,
  /** Canvas board width, metres, in landscape. */
  boardWidth: 0.62,
  /** Canvas board height, metres. 4:3 against the width, matching the pixels. */
  boardHeight: 0.465,
  /**
   * Portrait width/height, metres — the landscape pair swapped. ROTATE CANVAS
   * toggles between them (see `orientationDims` in EaselSystem), rebuilding the
   * board mesh, the physics box and the 2D canvas to match.
   */
  portraitBoardWidth: 0.465,
  portraitBoardHeight: 0.62,
  /** Canvas board thickness, metres. Also the physics box depth. */
  boardDepth: 0.02,
  /** Height of the board's centre above the floor, metres. */
  boardCentreHeight: 1.2,
  /** Degrees the easel leans back, like a real A-frame. */
  tiltDeg: 12,
  /** Metres of slop allowed on the board's depth axis when matching an impact. */
  hitDepthTolerance: 0.06,
  /** Painting resolution, pixels across, in landscape. */
  canvasPxW: 1024,
  /** Painting resolution, pixels down, in landscape. */
  canvasPxH: 768,
  /** Painting resolution in portrait — the landscape pair swapped. */
  portraitCanvasPxW: 768,
  portraitCanvasPxH: 1024,
  /** Silhouette stamped onto the painting. Same mask the room splats use. */
  maskUrl: '/textures/splat.png',
  /**
   * Silhouette stamped for a web-style impact — the same mask the web decals
   * use. Round 5 put web ammo on the palette, so webbing can now land on the
   * canvas; without a second mask it would have stamped paint-shaped blobs.
   */
  webMaskUrl: '/textures/web-splat.png',
  /**
   * Colour a web stamp is tinted. Near-white rather than #ffffff: pure white on
   * an off-white canvas is invisible, and webbing is grey-white anyway.
   */
  webStampColor: '#dedee6',
  /** Working size of the tinted splat stamp, pixels square. */
  maskPx: 256,
  /** Smallest paint stamp on the painting, pixels. */
  stampMinPx: 130,
  /** Largest paint stamp, pixels. */
  stampMaxPx: 220,
  /** Blank canvas colour, and the colour NEW CANVAS restores. */
  canvasColor: '#f7f5f0',
  /** Frame, legs and crossbar colour. */
  woodColor: '#8a6a48',
  /** Wood roughness — matte, unlike the glossy paint. */
  woodRoughness: 0.7,
  /** Leg and crossbar thickness, metres. */
  frameThickness: 0.035,
  /** How far behind the board the rear leg stands, metres. */
  rearLegOffset: 0.16,
} as const;

/**
 * Web ammo: the wrist shooters, the two gesture triggers, and the webbing.
 *
 * Round 4 made this a *mode* you entered from the title screen. Round 5 deleted
 * that phase — field feedback was "I want web mode AND chill mode, same
 * interactions" — and webbing became the fifth chip on the wrist palette. Load
 * WEB and the shooters appear on both wrists in whatever phase you are already
 * in; load any paint chip or dab and they go away. Everything below is
 * unchanged by that except that nothing here is gated on a phase any more.
 *
 * Three ways to fire, all landing on the same white ball: the trigger (through
 * BallSpawnSystem's ordinary firing path, so it obeys the same cooldown, the
 * same HUD-swallowing rule and the same spray-on-hold in Chill), a THWIP hand
 * gesture, and a forward thrust of the hand. Every web ball trails a strand
 * from the wrist that threw it and sticks a white web splat where it lands.
 *
 * ### The grip frame, since every offset below is in it
 *
 * Same convention as PALETTE, and worth stating exactly because round 5 moved
 * the shooter across it: **+Y is out of the BACK of the hand** (where a watch
 * face sits), **-Y is the PALM side**, **-Z is the way the hand points** and +Z
 * is back toward the elbow. X is the mirrored axis: +X is thumb-side on the
 * left hand and pinky-side on the right, which is why every X-ish number here
 * is declared in the **right** hand's frame and flipped for the left.
 */
export const WEB = {
  // ---- The shooters on your wrists ----------------------------------------
  //
  // Round 4 mounted these on the back of the wrist at yaw 0, and the field
  // report was blunt: "the shooting component is parallel to the user's forearm
  // / on top; it must be perpendicular to the band, sitting on the UNDERSIDE of
  // the forearm (palm up), nozzle pointing the way the fist points".
  //
  // The GLB measures 0.73 x 1.85 x 1.90 in its own units — a near-square Y/Z
  // pair with X 2.6x smaller, which is the unmistakable signature of a **band**:
  // a ring lying in the model's YZ plane whose hole runs along model X. At yaw 0
  // that hole pointed sideways across the wrist, leaving the hoop standing up in
  // the plane of the forearm. Exactly the "parallel to the forearm / on top"
  // being complained about. shooterYawDeg swings it a quarter turn so the hole
  // runs along the arm and the band goes round the wrist the way a band does.
  /**
   * Cap on the finished shooter's longest dimension, metres.
   *
   * Not the primary fit any more — {@link shooterBandMeters} is — but the
   * backstop for art whose proportions are nothing like the shipped cuff's. If
   * band-fitting would make the model longer than this, it is length-fitted
   * instead. Round 4 shipped 0.07 as the primary fit and the field called the
   * result too small.
   */
  shooterLengthMeters: 0.1,
  /**
   * Target band diameter, metres — the size the cuff is actually fitted to.
   *
   * A wrist is a fixed size, so the number that decides whether a worn object
   * looks right is how wide the band is, not how long the whole model is.
   * 7.5 cm is a generous adult wrist with the cuff standing a little proud of
   * it. Deliberately a constant: do NOT try to measure the player's hand at
   * runtime — joint spans are noisy and this has to look right on frame one.
   */
  shooterBandMeters: 0.075,
  /**
   * Mount yaw about the grip's Y axis, degrees, applied to the model inside its
   * holder. 90 lays the shipped cuff's hole along the forearm. @see WEB
   */
  shooterYawDeg: 90,
  /** Mount pitch about the grip's X axis, degrees. Tips the nose up or down. */
  shooterPitchDeg: 0,
  /**
   * Mount roll about the grip's Z axis, degrees — applied LAST, so it spins the
   * mounted cuff around the forearm. This is the knob for bringing a nozzle,
   * a seam or a logo round to whichever side of the wrist is facing the player.
   *
   * **180 since round 6, and that is the palm-up fix.** Round 5 mounted the
   * cuff for a fists-down punch pose and the field report was that the pose
   * people actually adopt is the Spider-Man one: forearm supinated, palm and
   * the underside of the wrist turned UP toward your own face. Half a turn
   * about the forearm brings the device body round to that side, so it reads
   * right in supination instead of in pronation.
   *
   * Mirrored for the left hand like every other rotation about Y or Z, which
   * for exactly 180 is the same rotation either way — the two wrists stay
   * symmetric by construction rather than by luck.
   *
   * Nothing about aim changes: webs fly along the grip's forward axis and the
   * muzzle is a point in the *holder's* frame (see {@link muzzleLocal}), which
   * the mount rotation does not touch.
   */
  shooterRollDeg: 180,
  /** Metres toward the pinky side, in the RIGHT grip's frame. Left mirrors. */
  shooterOffsetX: 0.0,
  /**
   * Metres along the grip's Y axis. **Negative**, and that is the round-5 fix:
   * the device belongs against the palm side of the wrist, not on the back of
   * the hand where round 4 put it.
   */
  shooterOffsetY: -0.018,
  /**
   * Metres along the grip's Z axis. **Positive**, i.e. back toward the elbow:
   * the grip origin sits in the palm and a cuff is worn at the wrist behind it.
   */
  shooterOffsetZ: 0.03,
  /**
   * The nozzle, in the shooter holder's own (grip-aligned) local space, metres.
   *
   * Both the web's spawn point and the strand's near end come from here, so
   * a mount rotation that moves the nozzle moves the webbing with it rather
   * than leaving strands sprouting from the middle of the cuff. X mirrors
   * per hand like every other X here; the defaults put it on the underside of
   * the band's leading edge.
   */
  muzzleLocal: [0, -0.032, -0.018] as [number, number, number],
  /** Metres past the nozzle that a web ball is born, so it clears the hand. */
  muzzleOffset: 0.09,

  // ---- THWIP gesture (hand tracking) --------------------------------------
  /**
   * Master switch for the joint-driven gesture. The trigger and the thrust are
   * unconditional; this only gates the finger-curl classifier, so web ammo
   * still has two working triggers if hand joints are ever unavailable.
   */
  gestureEnabled: true,
  /**
   * Fingertip-to-wrist distance, metres, below which a finger counts as curled
   * into the palm. Middle and ring must both be under this.
   *
   * Absolute metres rather than a fraction of hand span: an adult middle
   * fingertip sits ~0.16 m from the wrist extended and ~0.05 m folded, so 0.07
   * is a conservative "definitely folded" and leaves a wide dead band before
   * the extend gate below.
   */
  curlThreshold: 0.07,
  /**
   * Fingertip-to-wrist distance, metres, above which a finger counts as
   * extended. Index and pinky must both clear this — that pair staying out is
   * what separates a thwip from a fist.
   */
  extendThreshold: 0.13,
  /** Minimum milliseconds between gesture shots from one hand. */
  gestureCooldownMs: 500,

  // ---- Thrust trigger ------------------------------------------------------
  /**
   * Forward hand speed, m/s, that counts as a thrust. Measured along the
   * grip's own -Z, so pulling the hand back or waving it sideways never fires.
   */
  thrustSpeed: 1.7,
  /** Minimum milliseconds between thrust shots from one hand. */
  thrustCooldownMs: 600,
  /**
   * Seconds of hand travel averaged into the speed estimate. One frame of
   * tracking noise at 90 Hz can read as several m/s; a short window smooths
   * that out without making the gesture feel laggy.
   */
  thrustWindowSec: 0.08,

  // ---- The strand ----------------------------------------------------------
  /** Simultaneous strands. Beyond this the oldest is retired early. */
  strandPool: 8,
  /** Strand cylinder radius, metres. Thin enough to read as a thread. */
  strandRadius: 0.004,
  /** Seconds a strand hangs at the impact point, fading, before it frees its slot. */
  strandLingerSec: 0.6,

  // ---- The paint -----------------------------------------------------------
  /** Web splat decals held before the pool recycles. Its own pool, not SPLAT's. */
  splatCapacity: 192,
  /** Size multiplier on a web splat versus a paint splat. Webs spread wider. */
  splatSizeMult: 1.6,

  // ---- TETHER WEB (round 6) ------------------------------------------------
  //
  // A second thing web ammo can be, chosen on the wrist selector below or with
  // the right controller's B button. A tether web flies exactly like a splat
  // web — same arc, same strand, same wall decal if it misses — but a robot it
  // touches gets LATCHED instead of damaged. Then you reel it in and it pops.
  //
  // Two ways to reel, because the two input modes want different things: a
  // controller player has a squeeze button right under their fingers, and a
  // hand-tracking player has no button but does have a whole arm. So: hold to
  // reel steadily, or yank to haul it in a chunk at a time.
  /**
   * Metres from the player's **head** at which a reeled-in robot pops.
   *
   * Measured off the head rather than off the hand because that is where the
   * player's sense of "it's on me now" lives, and because a hand held out at
   * arm's length would otherwise pop things that are still across the room.
   * Inside 0.7 m a 35 cm robot fills a satisfying amount of view.
   */
  tetherKillRadius: 0.7,
  /**
   * Seconds a tether may stay attached before it lets go on its own.
   *
   * A safety valve, not a mechanic. Without it a player who latches a robot and
   * then walks away has silently removed it from the round: the slot never
   * respawns and the ring quietly shrinks. Twelve seconds is far longer than
   * any deliberate reel takes.
   */
  tetherMaxSec: 12,
  /**
   * Speed, m/s, at which the hand moving AWAY from the tethered robot counts
   * as a yank.
   *
   * Measured as the hand's velocity projected onto the robot-to-hand direction,
   * the same trick {@link thrustSpeed} uses on the pointing axis: pulling back
   * scores, pushing forward and waving sideways do not. Lower than the thrust
   * threshold on purpose — a yank is a tug, a thrust is a punch, and the thrust
   * has to be hard enough that ordinary arm movement never trips it.
   */
  yankSpeed: 1.3,
  /** Metres of line a single yank hauls in. Roughly one arm's worth. */
  yankReelMeters: 0.55,
  /**
   * Minimum milliseconds between yanks from one hand.
   *
   * Short, unlike the gesture cooldowns: repeated yanking is the *intended*
   * verb here, so this only has to stop one continuous pull from registering
   * as five. Four hauls a second is about as fast as an arm can actually go.
   */
  yankCooldownMs: 250,
  /** Metres per second the line comes in while the squeeze is held. */
  reelSpeed: 1.8,

  // ---- The wrist selector gadget -------------------------------------------
  //
  // Two mini pads floating above the LEFT shooter, parented into its holder so
  // they ride the wrist exactly as the cuff does. Poke one, squeeze near one,
  // or press B. They only exist while web ammo is loaded — with paint on the
  // palette there is no sub-mode to choose.
  //
  // Everything here is in the left grip's frame, same as the shooter mount:
  // -Y is the palm side, which is the side facing the player in the palm-up
  // pose the shooter is now mounted for.
  /** Half-height of one pad, metres. Big enough to poke, small enough to wear. */
  selectorPadMeters: 0.022,
  /** Gap between the two pads, metres. */
  selectorPadGap: 0.008,
  /**
   * Metres along the grip's Y axis. **More negative than
   * {@link shooterOffsetY}**, i.e. further out on the palm side, so the pads
   * float clear of the cuff rather than inside it.
   */
  selectorOffsetY: -0.058,
  /** Metres along the grip's Z axis. Slightly forward of the cuff's centre. */
  selectorOffsetZ: -0.005,
  /** Scale applied to whichever pad is selected. */
  selectorSelectedScale: 1.2,
  /** Emissive intensity on the selected pad, on top of that scale. */
  selectorSelectedEmissive: 0.55,
  /** Resting emissive on the unselected pad — a holo panel is never fully dark. */
  selectorIdleEmissive: 0.08,
} as const;

/**
 * Sound effect paths. Every one of these ships in public/audio today.
 * FeedbackSystem must treat a missing file as "skip the sound", never a crash.
 *
 * Kept as a pure path map — nothing but `/audio/*.mp3` strings — because both
 * main.ts's AssetManifest and config.test.ts iterate its values. Volumes and
 * spatialisation live in the two tables below rather than nested in here.
 */
export const AUDIO = {
  /** Trigger tick when a ball leaves the muzzle. */
  fire: '/audio/fire.mp3',
  /** Wet slap when paint lands on a surface. */
  splat: '/audio/splat.mp3',
  /** Robot destruction. */
  pop: '/audio/pop.mp3',
  /** Per-second beep during the pre-round countdown. */
  countdown: '/audio/countdown.mp3',
  /** End-of-round sting. */
  gameOver: '/audio/gameover.mp3',
  /** Combo milestone. */
  chime: '/audio/chime.mp3',
  /** Confirmation tick under every HUD button press. */
  uiClick: '/audio/ui-click.mp3',
  /** Ambient loop that plays for the whole of Chill mode. */
  chillMusic: '/audio/chill-music.mp3',
  /** The web shooter going off. Non-positional — it happens at your wrist. */
  thwip: '/audio/thwip.mp3',
  /** Webbing hitting a surface. Positional, like the paint splat. */
  webHit: '/audio/web-hit.mp3',
} as const;

/**
 * Per-cue playback gain, 0..1. These are the mix: the fire tick repeats every
 * few hundred milliseconds so it sits well under the one-off pop and sting.
 */
export const AUDIO_VOLUME = {
  fire: 0.35,
  /** Paint hitting the room. */
  splat: 0.5,
  /** Same sample on a robot hit, pushed up so a connect reads over the room. */
  splatTarget: 0.72,
  pop: 0.7,
  countdown: 0.5,
  gameOver: 0.8,
  chime: 0.6,
  /** Button tick. Present enough to confirm a press, quiet enough to spam. */
  uiClick: 0.5,
  /** Ambient bed. Deliberately low — it plays under everything, forever. */
  chillMusic: 0.25,
  /** The thwip. Loud: it is the whole point of the mode. */
  thwip: 0.55,
  /** Webbing landing. Level with the paint splat it replaces. */
  webHit: 0.5,
} as const;

/** Shared 3D-audio settings for the two positional cues (splat and pop). */
export const AUDIO_SPATIAL = {
  /** Metres at which a positional cue plays at full volume. */
  refDistance: 1.5,
  /** Simultaneous voices per cue before the oldest is stolen. */
  maxInstances: 4,
} as const;

/**
 * Controller rumble. Intensity is 0..1, duration is milliseconds. Hand
 * tracking has no actuators, so all of this silently no-ops in pinch mode.
 */
export const HAPTICS = {
  /** Firing hand only. */
  fireIntensity: 0.3,
  fireMs: 40,
  /** Both hands — a robot took damage. */
  hitIntensity: 0.5,
  hitMs: 60,
  /** Both hands — a robot popped. */
  popIntensity: 0.9,
  popMs: 100,
  /**
   * Web-shooting hand only. Punchier and shorter than the paint trigger: a
   * thwip should feel like a snap, not the soft thud of a paintball leaving.
   */
  thwipIntensity: 0.5,
  thwipMs: 50,
  /** Tethering hand only — the line just caught something. A solid thunk. */
  tetherAttachIntensity: 0.5,
  tetherAttachMs: 60,
  /**
   * Tethering hand only, once per reel step. Deliberately the lightest cue in
   * the table: it repeats several times a second while you haul, and anything
   * heavier turns a satisfying ratchet into a numb hand.
   */
  yankIntensity: 0.3,
  yankMs: 25,
  /**
   * Both hands — a robot you dragged in with your own arm just popped. The
   * hardest rumble in the game, and the only one above the ordinary pop:
   * TargetPopped fires in the same frame with the sound, so this is purely the
   * extra weight the kill earned.
   */
  tetherPopIntensity: 0.9,
  tetherPopMs: 120,
} as const;

// ---------------------------------------------------------------------------
// Round 7: rendering fidelity + VFX. Appended as two self-contained sections so
// the tuning surface above stays exactly as it was.
// ---------------------------------------------------------------------------

/** Renderer tone-mapping curves main.ts knows how to apply. */
export type ToneMappingName = 'none' | 'neutral' | 'aces' | 'agx';

/**
 * Renderer-wide look: image-based lighting, tone mapping, and the material
 * polish that leans on them. Applied once at startup (main.ts, BallSpawnSystem's
 * material cache, TargetSystem's robot pool) — none of it costs anything per
 * frame beyond the shader work it buys.
 *
 * Why this exists: IWSDK's `defaultLighting` lights the scene with a nearly
 * uniform grey-blue gradient and no direct lights, so every PBR surface read as
 * flat pastel plastic — a white sphere measured 215-221/255 from top to bottom,
 * i.e. no shading at all, and no specular highlight anywhere because a uniform
 * environment has nothing in it to reflect. Swapping the IBL source for three's
 * RoomEnvironment (a PMREM of a lit room, built once at boot) gives every
 * material shape, a top-lit falloff and real reflections, at zero extra cost
 * per frame: it samples the same kind of PMREM texture the gradient did.
 *
 * Nothing here draws a background. IBLTexture only writes `scene.environment`;
 * the passthrough room is never covered.
 */
export const RENDER = {
  /**
   * What the scene is lit by. 'room' is three's RoomEnvironment, generated in
   * a few milliseconds at boot with no download. Any other value is a URL to an
   * equirect (.hdr/.exr/.png/.jpg) under public/, PMREM'd by IWSDK's
   * EnvironmentSystem — e.g. a capture of a real living room to match the
   * passthrough. Empty string keeps IWSDK's flat gradient (the old look).
   */
  iblSource: 'room' as string,
  /**
   * Strength of that lighting (scene.environmentIntensity). It is the ONLY
   * light in the scene, so this is the master brightness of every lit object —
   * balls, robots, palette, easel. 1.0 with 'neutral' tone mapping keeps paint
   * vivid without blowing out; under 'none', drop it to ~0.7 or white surfaces
   * start clipping flat white.
   */
  iblIntensity: 1.0,
  /**
   * Spins the lighting around the vertical axis, degrees. Moves where the room
   * environment's bright "ceiling panels" sit, i.e. which side of every ball
   * carries the highlight. Cosmetic.
   */
  iblRotationYDeg: 0,
  /**
   * Tone-mapping curve for every three.js material that has not opted out
   * (uikit's HUD panels and text opt out, so the HUD is untouched by this).
   *
   * 'neutral' (Khronos PBR Neutral) is the choice for passthrough: it is the
   * identity for everything below ~0.76 linear, so authored paint colours land
   * on screen as authored, and it only rolls off the highlights the new IBL
   * produces — no hue-skewed clipping on the clearcoat glints. Its small black
   * offset even nudges the pastel splats a touch more saturated; the cost is
   * that a pure-white unlit surface tops out around 94% sRGB instead of 100%.
   * 'aces' and 'agx' were measured too: both visibly desaturate the paint and
   * wash it out against the passthrough feed — avoid. 'none' is the pre-round-7
   * renderer (pair it with iblIntensity ~0.7).
   */
  toneMapping: 'neutral' as ToneMappingName,
  /** Multiplier applied before the tone curve. >1 brightens everything lit. */
  exposure: 1.0,

  // ---- Paint balls (BallSpawnSystem material cache) -----------------------
  /**
   * Base roughness of a paint ball, 0 = mirror, 1 = chalk. Low reads as wet;
   * the clearcoat below adds the crisp glint on top, so the base can stay a
   * little soft and keep its colour saturated.
   */
  ballRoughness: 0.25,
  /**
   * Clearcoat layer strength, 0..1 — the "wet paint" glaze. Above 0 the balls
   * use MeshPhysicalMaterial (one extra shader program, compiled the first time
   * a ball is drawn — a one-off hitch on the very first shot). 0 falls back to
   * MeshStandardMaterial, which shares the palette dabs' already-compiled
   * program: no glaze, no first-shot compile.
   */
  ballClearcoat: 1.0,
  /** Roughness of that glaze. Lower = a tighter, brighter highlight. */
  ballClearcoatRoughness: 0.06,
  /**
   * Web balls' base colour, linear RGB. A hair cooler than pure white so the
   * ball reads as pearly webbing rather than a paint colour.
   */
  webBallColor: [0.94, 0.94, 0.97] as readonly [number, number, number],
  /**
   * Web balls' base roughness. Higher than paint: a satin pearl under the
   * clearcoat glint, not a wet bead.
   */
  webBallRoughness: 0.42,
  /** Web balls' glaze roughness — slightly softer than paint's. */
  webBallClearcoatRoughness: 0.1,
  /**
   * Faint self-light on web balls, linear RGB. Keeps them reading white in a
   * dim room instead of going grey on their shadow side. Free (a uniform).
   */
  webBallEmissive: [0.05, 0.05, 0.07] as readonly [number, number, number],

  // ---- Robots (TargetSystem.ensurePool, patched once on the shared materials)
  /**
   * Multiplier on how much environment light the robots catch, diffuse and
   * reflection together. Their metal panels are what benefit: >1 makes them
   * pop against passthrough. 1 = physically plain.
   */
  robotEnvBoost: 1.25,
  /**
   * Rim-glow colour, linear RGB — a soft holo edge on the robot's silhouette
   * that separates it from a busy real room. Cool cyan by default because
   * indoor passthrough is mostly warm.
   */
  robotRimColor: [0.45, 0.8, 1.0] as readonly [number, number, number],
  /**
   * Rim-glow strength. 0 switches the rim off. 0.3 is barely there, 0.5 reads
   * as a deliberate holo edge; past ~0.6 it turns into a halo.
   */
  robotRimStrength: 0.4,
  /**
   * Rim falloff exponent. Higher = a thinner rim hugging the outline; lower =
   * a glow creeping over the whole body.
   */
  robotRimPower: 2.5,
} as const;

/** Particle silhouette for one VFX burst. @see VfxBurstConfig.shape */
export type VfxShape = 'blob' | 'flake' | 'streak';

/** One burst type in {@link VFX}. Every field is per-particle unless noted. */
export interface VfxBurstConfig {
  /** Particles per burst. 0 disables the effect entirely. */
  readonly count: number;
  /** Slowest launch speed, m/s. */
  readonly speedMin: number;
  /** Fastest launch speed, m/s. */
  readonly speedMax: number;
  /** Shortest lifetime, seconds. Shorter = snappier. */
  readonly lifeMin: number;
  /** Longest lifetime, seconds. */
  readonly lifeMax: number;
  /** Size as a multiple of {@link VFX.particleRadius}. +-30% jitter on top. */
  readonly size: number;
  /**
   * Cone half-angle around the burst's axis, degrees. 180 = a full sphere,
   * 90 = a hemisphere off the surface, small = a jet.
   */
  readonly spreadDeg: number;
  /**
   * Added to the axis's Y before normalising: >0 tilts every burst upward so
   * particles arc up and fall, which reads as "splash" rather than "spray".
   */
  readonly upBias: number;
  /** Fraction of real gravity the particles feel. Confetti floats (<0.5). */
  readonly gravityScale: number;
  /** Air drag, 1/s. Higher = particles stall quickly and hang. */
  readonly drag: number;
  /** Metres from the event point along each particle's direction at spawn. */
  readonly startOffset: number;
  /**
   * 'blob' = round droplet, 'flake' = flat tumbling confetti chip, 'streak' =
   * a spark stretched along its velocity.
   */
  readonly shape: VfxShape;
}

/**
 * Particle juice: confetti, paint droplets and sparks, all from ONE pooled
 * InstancedMesh (VfxSystem) — a single draw call however many effects are
 * running, zero allocation per frame, and no transparency (particles shrink
 * away instead of fading, so there is no sorting and no overdraw).
 *
 * Driven entirely by the existing game-event mailbox, so no gameplay system
 * knows the particles exist.
 */
export const VFX = {
  /** Master switch. false = VfxSystem builds nothing and draws nothing. */
  enabled: true,
  /**
   * Live-particle ceiling. A burst that finds the pool full is truncated, not
   * queued. 256 is ~3x the worst realistic load (two pops + rapid fire).
   */
  poolSize: 256,
  /** Base particle radius, metres. Every burst's `size` multiplies this. */
  particleRadius: 0.007,
  /** Gravity, m/s^2, before each burst's gravityScale. */
  gravity: 9.81,
  /**
   * Largest simulation step, seconds. A frame hitch longer than this slows the
   * particles down instead of teleporting them through the floor.
   */
  maxStepSec: 0.05,
  /** Fraction of life spent popping in from 40% size. Snappier when smaller. */
  growEnd: 0.08,
  /** Fraction of life after which a particle shrinks away to nothing. */
  shrinkStart: 0.55,
  /** A flake's thickness relative to its width. Lower = flatter confetti. */
  flakeThickness: 0.22,
  /** A streak's length relative to its width. Higher = longer spark trails. */
  streakStretch: 4.0,
  /** Slowest flake tumble, radians per second. */
  spinMin: 8,
  /** Fastest flake tumble, radians per second. */
  spinMax: 20,
  /**
   * Particle surface roughness. They are lit by the same IBL as everything
   * else and flat-shaded, so tumbling confetti glints as its faces turn.
   */
  roughness: 0.35,
  /**
   * Frames the (empty) particle mesh is drawn after the headset session
   * becomes visible, purely so its shader compiles at session start instead of
   * hitching the first robot pop. After that the mesh hides itself whenever no
   * particle is alive — zero draw calls when idle.
   */
  warmupFrames: 3,

  /**
   * Robot popped: paint confetti in the palette colours (plus white), thrown
   * up and out of the robot's body, floating down on heavy drag.
   */
  pop: {
    count: 20,
    speedMin: 1.0,
    speedMax: 2.4,
    lifeMin: 0.55,
    lifeMax: 0.95,
    size: 2.0,
    spreadDeg: 180,
    upBias: 0.9,
    gravityScale: 0.45,
    drag: 2.4,
    startOffset: 0.06,
    shape: 'flake',
  } satisfies VfxBurstConfig,
  /**
   * A ball landed: a few droplets of its own colour kicked off the surface.
   * The impact event carries no contact normal, so the axis is the direction
   * back toward the player's head (plus upBias) — right for walls and floors,
   * and the wide cone hides the error on grazing hits.
   */
  impact: {
    count: 6,
    speedMin: 0.6,
    speedMax: 1.6,
    lifeMin: 0.25,
    lifeMax: 0.45,
    size: 1.2,
    spreadDeg: 70,
    upBias: 0.6,
    gravityScale: 1.0,
    drag: 0.6,
    startOffset: 0.01,
    shape: 'blob',
  } satisfies VfxBurstConfig,
  /**
   * A ball connected with a robot without killing it: a short spray of the
   * loaded colour out of the robot's front (toward the player).
   */
  hit: {
    count: 6,
    speedMin: 0.8,
    speedMax: 1.8,
    lifeMin: 0.2,
    lifeMax: 0.4,
    size: 1.1,
    spreadDeg: 60,
    upBias: 0.4,
    gravityScale: 1.0,
    drag: 0.8,
    startOffset: 0.08,
    shape: 'blob',
  } satisfies VfxBurstConfig,
  /** A tether web latched onto a robot: a quick white spark burst. */
  tether: {
    count: 10,
    speedMin: 1.6,
    speedMax: 3.0,
    lifeMin: 0.12,
    lifeMax: 0.24,
    size: 0.6,
    spreadDeg: 180,
    upBias: 0,
    gravityScale: 0.15,
    drag: 3.0,
    startOffset: 0.05,
    shape: 'streak',
  } satisfies VfxBurstConfig,
  /**
   * A shot left the muzzle: a tiny puff of the loaded paint (white for web)
   * drifting forward and dripping. Fires every shot, so it stays small and
   * short — set count 0 if it ever reads as clutter near the hands.
   */
  muzzle: {
    count: 3,
    speedMin: 0.25,
    speedMax: 0.6,
    lifeMin: 0.12,
    lifeMax: 0.22,
    size: 0.6,
    spreadDeg: 35,
    upBias: 0,
    gravityScale: 1.0,
    drag: 1.5,
    startOffset: 0.0,
    shape: 'blob',
  } satisfies VfxBurstConfig,
} as const;
