import { VisibilityState, XRMesh, XRPlane, createSystem } from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import { ROOM } from '../config';

/** The slice of ROOM that {@link shouldShowScanNotice} reads. */
export interface ScanNoticeConfig {
  readonly scanCheckDelaySec: number;
}

/**
 * Has this session been running long enough, with nothing detected, to say out
 * loud that the room was never scanned?
 *
 * Both halves matter and both are the fix for a different way of being wrong:
 *
 * - **Nothing detected.** `XRFrame.detectedPlanes` is empty in a room with no
 *   saved Space Setup, and empty is all you get — Meta's docs are explicit that
 *   there is no error to catch and nothing to await. Counting is the only test
 *   available.
 * - **Long enough.** The array "is not populated immediately"; Meta's Browser
 *   documentation says to "wait 2 to 3 seconds after session creation before
 *   making that decision". Without the delay, every session with a perfectly
 *   good room scan would flash the notice for a second on the way in, which is
 *   worse than not having a notice at all.
 *
 * Meshes count as well as planes even though Meta's Browser page lists only the
 * Plane Detection module: IWSDK asks for both, a runtime that reports meshes
 * has plainly been given a scene model, and refusing to notice that would be
 * pedantry the player pays for.
 *
 * Pure and free of any IWSDK dependency, so the rule can be swept in tests
 * without a headset, a session or a room.
 */
export function shouldShowScanNotice(
  planeCount: number,
  meshCount: number,
  elapsedSec: number,
  cfg: ScanNoticeConfig,
): boolean {
  if (planeCount + meshCount > 0) return false;
  return elapsedSec >= cfg.scanCheckDelaySec;
}

/**
 * Notices that the player's room has never been scanned, and offers to fix it.
 *
 * ### Why this exists at all
 *
 * Field feedback, three rounds running: "no wall splats". The player can see
 * their Guardian boundary, so they reasonably assume the headset knows where
 * their walls are. It does not. Guardian is a play-area polygon; the planes and
 * meshes this game turns into colliders come from **Space Setup**, the saved
 * room scan behind Settings > Boundary > Mixed Reality, and those are two
 * different things that a player has no reason to tell apart. In a room that
 * was never set up, WorldCollisionSystem gets nothing to work with, and the
 * only thing paint can land on is FloorGuardSystem's invisible slab — a floor,
 * and no walls. Exactly the report.
 *
 * Round 2 handled it by calling `initiateRoomCapture()` off a timer. Round 3
 * field feedback killed that: it fought the headset's own flow and made "the
 * barriers weird". Round 4 removed the call outright, which fixed the fighting
 * and left an unscanned room with **no route at all** to ever getting walls.
 *
 * ### What this does instead
 *
 * Counts. After {@link ROOM.scanCheckDelaySec} of immersive session, if not one
 * plane or mesh has ever qualified, it raises `globals.sceneScanMissing` and
 * HudSystem puts a notice and a SCAN ROOM button on the title screen. **Nothing
 * fires automatically.** Pressing the button is the only thing that ever calls
 * {@link requestRoomCapture}, which is the sanctioned shape of this API — Meta
 * documents it as something to call "when you are sure that there are no
 * planes" and their own scene guidance is to "suggest users to capture a new
 * scene", not to drag them into one.
 *
 * The signal falls back to false the instant anything is detected, including
 * long afterwards — a player who walks out, runs Space Setup and comes back
 * gets their notice dismissed without a reload.
 *
 * Runs at priority 7, between WorldCollisionSystem (5) and FloorGuardSystem (6)
 * and the gameplay systems: it is the third member of the "what is actually in
 * this room" group, and it only ever reads.
 */
export class SceneScanSystem extends createSystem({
  planes: { required: [XRPlane] },
  meshes: { required: [XRMesh] },
}) {
  private sceneScanMissing!: Signal<boolean>;

  /** Seconds of immersive session so far. Reset whenever the session ends. */
  private elapsedSec = 0;
  /** True only while an immersive session is actually presenting. */
  private immersive = false;
  /**
   * Set once the player has pressed SCAN ROOM.
   *
   * Meta documents `initiateRoomCapture` as callable "only once per session",
   * so a second press cannot do anything; remembering that lets the HUD say so
   * instead of offering a button that silently fails.
   */
  private captureRequested = false;

  init() {
    this.sceneScanMissing = this.globals.sceneScanMissing as Signal<boolean>;

    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        const immersive = state !== VisibilityState.NonImmersive;
        if (immersive === this.immersive) return;
        this.immersive = immersive;
        if (!immersive) {
          // Leaving the session resets everything: the next one gets its own
          // grace period, and its own single room-capture call.
          this.elapsedSec = 0;
          this.captureRequested = false;
          this.sceneScanMissing.value = false;
        }
      }),
    );
  }

  update(delta: number) {
    if (!this.immersive) return;

    const detected =
      this.queries.planes.entities.size + this.queries.meshes.entities.size;

    // Stop accumulating once the answer can no longer change, so a long session
    // never drifts into float territory on a counter nothing reads.
    if (detected === 0 && this.elapsedSec < ROOM.scanCheckDelaySec) {
      this.elapsedSec += delta;
    }

    const missing = shouldShowScanNotice(
      this.queries.planes.entities.size,
      this.queries.meshes.entities.size,
      this.elapsedSec,
      ROOM,
    );
    // Signals dedupe identical writes, but peeking first keeps this honest
    // about being a per-frame poll of a value that almost never moves.
    if (this.sceneScanMissing.peek() !== missing) {
      this.sceneScanMissing.value = missing;
    }
  }

  /** True once SCAN ROOM has been pressed this session. @see captureRequested */
  get roomCaptureRequested(): boolean {
    return this.captureRequested;
  }

  /**
   * Ask Quest to run Space Setup. Called from the SCAN ROOM button and from
   * nowhere else — this is a user gesture by construction.
   *
   * `initiateRoomCapture` is a Quest Browser extension to `XRSession` rather
   * than anything in the WebXR spec, so it is absent on every other runtime
   * (and on the desktop emulator), which is why the whole call is feature-
   * detected and wrapped. A rejected promise is swallowed for the same reason
   * FeedbackSystem swallows a rejected haptic pulse: an unhandled rejection
   * mid-frame is worse than a button that did not work.
   *
   * @returns false when there is no such API to call, which is the HUD's cue to
   *   tell the player to run Space Setup from the system menu instead.
   */
  requestRoomCapture(): boolean {
    const session = this.world.session as
      | { initiateRoomCapture?: () => Promise<void> | void }
      | undefined;
    const initiate = session?.initiateRoomCapture;
    if (typeof initiate !== 'function') return false;

    try {
      const result = initiate.call(session);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => {});
      }
    } catch {
      // Called twice, called too early, or the runtime simply refused.
      return false;
    }

    this.captureRequested = true;
    return true;
  }
}
