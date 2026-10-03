import { describe, it, expect } from 'vitest';
import {
  createGestureGate,
  createShooterFit,
  fitShooterScale,
  forwardSpeed,
  gooStrandRgb,
  isThwipPose,
  stepGestureGate,
  StrandState,
} from '../../src/systems/WebShooterSystem';
import type { ThwipPose } from '../../src/systems/WebShooterSystem';
import { WEB } from '../../src/config';

/** A hand doing nothing in particular: everything out, nothing curled. */
const OPEN_HAND: ThwipPose = {
  indexDist: 0.16,
  middleDist: 0.17,
  ringDist: 0.16,
  pinkyDist: 0.14,
};

/** The thwip: middle and ring folded in, index and pinky still out. */
const THWIP_HAND: ThwipPose = {
  indexDist: 0.16,
  middleDist: 0.05,
  ringDist: 0.05,
  pinkyDist: 0.14,
};

describe('isThwipPose', () => {
  it('fires on middle+ring curled with index+pinky extended', () => {
    expect(isThwipPose(THWIP_HAND, WEB)).toBe(true);
  });

  it('ignores an open hand', () => {
    expect(isThwipPose(OPEN_HAND, WEB)).toBe(false);
  });

  it('ignores a fist — all four curled is not the gesture', () => {
    expect(
      isThwipPose(
        { indexDist: 0.05, middleDist: 0.05, ringDist: 0.05, pinkyDist: 0.045 },
        WEB,
      ),
    ).toBe(false);
  });

  it('ignores a point — index out but middle, ring AND pinky curled', () => {
    expect(
      isThwipPose(
        { indexDist: 0.16, middleDist: 0.05, ringDist: 0.05, pinkyDist: 0.05 },
        WEB,
      ),
    ).toBe(false);
  });

  it('needs BOTH of middle and ring curled', () => {
    expect(isThwipPose({ ...THWIP_HAND, ringDist: 0.15 }, WEB)).toBe(false);
    expect(isThwipPose({ ...THWIP_HAND, middleDist: 0.15 }, WEB)).toBe(false);
  });

  it('needs BOTH of index and pinky extended', () => {
    expect(isThwipPose({ ...THWIP_HAND, indexDist: 0.05 }, WEB)).toBe(false);
    expect(isThwipPose({ ...THWIP_HAND, pinkyDist: 0.05 }, WEB)).toBe(false);
  });

  it('says no inside the dead band rather than guessing', () => {
    // Every finger parked between the two thresholds: half a gesture, which
    // must read as "not yet" and not as a coin flip on tracking noise.
    const midpoint = (WEB.curlThreshold + WEB.extendThreshold) / 2;
    expect(
      isThwipPose(
        {
          indexDist: midpoint,
          middleDist: midpoint,
          ringDist: midpoint,
          pinkyDist: midpoint,
        },
        WEB,
      ),
    ).toBe(false);
  });

  it('treats an unresolved joint (Infinity) as extended, never as curled', () => {
    // jointDistance returns Infinity for a joint it could not find. That must
    // fail the curl test, so missing tracking data can never read as a thwip.
    expect(
      isThwipPose({ ...THWIP_HAND, middleDist: Number.POSITIVE_INFINITY }, WEB),
    ).toBe(false);
  });
});

