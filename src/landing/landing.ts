// Splotopia landing overlay (formerly PaintBlast MR; renamed round 9).
//
// Deliberately framework-free and IWSDK-free: it renders instantly on page
// load (World.create takes seconds to boot Havok/assets), then main.ts hands
// it the World via bindWorld() to wire the ENTER AR buttons and auto-hide.
//
// The whole page is a paintable surface: every click stamps a glowing neon
// splat with drips that run (see splatter.ts), and on mouse/trackpad devices
// the cursor becomes a blaster reticle that locks onto buttons.

import './landing.css';
import { createSplatterLayer, NEON_HEX } from './splatter';

interface WorldLike {
  launchXR(): void;
}

export interface LandingHandle {
  /** Wire the ENTER AR buttons to a booted World. */
  bindWorld(world: WorldLike): void;
  /**
   * Show/hide the overlay. main.ts drives this from world.visibilityState
   * (it owns the real VisibilityState enum; this module stays IWSDK-free).
   */
  setVisible(visible: boolean): void;
}

/**
 * The roster, in order: the four Neatniks, then Pip (the player's sidekick,
 * not a Neatnik). Image paths are under public/. The export keeps its
 * pre-rebrand identifier until the identifier pass.
 */
export const NEATNIKS = [
  {
    id: 'mopsy',
    name: 'Mopsy',
    role: 'Hover bot',
    accent: '#48dbfb',
    blurb:
      'A squat dome on a skirt of mop strings. Drifts, bobs and winks at you. Easy to splat, impossible to ignore.',
  },
  {
    id: 'squeegee',
    name: 'Squeegee',
    role: 'Shield',
    accent: '#ffd23f',
    blurb:
      'Holds a rubber blade that always turns to face you. Hit the blade three times to shatter it, or flank it for a quick splat.',
  },
  {
    id: 'peekaboo',
    name: 'Peekaboo',
    role: 'Sneak',
    accent: '#b6ff3b',
    blurb:
      'A vacuum wand with a periscope head. Hides behind your real furniture and peeks out. That surprised face is your tell.',
  },
  {
    id: 'duster-duke',
    name: 'Duster Duke',
    role: 'Boss',
    accent: '#ff4f81',
    blurb:
      'Feather-duster crown, cleaning-cloth cape, eleven hits to topple, and he never stands still. Pop him and he splits into two Mopsys.',
  },
  {
    id: 'pip',
    name: 'Pip',
    role: 'Your sidekick',
    accent: '#b84dff',
    blurb:
      'A palette drone with brush arms. Hovers by your menu, shows you the ropes and spins for joy at every new high score. Pip is no Neatnik. Pip is on your side. Do not paint Pip.',
  },
] as const;

const enterButton = (extraClass = '', id = '') =>
  `<button ${id ? `id="${id}" ` : ''}type="button" class="pb-btn pb-btn-primary ${extraClass}" data-enter-ar>
     <span class="pb-btn-label">ENTER AR</span>
     <span class="pb-btn-drips" aria-hidden="true"><i></i><i></i><i></i></span>
   </button>`;

