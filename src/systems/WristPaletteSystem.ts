import {
  Quaternion,
  Vector3,
  createComponent,
  createSystem,
  setWorldPosition,
  setWorldQuaternion,
} from '@iwsdk/core';

import { PALETTE } from '../config';

const DEG_TO_RAD = Math.PI / 180;

/**
 * Optional AssetManifest key for a modelled palette board.
 *
 * Drop `public/gltf/palette-board.glb` in, uncomment the manifest entry marked
 * ROUND3-PALETTE-ASSET in main.ts, and the board becomes that model instead of
 * the primitive oval. The dabs and chips are always built in code and always
 * parented to the same root, so tapping keeps working whatever the art is —
 * exactly the arrangement EASEL_ASSET_KEY uses for the easel.
 */
export const PALETTE_BOARD_ASSET_KEY = 'paletteBoard';

/**
 * Marks the single entity that parents the board, the four paint dabs, the five
 * ammo chips and their labels.
 *
 * main.ts builds it (see `seedWristPalette`); this system is the only thing
 * that writes its transform. Everything on the palette is a child, so it all
 * inherits the wrist pose for free and keeps its own PaintDab / KindChip /
 * RayInteractable / PokeInteractable / OneHandGrabbable setup untouched.
 */
export const PaletteRoot = createComponent('PaletteRoot', {});

/**
 * Straps the painter's palette to the player's left wrist.
 *
 * Field feedback, round 1: the palette lived at fixed world coordinates, which
 * put it behind, below or simply out of reach depending on where the player
 * happened to be standing. A palette you carry is always reachable.
 *
 * Field feedback, round 2: "it could be like an actual paint palette, and I
 * should just tap a colour". So the 4x4 grid of combined colour+kind orbs
 * became a flat oval board with paint dabs curving round its far edge and a
 * row of kind chips by the wrist — see main.ts's `seedWristPalette`.
 *
 * Every frame the left grip's world pose is copied onto the palette root with
 * a grip-local offset and a pitch, so the board floats just above the back of
 * the hand and tips toward the player. Grip spaces exist in hand-tracking mode
 * too — IWSDK poses them from the wrist joint — so there is one code path for
 * controllers and hands.
 *
 * Field feedback, round 4: web mode hid the palette, because webbing was a
 * phase in which there was nothing to choose. Round 5 made webbing a chip *on*
 * the palette, so the board is now the only way back to paint — it is visible
 * and live in every phase, unconditionally, and there is deliberately no phase
 * subscription here any more. Hiding it would strand the player in web ammo.
 *
 * Runs at priority 8, i.e. before BallSpawnSystem (10) reads palette presses
 * and before the panel-ray test looks at anything, so the dabs are already
 * where the player sees them when the frame's input is resolved.
 *
 * Zero allocations in update(): five scratch objects, all built in init().
 */
export class WristPaletteSystem extends createSystem({
  roots: { required: [PaletteRoot] },
}) {
  // Scratch — reused every frame, never reallocated.
  private gripPosition!: Vector3;
  private gripOrientation!: Quaternion;
  private localOffset!: Vector3;
  private targetPosition!: Vector3;
  private targetOrientation!: Quaternion;
  /** Constant pitch of the palette plane; built once from PALETTE.tiltDeg. */
  private tilt!: Quaternion;

  init() {
    this.gripPosition = new Vector3();
    this.gripOrientation = new Quaternion();
    this.localOffset = new Vector3();
    this.targetPosition = new Vector3();
    this.targetOrientation = new Quaternion();

    this.tilt = new Quaternion().setFromAxisAngle(
      new Vector3(1, 0, 0),
      PALETTE.tiltDeg * DEG_TO_RAD,
    );
  }

  update() {
    const grip = this.player?.gripSpaces?.left;
    // A disconnected controller leaves its grip space hidden rather than
    // posed; parking the palette at its last pose beats snapping it to the
    // world origin. Both IWER and the headset keep grips visible in practice.
    if (!grip || grip.visible === false) return;

    // getWorldPosition/getWorldQuaternion refresh the grip's world matrix
    // themselves, so there is nothing to update by hand first.
    grip.getWorldPosition(this.gripPosition);
    grip.getWorldQuaternion(this.gripOrientation);

    this.localOffset
      .set(PALETTE.wristOffsetX, PALETTE.wristOffsetY, PALETTE.wristOffsetZ)
      .applyQuaternion(this.gripOrientation);
    this.targetPosition.copy(this.gripPosition).add(this.localOffset);
    this.targetOrientation.copy(this.gripOrientation).multiply(this.tilt);

    for (const root of this.queries.roots.entities) {
      const object3D = root.object3D;
      if (!object3D) continue;
      // setWorld* rather than a raw copy: the root hangs off the scene entity
      // today, but these stay correct if it is ever reparented, and both are
      // allocation-free (module-level scratch inside @iwsdk/core).
      setWorldPosition(object3D, this.targetPosition);
      setWorldQuaternion(object3D, this.targetOrientation);
    }
  }
}
