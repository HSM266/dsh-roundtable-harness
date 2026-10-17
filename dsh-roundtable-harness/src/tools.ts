/**
 * Agent tools.
 *
 * The tools are thin: every one of them calls the same
 * {@link RoundtableEndpoints} method the settings page calls, so an agent can
 * never reach a code path the UI cannot, and vice versa.
 *
 * Note the parameter DSL: an optional field **omits** `required`, it never says
 * `required: false` — the schema compiler rejects the latter outright.
 *
 * @module dsh-roundtable-harness/tools
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRuntime } from '@deepseek-ai/dsh-tools';
import type { RoundtableEndpoints } from './service.js';
import type { RunState, Speech } from './roundtable.js';
import { SCORE_DIMENSIONS, SCORE_DIMENSION_LABELS } from './dimensions.js';
import { AI_JUDGE_DISCLAIMER } from './judge.js';

/** Longest a `roundtable_start` tool call blocks before reporting progress instead. */
const START_WAIT_MS = 120_000;

/** Render one speech as a compact transcript row. */
function speechLine(speech: Speech): string {
  const head = `[R${speech.round}] ${speech.name} (${speech.provider}/${speech.model})`;
  const spend = speech.costStatus === 'measured'
    ? `$${speech.cost.toFixed(6)}`
    : `花费口径不可用(${speech.costStatus})`;
  const stats = `${speech.usage.outputTokens} out · ${spend} · ${speech.elapsedMs} ms`;
  if (speech.status !== 'ok') return `${head} — ${speech.status.toUpperCase()}: ${speech.note ?? '无响应'} (${stats})`;
  return `${head} — ${stats}\n${speech.text}`;
}

/** Human-readable cost coverage for the header line. */
function costSourceLabel(state: RunState): string {
  switch (state.costSource) {
    case 'ledger': return 'dsh-cost-meter 真实账本，全员已归因';
    case 'partial': return 'dsh-cost-meter 真实账本，部分选手归因失败（已排除出性价比榜）';
    default: return '口径不可用：未读到账本，性价比不排名';
  }
}

/**
 * Render a run for the model: state header, the transcript of the most recent
 * round, the scoreboard, and where the report went.
 * @param state - the run to summarize.
 * @returns a Markdown-ish summary.
 */
export function renderRunSummary(state: RunState): string {
  const lines: string[] = [];
  lines.push(`状态：${state.status}${state.stopReason !== undefined ? `（${state.stopReason}）` : ''}`);
  lines.push(`话题：${state.topic}`);
  lines.push(`轮数：${state.rounds}/${state.plannedRounds} · 发言 ${state.speeches.length} 条`
    + ` · 总花费 $${state.totalCost.toFixed(6)}（${costSourceLabel(state)}）`);
  if (state.continuedFrom !== undefined) lines.push(`续接自：${state.continuedFrom}`);
  if (state.reportPath !== undefined) lines.push(`Markdown 战报：${state.reportPath}`);
  if (state.docxPath !== undefined) lines.push(`docx 战报：${state.docxPath}`);
  if (state.error !== undefined) lines.push(`错误：${state.error}`);

  if (state.judge !== undefined && state.judge.scores.length > 0) {
    const weights = SCORE_DIMENSIONS
      .map((dimension) => `${SCORE_DIMENSION_LABELS[dimension]} ${state.weights[dimension]}`)
      .join(' · ');
    lines.push('', `评分榜（六维加权平均：${weights}）：`);
    for (const score of state.judge.scores) {
      const crown = state.judge.championId === score.participantId ? '🏆 ' : '';
      const dims = SCORE_DIMENSIONS
        .map((dimension) => `${SCORE_DIMENSION_LABELS[dimension]} ${score[dimension]}`)
        .join(' / ');
      const spend = score.costStatus === 'measured' ? `$${score.cost.toFixed(6)}` : '口径不可用';
      lines.push(`- ${crown}${score.name}：总分 ${score.total}（${dims}；花费 ${spend}）${score.comment.length > 0 ? ` — ${score.comment}` : ''}`);
    }
    if (state.judge.valueRanking.length > 0) {
      lines.push('', '性价比榜（总分 ÷ 真实花费；只统计口径可用的选手）：');
      for (const id of state.judge.valueRanking) {
        const score = state.judge.scores.find((entry) => entry.participantId === id);
        if (score === undefined || score.value === undefined) continue;
        lines.push(`- 第 ${score.valueRank ?? '—'} 名 ${score.name}：性价比 ${score.value}（总分 ${score.total}，花费 $${score.cost.toFixed(6)}）`);
      }
    } else {
      lines.push('', '本场没有可用的花费数据，性价比不参与排名。');
    }
    if (state.judge.unmeasured.length > 0) {
      lines.push('', '未纳入性价比排名（无数据 ≠ 最划算）：');
      for (const entry of state.judge.unmeasured) lines.push(`- ${entry.name}：${entry.reason}`);
    }
    if (state.judge.summary.length > 0) lines.push('', `裁判总结：${state.judge.summary}`);
    lines.push('', `⚠️ ${AI_JUDGE_DISCLAIMER}`);
    lines.push(`裁判模型：${state.judge.model.length > 0 ? `${state.judge.provider}/${state.judge.model}` : '未记录'}`
      + ` · 状态：${state.judge.degraded ? '降级（字数估算，非模型评分）' : '正常'}`);
    if (!state.judge.judged) {
      lines.push(`⚠️ 裁判不可用，已降级：${state.judge.note ?? '未给出有效评分'}。上面的名次不代表模型判断。`);
    }
  } else if (state.status !== 'running') {
    lines.push('', '本场没有裁判结果（裁判未配置、讨论被终止，或裁判未运行）。');
  }

  if (state.speeches.length > 0) {
    lines.push('', '发言记录：');
    for (const speech of state.speeches) lines.push('', speechLine(speech));
  }
  if (state.anomalies.length > 0) {
    lines.push('', '异常记录：');
    for (const anomaly of state.anomalies) {
      lines.push(`- [R${anomaly.round || '—'}] ${anomaly.kind}：${anomaly.message}`);
    }
  }
  return lines.join('\n');
}