describe('stepGestureGate', () => {
  const COOLDOWN = 500;

  it('fires on the frame the gesture starts', () => {
    const gate = createGestureGate();
    expect(stepGestureGate(gate, true, 1000, COOLDOWN)).toBe(true);
  });

  it('fires once, however long the gesture is held', () => {
    const gate = createGestureGate();
    expect(stepGestureGate(gate, true, 1000, COOLDOWN)).toBe(true);

    let extra = 0;
    // Well past the cooldown, still held — the latch is what stops it.
    for (let t = 1011; t <= 4000; t += 11) {
      if (stepGestureGate(gate, true, t, COOLDOWN)) extra++;
    }
    expect(extra).toBe(0);
  });

  it('re-arms once the gesture clears, and fires again', () => {
    const gate = createGestureGate();
    expect(stepGestureGate(gate, true, 0, COOLDOWN)).toBe(true);
    expect(stepGestureGate(gate, false, 100, COOLDOWN)).toBe(false);
    expect(stepGestureGate(gate, true, 600, COOLDOWN)).toBe(true);
  });

  it('swallows a re-pose inside the cooldown', () => {
    // A single dropped tracking frame reads as clear-then-pose. Without the
    // cooldown that throws a second web the player never asked for.
    const gate = createGestureGate();
    expect(stepGestureGate(gate, true, 0, COOLDOWN)).toBe(true);
    expect(stepGestureGate(gate, false, 11, COOLDOWN)).toBe(false);
    expect(stepGestureGate(gate, true, 22, COOLDOWN)).toBe(false);
  });

  it('does not let a swallowed re-pose hold the gate open afterwards', () => {
    const gate = createGestureGate();
    stepGestureGate(gate, true, 0, COOLDOWN);
    stepGestureGate(gate, false, 11, COOLDOWN);
    // Blocked by cooldown, but the latch still closed...
    expect(stepGestureGate(gate, true, 22, COOLDOWN)).toBe(false);
    // ...so it still needs a genuine clear before the next shot.
    expect(stepGestureGate(gate, true, 900, COOLDOWN)).toBe(false);
    expect(stepGestureGate(gate, false, 911, COOLDOWN)).toBe(false);
    expect(stepGestureGate(gate, true, 922, COOLDOWN)).toBe(true);
  });

  it('never fires while inactive', () => {
    const gate = createGestureGate();
    for (let t = 0; t < 5000; t += 100) {
      expect(stepGestureGate(gate, false, t, COOLDOWN)).toBe(false);
    }
  });
});

describe('forwardSpeed', () => {
  it('measures travel along the pointing axis', () => {
    // One metre along -Z in one second, hand pointing -Z.
    expect(forwardSpeed(0, 0, 0, 0, 0, -1, 0, 0, -1, 1)).toBeCloseTo(1);
  });

  it('scales by the sample window, not the frame', () => {
    expect(forwardSpeed(0, 0, 0, 0, 0, -0.16, 0, 0, -1, 0.08)).toBeCloseTo(2);
  });

  it('goes negative when the hand is pulled back', () => {
    expect(forwardSpeed(0, 0, 0, 0, 0, 1, 0, 0, -1, 1)).toBeCloseTo(-1);
  });

  it('ignores sideways motion entirely', () => {
    // A brisk wave across the body must not read as a thrust.
    expect(forwardSpeed(0, 0, 0, 2, 0, 0, 0, 0, -1, 1)).toBeCloseTo(0);
    expect(forwardSpeed(0, 0, 0, 0, 2, 0, 0, 0, -1, 1)).toBeCloseTo(0);
  });

  it('projects a diagonal onto the pointing axis', () => {
    // Moving straight down -Z while the hand points 45 degrees off it recovers
    // only the component along the hand.
    const s = Math.SQRT1_2;
    expect(forwardSpeed(0, 0, 0, 0, 0, -1, 0, -s, -s, 1)).toBeCloseTo(s);
  });

  it('returns 0 rather than Infinity on a zero or negative window', () => {
    expect(forwardSpeed(0, 0, 0, 0, 0, -1, 0, 0, -1, 0)).toBe(0);
    expect(forwardSpeed(0, 0, 0, 0, 0, -1, 0, 0, -1, -0.5)).toBe(0);
  });
});

