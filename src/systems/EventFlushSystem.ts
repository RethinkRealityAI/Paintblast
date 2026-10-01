import { createSystem } from '@iwsdk/core';

import { GameEventBuffer } from '../types';

/**
 * Empties world.globals.gameEvents at the end of every frame.
 *
 * The event buffer is a one-frame mailbox: producers (BallSpawnSystem,
 * BallFlightSystem, TargetSystem, GameStateSystem) append to it, consumers
 * (HudSystem, FeedbackSystem) read it, and this system — registered at
 * priority 90, after everything else — resets the count so the next frame
 * starts clean. Clearing here rather than in a consumer means no consumer has
 * to be the designated last reader.
 */
export class EventFlushSystem extends createSystem({}) {
  private events!: GameEventBuffer;

  init() {
    this.events = this.globals.gameEvents as GameEventBuffer;
  }

  update() {
    this.events?.clear();
  }
}
