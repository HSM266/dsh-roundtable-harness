/**
 * Verification entry: everything `scripts/verify.mjs` exercises, bundled with
 * the Harness packages aliased away so it runs offline.
 *
 * Covered:
 *   1. configuration repair (clamping, dropping unusable participants, aliases, weights)
 *   2. `JUDGE_MODEL` / `JUDGE_PERSONA` parsing and precedence
 *   3. sensitive screening: redaction, NFKC folding, empty-matching-rule refusal
 *   4. cost attribution: exact match only, no day-total fallback
 *   5. cost-effectiveness ranking: unmeasured participants are excluded, not scored
 *   6. judge payload extraction from messy model output
 *   7. persona-file containment (no absolute path, no escape)
 *   8. Markdown escaping of model output
 *   9. a full 2-provider × 2-round discussion against mock providers
 *  10. a 429 mid-discussion: immediate stop, anomaly, partial report
 *  11. terminating a run: abort signal honoured, referee skipped, transcript still written
 *  12. continuing a finished run: rounds and transcript carry over
 *  13. docx generation validated by inflating `word/document.xml` out of the zip
 *  14. avatar hardening (SSRF ranges, magic-byte type sniffing)
 *  15. client Remote envelope unwrapping
 *  16. plugin wiring against a mock Cordis context
 *
 * @module dsh-roundtable-harness/test/verify-entry
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import {
  applyEnvironmentOverrides,
  defaultConfig,
  normalizeConfig,
  parseJudgeModel,
  isSafePersonaFile,
  resolvePersona,
  resolvePersonaDir,
  resolvePersonaTarget,
  type RoundtableConfig,
} from '../src/config.js';
import { compileScanner, screen, foldForScan, analyzePattern, MAX_REJECTED_REPORTED } from '../src/sensitive.js';
import { computeValueScores, parseJudgePayload, buildJudgePrompt } from '../src/judge.js';
import { RoundtableRun, participantCostsOf, type RunState, type Speech } from '../src/roundtable.js';
import { attributeTurnCost, type CostSnapshot } from '../src/cost.js';
import { buildDocxReport, isPublicAddress, parseIPv6, resolveAvatarPath, sniffImageType } from '../src/docx-export.js';
import { escapeMarkdown } from '../src/report.js';
import { apply as applyPlugin, Config as PluginConfig, name as pluginName } from '../src/index.js';
import { bindRemote, unwrap, finalizeDraft, parseNumericInput } from '../src/client.js';
import { DEFAULT_SCORE_WEIGHTS, SCORE_DIMENSIONS, weightedTotal } from '../src/dimensions.js';
import { remoteMethodsOf } from './stubs/dsh-typert-protocol.js';

/** One named check result. */
export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** What the mock provider does for one call. */
type MockBehaviour =
  | { kind: 'text'; text: string; outputTokens?: number }
  | { kind: 'http'; status: number; message?: string }
  | { kind: 'empty' };

