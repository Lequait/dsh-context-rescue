/**
 * The configuration surface, declared as a real Cordis/Schemastery schema.
 *
 * Why declare it at all: without an exported `Config`, the host treats this
 * plugin's options as unknown configuration. Users editing a profile patch get
 * no completion and no validation, and `dsh --dump-config-schema` can only say
 * "unknown". With it, the host validates the patch before the plugin starts and
 * documents every knob it accepts.
 *
 * The schema deliberately does not tighten anything the runtime tolerates:
 * unknown keys pass through so {@link validateConfig} can still name a typo
 * instead of the host dropping it silently.
 * @module dsh-context-rescue/schema
 */

import Schema from 'schemastery';

import { DEFAULTS } from './config.js';

export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(DEFAULTS.enabled)
    .description('Master switch. `false` leaves the harness completely untouched.'),

  mode: Schema.union(['auto', 'diagnose', 'fold'])
    .default(DEFAULTS.mode)
    .description('`auto` detects, rescues, then retries; `diagnose` only reports; `fold` always takes the mechanical digest.'),

  zeroModelOnly: Schema.boolean()
    .default(DEFAULTS.zeroModelOnly)
    .description('Never ask a model to summarise. Use this when a proxy owns the compression lane.'),

  retainRatio: Schema.number()
    .min(0.05)
    .max(0.6)
    .default(DEFAULTS.retainRatio)
    .description('Fraction of the model window kept verbatim at the tail after a fold.'),

  retainMinTokens: Schema.number()
    .min(0)
    .default(DEFAULTS.retainMinTokens)
    .description('Floor for the verbatim tail, in tokens.'),

  retainMaxTokens: Schema.number()
    .min(0)
    .default(DEFAULTS.retainMaxTokens)
    .description('Ceiling for the verbatim tail, in tokens. Wins when it is below the floor.'),

  fitRatio: Schema.number()
    .min(0.3)
    .max(1)
    .default(DEFAULTS.fitRatio)
    .description('A retry is only issued when the projection lands below this fraction of the window.'),

  targetRatio: Schema.number()
    .min(0.2)
    .max(0.98)
    .default(DEFAULTS.targetRatio)
    .description('Where a fold aims, as a fraction of the window. Keep it below `fitRatio`.'),

  maxAttemptsPerTurn: Schema.number()
    .min(0)
    .default(DEFAULTS.maxAttemptsPerTurn)
    .description('Rescues allowed in one turn, so a hopeless session cannot turn into a retry storm.'),

  allowModelCompaction: Schema.boolean()
    .default(DEFAULTS.allowModelCompaction)
    .description('Borrow the host compaction engine when one is installed, before falling back to the zero-model digest.'),

  maxDigestChars: Schema.number()
    .min(500)
    .default(DEFAULTS.maxDigestChars)
    .description('Cap on the mechanical checkpoint, in characters.'),

  minFoldTokens: Schema.number()
    .min(0)
    .default(DEFAULTS.minFoldTokens)
    .description('Never fold a span worth fewer tokens than this.'),

  windowFallback: Schema.number()
    .min(1000)
    .default(DEFAULTS.windowFallback)
    .description('Window used when neither the model registry nor the failure text provides one.'),

  pinFirstUserMessage: Schema.boolean()
    .default(DEFAULTS.pinFirstUserMessage)
    .description('Keep the first user message (the task statement) out of a fold, unless it alone overflows.'),

  registerTools: Schema.boolean()
    .default(DEFAULTS.registerTools)
    .description('Register the `context_rescue`, `context_rescue_estimate` and `context_rescue_fold` tools.'),

  registerCommands: Schema.boolean()
    .default(DEFAULTS.registerCommands)
    .description('Register `/rescue` and `/rescue-status` when the host has a command registry.'),

  preflight: Schema.boolean()
    .default(DEFAULTS.preflight)
    .description('Fold before the request is built when the projection already exceeds the window.'),

  repairTransactions: Schema.boolean()
    .default(DEFAULTS.repairTransactions)
    .description('Close compaction brackets that a crash left open, so the session can be folded again.'),

  trimOversizedMessages: Schema.boolean()
    .default(DEFAULTS.trimOversizedMessages)
    .description('Replace a message that alone overflows the window with its own head and tail.'),

  excerptChars: Schema.number()
    .min(200)
    .default(DEFAULTS.excerptChars)
    .description('Characters kept from each end of a message replaced by an excerpt.'),

  verbose: Schema.boolean()
    .default(DEFAULTS.verbose)
    .description('Write structured diagnostics to the host logger.'),

  extraPatterns: Schema.array(Schema.string())
    .default([...DEFAULTS.extraPatterns])
    .description('Extra detection regex sources, appended to the built-in probes.'),

  laneRefusalPatterns: Schema.array(Schema.string())
    .default([...DEFAULTS.laneRefusalPatterns])
    .description('Text that means "this compression lane is owned by someone else"; matched case-insensitively.'),
});

export default Config;
