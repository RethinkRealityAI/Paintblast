// Every gameplay tunable in Splotopia (formerly PaintBlast MR) lives in this file.
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
  /**
   * Round 9: in Countdown / Playing the docked HUD sits low in front of you, so
   * shots at low robots (Duster Duke stands at 0.4 m) cross its rectangle. In
   * those phases only a ray over one of the panel's visible BUTTONS swallows
   * the shot — elements whose `id` starts with this prefix (uikitml
   * convention: every <button> is `btn-...`). Menus (Idle, GameOver, Chill)
   * still block over the whole visible panel. A hidden panel never blocks.
   */
  uiInteractiveIdPrefix: 'btn-',
  /**
   * Metres of slop around a button when testing "is this ray clicking it".
   * A little generous so a click on a button edge never also fires.
   */
  uiButtonMarginMeters: 0.01,
  /**
   * Aim assist on paint, degrees (round 7). A shot within this cone of a live
   * robot is bent onto the ballistic arc that hits it — judged against the
   * corrected arc, so a player who has learned the drop is already inside it.
   * Small on purpose: hand tracking is centimetre-noisy and Meta's hands
   * guidance asks for forgiving targeting, but paint should still feel like
   * paint. Webs get their own, wider cone ({@link WEB.aimAssistDeg}). Only
   * live robots attract — walls, the easel and the floor never do. 0 disables.
   */
  aimAssistDeg: 4,
  /** Robots further than this many metres never attract aim assist. */
  aimAssistMaxRange: 6,
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
  /**
   * HUD status line while a round is frozen because the headset lost focus —
   * the Quest system menu is open, the headset came off, or the session ended
   * mid-round. Replaces the Countdown / Playing line until focus returns, when
   * the normal line comes straight back. ASCII only (MSDF font).
   */
  pausedStatusText: 'Paused - the round waits for you',
  /**
   * The longest single frame, seconds, that still counts as play time.
   *
   * The pause itself is driven by the session's visibility state, but a
   * hidden session gets no frames at all — the browser simply stops calling
   * back — so the first frame after the headset comes back can arrive with a
   * delta of minutes and no visibility change ever having been seen. Any frame
   * longer than this is treated as time spent paused instead: the round clock,
   * the countdown, the combo window and every robot timer skip it.
   *
   * Half a second sits far above a real hitch (a shader compile is ~0.1-0.3 s,
   * and that time WAS on screen) and far below any stall a player would call
   * "I was away". Raise it if long hitches start eating round time; lower it
   * and genuine hitches stop counting against the clock.
   */
  pauseGapSec: 0.5,
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
  /**
   * Highest spawn height, metres above the floor. 1.7 keeps the nearest ring
   * (1.2 m) within ~23 degrees above a seated (1.2 m) eye line — VRCs ask for
   * play inside a comfortable +/-30 degree vertical band. Was 2.0 (~34 deg).
   */
  heightMax: 1.7,
  /**
   * Legacy (rounds 1-7) robot height, metres. Round 8 sizes every robot from
   * its archetype's `SPLOTBOTS.archetypes.*.heightMeters` instead — the
   * robot.gltf fallback too — so this no longer changes anything.
   */
  heightMeters: 0.35,
  /** Floor under the derived hit sphere, metres — keeps small art hittable. */
  hitRadiusMin: 0.12,
  /**
   * How far a robot may wander off its evenly spaced ring angle, as a fraction
   * of one slice. 0 = perfectly regular ring, 1 = slices may touch.
   */
  spawnAngleJitter: 0.4,
  /**
   * Pooled robot instances allocated up front and reused. Round 8: must equal
   * the sum of every Splotbot archetype's `pool` (SPLOTBOTS.archetypes), since
   * each slot is built once as one specific character; a unit test pins it.
   * It also sizes the aim-assist table.
   */
  poolSize: 14,
  /**
   * Hard ceiling on robots alive at once, whatever a wave asks for. Round 8's
   * waves (SPLOTBOTS.waves) set the real number per phase of the round; this
   * only stops a mistuned wave from flooding a seated player's view. The
   * boss's two split Mopsys are allowed past it for a moment.
   */
  maxConcurrent: 5,
  /**
   * Default hits to pop, for the Target component's schema only. Round 8:
   * each archetype's `SPLOTBOTS.archetypes.*.hp` is what a spawn really gets.
   */
  baseHp: 1,
  /**
   * Seconds after a pop before the spawn director may fill the gap (and
   * before that pool slot can be reused).
   */
  respawnDelaySec: 1.5,
  /**
   * Legacy hover amplitude, metres. Round 8: per archetype
   * (`SPLOTBOTS.archetypes.*.bobAmplitude`); unused.
   */
  bobAmplitude: 0.08,
  /** Hover cycles per second, shared by every Splotbot's bob. */
  bobHz: 0.5,
  /**
   * Legacy yaw drift, degrees per second. Round 8 robots turn to *face you*
   * instead (`SPLOTBOTS.archetypes.*.faceRate`); unused.
   */
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
  /**
   * Seconds a hit keeps the robot puffed up and flashing white (round 8: the
   * flash brightness is SPLOTBOTS.anim.hitFlashIntensity; the squash-and-
   * stretch rings on for SPLOTBOTS.anim.hitSec).
   */
  hitFlashSec: 0.12,
  /** Peak scale multiplier at the instant of a non-lethal hit. */
  hitFlashScale: 1.18,
  /**
   * Seconds the pop animation takes: a quick squash, then a spinning shrink
   * to nothing. Round 8 lengthened it from 0.15 so the squash actually reads;
   * the robot stops being shootable the instant it starts.
   */
  popDurationSec: 0.32,
  /**
   * Width of the arc robots spawn in, degrees, centred on the way the player
   * is facing at the moment the round starts.
   *
   * The competition's "airplane seat" test is the reason this exists: on a
   * full ring a seated player has to twist round to find the robot behind
   * them, and in a real airplane seat they cannot. 150 is +/-75 degrees — every
   * robot sits inside a comfortable head-and-shoulders turn with no torso
   * rotation, while the outer lanes still make the player look left and right
   * rather than stare straight ahead.
   *
   * The robots split the arc into equal lanes (spawnAngleJitter wanders inside
   * a lane, never out of it), so narrowing it bunches them up; below ~90 with
   * four robots they start to overlap at the near radius. 360 restores the
   * original full ring around the player, which ignores facing entirely.
   * Respawns reuse the arc captured at round start, so it does not chase the
   * player's head mid-round.
   */
  spawnArcDeg: 150,
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
  // Round 8: 0.46 (was 0.4) - the techno-paint title is a two-column card
  // that is nearly square, so height is what limits its size.
  baseHeight: 0.46,

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

  // ---- Round 8: techno-paint micro-interactions ------------------------------
  /**
   * Seconds a newly shown section takes to fade up and rise into place (title
   * -> Armory, round -> summary...). 0 swaps instantly. Keep it short: this is
   * confirmation, not choreography.
   */
  sectionFadeSec: 0.22,
  /** How far below its resting place a section starts its rise, panel cm. */
  sectionRiseCm: -1.2,
  /** A button swells to this under the pointer (1 = no swell). */
  buttonHoverScale: 1.04,
  /** ...and squashes to this for the press flash. */
  buttonPressScale: 0.93,
  /** The Armory's small skin dots swell more, so the hovered one is obvious. */
  skinDotHoverScale: 1.18,
  /**
   * Milliseconds a button stays in its pressed look after a press. A Quest
   * trigger pull is often two or three frames long, so painting the pressed
   * state for exactly as long as it is held is invisible.
   */
  pressFlashMs: 140,
  /** Seconds left in a round at which the clock turns coral. */
  timerUrgentSec: 10,
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

  // ---- Round 8: the techno-paint holo board ---------------------------------
  //
  // The wooden kidney became a dark glass slab with a glowing neon edge, glossy
  // liquid paint wells and holo sockets under every chip and pad — the same
  // art direction as the HUD (docs/concepts/techno-ui.jpg). Built in code, so
  // nothing streams and nothing can fail to load.
  /**
   * Which board to build: 'holo' (round 8 default), 'glb' (the Higgsfield
   * palette-board.glb, still in the manifest, falls back to holo while it
   * streams) or 'wood' (the round-3 primitive oval).
   */
  boardStyle: 'holo' as 'holo' | 'glb' | 'wood',
  /**
   * Squareness of the holo board's outline: 2 is the plain oval, 4 a rounded
   * rectangle. ~3 reads as a modern "squircle" device and still hugs the dab
   * arc. Its semi-axes are boardRadius and boardRadius * boardOvalScale.
   */
  holoSquareness: 3.2,
  /** Glass face colour (sRGB) and how much passthrough shows through it. */
  holoFaceColor: '#070912',
  holoFaceOpacity: 0.84,
  /** The bezel round the slab's side, a brushed graphite. */
  holoBezelColor: '#3a3f4f',
  /** Metres the neon line is inset from the slab's edge. */
  holoEdgeInset: 0.0045,
  /** Radius of the crisp neon line, metres. */
  holoEdgeRadius: 0.0009,
  /** Radius of the soft additive halo round it, metres. */
  holoGlowRadius: 0.0032,
  /** Resting opacity of that halo (the shimmer swings around it). */
  holoGlowOpacity: 0.32,
  /**
   * Colours the neon edge runs through, in order round the board (it closes
   * back onto the first). sRGB hex. A ramp on a 3D line is fine — the
   * no-gradient rule is uikit's, not three's.
   */
  holoEdgeColors: ['#48dbfb', '#b84dff', '#ff4f81', '#48dbfb'] as readonly string[],
  /** Paint splats baked onto the glass corners, sRGB hex. Empty for none. */
  holoSplatColors: ['#b6ff3b', '#b84dff'] as readonly string[],

  // ---- Paint wells under the dabs ------------------------------------------
  /** Radius of a well's glowing rim as a multiple of dabRadius. */
  wellRimScale: 1.2,
  /** Tube radius of that rim, metres. */
  wellRimTube: 0.0011,
  /** Rim opacity for the dabs that are NOT loaded. */
  wellRimOpacity: 0.45,
  /** Rim opacity for the loaded dab — the obvious "this one" cue. */
  wellRimSelectedOpacity: 1,
  /** Soft colour pool under a dab: radius as a multiple of dabRadius. */
  wellGlowScale: 1.55,
  /** ...and its opacity (additive). */
  wellGlowOpacity: 0.2,
  /** The loaded dab's pool, brighter. */
  wellGlowSelectedOpacity: 0.42,
  /** Resting emissive on the liquid paint so it reads as lit from within. */
  dabEmissive: 0.16,
  /** How far the idle shimmer swings that emissive (0 = still). */
  dabPulseAmp: 0.1,
  /** Idle shimmer frequency, Hz. Slow: a breath, not a blink. */
  shimmerHz: 0.45,
  /** How far the shimmer swings the edge halo, as a fraction of its opacity. */
  shimmerEdgeAmp: 0.35,

  // ---- Holo sockets under chips and mode pads -----------------------------
  /** Socket ring radius as a multiple of the chip / pad radius. */
  socketRimScale: 1.25,
  /** Socket rim opacity, unselected / selected. */
  socketRimOpacity: 0.4,
  socketRimSelectedOpacity: 1,

  // ---- Appear animation -----------------------------------------------------
  /** Seconds of the pop-in when the palette (re)appears. 0 = no animation. */
  appearSec: 0.3,
  /** Scale the palette pops up from (then overshoots 1 slightly and settles). */
  appearFromScale: 0.35,
  /**
   * Seconds the left hand may be untracked before the palette hides (and so
   * pops back in when the hand returns). Long enough that a blink of lost
   * tracking mid-poke never hides it; a parked (poked) palette never hides.
   */
  hideAfterLostSec: 0.5,

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

  // ---- Launcher mode pads (round 8) -----------------------------------------
  /** Radius of one HAND / BLASTER / WEB pad, metres. 2.6 cm across: a fingertip target. */
  modePadRadius: 0.013,
  /** Pad thickness, metres. */
  modePadHeight: 0.006,
  /** Centre-to-centre spacing of the three pads, metres. */
  modePadSpacing: 0.036,
  /**
   * Where the pad row sits along the board's near-far axis (+ = near edge).
   * Between the dab arc and the chip labels.
   */
  modePadRowOffset: -0.014,
  /** Identity colours, HAND / BLASTER / WEB. */
  modePadColors: ['#b8c2cc', '#ff4fb8', '#48dbfb'] as readonly string[],
  /** Round 8: the pad body is dark glass; its accent lives in the rim, icon glow and selected emissive. */
  modePadBodyColor: '#141827',
  /** Size of the white icon printed on each pad, as a fraction of the pad diameter. */
  modePadIconScale: 0.62,

  // ---- Hand tracking (round 7) ----------------------------------------------
  //
  // The four offsets and the tilt above were tuned on controllers, in the grip
  // frame, and still drive the controller palette unchanged. A tracked hand's
  // grip frame is a quarter turn away from a controller's (its -Z points at
  // the thumb), which is why the palette stood on edge across the forearm in
  // hand mode — and a bare hand rolls freely, so "above the back of the hand"
  // ends up *under* the arm the moment you turn your palm up.
  //
  // So with hands the palette is posed in world terms instead: it floats
  // `handLift` metres straight UP from the wrist joint (whatever the roll),
  // nudged `handForward` toward the fingers, and turns its face to your eyes,
  // with its dab edge pointing the way your fingers do. Readable in every
  // pose; reachable by the other index finger.
  /** Metres straight up (world +Y) from the left wrist joint to the board centre. */
  // Round 8: 0.08 (was 0.06) so the board clears the gauntlet, which rides
  // the palm side of the forearm and so faces up at the board when palm-up.
  handLift: 0.08,
  /**
   * Metres along the forearm toward the fingers from the wrist joint. Out over
   * the hand rather than the wrist, so the board never covers the gauntlet's
   * selector pads (which ride the forearm just behind the wrist).
   */
  handForward: 0.11,
  /**
   * Metres sideways, away from the body (to the left of a left forearm), so
   * the board clears the gauntlet's selector pads. 0 sits it over the wrist.
   */
  handOutward: 0.03,
  /**
   * Pinch-to-select reach, metres from the pinch point to a dab, chip or pad
   * centre. Tighter than {@link grabSelectRadius}: a fingertip pinch is a
   * precise point, a controller's grip origin is not.
   */
  pinchSelectRadius: 0.045,

  // ---- Hold still while I poke you (round 7) --------------------------------
  //
  // Meta's hands UI guidance: "Do not anchor menus to the user's wrist... a
  // menu that follows the wrist is hard to use because it shifts position while
  // the other hand tries to poke it." So the palette now **parks in world space
  // the moment the other hand's fingertip comes near**, and only rejoins the
  // wrist once that fingertip has left. You aim at a still target; the board
  // never visibly detaches unless you move the palette arm mid-poke.
  /**
   * Metres from the palette centre at which the other hand's index fingertip
   * (or controller) parks the palette in place.
   */
  lockRadius: 0.16,
  /** Seconds the fingertip must stay outside `lockRadius` before the palette lets go. */
  lockReleaseSec: 0.35,
  /**
   * Time constant, seconds, of the glide back onto the wrist after a park, so
   * re-attaching is a quick slide rather than a snap.
   */
  reattachSec: 0.06,
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
   * Only **vertical** planes and (round 9) ceilings are thickened. Floors are
   * left on `Auto`: a floor already has FloorGuardSystem's half-metre slab a
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
   * Round 9: a horizontal plane at least this high (metres above the floor),
   * or one labelled `ceiling`, is treated as a ceiling and given the same
   * thickened box ({@link ROOM.wallThicknessMeters}) walls get, so high lobs
   * stop tunnelling through the 1 mm plane. Floors and table tops stay on
   * `Auto` (FloorGuard covers the floor). Above any standing head on purpose.
   */
  ceilingMinHeightMeters: 1.9,

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
  /**
   * Status line shown under the HUD while chilling. ASCII only (MSDF font).
   * Names the pinch as well as the trigger: a hands-only player has no trigger
   * to hold, and holding a pinch sprays exactly the same way.
   */
  statusText: 'Hold trigger or pinch to spray. Tap the palette to change paint.',
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
  /**
   * Metres in front of the head the easel is planted on entering Chill.
   * Round 9: 0.7 (was 1.4, out of reach seated). 0.7 puts the board at a
   * comfortable seated arm's reach for grabbing, and the docked HUD
   * (HUD.playOffset, 0.95 m out and 0.52 m down) stays behind and below it.
   */
  spawnDistance: 0.7,
  /**
   * Round 9: the board's centre is planted this far below the eyes (0 = at
   * eye height), for a seated (~1.2 m) and a standing (~1.6 m) player alike.
   * The limit is the docked HUD: it rides 0.95 m ahead of the head and its
   * top edge is ~0.35 m below the eyes, so if the player leans in to paint it
   * swings into the easel's depth. The board's bottom edge must stay above
   * that top edge in BOTH orientations (portrait is 0.62 m tall: 0 leaves
   * ~4 cm, landscape ~11 cm). Raise past ~0.03 only if the HUD moves down.
   */
  boardBelowEyes: 0,
  /** Lowest the board centre is ever planted, metres (floor-seated players). */
  boardCentreMinHeight: 0.85,
  /** Highest the board centre is ever planted, metres (tall standing players). */
  boardCentreMaxHeight: 1.8,
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
  /**
   * Height of the board's centre above the floor, metres — the fallback when
   * no head pose is available. Normally {@link EASEL.boardBelowEyes} decides.
   */
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
  /**
   * Time constant, seconds, of the smoothing on the easel's drawn pose while
   * it is being grabbed (round 7). Two tracked hands tremble independently;
   * on a 60 cm board that read as jitter. ~70 ms reads as the easel having a
   * little weight. 0 disables.
   */
  grabSmoothingSec: 0.07,
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
 * same HUD-swallowing rule and the same spray-on-hold in Chill), a FLICK hand
 * gesture (off by default since round 9), and a forward thrust of the hand. Every web ball trails a strand
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
  // ---- The shooters on your forearms (round 7) -----------------------------
  //
  // Rounds 4-6 posed the shooter off the raw WebXR grip space and assumed its
  // -Z was "where the hand points". For a tracked hand the spec defines grip -Z
  // as *toward the thumb*, so the device sat across the wrist and webs flew out
  // sideways — the round-7 field report ("perpendicular to the wrist instead of
  // parallel and aligned with the forearm"). Every number below now lives in
  // the **aim frame** built by `src/wrist-pose.ts`: -Z is exactly the direction
  // a web travels, +Y is the back of the hand, +X is pinky-side on the right
  // hand (mirrored for the left). The shooter is a gauntlet whose long axis IS
  // that -Z, so what you see is where it shoots, by construction.
  /**
   * Where a tracked hand's aim comes from.
   *
   * - `'ray'` (default): the OS target ray. On Quest this is the same
   *   shoulder-through-hand pointer the system UI uses, already filtered, so it
   *   stays steady when you bend your wrist back into the classic web-shooter
   *   pose and lines up with your forearm when the arm is extended.
   * - `'hand'`: the hand's own wrist-to-knuckles axis. Shoots exactly where
   *   the back of the hand points; a bent-back wrist then aims high.
   *
   * Controllers always aim along their own ray (the direction the trigger has
   * always fired), whatever this says.
   */
  handAimSource: 'ray' as 'ray' | 'hand',
  /**
   * With `handAimSource: 'ray'`, how far (degrees) the OS ray may stray from
   * the hand's own axis and still be used outright. The system ray is a
   * pointer: it stays out in front of you even when you turn your hand up to
   * look at it, which would peel the gauntlet off your forearm. Past
   * `rayBlendFarDeg` the hand's axis takes over; smoothstep in between.
   */
  rayBlendNearDeg: 30,
  /** @see rayBlendNearDeg */
  rayBlendFarDeg: 65,
  /**
   * Controllers have no wrist joint: metres from the grip origin back up the
   * forearm to where the wrist is assumed to be. Hands use the real joint.
   */
  controllerWristBack: 0.07,
  /**
   * Time constant, seconds, of the smoothing on the shooter's pose — and on
   * the direction webs fire, which is read off the smoothed device so the shot
   * always leaves along the barrel you can see. 0 disables it. Around 30 ms
   * kills hand-tracking shimmer without a perceptible lag.
   */
  shooterSmoothingSec: 0.03,
  /**
   * A palm that moves further than this in one frame (metres) is treated as a
   * hand that dropped out and came back, not as motion: the velocity sample,
   * the thrust window and the pose smoothing all restart. 30 cm in ~14 ms is
   * over 20 m/s — no real hand does that, but a reacquired one does, and
   * without this it read as a thrust (a spurious shot) or a huge haul.
   */
  reacquireJumpMeters: 0.3,
  /**
   * Length of the gauntlet along the forearm, metres (body + straps, nozzle
   * excluded). Also the cap {@link fitShooterScale} applies to an optional GLB.
   */
  shooterLengthMeters: 0.11,
  /**
   * Forearm diameter the straps are sized to, metres. 7.5 cm is a generous
   * adult wrist with the strap standing a little proud of it. Deliberately a
   * constant: do NOT measure the player's hand at runtime — joint spans are
   * noisy and this has to look right on frame one.
   */
  shooterBandMeters: 0.075,
  /**
   * Swap the code-built gauntlet for `public/gltf/web-shooter.glb`. Off since
   * round 7: the shipped GLB is a *ring* cuff, which by design cannot lie
   * along the forearm. A replacement must be authored long axis = model -Z,
   * nozzle at the -Z end, top (back of the hand) = +Y; it is measured and
   * rescaled at runtime, and the three mount angles below can correct an
   * exporter's axes without touching code.
   */
  shooterUseGlb: false,
  /** Mount yaw (degrees) applied to the model inside its holder. 0 for the gauntlet. */
  shooterYawDeg: 0,
  /** Mount pitch about the holder's X, degrees. Tips the nozzle up or down. */
  shooterPitchDeg: 0,
  /**
   * Mount roll about the forearm, degrees — spins the device round the arm.
   * 0 puts the glowing cartridge on the palm side, facing you in the palm-up
   * pose people adopt to look at their wrist.
   */
  shooterRollDeg: 0,
  /** Metres toward the pinky side, in the RIGHT hand's aim frame. Left mirrors. */
  shooterOffsetX: 0.0,
  /**
   * Metres along the aim frame's Y from the wrist joint. **Negative**: the
   * device rides the underside (palm side) of the forearm, the way a web
   * shooter is worn — out of the way of the hand when the wrist bends back.
   */
  shooterOffsetY: -0.034,
  /**
   * Metres along the aim frame's Z from the wrist joint. **Positive**, i.e.
   * back up the forearm: the body sits on the arm and only the nozzle reaches
   * the wrist crease.
   */
  shooterOffsetZ: 0.05,
  /**
   * The nozzle tip, in the shooter holder's own (aim-aligned) frame, metres.
   * Both the web's spawn point and the strand's near end come from here.
   * Round 8: the spinneret (GauntletSystem) puts its chrome needle's tip here
   * — housing, collar, glowing cartridge, needle, all on this axis.
   */
  muzzleLocal: [0, 0, -0.082] as [number, number, number],
  /** Metres past the nozzle that a web ball is born, so it clears the hand. */
  muzzleOffset: 0.09,

  // ---- Webs in flight (round 7) --------------------------------------------
  /**
   * Launch speed of webbing relative to paint ({@link FIRE.speed}). A web
   * should *zip*; at paint speed a tether arced so far under a robot that it
   * mostly missed.
   *
   * **Capped by the walls, not by feel.** There is no CCD (gotcha 6): one
   * Havok step at 72 Hz must not carry a ball further than the wall capture
   * band, `ROOM.wallThicknessMeters + 2 * BALLS.radius` (14 cm). 1.15 is
   * 13.6 cm per step; R7's first cut at 1.45 (17 cm) let one head-on web in
   * five pass straight through a wall. The flat, fast *look* comes mostly from
   * {@link webGravityFactor}. A test pins this.
   */
  webSpeedMult: 1.15,
  /**
   * Gravity factor on webbing (paint is 1). Low, so a web flies close to where
   * the barrel points — the "line" reading of a web — without becoming a
   * laser that never lands.
   */
  webGravityFactor: 0.35,
  /**
   * Aim assist on webbing, degrees: a shot within this cone of a live robot is
   * bent onto the arc that hits it. Wider than paint's
   * ({@link FIRE.aimAssistDeg}) because a tether that just misses is the most
   * frustrating miss in the game. 0 disables.
   */
  aimAssistDeg: 9,

  // ---- FLICK gesture (hand tracking; was "THWIP" before the round 9 rebrand)
  /**
   * Master switch for the joint-driven finger-curl gesture (middle + ring
   * curled, index + pinky out). The trigger/pinch and the thrust are
   * unconditional; this only gates the finger-curl classifier.
   *
   * Round 9: **off by default.** The pose reads as the rock / "devil horns"
   * sign, it misfires on relaxed hands, and the curl-to-shoot hand sign leaned
   * on a famous comic-book web-slinger the rebrand steers well clear of.
   * Pinch/trigger and the thrust still fire everything; flip this to true to
   * bring the gesture back.
   */
  gestureEnabled: false,
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
   * what separates a flick from a fist.
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
  /**
   * GOO (round 9): strands take the player's loaded paint colour
   * (globals.activeColor) instead of plain white, so the goo reads as paint
   * pulled into sticky strings. false restores the white thread.
   */
  gooUsesPaintColor: true,
  /**
   * How far a TETHER line is lifted toward white over the paint colour, 0..1.
   * A held line sits a touch brighter than a flying strand so "this one is
   * hooked" still reads at a glance. 0 = same as the strand, 1 = white.
   */
  gooTetherLift: 0.35,

  // ---- The paint -----------------------------------------------------------
  /** Web splat decals held before the pool recycles. Its own pool, not SPLAT's. */
  splatCapacity: 192,
  /** Size multiplier on a web splat versus a paint splat. Webs spread wider. */
  splatSizeMult: 1.6,

  // ---- TETHER WEB (round 6, reworked round 7) -------------------------------
  //
  // A second thing web ammo can be, chosen on the wrist selector or with the
  // right controller's B button. A tether web flies like a splat web, but a
  // robot it touches gets LATCHED instead of damaged. Then you reel it in and
  // it pops when it reaches you.
  //
  // Round 6 reeled in fixed 0.55 m chunks on a fast yank, and the robot
  // *teleported* each chunk — the "hook feels janky" report. Round 7 replaces
  // that with a queue: every way of hauling adds metres of line to a per-hand
  // queue, and the robot glides along the line at up to `reelGlideSpeed`.
  // Three ways to haul, all live at once:
  //   1. PULL — move the hand away from the robot; line comes in proportionally
  //      (a ratchet: the recovery stroke toward the robot is free);
  //   2. PINCH or TRIGGER held on the hand that owns the line (that hand stops
  //      firing while it holds a tether — the press reels instead);
  //   3. SQUEEZE held (controllers).
  /**
   * Metres from the player's **head** at which a reeled-in robot pops.
   * Off the head rather than the hand: an arm held out at full stretch would
   * otherwise pop things that are still most of a room away.
   */
  tetherKillRadius: 0.7,
  /**
   * Seconds a tether may stay attached before it lets go on its own. A safety
   * valve, not a mechanic: a latched robot never respawns, so a line nobody
   * reels would quietly shrink the round.
   */
  tetherMaxSec: 8,
  /**
   * A pinch or trigger press on the tethered hand that **starts** after the
   * line latched and is released within this many milliseconds lets go of the
   * line instead of reeling (round 7). Holding reels; tapping releases — the
   * same verb for hands and controllers, and the controller player's only
   * deliberate release (their hand cannot fire while it holds a line).
   */
  releaseTapMs: 250,
  /**
   * Extra metres added to a robot's hit radius for **tether** webs only. A
   * line that brushes a robot should catch it; a paint ball that brushes one
   * should not score.
   */
  tetherLatchBonus: 0.12,
  /**
   * Hand speed away from the robot, m/s, ignored as tracking noise before the
   * pull ratchet takes in any line. Subtracted rather than gated, so hauling
   * ramps in smoothly.
   */
  pullDeadband: 0.2,
  /** Metres of line per metre of pull. 2.2: a 30 cm haul brings it ~65 cm. */
  pullGain: 2.2,
  /** Metres per second the line comes in while a pinch, trigger or squeeze is held. */
  reelSpeed: 1.8,
  /**
   * Fastest the robot travels along the line, m/s, while it works through the
   * queued haul. This is the knob that turns a big pull into a glide instead
   * of a jump.
   */
  reelGlideSpeed: 4.5,
  /**
   * Most line, metres, that may be queued but not yet travelled. Caps how far
   * a robot keeps gliding after the player stops hauling — a burst of frantic
   * pulling should not carry it on for a second afterwards.
   */
  reelQueueMax: 1.2,
  /**
   * Minimum milliseconds between TetherReeled events (each is a light rumble
   * on the hauling hand). Reeling is continuous now, and a buzz every frame
   * would numb the hand rather than read as a ratchet.
   */
  reelFeedbackMs: 110,
  /**
   * Radians of side-to-side struggle on a robot while it is on the line. Pure
   * readability: a hooked robot should look hooked.
   */
  tetherStruggleRad: 0.22,
  /** Struggle oscillation, Hz. */
  tetherStruggleHz: 7,

  // ---- The wrist selector gadget -------------------------------------------
  //
  // Two mini pads on the LEFT gauntlet's palm-side face, parented into its
  // holder so they ride the forearm exactly as the device does. Poke one,
  // pinch or squeeze near one, or press B. They only exist while web ammo is
  // loaded — with paint on the palette there is no sub-mode to choose.
  //
  // Round 7: everything here is in the shooter holder's frame (the aim frame,
  // origin at the device centre), not the grip's. -Y is the palm side, which
  // is the side facing the player when they turn the forearm palm-up to look.
  /** Half-height of one pad, metres. Big enough to poke, small enough to wear. */
  selectorPadMeters: 0.022,
  /** Gap between the two pads, metres. */
  selectorPadGap: 0.008,
  /**
   * Metres along the holder's Y. Negative = palm side, and further out than
   * the gauntlet body (radius ~1.6 cm) so the pads float clear of it rather
   * than inside the model the player is trying to poke.
   */
  selectorOffsetY: -0.03,
  /**
   * Metres along the holder's Z. Slightly up the forearm from the device
   * centre, so a fingertip reaching for a pad never crosses the nozzle.
   */
  selectorOffsetZ: 0.012,
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
  /** The GOO launcher going off. Non-positional — it happens at your wrist. */
  flick: '/audio/flick.mp3',
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
  /** The GOO launch. Loud: it is the whole point of the mode. */
  flick: 0.55,
  /** Webbing landing. Level with the paint splat it replaces. */
  webHit: 0.5,
  /**
   * Round 8: a Squeegee's shield bouncing a shot (the UI tick, positional at
   * the blade). Quiet — it is a "nope", not a reward.
   */
  shieldPing: 0.45,
  /**
   * Round 8: Duster Duke starts his entrance drop (the countdown blip, as a
   * "heads up"). Non-positional so it is heard wherever you are looking.
   */
  bossEnter: 0.75,
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
   * GOO launch should feel like a snap, not the soft thud of a paintball leaving.
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
  /**
   * Round 9: real-world depth occlusion for the Splotbots ONLY — a robot
   * behind your real couch is hidden by it (Peekaboo actually hides). Uses
   * IWSDK's DepthSensingSystem + DepthOccludable; the `depth-sensing` session
   * feature is requested as OPTIONAL, so a device without depth just shows
   * robots unoccluded (no failure). Never applied to the instanced splats or
   * balls (gotcha 20: the occlusion shader ignores instanceMatrix). false
   * skips the system entirely.
   */
  depthOcclusion: true,
  /** Depth data path requested from the browser (Quest supports GPU). */
  depthUsage: 'gpu-optimized' as 'gpu-optimized' | 'cpu-optimized',
  /** Depth data format requested from the browser. */
  depthFormat: 'float32' as 'float32' | 'luminance-alpha',
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