/** Build an LLM stand-in driven by a per-call script. */
export function makeMockLlm(
  behaviour: (call: { provider: string; model: string; index: number; system?: string }) => MockBehaviour,
  onCall?: (call: { provider: string; model: string; index: number; system?: string }) => void,
) {
  let index = 0;
  return {
    calls: [] as { provider: string; model: string; system?: string; prompt: string }[],
    listProviders() {
      return [{ id: 'mock-alpha', name: 'Mock Alpha' }, { id: 'mock-beta', name: 'Mock Beta' }];
    },
    async listModels(provider: string) {
      return provider === 'mock-alpha'
        ? [{ provider, id: 'alpha-1', name: 'Alpha One' }]
        : [{ provider, id: 'beta-1', name: 'Beta One' }];
    },
    async resolveModelInfo(provider: string, model: string) {
      return { provider, id: model, name: model };
    },
    stream(options: { provider: string; model: string; system?: string; messages: { content: { text?: string }[] }[] }) {
      const prompt = options.messages
        .flatMap((message) => message.content)
        .map((block) => block.text ?? '')
        .join('\n');
      const call = { provider: options.provider, model: options.model, index: index++, system: options.system };
      this.calls.push({ provider: call.provider, model: call.model, system: options.system, prompt });
      onCall?.(call);
      const plan = behaviour(call);
      return (async function* generate() {
        if (plan.kind === 'http') {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { message: plan.message ?? `HTTP ${plan.status}`, code: 'PROVIDER_HTTP_ERROR', status: plan.status },
            },
          };
          return;
        }
        const text = plan.kind === 'empty' ? '' : plan.text;
        yield { type: 'block-start', index: 0, blockType: 'text' };
        if (text.length > 0) yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'usage', usage: { inputTokens: 500, outputTokens: plan.kind === 'empty' ? 0 : (plan.outputTokens ?? 120) } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

/** Configuration used by the engine scenarios. */
function scenarioConfig(outputDir: string): RoundtableConfig {
  const config = defaultConfig();
  config.topic = 'AI 该不该有情绪';
  config.maxRounds = 2;
  config.outputDir = outputDir;
  config.maxTokensPerTurn = 256;
  config.requestTimeoutMs = 5_000;
  config.tokenBudget = 1_000_000;
  config.judge.enabled = false;
  config.participants = [
    { id: 'alpha', name: '阿尔法', provider: 'mock-alpha', model: 'alpha-1', persona: '你是尖刻的逻辑派。' },
    { id: 'beta', name: '贝塔', provider: 'mock-beta', model: 'beta-1', persona: '你是暴躁的直觉派。' },
  ];
  return config;
}

/** A ledger snapshot literal. */
function snapshot(byKey: Record<string, number>, available = true): CostSnapshot {
  return { available, path: '/tmp/ledger.json', day: '2026-01-01', totalCost: 0, byKey };
}

/** Read one entry out of a zip archive using only node:zlib. */
function readZipEntry(buffer: Buffer, name: string): string | undefined {
  const signature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  let offset = 0;
  while (offset < buffer.length - 4) {
    const at = buffer.indexOf(signature, offset);
    if (at < 0) break;
    const method = buffer.readUInt16LE(at + 8);
    const compressedSize = buffer.readUInt32LE(at + 18);
    const nameLength = buffer.readUInt16LE(at + 26);
    const extraLength = buffer.readUInt16LE(at + 28);
    const entryName = buffer.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const dataStart = at + 30 + nameLength + extraLength;
    if (entryName === name) {
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      return method === 0 ? data.toString('utf8') : inflateRawSync(data).toString('utf8');
    }
    offset = dataStart + compressedSize;
  }
  return undefined;
}

/** Count live timer handles, to prove a finished run leaves none behind. */
function activeTimers(): number {
  const resources = (process as unknown as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo;
  if (typeof resources !== 'function') return 0;
  return resources().filter((entry) => entry === 'Timeout').length;
}

/**
 * Run every check.
 * @returns one result per check, in order.
 */
export async function runAllChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const record = (name: string, ok: boolean, detail: string): void => {
    results.push({ name, ok, detail });
  };

  // 1 — configuration repair.
  const repaired = normalizeConfig({
    maxRounds: 99,
    keepRecentRounds: -3,
    sensitiveThreshold: 0,
    participants: [
      { id: 'A B', name: 'A B', provider: 'p', model: 'm', persona: 'x', avatar: ' a.png ' },
      { id: 'A B', name: '重名选手', provider: 'p', model: 'm2', persona: 'y' },
      { name: '没有模型', provider: 'p' },
      'garbage',
    ],
    providerAliases: { qwen: 'dashscope', '': 'x' },
    scoreWeights: { attack: 3, logic: -1, fun: 'lots' },
  });
  const weightsOk = repaired.scoreWeights.attack === 3
    && repaired.scoreWeights.logic === DEFAULT_SCORE_WEIGHTS.logic
    && repaired.scoreWeights.fun === DEFAULT_SCORE_WEIGHTS.fun
    && repaired.scoreWeights.depth === DEFAULT_SCORE_WEIGHTS.depth;
  record(
    '配置修复：轮数/阈值收敛、非法选手丢弃、重名 id 自动改名、别名清理、权重校验',
    repaired.maxRounds === 20 && repaired.keepRecentRounds === 0 && repaired.sensitiveThreshold === 1
      && repaired.participants.length === 2
      && repaired.participants[0]!.id === 'a-b'
      && repaired.participants[0]!.avatar === 'a.png'
      && repaired.participants[1]!.id === 'a-b-2'
      && repaired.participants[1]!.name === '重名选手'
      && Object.keys(repaired.providerAliases).length === 1
      && weightsOk,
    `maxRounds=${repaired.maxRounds} keep=${repaired.keepRecentRounds} threshold=${repaired.sensitiveThreshold} ids=${repaired.participants.map((entry) => entry.id).join(',')} weights=${JSON.stringify(repaired.scoreWeights)}`,
  );

  // 1b — weights feed the composite.
  const singleWeight = weightedTotal(
    { attack: 100, logic: 0, persona: 0, fun: 0, strategy: 0, depth: 0 },
    { attack: 1, logic: 0, persona: 0, fun: 0, strategy: 0, depth: 0 },
  );
  const equalComposite = weightedTotal(
    { attack: 60, logic: 60, persona: 60, fun: 60, strategy: 60, depth: 60 },
    DEFAULT_SCORE_WEIGHTS,
  );
  record(
    '六维加权：单项权重生效、等比权重取均值',
    singleWeight === 100 && equalComposite === 60,
    `single=${singleWeight} equal=${equalComposite}`,
  );

  // 2 — JUDGE_MODEL / JUDGE_PERSONA.
  const parsedSlash = parseJudgeModel('dashscope/qwen3-max');
  const parsedColon = parseJudgeModel('dashscope:qwen3-max');
  const parsedBare = parseJudgeModel('qwen3-max');
  const overridden = applyEnvironmentOverrides(defaultConfig(), {
    judgeModel: 'dashscope/qwen3-max',
    judgePersona: '你是裁判',
    outputDir: '/tmp/out',
  });
  record(
    'JUDGE_MODEL 解析与环境覆盖',
    parsedSlash.provider === 'dashscope' && parsedSlash.model === 'qwen3-max'
      && parsedColon.provider === 'dashscope' && parsedColon.model === 'qwen3-max'
      && parsedBare.provider === '' && parsedBare.model === 'qwen3-max'
      && overridden.judge.provider === 'dashscope' && overridden.judge.model === 'qwen3-max'
      && overridden.judge.persona === '你是裁判' && overridden.outputDir === '/tmp/out',
    `${JSON.stringify(parsedSlash)} / ${JSON.stringify(parsedColon)} / ${JSON.stringify(parsedBare)}`,
  );

  // 3 — sensitive screening: redaction, folding, zero-width and ReDoS refusal.
  const scanner = compileScanner({
    builtin: true,
    words: ['内幕消息', 'ｓｅｘ'],
    patterns: [
      '(?i)secret\\s+plan',
      '未闭合的[正则',
      'a*',
      '(?i)',
      '\\s*',
      '\\bword\\b',
      'foo(?=bar)',
      '(?<=foo)bar',
      '(a+)+b',
      '(?:a*)*',
      '(\\w+)\\1',
    ],
  });
  const screened = screen(scanner, '这属于内幕消息，还有 a Secret Plan 在里面。');
  const folded = screen(scanner, '这里有 sex 字样。');
  const foldedRule = screen(scanner, '这里有 ｓｅｘ 字样。');
  const clean = screen(scanner, '今天天气不错，word 也只是普通词。');
  const rejectedSet = scanner.rejected.map((entry) => entry.rule).sort().join('|');
  record(
    '敏感过滤：替换、NFKC 折叠（词表与正文双向）、零宽与嵌套量词被拒',
    screened.redacted === true && screened.hits.length === 2
      && screened.text.includes('[内容已过滤]') && !screened.text.includes('内幕消息')
      // A zero-width rule must not spray the clean text or trip the threshold.
      && clean.redacted === false && clean.hits.length === 0 && clean.text.includes('word')
      && folded.redacted === true && folded.text.includes('[内容已过滤]')
      && foldedRule.redacted === true && foldedRule.text.includes('[内容已过滤]')
      && scanner.rejected.length === 10,
    `hits=${screened.hits.map((hit) => hit.rule).join('|')} rejected(${scanner.rejected.length})=${rejectedSet} clean=${clean.text}`,
  );

  // 3b — each refusal carries an operator-facing, specific reason.
  const reasonOf = (rule: string): string =>
    scanner.rejected.find((entry) => entry.rule === rule)?.reason ?? '';
  record(
    '敏感过滤：\\b / 前瞻 / 后顾 / 嵌套量词 / 反向引用各有明确拒绝理由',
    reasonOf('\\bword\\b').includes('零宽')
      && reasonOf('foo(?=bar)').includes('零宽')
      && reasonOf('(?<=foo)bar').includes('零宽')
      && reasonOf('(a+)+b').includes('嵌套量词')
      && reasonOf('(?:a*)*').includes('嵌套量词')
      && reasonOf('(\\w+)\\1').includes('反向引用')
      && analyzePattern('普通错误词').ok
      && analyzePattern('\\b').ok === false,
    `zeroWidth=${reasonOf('\\bword\\b')} nested=${reasonOf('(a+)+b')} backref=${reasonOf('(\\w+)\\1')}`,
  );

  // 3c — a pathological pattern is refused before it can run.
  const redosStart = Date.now();
  const redosScanner = compileScanner({ builtin: false, words: [], patterns: ['(a+)+b'] });
  const redosElapsed = Date.now() - redosStart;
  const redosHits = redosScanner.scan(`${'a'.repeat(5_000)}!`);
  record(
    'ReDoS：灾难性回溯正则被静态拒绝，宿主不被卡死',
    redosElapsed < 100 && redosScanner.ruleCount === 0 && redosHits.length === 0
      && redosScanner.rejected.length === 1,
    `elapsed=${redosElapsed}ms rules=${redosScanner.ruleCount} rejected=${redosScanner.rejected.length}`,
  );

  // 3b — the folding map keeps original offsets.
  const foldMap = foldForScan('ａb');
  const offsetsOk = foldMap.spans.length === 2
    && foldMap.spans[0]![0] === 0 && foldMap.spans[0]![1] === 1
    && foldMap.spans[1]![0] === 1 && foldMap.spans[1]![1] === 2;
  record(
    'Unicode 折叠保留原始偏移（按码点映射，不重写正文）',
    offsetsOk,
    JSON.stringify(foldMap.spans),
  );

  // 4 — cost attribution: exact match only, no day-total fallback.
  const matched = attributeTurnCost(
    snapshot({ 'p:a-1': 1, 'p:b-1': 5 }),
    snapshot({ 'p:a-1': 1.25, 'p:b-1': 5.5 }),
    'a-1',
  );
  const mixed = attributeTurnCost(
    snapshot({ 'p:a-1': 1 }),
    snapshot({ 'p:a-1': 1.4, 'wrapper:x': 0.2 }),
    'a-1',
  );
  const noLedger = attributeTurnCost(snapshot({}, false), snapshot({}), 'a-1');
  record(
    '花费归因：只认精确模型键，匹配不到就记 0 并标注',
    matched.cost === 0.25 && matched.status === 'matched'
      && Math.abs(mixed.cost - 0.4) < 1e-9 && mixed.status === 'matched'
        && mixed.unattributedKeys.join() === 'wrapper:x'
      && noLedger.cost === 0 && noLedger.status === 'no-ledger',
    `matched=${matched.cost}/${matched.status} mixed=${mixed.cost}/${mixed.status}/${mixed.unattributedKeys.join('|')} noLedger=${noLedger.status}`,
  );

  // 4b — a pure mismatch reports nothing attributed, never the day total.
  const pureMismatch = attributeTurnCost(
    snapshot({ 'p:a-1': 1 }),
    snapshot({ 'p:a-1': 1, 'wrapper:x': 0.9 }),
    'a-1',
  );
  record(
    '花费归因：有增量但匹配不到模型 → 归因失败，不做当日总额兜底',
    pureMismatch.cost === 0 && pureMismatch.status === 'unmatched'
      && pureMismatch.unattributedKeys.join() === 'wrapper:x',
    `cost=${pureMismatch.cost} status=${pureMismatch.status} keys=${pureMismatch.unattributedKeys.join('|')}`,
  );

  // 4c — a readable ledger with no movement is also "no data", not zero cost.
  const idleLedger = attributeTurnCost(snapshot({ 'p:a-1': 1 }), snapshot({ 'p:a-1': 1 }), 'a-1');
  record(
    '花费归因：账本可读但无增量 → 记为无账本口径，不当作 0 元',
    idleLedger.cost === 0 && idleLedger.status === 'no-ledger',
    `cost=${idleLedger.cost} status=${idleLedger.status}`,
  );

  // 5 — cost-effectiveness ranking excludes the unmeasured.
  const values = computeValueScores([
    { participantId: 'cheap-strong', total: 90, cost: 0.001, measured: true },
    { participantId: 'expensive-strong', total: 95, cost: 0.02, measured: true },
    { participantId: 'no-data', total: 99, cost: 0, measured: false },
  ]);
  record(
    '性价比：只对已归因者排名，无数据者不参与（不再被当成满分）',
    values.get('cheap-strong')?.value === 100 && values.get('cheap-strong')?.rank === 1
      && values.get('expensive-strong')?.rank === 2
      && values.has('no-data') === false,
    JSON.stringify(Object.fromEntries([...values])),
  );

  // 5b — participants with no measured spend are listed with a reason.
  const speechesForCost = [
    { participantId: 'alpha', cost: 0.5, costStatus: 'measured', unattributedKeys: [] },
    { participantId: 'beta', cost: 0, costStatus: 'unmeasured', unattributedKeys: ['wrapper:x'] },
  ] as unknown as Speech[];
  const costs = participantCostsOf(speechesForCost, [
    { id: 'alpha', name: 'A', provider: 'p', model: 'a', persona: '' },
    { id: 'beta', name: 'B', provider: 'p', model: 'b', persona: '' },
    { id: 'gamma', name: 'C', provider: 'p', model: 'c', persona: '' },
  ]);
  record(
    '口径不可用：逐人标注原因，未测量者不计入总额',
    costs.alpha?.measured === true && costs.alpha?.cost === 0.5
      && costs.beta?.measured === false && typeof costs.beta?.reason === 'string'
      && costs.gamma?.measured === false,
    JSON.stringify(costs),
  );

  // 6 — judge payload extraction.
  const fenced = parseJudgePayload(
    '好的，结果如下：\n```json\n{"scores":[{"id":"a","attack":80,"logic":70,"persona":60,"fun":50,"strategy":40,"depth":30,"comment":"还行"}],"summary":"总结"}\n```',
  );
  const loose = parseJudgePayload('{"scores":[{"id":"b","attack":"61","logic":50,"persona":50,"fun":50,"strategy":50,"depth":50}],"summary":""}');
  record(
    '裁判 JSON 提取（带围栏 / 缺字段 / 六维）',
    fenced?.scores?.[0]?.attack === 80 && fenced?.scores?.[0]?.depth === 30 && fenced?.summary === '总结'
      && loose?.scores?.[0]?.id === 'b',
    `fenced=${JSON.stringify(fenced)} loose=${JSON.stringify(loose)}`,
  );

  // 7 — persona-file containment.
  const safeRelative = isSafePersonaFile('alice.md');
  const absoluteRejected = isSafePersonaFile('C:\\Windows\\System32\\drivers\\etc\\hosts');
  const posixRejected = isSafePersonaFile('/etc/passwd');
  const escapeRejected = isSafePersonaFile('../../secrets.md');
  const target = resolvePersonaTarget({
    id: 'alice', name: 'A', provider: 'p', model: 'm', persona: 'x',
    personaFile: 'C:\\Windows\\win.ini',
  });
  const personaDir = resolvePersonaDir();
  record(
    '人格文件限制：只接受 persona 目录内的相对路径',
    safeRelative && !absoluteRejected && !posixRejected && !escapeRejected
      && target.startsWith(personaDir)
      && target.endsWith('alice.md')
      && !target.toLowerCase().includes('windows'),
    `safe=${safeRelative} abs=${absoluteRejected} posix=${posixRejected} escape=${escapeRejected} target=${target}`,
  );

  // 8 — Markdown escaping of model output.
  const hostile = '# 标题\n| 注入 | 表格 |\n<script>alert(1)</script>\n- 列表\n[链接](http://x) ```js`';
  const escaped = escapeMarkdown(hostile);
  record(
    '战报转义：HTML 实体化 + Markdown 结构字符失效',
    escaped.includes('&lt;script&gt;') && !escaped.includes('<script>')
      && escaped.includes('\\#') && escaped.includes('\\|')
      && escaped.includes('\\`\\`\\`') && escaped.includes('\\[链接\\]')
      && escaped.includes('\\- 列表'),
    escaped.replace(/\n/g, '⏎'),
  );

  // 9 — a full mock discussion.
  const dirRoot = mkdtempSync(join(tmpdir(), 'roundtable-verify-'));
  try {
    const config = scenarioConfig(dirRoot);
    const llm = makeMockLlm((call) => ({
      kind: 'text',
      text: `【${call.provider}】第 ${call.index + 1} 次发言：我反对。`,
      outputTokens: 40 + call.index,
    }));
    const run = new RoundtableRun({ llm: llm as never, config, log: () => {} }, config.topic);
    const timersBefore = activeTimers();
    const state: RunState = await run.execute();
    const timersAfter = activeTimers();
    const ok = state.rounds === 2 && state.speeches.length === 4 && state.status === 'done'
      && llm.calls.length === 4
      && state.reportPath !== undefined && existsSync(state.reportPath)
      && readFileSync(state.reportPath, 'utf8').includes('阿尔法')
      && readFileSync(state.reportPath, 'utf8').includes('贝塔')
      && state.costSource === 'unavailable'
      && state.speeches.every((speech) => speech.costStatus !== 'measured')
      && timersAfter <= timersBefore;
    record(
      '2 个 Provider × 2 轮：4 条发言、战报落盘、无残留定时器、无账本时口径不可用',
      ok,
      `rounds=${state.rounds} speeches=${state.speeches.length} status=${state.status} costSource=${state.costSource} report=${state.reportPath} timers=${timersBefore}->${timersAfter}`,
    );

    // 9b — context sharing and per-speaker persona.
    const secondPrompt = llm.calls[1]?.prompt ?? '';
    const thirdPrompt = llm.calls[2]?.prompt ?? '';
    record(
      '上下文共享：后发言者能看到前面全部发言',
      secondPrompt.includes('第 1 次发言') && thirdPrompt.includes('第 1 次发言') && thirdPrompt.includes('第 2 次发言')
        && (llm.calls[1]?.system ?? '').includes('暴躁的直觉派') === true,
      `speaker2 system=${(llm.calls[1]?.system ?? '').slice(0, 20)}… promptHasSpeaker1=${secondPrompt.includes('第 1 次发言')}`,
    );

    // 10 — 429 aborts the whole discussion.
    const failConfig = scenarioConfig(dirRoot);
    failConfig.maxRounds = 3;
    let callIndex = 0;
    const failing = makeMockLlm(() => {
      callIndex += 1;
      return callIndex === 3
        ? { kind: 'http', status: 429, message: 'Too Many Requests' }
        : { kind: 'text', text: `第 ${callIndex} 次发言`, outputTokens: 30 };
    });
    const stopped = await new RoundtableRun({ llm: failing as never, config: failConfig, log: () => {} }, failConfig.topic).execute();
    record(
      '429 致命错误：立即终止、记录异常、保留已完成部分',
      stopped.stopReason === 'fatal-error' && stopped.speeches.length === 3
        && stopped.speeches[2]!.status === 'error'
        && stopped.anomalies.some((anomaly) => anomaly.kind === '致命错误')
        && stopped.reportPath !== undefined
        && readFileSync(stopped.reportPath, 'utf8').includes('429'),
      `stopReason=${stopped.stopReason} speeches=${stopped.speeches.length} anomalies=${stopped.anomalies.length}`,
    );

    // 11 — user stop: real abort, referee skipped, transcript still written.
    const stopConfig = scenarioConfig(dirRoot);
    stopConfig.maxRounds = 4;
    stopConfig.judge.enabled = true;
    stopConfig.judge.provider = 'mock-alpha';
    stopConfig.judge.model = 'alpha-1';
    let handle: RoundtableRun | undefined;
    const stopping = makeMockLlm(
      (call) => ({ kind: 'text', text: `第 ${call.index + 1} 次发言`, outputTokens: 20 }),
      (call) => { if (call.index === 1) handle?.stop('user-stop'); },
    );
    handle = new RoundtableRun({ llm: stopping as never, config: stopConfig, log: () => {} }, stopConfig.topic);
    const stoppedState = await handle.execute();
    const judgeCalls = stopping.calls.filter((call) => (call.system ?? '').includes('裁判'));
    record(
      '终止讨论：AbortSignal 生效、跳过裁判、仍写战报',
      stoppedState.status === 'stopped' && stoppedState.stopReason === 'user-stop'
        && stoppedState.judge === undefined
        && stoppedState.speeches.length >= 2 && stoppedState.speeches.length <= 3
        && stoppedState.reportPath !== undefined
        && judgeCalls.length === 0,
      `status=${stoppedState.status} reason=${stoppedState.stopReason} speeches=${stoppedState.speeches.length} judge=${stoppedState.judge === undefined ? 'skipped' : 'ran'} report=${stoppedState.reportPath}`,
    );

    // 12 — continuing a finished run.
    const baseConfig = scenarioConfig(dirRoot);
    const baseLlm = makeMockLlm((call) => ({ kind: 'text', text: `第一场第 ${call.index + 1} 次`, outputTokens: 30 }));
    const base = await new RoundtableRun({ llm: baseLlm as never, config: baseConfig, log: () => {} }, baseConfig.topic).execute();
    const contLlm = makeMockLlm((call) => ({ kind: 'text', text: `续场第 ${call.index + 1} 次`, outputTokens: 30 }));
    const continuation = await new RoundtableRun(
      { llm: contLlm as never, config: baseConfig, log: () => {} },
      base.topic,
      { previousId: base.id, completedRounds: base.rounds, speeches: base.speeches, summary: base.summary },
    ).execute();
    const continuedPrompt = contLlm.calls[0]?.prompt ?? '';
    record(
      '续前讨论：轮次接续、上下文带入、报告标注来源',
      continuation.rounds === 4 && continuation.plannedRounds === 4
        && continuation.speeches.length === 8
        && continuation.continuedFrom === base.id
        && continuation.speeches[0]!.round === 1
        && continuation.speeches[4]!.round === 3
        && continuedPrompt.includes('第一场第 1 次')
        && continuation.reportPath !== undefined
        && readFileSync(continuation.reportPath, 'utf8').includes(base.id),
      `rounds=${continuation.rounds}/${continuation.plannedRounds} speeches=${continuation.speeches.length} continuedFrom=${continuation.continuedFrom} carriesTranscript=${continuedPrompt.includes('第一场第 1 次')}`,
    );

    // 13 — docx: generate for real, then inflate document.xml out of the zip.
    const docxPath = await buildDocxReport(stopped, { outputDir: dirRoot, participants: failConfig.participants });
    const bytes = readFileSync(docxPath);
    const isZip = bytes.subarray(0, 4).toString('binary') === 'PK\x03\x04';
    const documentXml = readZipEntry(bytes, 'word/document.xml') ?? '';
    record(
      'docx：真实生成、可解压、含全部发言与选手名',
      isZip && documentXml.includes('阿尔法') && documentXml.includes('贝塔')
        && documentXml.includes('第 1 次发言') && documentXml.includes('异常记录')
        && documentXml.includes('评分榜'),
      `path=${docxPath} bytes=${bytes.length} hasAlpha=${documentXml.includes('阿尔法')} hasBeta=${documentXml.includes('贝塔')}`,
    );

    // 14 — avatar hardening: the full IPv6 surface, from values not prefixes.
    const blockedAddresses = [
      '127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0',
      '::1', '0:0:0:0:0:0:0:1', '[0:0:0:0:0:0:0:1]', '::', '0:0:0:0:0:0:0:0',
      '::ffff:127.0.0.1', '0:0:0:0:0:ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1',
      '::ffff:10.0.0.1', '::ffff:192.168.0.1', '::1%lo0', '[::1]',
      'fe80::1', 'fe80::1%eth0', 'febf::1', 'fc00::1', 'fd12:3456::1', 'fec0::1',
      'ff02::1', '2001:db8::1', '2001::1', '2002:7f00:1::1', '2002:0a00:1::1', '100::1',
      '64:ff9b::7f00:1', '64:ff9b::a00:1',
    ];
    const allowedAddresses = ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '2002:0808:0808::1'];
    const wrongAllow = blockedAddresses.filter((address) => isPublicAddress(address));
    const wrongBlock = allowedAddresses.filter((address) => !isPublicAddress(address));
    // The case the audit named: Node says "this is IPv6" and the old prefix
    // check still let it through.
    const netIsIP6 = isIP('0:0:0:0:0:0:0:1') === 6 && isIP('[0:0:0:0:0:0:0:1]') === 0;
    record(
      '形象图加固：IPv6 全写法按数值判定（回环/私网/链路本地/ULA/组播/映射全拦）',
      wrongAllow.length === 0 && wrongBlock.length === 0 && netIsIP6
        && parseIPv6('0:0:0:0:0:ffff:127.0.0.1')?.join(':') === '0:0:0:0:0:65535:32512:1'
        && sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])) === 'png'
        && sniffImageType(new Uint8Array([0xff, 0xd8, 0xff])) === 'jpg'
        && sniffImageType(new Uint8Array([0x3c, 0x73, 0x76, 0x67])) === undefined,
      `blocked=${blockedAddresses.length} wrongAllow=${wrongAllow.join(',') || '无'} allowed=${allowedAddresses.length} wrongBlock=${wrongBlock.join(',') || '无'} netIsIP6=${netIsIP6} parsed=${parseIPv6('0:0:0:0:0:ffff:127.0.0.1')?.join(':')}`,
    );

    // 14b — a relative avatar path may not walk out of the output directory.
    let traversal = '';
    try {
      traversal = resolveAvatarPath('../escape.png', dirRoot);
    } catch (error) {
      traversal = (error as Error).message;
    }
    record(
      '形象图本地路径：../ 穿越被拒，不读取目录外的文件',
      traversal.includes('超出导出目录'),
      traversal,
    );

    // 14c — "copy as path" quotes and file:// URLs must not break resolution.
    const quoted = resolveAvatarPath(`"${join(dirRoot, 'a.png')}"`, dirRoot);
    const quotedSingle = resolveAvatarPath(`'${join(dirRoot, 'b.png')}'`, dirRoot);
    const asFileUrl = resolveAvatarPath(pathToFileURL(join(dirRoot, 'c.png')).href, dirRoot);
    record(
      '形象图路径：粘贴带引号的路径与 file:// 都能解析（不再拼成相对路径）',
      quoted === resolve(join(dirRoot, 'a.png'))
        && quotedSingle === resolve(join(dirRoot, 'b.png'))
        && asFileUrl === resolve(join(dirRoot, 'c.png')),
      `quoted=${quoted} fileUrl=${asFileUrl}`,
    );

    // 15 — judge replies with ids that match nobody: degraded, not "judged".
    const mismatchConfig = scenarioConfig(dirRoot);
    mismatchConfig.judge.enabled = true;
    mismatchConfig.judge.provider = 'mock-alpha';
    mismatchConfig.judge.model = 'alpha-1';
    let judgeReply = '{"scores":[{"id":"ghost-1","attack":90,"logic":90,"persona":90,"fun":90,"strategy":90,"depth":90}],"summary":"我看错人了"}';
    const isJudgeCall = (call: { system?: string }): boolean => (call.system ?? '').includes('裁判');
    const judgeMock = makeMockLlm((call) => (isJudgeCall(call)
      ? { kind: 'text', text: judgeReply }
      : { kind: 'text', text: '发言', outputTokens: 40 }));
    const mismatchRun = await new RoundtableRun({ llm: judgeMock as never, config: mismatchConfig, log: () => {} }, mismatchConfig.topic).execute();
    const mismatchReport = mismatchRun.reportPath === undefined ? '' : readFileSync(mismatchRun.reportPath, 'utf8');
    record(
      '裁判 id 全不匹配：judged=false + 降级 + 战报写明「裁判不可用」',
      mismatchRun.judge !== undefined
        && mismatchRun.judge.judged === false
        && mismatchRun.judge.degraded === true
        && (mismatchRun.judge.note ?? '').includes('没有任何一个能对上')
        && mismatchReport.includes('裁判不可用，已降级为字数估算')
        && mismatchReport.includes('AI 裁判自动生成')
        && mismatchReport.includes('降级（非模型评分）'),
      `judged=${mismatchRun.judge?.judged} degraded=${mismatchRun.judge?.degraded} note=${mismatchRun.judge?.note} reportHasDisclaimer=${mismatchReport.includes('AI 裁判自动生成')}`,
    );

    // 15b — a correct reply is still accepted as a real judgement.
    judgeReply = '{"scores":[{"id":"alpha","attack":90,"logic":80,"persona":70,"fun":60,"strategy":50,"depth":40,"comment":"a"},{"id":"beta","attack":40,"logic":50,"persona":60,"fun":70,"strategy":80,"depth":90,"comment":"b"}],"summary":"正常"}';
    const goodMock = makeMockLlm((call) => (isJudgeCall(call)
      ? { kind: 'text', text: judgeReply }
      : { kind: 'text', text: '发言', outputTokens: 40 }));
    const goodRun = await new RoundtableRun({ llm: goodMock as never, config: mismatchConfig, log: () => {} }, mismatchConfig.topic).execute();
    record(
      '裁判正常返回：judged=true、degraded=false、六维分取自模型',
      goodRun.judge?.judged === true && goodRun.judge.degraded === false
        && goodRun.judge.scores[0]?.total === 65
        && (goodRun.judge.note ?? '') === '',
      `judged=${goodRun.judge?.judged} degraded=${goodRun.judge?.degraded} top=${goodRun.judge?.scores[0]?.name}:${goodRun.judge?.scores[0]?.total} note=${goodRun.judge?.note}`,
    );

    // 15 — a persona file outside the directory cannot be read or written.
    mkdirSync(personaDir, { recursive: true });
    const outside = join(dirRoot, 'escape.md');
    writeFileSync(outside, 'SHOULD NOT BE READ', 'utf8');
    const escapeTarget = resolvePersonaTarget({
      id: 'mallory', name: 'M', provider: 'p', model: 'm', persona: 'inline', personaFile: outside,
    });
    const resolved = resolvePersona({
      id: 'mallory', name: 'M', provider: 'p', model: 'm', persona: 'inline', personaFile: outside,
    });
    record(
      '人格文件越权读取被拦截（绝对路径回落到 persona 目录内）',
      escapeTarget.startsWith(personaDir) && resolved === 'inline',
      `target=${escapeTarget} resolved=${resolved}`,
    );
  } finally {
    try {
      rmSync(dirRoot, { recursive: true, force: true });
    } catch {
      // A locked temp directory on Windows is not a verification failure.
    }
  }

  return results;
}

