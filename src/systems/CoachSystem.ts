import {
  CanvasTexture,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
  createSystem,
} from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import { COACH } from '../config';
import {
  AimTargets,
  GameEvent,
  GameEventBuffer,
  GamePhase,
  markSeen,
  readMask,
  shouldCoach,
  unpackPopArchetype,
  unpackPopSlot,
  writeMask,
} from '../types';
import type { FlagStorage } from '../types';

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** The tip for `archetype`, or '' (Mopsy, unknown). */
export function coachLineFor(archetype: number, lines: readonly string[]): string {
  return archetype > 0 && archetype < lines.length ? lines[archetype] ?? '' : '';
}

/** Is coaching allowed now? Real rounds only: never in practice, menus or Chill. */
export function coachingActive(phase: GamePhase, practice: boolean): boolean {
  return phase === GamePhase.Playing && !practice;
}

/** `window.localStorage`, or undefined where touching it throws. */
function safeStorage(): FlagStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Round 9: first-encounter coaching. The first time each Neatnik type turns
 * up in a real round (Squeegee, Peekaboo, Duster Duke - Mopsy is the
 * tutorial's), a ~3 s tip takes over the HUD status line (`globals.coachLine`)
 * and floats over the bot itself.
 *
 * Keys off TargetSystem's `BotSpawned` event (and `BossEntered`, the Duke's
 * own). Seen types are a bitmask, kept per session and remembered on the
 * device (COACH.storageKey) so a veteran is never nagged. The floating label
 * is one canvas-textured quad, billboarded to the head; it follows the bot
 * through `aimTargets` while it is hittable and holds its last spot while a
 * Peekaboo is ducked. No Interactable, no physics, raycast disabled.
 */
export class CoachSystem extends createSystem({}) {
  private gamePhase!: Signal<GamePhase>;
  private practice?: Signal<boolean>;
  private coachLine?: Signal<string>;
  private events!: GameEventBuffer;
  private aim?: AimTargets;

  private seen = 0;
  private timeLeft = 0;
  private slot = -1;
  private label?: Mesh;
  private labelMaterial?: MeshBasicMaterial;
  private labelTexture?: CanvasTexture;
  private canvas?: HTMLCanvasElement;
  private readonly anchor = new Vector3();
  private readonly head = new Vector3();

  init() {
    this.gamePhase = this.globals.gamePhase as Signal<GamePhase>;
    this.practice = this.globals.practice as Signal<boolean> | undefined;
    this.coachLine = this.globals.coachLine as Signal<string> | undefined;
    this.events = this.globals.gameEvents as GameEventBuffer;
    this.aim = this.globals.aimTargets as AimTargets | undefined;
    this.seen = readMask(safeStorage(), COACH.storageKey);
    if (!COACH.enabled) return;
    if (COACH.floatingLabel) this.buildLabel();

    this.cleanupFuncs.push(
      this.gamePhase.subscribe((phase) => {
        if (phase !== GamePhase.Playing) this.clear();
      }),
    );
  }

  /** Forget every seen type (device and session) - for the harness / a reset. */
  resetSeen(): void {
    this.seen = 0;
    writeMask(safeStorage(), COACH.storageKey, 0);
  }

  update(delta: number) {
    if (!COACH.enabled) return;
    const playing = coachingActive(
      this.gamePhase.peek(),
      this.practice?.peek() === true,
    );

    if (playing) {
      const events = this.events;
      const count = events?.count ?? 0;
      for (let i = 0; i < count; i++) {
        const type = events.typeAt(i);
        if (type !== GameEvent.BotSpawned && type !== GameEvent.BossEntered) continue;
        const data = events.dataAt(i);
        // BossEntered carries the bare slot; BotSpawned a packPopData word.
        const archetype = type === GameEvent.BossEntered ? 3 : unpackPopArchetype(data);
        const slot = type === GameEvent.BossEntered ? data & 0xff : unpackPopSlot(data);
        if (!shouldCoach(archetype, this.seen)) continue;
        this.seen = markSeen(this.seen, archetype);
        writeMask(safeStorage(), COACH.storageKey, this.seen);
        this.show(archetype, slot, events.xAt(i), events.yAt(i), events.zAt(i));
      }
    }

    if (this.timeLeft <= 0) return;
    // The tip's clock stops with the round (paused) but not on a hidden label.
    if ((this.globals.paused as Signal<boolean> | undefined)?.peek()) return;
    this.timeLeft -= Math.min(Math.max(delta, 0), 0.1);
    if (this.timeLeft <= 0 || !playing) {
      this.clear();
      return;
    }
    this.placeLabel();
  }

