/**
 * Configuration surface and defaults.
 *
 * The plugin is deliberately conservative: it only acts when a failure looks
 * like a context-window overflow, it always keeps a verbatim recent tail, and
 * every action is bounded and reversible through the session log.
 * @module dsh-context-rescue/config
 */

/** @typedef {ReturnType<typeof resolveConfig>} RescueConfig */

export const DEFAULTS = Object.freeze({
  /** Master switch; `false` leaves the harness untouched. */
  enabled: true,
  /**
   * `auto` — detect overflow failures, rescue, then retry the same step.
   * `diagnose` — detect and report, never rewrite the session.
   * `fold` — always fold on a detected overflow, never try cheaper tiers.
   */
  mode: 'auto',
  /** When true, never call a model to summarise (billion-context-safe). */
  zeroModelOnly: false,
  /** Fraction of the window kept verbatim at the tail after a fold. */
  retainRatio: 0.25,
  /** Absolute floor for the retained verbatim tail. */
  retainMinTokens: 4000,
  /** Absolute ceiling for the retained verbatim tail. */
  retainMaxTokens: 40000,
  /** A retry is only issued when the projection is below this fraction. */
  fitRatio: 0.9,
  /** Folding aims at this fraction of the window. */
  targetRatio: 0.75,
  /** Rescue attempts allowed per turn; prevents retry storms. */
  maxAttemptsPerTurn: 2,
  /** Borrow the host compaction engine when one is installed. */
  allowModelCompaction: true,
  /** Cap on the mechanical digest size, in characters. */
  maxDigestChars: 12000,
  /** Never fold a range worth fewer tokens than this. */
  minFoldTokens: 4000,
  /** Window used when neither the model info nor the failure text provides one. */
  windowFallback: 196608,
  /** Keep the first user message (the task statement) out of the fold. */
  pinFirstUserMessage: true,
  /** Register the [context_rescue] tool. */
  registerTools: true,
  /** Register the human `/rescue` and `/rescue-status` commands when the host has a command registry. */
  registerCommands: true,
  /**
   * Fold before the request is built when the projection is already larger than
   * the model window. This is the pre-flight half of the rescue: the request
   * would fail anyway, so the cost of waiting for the failure is a wasted step.
   */
  preflight: true,
  /** Close compaction brackets a crash left open, so the session can fold again. */
  repairTransactions: true,
  /** Replace a single message that alone overflows the window with head+tail. */
  trimOversizedMessages: true,
  /** Characters kept from each end when that happens. */
  excerptChars: 3000,
  /** Write structured diagnostics to the host logger. */
  verbose: true,
  /** Extra detection regex sources (strings) appended to the built-in probes. */
  extraPatterns: [],
  /**
   * Resolved lazily by the host; when a lane owner (e.g. billion-context)
   * refuses native compaction we remember it and skip that tier afterwards.
   */
  laneRefusalPatterns: ['dsh_compaction_refused', 'bili owns compression'],
});

/** Deep-merge plain objects; arrays and scalars replace. */
export function mergeConfig(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ...base };
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    const bothPlain = value && typeof value === 'object' && !Array.isArray(value)
      && current && typeof current === 'object' && !Array.isArray(current);
    out[key] = bothPlain ? mergeConfig(current, value) : value;
  }
  return out;
}

/** Clamp a ratio into a usable range. */
function ratio(value, fallback, min = 0.01, max = 1) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/** Clamp a positive integer-ish quantity. */
function positive(value, fallback, min = 1) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.max(min, Math.floor(num));
}