/**
 * Gauntlet blasters (round 8): the skins the Armory offers. The gauntlet
 * system tints its trim, glow seams and canister rim from the selected entry;
 * the Armory lists `name`. Order is the stored index — append, never reorder,
 * or players' saved choice changes under them.
 */
export interface BlasterSkin {
  /** ASCII caps, shown in the Armory (gotcha 24). */
  readonly name: string;
  /** Glow seams, nozzle ring and canister rim, `#rrggbb` (sRGB). */
  readonly accent: string;
  /** Secondary trim, `#rrggbb`. */
  readonly trim: string;
  /** Shell panels, `#rrggbb`. */
  readonly shell: string;
}

export const BLASTER = {
  /**
   * localStorage key holding the selected skin index. Round 9 rebrand: reads
   * fall back to the pre-rebrand `paintblast.blasterSkin` and copy it forward.
   */
  skinStorageKey: 'splotopia.blasterSkin',
  skins: [
    { name: 'NEON CORAL', accent: '#ff4f81', trim: '#ffb347', shell: '#ecebe6' },
    { name: 'CYBER LIME', accent: '#b6ff3b', trim: '#3bf0ff', shell: '#e6ece6' },
    { name: 'ULTRAVIOLET', accent: '#b84dff', trim: '#ff4fd8', shell: '#e9e6ef' },
    { name: 'CHROME ICE', accent: '#48dbfb', trim: '#ffffff', shell: '#d7dde3' },
    { name: 'GOLD RUSH', accent: '#ffd23f', trim: '#ff7a3d', shell: '#2a2c33' },
  ] as ReadonlyArray<BlasterSkin>,

  // ---- The hardware (round 8, GauntletSystem) ------------------------------
  //
  // Two pieces per arm. A forearm BRACER posed in the aim frame (-Z = where
  // shots go, +Y = back of the hand, origin at the wrist joint) carrying the
  // paint barrel + canister on top (BLASTER mode) or the web spinneret
  // underneath (WEB mode; its offsets are WEB.shooterOffset*). And a
  // back-of-hand PLATE posed in the hand's own wrist frame, so it rides the
  // hand while the fingers stay free. HAND mode shows neither.
  //
  // X values are declared for the RIGHT hand and mirrored for the left.
  /**
   * Seconds for the gauntlet to deploy or stow when the mode changes. The
   * panels slide, unfold and scale in over this; shots are never blocked by it.
   */
  transitionSec: 0.3,
  /**
   * BLASTER perk: hold the trigger / pinch to keep firing, one ball per this
   * many milliseconds, in every phase where firing is allowed. (Chill already
   * sprays; the shorter of the two cooldowns wins there.) Ball speed is still
   * FIRE.speed — the wall-tunnelling cap (gotcha 22) does not move.
   */
  autoFireCooldownMs: 150,
  /**
   * The paint barrel's muzzle, metres, in the aim frame at the wrist joint
   * (+Y = over the back of the wrist, -Z = toward the fingers). Trigger,
   * pinch, flick and thrust shots in BLASTER mode all leave from here.
   */
  muzzleLocal: [0, 0.058, -0.014] as [number, number, number],
  /**
   * Metres past the muzzle that a paint ball is born, so it clears the barrel
   * and the knuckles. Smaller than FIRE.muzzleOffset because the barrel
   * already sits forward of the hand.
   */
  muzzleOffset: 0.05,
  /**
   * The back-of-hand plate's centre in the WRIST-JOINT frame (tracked hands):
   * +Y out of the back of the hand, -Z toward the knuckles.
   */
  plateOffsetHand: [0, 0.021, -0.048] as [number, number, number],
  /**
   * The same for controllers, whose "wrist" is assumed WEB.controllerWristBack
   * behind the grip: the plate sits over the back of the hand holding it.
   */
  plateOffsetController: [0, 0.036, -0.062] as [number, number, number],
  /**
   * Controllers are held thumb-up, so the anatomical back of the hand faces
   * outward and a barrel "over the wrist" would stick out sideways. Rolls the
   * controller hardware (bracer, barrel, spinneret — not the hand plate) about
   * the forearm by this many degrees (right hand; mirrored for the left). 90
   * brings the barrel up over the thumb side and the spinneret underneath;
   * 0 keeps it anatomical (barrel pointing out sideways).
   */
  controllerRollDeg: 90,
  /** Metres the barrel kicks back up the forearm on each shot. */
  recoilMeters: 0.012,
  /** Degrees the barrel tips up on each shot. */
  recoilPitchDeg: 6,
  /** Time constant, seconds, of the recoil settling back. */
  recoilDecaySec: 0.07,
  /** Peak size multiplier of the muzzle glow pulse on a shot. */
  muzzleFlashScale: 1,
  /** Canister swirl, revolutions per second at rest (doubles briefly per shot). */
  canisterSwirlHz: 0.35,
  /** Canister glow breathing, Hz. Cheap: one shared-material write per frame. */
  canisterPulseHz: 0.6,
  /** Volume of the mode-change cue (deploying reuses the chime, stowing the UI click). */
  modeSwitchVolume: 0.32,
  /** Haptic pulse on both hands when the mode changes. */
  modeSwitchHapticIntensity: 0.35,
  modeSwitchHapticMs: 45,
} as const;

