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
 * The distinction that makes a repair safe: a live writer is inside the current
 * turn, so its `start` carries this turn's number. A leftover carries an older
 * one. Nothing else is touched.
 * @module dsh-context-rescue/repair
 */

import { isObject } from './util.js';
import { eventsOf } from './measure.js';

/**
 * Every compaction id whose bracket is still open.
 * @param {any} session
 * @returns {Map<any, {seq?: any, turn?: number}>} id → the event that opened it
 */
export function openTransactions(session) {
  /** @type {Map<any, {seq?: any, turn?: number}>} */
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
 * Append the closing event for transactions that began in an earlier turn.
 *
 * Returns the ids it closed. It never touches a bracket opened in the current
 * turn: that one may still be mid-write, and closing it from here would corrupt
 * a live fold instead of repairing a dead one.
 * @param {any} session
 * @param {{turn?: number, onRepair?: (id: any, startedInTurn: number | undefined) => void}} [options]
 * @returns {any[]}
 */
export function repairStaleTransactions(session, options = {}) {
  const { turn, onRepair } = options;
  if (typeof session?.append !== 'function') return [];
  const repaired = [];
  for (const [id, start] of openTransactions(session)) {
    const startedInTurn = start.turn;
    const live = typeof turn === 'number' && typeof startedInTurn === 'number' && startedInTurn >= turn;
    if (live) continue;
    session.append('compaction/end', {
      compactionId: id,
      ...(typeof turn === 'number' ? { turn } : {}),
      error: 'closed by context-rescue: this transaction was left open by an earlier turn',
    });
    repaired.push(id);
    if (typeof onRepair === 'function') onRepair(id, startedInTurn);
  }
  return repaired;
}
