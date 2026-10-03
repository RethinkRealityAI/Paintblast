import {
  AdditiveBlending,
  BufferAttribute,
  CanvasTexture,
  Color,
  Group,
  IcosahedronGeometry,
  InputComponent,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Path,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Shape,
  ShapeGeometry,
  TorusGeometry,
  Vector3,
  CircleGeometry,
  createComponent,
  createSystem,
  setWorldPosition,
  setWorldQuaternion,
} from '@iwsdk/core';
import type { Object3D } from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';

import { MENU, WEB } from '../config';
import {
  BLASTER_MODE_LABELS,
  BallKind,
  BallStyle,
  BlasterMode,
  GameEvent,
  GameEventBuffer,
  PALETTE_CHIP_ORDER,
  PALETTE_DAB_ORDER,
  WebSubMode,
  WristMenuState,
  isPrintableAscii,
  readFlag,
  srgbToLinear,
  writeFlag,
  GamePhase,
} from '../types';
import type { FlagStorage } from '../types';
import { smoothingAlpha } from '../wrist-frame';
import { WristPose, isTracked } from '../wrist-pose';
import { GauntletSystem } from './GauntletSystem';
import {
  MENU_ROW_CAPTIONS,
  MENU_SUBMODE_LABELS,
  MenuCloseReason,
  MenuItemKind,
  PokePhase,
  buildMenuLayout,
  controllerMenuToggle,
  createGemPokeState,
  createPaletteLock,
  createPokeState,
  hitTestMenu,
  inPokeZone,
  inverseRotate,
  menuAutoClose,
  menuClosesAfterPick,
  menuRayHit,
  paletteLabelText,
  stepGemPoke,
  stepOpenProgress,
  stepPoke,
  stepPaletteLock,
} from '../wrist-menu';
import type { MenuItem, MenuLayout } from '../wrist-menu';

/** Marks the wrist menu's panel root (built by main.ts's `seedWristMenu`). */
export const WristMenuRoot = createComponent('WristMenuRoot', {});
/** Marks the summon gem's root (built by main.ts's `seedWristMenu`). */
export const WristMenuGem = createComponent('WristMenuGem', {});

/** userData key the panel / gem visual handles hang under. */
export const MENU_VISUALS_KEY = 'wristMenuVisuals';

/** The slice of a three material the menu animates. */
interface FadeMaterial {
  opacity: number;
}

/** One button's animated parts. */
export interface MenuButtonVisual {
  group: Object3D;
  plate: MeshBasicMaterial;
  rim: FadeMaterial;
  glow: FadeMaterial;
  face: FadeMaterial;
  /** Plate colour at rest, and tinted toward the accent when selected. */
  restColor: Color;
  selectedColor: Color;
}

/** Everything the system animates on the panel. Built once, at startup. */
export interface MenuPanelVisuals {
  /** Two backgrounds: index 0 short (no GOO row), 1 tall. */
  backgrounds: [Object3D, Object3D];
  /** One per layout row, in MenuItemKind order. */
  captions: Object3D[];
  /** One per layout item (same index). */
  buttons: MenuButtonVisual[];
  /** Static materials and their resting opacity, faded with the panel. */
  statics: Array<{ material: FadeMaterial; base: number }>;
  /** [short, tall], from buildMenuLayout. */
  layouts: [MenuLayout, MenuLayout];
}

/** The gem's animated parts. */
export interface MenuGemVisuals {
  /** Billboarded toward the eyes (ring + halo + core). */
  spin: Object3D;
  core: MeshStandardMaterial;
  ring: MeshBasicMaterial;
  halo: MeshBasicMaterial;
}

const SAME_COLOR_EPS = 1e-4;

// ---------------------------------------------------------------------------
// Visual builders (startup only)
// ---------------------------------------------------------------------------

/** A rounded rectangle centred on the origin. */
function roundedRectPath(target: Shape | Path, w: number, h: number, r: number): void {
  const x = -w / 2;
  const y = -h / 2;
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  target.moveTo(x + rr, y);
  target.lineTo(x + w - rr, y);
  target.absarc(x + w - rr, y + rr, rr, -Math.PI / 2, 0, false);
  target.lineTo(x + w, y + h - rr);
  target.absarc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2, false);
  target.lineTo(x + rr, y + h);
  target.absarc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI, false);
  target.lineTo(x, y + rr);
  target.absarc(x + rr, y + rr, rr, Math.PI, Math.PI * 1.5, false);
}

function roundedRect(w: number, h: number, r: number): ShapeGeometry {
  const s = new Shape();
  roundedRectPath(s, w, h, r);
  return new ShapeGeometry(s, 6);
}

/** A rounded-rect outline `t` metres thick (outer edge at w x h). */
function roundedRing(w: number, h: number, r: number, t: number): ShapeGeometry {
  const s = new Shape();
  roundedRectPath(s, w, h, r);
  const hole = new Path();
  roundedRectPath(hole, w - 2 * t, h - 2 * t, Math.max(0, r - t));
  s.holes.push(hole);
  return new ShapeGeometry(s, 6);
}

function unlit(color: string | Color, opacity: number, additive = false): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color: typeof color === 'string' ? new Color(color) : color,
    toneMapped: false,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: additive ? AdditiveBlending : undefined,
  });
}

/** Paint a left-to-right sRGB ramp a -> b onto a geometry's vertices (by x). */
function rampVertexColors(geometry: ShapeGeometry, width: number, a: string, b: string): void {
  const ca = new Color(a);
  const cb = new Color(b);
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, pos.getX(i) / width + 0.5));
    // Colors are already linear in three; lerp in linear space.
    c.copy(ca).lerp(cb, t);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
}

/** A transparent plane wearing a baked canvas. */
function canvasPlane(
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D, pw: number, ph: number) => void,
): { mesh: Mesh; material: MeshBasicMaterial } {
  const ppm = MENU.texturePxPerMeter;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(16, Math.round(w * ppm));
  canvas.height = Math.max(16, Math.round(h * ppm));
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    draw(ctx, canvas.width, canvas.height);
  }
  const texture = new CanvasTexture(canvas);
  // 2D canvas pixels are sRGB; unmarked, three would treat them as linear.
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new Mesh(new PlaneGeometry(w, h), material);
  return { mesh, material };
}

const FONT_STACK = '"Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif';