/** Normalise raw plugin options into a fully populated, validated config. */
export function resolveConfig(raw) {
  const merged = mergeConfig(DEFAULTS, raw ?? {});
  const mode = ['auto', 'diagnose', 'fold'].includes(merged.mode) ? merged.mode : 'auto';
  return Object.freeze({
    ...merged,
    mode,
    enabled: merged.enabled !== false,
    zeroModelOnly: merged.zeroModelOnly === true,
    allowModelCompaction: merged.allowModelCompaction !== false,
    pinFirstUserMessage: merged.pinFirstUserMessage !== false,
    registerTools: merged.registerTools !== false,
    preflight: merged.preflight !== false,
    repairTransactions: merged.repairTransactions !== false,
    trimOversizedMessages: merged.trimOversizedMessages !== false,
    excerptChars: Number.isFinite(merged.excerptChars) ? Math.max(200, Math.floor(merged.excerptChars)) : DEFAULTS.excerptChars,
    verbose: merged.verbose !== false,
    retainRatio: ratio(merged.retainRatio, DEFAULTS.retainRatio, 0.05, 0.6),
    fitRatio: ratio(merged.fitRatio, DEFAULTS.fitRatio, 0.3, 1),
    targetRatio: ratio(merged.targetRatio, DEFAULTS.targetRatio, 0.2, 0.98),
    retainMinTokens: positive(merged.retainMinTokens, DEFAULTS.retainMinTokens, 256),
    retainMaxTokens: positive(merged.retainMaxTokens, DEFAULTS.retainMaxTokens, 512),
    maxAttemptsPerTurn: positive(merged.maxAttemptsPerTurn, DEFAULTS.maxAttemptsPerTurn, 1),
    maxDigestChars: positive(merged.maxDigestChars, DEFAULTS.maxDigestChars, 512),
    minFoldTokens: positive(merged.minFoldTokens, DEFAULTS.minFoldTokens, 64),
    windowFallback: positive(merged.windowFallback, DEFAULTS.windowFallback, 1024),
    extraPatterns: Array.isArray(merged.extraPatterns) ? merged.extraPatterns.filter((item) => typeof item === 'string') : [],
    laneRefusalPatterns: Array.isArray(merged.laneRefusalPatterns)
      ? merged.laneRefusalPatterns.filter((item) => typeof item === 'string')
      : DEFAULTS.laneRefusalPatterns,
  });
}

/** Every option the plugin understands, for typo detection. */
const KNOWN_KEYS = new Set(Object.keys(DEFAULTS));

/**
 * Report options that will not do what the user asked, without changing the
 * resolved config. A rescue plugin that silently ignores a typo behaves exactly
 * like a rescue plugin that is not installed, so the misconfiguration has to be
 * visible at mount time.
 *
 * @param {any} raw the options the user passed to the plugin
 * @returns {Array<{key: string, message: string}>} warnings, empty when clean
 */
export function validateConfig(raw) {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return [{ key: '(options)', message: 'plugin options must be an object; the defaults are in effect' }];
  }
  const warnings = [];
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) warnings.push({ key, message: `unknown option "${key}" is ignored` });
  }
  const config = resolveConfig(raw);

  if (raw.mode !== undefined && !['auto', 'diagnose', 'fold'].includes(raw.mode)) {
    warnings.push({ key: 'mode', message: `mode ${JSON.stringify(raw.mode)} is not auto|diagnose|fold; using "auto"` });
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    warnings.push({ key: 'enabled', message: `enabled must be a boolean; ${JSON.stringify(raw.enabled)} is treated as true` });
  }
  const clamped = /** @type {Array<[string, number, number]>} */ ([
    ['retainRatio', 0.05, 0.6],
    ['fitRatio', 0.3, 1],
    ['targetRatio', 0.2, 0.98],
  ]);
  for (const [key, min, max] of clamped) {
    const requested = Number(raw[key]);
    if (!Number.isFinite(requested)) continue;
    if (requested === config[key]) continue;
    warnings.push({
      key,
      message: `${key} ${requested} is outside ${min}..${max}; using ${config[key]} instead`,
    });
  }
  if (config.retainMinTokens > config.retainMaxTokens) {
    warnings.push({
      key: 'retainMaxTokens',
      message: `retainMinTokens (${config.retainMinTokens}) is above retainMaxTokens (${config.retainMaxTokens}); the ceiling wins`,
    });
  }
  if (config.targetRatio >= config.fitRatio) {
    warnings.push({
      key: 'targetRatio',
      message: `targetRatio (${config.targetRatio}) is not below fitRatio (${config.fitRatio}); a fold that lands on the target can still be refused`,
    });
  }
  if (config.minFoldTokens >= config.retainMaxTokens) {
    warnings.push({
      key: 'minFoldTokens',
      message: `minFoldTokens (${config.minFoldTokens}) is not below retainMaxTokens (${config.retainMaxTokens}); short histories will never be folded`,
    });
  }
  return warnings;
}
