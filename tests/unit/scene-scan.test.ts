import { describe, it, expect } from 'vitest';
import { shouldShowScanNotice } from '../../src/systems/SceneScanSystem';
import { ROOM } from '../../src/config';

const CFG = { scanCheckDelaySec: 6 };

describe('shouldShowScanNotice', () => {
  it('says nothing at all before the grace period is up', () => {
    // detectedPlanes "is not populated immediately" (Meta's Browser docs), so
    // a fresh session always looks unscanned for a moment. Firing the notice
    // there would flash an amber warning at every player with a perfectly good
    // room scan, every single time they enter.
    for (const elapsed of [0, 0.5, 2, 5.99]) {
      expect(shouldShowScanNotice(0, 0, elapsed, CFG)).toBe(false);
    }
  });

  it('raises the notice once the grace period has passed with nothing found', () => {
    expect(shouldShowScanNotice(0, 0, CFG.scanCheckDelaySec, CFG)).toBe(true);
    expect(shouldShowScanNotice(0, 0, 30, CFG)).toBe(true);
  });

  it('stays quiet for a single plane, however long the session runs', () => {
    expect(shouldShowScanNotice(1, 0, 300, CFG)).toBe(false);
  });

  it('counts meshes as well as planes', () => {
    // Meta's Browser page documents only the Plane Detection module, but IWSDK
    // asks for both, and a runtime reporting meshes has plainly been handed a
    // scene model. Ignoring that would tell a scanned player to go and scan.
    expect(shouldShowScanNotice(0, 1, 300, CFG)).toBe(false);
    expect(shouldShowScanNotice(0, 12, 300, CFG)).toBe(false);
  });

  it('counts a lone global mesh as a scanned room', () => {
    // The round-6 case worth pinning down. Quest Space Setup can hand over
    // exactly one XRMesh — the whole-room triangle soup — with no planes at
    // all, and that room is scanned: WorldCollisionSystem turns that single
    // mesh into a trimesh collider covering every wall in it. Telling the
    // player to run Space Setup at that point would be advice to redo work
    // they have already done.
    expect(shouldShowScanNotice(0, 1, 300, CFG)).toBe(false);
    expect(shouldShowScanNotice(0, 1, ROOM.scanCheckDelaySec, ROOM)).toBe(false);
  });

  it('drops the notice the moment geometry turns up, however late', () => {
    // A player who walks out mid-session, runs Space Setup and comes back must
    // not have to reload to get their notice dismissed.
    expect(shouldShowScanNotice(0, 0, 120, CFG)).toBe(true);
    expect(shouldShowScanNotice(4, 0, 120, CFG)).toBe(false);
  });

  it('ignores the clock entirely once anything is detected', () => {
    for (const elapsed of [0, 1, CFG.scanCheckDelaySec, 1e6]) {
      expect(shouldShowScanNotice(3, 5, elapsed, CFG)).toBe(false);
    }
  });

  it('uses the shipped delay, which is longer than Quest needs', () => {
    expect(shouldShowScanNotice(0, 0, ROOM.scanCheckDelaySec - 0.01, ROOM)).toBe(
      false,
    );
    expect(shouldShowScanNotice(0, 0, ROOM.scanCheckDelaySec, ROOM)).toBe(true);
  });
});
