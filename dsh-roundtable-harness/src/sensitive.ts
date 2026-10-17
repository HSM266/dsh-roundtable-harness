/**
 * Sensitive-content screening.
 *
 * The scanner is deliberately blunt: a literal baseline list plus the user's own
 * words and regular expressions, matched case-insensitively. A hit never throws —
 * the caller replaces the offending passage with {@link FILTERED_PLACEHOLDER} and
 * counts the hit, and the engine stops only once `sensitiveThreshold` is exceeded.
 *
 * Three hardening rules matter as much as the word list:
 *
 *   - **Unicode folding.** Matching runs against an NFKC-folded copy, so
 *     full-width (`ｓｅｘ`), compatibility (`①`) and other look-alike spellings
 *     cannot walk past a literal rule — and literal rules are folded too, so a
 *     word list written in full-width still catches ASCII text. Folding is done
 *     per code point with an index map, so a hit's offsets are translated back
 *     and the redaction is spliced into the **original** text: the transcript
 *     keeps its own punctuation instead of being rewritten to half-width.
 *     Regular-expression rules are matched against the folded text as written
 *     (their syntax is not folded — rewriting `（）` into `()` would change what
 *     the pattern means).
 *   - **No zero-width rules.** A rule that can match zero characters (`\b`,
 *     `\B`, `(?=…)`, `(?!…)`, lookbehind) would put the placeholder between
 *     every boundary, spray the transcript and trip the threshold on the first
 *     turn. Such rules are refused at compile time, and `scan()` additionally
 *     ignores any zero-width match it still encounters.
 *   - **No catastrophic backtracking.** JavaScript regular expressions cannot be
 *     interrupted once started, so the defence has to happen before execution:
 *     nested quantifiers and backreferences are refused ({@link analyzePattern}),
 *     pattern input is length-capped, and a per-scan time budget disables a rule
 *     that keeps burning time.
 *
 * @module dsh-roundtable-harness/sensitive
 */

import type { SensitiveConfig } from './config.js';

/** Text substituted for a screened-out passage. */
export const FILTERED_PLACEHOLDER = '[内容已过滤]';

/** Longest accepted user pattern, in characters. */
export const MAX_PATTERN_LENGTH = 500;

/** Most user patterns compiled in one policy. */
export const MAX_PATTERNS = 200;

/** Most custom words compiled in one policy. */
export const MAX_WORDS = 1_000;

/** Most refusal entries kept in `rejected`; the overflow is summarised. */
export const MAX_REJECTED_REPORTED = 20;

/**
 * Longest text a user *pattern* is run against.
 *
 * Backtracking cost grows with input length, so capping the subject bounds the
 * damage an unknown-shape pattern can do. Literal rules are linear and see the
 * whole text.
 */
export const MAX_PATTERN_TEXT = 8_000;

/** Wall-clock budget for one rule's matching; a rule that blows it is disabled. */
export const SCAN_TIME_BUDGET_MS = 250;

/** Most hits one rule may contribute to a single scan. */
export const MAX_HITS_PER_RULE = 5_000;

/**
 * Baseline list: categories that a multi-model argument must never traffic in.
 * It is intentionally short and non-graphic — a starting point users extend in
 * the settings page, never a substitute for the participants' own boundaries.
 */
export const DEFAULT_SENSITIVE_WORDS: readonly string[] = [
  // 暴力与恐怖 / violence and terrorism
  '恐怖袭击', '制造炸弹', '爆炸物制作', '枪支买卖', '买枪', '自制枪', '刺杀',
  'terrorist attack', 'build a bomb', 'pipe bomb', 'buy a gun illegally',
  // 毒品与违禁药物 / drugs
  '冰毒', '海洛因', '摇头丸', '制毒', '贩毒',
  'methamphetamine', 'heroin', 'cook meth', 'sell drugs',
  // 色情与未成年人 / sexual content and minors
  '色情交易', '儿童色情', '未成年性',
  'child pornography', 'underage sex', 'sexual services',
  // 赌博与诈骗 / gambling and fraud
  '网络赌博', '开设赌场', '洗钱', '电信诈骗', '杀猪盘',
  'money laundering', 'online casino', 'phishing scheme',
  // 违法入侵与破坏 / intrusions and sabotage
  '入侵系统', '窃取密码', '勒索软件', '撞库',
  'ransomware', 'steal passwords', 'hack into',
  // 国家安全与颠覆 / state security and subversion
  '颠覆国家', '分裂国家', '煽动颠覆',
  'overthrow the government', 'subvert the state',
  // 自伤 / self-harm
  '自杀方法', '怎么自杀',
  'how to kill myself', 'suicide method',
];

