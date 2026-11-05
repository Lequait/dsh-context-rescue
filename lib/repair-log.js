/**
 * Plan the repair of a v4 session log an older version of this plugin wrote
 * with a bracket the host refuses to restore.
 *
 * The zero-model fold of 0.2.0–0.2.4 wrote
 * `compaction/start → compaction/prune → checkpoint → compaction/end`, and the
 * bracket records carried no `turn` when a tool call triggered the fold. The
 * host accepts both while the session is live (its append-time validation is a
 * subset of the restore-time one) and rejects them on the next restart, which
 * is issue #1. The plugin cannot fix such a log from inside a session, because
 * the host refuses to load the session in the first place — hence this pure
 * planner plus a CLI: read the log, rewrite the events that are provably
 * wrong, and let the caller prove the result against the host's own validator
 * before anything is written.
 *
 * What is repairable, and why:
 *
 * 1. A bracket with no `compaction/summary` gets one, by promoting the
 *    `compaction/prune` already in the bracket: the prune's span record is
 *    exactly what a summary carries, and the checkpoint in the same bracket
 *    still holds the digest text the model would read.
 * 2. A bracket record with a missing or wrong `turn` is stamped with the turn
 *    that is open at that point of the log, which is the only value the
 *    restore validator accepts (`assertCompactionTurn`).
 *
 * What is not repairable: a bracket that spans a turn boundary (the host
 * rejects any log shape in which `turn/start`/`turn/end` arrives mid-bracket),
 * a second `compaction/start` before the first closed, and a bracket with no
 * summary and no prune to promote.
 * @module dsh-context-rescue/lib/repair-log
 */

const CHECKPOINT_KIND = 'compact-checkpoint';
const FALLBACK_SUMMARY = 'This fold did not record its summary; the span was replaced with this placeholder.';

/** @param {any} value @returns {value is Record<string, any>} */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Copy one event deeply enough to rewrite `data` and `options` without touching
 * the caller's array. Events are plain JSON, so this is a structural copy of the
 * two objects that a repair may change.
 * @param {any} event
 */
function cloneEvent(event) {
  /** @type {any} */
  const copy = { ...event };
  if (isObject(event?.data)) copy.data = { ...event.data };
  if (isObject(event?.options)) copy.options = { ...event.options };
  return copy;
}

/** The content blocks a summary should carry, taken from the bracket's checkpoint. */
function summaryContentOf(checkpoint) {
  const content = checkpoint?.data?.content;
  if (Array.isArray(content) && content.length > 0) {
    return content.map((/** @type {any} */ block) => (isObject(block) ? { ...block } : block));
  }
  return [{ type: 'text', text: FALLBACK_SUMMARY }];
}

/**
 * Plan the rewrite of one log.
 *
 * Pure: it returns a repaired copy and never writes anything. `changes` lists
 * what it would rewrite and why; `problems` lists what it cannot fix and must
 * not guess about; `notes` records things worth saying that are not defects.
 * @param {any[]} events the events of one log, in log order
 * @returns {{
 *   events: any[],
 *   changes: Array<{index: number, seq: any, type: string, what: string}>,
 *   problems: Array<{index: number, seq: any, type: string, why: string}>,
 *   notes: Array<{index: number, seq: any, note: string}>
 * }}
 */
