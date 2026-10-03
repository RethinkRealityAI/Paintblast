import {
  AssetManager,
  AudioSource,
  AudioUtils,
  CanvasTexture,
  Color,
  createSystem,
  DoubleSide,
  DynamicDrawUsage,
  eq,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PanelUI,
  PlaneGeometry,
  PlaybackMode,
  Quaternion,
  RingGeometry,
  SRGBColorSpace,
  Vector3,
  VisibilityState,
  XRMesh,
  XRPlane,
} from '@iwsdk/core';
import type { Entity, Object3D, Texture } from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import { INTRO } from '../config';
import { RoomProbe, apparentScale, isWallNormal, yawFacingNormal } from '../room-probe';
import { GamePhase } from '../types';
import { SPLAT_TEXTURE_KEY } from './SplatterSystem';

/** AssetManifest key main.ts registers public/brand/logo.png under. */
export const INTRO_LOGO_KEY = 'introLogo';

/** Must match the PanelUI.config main.ts seeds the HUD entity with (HudSystem). */
const HUD_CONFIG_PATH = './ui/hud.json';

// ---- pure timeline (exported for tests) ---------------------------------------

export function clamp01(x: number): number {
  return x <= 0 ? 0 : x >= 1 ? 1 : x;
}

/** 0 → 0, 1 → 1, overshooting above 1 on the way when `overshoot` > 0. */
export function easeOutBack(t: number, overshoot: number): number {
  const x = clamp01(t) - 1;
  return 1 + (overshoot + 1) * x * x * x + overshoot * x * x;
}

export function easeOutCubic(t: number): number {
  const x = 1 - clamp01(t);
  return 1 - x * x * x;
}

export function easeInCubic(t: number): number {
  const x = clamp01(t);
  return x * x * x;
}

/** The subset of {@link INTRO} the timeline reads. */
export interface IntroTiming {
  readonly splatInSec: number;
  readonly logoStartSec: number;
  readonly logoInSec: number;
  readonly logoOvershoot: number;
  readonly taglineStartSec: number;
  readonly taglineInSec: number;
  readonly exitRise: number;
  readonly exitScale: number;
  readonly ringSec: number;
  readonly hudRevealAt: number;
}

/** Everything the intro draws on one frame. Filled in place: no allocation. */
export interface IntroFrame {
  splatScale: number;
  splatAlpha: number;
  logoScale: number;
  logoAlpha: number;
  taglineAlpha: number;
  /** Metres the tagline still has to slide up into place. */
  taglineDrop: number;
  ringProgress: number;
  /** Metres the whole group has risen during the exit. */
  rise: number;
  /** Whole-group scale multiplier during the exit. */
  groupScale: number;
  /** Whole-group opacity multiplier during the exit. */
  fade: number;
  /** The title HUD may show again. */
  hudVisible: boolean;
  done: boolean;
}

export function createIntroFrame(): IntroFrame {
  return {
    splatScale: 0,
    splatAlpha: 0,
    logoScale: 0,
    logoAlpha: 0,
    taglineAlpha: 0,
    taglineDrop: 0,
    ringProgress: 0,
    rise: 0,
    groupScale: 1,
    fade: 1,
    hudVisible: false,
    done: false,
  };
}

/**
 * Evaluate the intro at `t` seconds. The exit starts at `exitAt` and lasts
 * `exitSec` (a skip moves both earlier/shorter, see {@link skipExit}). With
 * `reduced` (prefers-reduced-motion) nothing bounces, rises or rings: the
 * logo just fades in and out.
 */