/**
 * Settings-page contract checks (the rewrite spec's 七、验收清单).
 *
 * The page cannot be rendered without a DOM, so what is checked is the part that
 * decides behaviour: the pure builder that turns the editing draft into the
 * payload actually saved.
 * @returns one result per check.
 */
export function runSettingsPageChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const record = (name: string, ok: boolean, detail: string): void => {
    results.push({ name, ok, detail });
  };

  const base = (): RoundtableConfig => {
    const config = defaultConfig();
    config.participants = [];
    config.sensitive = { builtin: true, words: [], patterns: [] };
    return config;
  };

  // Numbers are clamped on submit, never while typing.
  const wild = base();
  wild.maxRounds = 99;
  wild.maxTokensPerTurn = 5;
  wild.tokenBudget = 1;
  wild.keepRecentRounds = 42;
  wild.requestTimeoutMs = 999_999;
  wild.sensitiveThreshold = 900;
  const clamped = finalizeDraft(wild);
  record(
    '设置页：数字提交时收敛到规格范围（1-20 / 16-64000 / 512-1e6 / 0-10 / 1000-6e5 / 1-100）',
    clamped.maxRounds === 20 && clamped.maxTokensPerTurn === 16 && clamped.tokenBudget === 512
      && clamped.keepRecentRounds === 10 && clamped.requestTimeoutMs === 600_000
      && clamped.sensitiveThreshold === 100,
    `rounds=${clamped.maxRounds} tokens=${clamped.maxTokensPerTurn} budget=${clamped.tokenBudget} keep=${clamped.keepRecentRounds} timeout=${clamped.requestTimeoutMs} threshold=${clamped.sensitiveThreshold}`,
  );

  // All-zero weights fall back to equal weights.
  const zeroWeights = base();
  for (const dimension of SCORE_DIMENSIONS) zeroWeights.scoreWeights[dimension] = 0;
  const weighted = finalizeDraft(zeroWeights);
  record(
    '设置页：六维权重全 0 → 回退到全 1 等权',
    SCORE_DIMENSIONS.every((dimension) => weighted.scoreWeights[dimension] === 1),
    JSON.stringify(weighted.scoreWeights),
  );

  // Duplicate ids are separated; incomplete participants are skipped.
  const roster = base();
  roster.participants = [
    { id: 'same', name: '同名选手', provider: 'p', model: 'm1', persona: '' },
    { id: 'same', name: '同名选手', provider: 'p', model: 'm2', persona: '' },
    { id: 'same', name: '同名选手', provider: 'p', model: 'm3', persona: '' },
    { id: 'ghost', name: '没选模型', provider: '', model: '', persona: '' },
  ];
  const deduped = finalizeDraft(roster);
  record(
    '设置页：重名 id 自动加 -2/-3，未选 provider/model 的选手被跳过',
    deduped.participants.length === 3
      && deduped.participants[0]!.id === 'same'
      && deduped.participants[1]!.id === 'same-2'
      && deduped.participants[2]!.id === 'same-3',
    deduped.participants.map((entry) => entry.id).join(','),
  );

  // Blank rows never reach the Host (they are kept while editing).
  const lists = base();
  lists.sensitive = { builtin: true, words: ['甲', '', '  ', '乙'], patterns: ['a+b', ''] };
  const cleaned = finalizeDraft(lists);
  record(
    '设置页：词表/正则的空行在提交时剔除（编辑时保留）',
    cleaned.sensitive.words.join('|') === '甲|乙' && cleaned.sensitive.patterns.join('|') === 'a+b',
    `words=${cleaned.sensitive.words.join('|')} patterns=${cleaned.sensitive.patterns.join('|')}`,
  );

  // A participant with no explicit id still gets a usable slug.
  const derived = base();
  derived.participants = [{ id: '', name: '暴躁 老哥', provider: 'p', model: 'm', persona: '' }];
  const derivedPayload = finalizeDraft(derived);
  record(
    '设置页：ID 缺省时由名字生成合法 slug',
    derivedPayload.participants[0]?.id === '暴躁-老哥',
    String(derivedPayload.participants[0]?.id ?? ''),
  );

  // Numeric input: multi-digit typing works, decimals survive, empty/`.` commit nothing.
  const typed = ['1', '10', '100', '100000'].map((raw) => parseNumericInput(raw, 512, 1_000_000));
  record(
    '设置页：数字框可连续输入多位数、权重支持小数、空值与 `.` 不提交',
    typed.join(',') === '512,512,512,100000'
      && parseNumericInput('', 1, 20) === undefined
      && parseNumericInput('.', 0, 1, 2) === undefined
      && parseNumericInput('abc', 1, 20) === undefined
      && parseNumericInput('99', 1, 20) === 20
      && parseNumericInput('0.1', 0, 100, 2) === 0.1
      && parseNumericInput('0.25', 0, 100, 2) === 0.25,
    `typed=${typed.join(',')} empty=${String(parseNumericInput('', 1, 20))} decimal=${String(parseNumericInput('0.1', 0, 100, 2))}`,
  );

  // A huge policy cannot flood the wire: words are capped and refusals summarised.
  const many = compileScanner({
    builtin: false,
    words: Array.from({ length: 1_100 }, (_, index) => `word-${index}`),
    patterns: Array.from({ length: 30 }, () => '\\b'),
  });
  record(
    '敏感过滤：词表 1000 上限，被拒列表最多回 20 条 + 折叠计数',
    many.ruleCount === 1_000
      && many.rejected.length === MAX_REJECTED_REPORTED + 1
      && (many.rejected[0]?.rule ?? '').includes('未生效'),
    `rules=${many.ruleCount} rejected=${many.rejected.length} first=${many.rejected[0]?.rule ?? ''}`,
  );

  return results;
}

