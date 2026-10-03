import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PanelBlockMode,
  panelBlockMode,
  rayHitsLocalRect,
  visibleInWorld,
} from '../../src/systems/BallSpawnSystem';
import {
  crowded2D,
  inWaveBreather,
  pushOutToRadius,
  splitCentre,
} from '../../src/systems/TargetSystem';
import {
  isCeilingPlane,
  shouldThickenPlane,
} from '../../src/systems/WorldCollisionSystem';
import { easelCentreHeight } from '../../src/systems/EaselSystem';
import {
  BALLS,
  EASEL,
  FIRE,
  HUD,
  RENDER,
  ROOM,
  NEATNIKS,
} from '../../src/config';
import type { NeatnikWave } from '../../src/config';
import { GamePhase } from '../../src/types';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major inverse of "scale (sx, sy, 1) then translate (tx, ty, tz)". */
function inverseScaleTranslate(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  tz: number,
): number[] {
  return [1 / sx, 0, 0, 0, 0, 1 / sy, 0, 0, 0, 0, 1, 0, -tx / sx, -ty / sy, -tz, 1];
}

describe('panelBlockMode (round 9: docked HUD must not eat shots)', () => {
  it('only blocks over buttons while a round is on', () => {
    expect(panelBlockMode(GamePhase.Playing)).toBe(PanelBlockMode.ButtonsOnly);
    expect(panelBlockMode(GamePhase.Countdown)).toBe(PanelBlockMode.ButtonsOnly);
  });

  it('keeps "pointing at UI beats shooting" for the real menus', () => {
    expect(panelBlockMode(GamePhase.Idle)).toBe(PanelBlockMode.Rect);
    expect(panelBlockMode(GamePhase.GameOver)).toBe(PanelBlockMode.Rect);
    expect(panelBlockMode(GamePhase.Chill)).toBe(PanelBlockMode.Rect);
  });

  it('only blocks over buttons while the tutorial card is up, even in Idle', () => {
    expect(panelBlockMode(GamePhase.Idle, true)).toBe(PanelBlockMode.ButtonsOnly);
    expect(panelBlockMode(GamePhase.Idle, false)).toBe(PanelBlockMode.Rect);
  });

  it('finds buttons by the uikitml btn- id convention', () => {
    expect(FIRE.uiInteractiveIdPrefix).toBe('btn-');
    const hud = readFileSync('ui/hud.uikitml', 'utf8');
    const buttons = hud.match(/<button id="([^"]+)"/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b).toContain(`id="${FIRE.uiInteractiveIdPrefix}`);
  });
});

describe('rayHitsLocalRect', () => {
  it('hits a rect dead ahead and misses beside it', () => {
    expect(rayHitsLocalRect(IDENTITY, 0, 0, 1, 0, 0, -1, 0.5, 0.5, 3)).toBe(true);
    expect(rayHitsLocalRect(IDENTITY, 0.6, 0, 1, 0, 0, -1, 0.5, 0.5, 3)).toBe(false);
  });

  it('ignores a rect behind the ray, beyond reach, or edge-on', () => {
    expect(rayHitsLocalRect(IDENTITY, 0, 0, 1, 0, 0, 1, 0.5, 0.5, 3)).toBe(false);
    expect(rayHitsLocalRect(IDENTITY, 0, 0, 5, 0, 0, -1, 0.5, 0.5, 3)).toBe(false);
    expect(rayHitsLocalRect(IDENTITY, 0, 0, 1, 1, 0, 0, 0.5, 0.5, 3)).toBe(false);
  });

  it('works through a scaled unit-square matrix (uikit panel matrix), t in world metres', () => {
    // A 0.4 x 0.2 m button 2 m ahead, as a unit square scaled onto it.
    const inv = inverseScaleTranslate(0.4, 0.2, 0, 1, -2);
    // Straight at its centre from the origin's height 1.
    expect(rayHitsLocalRect(inv, 0, 1, 0, 0, 0, -1, 0.5, 0.5, 3)).toBe(true);
    // 0.15 m above centre: outside the 0.1 m half-height.
    expect(rayHitsLocalRect(inv, 0, 1.15, 0, 0, 0, -1, 0.5, 0.5, 3)).toBe(false);
    // 2 m away: out of a 1.5 m reach, in a 3 m reach.
    expect(rayHitsLocalRect(inv, 0, 1, 0, 0, 0, -1, 0.5, 0.5, 1.5)).toBe(false);
  });

  it('lets a low shot under the docked HUD through to the Duke', () => {
    // Seated head 1.2 m: the HUD docks 0.52 m below and 0.95 m out. The
    // CLEAR PAINT button is a small strip of it; a ray from the hand (1.0 m)
    // to the Duke (0.4 m, 2 m out) crosses the panel plane near y 0.71 —
    // inside the old full-panel box, outside a 12 x 4 cm button at its
    // bottom-left corner.
    const panelY = 1.2 + HUD.playOffset[1];
    const panelZ = HUD.playOffset[2];
    const halfH = (HUD.baseHeight * HUD.playScale) / 2;
    const dirY = (0.4 - 1.0) / 2;
    const len = Math.hypot(dirY, 1);
    const dy = dirY / len;
    const dz = -1 / len;
    const oldBox = inverseScaleTranslate(1, 1, 0, panelY, panelZ);
    expect(rayHitsLocalRect(oldBox, 0, 1.0, 0, 0, dy, dz, 0.2, halfH, 3)).toBe(true);
    const button = inverseScaleTranslate(0.12, 0.04, -0.13, panelY - halfH + 0.03, panelZ);
    expect(rayHitsLocalRect(button, 0, 1.0, 0, 0, dy, dz, 0.5, 0.5, 3)).toBe(false);
  });
});

describe('visibleInWorld', () => {
  it('is false when any ancestor is hidden (hidden HUD / hidden palette)', () => {
    const root = { visible: false, parent: null };
    const child = { visible: true, parent: root };
    const leaf = { visible: true, parent: child };
    expect(visibleInWorld(leaf as never)).toBe(false);
    root.visible = true;
    expect(visibleInWorld(leaf as never)).toBe(true);
    expect(visibleInWorld(undefined)).toBe(false);
  });
});

describe('inWaveBreather (round 9 rest beat)', () => {
  const waves: NeatnikWave[] = [
    { startSec: 0, maxAlive: 3, weights: [1, 0, 0] },
    { startSec: 20, maxAlive: 4, weights: [1, 1, 1] },
    { startSec: 50, maxAlive: 4, weights: [1, 1, 1] },
  ];

  it('pauses spawns for breatherSec as each later wave opens', () => {
    expect(inWaveBreather(20, waves, 3)).toBe(true);
    expect(inWaveBreather(22.9, waves, 3)).toBe(true);
    expect(inWaveBreather(23, waves, 3)).toBe(false);
    expect(inWaveBreather(51, waves, 3)).toBe(true);
  });

  it('never delays the first wave, and 0 disables it', () => {
    expect(inWaveBreather(0, waves, 3)).toBe(false);
    expect(inWaveBreather(1, waves, 3)).toBe(false);
    expect(inWaveBreather(20, waves, 0)).toBe(false);
  });

  it('ships a short breather that fits inside every wave', () => {
    expect(NEATNIKS.waveBreatherSec).toBeGreaterThan(0);
    expect(NEATNIKS.waveBreatherSec).toBeLessThanOrEqual(5);
    const w = NEATNIKS.waves;
    for (let i = 1; i < w.length; i++) {
      expect(w[i].startSec - w[i - 1].startSec).toBeGreaterThan(
        NEATNIKS.waveBreatherSec * 2,
      );
    }
  });
});

describe('pushOutToRadius (released tether bots drift back out)', () => {
  it('moves a robot inside the radius straight out to it', () => {
    const out = new Float32Array(2);
    expect(pushOutToRadius(0, -0.5, 0, 0, 0.9, 0, out)).toBe(true);
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(-0.9);
  });

  it('leaves a robot that is already far enough alone', () => {
    const out = new Float32Array(2);
    expect(pushOutToRadius(1.5, 0.2, 0, 0, 0.9, 0, out)).toBe(false);
    expect(out[0]).toBeCloseTo(1.5);
    expect(out[1]).toBeCloseTo(0.2);
  });

  it('uses the fallback heading for a robot exactly on the head', () => {
    const out = new Float32Array(2);
    pushOutToRadius(1, 1, 1, 1, 0.9, -Math.PI / 2, out);
    expect(out[0]).toBeCloseTo(1);
    expect(out[1]).toBeCloseTo(1 - 0.9);
  });

  it('has a drift time in config', () => {
    expect(NEATNIKS.releaseReturnSec).toBeGreaterThan(0);
  });
});

describe('splitCentre (Duke popped in your face)', () => {
  it('splits where he died when he is out in the room', () => {
    const out = new Float32Array(2);
    expect(splitCentre(0, -2, 0.3, -2.2, 0, 0, ROOM.spawnMinDist, out)).toBe(false);
    expect(out[1]).toBeCloseTo(-2);
  });

  it('splits around his home slot when hauled inside spawnMinDist', () => {
    const out = new Float32Array(2);
    expect(splitCentre(0, -0.6, 0.3, -2.2, 0, 0, ROOM.spawnMinDist, out)).toBe(true);
    expect(out[0]).toBeCloseTo(0.3);
    expect(out[1]).toBeCloseTo(-2.2);
  });
});

describe('crowded2D (Peekaboos do not stack)', () => {
  it('flags a spot within minSpacing of another peekaboo', () => {
    const pts = new Float32Array([0, -2, 1, -2]);
    expect(crowded2D(0.1, -2.1, pts, 2, 0.3)).toBe(true);
    expect(crowded2D(0.5, -2, pts, 2, 0.3)).toBe(false);
    // Only the first `count` points count.
    expect(crowded2D(1, -2, pts, 1, 0.3)).toBe(false);
  });

  it('ships a spacing wider than a peekaboo is tall-ish', () => {
    expect(NEATNIKS.peek.minSpacing).toBeGreaterThanOrEqual(0.25);
  });
});

describe('isCeilingPlane / shouldThickenPlane (round 9: ceilings tunnel too)', () => {
  const min = ROOM.ceilingMinHeightMeters;

  it('thickens walls, as since round 6', () => {
    expect(shouldThickenPlane('vertical', 'wall', 1.2, min)).toBe(true);
  });

  it('thickens a horizontal plane labelled ceiling or above head height', () => {
    expect(isCeilingPlane('horizontal', 'ceiling', 2.4, min)).toBe(true);
    expect(isCeilingPlane('horizontal', '', 2.4, min)).toBe(true);
    expect(isCeilingPlane('horizontal', undefined, 2.5, min)).toBe(true);
    expect(shouldThickenPlane('horizontal', 'ceiling', 2.4, min)).toBe(true);
  });

  it('leaves floors and table tops thin (FloorGuard covers the floor)', () => {
    expect(shouldThickenPlane('horizontal', 'floor', 0, min)).toBe(false);
    expect(shouldThickenPlane('horizontal', 'table', 0.75, min)).toBe(false);
    expect(shouldThickenPlane(undefined, undefined, 3, min)).toBe(false);
  });

  it('sits the ceiling threshold above a standing head', () => {
    expect(min).toBeGreaterThan(1.8);
    expect(min).toBeLessThan(2.3);
  });
});

describe('easel within seated reach (round 9)', () => {
  it('spawns inside a seated arm\'s reach', () => {
    expect(EASEL.spawnDistance).toBeLessThanOrEqual(0.8);
    expect(EASEL.spawnDistance).toBeGreaterThanOrEqual(0.5);
  });

  it("plants the board at eye level, seated or standing", () => {
    expect(easelCentreHeight(1.2)).toBeCloseTo(1.2 - EASEL.boardBelowEyes);
    expect(easelCentreHeight(1.6)).toBeCloseTo(1.6 - EASEL.boardBelowEyes);
    expect(easelCentreHeight(0.2)).toBe(EASEL.boardCentreMinHeight);
    expect(easelCentreHeight(3)).toBe(EASEL.boardCentreMaxHeight);
    expect(easelCentreHeight(Number.NaN)).toBe(EASEL.boardCentreHeight);
  });

  it('keeps the board above the docked HUD and in front of it', () => {
    for (const eyes of [1.1, 1.2, 1.4, 1.6, 1.75]) {
      const boardBottom = easelCentreHeight(eyes) - EASEL.portraitBoardHeight / 2;
      const hudTop = eyes + HUD.playOffset[1] + (HUD.baseHeight * HUD.playScale) / 2;
      expect(boardBottom).toBeGreaterThan(hudTop);
    }
    // The board (and its rear leg) stand nearer than the docked panel.
    expect(EASEL.spawnDistance + EASEL.rearLegOffset).toBeLessThan(
      -HUD.playOffset[2],
    );
  });
});

describe('depth occlusion wiring (round 9)', () => {
  const main = readFileSync('src/main.ts', 'utf8');
  const spawn = readFileSync('src/systems/BallSpawnSystem.ts', 'utf8');
  const target = readFileSync('src/systems/TargetSystem.ts', 'utf8');

  it('is on by default and requests depth-sensing as optional', () => {
    expect(RENDER.depthOcclusion).toBe(true);
    expect(main).toMatch(/depthSensing: RENDER\.depthOcclusion/);
    expect(main).toMatch(/required: false/);
  });

  it('registers the depth system before TargetSystem builds its pool', () => {
    const depthAt = main.indexOf('registerSystem(RobotDepthSensingSystem');
    const targetAt = main.indexOf('registerSystem(TargetSystem');
    expect(depthAt).toBeGreaterThan(0);
    expect(depthAt).toBeLessThan(targetAt);
  });

  it('never tags instanced splats or balls (gotcha 20)', () => {
    expect(main).not.toMatch(/addComponent\(DepthOccludable\)/);
    expect(spawn).not.toMatch(/addComponent\(DepthOccludable\)/);
    expect(target).toMatch(/addComponent\(DepthOccludable\)/);
  });
});

describe('balls are not grabbable (round 9)', () => {
  const spawn = readFileSync('src/systems/BallSpawnSystem.ts', 'utf8');

  it('spawns balls without OneHandGrabbable or Interactable', () => {
    expect(spawn).not.toMatch(/ball\.addComponent\(OneHandGrabbable/);
    expect(spawn).not.toMatch(/ball\.addComponent\(Interactable\)/);
  });

  it('so the only way a ball moves is the capped muzzle speed', () => {
    // gotcha 22: < (wall + 2 radius) per 72 Hz step.
    expect(FIRE.speed / 72).toBeLessThan(ROOM.wallThicknessMeters + 2 * BALLS.radius);
  });
});