/** White condensed caps with a neon bloom and a dark keyline. ASCII only. */
function neonText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  px: number,
  accent: string,
  maxWidth: number,
): void {
  if (!isPrintableAscii(text)) {
    console.warn(`[Splotopia] menu label "${text}" is not plain ASCII`);
  }
  ctx.font = `800 ${Math.round(px)}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.shadowColor = accent;
  ctx.shadowBlur = Math.round(px * 0.35);
  ctx.fillStyle = accent;
  ctx.fillText(text, x, y, maxWidth);
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(2, Math.round(px * 0.12));
  ctx.strokeStyle = 'rgba(6, 7, 12, 0.85)';
  ctx.strokeText(text, x, y, maxWidth);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, x, y, maxWidth);
}

/** A rounded capsule from (x, y0) to (x, y1), `w` wide, as one Shape. */
function capsuleShape(x: number, y0: number, y1: number, w: number): Shape {
  const r = w / 2;
  const s = new Shape();
  s.moveTo(x - r, y0);
  s.lineTo(x - r, y1);
  s.absarc(x, y1, r, Math.PI, 0, true);
  s.lineTo(x + r, y0);
  s.absarc(x, y0, r, 0, Math.PI, true);
  return s;
}

/** A filled polygon Shape from [x, y] pairs. */
function polyShape(points: ReadonlyArray<readonly [number, number]>): Shape {
  const s = new Shape();
  points.forEach(([x, y], i) => (i === 0 ? s.moveTo(x, y) : s.lineTo(x, y)));
  s.closePath();
  return s;
}

/**
 * The launcher icons (moved from the round-8 palette pads), authored in a unit
 * box centred on the origin, +Y up. HAND is an open palm, BLASTER a paint gun
 * in profile, GOO a web.
 */
export function modeIconShapes(mode: BlasterMode): Shape[] {
  if (mode === BlasterMode.Hand) {
    const palm = new Shape();
    palm.moveTo(-0.28, 0.04);
    palm.lineTo(0.28, 0.04);
    palm.lineTo(0.28, -0.22);
    palm.absarc(0.1, -0.22, 0.18, 0, -Math.PI / 2, true);
    palm.lineTo(-0.12, -0.4);
    palm.absarc(-0.12, -0.24, 0.16, -Math.PI / 2, -Math.PI, true);
    palm.closePath();
    const thumb = polyShape([
      [-0.28, -0.16],
      [-0.5, 0.04],
      [-0.42, 0.13],
      [-0.2, -0.04],
    ]);
    return [
      palm,
      thumb,
      capsuleShape(-0.215, 0.0, 0.3, 0.1),
      capsuleShape(-0.07, 0.0, 0.42, 0.1),
      capsuleShape(0.075, 0.0, 0.38, 0.1),
      capsuleShape(0.215, 0.0, 0.24, 0.1),
    ];
  }
  if (mode === BlasterMode.Paint) {
    const canister = new Shape();
    canister.absarc(-0.05, 0.3, 0.13, 0, Math.PI * 2, false);
    return [
      polyShape([
        [-0.45, -0.02],
        [0.3, -0.02],
        [0.3, 0.2],
        [-0.45, 0.2],
      ]),
      polyShape([
        [0.3, 0.03],
        [0.48, 0.03],
        [0.48, 0.15],
        [0.3, 0.15],
      ]),
      polyShape([
        [-0.33, -0.02],
        [-0.12, -0.02],
        [-0.2, -0.45],
        [-0.42, -0.45],
      ]),
      canister,
    ];
  }
  const ring = (outer: number, inner: number) => {
    const s = new Shape();
    s.absarc(0, 0, outer, 0, Math.PI * 2, false);
    const hole = new Path();
    hole.absarc(0, 0, inner, 0, Math.PI * 2, true);
    s.holes.push(hole);
    return s;
  };
  const shapes = [ring(0.46, 0.38), ring(0.25, 0.18)];
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 4;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const half = 0.035;
    const len = 0.48;
    shapes.push(
      polyShape([
        [c * len - s * half, s * len + c * half],
        [c * len + s * half, s * len - c * half],
        [-c * len + s * half, -s * len - c * half],
        [-c * len - s * half, -s * len + c * half],
      ]),
    );
  }
  return shapes;
}

/** Fill three Shapes (holes included) into a canvas box centred at (cx, cy). */
function drawShapes(
  ctx: CanvasRenderingContext2D,
  shapes: Shape[],
  cx: number,
  cy: number,
  size: number,
  fill: string,
  glow: string,
): void {
  ctx.save();
  ctx.shadowColor = glow;
  ctx.shadowBlur = size * 0.12;
  ctx.fillStyle = fill;
  for (const shape of shapes) {
    ctx.beginPath();
    const trace = (pts: Array<{ x: number; y: number }>) => {
      pts.forEach((p, i) => {
        const x = cx + p.x * size;
        const y = cy - p.y * size;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
    };
    trace(shape.getPoints(10));
    for (const hole of shape.holes) trace(hole.getPoints(10));
    ctx.fill('evenodd');
  }
  ctx.restore();
}

/** A cartoon paint splat (deterministic), centred at (cx, cy), radius r px. */
function drawSplat(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  fill: string,
  seed: number,
): void {
  let state = seed;
  const rand = () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
  ctx.save();
  ctx.fillStyle = fill;
  ctx.shadowColor = fill;
  ctx.shadowBlur = r * 0.35;
  const disc = (x: number, y: number, rr: number) => {
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.fill();
  };
  disc(cx, cy, r * 0.66);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + rand() * 0.6;
    const d = r * (0.55 + rand() * 0.25);
    disc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * (0.17 + rand() * 0.13));
  }
  for (let i = 0; i < 3; i++) {
    const a = rand() * Math.PI * 2;
    const d = r * (1.0 + rand() * 0.25);
    disc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * (0.06 + rand() * 0.06));
  }
  // A glossy highlight, so it reads as wet paint.
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.25, cy - r * 0.28, r * 0.2, r * 0.11, -0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** A tether hook icon, centred at (cx, cy), `s` px tall. */
function drawHook(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = s * 0.15;
  ctx.lineWidth = s * 0.13;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx + s * 0.12, cy - s * 0.48);
  ctx.lineTo(cx + s * 0.12, cy + s * 0.08);
  ctx.arc(cx - s * 0.06, cy + s * 0.08, s * 0.18, 0, Math.PI * 0.95, false);
  ctx.stroke();
  // Barb.
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.24, cy + s * 0.1);
  ctx.lineTo(cx - s * 0.3, cy - s * 0.06);
  ctx.stroke();
  // Line out of the eye.
  ctx.lineWidth = s * 0.05;
  ctx.setLineDash([s * 0.06, s * 0.06]);
  ctx.beginPath();
  ctx.moveTo(cx + s * 0.12, cy - s * 0.48);
  ctx.lineTo(cx + s * 0.42, cy - s * 0.62);
  ctx.stroke();
  ctx.restore();
}

/** The small glyph on an ammo button (same silhouettes as the old chips). */
function drawAmmoGlyph(
  ctx: CanvasRenderingContext2D,
  kind: BallKind,
  cx: number,
  cy: number,
  r: number,
  color: string,
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = r * 0.5;
  ctx.lineWidth = r * 0.22;
  switch (kind) {
    case BallKind.Bouncy:
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cx, cy, r * 1.05, r * 0.4, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case BallKind.Sticky: {
      const s = r * 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - s / 2 + 3, cy - s / 2);
      ctx.lineTo(cx + s / 2, cy - s / 2);
      ctx.lineTo(cx + s / 2, cy + s / 2);
      ctx.lineTo(cx - s / 2, cy + s / 2);
      ctx.lineTo(cx - s / 2, cy - s / 2);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case BallKind.Splash:
      ctx.beginPath();
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2 - Math.PI / 2;
        const rr = i % 2 === 0 ? r * 1.1 : r * 0.5;
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      break;
    default:
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2);
      ctx.fill();
  }
  ctx.restore();
}

/** Accent colour (hex) of a menu item. */
function itemAccent(item: MenuItem): string {
  switch (item.kind) {
    case MenuItemKind.Launcher:
      return MENU.launcherColors[item.column] ?? '#48dbfb';
    case MenuItemKind.SubMode:
      return MENU.subModeColors[item.column] ?? '#48dbfb';
    case MenuItemKind.Colour: {
      const c = PALETTE_DAB_ORDER[item.value];
      const hex = (v: number) =>
        Math.round(Math.min(1, Math.max(0, v)) * 255)
          .toString(16)
          .padStart(2, '0');
      return `#${hex(c[0])}${hex(c[1])}${hex(c[2])}`;
    }
    default:
      return PALETTE_CHIP_ORDER[item.value]?.color ?? '#ffffff';
  }
}

