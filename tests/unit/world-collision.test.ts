import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  COLLIDABLE_MESH_LABELS,
  GLOBAL_MESH_LABEL,
  formatColliderLog,
  isCollidableMesh,
  isGlobalMesh,
} from '../../src/systems/WorldCollisionSystem';
import { BALLS, FIRE, ROOM, WEB } from '../../src/config';

/**
 * Every semantic label the WebXR registry defines, verbatim. Quest maps its own
 * native `SemanticLabelMETA` enum onto this shorter list before a browser ever
 * sees it, so these — not `WALL_FACE`, not `STORAGE`, not `GLOBAL_MESH` — are
 * the strings that reach `XRMesh.semanticLabel`.
 *
 * @see https://github.com/immersive-web/semantic-labels (labels.json)
 */
const WEBXR_LABELS = [
  'desk',
  'couch',
  'floor',
  'ceiling',
  'wall',
  'door',
  'window',
  'table',
  'shelf',
  'bed',
  'screen',
  'lamp',
  'plant',
  'wall art',
  'global mesh',
  'other',
] as const;

describe('GLOBAL_MESH_LABEL', () => {
  it('is the registry spelling: ASCII lowercase, one space', () => {
    // Not globalMesh, not global_mesh, and emphatically not the native
    // GLOBAL_MESH that Meta's Unity docs use. @iwsdk/core compares against
    // exactly this literal.
    expect(GLOBAL_MESH_LABEL).toBe('global mesh');
    expect(GLOBAL_MESH_LABEL).toBe(GLOBAL_MESH_LABEL.toLowerCase());
    expect(WEBXR_LABELS).toContain(GLOBAL_MESH_LABEL);
  });
});

describe('isGlobalMesh', () => {
  it('recognises the global mesh by its UNBOUNDED flag, not its label', () => {
    // The load-bearing case, and the reason a label test alone would have
    // shipped a feature that never fired: @iwsdk/core recognises 'global mesh'
    // itself and then adds the component WITHOUT copying the label across, so
    // semanticLabel arrives as its empty-string default.
    expect(isGlobalMesh('', false)).toBe(true);
  });

  it('still recognises it by label, in case IWSDK ever forwards one', () => {
    expect(isGlobalMesh(GLOBAL_MESH_LABEL, false)).toBe(true);
    expect(isGlobalMesh(GLOBAL_MESH_LABEL, true)).toBe(true);
  });

  it('never mistakes a bounded object for the room', () => {
    // A convex hull round a couch is right; a trimesh of one is waste. Worse,
    // treating a bounded mesh as the room would give it the wall material.
    for (const label of WEBXR_LABELS) {
      if (label === GLOBAL_MESH_LABEL) continue;
      expect(isGlobalMesh(label, true)).toBe(false);
    }
  });
});

describe('COLLIDABLE_MESH_LABELS', () => {
  it('only contains strings the WebXR registry actually defines', () => {
    for (const label of COLLIDABLE_MESH_LABELS) {
      expect(WEBXR_LABELS).toContain(label as (typeof WEBXR_LABELS)[number]);
    }
  });

  it('covers the furniture Quest reports as bounded volumes', () => {
    // Round 5 shipped {table, couch, chair, other}, which missed five real
    // labels and included one Quest never emits.
    for (const label of ['table', 'desk', 'couch', 'bed', 'shelf', 'other']) {
      expect(isCollidableMesh(label)).toBe(true);
    }
  });

  it('has dropped chair, which no conforming runtime can emit', () => {
    // Round 5 carried it, copied from Meta's own IWSDK example, where it is
    // equally dead. 'chair' is not in the registry; Quest sends CHAIR through
    // as 'couch'. A chair still gets a collider — just under the right name.
    expect(isCollidableMesh('chair')).toBe(false);
    expect(isCollidableMesh('couch')).toBe(true);
  });

  it('excludes wall, floor and ceiling on purpose', () => {
    // Not an oversight. In a real Space Setup capture those carry a Bounded2D
    // component and nothing else, so they arrive as XRPlane and can never
    // appear in detectedMeshes. The planes path colliderizes them.
    expect(isCollidableMesh('wall')).toBe(false);
    expect(isCollidableMesh('floor')).toBe(false);
    expect(isCollidableMesh('ceiling')).toBe(false);
  });

  it('never claims the global mesh — that has its own trimesh path', () => {
    expect(COLLIDABLE_MESH_LABELS.has(GLOBAL_MESH_LABEL)).toBe(false);
  });

  it('rejects an unlabelled bounded mesh rather than guessing', () => {
    expect(isCollidableMesh('')).toBe(false);
  });
});

