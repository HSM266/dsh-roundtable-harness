/**
 * Markdown 战报 rendering.
 *
 * The Markdown report is the primary deliverable — readable in the browser,
 * diffable in git, and the exact same content the docx carries — so it is
 * written first and the docx is produced from the same state.
 *
 * **Everything a model produced is escaped before it enters the document.** A
 * participant can emit `# 标题`, a table pipe, a fenced block or raw `<script>`
 * just as easily as prose, and a report is a file the user opens in a renderer.
 * Escaping here, at the one point where model text becomes document structure,
 * keeps the report a report.
 *
 * @module dsh-roundtable-harness/report
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunState, Speech } from './roundtable.js';
import { SCORE_DIMENSIONS, SCORE_DIMENSION_LABELS, describeWeights, type ScoreDimension } from './dimensions.js';
import { AI_JUDGE_DISCLAIMER } from './judge.js';

/** Options for {@link buildMarkdownReport}. */
export interface ReportOptions {
  /** Directory the report is written to; created when missing. */
  outputDir: string;
  /** Referee persona, recorded in the appendix for reproducibility. */
  judgePersona?: string;
  /** Overrides the generated file name stem. */
  fileStem?: string;
}

/** `YYYYMMDD-HHmmss` in local time, safe for a file name. */
export function timestampSlug(at: number = Date.now()): string {
  const date = new Date(at);
  const pad = (value: number): string => `${value}`.padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Control characters that would corrupt a Markdown document or an OOXML body. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Strip control characters and normalize line endings.
 * @param value - raw text.
 * @returns text safe to embed in a document body.
 */
export function sanitizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(CONTROL_CHARACTERS, '');
}

/**
 * Escape model-authored text for a Markdown document.
 *
 * HTML is entity-escaped (`<`, `>`, `&`) because most Markdown renderers pass
 * raw HTML through, and Markdown structural characters are backslash-escaped so
 * a participant cannot open a heading, a list, a code fence, a table column, or
 * a link. Line-leading list and quote markers are escaped separately, since
 * escaping every `-` would make ordinary prose unreadable.
 * @param value - raw text from a model, the user, or a log line.
 * @returns text that renders as literal prose.
 */
export function escapeMarkdown(value: string): string {
  return sanitizeText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}[\]()#+!|~])/g, '\\$1')
    .replace(/^(\s*)([-+]|\d+\.)(\s)/gm, '$1\\$2$3');
}

/** Escape the characters that would break a Markdown table cell. */
function cell(value: string): string {
  return escapeMarkdown(value).replace(/\n/g, ' ');
}

/** Human-readable stop reason. */
export function describeStopReason(reason: RunState['stopReason']): string {
  switch (reason) {
    case 'max-rounds': return '达到设定轮数';
    case 'fatal-error': return 'Provider 返回 429/5xx，讨论立即终止（不自动重试）';
    case 'sensitive-threshold': return '敏感内容命中次数超过阈值';
    case 'user-stop': return '用户手动终止（已跳过裁判环节）';
    case 'no-participants': return '没有可用的参赛选手';
    case 'topic-refused': return '话题本身命中敏感规则，讨论未开始';
    case 'internal-error': return '插件内部错误';
    default: return '（未记录）';
  }
}

/** Human-readable cost status. */
export function describeCostStatus(status: Speech['costStatus']): string {
  switch (status) {
    case 'measured': return '已归因';
    case 'unmeasured': return '归因失败';
    case 'no-ledger': return '无账本';
    default: return '未知';
  }
}

/** Human-readable overall cost coverage. */
export function describeCostSource(source: RunState['costSource']): string {
  switch (source) {
    case 'ledger': return 'dsh-cost-meter 真实账本（全员已归因）';
    case 'partial': return 'dsh-cost-meter 真实账本（部分选手归因失败）';
    default: return '口径不可用（未读到账本）';
  }
}

/**
 * Per-participant latency and throughput, computed from the recorded turns.
 *
 * Only answered turns count toward the average: a timeout or an empty reply says
 * nothing about how fast a route is when it does answer, and folding those in
 * would make a provider look slow because it failed rather than because it was
 * slow.
 * @param speeches - every turn of the run.
 * @returns rows per participant plus the single slowest turn.
 */