/** Draw one button's face into its canvas. */
function drawButtonFace(
  ctx: CanvasRenderingContext2D,
  item: MenuItem,
  pw: number,
  ph: number,
): void {
  const accent = itemAccent(item);
  switch (item.kind) {
    case MenuItemKind.Launcher: {
      const iconSize = ph * 0.5;
      drawShapes(ctx, modeIconShapes(item.value as BlasterMode), pw / 2, ph * 0.38, iconSize, '#ffffff', accent);
      neonText(
        ctx,
        paletteLabelText(BLASTER_MODE_LABELS[item.value as BlasterMode]),
        pw / 2,
        ph * 0.8,
        ph * 0.25,
        accent,
        pw * 0.9,
      );
      break;
    }
    case MenuItemKind.SubMode: {
      // Icon on the left, the verb big on the right — clear of each other.
      const iconX = ph * 0.48;
      if (item.value === WebSubMode.Tether) {
        drawHook(ctx, iconX + ph * 0.04, ph * 0.56, ph * 0.62, accent);
      } else {
        drawSplat(ctx, iconX, ph * 0.5, ph * 0.24, accent, 7);
      }
      const textLeft = iconX + ph * 0.42;
      const textRight = pw - ph * 0.12;
      neonText(
        ctx,
        MENU_SUBMODE_LABELS[item.value as WebSubMode],
        (textLeft + textRight) / 2,
        ph * 0.54,
        ph * 0.4,
        accent,
        textRight - textLeft,
      );
      break;
    }
    case MenuItemKind.Colour:
      drawSplat(ctx, pw / 2, ph / 2, Math.min(pw, ph) * 0.3, accent, 11 + item.value * 7);
      break;
    default: {
      const spec = PALETTE_CHIP_ORDER[item.value];
      if (!spec) break;
      drawAmmoGlyph(ctx, spec.kind, pw / 2, ph * 0.36, ph * 0.15, accent);
      neonText(ctx, paletteLabelText(spec.label), pw / 2, ph * 0.77, ph * 0.26, accent, pw * 0.92);
    }
  }
}

/** One panel background (dark glass slab, gradient neon edge, halo). */
function buildBackground(
  w: number,
  h: number,
  statics: MenuPanelVisuals['statics'],
): Object3D {
  const group = new Group();
  group.name = 'WristMenuBackground';
  const slabMat = unlit(MENU.panelColor, MENU.panelOpacity);
  const slab = new Mesh(roundedRect(w, h, MENU.panelCorner), slabMat);
  slab.renderOrder = 10;
  const lineGeo = roundedRing(w, h, MENU.panelCorner, 0.0011);
  rampVertexColors(lineGeo, w, MENU.edgeColor, MENU.edgeAccent);
  const lineMat = unlit('#ffffff', 1);
  lineMat.vertexColors = true;
  const line = new Mesh(lineGeo, lineMat);
  line.position.z = 0.0004;
  line.renderOrder = 11;
  const glowGeo = roundedRing(w + 0.006, h + 0.006, MENU.panelCorner + 0.003, 0.005);
  rampVertexColors(glowGeo, w, MENU.edgeColor, MENU.edgeAccent);
  const glowMat = unlit('#ffffff', MENU.edgeGlowOpacity, true);
  glowMat.vertexColors = true;
  const glow = new Mesh(glowGeo, glowMat);
  glow.renderOrder = 11;
  group.add(slab, line, glow);
  statics.push(
    { material: slabMat, base: MENU.panelOpacity },
    { material: lineMat, base: 1 },
    { material: glowMat, base: MENU.edgeGlowOpacity },
  );
  return group;
}

/**
 * Build the menu panel: two backgrounds (with and without the GOO row), the
 * row captions and every button, in the panel's XY plane facing +Z. Decoration
 * only — none of it is an entity, nothing is Interactable, so IWSDK's pointer
 * pipeline never sees it. WristMenuSystem does all the hit testing.
 */