/**
 * Crash-path and referee-fidelity checks.
 *
 * R1: an unexpected exception used to skip the report, so "保留已完成部分" only
 * held for provider errors. R2: the referee used the inline persona while the
 * speaker performed the mirror file's version.
 * @returns one result per check.
 */
export async function runCrashPathChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const record = (name: string, ok: boolean, detail: string): void => {
    results.push({ name, ok, detail });
  };
  const dirRoot = mkdtempSync(join(tmpdir(), 'roundtable-crash-'));

  try {
    // R1 — throw inside a turn after one speech was already recorded.
    const config = scenarioConfig(dirRoot);
    let personaReads = 0;
    const trapped = {
      id: 'beta', name: '贝塔', provider: 'mock-beta', model: 'beta-1',
    } as ParticipantConfig & { persona: string };
    Object.defineProperty(trapped, 'persona', {
      enumerable: true,
      get() {
        personaReads += 1;
        // `resolvePersona` reads the inline persona twice per call, so beta sees
        // 2 reads in the preflight scan; its first turn starts at read 3, which is
        // already after 阿尔法 has spoken.
        if (personaReads >= 4) throw new Error('模拟内部异常');
        return '你是暴躁的直觉派。';
      },
    });
    config.participants = [
      { id: 'alpha', name: '阿尔法', provider: 'mock-alpha', model: 'alpha-1', persona: '你是尖刻的逻辑派。' },
      trapped,
    ];
    const llm = makeMockLlm((call) => ({ kind: 'text', text: `第 ${call.index + 1} 次发言`, outputTokens: 30 }));
    const run = await new RoundtableRun({ llm: llm as never, config, log: () => {} }, config.topic).execute();
    const report = run.reportPath === undefined ? '' : readFileSync(run.reportPath, 'utf8');
    record(
      '内部异常也写战报：failed + 保留已完成发言 + 记录内部错误',
      run.status === 'failed'
        && run.stopReason === 'internal-error'
        && run.speeches.length >= 1
        && run.reportPath !== undefined
        && report.includes('阿尔法')
        && report.includes('内部错误'),
      `status=${run.status} reason=${run.stopReason} speeches=${run.speeches.length} report=${run.reportPath}`,
    );

    // R2 — the referee must judge the persona the speaker actually performed.
    const personaDir = resolvePersonaDir();
    mkdirSync(personaDir, { recursive: true });
    writeFileSync(join(personaDir, 'mirror.md'), '文件里的人设：说话带刺的读书人。', 'utf8');
    const probe = buildJudgePrompt({
      topic: '测试',
      participants: [{
        id: 'mirror', name: '镜像选手', provider: 'p', model: 'm',
        persona: '内联的旧人设：完全不同的风格。',
        personaFile: 'mirror.md',
      }],
      speeches: [],
    });
    record(
      '裁判看到的是镜像文件人设，不是内联的旧文本',
      probe.prompt.includes('文件里的人设') && !probe.prompt.includes('内联的旧人设'),
      probe.prompt.split('\n').find((line) => line.includes('人设')) ?? '（没有人设行）',
    );
  } finally {
    try {
      rmSync(dirRoot, { recursive: true, force: true });
    } catch {
      // A locked temp directory on Windows is not a verification failure.
    }
  }

  return results;
}

