import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { initLanding, NEATNIKS } from '../../src/landing/landing';
import { dripLength, easeOutBack } from '../../src/landing/splatter';

describe('landing splatter helpers', () => {
  it('drips run fast, then stop at their full length', () => {
    expect(dripLength(0, 100, 1000)).toBe(0);
    const early = dripLength(200, 100, 1000);
    const late = dripLength(800, 100, 1000) - dripLength(600, 100, 1000);
    expect(early).toBeGreaterThan(late);
    expect(dripLength(1000, 100, 1000)).toBeCloseTo(100, 6);
    expect(dripLength(5000, 100, 1000)).toBeCloseTo(100, 6);
  });

  it('splat pop overshoots and lands on 1', () => {
    expect(easeOutBack(1)).toBeCloseTo(1, 6);
    expect(easeOutBack(0.6, 2.4)).toBeGreaterThan(1);
  });
});

describe('landing page', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="landing-root"></div>';
  });

  it('keeps the ENTER AR / QR contract main.ts relies on', () => {
    const handle = initLanding();
    const root = document.getElementById('landing-root')!;
    const enter = root.querySelector<HTMLButtonElement>('#pb-enter');
    expect(enter).not.toBeNull();
    expect(root.querySelector('#pb-qr-toggle')).not.toBeNull();
    expect(root.querySelector('#pb-qr-card')).not.toBeNull();

    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-enter-ar]'));
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    expect(buttons.every((b) => b.disabled)).toBe(true);

    let launched = 0;
    handle.bindWorld({ launchXR: () => launched++ });
    expect(buttons.every((b) => !b.disabled)).toBe(true);
    buttons[buttons.length - 1].click();
    expect(launched).toBe(1);

    handle.setVisible(false);
    expect(root.classList.contains('pb-hidden')).toBe(true);
    handle.setVisible(true);
    expect(root.classList.contains('pb-hidden')).toBe(false);
  });

  it('QR toggle opens the card and reports it', () => {
    initLanding();
    const toggle = document.querySelector<HTMLButtonElement>('#pb-qr-toggle')!;
    const card = document.querySelector<HTMLElement>('#pb-qr-card')!;
    const was = card.classList.contains('pb-open');
    toggle.click();
    expect(card.classList.contains('pb-open')).toBe(!was);
    expect(toggle.getAttribute('aria-expanded')).toBe(String(!was));
  });

  it('is a no-op without its root', () => {
    document.body.innerHTML = '';
    const handle = initLanding();
    expect(() => handle.setVisible(false)).not.toThrow();
  });

  it('ships the roster, the three blasters and the three hands-only steps', () => {
    initLanding();
    const text = document.getElementById('landing-root')!.textContent ?? '';
    for (const b of NEATNIKS) expect(text).toContain(b.name);
    for (const m of ['BLASTER', 'GOO', 'HAND']) expect(text).toContain(m);
    expect(text).toMatch(/Meet the Neatniks/);
    expect(text).not.toMatch(/Splotbot|PaintBlast/i);
    expect(text).toMatch(/Pinch to fire/);
    expect(text).toMatch(/Tap the wrist gem/);
    expect(text).toMatch(/Haul Neatniks in/);
    expect(text).toMatch(/Chill/i);
  });

  it('never references the IP the competition plan flags', () => {
    initLanding();
    const html = document.getElementById('landing-root')!.innerHTML + readFileSync('index.html', 'utf8');
    expect(html).not.toMatch(/spider/i);
    expect(html).not.toMatch(/thwip/i);
    expect(html).not.toMatch(/\bweb (launcher|shooter|sling)/i);
  });

  it('every image has alt text and points at a real file', () => {
    initLanding();
    const imgs = Array.from(document.querySelectorAll('img'));
    expect(imgs.length).toBeGreaterThan(5);
    for (const img of imgs) {
      expect(img.hasAttribute('alt')).toBe(true);
      const src = img.getAttribute('src')!;
      expect(existsSync(`public${src}`)).toBe(true);
    }
  });

  it('index.html carries the Splotopia name, not the old one', () => {
    const html = readFileSync('index.html', 'utf8');
    expect(html).toMatch(/<title>Splotopia \|/);
    expect(html).toMatch(/og:site_name" content="Splotopia"/);
    expect(html).not.toMatch(/PaintBlast MR|Splotbot/);
  });

  it('index.html shares the OG card', () => {
    const html = readFileSync('index.html', 'utf8');
    expect(html).toMatch(/og:image" content="[^"]*\/brand\/og\.jpg"/);
    expect(existsSync('public/brand/og.jpg')).toBe(true);
  });
});