export function buildWristMenuPanel(): { group: Group; visuals: MenuPanelVisuals } {
  const group = new Group();
  group.name = 'WristMenu';
  const layouts: [MenuLayout, MenuLayout] = [
    buildMenuLayout(false, MENU),
    buildMenuLayout(true, MENU),
  ];
  const statics: MenuPanelVisuals['statics'] = [];
  const backgrounds: [Object3D, Object3D] = [
    buildBackground(layouts[0].width, layouts[0].height, statics),
    buildBackground(layouts[1].width, layouts[1].height, statics),
  ];
  group.add(backgrounds[0], backgrounds[1]);

  const captions: Object3D[] = [];
  for (const caption of layouts[1].captions) {
    const text = MENU_ROW_CAPTIONS[caption.kind];
    const w = layouts[1].width - 2 * MENU.padding;
    const { mesh, material } = canvasPlane(w, MENU.captionHeight, (ctx, pw, ph) => {
      ctx.font = `700 ${Math.round(ph * 0.82)}px ${FONT_STACK}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = MENU.captionColor;
      ctx.shadowColor = MENU.edgeColor;
      ctx.shadowBlur = ph * 0.3;
      ctx.fillText(text, 2, ph / 2);
      // A thin rule after the word, techno style.
      const tw = ctx.measureText(text).width;
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(72, 219, 251, 0.35)';
      ctx.fillRect(tw + ph * 0.5, ph * 0.48, pw - tw - ph * 0.6, Math.max(1, ph * 0.06));
    });
    mesh.name = `WristMenuCaption_${text}`;
    mesh.renderOrder = 12;
    mesh.position.z = 0.0005;
    group.add(mesh);
    captions.push(mesh);
    statics.push({ material, base: 1 });
  }

  const buttons: MenuButtonVisual[] = [];
  for (const item of layouts[1].items) {
    const accentHex = itemAccent(item);
    const accent = new Color(accentHex);
    const g = new Group();
    g.name = `WristMenuButton_${item.kind}_${item.value}`;
    const restColor = new Color(MENU.buttonColor);
    const selectedColor = restColor.clone().lerp(accent, MENU.selectedFillMix);
    // Keep a selected plate dark enough for the white label to read: pale
    // accents (NORMAL's off-white, HAND's silver) would otherwise turn it grey.
    const hsl = { h: 0, s: 0, l: 0 };
    selectedColor.getHSL(hsl);
    if (hsl.l > 0.16) selectedColor.setHSL(hsl.h, hsl.s, 0.16);
    const plate = unlit(restColor.clone(), MENU.buttonOpacity);
    const plateMesh = new Mesh(roundedRect(item.w, item.h, MENU.buttonCorner), plate);
    plateMesh.renderOrder = 13;
    const glow = unlit(accent.clone(), 0, true);
    const glowMesh = new Mesh(
      roundedRing(item.w + 0.007, item.h + 0.007, MENU.buttonCorner + 0.0035, 0.004),
      glow,
    );
    glowMesh.renderOrder = 14;
    const rim = unlit(accent.clone(), MENU.rimOpacity);
    const rimMesh = new Mesh(roundedRing(item.w, item.h, MENU.buttonCorner, 0.0012), rim);
    rimMesh.position.z = 0.0003;
    rimMesh.renderOrder = 15;
    const face = canvasPlane(item.w - 0.003, item.h - 0.003, (ctx, pw, ph) =>
      drawButtonFace(ctx, item, pw, ph),
    );
    face.mesh.position.z = 0.0005;
    face.mesh.renderOrder = 16;
    g.add(plateMesh, glowMesh, rimMesh, face.mesh);
    group.add(g);
    buttons.push({
      group: g,
      plate,
      rim,
      glow,
      face: face.material,
      restColor,
      selectedColor,
    });
  }

  return { group, visuals: { backgrounds, captions, buttons, statics, layouts } };
}

/** A soft radial glow texture (white centre to transparent), baked once. */
function radialGlowTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The summon gem: a faceted crystal in the loaded paint colour, a neon ring in
 * the loaded launcher's colour (the always-visible, never-interactive loadout
 * glyph) and a soft halo. The `spin` group faces the eyes each frame.
 */
export function buildWristMenuGem(): { group: Group; visuals: MenuGemVisuals } {
  const group = new Group();
  group.name = 'WristMenuGem';
  const spin = new Group();
  const r = MENU.gemRadius;
  const core = new MeshStandardMaterial({
    color: new Color(1, 1, 1),
    emissive: new Color(1, 1, 1),
    emissiveIntensity: 0.65,
    roughness: 0.18,
    metalness: 0.25,
    flatShading: true,
  });
  const coreMesh = new Mesh(new IcosahedronGeometry(r, 0), core);
  coreMesh.name = 'WristMenuGemCore';
  const ring = unlit('#48dbfb', 0.95);
  const ringMesh = new Mesh(new TorusGeometry(r * 1.55, r * 0.13, 6, 32), ring);
  ringMesh.renderOrder = 2;
  const halo = new MeshBasicMaterial({
    map: radialGlowTexture(),
    color: new Color(1, 1, 1),
    transparent: true,
    opacity: MENU.gemGlowOpacity,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const haloMesh = new Mesh(new CircleGeometry(r * 2.6, 24), halo);
  haloMesh.position.z = -r * 0.5;
  haloMesh.renderOrder = 1;
  spin.add(haloMesh, ringMesh, coreMesh);
  group.add(spin);
  return { group, visuals: { spin, core, ring, halo } };
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

/** `window.localStorage`, or undefined where touching it throws. */
function safeStorage(): FlagStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

interface HapticPulseActuator {
  pulse?: (intensity: number, duration: number) => Promise<boolean> | void;
}
interface HapticGamepad {
  hapticActuators?: ArrayLike<HapticPulseActuator>;
}

/** Ease-out cubic, 0..1. */
function easeOut(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/**
 * Round 10: the summonable holographic wrist menu.
 *
 * Owner playtest, round 10: the always-on wrist palette (rounds 2-9) "is
 * completely interrupting the game ... always a bunch of accidental presses".
 * Its dabs, chips and pads were Interactable + PokeInteractable +
 * OneHandGrabbable, proximity-squeezable and pinch-selectable, and they rode
 * the very hand that also fires. This replaces all of it:
 *
 * - **Closed** (the default): only a small glowing **gem** on the left wrist,
 *   showing the loaded colour (core) and launcher / GOO verb (ring). Nothing
 *   else exists for input — no entity is Interactable, there is no proximity
 *   or pinch selection anywhere, and the closed menu never blocks a shot
 *   (`WristMenuState.open === 0`).
 * - **Summon**: poke the gem with the RIGHT index fingertip ({@link stepGemPoke}:
 *   enter-then-leave hysteresis, debounce, ignored mid-pinch), or press **Y**
 *   on the left controller ({@link controllerMenuToggle}).
 * - **Open**: a flat dark-glass panel floats above the left forearm, turned to
 *   the eyes: LAUNCHER (HAND / BLASTER / GOO), GOO MODE (SPLAT / TETHER, only
 *   while GOO is loaded), COLOUR (4 paints), AMMO (4 kinds). Press = poke
 *   through a button with the right index fingertip ({@link stepPoke}: hover
 *   glow, the button sinks, one select per poke, re-arms on backing out), or
 *   point the right controller's ray and pull the trigger. The panel parks in
 *   world space while the fingertip is in its poke zone.
 * - **Dismiss**: poke the gem again, Y, a launcher / GOO-verb pick
 *   (`MENU.closeOnPick`), `MENU.autoCloseIdleSec` of no interaction, or the
 *   left hand dropping tracking for `MENU.closeAfterLostSec`.
 *
 * Writes `globals.wristMenu` ({@link WristMenuState}) every frame for
 * BallSpawnSystem (the open panel blocks the ray that points at it; left fire
 * pauses while open; a press spent on the menu never fires) and the tutorial.
 * Selection writes the same loadout signals the palette did (`blasterMode`,
 * `webSubMode`, `activeColor`, `activeKind`, `activeStyle`) — BallSpawnSystem's
 * `syncBlasterMode` subscription keeps launcher and style in lockstep.
 *
 * Priority 8: before GauntletSystem (9) and BallSpawnSystem (11), so this
 * frame's menu state is settled before anything fires. Zero allocations in
 * update(); every scratch object is built in init().
 */
export class WristMenuSystem extends createSystem({
  roots: { required: [WristMenuRoot] },
  gems: { required: [WristMenuGem] },
}) {
  private state!: WristMenuState;
  private events?: GameEventBuffer;
  private blasterMode?: Signal<BlasterMode>;
  private webSubMode?: Signal<WebSubMode>;
  private activeColor?: Signal<readonly [number, number, number, number]>;
  private activeKind?: Signal<BallKind>;
  private activeStyle?: Signal<BallStyle>;
  private paused?: Signal<boolean>;

  private wrist!: WristPose;
  private readonly gemPoke = createGemPokeState();
  private readonly poke = createPokeState();
  private readonly lock = createPaletteLock();

  /** True while the menu is (or is becoming) open. */
  private wantOpen = false;
  /** Open-animation progress, 0 closed .. 1 open. */
  private progress = 0;
  private idleSec = 0;
  private lostSec = Number.POSITIVE_INFINITY;
  private clock = 0;
  private openedOnce = false;
  /** Which layout is applied: 0 short, 1 tall (GOO row); -1 none yet. */
  private appliedLayout = -1;
  /** Button under the right controller's ray, -1 none. */
  private rayHover = -1;
  private primed = false;
  private gliding = false;

  // Scratch.
  private headPos!: Vector3;
  private tip!: Vector3;
  private gemPos!: Vector3;
  private offset!: Vector3;
  private distal!: Vector3;
  private sideways!: Vector3;
  private top!: Vector3;
  private panelUp!: Vector3;
  private targetPos!: Vector3;
  private targetQ!: Quaternion;
  private shownPos!: Vector3;
  private shownQ!: Quaternion;
  private lookM!: Matrix4;
  private worldUp!: Vector3;
  private rayPos!: Vector3;
  private rayDir!: Vector3;
  private rayQ!: Quaternion;
  private local!: Float32Array;
  private hitXY!: Float32Array;

  init() {
    this.headPos = new Vector3();
    this.tip = new Vector3();
    this.gemPos = new Vector3();
    this.offset = new Vector3();
    this.distal = new Vector3();
    this.sideways = new Vector3();
    this.top = new Vector3();
    this.panelUp = new Vector3();
    this.targetPos = new Vector3();
    this.targetQ = new Quaternion();
    this.shownPos = new Vector3();
    this.shownQ = new Quaternion();
    this.lookM = new Matrix4();
    this.worldUp = new Vector3(0, 1, 0);
    this.rayPos = new Vector3();
    this.rayDir = new Vector3();
    this.rayQ = new Quaternion();
    this.local = new Float32Array(3);
    this.hitXY = new Float32Array(2);
    this.wrist = new WristPose('left');

    const globals = this.globals as Record<string, unknown>;
    // main.ts seeds it; a test world without it gets a private one.
    this.state = (globals.wristMenu as WristMenuState | undefined) ?? new WristMenuState();
    globals.wristMenu = this.state;
    this.events = globals.gameEvents as GameEventBuffer | undefined;
    this.blasterMode = globals.blasterMode as typeof this.blasterMode;
    this.webSubMode = globals.webSubMode as typeof this.webSubMode;
    this.activeColor = globals.activeColor as typeof this.activeColor;
    this.activeKind = globals.activeKind as typeof this.activeKind;
    this.activeStyle = globals.activeStyle as typeof this.activeStyle;
    this.paused = globals.paused as typeof this.paused;
    const gamePhase = globals.gamePhase as Signal<GamePhase> | undefined;
    this.openedOnce = readFlag(safeStorage(), MENU.firstOpenStorageKey);

    const subs: Array<() => void> = [];
    if (this.activeColor) subs.push(this.activeColor.subscribe(() => this.paintGemColors()));
    if (this.blasterMode) subs.push(this.blasterMode.subscribe(() => this.paintGemColors()));
    if (this.webSubMode) subs.push(this.webSubMode.subscribe(() => this.paintGemColors()));
    // A round starting or ending closes the menu: an open menu pauses left
    // fire and swallows right-hand shots near it. Playing itself is left
    // alone — the tutorial's practice (Playing) needs the menu for GOO/TETHER.
    if (gamePhase) {
      subs.push(
        gamePhase.subscribe((phase) => {
          if (phase === GamePhase.Countdown || phase === GamePhase.GameOver) this.close();
        }),
      );
    }
    this.cleanupFuncs.push(
      ...subs,
      this.queries.roots.subscribe('qualify', (root) => {
        const o = root.object3D;
        if (!o) return;
        o.visible = false;
        o.scale.setScalar(1e-4);
        this.appliedLayout = -1;
      }),
      this.queries.gems.subscribe('qualify', (gem) => {
        const o = gem.object3D;
        if (o) o.visible = false;
        this.paintGemColors();
      }),
    );
  }

  /** Public for the harness / MCP: is the menu open (or opening)? */
  get isOpen(): boolean {
    return this.wantOpen;
  }

  /** Public for the harness / MCP: open or close the menu as if summoned. */
  setOpen(open: boolean): void {
    if (open !== this.wantOpen) this.toggle();
  }

  update(delta: number) {
    const dt = Math.min(Math.max(delta, 0), 0.1);
    this.clock += dt;
    const state = this.state;

    const leftTracked = this.wrist.update(this.player, this.input, WEB);
    this.lostSec = leftTracked ? 0 : this.lostSec + dt;

    const head = this.player?.head;
    if (head) head.getWorldPosition(this.headPos);

    // ---- The gem ------------------------------------------------------------
    if (leftTracked) this.computeGem();
    const gemShown =
      this.primedGem && this.lostSec < MENU.gemHideAfterLostSec;
    state.gemVisible = gemShown ? 1 : 0;
    state.gem[0] = this.gemPos.x;
    state.gem[1] = this.gemPos.y;
    state.gem[2] = this.gemPos.z;

    const input = this.input;
    const rightTracked = !!input && isTracked(input, 'right');
    const rightPad = input?.gamepads?.right;
    // Only a tracked HAND has a fingertip: a right controller leaves the
    // index-tip space frozen where the hand last was (gotcha 21), which would
    // poke the gem / panel forever and block right-hand fire.
    const rightIsHand = !!input && input.isPrimary('hand', 'right');
    const tipSpace = this.player?.indexTipSpaces?.right;
    const tipOk = rightIsHand && !!tipSpace;
    if (tipOk) tipSpace!.getWorldPosition(this.tip);
    const pausedNow = this.paused?.peek() === true;

    if (!pausedNow) {
      const dist =
        tipOk && leftTracked && gemShown
          ? this.tip.distanceTo(this.gemPos)
          : Number.POSITIVE_INFINITY;
      const blocked = rightPad?.getSelecting() === true;
      if (stepGemPoke(this.gemPoke, dist, this.clock, blocked, MENU)) this.toggle();

      const leftPad = input?.gamepads?.left;
      if (
        leftPad &&
        input?.isPrimary('controller', 'left') &&
        controllerMenuToggle(
          leftPad.getButtonDown(InputComponent.Y_Button) === true,
          leftPad.getButtonDown(InputComponent.X_Button) === true,
          0,
        )
      ) {
        this.toggle();
      }
    }

    // ---- Auto close -----------------------------------------------------------
    if (this.wantOpen) {
      this.idleSec += dt;
      if (menuAutoClose(this.idleSec, this.lostSec, MENU) !== MenuCloseReason.None) {
        this.close();
      }
    }

    // ---- Animation + pose -----------------------------------------------------
    this.progress = stepOpenProgress(this.progress, this.wantOpen, dt, MENU.openSec);
    state.open = this.wantOpen && this.progress >= 1 ? 1 : 0;
    state.opening = this.wantOpen && this.progress < 1 ? 1 : 0;

    const layoutIndex = this.blasterMode?.peek() === BlasterMode.Web ? 1 : 0;
    const visuals = this.panelVisuals();
    if (visuals && layoutIndex !== this.appliedLayout) this.applyLayout(visuals, layoutIndex);
    const layout = visuals?.layouts[Math.max(0, this.appliedLayout)];

    if (this.progress > 0 && layout) {
      this.posePanel(dt, leftTracked, layout, tipOk);
    } else {
      for (const root of this.queries.roots.entities) {
        const o = root.object3D;
        if (o && o.visible) {
          o.visible = false;
          o.scale.setScalar(1e-4);
        }
      }
      this.primed = false;
      this.lock.locked = false;
    }

    // ---- Input on the open panel -----------------------------------------------
    state.tipNear = 0;
    this.rayHover = -1;
    if (state.open && layout && !pausedNow) {
      if (tipOk) {
        this.toPanel(this.tip.x, this.tip.y, this.tip.z);
        const lx = this.local[0];
        const ly = this.local[1];
        const lz = this.local[2];
        if (
          inPokeZone(lx, ly, lz, state.halfW, state.halfH, MENU.lockMarginMeters, MENU.lockFrontMeters, MENU.lockBehindMeters)
        ) {
          state.tipNear = 1;
        }
        const hit = hitTestMenu(layout, lx, ly, MENU.hitMarginMeters);
        const z = lz - MENU.buttonLift - MENU.tipRadiusMeters;
        const picked = stepPoke(this.poke, z, hit, true, MENU);
        if (this.poke.phase === PokePhase.Hover || this.poke.phase === PokePhase.Pressing) {
          this.idleSec = 0;
        }
        if (picked >= 0) this.pick(layout.items[picked], 'right');
      } else {
        stepPoke(this.poke, Number.NaN, -1, false, MENU);
      }

      // Right controller: ray hover + trigger click.
      if (rightTracked && !rightIsHand && rightPad && state.open) {
        const ray = this.player?.raySpaces?.right;
        if (ray) {
          ray.getWorldPosition(this.rayPos);
          ray.getWorldQuaternion(this.rayQ);
          this.rayDir.set(0, 0, -1).applyQuaternion(this.rayQ);
          if (
            menuRayHit(
              state,
              this.rayPos.x,
              this.rayPos.y,
              this.rayPos.z,
              this.rayDir.x,
              this.rayDir.y,
              this.rayDir.z,
              MENU.rayMaxMeters,
              0,
              this.local,
              this.hitXY,
            )
          ) {
            this.idleSec = 0;
            this.rayHover = hitTestMenu(layout, this.hitXY[0], this.hitXY[1], MENU.hitMarginMeters);
            if (rightPad.getSelectStart()) {
              // The trigger that clicks the menu never also fires.
              state.consumeMask |= 2;
              if (this.rayHover >= 0) this.pick(layout.items[this.rayHover], 'right');
            }
          }
        }
      }
    } else if (!state.open) {
      // Closed (or animating): no poke can be in progress. Behind, so a
      // finger already inside the panel when it opens must back out first.
      this.poke.phase = PokePhase.Behind;
      this.poke.target = -1;
      this.poke.depth = 0;
    }

    if (visuals && this.progress > 0 && layout) this.paintPanel(visuals, layout);
    this.paintGem(dt, gemShown);
  }

  // ---- Open / close / pick ----------------------------------------------------

  private toggle(): void {
    if (this.wantOpen) this.close();
    else this.open();
  }

  private open(): void {
    this.wantOpen = true;
    this.idleSec = 0;
    this.poke.phase = PokePhase.Behind;
    this.poke.target = -1;
    this.lock.locked = false;
    if (!this.openedOnce) {
      this.openedOnce = true;
      writeFlag(safeStorage(), MENU.firstOpenStorageKey, true);
    }
    this.cue(1);
  }

  private close(): void {
    if (!this.wantOpen) return;
    this.wantOpen = false;
    this.state.open = 0;
    this.cue(0);
  }

  /** Click + MenuToggled + a haptic tick on both controllers. */
  private cue(open: number): void {
    const g = this.state.gem;
    this.events?.emit(GameEvent.UiClick, g[0], g[1], g[2], 0);
    this.events?.emit(GameEvent.MenuToggled, g[0], g[1], g[2], open);
    this.pulse('left');
    this.pulse('right');
  }

  /** Apply one menu pick to the loadout signals. */
  private pick(item: MenuItem | undefined, side: 'left' | 'right'): void {
    if (!item) return;
    this.idleSec = 0;
    // Any pinch / trigger held right now was not meant as a shot.
    const input = this.input;
    for (let hand = 0; hand < 2; hand++) {
      const s = hand === 1 ? 'right' : 'left';
      if (input?.gamepads?.[s]?.getSelecting()) this.state.consumeMask |= 1 << hand;
    }
    switch (item.kind) {
      case MenuItemKind.Launcher:
        if (this.blasterMode && this.blasterMode.peek() !== item.value) {
          this.blasterMode.value = item.value as BlasterMode;
        }
        break;
      case MenuItemKind.SubMode:
        if (this.webSubMode && this.webSubMode.peek() !== item.value) {
          this.webSubMode.value = item.value as WebSubMode;
        }
        break;
      case MenuItemKind.Colour: {
        const c = PALETTE_DAB_ORDER[item.value];
        if (c && this.activeColor) this.activeColor.value = [c[0], c[1], c[2], c[3]];
        break;
      }
      default: {
        const spec = PALETTE_CHIP_ORDER[item.value];
        if (!spec) break;
        if (this.activeKind && this.activeKind.peek() !== spec.kind) {
          this.activeKind.value = spec.kind;
        }
        // A paint kind means paint: leaves GOO for the last paint launcher
        // (BallSpawnSystem's syncBlasterMode subscription).
        if (this.activeStyle && this.activeStyle.peek() !== spec.style) {
          this.activeStyle.value = spec.style;
        }
      }
    }
    this.events?.emit(GameEvent.AmmoSelected, 0, 0, 0, this.activeKind?.peek() ?? 0);
    this.pulse(side);
    if (menuClosesAfterPick(item.kind, item.value, MENU)) this.close();
  }

  private pulse(side: 'left' | 'right'): void {
    if (!(MENU.hapticIntensity > 0)) return;
    const gamepad = this.input?.gamepads?.[side]?.gamepad as unknown as HapticGamepad | undefined;
    const actuator = gamepad?.hapticActuators?.[0];
    if (!actuator?.pulse) return;
    try {
      const result = actuator.pulse(MENU.hapticIntensity, MENU.hapticMs);
      if (result && typeof (result as Promise<boolean>).catch === 'function') {
        (result as Promise<boolean>).catch(() => {});
      }
    } catch {
      // Actuator vanished between the check and the call.
    }
  }

  // ---- Pose ---------------------------------------------------------------------

  private primedGem = false;

  private gauntlet?: GauntletSystem | null;

  /**
   * The gem's world position, into gemPos. Round 10: when the gauntlet's left
   * arm is posed, the gem sits on GauntletSystem's menu-gem mount on the left
   * sleeve (sized to the player's arm, clear of the turret in every mode),
   * lifted off it by the gem's radius along the sleeve's surface normal.
   * Otherwise it falls back to the fixed offset from this system's own
   * WristPose. (GauntletSystem runs at priority 9, so this is its previous
   * frame's anchor: one frame behind, smoothed like the sleeve it rides.)
   */
  private computeGem(): void {
    if (this.gauntlet === undefined) {
      try {
        this.gauntlet = this.world.getSystem(GauntletSystem) ?? null;
      } catch {
        this.gauntlet = null;
      }
    }
    const g = this.gauntlet;
    if (g && g.menuGemInto(this.gemPos) && g.menuGemNormalInto(this.offset)) {
      this.gemPos.addScaledVector(this.offset, MENU.gemRadius);
      this.primedGem = true;
      return;
    }
    const o = this.wrist.isHand ? MENU.gemOffsetHand : MENU.gemOffsetController;
    this.offset.set(o[0], o[1], o[2]).applyQuaternion(this.wrist.wristQ);
    this.gemPos.copy(this.wrist.anchor).add(this.offset);
    this.primedGem = true;
  }

  /** World point -> panel frame (shown pose, unscaled), into `local`. */
  private toPanel(x: number, y: number, z: number): void {
    const c = this.state.center;
    const q = this.state.quaternion;
    inverseRotate(q[0], q[1], q[2], q[3], x - c[0], y - c[1], z - c[2], this.local);
  }

  /**
   * Where the open panel belongs this frame (top edge fixed above the wrist,
   * turned to the eyes), parked while the fingertip is in its poke zone, then
   * written to the root with the open animation's scale.
   */
  private posePanel(dt: number, leftTracked: boolean, layout: MenuLayout, tipOk: boolean): void {
    const visuals = this.panelVisuals();
    const tall = visuals ? visuals.layouts[1].height : layout.height;
    const state = this.state;

    let haveTarget = false;
    if (leftTracked && this.player?.head) {
      if (this.wrist.isHand) {
        this.distal.set(0, 0, -1).applyQuaternion(this.wrist.wristQ);
        this.sideways.set(this.distal.z, 0, -this.distal.x);
        const len = this.sideways.length();
        if (len > 1e-3) this.sideways.multiplyScalar(1 / len);
        else this.sideways.set(0, 0, 0);
        this.top
          .copy(this.wrist.anchor)
          .addScaledVector(this.distal, MENU.handForward)
          .addScaledVector(this.sideways, MENU.handOutward);
        this.top.y += MENU.handLift + tall;
      } else {
        this.top.copy(this.wrist.palm);
        this.top.y += MENU.controllerLift + tall;
      }
      // +Z of the panel toward the eyes, +Y as close to world up as allowed.
      this.lookM.lookAt(this.headPos, this.top, this.worldUp);
      this.targetQ.setFromRotationMatrix(this.lookM);
      this.panelUp.set(0, 1, 0).applyQuaternion(this.targetQ);
      this.targetPos.copy(this.top).addScaledVector(this.panelUp, -layout.height / 2);
      haveTarget = true;
    }

    // Park while poking (decided against the pose the finger saw last frame).
    let inZone = false;
    if (this.primed && tipOk) {
      this.toPanel(this.tip.x, this.tip.y, this.tip.z);
      inZone = inPokeZone(
        this.local[0],
        this.local[1],
        this.local[2],
        state.halfW,
        state.halfH,
        MENU.lockMarginMeters,
        MENU.lockFrontMeters,
        MENU.lockBehindMeters,
      );
    }
    if (stepPaletteLock(this.lock, inZone ? 0 : 1, this.clock, 0.5, MENU.lockReleaseSec)) {
      this.gliding = true;
    }

    if (!this.primed) {
      if (!haveTarget) return;
      this.shownPos.copy(this.targetPos);
      this.shownQ.copy(this.targetQ);
      this.primed = true;
    } else if (!haveTarget || this.lock.locked) {
      // Parked (or no hand this frame): stay exactly where it is.
    } else if (this.gliding) {
      const alpha = smoothingAlpha(dt, MENU.reattachSec);
      this.shownPos.lerp(this.targetPos, alpha);
      this.shownQ.slerp(this.targetQ, alpha);
      if (
        this.shownPos.distanceToSquared(this.targetPos) < 4e-6 &&
        this.shownQ.angleTo(this.targetQ) < 0.01
      ) {
        this.gliding = false;
      }
    } else {
      this.shownPos.copy(this.targetPos);
      this.shownQ.copy(this.targetQ);
    }

    state.center[0] = this.shownPos.x;
    state.center[1] = this.shownPos.y;
    state.center[2] = this.shownPos.z;
    state.quaternion[0] = this.shownQ.x;
    state.quaternion[1] = this.shownQ.y;
    state.quaternion[2] = this.shownQ.z;
    state.quaternion[3] = this.shownQ.w;
    state.halfW = layout.width / 2;
    state.halfH = layout.height / 2;

    const e = easeOut(this.progress);
    const scale = MENU.openFromScale + (1 - MENU.openFromScale) * e;
    for (const root of this.queries.roots.entities) {
      const o = root.object3D;
      if (!o) continue;
      o.visible = true;
      setWorldPosition(o, this.shownPos);
      setWorldQuaternion(o, this.shownQ);
      o.scale.setScalar(scale);
    }
  }

  // ---- Visuals ------------------------------------------------------------------

  private panelVisuals(): MenuPanelVisuals | undefined {
    for (const root of this.queries.roots.entities) {
      const v = root.object3D?.userData?.[MENU_VISUALS_KEY] as MenuPanelVisuals | undefined;
      if (v) return v;
    }
    return undefined;
  }

  private gemVisuals(): { object: Object3D; visuals: MenuGemVisuals } | undefined {
    for (const gem of this.queries.gems.entities) {
      const o = gem.object3D;
      const v = o?.userData?.[MENU_VISUALS_KEY] as MenuGemVisuals | undefined;
      if (o && v) return { object: o, visuals: v };
    }
    return undefined;
  }

  /**
   * Show / hide the GOO row: move every button and caption to the layout, swap
   * the background. Event-rate (a launcher change), never per frame. Keeps
   * the panel's TOP edge where it was, so the launcher row never jumps under
   * the finger that just picked GOO.
   */
  private applyLayout(visuals: MenuPanelVisuals, index: number): void {
    const prev = this.appliedLayout >= 0 ? visuals.layouts[this.appliedLayout] : undefined;
    const layout = visuals.layouts[index];
    visuals.backgrounds[0].visible = index === 0;
    visuals.backgrounds[1].visible = index === 1;
    for (let i = 0; i < layout.captions.length; i++) {
      const c = layout.captions[i];
      const o = visuals.captions[i];
      if (!o) continue;
      o.visible = c.shown;
      o.position.x = 0;
      o.position.y = c.y;
    }
    for (let i = 0; i < layout.items.length; i++) {
      const it = layout.items[i];
      const b = visuals.buttons[i];
      if (!b) continue;
      b.group.visible = it.shown;
      b.group.position.x = it.x;
      b.group.position.y = it.y;
    }
    if (prev && this.primed) {
      this.panelUp.set(0, 1, 0).applyQuaternion(this.shownQ);
      this.shownPos.addScaledVector(this.panelUp, -(layout.height - prev.height) / 2);
    }
    this.appliedLayout = index;
    this.state.halfW = layout.width / 2;
    this.state.halfH = layout.height / 2;
  }

  /** Is this item the loaded one? */
  private isSelected(item: MenuItem): boolean {
    switch (item.kind) {
      case MenuItemKind.Launcher:
        return this.blasterMode?.peek() === item.value;
      case MenuItemKind.SubMode:
        return this.webSubMode?.peek() === item.value;
      case MenuItemKind.Colour: {
        const a = this.activeColor?.peek();
        const c = PALETTE_DAB_ORDER[item.value];
        if (!a || !c) return false;
        return (
          (a[0] - c[0]) ** 2 + (a[1] - c[1]) ** 2 + (a[2] - c[2]) ** 2 < SAME_COLOR_EPS
        );
      }
      default:
        return this.activeKind?.peek() === PALETTE_CHIP_ORDER[item.value]?.kind;
    }
  }

  /** Highlights, hover, press depth and the open fade. Scalars only. */
  private paintPanel(visuals: MenuPanelVisuals, layout: MenuLayout): void {
    const fade = easeOut(this.progress);
    for (const s of visuals.statics) s.material.opacity = s.base * fade;
    const gooLoaded = this.blasterMode?.peek() === BlasterMode.Web;
    const poke = this.poke;
    for (let i = 0; i < layout.items.length; i++) {
      const it = layout.items[i];
      const b = visuals.buttons[i];
      if (!b || !it.shown) continue;
      const selected = this.isSelected(it);
      const hovered =
        (poke.target === i &&
          (poke.phase === PokePhase.Hover || poke.phase === PokePhase.Pressing)) ||
        this.rayHover === i;
      const depth = poke.target === i ? Math.min(poke.depth, MENU.sinkMaxMeters) : 0;
      const dim = it.kind === MenuItemKind.Ammo && gooLoaded ? MENU.dimmedRowOpacity : 1;
      const k = fade * dim;
      b.group.position.z = MENU.buttonLift - depth;
      b.rim.opacity =
        (selected ? MENU.rimSelectedOpacity : hovered ? MENU.rimHoverOpacity : MENU.rimOpacity) * k;
      b.glow.opacity =
        ((selected ? MENU.glowSelectedOpacity : 0) + (hovered ? MENU.glowHoverOpacity : 0)) * k;
      b.plate.color.copy(selected ? b.selectedColor : b.restColor);
      b.plate.opacity = MENU.buttonOpacity * k;
      b.face.opacity = k;
    }
  }

  /** Recolour the gem: core = loaded paint, ring = launcher (or GOO verb). */
  private paintGemColors(): void {
    const g = this.gemVisuals();
    if (!g) return;
    const c = this.activeColor?.peek();
    if (c) {
      g.visuals.core.color.setRGB(c[0], c[1], c[2], SRGBColorSpace);
      g.visuals.core.emissive.setRGB(c[0], c[1], c[2], SRGBColorSpace);
      g.visuals.halo.color.setRGB(
        0.55 + 0.45 * srgbToLinear(c[0]),
        0.55 + 0.45 * srgbToLinear(c[1]),
        0.55 + 0.45 * srgbToLinear(c[2]),
      );
    }
    const mode = this.blasterMode?.peek() ?? BlasterMode.Paint;
    const hex =
      mode === BlasterMode.Web
        ? MENU.subModeColors[this.webSubMode?.peek() === WebSubMode.Tether ? 1 : 0]
        : MENU.launcherColors[mode];
    g.visuals.ring.color.set(hex ?? '#48dbfb');
  }

  /** Gem pose, billboard, first-time pulse and open glow. */
  private paintGem(dt: number, shown: boolean): void {
    const g = this.gemVisuals();
    if (!g) return;
    const o = g.object;
    o.visible = shown;
    if (!shown) return;
    setWorldPosition(o, this.gemPos);
    // Face the eyes (Object3D.lookAt points +Z at the target; no allocation).
    o.lookAt(this.headPos);
    g.visuals.spin.rotation.z += dt * 0.6;
    let pulse = 0;
    if (!this.openedOnce && MENU.gemPulseAmp > 0) {
      pulse = 0.5 + 0.5 * Math.sin(this.clock * MENU.gemPulseHz * Math.PI * 2);
    }
    const scale = 1 + MENU.gemPulseAmp * pulse;
    g.visuals.spin.scale.setScalar(scale);
    const openBoost = this.wantOpen ? 1.6 : 1;
    g.visuals.halo.opacity = Math.min(1, MENU.gemGlowOpacity * openBoost * (1 + pulse));
    g.visuals.core.emissiveIntensity = 0.55 + 0.35 * pulse + (this.wantOpen ? 0.3 : 0);
    g.visuals.ring.opacity = this.wantOpen ? 1 : 0.85;
  }
}
