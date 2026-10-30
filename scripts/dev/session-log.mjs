/**
 * Read a real DSH v4 session log.
 *
 * The format is a chain of independent zstd frames, one per append batch, and
 * Node's zstd decoder stops after the first frame. Frames are therefore split
 * on their magic number and decoded individually; a false-positive magic inside
 * compressed bytes simply fails to decode and the span is widened.
 * @module dsh-context-rescue/scripts/dev/session-log
 */

import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** @param {Buffer} buffer @returns {Buffer} */
function decodeFrames(buffer) {
  const offsets = [];
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer[index] === MAGIC[0] && buffer[index + 1] === MAGIC[1]
      && buffer[index + 2] === MAGIC[2] && buffer[index + 3] === MAGIC[3]) offsets.push(index);
  }
  if (offsets.length === 0) return zstdDecompressSync(buffer);
  const parts = [];
  let cursor = 0;
  while (cursor < offsets.length) {
    let advanced = 0;
    for (let span = 1; span <= 4 && cursor + span <= offsets.length; span += 1) {
      const start = offsets[cursor];
      const end = cursor + span < offsets.length ? offsets[cursor + span] : buffer.length;
      try {
        parts.push(zstdDecompressSync(buffer.subarray(start, end)));
        advanced = span;
        break;
      } catch {
        // Not a whole frame: widen the span.
      }
    }
    cursor += advanced || 1;
  }
  return Buffer.concat(parts);
}

/**
 * @param {string} path
 * @returns {{ header: any, events: any[] }}
 */
export function loadSessionLog(path) {
  const raw = readFileSync(path);
  const text = decodeFrames(raw).toString('utf8');
  const events = [];
  let header;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type === 'session' && header === undefined) header = record;
    else events.push(record);
  }
  return { header, events };
}

/** The surface the host reconstructs from a log, in surface order. */
const MESSAGE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'developer/message', 'tool/result']);

/**
 * @param {any[]} events
 * @returns {{ surface: Array<any>, bySeq: Map<number, any> }}
 */
export function reconstructSurface(events) {
  const surface = [];
  const bySeq = new Map();
  for (const event of events) {
    bySeq.set(event.seq, event);
    const op = event?.options?.surfaceOp ?? event?.surfaceOp;
    if (op && op.op === 'replace') {
      const start = surface.indexOf(op.startSeq);
      const end = surface.indexOf(op.endSeq);
      if (start >= 0 && end >= start) surface.splice(start, end - start + 1, event.seq);
      continue;
    }
    if (MESSAGE_TYPES.has(event?.type)) surface.push(event.seq);
  }
  return { surface, bySeq };
}