/**
 * The enter-AR intro (round 8): the first time a session becomes visible, the
 * SPLOTOPIA logo bursts out of a paint splat ~1.5 m in front of you, a ring of
 * neon splats flies out, the tagline lands, then the whole thing lifts away
 * and the title HUD takes over. Any pinch or trigger skips it. Times are
 * seconds from the moment it starts.
 */
export const INTRO = {
  /** Master switch. false = no intro, the title HUD shows immediately. */
  enabled: true,
  /** Seconds after the session turns visible before it starts (tracking settles). */
  startDelaySec: 0.45,
  /** Metres in front of the head, along the floor-level gaze direction. */
  distance: 1.5,
  /** Metres above eye height of the logo centre. Slightly up reads as a title. */
  heightOffset: 0.06,
  /** Logo width, metres (height follows the texture's aspect). */
  logoWidth: 1.15,
  /** Width of the paint splat the logo bursts out of, metres. */
  splatWidth: 1.6,
  /** Opacity of the three neon splat layers (the dark ink layer behind the logo is fixed). */
  splatOpacity: 0.85,
  /** Splat reveal: starts at 0, full size after this long. */
  splatInSec: 0.32,
  /** When the logo starts popping in, and how long the pop takes. */
  logoStartSec: 0.1,
  logoInSec: 0.55,
  /** easeOutBack overshoot of the logo pop. 0 = no bounce; 2+ = cartoon. */
  logoOvershoot: 2.2,
  /** Tagline under the logo: when it fades up, and how long that takes. */
  taglineStartSec: 0.8,
  taglineInSec: 0.4,
  /** ASCII; drawn into a texture at runtime. */
  tagline: 'YOUR ROOM IS THE ARENA',
  /** When the exit starts on its own (the hold ends). */
  exitStartSec: 2.7,
  /** Exit length when it plays out, and when a pinch / trigger skips it. */
  exitSec: 0.75,
  skipExitSec: 0.35,
  /** Ignore skips this early, so a pinch already in flight cannot eat the reveal. */
  skipLockSec: 0.25,
  /** Metres the logo rises while it fades out, and the scale it shrinks to. */
  exitRise: 0.45,
  exitScale: 0.55,
  /** Shockwave ring: final radius (metres) and how long it lasts. */
  ringRadius: 0.95,
  ringSec: 0.6,
  /** Neon splats flung out of the burst. 0 = none. */
  particleCount: 56,
  particleSpeedMin: 0.9,
  particleSpeedMax: 2.3,
  /** Splat sizes, metres. */
  particleSizeMin: 0.035,
  particleSizeMax: 0.09,
  particleLifeMin: 0.8,
  particleLifeMax: 1.4,
  /** Linear drag, 1/s: the burst decelerates instead of flying off forever. */
  particleDrag: 2.4,
  /** Downward pull, m/s^2, so the splats arc like paint. */
  particleGravity: 0.9,
  /** Burst colours (sRGB hex): coral, amber, cyan, lime, violet. */
  colors: ['#ff4f81', '#ffd23f', '#48dbfb', '#b6ff3b', '#b84dff'] as readonly string[],
  /** Hide the title HUD while the logo is up (both sit straight ahead). */
  hideHud: true,
  /** Fraction of the exit after which the HUD reappears. */
  hudRevealAt: 0.4,
  /** Sounds (existing files) and their volumes. 0 mutes one. */
  whooshSrc: '/audio/fire.mp3',
  whooshVolume: 0.55,
  splatSrc: '/audio/splat.mp3',
  splatVolume: 0.9,
  chimeSrc: '/audio/chime.mp3',
  chimeVolume: 0.5,
} as const;