function markup(): string {
  const bots = NEATNIKS.map(
    (b, i) => `
      <li class="pb-bot" style="--accent:${b.accent}; --i:${i}">
        <div class="pb-bot-art">
          <img src="/landing/bots/${b.id}.webp" alt="${b.name}, ${b.id === 'pip' ? 'your sidekick drone' : `${b.role.toLowerCase()} Neatnik`} concept art" width="520" height="520" loading="lazy" decoding="async" />
          <span class="pb-bot-role">${b.role}</span>
        </div>
        <div class="pb-bot-body">
          <h3>${b.name}</h3>
          <p>${b.blurb}</p>
        </div>
      </li>`,
  ).join('');

  const ticker = ['PINCH TO FIRE', 'POP THE NEATNIKS', 'HAUL THEM IN', 'PAINT YOUR ROOM', 'NO CONTROLLERS NEEDED', 'PLAY SEATED']
    .map((t, i) => `<span style="--c:${NEON_HEX[i % NEON_HEX.length]}">${t}</span>`)
    .join('');

  return `
    <canvas id="pb-splat-canvas" aria-hidden="true"></canvas>
    <div class="pb-reticle" aria-hidden="true">
      <svg viewBox="0 0 48 48" width="48" height="48">
        <circle cx="24" cy="24" r="13" />
        <path d="M24 3v9M24 36v9M3 24h9M36 24h9" />
        <circle class="pb-reticle-dot" cx="24" cy="24" r="2.4" />
      </svg>
    </div>

    <a class="pb-skip" href="#pb-play">Skip to Enter AR</a>

    <header class="pb-nav" role="banner">
      <a class="pb-nav-logo" href="#pb-top" aria-label="Splotopia, back to top">
        <img src="/landing/logo-360.webp" alt="Splotopia" width="180" height="61" />
      </a>
      <nav aria-label="Sections">
        <ul class="pb-nav-links">
          <li><a href="#pb-bots">Neatniks</a></li>
          <li><a href="#pb-blasters">Blasters</a></li>
          <li><a href="#pb-how">How to play</a></li>
          <li><a href="#pb-chill">Chill</a></li>
        </ul>
      </nav>
      ${enterButton('pb-btn-small')}
    </header>

    <main class="pb-page" id="pb-top">
      <section class="pb-hero" aria-labelledby="pb-hero-title">
        <picture class="pb-hero-art" aria-hidden="true">
          <source media="(max-width: 900px)" srcset="/landing/keyart-1100.webp" />
          <img src="/landing/keyart-1920.webp" alt="" width="1920" height="1072" fetchpriority="high" decoding="async" />
        </picture>
        <div class="pb-hero-scrim" aria-hidden="true"></div>

        <div class="pb-hero-inner">
          <p class="pb-kicker"><span class="pb-live-dot" aria-hidden="true"></span>Mixed reality &middot; Meta Quest 3 / 3S</p>
          <h1 id="pb-hero-title" class="pb-logo-title">
            <span class="pb-logo-splash" aria-hidden="true"></span>
            <img src="/landing/logo-1100.webp" alt="Splotopia" width="1100" height="370" decoding="async" />
          </h1>
          <p class="pb-tagline">Your room is the arena.</p>
          <p class="pb-sub">
            The Neatniks are rogue cleaning robots, and they hate mess. So make some.
            Pinch to blast paint that sticks to your real walls, couch and ceiling.
            Seated, hands-first, straight from the browser.
          </p>
          <div class="pb-cta-row">
            ${enterButton('pb-btn-hero', 'pb-enter')}
            <button id="pb-qr-toggle" type="button" class="pb-btn pb-btn-ghost" aria-expanded="false" aria-controls="pb-qr-card">
              PLAY ON QUEST
            </button>
          </div>
          <div id="pb-qr-card" class="pb-qr-card" role="region" aria-label="Open on your Quest">
            <img src="/landing/qr-play.png" alt="QR code linking to Splotopia at paintblast-mr.netlify.app" width="170" height="170" loading="lazy" />
            <p><b>On your Quest 3 / 3S:</b> look at this code in passthrough, tap <b>Open Link</b>, then press <b>ENTER AR</b>.</p>
          </div>
          <ul class="pb-badges" aria-label="At a glance">
            <li>Hands-first</li>
            <li>Play seated</li>
            <li>Your real room</li>
            <li>Nothing to install</li>
          </ul>
          <p class="pb-hint" aria-hidden="true">Go on. Click anywhere. This page is paintable.</p>
        </div>
      </section>

      <div class="pb-ticker" aria-hidden="true">
        <div class="pb-ticker-track">${ticker}${ticker}</div>
      </div>

      <section class="pb-stats" aria-label="By the numbers">
        <div><b style="--c:#ff4f81">4</b><span>Neatniks</span></div>
        <div><b style="--c:#ffd23f">3</b><span>Blasters</span></div>
        <div><b style="--c:#48dbfb">4</b><span>Paint kinds</span></div>
        <div><b style="--c:#b6ff3b">0</b><span>Controllers needed</span></div>
      </section>

      <section class="pb-section" id="pb-bots" aria-labelledby="pb-bots-title">
        <header class="pb-section-head">
          <p class="pb-eyebrow" style="--c:#48dbfb">The cleaning crew</p>
          <h2 id="pb-bots-title">Meet the Neatniks</h2>
          <span class="pb-drip-bar" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
          <p class="pb-lede">Four household appliances gone rogue. They mop, wipe, vacuum and dust,
          and they have moved into your living room. Return the favour. Pip has your back.</p>
        </header>
        <ul class="pb-roster">${bots}</ul>
      </section>

      <section class="pb-section" id="pb-blasters" aria-labelledby="pb-blasters-title">
        <header class="pb-section-head">
          <p class="pb-eyebrow" style="--c:#ff4f81">Gear up</p>
          <h2 id="pb-blasters-title">Three ways to blast</h2>
          <span class="pb-drip-bar" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
          <p class="pb-lede">Switch any time with one tap on your wrist palette.</p>
        </header>
        <div class="pb-blasters">
          <div class="pb-blasters-art">
            <img src="/landing/gauntlets.webp" alt="Concept art of the three forearm gauntlets: the paint blaster with a glowing canister, the slim goo launcher, and the bare-hand emitter" width="1024" height="572" loading="lazy" decoding="async" />
          </div>
          <ol class="pb-blaster-list">
            <li style="--c:#ff4f81">
              <span class="pb-mode-tag">BLASTER</span>
              <h3>Paint cannon</h3>
              <p>A forearm launcher with a canister that glows in your loaded colour. Hold to keep the paint coming.</p>
            </li>
            <li style="--c:#48dbfb">
              <span class="pb-mode-tag">GOO</span>
              <h3>Paint goo</h3>
              <p>Fling strands of sticky goo in your paint colour. Splat it on the walls, or switch to tether, hook a Neatnik and haul it right into your lap.</p>
            </li>
            <li style="--c:#d6dde4">
              <span class="pb-mode-tag">HAND</span>
              <h3>Bare hands</h3>
              <p>No hardware at all. Point, pinch, and paint flies straight from your fingertips.</p>
            </li>
          </ol>
        </div>
      </section>

      <section class="pb-section" id="pb-how" aria-labelledby="pb-how-title">
        <header class="pb-section-head">
          <p class="pb-eyebrow" style="--c:#b6ff3b">Learn it in ten seconds</p>
          <h2 id="pb-how-title">How to play</h2>
          <span class="pb-drip-bar" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
          <p class="pb-lede">Three moves, bare hands, sitting down.</p>
        </header>
        <ol class="pb-steps">
          <li style="--c:#ff4f81">
            <span class="pb-step-num" aria-hidden="true">01</span>
            <span class="pb-step-icon" aria-hidden="true">${ICON_PINCH}</span>
            <h3>Pinch to fire</h3>
            <p>Point your hand and pinch thumb to finger. Paint flies where you point and sticks where it lands.</p>
          </li>
          <li style="--c:#ffd23f">
            <span class="pb-step-num" aria-hidden="true">02</span>
            <span class="pb-step-icon" aria-hidden="true">${ICON_PALETTE}</span>
            <h3>Tap the wrist palette</h3>
            <p>A painter's palette floats over your left hand. Tap a dab for colour, a chip for Bouncy, Sticky, Splash or Goo.</p>
          </li>
          <li style="--c:#48dbfb">
            <span class="pb-step-num" aria-hidden="true">03</span>
            <span class="pb-step-icon" aria-hidden="true">${ICON_HAUL}</span>
            <h3>Haul Neatniks in</h3>
            <p>Hook a Neatnik with a goo tether, pull your hand back to reel it in, and pop it right in front of you.</p>
          </li>
        </ol>
        <p class="pb-footnote">Prefer controllers? Trigger fires, squeeze picks from the palette, A starts a round.</p>
      </section>

      <section class="pb-section pb-chill" id="pb-chill" aria-labelledby="pb-chill-title">
        <div class="pb-chill-art">
          <img src="/landing/chill.webp" alt="An easel with a half-finished painting in a softly lit living room splashed with paint" width="640" height="478" loading="lazy" decoding="async" />
        </div>
        <div class="pb-chill-copy">
          <p class="pb-eyebrow" style="--c:#b84dff">Chill mode</p>
          <h2 id="pb-chill-title">No timer. No robots. Just paint.</h2>
          <p class="pb-lede">Your room becomes a studio. Spray the walls, set up an easel and paint a
          canvas with a lofi soundtrack on, then save the picture as a PNG.</p>
          <ul class="pb-ticks">
            <li>Hold a pinch to spray</li>
            <li>A canvas you can grab, turn and save</li>
            <li>Paint that stays where it lands</li>
          </ul>
        </div>
      </section>

      <section class="pb-final" id="pb-play" aria-labelledby="pb-final-title">
        <span class="pb-final-splash" aria-hidden="true"></span>
        <h2 id="pb-final-title">Your walls are asking for it.</h2>
        <p class="pb-lede">Put on your Quest 3 or 3S, open this page in the browser and press ENTER AR.
        Nothing to download, nothing to install.</p>
        <div class="pb-final-row">
          ${enterButton('pb-btn-hero')}
          <div class="pb-final-qr">
            <img src="/landing/qr-play.png" alt="QR code linking to Splotopia at paintblast-mr.netlify.app" width="150" height="150" loading="lazy" />
            <p><b>On a computer?</b> Look at this code with your Quest in passthrough and tap Open Link.</p>
          </div>
        </div>
        <p class="pb-unsupported" hidden>This browser cannot start mixed reality. Open the page on a Meta Quest 3 or 3S.</p>
      </section>
    </main>

    <footer class="pb-footer">
      <img src="/landing/logo-360.webp" alt="Splotopia" width="140" height="47" loading="lazy" />
      <p>Splotopia: a mixed-reality paint arcade for Meta Quest 3 / 3S. Paint your room, pop the Neatniks. Built with Meta's Immersive Web SDK and WebXR.</p>
      <p class="pb-footer-small">A RethinkReality game &middot; Play somewhere with a little space around your seat.</p>
      <a href="#pb-top" class="pb-top-link">Back to top</a>
    </footer>
  `;
}