  private show(archetype: number, slot: number, x: number, y: number, z: number): void {
    const text = coachLineFor(archetype, COACH.lines);
    if (!text) return;
    this.timeLeft = COACH.showSec;
    this.slot = slot;
    this.anchor.set(x, y, z);
    if (this.coachLine) this.coachLine.value = text;
    if (this.label && this.labelMaterial) {
      this.drawLabel(text);
      this.label.visible = true;
      this.placeLabel();
    }
  }

  private clear(): void {
    this.timeLeft = 0;
    this.slot = -1;
    if (this.label) this.label.visible = false;
    if (this.coachLine && this.coachLine.peek() !== '') this.coachLine.value = '';
  }

  /** Over the bot (live position while hittable), facing the head. */
  private placeLabel(): void {
    const label = this.label;
    if (!label || !label.visible) return;
    const aim = this.aim;
    const s = this.slot;
    if (aim && s >= 0 && s < aim.capacity && aim.active[s]) {
      this.anchor.set(aim.positions[s * 3], aim.positions[s * 3 + 1], aim.positions[s * 3 + 2]);
    }
    label.position.set(this.anchor.x, this.anchor.y + COACH.labelAbove, this.anchor.z);
    this.player.head.getWorldPosition(this.head);
    label.rotation.set(
      0,
      Math.atan2(this.head.x - label.position.x, this.head.z - label.position.z),
      0,
    );
  }

  private buildLabel(): void {
    if (typeof document === 'undefined') return;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1024;
    this.canvas.height = 128;
    this.labelTexture = new CanvasTexture(this.canvas);
    this.labelTexture.colorSpace = SRGBColorSpace;
    this.labelMaterial = new MeshBasicMaterial({
      map: this.labelTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      side: DoubleSide,
    });
    const mesh = new Mesh(new PlaneGeometry(1, 1), this.labelMaterial);
    mesh.scale.set(COACH.labelWidth, COACH.labelWidth / 8, 1);
    mesh.renderOrder = 995;
    mesh.visible = false;
    mesh.raycast = () => {};
    mesh.name = 'CoachLabel';
    this.label = mesh;
    this.world.createTransformEntity(mesh, {
      parent: this.world.sceneEntity,
      persistent: true,
    });
  }

  /** Amber pill, dark ink, the tip in caps-friendly bold. */
  private drawLabel(text: string): void {
    const canvas = this.canvas;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !this.labelTexture) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.font = "800 54px Rubik, 'Arial Black', 'Helvetica Neue', Arial, sans-serif";
    const tw = Math.min(w - 24, ctx.measureText(text).width + 72);
    const x0 = (w - tw) / 2;
    const r = h * 0.38;
    ctx.fillStyle = 'rgba(11, 12, 20, 0.88)';
    ctx.strokeStyle = '#ffd23f';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(x0 + r, 10);
    ctx.lineTo(x0 + tw - r, 10);
    ctx.arcTo(x0 + tw, 10, x0 + tw, h / 2, r);
    ctx.arcTo(x0 + tw, h - 10, x0 + tw - r, h - 10, r);
    ctx.lineTo(x0 + r, h - 10);
    ctx.arcTo(x0, h - 10, x0, h / 2, r);
    ctx.arcTo(x0, 10, x0 + r, 10, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffd23f';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 3, w - 60);
    this.labelTexture.needsUpdate = true;
  }
}