describe('thrust edge detection', () => {
  /** How the system wires the two pure pieces together, minus the World. */
  const thrust = (
    gate: ReturnType<typeof createGestureGate>,
    fromZ: number,
    toZ: number,
    windowSec: number,
    nowMs: number,
  ) =>
    stepGestureGate(
      gate,
      forwardSpeed(0, 0, fromZ, 0, 0, toZ, 0, 0, -1, windowSec) >
        WEB.thrustSpeed,
      nowMs,
      WEB.thrustCooldownMs,
    );

  it('fires once on a spike, not once per window', () => {
    const gate = createGestureGate();
    const window = WEB.thrustWindowSec;
    // 3 m/s forward, sustained across several windows.
    const step = 3 * window;

    let fired = 0;
    let z = 0;
    for (let i = 0; i < 12; i++) {
      const next = z - step;
      if (thrust(gate, z, next, window, i * window * 1000)) fired++;
      z = next;
    }
    expect(fired).toBe(1);
  });

  it('stays silent for a hand drifting under the threshold', () => {
    const gate = createGestureGate();
    const window = WEB.thrustWindowSec;
    // Half the trigger speed — a hand being moved, not thrown.
    const step = (WEB.thrustSpeed / 2) * window;

    let z = 0;
    for (let i = 0; i < 40; i++) {
      const next = z - step;
      expect(thrust(gate, z, next, window, i * window * 1000)).toBe(false);
      z = next;
    }
  });

  it('re-arms after the hand stops, then fires again past the cooldown', () => {
    const gate = createGestureGate();
    const window = WEB.thrustWindowSec;
    const fast = 3 * window;

    expect(thrust(gate, 0, -fast, window, 0)).toBe(true);
    // Hand comes to rest: the latch clears.
    expect(thrust(gate, 0, 0, window, 200)).toBe(false);
    // Second shove, still inside the cooldown — swallowed.
    expect(thrust(gate, 0, -fast, window, 300)).toBe(false);
    expect(thrust(gate, 0, 0, window, 400)).toBe(false);
    // And once the cooldown has run out, it lands.
    expect(thrust(gate, 0, -fast, window, 400 + WEB.thrustCooldownMs)).toBe(
      true,
    );
  });

  it('never fires on a hand yanked backwards', () => {
    const gate = createGestureGate();
    const window = WEB.thrustWindowSec;
    const fast = 5 * window;

    let z = 0;
    for (let i = 0; i < 12; i++) {
      const next = z + fast;
      expect(thrust(gate, z, next, window, i * window * 1000)).toBe(false);
      z = next;
    }
  });
});