export function evaluateIntro(
  t: number,
  exitAt: number,
  exitSec: number,
  timing: IntroTiming,
  reduced: boolean,
  out: IntroFrame,
): IntroFrame {
  const splatP = clamp01(t / Math.max(1e-3, timing.splatInSec));
  const logoP = clamp01((t - timing.logoStartSec) / Math.max(1e-3, timing.logoInSec));
  const tagP = clamp01((t - timing.taglineStartSec) / Math.max(1e-3, timing.taglineInSec));
  const exitP = clamp01((t - exitAt) / Math.max(1e-3, exitSec));

  if (reduced) {
    out.splatScale = splatP > 0 ? 1 : 0;
    out.logoScale = logoP > 0 ? 1 : 0;
    out.ringProgress = 0;
    out.rise = 0;
    out.groupScale = 1;
    out.taglineDrop = 0;
  } else {
    // A gentle breath while it holds, so it is not a flat sticker.
    const breathe = 1 + 0.025 * Math.sin(t * 3.1);
    out.splatScale = easeOutBack(splatP, 1.6) * breathe;
    out.logoScale = t < timing.logoStartSec ? 0 : easeOutBack(logoP, timing.logoOvershoot);
    out.ringProgress = t < timing.logoStartSec ? 0 : clamp01((t - timing.logoStartSec) / Math.max(1e-3, timing.ringSec));
    const e = easeInCubic(exitP);
    out.rise = e * timing.exitRise;
    out.groupScale = 1 - e * (1 - timing.exitScale);
    out.taglineDrop = (1 - easeOutCubic(tagP)) * 0.06;
  }
  out.splatAlpha = clamp01(t / 0.08) * 0.92;
  out.logoAlpha = t < timing.logoStartSec ? 0 : clamp01((t - timing.logoStartSec) / 0.12);
  out.taglineAlpha = t < timing.taglineStartSec ? 0 : easeOutCubic(tagP);
  out.fade = 1 - (reduced ? exitP : easeInCubic(exitP));
  out.hudVisible = exitP >= timing.hudRevealAt;
  out.done = t >= exitAt + exitSec;
  return out;
}

/**
 * A pinch / trigger at `t`: returns the new exit start. Before the hold ends
 * the exit starts now (and plays at the short skip length); once the exit is
 * already running, it is left alone.
 */
export function skipExit(t: number, exitAt: number): number {
  return t < exitAt ? t : exitAt;
}

/** Yaw (radians, about +Y) that turns a +Z-facing plane toward -forward. */
export function faceYaw(forwardX: number, forwardZ: number): number {
  return Math.atan2(-forwardX, -forwardZ);
}

/**
 * Round 9 (verified bug): the intro may only play over the title screen.
 * Re-entering AR mid-round (the session ended, the round paused, ENTER AR
 * again) used to replay it and hide the HUD over a live round. Pure.
 */
export function introAllowedInPhase(phase: GamePhase): boolean {
  return phase === GamePhase.Idle;
}

// ---- system ---------------------------------------------------------------

const Phase = { Idle: 0, Waiting: 1, Playing: 2, Finished: 3 } as const;
type Phase = typeof Phase[keyof typeof Phase];

/** Render order band: above balls/splats, all transparent, drawn back to front. */
const ORDER = { ring: 990, splat: 991, particles: 996, logo: 997, tagline: 998 } as const;

/**
 * The enter-AR "wow" beat. The first time an immersive session turns visible,
 * the PAINTBLAST logo bursts out of a neon paint splat in front of the player,
 * a ring of splats flies out, the tagline lands, then it lifts away and hands
 * over to the title HUD (hidden meanwhile, {@link INTRO.hideHud}).
 *
 * - Plays once per session; exiting to the browser re-arms it.
 * - Any pinch / trigger skips to a short exit. It never consumes input: the
 *   same pinch still fires a ball, and the HUD is interactive again the moment
 *   it reappears.
 * - Holds still while the session is blurred/hidden (Quest menu, headset off).
 * - Unlit, tone-mapping-free materials so it reads in any room; transparent
 *   planes never write depth.
 * - Zero allocation per frame: one group, a handful of meshes, one instanced
 *   burst, all scratch built in init().
 */
