import { describe, it, expect, beforeEach } from 'vitest';
import {
  GameEvent,
  GameEventBuffer,
  GAME_EVENT_CAPACITY,
} from '../../src/types';

describe('GameEventBuffer', () => {
  let buffer: GameEventBuffer;

  beforeEach(() => {
    buffer = new GameEventBuffer(4);
  });

  it('defaults to the shared frame capacity', () => {
    expect(new GameEventBuffer().capacity).toBe(GAME_EVENT_CAPACITY);
  });

  it('rejects non-positive or non-integer capacities', () => {
    expect(() => new GameEventBuffer(0)).toThrow();
    expect(() => new GameEventBuffer(-1)).toThrow();
    expect(() => new GameEventBuffer(2.5)).toThrow();
  });

  it('starts empty', () => {
    expect(buffer.count).toBe(0);
  });

  it('stores type, position and payload for one event', () => {
    expect(buffer.emit(GameEvent.BallImpact, 1, 2, -3, 7)).toBe(true);

    expect(buffer.count).toBe(1);
    expect(buffer.typeAt(0)).toBe(GameEvent.BallImpact);
    expect(buffer.xAt(0)).toBe(1);
    expect(buffer.yAt(0)).toBe(2);
    expect(buffer.zAt(0)).toBe(-3);
    expect(buffer.dataAt(0)).toBe(7);
  });

  it('defaults position and payload to zero', () => {
    buffer.emit(GameEvent.RoundStart);
    expect(buffer.typeAt(0)).toBe(GameEvent.RoundStart);
    expect(buffer.xAt(0)).toBe(0);
    expect(buffer.yAt(0)).toBe(0);
    expect(buffer.zAt(0)).toBe(0);
    expect(buffer.dataAt(0)).toBe(0);
  });

  it('keeps events in emission order and does not alias slots', () => {
    buffer.emit(GameEvent.BallFired, 1, 0, 0, 10);
    buffer.emit(GameEvent.SplatPainted, 2, 0, 0, 20);
    buffer.emit(GameEvent.TargetPopped, 3, 0, 0, 30);

    expect(buffer.count).toBe(3);
    expect(buffer.typeAt(0)).toBe(GameEvent.BallFired);
    expect(buffer.typeAt(1)).toBe(GameEvent.SplatPainted);
    expect(buffer.typeAt(2)).toBe(GameEvent.TargetPopped);
    expect(buffer.xAt(1)).toBe(2);
    expect(buffer.dataAt(2)).toBe(30);
  });

  it('drops events past capacity instead of growing', () => {
    for (let i = 0; i < 4; i++) {
      expect(buffer.emit(GameEvent.BallFired, i, 0, 0, i)).toBe(true);
    }

    expect(buffer.emit(GameEvent.BallFired, 99, 0, 0, 99)).toBe(false);
    expect(buffer.count).toBe(4);
    // The dropped event must not have overwritten the last stored one.
    expect(buffer.xAt(3)).toBe(3);
  });

  it('clear() empties the buffer and reuses slots from the start', () => {
    buffer.emit(GameEvent.BallImpact, 5, 5, 5, 5);
    buffer.emit(GameEvent.BallStuck, 6, 6, 6, 6);
    buffer.clear();

    expect(buffer.count).toBe(0);

    buffer.emit(GameEvent.ComboMilestone, -1, -2, -3, 4);
    expect(buffer.count).toBe(1);
    expect(buffer.typeAt(0)).toBe(GameEvent.ComboMilestone);
    expect(buffer.xAt(0)).toBe(-1);
    expect(buffer.dataAt(0)).toBe(4);
  });

  it('accepts a full frame again after clear()', () => {
    for (let i = 0; i < 4; i++) buffer.emit(GameEvent.BallFired);
    expect(buffer.emit(GameEvent.BallFired)).toBe(false);

    buffer.clear();
    for (let i = 0; i < 4; i++) {
      expect(buffer.emit(GameEvent.BallFired)).toBe(true);
    }
    expect(buffer.count).toBe(4);
  });
});

describe('GameEvent enum', () => {
  it('assigns a unique integer to every event type', () => {
    const values = Object.values(GameEvent);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});
