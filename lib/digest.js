/**
 * Mechanical digest of a folded span.
 *
 * This is the zero-model path: it never calls a provider, so it still works
 * when the compression lane is owned by a proxy that refuses host compaction
 * calls (billion-context, discussion #10138). The digest keeps the parts of a
 * long session that matter for continuing work — what the user asked, which
 * files and commands were touched, which errors are still open, what remains on
 * the todo list — and drops the prose.
 * @module dsh-context-rescue/digest
 */

import {
  asText, clamp, contentBlocksToText, collectPaths, isObject, oneLine, uniq,
} from './util.js';
import { eventsOf } from './measure.js';

const ERRORISH = /(?:^|\n)\s*(?:error|err!|exception|traceback|fatal|failed|failure|错误|失败|异常)\b/i;

/**
 * Messages the harness injects on the user's behalf: runtime snapshots, skill
 * catalogues, memory projections, time samples. They are not what the user
 * asked for, so listing them as intent would bury the real request.
 */
const HOUSEKEEPING = new RegExp(
  [
    '<(?:system-reminder|available_skills|runtime-context)',
    'MNEMON RUNTIME MEMORY SNAPSHOT',
    '\\[MNEMON\\]',
    'Time sampled while preparing turn',
    'Current runtime context',
    'Browser time zone for this request',
    '^The approval policy changed from',
    '^background job ', 
    '^<path>[^<]*</path>',
  ].join('|'),
  'iu',
);

/** Wrapper tags the harness puts around injected objectives. */
const INTENT_WRAPPER = /<\/?(?:goal_round|system-reminder|available_skills)>/gu;

/** Drop the echoed tool call a conclusion is often glued to. */
function stripCallEcho(text) {
  const cut = text.indexOf('[调用 ');
  const head = cut === -1 ? text : text.slice(0, cut);
  return head.trim();
}

/** An assistant message that is really a tool-call payload, not prose. */
/** An assistant message that is really a tool-call payload, not prose. */
function isToolCallDump(text) {
  const head = text.trimStart();
  return head.startsWith('[调用') || head.startsWith('{"code"') || head.startsWith('{"type":"tool');
}

/** A reasoning block serialised as text is not a conclusion. */
const REASONING_BLOCK = /^\s*\{\s*"type"\s*:\s*"reasoning"/u;

/** Unwrap an injected objective so the line reads as what was asked. */
function stripIntentWrappers(text) {
  return text.replace(INTENT_WRAPPER, ' ').replace(/\s+/gu, ' ').trim();
}

/** Read the events whose seq lies inside the inclusive span. */
export function eventsInRange(session, startSeq, endSeq) {
  const events = eventsOf(session);
  return events.filter((event) => {
    if (!isObject(event)) return false;
    if (startSeq !== undefined && event.seq < startSeq) return false;
    if (endSeq !== undefined && event.seq > endSeq) return false;
    return true;
  });
}

/** Arguments that answer "what was this call for", in descending usefulness. */
const SUMMARY_KEYS = ['description', 'command', 'objective', 'query', 'prompt', 'file_path', 'path', 'pattern', 'url'];

/** A `description:` field written inside a code string, as the run_code tool does. */
const DESCRIPTION_IN_CODE = /description:\s*(["'`])((?:\.|(?!\1).)*)\1/u;

/** Turn an argument blob into one readable line, preferring a stated purpose. */
function describeCall(args) {
  if (args === undefined) return '';
  let parsed = args;
  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return oneLine(trimmed, 120);
      }
    } else {
      return oneLine(trimmed, 120);
    }
  }
  if (!isObject(parsed)) return oneLine(asText(parsed), 120);
  for (const key of SUMMARY_KEYS) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value, 120);
  }
  const code = typeof parsed.code === 'string' ? parsed.code : '';
  if (code !== '') {
    const described = DESCRIPTION_IN_CODE.exec(code);
    if (described) {
      const quote = described[1];
      const text = described[2].split(String.fromCharCode(92) + quote).join(quote);
      return oneLine(text, 120);
    }
    const first = code.split('\n').find((line) => line.trim() !== '');
    if (first !== undefined) return oneLine(first, 100);
  }
  const keys = Object.keys(parsed).slice(0, 5);
  return keys.length > 0 ? `参数：${keys.join('、')}` : '';
}