/**
 * Static check: the polling effect must depend only on `remote`.
 *
 * A dependency on `load` recreates the interval on every keystroke, which is
 * both a request per character and the reason a stale snapshot could overwrite a
 * fresh save.
 * @returns one result.
 */
export function checkPollingWiring(): CheckResult {
  // The entry is bundled into test/.build, so resolve the source by trying the
  // project root first and then the path relative to this module — a CI runner
  // may start from anywhere.
  const candidates = [
    join(process.cwd(), 'src', 'client.tsx'),
    join(process.cwd(), '..', 'src', 'client.tsx'),
    fileURLToPath(new URL('../../src/client.tsx', import.meta.url)),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (found === undefined) {
    return { name: '客户端轮询：依赖只放 remote', ok: false, detail: `找不到 src/client.tsx（试过 ${candidates.join(' , ')}）` };
  }
  const source = readFileSync(found, 'utf8');
  const start = source.indexOf('const timer = setInterval');
  if (start < 0) return { name: '客户端轮询：依赖只放 remote', ok: false, detail: '没找到轮询定时器' };
  const window = source.slice(start, start + 900);
  const depsMatch = /\}, \[([^\]]*)\]\);/.exec(window);
  const deps = (depsMatch?.[1] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const loadInDeps = deps.includes('load') || deps.includes('loadRef');
  const viaRef = source.includes('loadRef.current(false)');
  return {
    name: '客户端轮询：依赖只放 remote，load 走 ref（否则每敲一键重建定时器）',
    ok: deps.length === 1 && deps[0] === 'remote' && !loadInDeps && viaRef,
    detail: `依赖=[${deps.join(',')}] 通过ref调用=${viaRef}`,
  };
}