/**
 * Register the three roundtable tools on the calling context.
 * @param ctx - the context that owns the registrations.
 * @param service - the shared operations object.
 * @param tools - the tool registry, injected optionally by the caller.
 * @returns the disposers, so the caller can keep them in its own effect.
 */
export function registerRoundtableTools(
  ctx: Context,
  service: RoundtableEndpoints,
  tools: ToolRuntime,
): (() => void)[] {
  const disposers: (() => void)[] = [];
  void ctx;

  disposers.push(tools.register(defineTool({
    name: 'roundtable_start',
    description: [
      '启动一场多模型圆桌辩论：按配置顺序让多个 AI 围绕同一话题多轮互喷，',
      '每一轮都把全部历史发言打包给下一个模型作为吵架依据，结束后由裁判模型按',
      '攻击性 / 逻辑 / 人物形象还原度 / 趣味度 / 策略 / 深度 六维加权平均打分，',
      '性价比单独用 dsh-cost-meter 的真实账单计算（只统计口径可用的选手），',
      '并写出 Markdown《赛博圆桌战报》。选手、人格、裁判、权重与轮数在「圆桌会议」设置页配置。',
      '要在上一场基础上继续加轮次，用设置页的「续前讨论」。',
    ].join(''),
    parameters: {
      topic: { type: 'string', description: '讨论话题；留空则使用设置页保存的话题' },
      rounds: { type: 'number', description: '讨论轮数 1-20；留空或 0 则使用设置页保存的轮数' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { topic?: string; rounds?: number }) {
      await service.startRun(args.topic ?? '', args.rounds ?? 0);
      // The run continues in the background; block only long enough to answer
      // most discussions inline, then hand back progress instead of hanging.
      const settled = await Promise.race([
        service.whenRunSettles(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), START_WAIT_MS)),
      ]);
      if (settled === undefined) {
        const state = await service.getState();
        return `讨论已开始并在后台继续（超过 ${Math.round(START_WAIT_MS / 1000)} 秒仍未结束）。\n`
          + `当前进度：第 ${state.run?.rounds ?? 0}/${state.run?.plannedRounds ?? 0} 轮，`
          + `已有 ${state.run?.speeches.length ?? 0} 条发言。稍后用 roundtable_status 查询，`
          + `结束用 roundtable_export 导出 docx。`;
      }
      return renderRunSummary(settled);
    },
  })));

  disposers.push(tools.register(defineTool({
    name: 'roundtable_status',
    description: '查询当前或最近一场圆桌辩论的状态：轮次进度、全部发言、裁判评分榜与异常记录。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      const state = await service.getState();
      if (state.run === undefined) {
        return `还没有任何讨论记录。已配置 ${state.config.participants.length} 位选手，`
          + `裁判 ${state.resolvedJudge !== undefined ? `${state.resolvedJudge.provider}/${state.resolvedJudge.model}` : '未配置'}。`;
      }
      return renderRunSummary(state.run);
    },
  })));

  disposers.push(tools.register(defineTool({
    name: 'roundtable_export',
    description: '把最近一场圆桌辩论导出成 docx 战报（含封面、选手形象图、逐轮发言、评分榜与异常记录章节）。',
    parameters: {
      format: {
        type: 'string',
        description: '导出格式：docx（默认，写入文件）或 markdown（直接返回文本）',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { format?: string }) {
      if ((args.format ?? 'docx').toLowerCase() === 'markdown') {
        return service.getReport();
      }
      const path = await service.exportDocx();
      return `docx 战报已写入：${path}`;
    },
  })));

  return disposers;
}