/** Extract a tool call's name, one-line purpose and any paths it mentions. */
function toolCallFacts(event) {
  const data = isObject(event.data) ? event.data : {};
  const call = isObject(data.call) ? data.call : data;
  const name = asText(call.name ?? data.name ?? 'tool');
  const args = call.arguments ?? call.input ?? data.arguments ?? data.input;
  const paths = [];
  if (args !== undefined) collectPaths(args, paths);
  return { name, summary: describeCall(args), paths };
}

/**
 * Collapse the call log into readable lines: same call once, same tool at most a
 * handful of times, with a count for everything dropped.
 */
function summarizeCommands(entries, limit) {
  const seen = new Set();
  const perName = new Map();
  const lines = [];
  let omitted = 0;
  for (const entry of entries) {
    const key = `${entry.name}|${entry.summary}`;
    if (seen.has(key)) {
      // A repeated identical call is still a call the reader does not need to see twice.
      omitted += 1;
      continue;
    }
    seen.add(key);
    const used = perName.get(entry.name) ?? 0;
    if (used >= 6 || lines.length >= limit) {
      perName.set(entry.name, used + 1);
      omitted += 1;
      continue;
    }
    perName.set(entry.name, used + 1);
    lines.push(`${entry.name}：${entry.summary === '' ? '（参数未说明用途）' : entry.summary}`);
  }
  if (omitted > 0) lines.push(`（另有 ${omitted} 次重复或同类调用未展开）`);
  return lines;
}

/** Extract tool result text and its failure flag. */
function toolResultFacts(event) {
  const data = isObject(event.data) ? event.data : {};
  const result = isObject(data.result) ? data.result : data;
  const isError = result.isError === true || result.is_error === true || data.isError === true;
  const content = result.content ?? data.content ?? result.output ?? '';
  return { isError, text: contentBlocksToText(content, 1200) };
}

/**
 * Build a bounded markdown digest for one folded span.
 * @param {any} session
 * @param {{
 *   startSeq?: any, endSeq?: any, shadowedSeqs?: any[], shadowedTokenCount?: number,
 *   totalTokens?: number, windowTokens?: number, measuredTokens?: number,
 *   reason?: string, maxChars?: number, keepCounts?: Record<string, number>,
 *   pinDropped?: boolean
 * }} options
 * @returns {string}
 */