describe('fitShooterScale', () => {
  /** The shipped GLB, in its own units: a cuff whose hole runs along X. */
  const SHIPPED = { x: 0.72536, y: 1.84812, z: 1.89868 };

  const fit = (
    x: number,
    y: number,
    z: number,
    band = WEB.shooterBandMeters,
    length = WEB.shooterLengthMeters,
  ) => {
    const out = createShooterFit();
    fitShooterScale(x, y, z, band, length, out);
    return out;
  };

  it('finds the band axis of the shipped cuff', () => {
    // y and z are within 3% of each other and x is 2.6x smaller: the ring lies
    // in yz and its hole runs along x. Axis 0 is x.
    const out = fit(SHIPPED.x, SHIPPED.y, SHIPPED.z);
    expect(out.bandAxis).toBe(0);
    expect(out.bandSpan).toBeCloseTo(SHIPPED.z, 5);
  });

  it('finds the band axis whichever way the exporter oriented it', () => {
    expect(fit(SHIPPED.y, SHIPPED.x, SHIPPED.z).bandAxis).toBe(1);
    expect(fit(SHIPPED.y, SHIPPED.z, SHIPPED.x).bandAxis).toBe(2);
  });

  it('scales the shipped cuff to the configured band diameter', () => {
    const out = fit(SHIPPED.x, SHIPPED.y, SHIPPED.z);
    expect(out.cappedByLength).toBe(false);
    expect(out.bandSpan * out.scale).toBeCloseTo(WEB.shooterBandMeters, 6);
  });

  it('never lets the finished model exceed the length cap', () => {
    const out = fit(SHIPPED.x, SHIPPED.y, SHIPPED.z);
    const longest = Math.max(SHIPPED.x, SHIPPED.y, SHIPPED.z);
    expect(longest * out.scale).toBeLessThanOrEqual(
      WEB.shooterLengthMeters + 1e-9,
    );
  });

  it('falls back to a length fit for art that is not a band at all', () => {
    // A long thin barrel: band-fitting its 1x1 cross-section to 7.5 cm would
    // stretch the 10-unit length to three quarters of a metre.
    const out = fit(10, 1, 1);
    expect(out.cappedByLength).toBe(true);
    expect(10 * out.scale).toBeCloseTo(WEB.shooterLengthMeters, 6);
  });

  it('is scale-invariant: the same model in different units fits the same', () => {
    const metres = fit(SHIPPED.x, SHIPPED.y, SHIPPED.z);
    const centimetres = fit(SHIPPED.x * 100, SHIPPED.y * 100, SHIPPED.z * 100);
    expect(metres.bandAxis).toBe(centimetres.bandAxis);
    expect(metres.scale / centimetres.scale).toBeCloseTo(100, 4);
  });

  it('leaves a degenerate model alone rather than dividing by zero', () => {
    const out = fit(0, 0, 0);
    expect(out.scale).toBe(1);
    expect(Number.isFinite(out.scale)).toBe(true);
  });

  it('grew the shipped shooter compared with round 4s length fit', () => {
    // Round 4: longest axis fitted to 0.07. Round 5: band fitted to 0.075. The
    // field asked for bigger, so bigger is asserted rather than assumed.
    const longest = Math.max(SHIPPED.x, SHIPPED.y, SHIPPED.z);
    const round4 = 0.07 / longest;
    expect(fit(SHIPPED.x, SHIPPED.y, SHIPPED.z).scale).toBeGreaterThan(round4);
  });
});

describe('StrandState', () => {
  it('numbers the four strand states without collisions', () => {
    // Round 6 added Tethered: a strand with no timer, whose far end tracks a
    // live robot rather than a landed ball.
    const values = Object.values(StrandState);
    expect(values).toHaveLength(4);
    expect(new Set(values).size).toBe(4);
  });

  it('makes Free the zero value, so a fresh Int8Array pool starts empty', () => {
    expect(StrandState.Free).toBe(0);
  });

  it('keeps the round-5 states on their original numbers', () => {
    // The strand pool is a plain Int8Array and WebStrand mirrors it for the
    // MCP tools; renumbering would silently reinterpret every live slot.
    expect(StrandState.Flying).toBe(1);
    expect(StrandState.Fading).toBe(2);
    expect(StrandState.Tethered).toBe(3);
  });
});

describe('gooStrandRgb (round 9 GOO colour)', () => {
  it('uses the sRGB paint colour for a flying strand', () => {
    const out: [number, number, number] = [0, 0, 0];
    expect(gooStrandRgb([1, 0.2, 0.4, 1], true, false, 0.35, out)).toEqual([1, 0.2, 0.4]);
  });

  it('lifts a tether line toward white', () => {
    const out: [number, number, number] = [0, 0, 0];
    gooStrandRgb([0, 0.5, 1, 1], true, true, 0.5, out);
    expect(out[0]).toBeCloseTo(0.5);
    expect(out[1]).toBeCloseTo(0.75);
    expect(out[2]).toBeCloseTo(1);
  });

  it('falls back to white when the knob is off or no colour is loaded', () => {
    const out: [number, number, number] = [0, 0, 0];
    expect(gooStrandRgb([1, 0, 0, 1], false, false, 0.35, out)).toEqual([1, 1, 1]);
    expect(gooStrandRgb(undefined, true, true, 0.35, out)).toEqual([1, 1, 1]);
  });

  it('clamps garbage input into 0..1', () => {
    const out: [number, number, number] = [0, 0, 0];
    gooStrandRgb([2, -1, Number.NaN, 1], true, false, 0, out);
    expect(out).toEqual([1, 0, 1]);
  });
});