/**
 * Remote-envelope check.
 *
 * A Client Remote method resolves `{ok:true, value}` / `{ok:false, error}` — it
 * does not reject. The shipped 0.1.2 client read the envelope as if it were the
 * payload, so `state.config` was `undefined` and the page died with
 * `"undefined" is not valid JSON`. This check pins the unwrapping contract.
 * @returns one result.
 */
export async function runEnvelopeCheck(): Promise<CheckResult> {
  const raw = {
    getState: async () => ({ ok: true, value: { config: { topic: '信封测试' }, providers: [], running: false } }),
    refreshProviders: async () => ({ ok: true, value: [] }),
    testProvider: async () => ({ ok: true, value: { ok: true, models: 2, message: 'ok' } }),
    saveConfig: async () => ({ ok: true, value: { topic: 'saved' } }),
    reloadConfig: async () => ({ ok: true, value: { topic: 'reloaded' } }),
    scanPreview: async () => ({ ok: true, value: { hits: [], redacted: '', ruleCount: 0, rejected: [] } }),
    startRun: async () => ({ ok: true, value: { id: 'run' } }),
    continueRun: async () => ({ ok: true, value: { id: 'run-2' } }),
    stopRun: async () => ({ ok: true, value: { id: 'run' } }),
    clearRun: async () => ({ ok: true, value: true }),
    exportDocx: async () => ({ ok: true, value: 'C:/tmp/report.docx' }),
    getReport: async () => ({ ok: true, value: '# 战报' }),
    rejudge: async () => ({ ok: true, value: { id: 'run' } }),
  };
  const bound = bindRemote(raw as never);
  const state = await bound.getState() as { config?: { topic?: string } } | undefined;
  const saved = await bound.saveConfig({ topic: 'x' }) as { topic?: string } | undefined;
  const continued = await bound.continueRun(2) as { id?: string } | undefined;
  const report = await bound.getReport();

  let failureMessage = '';
  let failureCode = '';
  const failing = bindRemote({
    ...raw,
    getState: async () => ({ ok: false, error: { message: '宿主说不行', code: 'roundtable/bad' } }),
  } as never);
  try {
    await failing.getState();
  } catch (error) {
    failureMessage = (error as Error).message;
    failureCode = String((error as Error & { code?: string }).code ?? '');
  }

  // A namespace that resolves values directly must keep working.
  const passthrough = unwrap<{ config: { topic: string } }>({ config: { topic: '直通' } });

  const ok = state?.config?.topic === '信封测试'
    && saved?.topic === 'saved'
    && continued?.id === 'run-2'
    && report === '# 战报'
    && failureMessage === '宿主说不行'
    && failureCode === 'roundtable/bad'
    && passthrough.config.topic === '直通';

  return {
    name: '客户端信封拆解：{ok,value} 取到 config / {ok:false,error} 抛出 / 非信封直通',
    ok,
    detail: `topic=${state?.config?.topic} saved=${saved?.topic} continued=${continued?.id} throw=${failureMessage}${failureCode === '' ? '' : `(${failureCode})`} passthrough=${passthrough.config.topic}`,
  };
}

