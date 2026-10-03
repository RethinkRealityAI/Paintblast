import {
  AssetManager,
  Box3,
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Group,
  Mesh,
  MeshStandardMaterial,
  PanelUI,
  SphereGeometry,
  BoxGeometry,
  Quaternion,
  Vector3,
  createSystem,
} from '@iwsdk/core';
import type { Entity, Object3D } from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import { NEATNIKS } from '../config';
import { GamePhase } from '../types';
import type { PipFocus } from '../types';

const TAU = Math.PI * 2;
const DEG_TO_RAD = Math.PI / 180;

/** The HUD panel's PanelUI.config (main.ts seedHud). */
const HUD_CONFIG_MATCH = 'hud';

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests). Allocation free.
// ---------------------------------------------------------------------------

/**
 * Is Pip out with the player in this phase? He keeps you company on the
 * title screen, the results card and in Chill, and gets out of the line of
 * fire for the countdown and the round itself.
 */
export function pipShownInPhase(phase: GamePhase): boolean {
  return (
    phase === GamePhase.Idle ||
    phase === GamePhase.GameOver ||
    phase === GamePhase.Chill
  );
}

/** Framerate-independent lerp factor for exponential smoothing at `rate`/s. */
export function expSmoothing(rate: number, dtSec: number): number {
  if (!(rate > 0) || !(dtSec > 0)) return 0;
  return 1 - Math.exp(-rate * dtSec);
}

/**
 * Step Pip's presence (0 = flown off, 1 = here) toward `shown` at a rate
 * that covers the full trip in `flySec`.
 */
export function stepPresence(
  current: number,
  shown: boolean,
  flySec: number,
  dtSec: number,
): number {
  const step = flySec > 0 ? dtSec / flySec : 1;
  const next = shown ? current + step : current - step;
  return next < 0 ? 0 : next > 1 ? 1 : next;
}

/**
 * The new-best-score happy spin, `tSec` after it started: `turns` full
 * turns eased in and out over `durSec`, with a hop of `hop` metres at the
 * middle. Writes [spinRad, hopMetres] into `out`; both 0 outside the spin.
 */
export function happySpin(
  tSec: number,
  durSec: number,
  turns: number,
  hop: number,
  out: Float32Array,
): void {
  if (!(tSec >= 0) || !(durSec > 0) || tSec >= durSec) {
    out[0] = 0;
    out[1] = 0;
    return;
  }
  const u = tSec / durSec;
  out[0] = turns * TAU * (0.5 - 0.5 * Math.cos(Math.PI * u));
  out[1] = hop * Math.sin(Math.PI * u);
}

/**
 * Where Pip hovers: beside the HUD panel's left edge, a little above its
 * centre line and a little toward the viewer.
 *
 * @param hx,hy,hz     panel centre (world)
 * @param rx,ry,rz     panel's right axis (world, unit)
 * @param tx,tz        floor-plane unit vector from the panel toward the viewer
 * @param halfWidth    half the panel's width, metres
 * @param beside       metres past the panel's edge
 * @param above        metres above the centre line
 * @param toward       metres toward the viewer
 */
export function pipHoverPoint(
  hx: number,
  hy: number,
  hz: number,
  rx: number,
  ry: number,
  rz: number,
  tx: number,
  tz: number,
  halfWidth: number,
  beside: number,
  above: number,
  toward: number,
  out: Float32Array,
): void {
  const reach = halfWidth + beside;
  out[0] = hx - rx * reach + tx * toward;
  out[1] = hy - ry * reach + above;
  out[2] = hz - rz * reach + tz * toward;
}

/**
 * Round 9: where Pip hovers when the tutorial points him at something (the
 * wall ring, the wrist palette, a Mopsy): beside the subject in the viewer's
 * frame - `left` metres to the viewer's left, `up` above, `toward` metres
 * toward the viewer - so he never sits on the target or in the line of fire.
 *
 * @param px,py,pz  the subject (world)
 * @param hx,hz     the viewer's head on the floor plane
 */