export function summarizeLatency(speeches: readonly Speech[]): {
  rows: {
    name: string;
    turns: number;
    averageMs: number;
    outputTokens: number;
    tokensPerSecond: string;
    timeouts: number;
    empties: number;
  }[];
  slowest?: { name: string; round: number; elapsedMs: number };
} {
  const order: string[] = [];
  const grouped = new Map<string, {
    name: string;
    answered: number;
    totalMs: number;
    outputTokens: number;
    timeouts: number;
    empties: number;
  }>();
  let slowest: { name: string; round: number; elapsedMs: number } | undefined;
  for (const speech of speeches) {
    let entry = grouped.get(speech.participantId);
    if (entry === undefined) {
      entry = { name: speech.name, answered: 0, totalMs: 0, outputTokens: 0, timeouts: 0, empties: 0 };
      grouped.set(speech.participantId, entry);
      order.push(speech.participantId);
    }
    if (speech.status === 'ok') {
      entry.answered += 1;
      entry.totalMs += speech.elapsedMs;
      entry.outputTokens += speech.usage.outputTokens;
      if (slowest === undefined || speech.elapsedMs > slowest.elapsedMs) {
        slowest = { name: speech.name, round: speech.round, elapsedMs: speech.elapsedMs };
      }
    } else if (speech.status === 'timeout') {
      entry.timeouts += 1;
    } else if (speech.status === 'empty') {
      entry.empties += 1;
    }
  }
  const rows = order.map((id) => {
    const entry = grouped.get(id)!;
    const averageMs = entry.answered === 0 ? 0 : Math.round(entry.totalMs / entry.answered);
    const seconds = entry.totalMs / 1000;
    const rate = seconds > 0 && entry.outputTokens > 0 ? (entry.outputTokens / seconds).toFixed(1) : '—';
    return {
      name: entry.name,
      turns: entry.answered,
      averageMs,
      outputTokens: entry.outputTokens,
      tokensPerSecond: rate,
      timeouts: entry.timeouts,
      empties: entry.empties,
    };
  });
  return slowest === undefined ? { rows } : { rows, slowest };
}

/** Render one speech as a Markdown block. */
function renderSpeech(speech: Speech): string {
  const header = `#### 第 ${speech.round} 轮 · ${escapeMarkdown(speech.name)}`;
  const meta = `> ${escapeMarkdown(speech.provider)}/${escapeMarkdown(speech.model)} · ${speech.status}`
    + ` · 输出 ${speech.usage.outputTokens} tokens`
    + ` · 花费 ${speech.costStatus === 'measured' ? `$${speech.cost.toFixed(6)}` : `口径不可用（${describeCostStatus(speech.costStatus)}）`}`
    + ` · ${speech.elapsedMs} ms`
    + (speech.sensitiveHits > 0 ? ` · 过滤 ${speech.sensitiveHits} 处` : '');
  const body = speech.status === 'ok'
    ? escapeMarkdown(speech.text)
    : `**${escapeMarkdown(speech.text)}**`;
  return [header, meta, '', body, ''].join('\n');
}

/**
 * Render the whole 战报 as Markdown.
 * @param state - the finished run state.
 * @param options - output settings.
 * @returns the Markdown document.
 */