/** One matched rule and where it matched. */
export interface SensitiveHit {
  /** The rule that matched: a literal word or the user's pattern source. */
  rule: string;
  /** Match offset inside the **original** text. */
  index: number;
  /** End offset (exclusive) inside the original text. */
  end: number;
}

/** One refused rule and why. */
export interface RejectedRule {
  rule: string;
  reason: string;
}

/** A compiled scanner. */
export interface SensitiveScanner {
  /** Scan text and return every hit, in match order. */
  scan(text: string): SensitiveHit[];
  /** Replace every matched passage with the placeholder. */
  redact(text: string): string;
  /** Number of active rules, for diagnostics. */
  readonly ruleCount: number;
  /** Rules the compiler refused, with the reason. */
  readonly rejected: readonly RejectedRule[];
  /** Rules disabled at run time for exceeding the time budget. */
  readonly timedOut: readonly string[];
}

/** The empty scanner, used when screening is disabled. */
export const NULL_SCANNER: SensitiveScanner = {
  scan: () => [],
  redact: (text) => text,
  ruleCount: 0,
  rejected: [],
  timedOut: [],
};

/** A folded string plus, per folded index, the original span that produced it. */
interface FoldedText {
  folded: string;
  /** `[start, end)` in the original text for each folded code unit. */
  spans: [number, number][];
}

/**
 * Fold text to NFKC while recording where each output code unit came from.
 *
 * Folding per code point rather than over the whole string is what keeps the map
 * exact: whole-string NFKC can compose across code points and change length in
 * ways no index map can follow. Per-code-point folding still catches the
 * look-alike spellings that matter here.
 * @param text - the original text.
 * @returns the folded text and its origin map.
 */
export function foldForScan(text: string): FoldedText {
  let folded = '';
  const spans: [number, number][] = [];
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index) ?? 0;
    const character = String.fromCodePoint(codePoint);
    const width = character.length;
    const replacement = character.normalize('NFKC');
    for (let unit = 0; unit < replacement.length; unit += 1) {
      spans.push([index, index + width]);
    }
    folded += replacement;
    index += width;
  }
  return { folded, spans };
}

/** The verdict for one candidate pattern. */
export interface PatternVerdict {
  ok: boolean;
  /** Why it was refused, in operator-facing Chinese. */
  reason?: string;
}

/** Constructs that can match zero characters. */
const ZERO_WIDTH_TOKEN = /\\[bB]|\(\?(?:=|!|<=|<!)/;

/** Backreferences: bounded input, but they amplify backtracking. */
const BACKREFERENCE_TOKEN = /\\[1-9]/;

/**
 * A group that contains a quantifier and is itself quantified — the shape that
 * turns a linear match into exponential backtracking (`(a+)+b`, `(?:a*)*`).
 */
const NESTED_QUANTIFIER = /\([^()]*[+*}][^()]*\)\s*(?:[+*}?]|\{\d+,?\d*\})/;

/** Samples used to prove a pattern cannot match zero-width in practice. */
const ZERO_WIDTH_SAMPLES: readonly string[] = ['', 'a', 'a b', 'abc def', '中文 测试', '!!!', '  '];

/**
 * Decide whether a user-supplied pattern is safe to execute.
 *
 * The check is intentionally conservative: a refused rule is reported to the
 * operator with a reason, never silently dropped.
 * @param source - the pattern body (without a `(?i)` prefix).
 * @returns whether the pattern may be compiled into the scanner.
 */