const ICON_PINCH = `<svg viewBox="0 0 64 64"><path d="M20 44c-6-6-8-14-4-18s9-1 12 3l2 3V12a4 4 0 0 1 8 0v16"/><path d="M38 28v-4a4 4 0 0 1 8 0v8c0 10-6 18-14 18h-2c-4 0-7-2-10-6"/><circle cx="48" cy="14" r="4"/><path d="M54 8l4-4M56 16h5M50 4l1-3"/></svg>`;
const ICON_PALETTE = `<svg viewBox="0 0 64 64"><path d="M32 8C17 8 6 18 6 31c0 11 8 19 18 19 5 0 6-3 6-6 0-4 3-6 7-6h6c9 0 15-5 15-12C58 15 46 8 32 8z"/><circle cx="20" cy="26" r="4"/><circle cx="31" cy="19" r="4"/><circle cx="43" cy="22" r="4"/><circle cx="17" cy="38" r="3"/></svg>`;
const ICON_HAUL = `<svg viewBox="0 0 64 64"><rect x="36" y="8" width="20" height="18" rx="6"/><circle cx="42" cy="17" r="2"/><circle cx="50" cy="17" r="2"/><path d="M36 22C24 26 18 34 14 46"/><path d="M8 40l6 8 8-5"/><path d="M6 56h20"/></svg>`;