export function renderMarkdownReport(state: RunState, options: ReportOptions): string {
  const lines: string[] = [];
  const date = new Date(state.startedAt);
  lines.push('# 赛博圆桌战报', '');
  lines.push(`> ⚠️ ${AI_JUDGE_DISCLAIMER}`, '');
  lines.push(`**话题**：${state.topic.length > 0 ? escapeMarkdown(state.topic) : '（未设置）'}`, '');
  lines.push(`**时间**：${date.toLocaleString('zh-CN')}`, '');
  lines.push(`**轮数**：${state.rounds} / ${state.plannedRounds}`, '');
  lines.push(`**终止原因**：${describeStopReason(state.stopReason)}`, '');
  lines.push(`**花费口径**：${describeCostSource(state.costSource)}`, '');
  lines.push(`**总花费**：$${state.totalCost.toFixed(6)}`, '');
  if (state.continuedFrom !== undefined) {
    lines.push(`**续接自**：上一场讨论 \`${state.continuedFrom}\``, '');
  }
  lines.push('');

  // ── 参赛选手 ─────────────────────────────────────────────────────────────
  lines.push('## 参赛选手', '');
  const roster = state.speeches.reduce<Map<string, Speech>>((map, speech) => {
    if (!map.has(speech.participantId)) map.set(speech.participantId, speech);
    return map;
  }, new Map());
  lines.push('| 选手 | Provider / 模型 | 有效发言 | 输出 tokens | 花费 (USD) | 口径 |');
  lines.push('| --- | --- | ---: | ---: | ---: | --- |');
  for (const [id, speech] of roster) {
    const mine = state.speeches.filter((entry) => entry.participantId === id);
    const ok = mine.filter((entry) => entry.status === 'ok').length;
    const tokens = mine.reduce((sum, entry) => sum + (entry.usage.outputTokens ?? 0), 0);
    const measured = mine.filter((entry) => entry.costStatus === 'measured');
    const cost = measured.reduce((sum, entry) => sum + entry.cost, 0);
    const status = measured.length === 0 ? 'no-ledger' : measured.length === mine.length ? 'measured' : 'unmeasured';
    lines.push(`| ${cell(speech.name)} | ${cell(`${speech.provider}/${speech.model}`)} | ${ok}/${mine.length} | ${tokens} | ${measured.length === 0 ? '—' : cost.toFixed(6)} | ${describeCostStatus(status)} |`);
  }
  lines.push('');

  // ── 评分榜 ───────────────────────────────────────────────────────────────
  lines.push('## 评分榜', '');
  if (state.judge === undefined) {
    lines.push('本场没有裁判结果（裁判未配置、讨论被终止，或裁判未运行）。', '');
  } else {
    const judge = state.judge;
    lines.push(`> ⚠️ ${AI_JUDGE_DISCLAIMER}`, '');
    lines.push(`**裁判模型**：${judge.model.length > 0 ? escapeMarkdown(`${judge.provider}/${judge.model}`) : '（未配置）'}`
      + ` · **出分时间**：${judge.at > 0 ? new Date(judge.at).toLocaleString('zh-CN') : '—'}`
      + ` · **状态**：${judge.degraded ? '⚠️ 降级（非模型评分）' : '正常'}`
      + ` · 耗时 ${judge.elapsedMs} ms`, '');
    lines.push(`评分维度与权重：${describeWeights(state.weights)}。`
      + `总分 = 六维加权平均（0-100）。`, '');
    if (judge.transcriptDroppedChars > 0) {
      lines.push(`> 裁判只看到最近部分发言：较早的 ${judge.transcriptDroppedChars} 字因超出提示词预算未附上。`, '');
    }
    if (!judge.judged) {
      lines.push(`> ⚠️ **裁判不可用，已降级为字数估算**：${escapeMarkdown(judge.note ?? '未给出有效评分')}。`
        + `攻击性/逻辑/深度按有效输出量估算，其余维度记中性 50 分；下面的名次不代表模型判断。`, '');
    } else if (judge.note !== undefined) {
      lines.push(`> 说明：${escapeMarkdown(judge.note)}`, '');
    }
    const dimensionHeader = SCORE_DIMENSIONS.map((dimension) => SCORE_DIMENSION_LABELS[dimension]).join(' | ');
    const dimensionRule = SCORE_DIMENSIONS.map(() => '---:').join(' | ');
    lines.push(`| 名次 | 选手 | ${dimensionHeader} | 总分 | 点评 |`);
    lines.push(`| ---: | --- | ${dimensionRule} | ---: | --- |`);
    state.judge.scores.forEach((score, index) => {
      const medal = state.judge?.championId === score.participantId ? '🏆 ' : '';
      const dims = SCORE_DIMENSIONS.map((dimension: ScoreDimension) => `${score[dimension]}`).join(' | ');
      lines.push(`| ${index + 1} | ${medal}${cell(score.name)} | ${dims} | **${score.total}** | ${cell(score.comment)} |`);
    });
    lines.push('');
    if (state.judge.summary.length > 0) {
      lines.push('### 裁判总结', '', escapeMarkdown(state.judge.summary), '');
    }

    // ── 性价比（独立榜，实验性，只收数据完整的选手） ──────────────────────
    const scored = state.speeches.length;
    const attributed = state.speeches.filter((speech) => speech.costStatus === 'measured').length;
    lines.push('### 性价比榜（实验性 · 不要当作可靠结论）', '');
    lines.push(`口径覆盖率：${attributed}/${scored} 条发言完成花费归因`
      + `（${scored === 0 ? 0 : Math.round((attributed / scored) * 100)}%）。`
      + `本榜在 0.2.x 仍是实验功能：花费来自外部账本，一次归因失败就可能让「便宜」失真，`
      + `名次仅供参考，真实账单见 dsh-cost-meter。`, '');
    if (state.judge.valueRanking.length === 0) {
      lines.push(`本场没有数据完整到可以参与性价比排名的选手：`, '');
      for (const entry of state.judge.unmeasured) {
        lines.push(`- ${escapeMarkdown(entry.name)}：${escapeMarkdown(entry.reason)}`);
      }
      lines.push('');
    } else {
      lines.push('性价比 = 总分 ÷ 真实花费；全场最高者记 100，其余线性折算。'
        + '**只收每一轮花费都被成功归因的选手**——少归因一轮就会低估花费、虚高性价比，所以直接排除。', '');
      lines.push('| 名次 | 选手 | 总分 | 花费 (USD) | 性价比 |');
      lines.push('| ---: | --- | ---: | ---: | ---: |');
      for (const id of state.judge.valueRanking) {
        const score = state.judge.scores.find((entry) => entry.participantId === id);
        // Rendering filter: a row without real cost data never reaches the table.
        if (score === undefined || score.value === undefined || score.costStatus !== 'measured') continue;
        lines.push(`| ${score.valueRank ?? '—'} | ${cell(score.name)} | ${score.total} | ${score.cost.toFixed(6)} | ${score.value} |`);
      }
      lines.push('');
      if (state.judge.unmeasured.length > 0) {
        lines.push('未纳入本榜的选手（数据不全，不是「最划算」）：', '');
        for (const entry of state.judge.unmeasured) {
          lines.push(`- ${escapeMarkdown(entry.name)}：${escapeMarkdown(entry.reason)}`);
        }
        lines.push('');
      }
    }
  }

  // ── 调用耗时 ─────────────────────────────────────────────────────────────
  //
  // Latency is what makes an operator blame a provider, so measure it instead of
  // guessing: average wall time per turn, output tokens, output rate, and how
  // often the turn did not answer at all. A 900 ms first token is not a problem;
  // a 60 s timeout is, and this table tells them apart.
  const latency = summarizeLatency(state.speeches);
  if (latency.rows.length > 0) {
    lines.push('## 调用耗时', '');
    lines.push('| 选手 | 发言 | 平均耗时 | 输出 tokens | 输出速率 | 超时 | 空响应 |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const row of latency.rows) {
      lines.push(
        `| ${escapeMarkdown(row.name)} | ${row.turns} | ${row.averageMs} ms | ${row.outputTokens}`
        + ` | ${row.tokensPerSecond} tok/s | ${row.timeouts} | ${row.empties} |`,
      );
    }
    lines.push('');
    if (latency.slowest !== undefined) {
      lines.push(
        `> 最慢一次：${escapeMarkdown(latency.slowest.name)} 第 ${latency.slowest.round} 轮 ${latency.slowest.elapsedMs} ms；`
        + '超时次数按单次请求超过「讨论参数」里的超时阈值统计。',
        '',
      );
    }
  }

  // ── 逐轮记录 ─────────────────────────────────────────────────────────────
  lines.push('## 讨论记录', '');
  if (state.speeches.length === 0) {
    lines.push('（没有任何发言记录）', '');
  }
  let currentRound = 0;
  for (const speech of state.speeches) {
    if (speech.round !== currentRound) {
      currentRound = speech.round;
      lines.push(`### 第 ${currentRound} 轮`, '');
    }
    lines.push(renderSpeech(speech));
  }

  // ── 异常记录 ─────────────────────────────────────────────────────────────
  lines.push('## 异常记录', '');
  if (state.anomalies.length === 0) {
    lines.push('本场无异常。', '');
  } else {
    lines.push('| 时间 | 轮次 | 选手 | 类型 | 详情 |');
    lines.push('| --- | ---: | --- | --- | --- |');
    for (const anomaly of state.anomalies) {
      const at = new Date(anomaly.at).toLocaleTimeString('zh-CN');
      const who = anomaly.participantId ?? '—';
      lines.push(`| ${at} | ${anomaly.round || '—'} | ${cell(who)} | ${cell(anomaly.kind)} | ${cell(anomaly.message)} |`);
    }
    lines.push('');
  }

  // ── 附录 ─────────────────────────────────────────────────────────────────
  lines.push('## 附录', '');
  lines.push(`- 运行 ID：\`${state.id}\``);
  if (state.continuedFrom !== undefined) lines.push(`- 续接自：\`${state.continuedFrom}\``);
  lines.push(`- 压缩摘要：${state.summary.trim().length > 0 ? '有（见下）' : '无（上下文未超预算）'}`);
  lines.push(`- 最后一次请求的上下文估算：${state.lastContextTokens} tokens`);
  if (state.docxPath !== undefined) lines.push(`- docx 战报：\`${state.docxPath}\``);
  if (state.error !== undefined) lines.push(`- 错误：${escapeMarkdown(state.error)}`);
  if (options.judgePersona !== undefined && options.judgePersona.trim().length > 0) {
    lines.push('', '### 裁判人格', '', '```text', sanitizeText(options.judgePersona.trim()).replace(/```/g, '``\u200b`'), '```');
  }
  if (state.summary.trim().length > 0) {
    lines.push('', '### 上下文压缩摘要', '', escapeMarkdown(state.summary.trim()));
  }
  lines.push('', '---', '', '本战报由 dsh-roundtable-harness 生成。模型输出已转义后再写入，敏感内容按配置词库过滤（命中处替换为 `[内容已过滤]`）。');
  return lines.join('\n');
}

/**
 * Render and write the Markdown 战报.
 * @param state - the finished run state.
 * @param options - output settings.
 * @returns the absolute path written.
 */
export function buildMarkdownReport(state: RunState, options: ReportOptions): string {
  mkdirSync(options.outputDir, { recursive: true });
  const stem = options.fileStem ?? `roundtable-${timestampSlug(state.startedAt)}`;
  const path = join(options.outputDir, `${stem}-战报.md`);
  writeFileSync(path, `${renderMarkdownReport(state, options)}\n`, 'utf8');
  return path;
}
