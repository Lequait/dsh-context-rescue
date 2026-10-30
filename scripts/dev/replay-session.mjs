/**
 * Session shells that replay a session log captured on disk.
 *
 * `~/.dsh/sessions/<workspace>/session-<uuid>/session.v4.jsonl.zstd` is the only
 * source of truth for how the host actually builds a surface, so every claim the
 * planner makes is checked against one of these. `ReplaySession` keeps the
 * projection live in memory: an `append` with a `surfaceOp` mutates the node list
 * exactly like the host does, which is what lets a fold be validated after the
 * fact instead of only before.
 * @module dsh-context-rescue/scripts/dev/replay-session
 */

import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Message event types that become surface nodes on their own. */
const MESSAGE_TYPES = new Set([
  'system/message',
  'user/message',
  'assistant/message',
  'tool/result',
  'tool/call',
  'tool/ptc-dispatch',
]);

/** Expand `~` so an env var can be written the way a shell user expects. */
export function expandHome(path) {
  if (path.startsWith('~')) return join(homedir(), path.slice(1));
  return path;
}

/** The newest `session.v4.jsonl.zstd` anywhere below `directory`. */
export function newestUnder(directory) {
  const candidates = [];
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.name.endsWith('.jsonl.zstd')) candidates.push(child);
    }
  }
  candidates.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return candidates[0];
}

/** Every session log below `directory`, newest first. */
export function allLogsUnder(directory) {
  const found = [];
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.name.endsWith('.jsonl.zstd')) found.push(child);
    }
  }
  return found.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
}

/** A session shell over a loaded log: appends land in memory, surface is live. */
export class ReplaySession {
  constructor(events, surface) {
    this.events = events;
    this.surface = { nodes: surface };
    this.seq = events.at(-1)?.seq ?? 0;
    this.id = 'replay';
  }

  append(type, data, options) {
    const seq = ++this.seq;
    const event = { seq, time: seq, type, data: data ?? {}, ...(options ? { options } : {}) };
    this.events.push(event);
    const op = options?.surfaceOp;
    if (op) {
      const start = this.surface.nodes.indexOf(op.startSeq);
      const end = this.surface.nodes.indexOf(op.endSeq);
      assert.ok(start >= 0 && end >= start, 'replacement range must be on the surface');
      this.surface.nodes.splice(start, end - start + 1, seq);
    } else if (MESSAGE_TYPES.has(type)) {
      this.surface.nodes.push(seq);
    }
    return event;
  }

  eventAt(seq) {
    return this.events.find((event) => event.seq === seq);
  }
}