export function initLanding(): LandingHandle {
  const root = document.getElementById('landing-root');
  if (!root) {
    // Landing markup missing (e.g. a stripped-down embed) — no-op handle.
    return { bindWorld: () => undefined, setVisible: () => undefined };
  }

  root.innerHTML = markup();

  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion) root.classList.add('pb-reduced-motion');

  const canvas = root.querySelector<HTMLCanvasElement>('#pb-splat-canvas')!;
  const enterButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-enter-ar]'));
  const qrToggle = root.querySelector<HTMLButtonElement>('#pb-qr-toggle')!;
  const qrCard = root.querySelector<HTMLElement>('#pb-qr-card')!;
  const unsupportedNote = root.querySelector<HTMLElement>('.pb-unsupported')!;
  const reticle = root.querySelector<HTMLElement>('.pb-reticle')!;

  // ---- neon paint layer ---------------------------------------------------

  const splatter = createSplatterLayer(canvas, root, reducedMotion);

  root.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    // Buttons, links, images and the QR card handle their own clicks.
    const target = event.target as HTMLElement;
    if (target.closest('button, a, .pb-qr-card, .pb-final-qr, .pb-nav')) return;
    splatter.splatAtClient(event.clientX, event.clientY);
    fireReticle();
  });

  // Opening salvo once the page has painted: splats framing the hero.
  const salvo = () => {
    const w = window.innerWidth;
    const h = Math.min(window.innerHeight, root.querySelector<HTMLElement>('.pb-hero')?.offsetHeight ?? window.innerHeight);
    const narrow = w < 700;
    const spots: Array<[number, number, number]> = narrow
      ? [
          [w * 0.02, h * 0.1, 90],
          [w * 1.0, h * 0.42, 90],
          [w * 0.02, h * 0.9, 100],
        ]
      : [
          [w * 0.06, h * 0.24, 190],
          [w * 0.94, h * 0.2, 150],
          [w * 0.1, h * 0.8, 170],
          [w * 0.92, h * 0.74, 200],
        ];
    spots.forEach(([x, y, size], i) =>
      window.setTimeout(
        () => splatter.splatAtPage(x, y, size, NEON_HEX[(i * 2) % NEON_HEX.length]),
        reducedMotion ? 0 : 450 + i * 190,
      ),
    );
  };
  if (document.readyState === 'complete') salvo();
  else window.addEventListener('load', salvo, { once: true });

  // ---- blaster reticle (mouse / trackpad only) ------------------------------

  const finePointer =
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
  let reticleTimer = 0;
  function fireReticle() {
    if (!finePointer || reducedMotion) return;
    reticle.classList.remove('pb-reticle-fire');
    // Restart the recoil animation.
    void reticle.offsetWidth;
    reticle.classList.add('pb-reticle-fire');
    window.clearTimeout(reticleTimer);
    reticleTimer = window.setTimeout(() => reticle.classList.remove('pb-reticle-fire'), 260);
    reticle.style.color = splatter.nextColor();
  }
  if (finePointer) {
    root.classList.add('pb-has-reticle');
    reticle.style.color = splatter.nextColor();
    root.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
      reticle.style.transform = `translate3d(${event.clientX - 24}px, ${event.clientY - 24}px, 0)`;
      reticle.classList.add('pb-reticle-on');
      const interactive = (event.target as HTMLElement).closest('button, a, [tabindex]');
      reticle.classList.toggle('pb-reticle-lock', !!interactive);
    });
    root.addEventListener('pointerleave', () => reticle.classList.remove('pb-reticle-on'));
  }

  // ---- reveal-on-scroll -----------------------------------------------------

  const revealables = root.querySelectorAll<HTMLElement>('.pb-section, .pb-final, .pb-stats');
  if (!reducedMotion && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('pb-in');
            io.unobserve(e.target);
          }
        }
      },
      { root, threshold: 0.12 },
    );
    revealables.forEach((el) => {
      el.classList.add('pb-reveal');
      io.observe(el);
    });
  }

  // ---- QR card / AR support -------------------------------------------------

  const setQrOpen = (open: boolean) => {
    qrCard.classList.toggle('pb-open', open);
    qrToggle.setAttribute('aria-expanded', String(open));
  };
  qrToggle.addEventListener('click', () => setQrOpen(!qrCard.classList.contains('pb-open')));

  const markUnsupported = () => {
    for (const b of enterButtons) b.hidden = true;
    root.classList.add('pb-no-xr');
    unsupportedNote.hidden = false;
    setQrOpen(true);
  };
  const xr = (navigator as Navigator & { xr?: { isSessionSupported(m: string): Promise<boolean> } }).xr;
  if (!xr) {
    markUnsupported();
  } else {
    xr.isSessionSupported('immersive-ar')
      .then((supported) => {
        if (!supported) markUnsupported();
      })
      .catch(() => undefined);
  }

  // ---- world hookup ---------------------------------------------------------

  let boundWorld: WorldLike | undefined;

  for (const b of enterButtons) {
    b.addEventListener('click', () => boundWorld?.launchXR());
    // Disabled until the World is ready: the label still reads ENTER AR and
    // enables within a couple of seconds, which beats a dead click.
    b.disabled = true;
    b.setAttribute('aria-busy', 'true');
  }

  return {
    bindWorld(world: WorldLike) {
      boundWorld = world;
      for (const b of enterButtons) {
        b.disabled = false;
        b.removeAttribute('aria-busy');
      }
    },
    setVisible(visible: boolean) {
      root.classList.toggle('pb-hidden', !visible);
      root.setAttribute('aria-hidden', String(!visible));
      splatter.setActive(visible);
    },
  };
}