/**
 * One Splotbot character's tuning (round 8). Every archetype in
 * SPLOTBOTS.archetypes has the same shape so TargetSystem can treat the cast
 * as data: which art, how big, how tough, what it is worth, and how it idles.
 */
export interface SplotbotArchetypeConfig {
  /** AssetManifest key for this character's GLB (main.ts registers it). */
  readonly assetKey: string;
  /**
   * Model URL. Background-loaded: until it arrives (or if it is missing) the
   * slot wears robot.gltf, and the next Countdown swaps the real art in — so
   * dropping a new GLB at this path never needs a code change.
   */
  readonly url: string;
  /** How many pool slots are built as this character. Sum = TARGETS.poolSize. */
  readonly pool: number;
  /** Finished height, metres. The GLB is measured and rescaled to this. */
  readonly heightMeters: number;
  /** Hit-sphere radius as a fraction of the model's largest half-extent. */
  readonly hitRadiusScale: number;
  /** Hits to pop. */
  readonly hp: number;
  /** Base points for a pop, before the combo multiplier. */
  readonly points: number;
  /**
   * Degrees to turn the model so its face screen looks down the robot's +Z
   * (which TargetSystem then aims at the player). Meshy's facing is not
   * fixed: 0 if the GLB faces +Z, 180 if it faces -Z, +/-90 if sideways.
   */
  readonly yawOffsetDeg: number;
  /** How fast it turns to face you, 1/s (exponential ease). 0 = never turns. */
  readonly faceRate: number;
  /** Vertical hover amplitude, metres (the shared TARGETS.bobHz bob). */
  readonly bobAmplitude: number;
  /** Idle sway (rock about the facing axis), radians peak. */
  readonly swayRad: number;
  /** Idle sway cycles per second. */
  readonly swayHz: number;
}