export function buildDigest(session, options) {
  const {
    startSeq, endSeq, shadowedSeqs = [], shadowedTokenCount = 0,
    totalTokens = 0, windowTokens = 0, measuredTokens = 0, reason = '', maxChars = 12000,
    pinDropped = false,
  } = options;
  const events = eventsInRange(session, startSeq, endSeq);

  /** @type {string[]} */ const userLines = [];
  /** @type {string[]} */ const assistantLines = [];
  /** @type {Array<{name: string, summary: string}>} */ const commandEntries = [];
  /** @type {string[]} */ const errorLines = [];
  /** @type {string[]} */ const filePaths = [];
  let todoState = null;

  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        const message = isObject(event.data) ? event.data.message : undefined;
        const text = contentBlocksToText(isObject(message) ? message.content : event.data?.content, 600);
        const cleaned = stripIntentWrappers(text);
        // Match the noise patterns on the raw text: stripping the wrapper tags
        // first would also remove the tags those patterns look for.
        if (cleaned !== '' && !HOUSEKEEPING.test(text) && !HOUSEKEEPING.test(cleaned)) userLines.push(oneLine(cleaned, 240));
        break;
      }
      case 'assistant/message': {
        const message = isObject(event.data) ? event.data.message : undefined;
        const text = contentBlocksToText(isObject(message) ? message.content : event.data?.content, 800);
        // A reasoning block or a serialised tool call is not a conclusion.
        const prose = text.trim() !== '' && !REASONING_BLOCK.test(text) && !isToolCallDump(text);
        if (prose) {
          const statement = stripCallEcho(text);
          if (statement !== '') assistantLines.push(oneLine(statement, 320));
        }
        break;
      }
      case 'tool/call': {
        const facts = toolCallFacts(event);
        commandEntries.push({ name: facts.name, summary: facts.summary });
        for (const path of facts.paths) filePaths.push(path);
        break;
      }
      case 'tool/result': {
        const facts = toolResultFacts(event);
        if (facts.isError || ERRORISH.test(facts.text)) {
          errorLines.push(oneLine(facts.text, 200));
        }
        break;
      }
      case 'todo/write': {
        const data = isObject(event.data) ? event.data : {};
        if (Array.isArray(data.todos)) todoState = data.todos;
        break;
      }
      case 'llm/retry': {
        const data = isObject(event.data) ? event.data : {};
        if (data.message) errorLines.push(oneLine(data.message, 200));
        break;
      }
      default:
        break;
    }
  }

  const files = uniq(filePaths, 40);
  const commands = summarizeCommands(commandEntries, 45);
  const errors = uniq(errorLines, 12);
  const uniqueIntents = [];
  const seenIntent = new Set();
  for (const line of userLines) {
    const key = line.replace(/\s+/gu, ' ').slice(0, 160);
    if (seenIntent.has(key)) continue;
    seenIntent.add(key);
    uniqueIntents.push(line);
  }
  const intents = uniqueIntents.length <= 10
    ? uniqueIntents
    : [...uniqueIntents.slice(0, 4), '…', ...uniqueIntents.slice(-6)];
  const conclusions = assistantLines.slice(-4);

  const header = [
    '## 会话急救摘要（dsh-context-rescue · 机械抽取，未调用模型）',
    '',
    reason ? `- 触发原因：${oneLine(reason, 300)}` : '',
    `- 折叠范围：seq ${asText(startSeq)} … ${asText(endSeq)}（${shadowedSeqs.length} 个 surface 节点，约 ${Math.round(shadowedTokenCount).toLocaleString('en-US')} tokens）`,
    measuredTokens ? `- 折叠前投影：约 ${Math.round(measuredTokens).toLocaleString('en-US')} tokens` : '',
    windowTokens ? `- 模型窗口：约 ${Math.round(windowTokens).toLocaleString('en-US')} tokens` : '',
    totalTokens ? `- 被替换内容占全会话的 ${Math.round((shadowedTokenCount / Math.max(1, totalTokens)) * 100)}%` : '',
    pinDropped ? '- 注意：这次折叠包含了会话最开始的那条消息——它本身就是装不下的原因，只能一起折；它的要点见下方「用户意图」。' : '',
    '',
    '> 原始消息仍完整保留在会话日志中（可用会话查看器回溯），此处只是模型可见的压缩投影。',
    '',
  ].filter((line) => line !== '').join('\n');

  /** @type {Array<{title: string, lines: string[], priority: number}>} */
  const sections = [];
  if (errors.length > 0) sections.push({ title: '错误与失败（可能仍未解决）', lines: errors.map((line) => `- ${line}`), priority: 0 });
  if (files.length > 0) sections.push({ title: '触及的文件与路径', lines: files.map((path) => `- ${path}`), priority: 1 });
  if (todoState) {
    const items = todoState
      .map((todo) => {
        const status = asText(todo?.status ?? 'pending');
        const marker = status === 'completed' ? 'x' : status === 'in_progress' ? '~' : ' ';
        return `- [${marker}] ${oneLine(todo?.content, 160)}`;
      })
      .slice(0, 40);
    if (items.length > 0) sections.push({ title: '任务清单（折叠时状态）', lines: items, priority: 1 });
  }
  if (commands.length > 0) sections.push({ title: '已执行的关键操作', lines: commands.map((line) => `- ${line}`), priority: 2 });
  if (intents.length > 0) sections.push({ title: '用户意图（按时间顺序）', lines: intents.map((line, index) => `${index + 1}. ${line}`), priority: 2 });
  if (conclusions.length > 0) sections.push({ title: '最近结论', lines: conclusions.map((line) => `- ${line}`), priority: 3 });

  let body = '';
  const ordered = [...sections].sort((left, right) => left.priority - right.priority);
  for (const section of ordered) {
    const block = `### ${section.title}\n${section.lines.join('\n')}\n`;
    if (body.length + block.length > maxChars) {
      const room = maxChars - body.length - `### ${section.title}\n`.length - 20;
      if (room > 160) {
        const kept = [];
        let used = 0;
        for (const line of section.lines) {
          if (used + line.length + 1 > room) break;
          kept.push(line);
          used += line.length + 1;
        }
        if (kept.length > 0) body += `### ${section.title}\n${kept.join('\n')}\n- …（本段其余 ${section.lines.length - kept.length} 条已省略）\n`;
      }
      continue;
    }
    body += block;
  }
  if (!body.trim()) {
    body = '### 摘要\n- 折叠区间内没有可机械抽取的结构化内容（只有普通对话文本）。\n';
  }
  return clamp(`${header}
${body}`, maxChars + header.length + 200);
}