export function focusHoverPoint(
  px: number,
  py: number,
  pz: number,
  hx: number,
  hz: number,
  left: number,
  up: number,
  toward: number,
  out: Float32Array,
): void {
  let tx = hx - px;
  let tz = hz - pz;
  const len = Math.sqrt(tx * tx + tz * tz);
  if (len > 1e-4) {
    tx /= len;
    tz /= len;
  } else {
    tx = 0;
    tz = 1;
  }
  // Viewer looks along -t; their right is (-t) x +Y = (tz, 0, -tx).
  const rx = tz;
  const rz = -tx;
  out[0] = px - rx * left + tx * toward;
  out[1] = py + up;
  out[2] = pz - rz * left + tz * toward;
}

/** Speech-bubble width, metres, for a bubble `dist` metres from the eyes. */
export function bubbleWidth(dist: number): number {
  const w = 0.26 * (Number.isFinite(dist) ? dist : 1);
  return w < 0.34 ? 0.34 : w > 0.9 ? 0.9 : w;
}

/**
 * Pitch that leans Pip's face toward a head `dy` metres above it and
 * `horizontal` metres away, clamped to ±`maxRad`. Positive = nose up.
 */
export function lookTilt(dy: number, horizontal: number, maxRad: number): number {
  const angle = Math.atan2(dy, Math.max(1e-3, horizontal));
  return angle > maxRad ? maxRad : angle < -maxRad ? -maxRad : angle;
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

/**
 * Pip, the palette-drone mascot (round 8). Never shot, never in the way.
 *
 * Hovers beside the HUD panel (a head Follower — found through the PanelUI
 * query, not a reference from main.ts) whenever the menu is up: bobbing,
 * leaning in to look at the player, propellers spinning. When a round starts
 * he climbs away and vanishes; when it ends he swoops back, and a new best
 * score earns a double happy spin.
 *
 * Wears `NEATNIKS.pip.url` once it has streamed in (measured and rescaled to
 * `sizeMeters`), and a little code-built palette drone until then. No
 * Interactable and no physics, so he can never eat a click or a shot.
 */
export class PipSystem extends createSystem({
  panels: { required: [PanelUI] },
}) {
  private gamePhase!: Signal<GamePhase>;
  private bestScore?: Signal<number>;
  /** Round 9: the tutorial's point of interest. @see focusHoverPoint */
  private focus?: PipFocus;
  /** Round 9: the tutorial line Pip says in his speech bubble. */
  private tutorialLine?: Signal<string>;
  private bubble?: Mesh;
  private bubbleTexture?: CanvasTexture;
  private bubbleCanvas?: HTMLCanvasElement;
  private bubbleText = '';
  private focusTarget!: Vector3;

  private holder!: Group;
  private rig!: Group;
  private yawGroup!: Group;
  private procedural!: Group;
  private readonly rotors: Object3D[] = [];
  private hasGlb = false;
  private glbPollSec = 0;

  private hud: Entity | null = null;
  private presence = 0;
  private placed = false;
  private clock = 0;
  private happyAt = -1;
  private lastBest = 0;

  private pos!: Vector3;
  private target!: Float32Array;
  private spin!: Float32Array;
  private scratch!: Vector3;
  private headPos!: Vector3;
  private hudQ!: Quaternion;
  private right!: Vector3;
  private box!: Box3;
  private partBox!: Box3;
  private scratchSize!: Vector3;
  private measureSec = 0;
  private panelHalfWidth = 0.25;

  init() {
    this.gamePhase = this.globals.gamePhase as Signal<GamePhase>;
    this.bestScore = this.globals.bestScore as Signal<number> | undefined;
    this.focus = this.globals.pipFocus as PipFocus | undefined;
    this.tutorialLine = this.globals.tutorialLine as Signal<string> | undefined;
    this.focusTarget = new Vector3();
    this.pos = new Vector3();
    this.target = new Float32Array(3);
    this.spin = new Float32Array(2);
    this.scratch = new Vector3();
    this.headPos = new Vector3();
    this.hudQ = new Quaternion();
    this.right = new Vector3();
    this.box = new Box3();
    this.partBox = new Box3();
    this.scratchSize = new Vector3();

    this.yawGroup = new Group();
    this.yawGroup.name = 'PipYaw';
    this.rig = new Group();
    this.rig.name = 'PipRig';
    this.rig.add(this.yawGroup);
    this.holder = new Group();
    this.holder.name = 'Pip';
    this.holder.visible = false;
    this.holder.add(this.rig);

    this.procedural = buildProceduralPip(NEATNIKS.pip.sizeMeters, this.rotors);
    this.yawGroup.add(this.procedural);
    this.tryInstallGlb();

    this.world.createTransformEntity(this.holder, {
      parent: this.world.sceneEntity,
      persistent: true,
    });
    this.buildBubble();
    if (this.tutorialLine) {
      this.cleanupFuncs.push(
        this.tutorialLine.subscribe((line) => this.drawBubble(line)),
      );
    }

    if (this.bestScore) {
      this.lastBest = this.bestScore.peek();
      this.cleanupFuncs.push(
        this.bestScore.subscribe((best) => {
          // Only a real improvement — not the localStorage seed at boot.
          if (best > this.lastBest && this.lastBest >= 0) {
            this.happyAt = this.clock;
          }
          this.lastBest = best;
        }),
      );
    }
  }

  update(delta: number) {
    const pip = NEATNIKS.pip;
    this.clock += delta;

    if (!this.hasGlb) {
      this.glbPollSec -= delta;
      if (this.glbPollSec <= 0) {
        this.glbPollSec = 0.5;
        this.tryInstallGlb();
      }
    }

    // Round 9: the tutorial keeps Pip out (and pointing) even in its
    // practice round, which is a Playing phase.
    const focused = this.focus?.active === 1;
    const talking = this.bubbleText !== '';
    const shown = pipShownInPhase(this.gamePhase.peek()) || focused || talking;
    this.presence = stepPresence(this.presence, shown, pip.flySec, delta);
    if (this.presence <= 0) {
      this.holder.visible = false;
      if (this.bubble) this.bubble.visible = false;
      this.placed = false;
      return;
    }

    const hud = this.findHud();
    const hudObject = hud?.object3D;
    // A hidden HUD (the enter-AR intro hides it) hides Pip with it, so he
    // never hovers beside an empty spot in front of the logo burst.
    if (!hudObject || !hudObject.visible) {
      this.holder.visible = false;
      if (this.bubble) this.bubble.visible = false;
      return;
    }

    // Where the panel is, which way its right edge runs, and which way the
    // player is from it (on the floor plane).
    hudObject.getWorldPosition(this.scratch);
    hudObject.getWorldQuaternion(this.hudQ);
    this.right.set(1, 0, 0).applyQuaternion(this.hudQ);
    this.player.head.getWorldPosition(this.headPos);
    let tx = this.headPos.x - this.scratch.x;
    let tz = this.headPos.z - this.scratch.z;
    const tl = Math.sqrt(tx * tx + tz * tz);
    if (tl > 1e-4) {
      tx /= tl;
      tz /= tl;
    } else {
      tx = 0;
      tz = 1;
    }
    // The panel lays its document out *inside* maxWidth x maxHeight, so the
    // drawn panel is often narrower than its bounds: measure what is visible
    // (twice a second — the layout only changes with the phase).
    this.measureSec -= delta;
    if (this.measureSec <= 0) {
      this.measureSec = 0.5;
      this.panelHalfWidth = this.measurePanelHalfWidth(
        hudObject,
        (hud?.getValue(PanelUI, 'maxWidth') ?? 0.5) * 0.5,
      );
    }
    const halfWidth = this.panelHalfWidth;
    const focus = this.focus;
    if (focused && focus) {
      const fp = focus.position;
      const fo = focus.offset;
      this.focusTarget.set(fp[0], fp[1], fp[2]);
      focusHoverPoint(
        fp[0],
        fp[1],
        fp[2],
        this.headPos.x,
        this.headPos.z,
        fo[0],
        fo[1],
        fo[2],
        this.target,
      );
    } else {
      pipHoverPoint(
        this.scratch.x,
        this.scratch.y,
        this.scratch.z,
        this.right.x,
        this.right.y,
        this.right.z,
        tx,
        tz,
        halfWidth,
        pip.besidePanel,
        pip.abovePanel,
        pip.towardViewer,
        this.target,
      );
    }

    if (!this.placed) {
      this.pos.set(this.target[0], this.target[1], this.target[2]);
      this.placed = true;
    } else {
      const k = expSmoothing(pip.followRate, delta);
      this.pos.x += (this.target[0] - this.pos.x) * k;
      this.pos.y += (this.target[1] - this.pos.y) * k;
      this.pos.z += (this.target[2] - this.pos.z) * k;
    }

    // Fly in from above / off upward: presence 1 = parked beside the HUD.
    const away = 1 - this.presence;
    happySpin(
      this.clock - this.happyAt,
      pip.happySpinSec,
      pip.happySpinTurns,
      pip.happyHop,
      this.spin,
    );
    const bob = Math.sin(this.clock * TAU * pip.bobHz) * pip.bobAmplitude;
    this.holder.position.set(
      this.pos.x,
      this.pos.y + bob + this.spin[1] + away * away * pip.flyRise,
      this.pos.z,
    );
    this.holder.scale.setScalar(Math.max(0.001, 1 - away * away));
    this.holder.visible = true;

    // Face the player, lean in to look at them, and bank a little with the
    // bob. The happy spin rides on top of the facing.
    const dx = this.headPos.x - this.holder.position.x;
    const dz = this.headPos.z - this.holder.position.z;
    const horizontal = Math.sqrt(dx * dx + dz * dz);
    // Pointing: while the tutorial has him on a subject he turns half-way
    // toward it - the player still sees his face, and his nose says "there".
    let yaw = Math.atan2(dx, dz);
    if (focused) {
      const fx = this.focusTarget.x - this.holder.position.x;
      const fz = this.focusTarget.z - this.holder.position.z;
      if (fx * fx + fz * fz > 1e-4) {
        let d = Math.atan2(fx, fz) - yaw;
        while (d > Math.PI) d -= TAU;
        while (d < -Math.PI) d += TAU;
        yaw += d * 0.5;
      }
    }
    this.holder.rotation.set(0, yaw + this.spin[0], 0);
    const pitch = lookTilt(
      this.headPos.y - this.holder.position.y,
      horizontal,
      pip.lookTiltRad,
    );
    // Rotation about X by -pitch tips local +Z (the face) upward.
    this.rig.rotation.set(
      -pitch,
      0,
      Math.sin(this.clock * TAU * pip.bobHz * 0.5) * 0.12,
    );

    const rotorStep = pip.rotorHz * TAU * delta;
    for (let i = 0; i < this.rotors.length; i++) {
      this.rotors[i].rotation.y += i % 2 === 0 ? rotorStep : -rotorStep;
    }

    this.placeBubble(horizontal);
  }

  // ---- Round 9: the speech bubble -------------------------------------------

  private buildBubble(): void {
    if (typeof document === 'undefined') return;
    this.bubbleCanvas = document.createElement('canvas');
    this.bubbleCanvas.width = 1024;
    this.bubbleCanvas.height = 192;
    this.bubbleTexture = new CanvasTexture(this.bubbleCanvas);
    this.bubbleTexture.colorSpace = SRGBColorSpace;
    const material = new MeshBasicMaterial({
      map: this.bubbleTexture,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      side: DoubleSide,
    });
    const mesh = new Mesh(new PlaneGeometry(1, 192 / 1024), material);
    mesh.name = 'PipBubble';
    mesh.visible = false;
    mesh.renderOrder = 996;
    mesh.raycast = () => {};
    this.bubble = mesh;
    this.world.createTransformEntity(mesh, {
      parent: this.world.sceneEntity,
      persistent: true,
    });
  }

  /** A white rounded bubble with a tail toward Pip, dark bold text. */
  private drawBubble(text: string): void {
    this.bubbleText = text;
    const canvas = this.bubbleCanvas;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !this.bubbleTexture) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!text) {
      this.bubbleTexture.needsUpdate = true;
      return;
    }
    ctx.font = "800 64px Rubik, 'Arial Black', 'Helvetica Neue', Arial, sans-serif";
    const tw = Math.min(w - 16, ctx.measureText(text).width + 80);
    const x0 = (w - tw) / 2;
    const top = 8;
    const bottom = h - 46;
    const r = 40;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
    ctx.strokeStyle = '#48dbfb';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(x0 + r, top);
    ctx.lineTo(x0 + tw - r, top);
    ctx.arcTo(x0 + tw, top, x0 + tw, top + r, r);
    ctx.lineTo(x0 + tw, bottom - r);
    ctx.arcTo(x0 + tw, bottom, x0 + tw - r, bottom, r);
    // Tail down toward Pip, who hovers under the bubble's middle.
    ctx.lineTo(w / 2 + 26, bottom);
    ctx.lineTo(w / 2, h - 6);
    ctx.lineTo(w / 2 - 26, bottom);
    ctx.lineTo(x0 + r, bottom);
    ctx.arcTo(x0, bottom, x0, bottom - r, r);
    ctx.lineTo(x0, top + r);
    ctx.arcTo(x0, top, x0 + r, top, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#0b0c14';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, (top + bottom) / 2 + 3, w - 60);
    this.bubbleTexture.needsUpdate = true;
  }

  /** Above Pip, facing the head, sized for legibility at his distance. */
  private placeBubble(horizontal: number): void {
    const bubble = this.bubble;
    if (!bubble) return;
    const show = this.bubbleText !== '' && this.holder.visible && this.presence > 0.6;
    bubble.visible = show;
    if (!show) return;
    const width = bubbleWidth(Math.max(horizontal, 0.3));
    bubble.scale.set(width, width, 1);
    bubble.position.set(
      this.holder.position.x,
      this.holder.position.y + NEATNIKS.pip.sizeMeters * 0.55 + width * 0.11,
      this.holder.position.z,
    );
    bubble.rotation.set(
      0,
      Math.atan2(
        this.headPos.x - bubble.position.x,
        this.headPos.z - bubble.position.z,
      ),
      0,
    );
  }

  /**
   * Half the drawn width of the panel, metres, along its own right axis:
   * the world AABB of its *visible* meshes, projected onto `this.right`
   * (for a flat panel turned by any yaw, ext.x*|rx| + ext.z*|rz| is its
   * width). Hidden phase sections are skipped. Falls back to `fallback`
   * (half of maxWidth) when nothing visible has been laid out yet.
   */
  private measurePanelHalfWidth(panel: Object3D, fallback: number): number {
    const box = this.box;
    box.makeEmpty();
    panel.updateWorldMatrix(true, true);
    panel.traverseVisible((child) => {
      const mesh = child as Mesh;
      const geometry = mesh.isMesh ? mesh.geometry : undefined;
      if (!geometry) return;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) return;
      this.partBox.copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
      box.union(this.partBox);
    });
    if (box.isEmpty()) return fallback;
    box.getSize(this.scratchSize);
    const width =
      this.scratchSize.x * Math.abs(this.right.x) +
      this.scratchSize.z * Math.abs(this.right.z);
    if (!(width > 0.02)) return fallback;
    return Math.min(fallback, width * 0.5);
  }

  /** The HUD panel entity, cached; re-found if it is ever recreated. */
  private findHud(): Entity | null {
    if (this.hud && this.hud.active && this.hud.hasComponent(PanelUI)) {
      return this.hud;
    }
    this.hud = null;
    for (const entity of this.queries.panels.entities) {
      const config = entity.getValue(PanelUI, 'config') ?? '';
      if (config.includes(HUD_CONFIG_MATCH)) {
        this.hud = entity;
        break;
      }
    }
    return this.hud;
  }

  /** Swap the procedural drone for the Meshy GLB once it has streamed in. */
  private tryInstallGlb(): void {
    let scene: Object3D | undefined;
    try {
      scene = AssetManager.getGLTF(NEATNIKS.pip.assetKey)?.scene as
        | Object3D
        | undefined;
    } catch {
      return;
    }
    if (!scene) return;

    const model = scene.clone(true);
    model.updateMatrixWorld(true);
    this.box.setFromObject(model);
    const size = this.box.getSize(new Vector3());
    const centre = this.box.getCenter(new Vector3());
    const scale =
      NEATNIKS.pip.sizeMeters / (Math.max(size.x, size.y, size.z) || 1);
    const fit = new Group();
    fit.name = 'PipFit';
    fit.scale.setScalar(scale);
    fit.position.set(-centre.x * scale, -centre.y * scale, -centre.z * scale);
    fit.add(model);

    this.yawGroup.remove(this.procedural);
    this.rotors.length = 0;
    this.yawGroup.add(fit);
    this.yawGroup.rotation.y = NEATNIKS.pip.yawOffsetDeg * DEG_TO_RAD;
    this.hasGlb = true;
  }
}