export class IntroSystem extends createSystem({
  hud: { required: [PanelUI], where: [eq(PanelUI, 'config', HUD_CONFIG_PATH)] },
  // Round 9: real walls to splat the logo onto (spawn-time raycast only).
  planes: { required: [XRPlane] },
  meshes: { required: [XRMesh] },
}) {
  private phase: Phase = Phase.Idle;
  private visible = false;
  private t = 0;
  private wait = 0;
  private exitAt = 0;
  private exitSec = 0;
  private reduced = false;
  private hudHidden = false;
  private chimed = false;
  private splatted = false;

  private frame!: IntroFrame;
  private root?: Group;
  private logo?: Mesh;
  private logoMaterial?: MeshBasicMaterial;
  private logoAspect = 0.2;
  private tagline?: Mesh;
  private taglineMaterial?: MeshBasicMaterial;
  private taglineTexture?: CanvasTexture;
  private taglineCanvas?: HTMLCanvasElement;
  private ring?: Mesh;
  private ringMaterial?: MeshBasicMaterial;
  private splats: Mesh[] = [];
  private splatMaterials: MeshBasicMaterial[] = [];
  private burst?: InstancedMesh;
  private burstMaterial?: MeshBasicMaterial;

  private whoosh?: Entity;
  private splatCue?: Entity;
  private chime?: Entity;

  // Burst particles (struct of arrays, local to the root group).
  private px!: Float32Array;
  private py!: Float32Array;
  private pz!: Float32Array;
  private vx!: Float32Array;
  private vy!: Float32Array;
  private vz!: Float32Array;
  private rot!: Float32Array;
  private spin!: Float32Array;
  private size!: Float32Array;
  private life!: Float32Array;
  private burstAge = -1;

  // Scratch.
  private matrix!: Matrix4;
  private quat!: Quaternion;
  private zAxis!: Vector3;
  private pos!: Vector3;
  private scl!: Vector3;
  private headPos!: Vector3;
  private origin!: Vector3;
  private probe?: RoomProbe;
  private probeDir?: Vector3;
  private probeOrigin?: Vector3;
  private gamePhase?: Signal<GamePhase>;
  /** Round 9: the logo landed on a real wall this time (diagnostics / harness). */
  onWall = false;

  /** True once this session's intro is over (or was never going to play). */
  get finished(): boolean {
    return this.phase === Phase.Finished || (!INTRO.enabled && this.visible);
  }

  init() {
    this.frame = createIntroFrame();
    this.gamePhase = this.globals.gamePhase as Signal<GamePhase> | undefined;
    if (!INTRO.enabled) {
      this.cleanupFuncs.push(
        this.world.visibilityState.subscribe((state) => {
          this.visible = state === VisibilityState.Visible;
        }),
      );
      return;
    }

    this.matrix = new Matrix4();
    this.quat = new Quaternion();
    this.zAxis = new Vector3(0, 0, 1);
    this.pos = new Vector3();
    this.scl = new Vector3(1, 1, 1);
    this.headPos = new Vector3();
    this.origin = new Vector3();

    try {
      this.reduced =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      this.reduced = false;
    }

    this.build();

    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        this.visible = state === VisibilityState.Visible;
        if (state === VisibilityState.NonImmersive) {
          // Back on the 2D page: the next session gets its own intro.
          this.endIntro();
          this.phase = Phase.Idle;
        } else if (state === VisibilityState.Visible && this.phase === Phase.Idle) {
          const phase = this.gamePhase?.peek() ?? GamePhase.Idle;
          if (introAllowedInPhase(phase)) {
            this.phase = Phase.Waiting;
            this.wait = INTRO.startDelaySec;
          } else {
            // Back into AR mid-round: straight to the HUD, no intro.
            this.endIntro();
          }
        }
      }),
    );
  }

  private build(): void {
    const root = new Group();
    root.name = 'IntroRoot';
    root.visible = false;
    this.root = root;

    const quad = new PlaneGeometry(1, 1);
    const splatTex = (AssetManager.getTexture(SPLAT_TEXTURE_KEY) as Texture | null) ?? null;

    const basic = (params: ConstructorParameters<typeof MeshBasicMaterial>[0]) =>
      new MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        side: DoubleSide,
        ...params,
      });

    // Shockwave ring, cyan, behind everything.
    this.ringMaterial = basic({ color: new Color().setStyle('#48dbfb', SRGBColorSpace), opacity: 0 });
    this.ring = new Mesh(new RingGeometry(0.92, 1, 64), this.ringMaterial);
    this.ring.position.z = -0.06;
    this.ring.renderOrder = ORDER.ring;
    root.add(this.ring);

    // The splat the logo bursts out of: three tinted, offset, rotated masks.
    // The last, dark "ink" layer sits right behind the logo so the wordmark
    // (which carries its own colour splats) reads against any room.
    const splatLayers: Array<[string, number, number, number, number]> = [
      // colour, x, y, rotation, scale
      ['#b84dff', 0.16, 0.03, 0.6, 1.0],
      ['#ff4f81', -0.17, -0.04, 2.1, 0.95],
      ['#48dbfb', 0.03, 0.06, 4.0, 0.85],
      ['#0d0716', 0.0, -0.01, 5.3, 0.74],
    ];
    splatLayers.forEach(([hex, x, y, r, s], i) => {
      const material = basic({
        color: new Color().setStyle(hex, SRGBColorSpace),
        alphaMap: splatTex,
        opacity: 0,
      });
      const mesh = new Mesh(quad, material);
      mesh.position.set(x * INTRO.splatWidth, y * INTRO.splatWidth, -0.04 + i * 0.008);
      mesh.userData.ink = i === splatLayers.length - 1;
      mesh.rotation.z = r;
      mesh.userData.baseScale = s * INTRO.splatWidth;
      mesh.renderOrder = ORDER.splat + i;
      root.add(mesh);
      this.splats.push(mesh);
      this.splatMaterials.push(material);
    });

    // The logo; its texture is attached when the intro starts (it streams in
    // the background and is usually there long before ENTER AR is pressed).
    this.logoMaterial = basic({ opacity: 0 });
    this.logo = new Mesh(quad, this.logoMaterial);
    this.logo.renderOrder = ORDER.logo;
    root.add(this.logo);

    // Tagline, drawn into a canvas.
    if (typeof document !== 'undefined') {
      this.taglineCanvas = document.createElement('canvas');
      this.taglineCanvas.width = 1024;
      this.taglineCanvas.height = 128;
      this.taglineTexture = new CanvasTexture(this.taglineCanvas);
      this.taglineTexture.colorSpace = SRGBColorSpace;
      this.taglineMaterial = basic({ map: this.taglineTexture, opacity: 0 });
      this.tagline = new Mesh(quad, this.taglineMaterial);
      this.tagline.scale.set(INTRO.logoWidth * 0.78, INTRO.logoWidth * 0.78 * (128 / 1024), 1);
      this.tagline.renderOrder = ORDER.tagline;
      root.add(this.tagline);
    }

    // Burst of neon splats.
    const count = Math.max(0, Math.floor(INTRO.particleCount));
    this.px = new Float32Array(count);
    this.py = new Float32Array(count);
    this.pz = new Float32Array(count);
    this.vx = new Float32Array(count);
    this.vy = new Float32Array(count);
    this.vz = new Float32Array(count);
    this.rot = new Float32Array(count);
    this.spin = new Float32Array(count);
    this.size = new Float32Array(count);
    this.life = new Float32Array(count);
    if (count > 0 && !this.reduced) {
      this.burstMaterial = basic({ alphaMap: splatTex, opacity: 1 });
      const burst = new InstancedMesh(quad, this.burstMaterial, count);
      burst.instanceMatrix.setUsage(DynamicDrawUsage);
      burst.frustumCulled = false;
      burst.raycast = () => {};
      burst.renderOrder = ORDER.particles;
      const color = new Color();
      for (let i = 0; i < count; i++) {
        color.setStyle(INTRO.colors[i % INTRO.colors.length], SRGBColorSpace);
        burst.setColorAt(i, color);
      }
      burst.count = 0;
      this.burst = burst;
      root.add(burst);
    }

    // Nothing in the intro is ever a pointer/ray target.
    root.traverse((o) => {
      o.raycast = () => {};
    });

    this.world.createTransformEntity(root, {
      parent: this.world.sceneEntity,
      persistent: true,
    });

    this.whoosh = this.createCue(INTRO.whooshSrc);
    this.splatCue = this.createCue(INTRO.splatSrc);
    this.chime = this.createCue(INTRO.chimeSrc);
  }

  private createCue(src: string): Entity {
    const entity = this.world.createTransformEntity(new Group(), {
      parent: this.world.sceneEntity,
      persistent: true,
    });
    entity.addComponent(AudioSource, {
      src,
      volume: 1,
      positional: false,
      loop: false,
      autoplay: false,
      playbackMode: PlaybackMode.Restart,
      maxInstances: 1,
    });
    return entity;
  }

  private playCue(cue: Entity | undefined, volume: number): void {
    if (!cue?.active || volume <= 0) return;
    AudioUtils.setVolume(cue, volume);
    AudioUtils.play(cue);
  }

  private drawTagline(): void {
    const canvas = this.taglineCanvas;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !this.taglineTexture) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = "900 68px Rubik, 'Arial Black', 'Helvetica Neue', Arial, sans-serif";
    const x = canvas.width / 2;
    const y = canvas.height / 2 + 2;
    // Neon edge, then a crisp white face.
    ctx.shadowColor = '#48dbfb';
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#48dbfb';
    ctx.fillText(INTRO.tagline, x, y);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(INTRO.tagline, x, y);
    this.taglineTexture.needsUpdate = true;
  }

  // ---- lifecycle ------------------------------------------------------------

  private beginIntro(): void {
    const root = this.root;
    if (!root) {
      this.phase = Phase.Finished;
      return;
    }

    // Logo texture (background asset). Without it the splat + tagline still play.
    const tex = AssetManager.getTexture(INTRO_LOGO_KEY) as Texture | null;
    if (tex && this.logoMaterial) {
      tex.colorSpace = SRGBColorSpace;
      const img = tex.image as { width?: number; height?: number } | undefined;
      if (img?.width && img?.height) this.logoAspect = img.height / img.width;
      this.logoMaterial.map = tex;
      this.logoMaterial.needsUpdate = true;
    }
    this.drawTagline();

    // Place it once, in front of where the player is looking, level.
    const head = this.player?.head;
    let fx = 0;
    let fz = -1;
    if (head) {
      head.updateWorldMatrix(true, false);
      const m = head.matrixWorld.elements;
      this.headPos.set(m[12], m[13], m[14]);
      const len = Math.hypot(m[8], m[10]);
      if (len > 1e-3) {
        fx = -m[8] / len;
        fz = -m[10] / len;
      }
    } else {
      this.headPos.set(0, 1.4, 0);
    }
    const eyeY = this.headPos.y > 0.3 ? this.headPos.y : 1.4;
    this.origin.set(
      this.headPos.x + fx * INTRO.distance,
      eyeY + INTRO.heightOffset,
      this.headPos.z + fz * INTRO.distance,
    );
    let yaw = faceYaw(fx, fz);
    this.baseScale = 1;
    this.onWall = false;
    // Round 9: splat it onto the real wall in front when there is one, so
    // the very first thing the player sees is paint on THEIR room.
    if (INTRO.wallSnap && this.snapToWall(fx, fz, eyeY + INTRO.heightOffset)) {
      yaw = this.wallYaw;
      this.onWall = true;
    }
    root.position.copy(this.origin);
    root.rotation.set(0, yaw, 0);
    root.scale.setScalar(this.baseScale);
    root.visible = true;

    this.t = 0;
    this.exitAt = INTRO.exitStartSec;
    this.exitSec = INTRO.exitSec;
    this.chimed = false;
    this.splatted = false;
    this.burstAge = -1;
    this.phase = Phase.Playing;
    this.setHudVisible(false);
    this.playCue(this.whoosh, INTRO.whooshVolume);
  }

  private baseScale = 1;
  private wallYaw = 0;

  /**
   * Cast level from the eyes along the gaze; on a wall within
   * [wallMinDist, wallMaxDist] move `origin` onto it (stood off along its
   * normal), face the logo out of the wall and keep its apparent size.
   * @returns false (origin untouched) with no scene data or no wall in range.
   */
  private snapToWall(fx: number, fz: number, y: number): boolean {
    this.probe ??= new RoomProbe();
    this.probeDir ??= new Vector3();
    this.probeOrigin ??= new Vector3();
    this.probeDir.set(fx, 0, fz);
    this.probeOrigin.set(this.headPos.x, y, this.headPos.z);
    const objects: Array<Object3D | undefined> = [];
    for (const e of this.queries.planes.entities) objects.push(e.object3D);
    for (const e of this.queries.meshes.entities) objects.push(e.object3D);
    if (objects.length === 0) return false;
    const dist = this.probe.cast(
      this.probeOrigin,
      this.probeDir,
      objects,
      INTRO.wallMinDist,
      INTRO.wallMaxDist,
      (_x, ny) => isWallNormal(ny, INTRO.wallMaxTiltDeg),
    );
    if (!Number.isFinite(dist)) return false;
    const n = this.probe.hitNormal;
    const p = this.probe.point;
    this.origin.set(
      p.x + n.x * INTRO.wallStandoff,
      y,
      p.z + n.z * INTRO.wallStandoff,
    );
    this.wallYaw = yawFacingNormal(n.x, n.z);
    this.baseScale = apparentScale(
      dist,
      INTRO.distance,
      INTRO.wallScaleMin,
      INTRO.wallScaleMax,
    );
    return true;
  }

  private endIntro(): void {
    if (this.root) this.root.visible = false;
    if (this.burst) this.burst.count = 0;
    this.setHudVisible(true);
    this.phase = Phase.Finished;
  }

  private setHudVisible(visible: boolean): void {
    if (!INTRO.hideHud) return;
    if (visible === !this.hudHidden) return;
    for (const entity of this.queries.hud.entities) {
      if (entity.object3D) entity.object3D.visible = visible;
    }
    this.hudHidden = !visible;
  }

  private spawnBurst(): void {
    const n = this.px?.length ?? 0;
    if (!this.burst || n === 0) return;
    for (let i = 0; i < n; i++) {
      // Even ring with jitter, mostly in the logo's plane, a little toward you.
      const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.35;
      const speed = INTRO.particleSpeedMin + Math.random() * (INTRO.particleSpeedMax - INTRO.particleSpeedMin);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // Start on an ellipse hugging the logo, not a single point.
      this.px[i] = ca * INTRO.logoWidth * 0.32;
      this.py[i] = sa * INTRO.logoWidth * 0.1;
      this.pz[i] = 0.02;
      this.vx[i] = ca * speed;
      this.vy[i] = sa * speed * 0.75 + 0.25;
      this.vz[i] = 0.2 + Math.random() * 0.6;
      this.rot[i] = Math.random() * Math.PI * 2;
      this.spin[i] = (Math.random() - 0.5) * 6;
      this.size[i] = INTRO.particleSizeMin + Math.random() * (INTRO.particleSizeMax - INTRO.particleSizeMin);
      this.life[i] = INTRO.particleLifeMin + Math.random() * (INTRO.particleLifeMax - INTRO.particleLifeMin);
    }
    this.burstAge = 0;
    this.burst.count = n;
  }

  private stepBurst(dt: number): void {
    const burst = this.burst;
    if (!burst || this.burstAge < 0) return;
    this.burstAge += dt;
    const age = this.burstAge;
    const n = this.px.length;
    const damp = Math.exp(-INTRO.particleDrag * dt);
    let alive = 0;
    for (let i = 0; i < n; i++) {
      this.vx[i] *= damp;
      this.vy[i] = this.vy[i] * damp - INTRO.particleGravity * dt;
      this.vz[i] *= damp;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.rot[i] += this.spin[i] * dt;
      const k = age / this.life[i];
      // Pop to full size fast, shrink away over the last 40%.
      const s = k >= 1 ? 0 : this.size[i] * Math.min(1, k * 8) * Math.min(1, (1 - k) / 0.4);
      if (s > 0) alive++;
      this.quat.setFromAxisAngle(this.zAxis, this.rot[i]);
      this.pos.set(this.px[i], this.py[i], this.pz[i]);
      this.scl.set(s, s, s);
      this.matrix.compose(this.pos, this.quat, this.scl);
      burst.setMatrixAt(i, this.matrix);
    }
    burst.instanceMatrix.needsUpdate = true;
    if (alive === 0) {
      burst.count = 0;
      this.burstAge = -1;
    }
  }

  update(delta: number) {
    if (this.phase === Phase.Idle || this.phase === Phase.Finished) return;
    // Paused (Quest menu, headset off): freeze exactly where it is.
    if (!this.visible) return;
    const dt = Math.min(Math.max(delta, 0), 0.1);

    if (this.phase === Phase.Waiting) {
      // A round may have started during the start delay (A button): bail.
      if (!introAllowedInPhase(this.gamePhase?.peek() ?? GamePhase.Idle)) {
        this.endIntro();
        return;
      }
      this.wait -= dt;
      if (this.wait <= 0) this.beginIntro();
      return;
    }

    this.t += dt;
    const t = this.t;

    // Skip: any pinch / trigger on either hand. Never consumed — the same
    // press still does whatever it normally does.
    if (t > INTRO.skipLockSec && t < this.exitAt) {
      const left = this.input.gamepads.left;
      const right = this.input.gamepads.right;
      if (left?.getSelectStart() || right?.getSelectStart()) {
        this.exitAt = skipExit(t, this.exitAt);
        this.exitSec = INTRO.skipExitSec;
      }
    }

    if (!this.splatted && t >= INTRO.logoStartSec) {
      this.splatted = true;
      this.playCue(this.splatCue, INTRO.splatVolume);
      if (!this.reduced) this.spawnBurst();
    }
    if (!this.chimed && t >= INTRO.taglineStartSec && t < this.exitAt) {
      this.chimed = true;
      this.playCue(this.chime, INTRO.chimeVolume);
    }

    const f = evaluateIntro(t, this.exitAt, this.exitSec, INTRO, this.reduced, this.frame);
    this.apply(f);
    this.stepBurst(dt);
    if (f.hudVisible) this.setHudVisible(true);
    if (f.done) this.endIntro();
  }

  private apply(f: IntroFrame): void {
    const root = this.root!;
    root.position.set(this.origin.x, this.origin.y + f.rise, this.origin.z);
    root.scale.setScalar(Math.max(1e-3, f.groupScale * this.baseScale));

    for (let i = 0; i < this.splats.length; i++) {
      const mesh = this.splats[i];
      const base = mesh.userData.baseScale as number;
      // Splats pop a beat apart, and blow outward as they fade on the exit.
      const s = Math.max(1e-3, base * f.splatScale * (1 + (1 - f.fade) * (0.25 + i * 0.1)));
      mesh.scale.set(s, s, 1);
      this.splatMaterials[i].opacity =
        f.splatAlpha * f.fade * (mesh.userData.ink ? 0.88 : INTRO.splatOpacity);
    }

    if (this.logo && this.logoMaterial) {
      const w = Math.max(1e-3, INTRO.logoWidth * f.logoScale);
      this.logo.scale.set(w, w * this.logoAspect, 1);
      // Slight tilt that settles as the pop lands.
      this.logo.rotation.z = (1 - Math.min(1, f.logoScale)) * 0.12;
      this.logoMaterial.opacity = f.logoAlpha * f.fade;
      this.logo.visible = this.logoMaterial.map !== null && f.logoAlpha > 0;
    }

    if (this.tagline && this.taglineMaterial) {
      const below = INTRO.logoWidth * this.logoAspect * 0.5 + 0.05;
      this.tagline.position.set(0, -below - f.taglineDrop, 0.01);
      this.taglineMaterial.opacity = f.taglineAlpha * f.fade;
      this.tagline.visible = f.taglineAlpha > 0;
    }

    if (this.ring && this.ringMaterial) {
      const p = f.ringProgress;
      const r = Math.max(1e-3, 0.15 + easeOutCubic(p) * INTRO.ringRadius);
      this.ring.scale.set(r, r * 0.55, 1);
      this.ringMaterial.opacity = p > 0 && p < 1 ? (1 - p) * (1 - p) * 0.9 : 0;
      this.ring.visible = this.ringMaterial.opacity > 0;
    }

    if (this.burstMaterial) this.burstMaterial.opacity = f.fade;
  }
}
