/**
 * dsh-context-rescue — emergency rescue for sessions that hit the model context
 * window.
 *
 * The harness already compacts automatically, but that path fails whenever the
 * failure is not recognised as a context overflow (gateway wording) or whenever
 * the compression lane refuses the host's compaction call. When that happens the
 * turn dies and every retry re-sends the same oversized request. This plugin
 * listens on `agent/request-error`, which fires for *every* failed request,
 * independently re-detects the condition, folds the oldest history span into a
 * durable checkpoint, and retries the same step.
 *
 * @module dsh-context-rescue
 */

import { registerCommands } from './lib/command.js';
import { resolveConfig, validateConfig } from './lib/config.js';
import { log, preflight, rememberReport, rescue, rescueStateOf } from './lib/rescue.js';
import { registerTools } from './lib/tools.js';
import { errorText } from './lib/util.js';

export const name = 'context-rescue';

/**
 * The request-error hook is the whole point, and the tools service is needed to
 * register the manual entry points. Everything else is feature-detected.
 */
export const inject = ['tools'];

/** @param {any} ctx @param {any} rawConfig */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  // A misspelled option would otherwise make the plugin behave exactly like an
  // uninstalled one, so misconfiguration is reported where it is caused.
  for (const warning of validateConfig(rawConfig)) log(ctx, 'warn', `config: ${warning.message}`);
  if (!config.enabled) {
    log(ctx, 'info', 'disabled by configuration');
    return;
  }

  try {
    registerTools(ctx, config);
  } catch (error) {
    log(ctx, 'warn', `tool registration failed: ${errorText(error)}`);
  }

  // Commands are optional: the service is absent in some profiles, and losing
  // the slash commands must never cost us the request-error hook below.
  try {
    registerCommands(ctx, config);
  } catch (error) {
    log(ctx, 'warn', `command registration failed: ${errorText(error)}`);
  }

  /**
   * Pre-flight: a projection that is already larger than the model window
   * cannot be sent at all, so it is folded before the request is built. The
   * request-error hook below stays the safety net for everything else.
   */
  if (config.preflight) {
    ctx.on('agent/pre-step', async (payload, next) => {
      const agent = payload?.agent;
      const session = agent?.session;
      if (!session || payload?.signal?.aborted) return next();
      try {
        const report = await preflight(ctx, {
          agent,
          session,
          config,
          turn: payload?.turn,
          signal: payload?.signal,
          provider: payload?.provider,
          model: payload?.model,
        });
        if (report.attempted && config.verbose) {
          log(ctx, 'info', `pre-flight ${report.action}: ${report.reason}; tokens ${report.before?.totalTokens} -> ${report.after?.totalTokens}`);
        }
      } catch (error) {
        log(ctx, 'warn', `pre-flight failed, letting the step continue: ${errorText(error)}`);
      }
      return next();
    });
  }

  /**
   * Waterfall listener: return `{ kind: 'retry' }` to make the loop re-send the
   * same step (the request body is rebuilt from the session surface), or call
   * `next()` to leave the failure to the host.
   */
  ctx.on('agent/request-error', async (payload, next) => {
    const agent = payload?.agent;
    const session = agent?.session;
    if (!session) return next();

    const state = rescueStateOf(agent);
    const turn = payload?.turn;
    if (state.turn !== turn) {
      state.turn = turn;
      state.attempts = 0;
    }

    // Budget the attempts per turn before doing any work: a rescue that keeps
    // failing must not turn into a retry storm.
    let report;
    try {
      if (state.attempts >= config.maxAttemptsPerTurn) {
        return next();
      }
      state.attempts += 1;
      report = await rescue(ctx, {
        agent,
        session,
        failure: payload.failure,
        provider: payload.provider,
        turn,
        step: payload?.step,
        attempt: state.attempts,
        signal: payload?.signal,
        config,
      });
    } catch (error) {
      log(ctx, 'warn', `rescue failed, passing the original error through: ${errorText(error)}`);
      return next();
    }

    rememberReport(agent, report);

    if (report.action === 'retry') {
      log(ctx, 'info', `rescued (${report.reason}); tokens ${report.before?.totalTokens} -> ${report.after?.totalTokens}; retrying step ${payload?.step}`);
      return { kind: 'retry' };
    }

    if (config.verbose && report.detected?.overflow) {
      log(ctx, 'warn', `context overflow detected but not rescued: ${report.reason}`);
    }
    return next();
  });

  log(ctx, 'info', 'armed: context-overflow rescue active');
}
