/**
 * Human-facing slash commands.
 *
 * The model can call the tools, but the person sitting in front of the UI is the
 * one who sees "this session is dead" first. These commands give that person a
 * direct lever: `/rescue` folds immediately, `/rescue-status` only reports.
 *
 * Nothing here is required for the automatic rescue path, so the `commands`
 * service is feature-detected rather than injected — a profile without it must
 * still mount the request-error hook.
 * @module dsh-context-rescue/command
 */

import { serviceOf } from './measure.js';
import { describeSession, log, rememberReport, rescue, rescueStateOf } from './rescue.js';
import { errorText } from './util.js';

/** Namespaced definition id, matching the shape host commands use. */
const DEFINITION_ID = '@deepseek-ai/dsh-context-rescue';

/** Group digits for human-readable token counts. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : 'unknown';
}

/** A safe `sourceEventSeq` for the command result, when one is available. */
function seqOf(report) {
  const seq = report?.fold?.written?.replacementSeq;
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined;
}

/** Render one rescue report as the single line a command result carries. */
function describeReport(report) {
  if (report.action !== 'retry') return `Not rescued: ${report.reason}`;
  if (report.attempted === false) return `Nothing to do: ${report.reason}`;
  const before = num(report.before?.totalTokens);
  const after = num(report.after?.totalTokens);
  const window = num(report.window?.windowTokens);
  const tier = report.tiers?.filter((entry) => entry.ok === true).map((entry) => entry.tier).pop() ?? 'no tier';
  const folded = report.fold?.plan?.shadowedSeqs?.length;
  const items = typeof folded === 'number' ? `, ${num(folded)} history items folded` : '';
  return `Rescued: ${before} -> ${after} tokens against a ${window} window (${tier}${items}). Send your message again.`;
}

/** Build the `/rescue` and `/rescue-status` definitions over one context. */
function commandDefinitions(ctx, config) {
  const sessionOf = (invocation) => invocation?.agent?.session;

  const rescueHandler = async (invocation) => {
    const session = sessionOf(invocation);
    if (!session) return { kind: 'error', text: 'No active session to rescue.' };

    const wantsStatus = String(invocation?.rawInput ?? '').trim().toLowerCase() === 'status';
    const state = rescueStateOf(invocation.agent);

    try {
      if (wantsStatus) {
        const description = await describeSession(ctx, {
          session,
          config,
          signal: invocation?.signal,
        });
        const text = describeStatus(description, state);
        return { kind: 'success', text };
      }

      const report = await rescue(ctx, {
        agent: invocation.agent,
        session,
        failure: undefined,
        provider: undefined,
        signal: invocation?.signal,
        config,
        force: true,
      });
      rememberReport(invocation.agent, report);
      if (report.action !== 'retry') return { kind: 'error', text: describeReport(report) };
      const sourceEventSeq = seqOf(report);
      return {
        kind: 'success',
        text: describeReport(report),
        ...(sourceEventSeq === undefined ? {} : { sourceEventSeq }),
      };
    } catch (error) {
      return { kind: 'error', text: `Rescue failed: ${errorText(error)}` };
    }
  };

  const statusHandler = async (invocation) => {
    const session = sessionOf(invocation);
    if (!session) return { kind: 'error', text: 'No active session to inspect.' };
    try {
      const description = await describeSession(ctx, {
        session,
        config,
        signal: invocation?.signal,
      });
      return { kind: 'success', text: describeStatus(description, rescueStateOf(invocation.agent)) };
    } catch (error) {
      return { kind: 'error', text: `Status failed: ${errorText(error)}` };
    }
  };

  return [
    {
      definitionId: `${DEFINITION_ID}:rescue`,
      name: 'rescue',
      description: 'Fold the oldest conversation span now so the next request fits the model window',
      handler: rescueHandler,
    },
    {
      definitionId: `${DEFINITION_ID}:rescue-status`,
      name: 'rescue-status',
      description: 'Report context occupancy and whether an emergency fold is possible',
      handler: statusHandler,
    },
  ];
}

/** Render `describeSession` output as one command-result line. */
function describeStatus(description, state) {
  const parts = [];
  const used = description?.measuredTokens;
  const window = description?.window?.windowTokens;
  if (typeof used === 'number') parts.push(`${num(used)} tokens in context`);
  if (typeof window === 'number') parts.push(`window ${num(window)}`);
  if (typeof description?.occupancy === 'number' && Number.isFinite(description.occupancy)) {
    parts.push(`${Math.round(description.occupancy * 100)}% of the window`);
  }
  parts.push(description?.fits === true ? 'fits already' : 'over the fit ratio');
  if (typeof description?.derivedTokens === 'number' && Number.isFinite(description.derivedTokens)) {
    parts.push(`request would carry ~${num(description.derivedTokens)} tokens`);
  }

  const preview = description?.preview;
  if (preview && typeof preview.shadowedNodes === 'number') {
    parts.push(`a rescue would fold ${preview.shadowedNodes} nodes (seq ${preview.start}…${preview.end}, ~${num(preview.shadowedTokens)} tokens) into a ~${num(preview.digestChars)}-character summary and keep ~${num(preview.retainedTokens)} tokens of recent history`);
  } else if (description?.preview === null && description?.fits === false && description?.foldSupported?.ok === true) {
    parts.push('a rescue would find nothing to fold');
  }
  if (description?.foldSupported?.ok === false) {
    parts.push(`cannot fold (${description.foldSupported.missing.join(', ')})`);
  }
  if (description?.hostCompaction) parts.push(`host compaction ${description.hostCompaction}`);
  if (description?.toolResultPruner) parts.push(`tool-result pruner ${description.toolResultPruner}`);
  if (state?.laneBlocked) parts.push('compression lane refused the host engine; zero-model path only');

  const last = state?.lastReport;
  if (last) parts.push(`last rescue: ${last.action} (${last.reason})`);
  else parts.push('no rescue attempted yet');

  return parts.join('; ');
}

/**
 * Register the slash commands when the host exposes a command registry.
 *
 * The registry may mount *after* this plugin (plugin order is a profile detail),
 * so registration happens once now and again whenever the service appears. The
 * returned disposers unregister everything this call installed.
 * @param {any} ctx
 * @param {any} config
 * @returns {Array<() => void>} disposers, empty when no registry ever appears
 */
export function registerCommands(ctx, config) {
  if (config.registerCommands === false) return [];

  const disposers = [];
  const definitions = commandDefinitions(ctx, config);
  let lastCommands;

  const install = (commands) => {
    if (!commands || typeof commands.register !== 'function') return;
    if (commands === lastCommands) return;
    lastCommands = commands;
    for (const definition of definitions) {
      try {
        const disposer = commands.register(definition);
        if (typeof disposer === 'function') disposers.push(disposer);
      } catch (error) {
        // Re-providing the service fires the event again; a name we already own
        // is not an error worth reporting.
        if (!/already registered/u.test(errorText(error))) {
          log(ctx, 'warn', `command /${definition.name} registration failed: ${errorText(error)}`);
        }
      }
    }
  };

  install(serviceOf(ctx, 'commands'));

  // `internal/service` fires whenever a service implementation is (re)provided;
  // listening keeps the commands available even when the registry mounts late.
  if (typeof ctx.on === 'function') {
    const stop = ctx.on('internal/service', (name, value) => {
      if (name === 'commands') install(value);
    });
    if (typeof stop === 'function') disposers.push(stop);
  }

  return disposers;
}