export function analyzePattern(source: string): PatternVerdict {
  if (source.length === 0) return { ok: false, reason: '空正则' };
  if (source.length > MAX_PATTERN_LENGTH) {
    return { ok: false, reason: `超过 ${MAX_PATTERN_LENGTH} 字符` };
  }
  if (ZERO_WIDTH_TOKEN.test(source)) {
    return { ok: false, reason: '包含零宽断言（\\b / \\B / 前瞻 / 后顾），会匹配到空片段' };
  }
  if (BACKREFERENCE_TOKEN.test(source)) {
    return { ok: false, reason: '包含反向引用，可能触发灾难性回溯' };
  }
  if (NESTED_QUANTIFIER.test(source)) {
    return { ok: false, reason: '包含嵌套量词（如 (a+)+），可能触发灾难性回溯' };
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, 'u');
  } catch (error) {
    return { ok: false, reason: `不是合法正则：${(error as Error).message}` };
  }
  // Prove the claim with real input: a pattern can avoid matching "" and still
  // match zero-width somewhere (`\b` used to be exactly that case).
  for (const sample of ZERO_WIDTH_SAMPLES) {
    pattern.lastIndex = 0;
    const match = pattern.exec(sample);
    if (match !== null && match[0].length === 0) {
      return { ok: false, reason: '会匹配到空片段（零宽匹配）' };
    }
  }
  return { ok: true };
}

/**
 * Compile a screening policy into a scanner.
 * @param config - the stored policy.
 * @returns a scanner; refused patterns are listed in `rejected` and skipped.
 */
export function compileScanner(config: SensitiveConfig): SensitiveScanner {
  const rules: { label: string; pattern: RegExp; isPattern: boolean }[] = [];
  /** Everything refused, before the display cap is applied. */
  const refusals: RejectedRule[] = [];
  const timedOut = new Set<string>();
  const words = [
    ...(config.builtin ? DEFAULT_SENSITIVE_WORDS : []),
    ...config.words,
  ];
  // Words were unbounded: a pasted list of thousands was compiled into as many
  // RegExp objects, and every refusal was echoed back over the wire.
  const accepted = words.slice(0, MAX_WORDS);
  if (words.length > MAX_WORDS) {
    refusals.push({
      rule: `（还有 ${words.length - MAX_WORDS} 个词未生效）`,
      reason: `超过 ${MAX_WORDS} 条上限`,
    });
  }
  for (const word of accepted) {
    const trimmed = word.trim();
    if (trimmed.length === 0) continue;
    // The rule text is folded as well as the scanned text, so a list may be
    // written in either spelling and still catch both.
    const folded = trimmed.normalize('NFKC');
    rules.push({ label: trimmed, pattern: new RegExp(escapeRegExp(folded), 'giu'), isPattern: false });
  }
  const acceptedPatterns = config.patterns.slice(0, MAX_PATTERNS);
  if (config.patterns.length > MAX_PATTERNS) {
    refusals.push({
      rule: `（还有 ${config.patterns.length - MAX_PATTERNS} 条正则未生效）`,
      reason: `超过 ${MAX_PATTERNS} 条上限`,
    });
  }
  for (const source of acceptedPatterns) {
    const trimmed = source.trim();
    if (trimmed.length === 0) continue;
    // `(?i)` is not JavaScript syntax, but it is the first thing a user coming
    // from another regex flavour writes, and silently rejecting the rule would
    // leave them believing it is active. Accept it and force the flag.
    const inlineInsensitive = /^\(\?i\)/.test(trimmed);
    const body = inlineInsensitive ? trimmed.slice(4).trim() : trimmed;
    const verdict = analyzePattern(body);
    if (!verdict.ok) {
      refusals.push({ rule: trimmed, reason: verdict.reason ?? '不可用' });
      continue;
    }
    try {
      rules.push({
        label: trimmed,
        pattern: new RegExp(body, inlineInsensitive ? 'giu' : 'gu'),
        isPattern: true,
      });
    } catch (error) {
      refusals.push({ rule: trimmed, reason: `编译失败：${(error as Error).message}` });
    }
  }
  // Cap what is echoed back: thousands of refusals would travel over the wire and
  // drown the one line the operator needs to read.
  const rejected = refusals.length > MAX_REJECTED_REPORTED
    ? [...refusals.slice(0, MAX_REJECTED_REPORTED), {
      rule: `（另有 ${refusals.length - MAX_REJECTED_REPORTED} 条未列出）`,
      reason: '为免刷屏已折叠',
    }]
    : refusals;
  if (rules.length === 0) return { ...NULL_SCANNER, rejected, timedOut: [] };

  /** Scan without depending on `this`, so the methods can be destructured. */
  const scan = (text: string): SensitiveHit[] => {
    if (text.length === 0) return [];
    const { folded, spans } = foldForScan(text);
    const hits: SensitiveHit[] = [];
    const startedAt = Date.now();
    for (const [index, rule] of rules.entries()) {
      if (timedOut.has(rule.label)) continue;
      if (Date.now() - startedAt > SCAN_TIME_BUDGET_MS) {
        // Budget gone: the remaining rules did not run, and pretending they did
        // would mean quietly screening less than the policy says. Mark them so
        // the caller can report it.
        for (const rest of rules.slice(index)) timedOut.add(rest.label);
        break;
      }
      const ruleStart = Date.now();
      // Literal rules are linear, so they see the whole text; patterns are
      // capped so an unknown shape cannot backtrack over a huge transcript.
      const subject = rule.isPattern && folded.length > MAX_PATTERN_TEXT
        ? folded.slice(0, MAX_PATTERN_TEXT)
        : folded;
      rule.pattern.lastIndex = 0;
      let match = rule.pattern.exec(subject);
      let matches = 0;
      while (match !== null) {
        if (match[0].length === 0) {
          // Defensive: a zero-width match is never a hit. Advance one code unit
          // so the loop terminates, and do not record it.
          rule.pattern.lastIndex = match.index + 1;
          match = rule.pattern.exec(subject);
          continue;
        }
        const startSpan = spans[match.index];
        const endSpan = spans[Math.min(folded.length, match.index + match[0].length) - 1];
        if (startSpan !== undefined && endSpan !== undefined) {
          hits.push({ rule: rule.label, index: startSpan[0], end: endSpan[1] });
        }
        rule.pattern.lastIndex = match.index + match[0].length;
        matches += 1;
        if (matches > MAX_HITS_PER_RULE) break;
        match = rule.pattern.exec(subject);
      }
      if (Date.now() - ruleStart > SCAN_TIME_BUDGET_MS) timedOut.add(rule.label);
    }
    hits.sort((a, b) => a.index - b.index || a.end - b.end);
    return hits;
  };

  return {
    ruleCount: rules.length,
    rejected,
    get timedOut() {
      return [...timedOut];
    },
    scan,
    redact: (text: string) => spliceRedactions(text, scan(text)),
  };
}