/**
 * The Neatniks (round 8 "Splotbots", renamed round 9; identifiers keep the old
 * name): the cast of cleaning robots that replaced the
 * generic robot. Roles and behaviours are the art bible's
 * (docs/COMPETITION_PLAN.md section 6):
 *
 * - **Mopsy**: the basic hover target, most common. Skirt-sway bob.
 * - **Squeegee**: carries a wiper-blade shield and always turns to face you.
 *   A shot into its front cone pings off with no damage unless the ball has
 *   already bounced off something (BOUNCY off a wall), is a TETHER web, or is
 *   SPLASH ammo. Flank it, bank it, or hook it.
 * - **Peekaboo**: hides behind your real furniture (bounded scene meshes on
 *   the far side from you) and periscopes up for a moment; only hittable while
 *   up. With no furniture scanned it peeks up from low spawn heights.
 * - **Duster Duke**: the boss. Drops in for the last stretch of a round,
 *   takes six hits, stomps and sways, and splits into two Mopsys when popped.
 *   A tether haul takes `boss.tetherDamage` HP off instead of killing him.
 * - **Pip**: the palette-drone mascot. Never shot; hovers beside the HUD in
 *   menus and flies off while you play (PipSystem).
 */
export const SPLOTBOTS = {
  archetypes: {
    mopsy: {
      assetKey: 'splotbotMopsy',
      url: '/gltf/splotbots/mopsy.glb',
      pool: 7,
      heightMeters: 0.32,
      hitRadiusScale: 1.0,
      hp: 1,
      points: 100,
      yawOffsetDeg: 0,
      faceRate: 3,
      bobAmplitude: 0.08,
      swayRad: 0.12,
      swayHz: 0.9,
    },
    squeegee: {
      assetKey: 'splotbotSqueegee',
      url: '/gltf/splotbots/squeegee.glb',
      pool: 3,
      heightMeters: 0.42,
      hitRadiusScale: 0.95,
      hp: 1,
      points: 150,
      yawOffsetDeg: 0,
      // Snappy: the shield has to be in your face to be a puzzle.
      faceRate: 6,
      bobAmplitude: 0.05,
      swayRad: 0.05,
      swayHz: 0.6,
    },
    peekaboo: {
      assetKey: 'splotbotPeekaboo',
      url: '/gltf/splotbots/peekaboo.glb',
      pool: 3,
      heightMeters: 0.55,
      hitRadiusScale: 0.85,
      hp: 1,
      points: 200,
      yawOffsetDeg: 0,
      faceRate: 4,
      bobAmplitude: 0.02,
      swayRad: 0.1,
      swayHz: 1.3,
    },
    duke: {
      assetKey: 'splotbotDuke',
      url: '/gltf/splotbots/duster-duke.glb',
      pool: 1,
      heightMeters: 0.75,
      hitRadiusScale: 0.8,
      hp: 6,
      points: 600,
      yawOffsetDeg: 0,
      // Heavy: turns like a wardrobe on castors.
      faceRate: 1.5,
      bobAmplitude: 0,
      swayRad: 0.09,
      swayHz: 0.45,
    },
  } satisfies Record<string, SplotbotArchetypeConfig>,

  /**
   * Robot "lanes" across TARGETS.spawnArcDeg. Each spawn takes the emptiest
   * lane, so the cast stays spread across the arc whatever mix is alive.
   * More lanes = finer spread; fewer than a wave's maxAlive bunches robots.
   */
  lanes: 5,
  /** Seconds between two spawns when several slots are free at once. */
  spawnStaggerSec: 0.45,
  /**
   * Round 9: rest beat at every wave boundary (after the first wave), seconds.
   * No new robots spawn for this long once a wave starts, so arms get a
   * breather (comfort / gorilla arm). Robots already up stay up. 0 disables.
   */
  waveBreatherSec: 3,
  /**
   * Round 9: seconds a robot let off a tether (tap or timeout) takes to drift
   * back out to at least ROOM.spawnMinDist from your head, instead of
   * hovering in your face. Duster Duke uses boss.returnSec instead.
   */
  releaseReturnSec: 1.0,

  /**
   * Wave composition by round time. Each wave starts `startSec` seconds into
   * the round and lasts until the next one; `weights` is the chance of each
   * new spawn being [mopsy, squeegee, peekaboo] (any scale, normalised).
   * `maxAlive` is how many robots it keeps up (capped by TARGETS.maxConcurrent).
   */
  waves: [
    // Warm-up: only Mopsys, so the first thing anyone learns is "point, pinch, pop".
    { startSec: 0, maxAlive: 3, weights: [1, 0, 0] },
    // The cast arrives: shields and peekers join.
    { startSec: 22, maxAlive: 4, weights: [0.55, 0.25, 0.2] },
    // Mixed pressure until the boss.
    { startSec: 48, maxAlive: 4, weights: [0.4, 0.3, 0.3] },
  ] as ReadonlyArray<SplotbotWave>,

  boss: {
    /**
     * Duster Duke drops in when this many seconds are left on the round
     * clock (once per round). 0 disables the boss.
     */
    enterAtSecLeft: 20,
    /** Other robots kept alive alongside the boss (his split Mopsys excluded). */
    companionsMax: 2,
    /** Metres from the player's head the Duke lands, down the arc's middle. */
    distance: 2.0,
    /**
     * Height of the Duke's centre above the floor once landed, metres. Half
     * his height = feet on the floor; raise it to float him over a coffee table.
     */
    standHeight: 0.4,
    /** Metres above its landing spot the entrance drop starts from. */
    dropHeight: 1.6,
    /** Seconds the drop takes (ease-in, like falling). Not hittable meanwhile. */
    dropSec: 0.55,
    /** Landing squash: peak vertical compression (0.3 = 30% shorter). */
    landSquash: 0.3,
    /** Footstep stomps per second while idling. */
    stompHz: 1.1,
    /** Height of each stomp hop, metres. */
    stompLift: 0.035,
    /** HP a tether haul takes off the Duke instead of popping him. */
    tetherDamage: 2,
    /** Seconds the Duke takes to stomp back to his spot after a haul. */
    returnSec: 1.2,
    /** Sideways distance between the two Mopsys he splits into, metres. */
    splitSpread: 0.55,
  },

  shield: {
    /**
     * Full width of Squeegee's blocking cone, degrees, around the way it
     * faces. A shot arriving inside it is deflected. 140 = most frontal shots;
     * lower it to make flanking easier.
     */
    coneDeg: 140,
    /** Fraction of the incoming speed a deflected ball keeps. */
    deflectRestitution: 0.55,
    /** Upward kick added to a deflected ball, m/s, so the ping visibly arcs. */
    deflectLift: 1.2,
    /**
     * Hard cap on a deflected ball's speed, m/s. Must stay under 72 x 14 cm
     * (~10 m/s) or a bounced ball tunnels walls (CLAUDE.md gotcha 22); a test
     * pins it.
     */
    maxDeflectSpeed: 9,
    /** Seconds the same ball is ignored by the shield it just bounced off. */
    immunitySec: 0.4,
    /** Seconds of the shield's cyan "ping" flash. */
    flashSec: 0.22,
    /** Recoil tilt of a deflecting Squeegee, radians. */
    recoilRad: 0.35,
    /** Guard-stance lean of the whole body toward you, radians. */
    guardTiltRad: 0.08,
  },

  peek: {
    /** Seconds hidden before each peek. */
    hiddenSec: 1.6,
    /** Random extra hidden time, 0..this, so peekers do not sync up. */
    hiddenJitterSec: 1.2,
    /** Seconds a peek holds at the top. The art bible's tell: ~1.5 s. */
    upSec: 1.5,
    /** Seconds to rise (and to duck back down). */
    riseSec: 0.28,
    /** Lift fraction (0 hidden .. 1 up) above which it can be hit. */
    hittableLift: 0.6,
    /** How far above the furniture's top a peek raises its centre, metres. */
    peekAbove: 0.18,
    /** Metres behind the furniture's far face the hiding spot sits. */
    behindMargin: 0.22,
    /**
     * Round 9: two Peekaboos never hide closer than this, metres. A second
     * one slides sideways along the furniture, or picks another piece.
     */
    minSpacing: 0.3,
    /** Furniture whose top is lower than this (metres) is ignored (rugs). */
    furnitureMinTop: 0.35,
    /** Furniture whose top is higher than this is ignored (wardrobes). */
    furnitureMaxTop: 1.4,
    /** Hidden centre height with no furniture to hide behind, metres. */
    lowHideY: 0.3,
    /** Rise of a no-furniture peek, metres. */
    lowPeekRise: 0.5,
    /** Periscope wobble while up, radians peak. */
    wobbleRad: 0.14,
  },

  anim: {
    /** Seconds of the spawn pop-in (overshoot scale + spin). */
    spawnSec: 0.45,
    /** Overshoot of the pop-in (easeOutBack's s). 1.7 = classic, higher = boingier. */
    spawnOvershoot: 2.2,
    /** Full turns the pop-in spins through. */
    spawnSpinTurns: 1,
    /** Seconds a hit squash-and-stretch rings for. */
    hitSec: 0.4,
    /** Peak vertical squash of a hit (0.28 = 28% shorter, wider to match). */
    hitSquash: 0.28,
    /** Squash wobble cycles per second. */
    hitWobbleHz: 7,
    /** Peak brightness of the white hit flash (added emissive, linear). */
    hitFlashIntensity: 1.6,
    /** Pop: fraction of TARGETS.popDurationSec spent squashing before the shrink. */
    popSquashFrac: 0.35,
    /** Pop: full turns spun through the shrink. */
    popSpinTurns: 1.25,
  },

  /** Pip, the mascot drone (PipSystem). Never shot, never blocks shots. */
  pip: {
    assetKey: 'splotbotPip',
    url: '/gltf/splotbots/pip.glb',
    /** Pip's size (largest dimension), metres. */
    sizeMeters: 0.22,
    /** Same meaning as the archetypes' yawOffsetDeg: turns the face to +Z. */
    yawOffsetDeg: 0,
    /** Metres from the HUD panel's left edge out to Pip's centre. */
    besidePanel: 0.1,
    /** Metres above the panel's centre line. */
    abovePanel: 0.1,
    /** Metres toward you from the panel's plane. */
    towardViewer: 0.06,
    /** Follow stiffness, 1/s. Higher = sticks to the HUD more tightly. */
    followRate: 5,
    /** Hover bob, metres peak. */
    bobAmplitude: 0.015,
    /** Hover bob cycles per second. */
    bobHz: 0.7,
    /** Max lean toward your head, radians (it tilts in to look at you). */
    lookTiltRad: 0.25,
    /** Seconds of the new-best-score happy spin. */
    happySpinSec: 1.3,
    /** Full turns of the happy spin. */
    happySpinTurns: 2,
    /** Hop height during the happy spin, metres. */
    happyHop: 0.08,
    /** Seconds to fly off when a round starts (and to fly back in). */
    flySec: 0.6,
    /** Metres Pip climbs while flying off. */
    flyRise: 0.5,
    /** Propeller spin, turns per second (procedural fallback model only). */
    rotorHz: 9,
  },
} as const;

/** One wave of SPLOTBOTS.waves. */
export interface SplotbotWave {
  /** Seconds into the round this wave starts. */
  readonly startSec: number;
  /** Robots it keeps alive (capped by TARGETS.maxConcurrent). */
  readonly maxAlive: number;
  /** Spawn weights for [mopsy, squeegee, peekaboo]. */
  readonly weights: readonly [number, number, number];
}

