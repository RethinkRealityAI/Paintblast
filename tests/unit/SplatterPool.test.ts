import { describe, it, expect, beforeEach } from 'vitest';
import { SplatterPool } from '../../src/systems/SplatterSystem';

describe('SplatterPool ring buffer', () => {
  let pool: SplatterPool;

  beforeEach(() => {
    pool = new SplatterPool(4);
  });

  it('starts empty', () => {
    expect(pool.capacity).toBe(4);
    expect(pool.liveCount).toBe(0);
    expect(pool.writeIdx).toBe(0);
  });

  it('rejects non-positive or non-integer capacities', () => {
    expect(() => new SplatterPool(0)).toThrow();
    expect(() => new SplatterPool(-1)).toThrow();
    expect(() => new SplatterPool(3.5)).toThrow();
  });

  it('writes one splat and advances writeIdx', () => {
    const slot = pool.addSplat([0, 1, -2], [0, 0, 1], [1, 0, 0], 1.25);
    expect(slot).toBe(0);
    expect(pool.liveCount).toBe(1);
    expect(pool.writeIdx).toBe(1);
    expect(pool.getSplatPosition(0)).toEqual([0, 1, -2]);
    expect(pool.getSplatNormal(0)).toEqual([0, 0, 1]);
    expect(pool.getSplatColor(0)).toEqual([1, 0, 0]);
    expect(pool.getSplatSize(0)).toBeCloseTo(1.25, 5);
  });

  it('defaults the size column to 1 when no size is given', () => {
    pool.addSplat([0, 0, 0], [0, 1, 0], [1, 1, 1]);
    expect(pool.getSplatSize(0)).toBe(1);
  });

  it('keeps a distinct size per slot', () => {
    pool.addSplat([0, 0, 0], [0, 1, 0], [1, 1, 1], 0.5);
    pool.addSplat([1, 0, 0], [0, 1, 0], [1, 1, 1], 2);
    expect(pool.getSplatSize(0)).toBeCloseTo(0.5, 5);
    expect(pool.getSplatSize(1)).toBeCloseTo(2, 5);
  });

  it('wraps writeIdx back to 0 at capacity', () => {
    for (let i = 0; i < 4; i++) {
      pool.addSplat([i, 0, 0], [0, 1, 0], [1, 1, 1]);
    }
    expect(pool.liveCount).toBe(4);
    expect(pool.writeIdx).toBe(0);
  });

  it('overwrites oldest splats past capacity', () => {
    for (let i = 0; i < 5; i++) {
      pool.addSplat([i, 0, 0], [0, 1, 0], [1, 1, 1], i + 1);
    }
    expect(pool.liveCount).toBe(4); // capped at capacity
    expect(pool.writeIdx).toBe(1);  // 5 mod 4 = 1
    // slot 0 now holds the 5th splat (i=4)
    expect(pool.getSplatPosition(0)).toEqual([4, 0, 0]);
    expect(pool.getSplatSize(0)).toBeCloseTo(5, 5);
    // slot 1 still holds the 2nd splat (i=1)
    expect(pool.getSplatPosition(1)).toEqual([1, 0, 0]);
    expect(pool.getSplatSize(1)).toBeCloseTo(2, 5);
  });

  it('clear() resets writeIdx and liveCount but preserves capacity', () => {
    pool.addSplat([0, 0, 0], [0, 1, 0], [1, 1, 1], 1.5);
    pool.addSplat([1, 0, 0], [0, 1, 0], [0, 1, 0], 1.5);
    pool.clear();
    expect(pool.liveCount).toBe(0);
    expect(pool.writeIdx).toBe(0);
    expect(pool.capacity).toBe(4);
    expect(pool.getSplatPosition(0)).toEqual([0, 0, 0]);
    expect(pool.getSplatColor(0)).toEqual([0, 0, 0]);
    expect(pool.getSplatSize(0)).toBe(0);
  });

  it('returns the slot index from addSplat for later readback', () => {
    const first = pool.addSplat([0, 0, 0], [0, 1, 0], [1, 1, 1]);
    const second = pool.addSplat([1, 0, 0], [0, 1, 0], [1, 1, 1]);
    const third = pool.addSplat([2, 0, 0], [0, 1, 0], [1, 1, 1]);
    expect(first).toBe(0);
    expect(second).toBe(1);
    expect(third).toBe(2);
    expect(pool.getSplatPosition(second)).toEqual([1, 0, 0]);
  });
});