/**
 * Pip before his GLB arrives: a kidney-ish palette disc standing upright with
 * a face screen on +Z, four propeller pods and two brush legs. ~25 draw-call
 * pieces built once at boot.
 */
function buildProceduralPip(size: number, rotors: Object3D[]): Group {
  const root = new Group();
  root.name = 'PipProcedural';
  const r = size * 0.42;

  const wood = new MeshStandardMaterial({ color: 0xe9d3ad, roughness: 0.55 });
  const screen = new MeshStandardMaterial({
    color: 0xc9f1ff,
    emissive: 0x7fd8ff,
    emissiveIntensity: 0.6,
    roughness: 0.2,
  });
  const ink = new MeshStandardMaterial({ color: 0x1d2a3a, roughness: 0.4 });
  const chrome = new MeshStandardMaterial({
    color: 0xd8dde3,
    metalness: 0.8,
    roughness: 0.25,
  });
  const blade = new MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.5 });

  // Palette disc, faced toward +Z.
  const disc = new Mesh(new CylinderGeometry(r, r, r * 0.18, 32), wood);
  disc.rotation.x = Math.PI / 2;
  root.add(disc);

  // Paint dabs round the rim.
  const dabColors = [0xff4f6d, 0xffc94d, 0x48dbfb, 0x4fd18b, 0xb84dff];
  const dabGeo = new SphereGeometry(r * 0.13, 12, 8);
  for (let i = 0; i < dabColors.length; i++) {
    const a = Math.PI * 0.75 + (i / (dabColors.length - 1)) * Math.PI * 1.5;
    const dab = new Mesh(
      dabGeo,
      new MeshStandardMaterial({ color: dabColors[i], roughness: 0.3 }),
    );
    dab.scale.set(1, 1, 0.5);
    dab.position.set(Math.cos(a) * r * 0.78, Math.sin(a) * r * 0.78, r * 0.1);
    root.add(dab);
  }

  // Face screen with two eyes and a smile.
  const face = new Mesh(new BoxGeometry(r * 0.95, r * 0.75, r * 0.06), screen);
  face.position.set(0, r * 0.05, r * 0.12);
  root.add(face);
  const eyeGeo = new SphereGeometry(r * 0.08, 10, 8);
  for (const side of [-1, 1]) {
    const eye = new Mesh(eyeGeo, ink);
    eye.scale.set(1, 1.3, 0.4);
    eye.position.set(side * r * 0.2, r * 0.12, r * 0.16);
    root.add(eye);
  }
  const smile = new Mesh(new BoxGeometry(r * 0.28, r * 0.05, r * 0.03), ink);
  smile.position.set(0, -r * 0.12, r * 0.16);
  root.add(smile);

  // Four propeller pods on short arms.
  const podGeo = new CylinderGeometry(r * 0.13, r * 0.11, r * 0.16, 14);
  const bladeGeo = new BoxGeometry(r * 0.75, r * 0.02, r * 0.09);
  const armGeo = new CylinderGeometry(r * 0.04, r * 0.04, r * 0.45, 8);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const px = sx * r * 1.15;
      const py = sy * r * 0.62;
      const arm = new Mesh(armGeo, chrome);
      arm.position.set(sx * r * 0.92, py, 0);
      arm.rotation.z = Math.PI / 2;
      root.add(arm);
      const pod = new Mesh(podGeo, chrome);
      pod.position.set(px, py, 0);
      root.add(pod);
      const rotor = new Group();
      rotor.position.set(px, py + r * 0.11, 0);
      rotor.add(new Mesh(bladeGeo, blade));
      root.add(rotor);
      rotors.push(rotor);
    }
  }

  // Two brush legs.
  const legGeo = new CylinderGeometry(r * 0.04, r * 0.04, r * 0.7, 8);
  const tipGeo = new SphereGeometry(r * 0.1, 10, 8);
  for (const side of [-1, 1]) {
    const leg = new Mesh(legGeo, chrome);
    leg.position.set(side * r * 0.35, -r * 1.25, 0);
    leg.rotation.z = side * 0.25;
    root.add(leg);
    const tip = new Mesh(
      tipGeo,
      new MeshStandardMaterial({
        color: side < 0 ? 0x7a5cff : 0xff7a3d,
        roughness: 0.6,
      }),
    );
    tip.scale.set(1, 1.6, 1);
    tip.position.set(side * r * 0.44, -r * 1.62, 0);
    root.add(tip);
  }

  return root;
}