describe('formatColliderLog', () => {
  it('reports counts and labels in the documented shape', () => {
    expect(formatColliderLog(6, 2, ['global mesh', 'table'])).toBe(
      '[PaintBlast] room colliders: 6 planes, 2 meshes (labels: global mesh, table)',
    );
  });

  it('says "none" rather than trailing an empty list', () => {
    expect(formatColliderLog(0, 0, [])).toBe(
      '[PaintBlast] room colliders: 0 planes, 0 meshes (labels: none)',
    );
  });

  it('is greppable — the prefix is stable', () => {
    expect(formatColliderLog(1, 1, ['other'])).toMatch(
      /^\[PaintBlast\] room colliders: /,
    );
  });
});

describe('ROOM.wallThicknessMeters', () => {
  it('is thicker than one frame of ball travel at 72 Hz', () => {
    // The whole round-6 wall fix. IWSDK steps Havok once per frame with no CCD,
    // so a wall the ball can stride over in one step is a wall it can pass
    // through. The capture band is half the thickness plus the ball's radius on
    // either side of the plane.
    const travelPerFrame = FIRE.speed / 72;
    const captureBand = ROOM.wallThicknessMeters + 2 * BALLS.radius;
    expect(captureBand).toBeGreaterThan(travelPerFrame);
  });

  it('is thicker than one frame of WEB travel too', () => {
    // Round 7 made webs faster than paint. Its first cut (x1.45, 17 cm per
    // step) strode over the 14 cm band one head-on shot in five; this pins
    // the fastest thing that flies, not just the trigger speed.
    const fastest = FIRE.speed * Math.max(1, WEB.webSpeedMult);
    const captureBand = ROOM.wallThicknessMeters + 2 * BALLS.radius;
    expect(captureBand).toBeGreaterThan(fastest / 72);
  });

  it('stays thin enough that the bulge is invisible in passthrough', () => {
    // The collider grows symmetrically about the real surface, so paint lands
    // half of this proud of the wall you can see. Under the ball's own radius
    // it reads as contact; much past that it reads as floating.
    expect(ROOM.wallThicknessMeters / 2).toBeLessThanOrEqual(BALLS.radius);
    expect(ROOM.wallThicknessMeters).toBeGreaterThan(0);
  });

  it('logs the census soon enough to catch, late enough to be true', () => {
    expect(ROOM.colliderLogDelaySec).toBeGreaterThanOrEqual(2);
    expect(ROOM.colliderLogDelaySec).toBeLessThanOrEqual(
      ROOM.scanCheckDelaySec,
    );
  });
});

describe('title screen copy', () => {
  // Relative to the vitest root, which is the project root. `import.meta.url`
  // is not a file: URL under the happy-dom environment, so URL-relative
  // resolution is not available here.
  const markup = readFileSync('ui/hud.uikitml', 'utf8');
  const idle = markup.slice(
    markup.indexOf('id="section-idle"'),
    markup.indexOf('id="section-playing"'),
  );

  it('offers WEB MODE as a title-screen button', () => {
    // Round 5 left webbing discoverable only as one chip in a row of five on
    // your own wrist, and the field report was that nobody found it. The button
    // is a signpost, not a phase — see HudSystem.startWebMode.
    expect(idle).toContain('id="btn-web"');
    expect(idle).toContain('>WEB MODE<');
  });

  it('teaches the palette chip as well, so the button is not the only route', () => {
    expect(idle).toMatch(/WEB chip/);
  });

  it('teaches the gestures without tying them to web ammo', () => {
    // Round 6 made the gestures universal: they fire the loadout, so copy that
    // says "with WEB loaded" would now be wrong.
    expect(idle).toContain('THWIP');
    expect(idle).not.toMatch(/with WEB loaded/i);
  });

  it('keeps every rendered string ASCII (the MSDF font has no fancy glyphs)', () => {
    // The <style> block is excluded rather than the whole file asserted: CSS
    // comments are prose for whoever reads the markup next and never reach a
    // glyph atlas, while everything below them does.
    const body = markup.slice(markup.indexOf('</style>'));
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(body)).toBe(true);
  });
});