/**
 * Replace every hit span with the placeholder, merging overlaps.
 * Zero-width spans are dropped so an accidental empty match cannot paint the
 * placeholder through the whole text.
 * @param text - the original text.
 * @param hits - hit spans in the original coordinates.
 * @returns the redacted text.
 */
export function spliceRedactions(text: string, hits: readonly SensitiveHit[]): string {
  const meaningful = hits.filter((hit) => hit.end > hit.index);
  if (meaningful.length === 0) return text;
  const merged: [number, number][] = [];
  for (const hit of [...meaningful].sort((a, b) => a.index - b.index)) {
    const last = merged[merged.length - 1];
    if (last !== undefined && hit.index <= last[1]) {
      last[1] = Math.max(last[1], hit.end);
      continue;
    }
    merged.push([hit.index, hit.end]);
  }
  let output = '';
  let cursor = 0;
  for (const [start, end] of merged) {
    output += text.slice(cursor, start) + FILTERED_PLACEHOLDER;
    cursor = end;
  }
  return output + text.slice(cursor);
}

/** Escape a literal so it can be embedded in a regular expression. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Screen one passage.
 * @param scanner - the compiled scanner.
 * @param text - text to screen.
 * @returns the text to keep, the hits, and whether anything was replaced.
 */
export function screen(
  scanner: SensitiveScanner,
  text: string,
): { text: string; hits: SensitiveHit[]; redacted: boolean } {
  const hits = scanner.scan(text);
  if (hits.length === 0) return { text, hits, redacted: false };
  return { text: spliceRedactions(text, hits), hits, redacted: true };
}