/**
 * Wiring check: run the real `apply` against a mock Cordis context and report
 * everything it registered.
 *
 * This is the check that catches a tool definition the real registry would
 * refuse (the shipped 0.1.0 build failed here: `required: false` is rejected by
 * the parameter DSL), and it proves the Remote markers landed on the service
 * prototype the Gateway reads.
 * @returns one result.
 */
export async function runWiringCheck(): Promise<CheckResult> {
  const provided = new Map<string, unknown>();
  const tools: { name: string; parameters: Record<string, unknown> }[] = [];
  const promptSections: string[] = [];
  const injections: string[] = [];
  const failures: string[] = [];

  const base = {
    llm: {
      listProviders: () => [{ id: 'mock-alpha', name: 'Mock Alpha' }],
      listModels: async () => [],
      resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model, name: model }),
      stream: () => (async function* generate() { /* never called here */ })(),
    },
    get: () => undefined,
    provide: (key: string, value: unknown) => { provided.set(key, value); return () => {}; },
    effect: (callback: () => unknown) => { try { callback(); } catch (error) { failures.push((error as Error).message); } return () => {}; },
    on: () => () => {},
    plugin: () => () => {},
    inject: (names: string[], callback: (ctx: unknown) => void) => {
      injections.push(names.join(','));
      try {
        callback({
          ...base,
          tools: { register: (definition: { name: string; parameters: Record<string, unknown> }) => { tools.push(definition); return () => {}; } },
          systemPrompt: { section: (section: { name: string }) => { promptSections.push(section.name); return () => {}; }, getSectionOrder: () => 0 },
          effect: base.effect,
        });
      } catch (error) {
        failures.push(`${names.join(',')}: ${(error as Error).message}`);
      }
      return () => {};
    },
  };

  try {
    await applyPlugin(base as never, { exposeTools: true, injectPromptSection: true, promptOrder: 1 });
  } catch (error) {
    failures.push(`apply: ${(error as Error).message}`);
  }

  const service = provided.get('roundtable') as { typertRemote?: unknown } | undefined;
  const markers = service === undefined ? [] : remoteMethodsOf(Object.getPrototypeOf(service).constructor as never);
  const binding = service?.typertRemote as { namespace?: string; serviceKey?: string } | undefined;
  const toolNames = tools.map((tool) => tool.name).sort().join(',');
  const optionalWithoutRequired = tools.every((tool) =>
    Object.values(tool.parameters).every((spec) => !('required' in (spec as object)) || (spec as { required?: unknown }).required === true));

  const ok = failures.length === 0
    && service !== undefined
    && binding?.namespace === 'roundtable'
    && binding?.serviceKey === 'roundtable'
    && markers.length === 13
    && markers.some((marker) => marker.method === 'getState')
    && markers.some((marker) => marker.method === 'startRun')
    && markers.some((marker) => marker.method === 'continueRun')
    && tools.length === 3
    && toolNames === 'roundtable_export,roundtable_start,roundtable_status'
    && optionalWithoutRequired
    && promptSections.includes('roundtable:personas')
    && injections.includes('tools') && injections.includes('systemPrompt')
    && pluginName === 'roundtable'
    && PluginConfig !== undefined;

  return {
    name: '插件装配：服务绑定 / 13 个 Remote 标记 / 3 个工具 / prompt 段落',
    ok,
    detail: `provided=${[...provided.keys()].join(',')} namespace=${binding?.namespace} markers=${markers.length} tools=${toolNames} prompt=${promptSections.join(',')} inject=${injections.join('+')} failures=${failures.join(' | ') || '无'}`,
  };
}