export function planLogRepair(events) {
  const out = events.map(cloneEvent);
  /** @type {any[]} */
  const changes = [];
  /** @type {any[]} */
  const problems = [];
  /** @type {any[]} */
  const notes = [];

  /** The turn open at this point of the log, or `null` between turns. */
  let openTurn = null;
  /** @type {null | {startIndex: number, startSeq: any, id: any, turn: any, summaries: number[], prunes: number[], checkpoint: number | null}} */
  let bracket = null;
  /**
   * A bracket already reported as impossible keeps its closing record from being
   * reported a second time: one defect, one finding.
   * @type {null | {id: any}}
   */
  let abandoned = null;

  const change = (/** @type {number} */ index, /** @type {string} */ what) => {
    changes.push({ index, seq: out[index]?.seq, type: String(out[index]?.type), what });
  };

  for (let index = 0; index < out.length; index += 1) {
    const event = out[index];
    const type = String(event?.type ?? '');

    if (type === 'turn/start' || type === 'turn/end') {
      if (bracket !== null) {
        problems.push({
          index,
          seq: event.seq,
          type,
          why: `the compaction opened at seq ${bracket.startSeq} is still open when ${type} arrives, and the host rejects any bracket that spans a turn boundary`,
        });
        abandoned = { id: bracket.id };
        bracket = null;
      }
      if (type === 'turn/start') {
        const turn = event.data?.turn;
        openTurn = Number.isInteger(turn) && turn >= 0 ? turn : null;
      } else {
        openTurn = null;
      }
      continue;
    }

    if (type === 'compaction/start') {
      if (bracket !== null) {
        problems.push({
          index,
          seq: event.seq,
          type,
          why: `a second compaction/start arrives while the one at seq ${bracket.startSeq} is still open`,
        });
      }
      const declared = event.data?.turn;
      if (declared !== openTurn) {
        event.data = { ...(isObject(event.data) ? event.data : {}), turn: openTurn };
        change(
          index,
          declared === undefined
            ? `turn was missing; set to ${openTurn === null ? 'null (no turn is open here)' : `the open turn ${openTurn}`}`
            : `turn was ${JSON.stringify(declared)} but the open turn is ${openTurn === null ? 'null' : openTurn}; set to ${openTurn === null ? 'null' : openTurn}`,
        );
      }
      bracket = {
        startIndex: index,
        startSeq: event.seq,
        id: event.data?.compactionId,
        turn: event.data?.turn,
        summaries: [],
        prunes: [],
        checkpoint: null,
      };
      continue;
    }

    if (type === 'compaction/end' && bracket === null) {
      if (abandoned !== null && event.data?.compactionId === abandoned.id) {
        abandoned = null;
        continue;
      }
      problems.push({
        index,
        seq: event.seq,
        type,
        why: 'this compaction/end has no matching compaction/start',
      });
      continue;
    }

    if (bracket === null) {
      if (type === 'compaction/summary') {
        problems.push({
          index,
          seq: event.seq,
          type,
          why: 'this compaction/summary is outside every bracket',
        });
      }
      continue;
    }

    if (type === 'compaction/summary') {
      bracket.summaries.push(index);
      continue;
    }

    if (type === 'compaction/prune') {
      bracket.prunes.push(index);
      continue;
    }

    if (type === 'user/message') {
      if (isObject(event.data?.source) && event.data.source.kind === CHECKPOINT_KIND) bracket.checkpoint = index;
      continue;
    }

    if (type !== 'compaction/end') continue;

    const ending = bracket;
    bracket = null;

    const declaredEnd = event.data?.turn;
    if (declaredEnd !== ending.turn) {
      event.data = { ...(isObject(event.data) ? event.data : {}), turn: ending.turn };
      change(
        index,
        declaredEnd === undefined
          ? `the closing turn was missing; a bracket closes in the turn it opened in (${ending.turn === null ? 'null' : ending.turn})`
          : `the closing turn was ${JSON.stringify(declaredEnd)} but the bracket opened in ${ending.turn === null ? 'null' : ending.turn}`,
      );
    }

    // An end that carries an error is allowed to have no summary.
    if (event.data?.error !== undefined) continue;

    if (ending.summaries.length > 1) {
      problems.push({
        index,
        seq: event.seq,
        type,
        why: `this bracket holds ${ending.summaries.length} summaries, and the host accepts exactly one`,
      });
      continue;
    }

    if (ending.summaries.length === 1) {
      repairCheckpointSources(ending, ending.summaries[0]);
      continue;
    }

    if (ending.prunes.length === 0) {
      problems.push({
        index,
        seq: event.seq,
        type,
        why: 'this bracket has no summary and no compaction/prune to promote into one',
      });
      continue;
    }

    const promoteIndex = ending.prunes[0];
    const prune = out[promoteIndex];
    const data = { ...(isObject(prune.data) ? prune.data : {}) };
    data.compactionId = ending.id;
    data.summary = summaryContentOf(ending.checkpoint === null ? undefined : out[ending.checkpoint]);
    data.provider = typeof data.provider === 'string' ? data.provider : 'context-rescue';
    data.model = typeof data.model === 'string' ? data.model : 'context-rescue';
    out[promoteIndex] = { ...prune, type: 'compaction/summary', data };
    change(
      promoteIndex,
      'promoted to compaction/summary: the host requires exactly one summary inside every bracket whose end carries no error, and compaction/prune is not one',
    );
    repairCheckpointSources(ending, promoteIndex);
  }

  /**
   * The checkpoint's `sourceEventSeqs` must name every surface node the replace
   * swallowed, plus the bracket records. A checkpoint that omits one makes the
   * host reject the log with "replacement sourceEventSeqs omit a shadowed
   * surface node", and the list is fully reconstructible from the bracket.
   * @param {{startIndex: number, startSeq: any, id: any, summaries: number[], prunes: number[], checkpoint: number | null}} ending
   * @param {number} summaryIndex
   */
  function repairCheckpointSources(ending, summaryIndex) {
    if (ending.checkpoint === null) return;
    const checkpoint = out[ending.checkpoint];
    const options = isObject(checkpoint.options) ? checkpoint.options : undefined;
    if (options === undefined || !isObject(options.surfaceOp) || options.surfaceOp.op !== 'replace') return;
    const summary = out[summaryIndex];
    const shadowed = Array.isArray(summary?.data?.shadowedSeqs) ? summary.data.shadowedSeqs : [];
    const expected = [ending.startSeq, summary?.seq, ...shadowed];
    const actual = Array.isArray(options.sourceEventSeqs) ? options.sourceEventSeqs : [];
    const same = actual.length === expected.length && expected.every((seq, index) => actual[index] === seq);
    if (same) return;
    checkpoint.options = { ...options, sourceEventSeqs: expected };
    change(
      ending.checkpoint,
      `sourceEventSeqs named ${actual.length} of the ${expected.length} records this replacement covers; set to the bracket's own records`,
    );
  }

  if (bracket !== null) {
    notes.push({
      index: bracket.startIndex,
      seq: bracket.startSeq,
      note: 'the log ends inside an open bracket; the host tolerates that, because only a closing record has to be valid',
    });
  }

  return { events: out, changes, problems, notes };
}
