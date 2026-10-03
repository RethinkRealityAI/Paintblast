import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { CHILL, TUTORIAL } from '../../src/config';

/**
 * The competition's hands-first bar is "can someone finish the whole thing
 * without ever pairing a controller?" — so every instruction the HUD gives has
 * to be followable with bare hands. These pin the copy that makes that true.
 */
describe('hands-first HUD copy', () => {
  // Relative to the vitest root (the project root); see world-collision.test.
  const markup = readFileSync('ui/hud.uikitml', 'utf8');
  const body = markup.slice(markup.indexOf('</style>'));
  const section = (from: string, to: string) =>
    body.slice(body.indexOf(`id="${from}"`), body.indexOf(`id="${to}"`));
  const idle = section('section-idle', 'section-playing');
  const chill = body.slice(body.indexOf('id="section-chill"'));

  it('teaches firing by the pinch (round 9: in the tutorial, not a title tile)', () => {
    const tutorial = body.slice(body.indexOf('id="section-tutorial"'));
    expect(tutorial.toLowerCase()).toContain('pinch');
    expect(TUTORIAL.lines.fire.toLowerCase()).toContain('pinch');
  });

  it('tells a hands-only player which hand presses buttons', () => {
    // Rounds 2-9: the left hand's ray was permanently taken by the wrist
    // palette. Round 10's menu takes nothing, but the title still teaches the
    // one hand that always works.
    expect(idle).toMatch(/RIGHT hand/);
    expect(idle.toLowerCase()).toContain('pinch');
  });

  it('never tells a chill player to use a control only controllers have', () => {
    const status = /id="hud-chill-status"[^>]*>([^<]*)</.exec(chill)?.[1] ?? '';
    expect(status.toLowerCase()).toContain('pinch');
    // The markup's first paint and the signal HudSystem writes must agree.
    expect(status).toBe(CHILL.statusText);
    expect(CHILL.statusText.toLowerCase()).toContain('pinch');
    expect(chill).toMatch(/Pinch or squeeze the easel/);
  });

  it('ships the PAUSED pill hidden, ahead of every section', () => {
    const pill = body.indexOf('id="hud-paused"');
    expect(pill).toBeGreaterThan(-1);
    expect(pill).toBeLessThan(body.indexOf('id="section-idle"'));
    expect(body).toMatch(/<span id="hud-paused" class="paused">PAUSED<\/span>/);

    const style = markup.slice(0, markup.indexOf('</style>'));
    const rule = /\.paused\s*\{([^}]*)\}/.exec(style)?.[1] ?? '';
    expect(rule).toMatch(/display:\s*none/);
  });
});
