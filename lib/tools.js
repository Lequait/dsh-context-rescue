/**
 * Model-facing tools.
 *
 * Registered as plain `ToolDefinition` objects — no `defineTool` import, so the
 * plugin loads even when the host's tool schema package is not resolvable from
 * the plugin's own dependency tree.
 * @module dsh-context-rescue/tools
 */

import { describeSession, mechanicalFold, rescue, rescueStateOf } from './rescue.js';
import { serviceOf } from './measure.js';
import { classifyFailure } from './overflow.js';
import { errorText, isObject } from './util.js';

/** Render a JSON value as a single fenced text block. */
function renderJson(value) {
  return [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`` }];
}

const OUTPUT = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => renderJson(value) };

/** Pull the calling agent out of a tool execution context. */
function agentOf(exec) {
  return exec?.agent ?? exec?.context?.agent ?? exec?.session?.agent;
}

/**
 * Register the rescue tools.
 * @param {any} ctx
 * @param {any} config
 * @returns {Array<() => void>} disposers
 */
export function registerTools(ctx, config) {
  if (config.registerTools === false) return [];
  const tools = serviceOf(ctx, 'tools');
  if (!tools || typeof tools.register !== 'function') return [];
  const disposers = [];

  disposers.push(tools.register({
    name: 'context_rescue',
    description: [
      'Emergency context-window rescue for this session.',
      'action=status reports occupancy, the resolved window, which rescue tiers are available, and the last rescue attempt.',
      'action=rescue immediately folds the oldest history span into a mechanical digest (no model call) and reports the token delta.',
      'Use it when a request failed with a context-window / too-large-payload error, or before sending a very large prompt.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'rescue'],
          description: 'status: report only. rescue: fold now.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args, exec) {
      const action = isObject(args) && typeof args.action === 'string' ? args.action : 'status';
      const agent = agentOf(exec);
      const session = agent?.session;
      if (!session) return { ok: false, error: 'no active session on this execution context' };
      const state = agent ? rescueStateOf(agent) : null;
      const provider = exec?.agent?.options?.provider ?? undefined;

      if (action === 'status') {
        const description = await describeSession(ctx, { session, config, provider, signal: exec?.signal });
        return { ok: true, ...description, lastAttempt: state?.lastReport ?? null, attemptsThisTurn: state?.attempts ?? 0, history: state?.history ?? [] };
      }

      try {
        const report = await rescue(ctx, {
          agent,
          session,
          failure: null,
          provider,
          turn: undefined,
          signal: exec?.signal,
          config,
          force: true,
        });
        return {
          // `attempted` is what separates "folded the history" from "measured it
          // and left it alone"; reporting the latter as a success tells the model
          // context was freed when nothing moved.
          ok: report.attempted === true && report.action === 'retry',
          attempted: report.attempted === true,
          action: report.action,
          reason: report.reason,
          before: report.before?.totalTokens,
          after: report.after?.totalTokens,
          window: report.window,
          tiers: report.tiers,
        };
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    },
  }));

  disposers.push(tools.register({
    name: 'context_rescue_estimate',
    description: 'Estimate whether the given error text (or this session as-is) would be classified as a context-window overflow, and show the sizes extracted from the message.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Optional error message to classify. Omit to classify the current session only.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args, exec) {
      const text = isObject(args) && typeof args.text === 'string' ? args.text : '';
      const detected = text ? classifyFailure({ message: text }, { extraPatterns: config.extraPatterns }) : null;
      const agent = agentOf(exec);
      const session = agent?.session;
      const sessionInfo = session
        ? await describeSession(ctx, { session, config, provider: exec?.agent?.options?.provider, signal: exec?.signal })
        : null;
      return { ok: true, detected, session: sessionInfo };
    },
  }));

  // The manual fold shares the mechanical tier so users can free space without
  // waiting for a failure.
  disposers.push(tools.register({
    name: 'context_rescue_fold',
    description: 'Fold the oldest history span into a mechanical digest right now (zero model calls) and report the token delta. Equivalent to context_rescue with action=rescue.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: OUTPUT,
    async execute(_args, exec) {
      const agent = agentOf(exec);
      const session = agent?.session;
      if (!session) return { ok: false, error: 'no active session on this execution context' };
      const description = await describeSession(ctx, { session, config, provider: exec?.agent?.options?.provider, signal: exec?.signal });
      const fold = mechanicalFold(ctx, {
        agent,
        session,
        config,
        windowTokens: description.window.windowTokens,
        reason: 'manual fold requested tool call',
      });
      return {
        ok: fold.ok === true,
        before: fold.before?.totalTokens,
        after: fold.after?.totalTokens,
        digestChars: fold.digestChars,
        window: description.window,
        skipped: fold.skipped,
        written: fold.written,
      };
    },
  }));

  return disposers;
}
