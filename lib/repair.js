/**
 * Close compaction transactions that no writer is going to close.
 *
 * A fold is a bracket: `compaction/start` opens it and `compaction/end` closes
 * it. The writer appends both inside one turn, but the process can die in
 * between — the app is closed, the machine sleeps, the renderer crashes. The
 * session then keeps a dangling start forever, and because the planner refuses
 * to fold across an open transaction (rightly: it cannot tell a half-written
 * fold from a live one), that session can never be rescued again. It is the
 * same dead end the plugin exists to remove, only caused by a crash instead of
 * a window.
 *
 * What a repair may write is decided by the host's restore validator, not by
 * what looks tidy. `compaction/end` must name the same turn as its `start`
 * **and** that turn must be the one open at that point in the log. So:
 *
 * - A bracket whose turn is still the open turn can be closed, and the close
 *   must carry that same turn. This is the crash case: the log ends inside the
 *   turn that opened the bracket.
 * - A bracket from an earlier turn can never be closed. Once the log has moved
 *   past it, the log is already invalid ("turn/end crosses an open
 *   compaction"), and appending an end with either turn makes it no better —
 *   with the current turn it fails "compaction/end changes its owner turn",
 *   with the old one "does not match the open turn". Those are reported, never
 *   written.
 *
 * Our hooks run at step boundaries and the host awaits its own compaction
 * inside a step, so an open bracket seen here has no live writer behind it.
 * @module dsh-context-rescue/repair
 */

import { isObject } from './util.js';
import { eventsOf } from './measure.js';

/**
 * Every compaction id whose bracket is still open.
 * @param {any} session
 * @returns {Map<any, {seq?: any, turn?: number | null}>} id → the event that opened it
 */
export function openTransactions(session) {
  /** @type {Map<any, {seq?: any, turn?: number | null}>} */
  const open = new Map();
  for (const event of eventsOf(session)) {
    if (!isObject(event)) continue;
    const id = isObject(event.data) ? event.data.compactionId : undefined;
    if (id === undefined) continue;
    if (event.type === 'compaction/start') open.set(id, { seq: event.seq, turn: event.data?.turn });
    else if (event.type === 'compaction/end') open.delete(id);
  }
  return open;
}

/**
 * The turn that is open at the end of the log, or `null` between turns.
 * @param {any} session
 * @returns {number | null}
 */
export function openTurnOf(session) {
  const events = eventsOf(session);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isObject(event)) continue;
    if (event.type === 'turn/start') {
      const turn = isObject(event.data) ? event.data.turn : undefined;
      return Number.isFinite(turn) ? /** @type {number} */ (turn) : null;
    }
    if (event.type === 'turn/end') return null;
  }
  return null;
}

/**
 * Append the closing event for transactions that can still be closed validly.
 *
 * Returns the ids it closed. Brackets that can no longer be closed are passed
 * to `onUnrepairable` and left exactly as they are.
 * @param {any} session
 * @param {{
 *   onRepair?: (id: any, turn: number | null | undefined) => void,
 *   onUnrepairable?: (id: any, turn: number | null | undefined, openTurn: number | null) => void,
 * }} [options]
 * @returns {any[]}
 */
export function repairStaleTransactions(session, options = {}) {
  const { onRepair, onUnrepairable } = options;
  if (typeof session?.append !== 'function') return [];
  const openTurn = openTurnOf(session);
  const repaired = [];
  for (const [id, start] of openTransactions(session)) {
    const startedInTurn = start.turn;
    if ((startedInTurn ?? null) !== openTurn) {
      if (typeof onUnrepairable === 'function') onUnrepairable(id, startedInTurn, openTurn);
      continue;
    }
    session.append('compaction/end', {
      compactionId: id,
      turn: openTurn,
      error: 'closed by context-rescue: this transaction was left open by an earlier step',
    });
    repaired.push(id);
    if (typeof onRepair === 'function') onRepair(id, startedInTurn);
  }
  return repaired;
}
