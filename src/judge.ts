/**
 * The rotating referee.
 *
 * Six dimensions come from the judge model: 攻击性 / 逻辑 / 人物形象还原度 /
 * 趣味度 / 策略 / 深度. The composite is assembled here from the raw dimensions
 * and the configured weights, so the arithmetic is reproducible from the report
 * alone rather than being whatever number the model felt like writing.
 *
 * `性价比` is **not** a judged dimension — a model has no idea what it cost. It
 * is derived from the ledger, and only for participants whose spend was actually
 * attributed. A speaker with no cost data is reported as 「口径不可用」 and left
 * out of that ranking: "no data" must never read as "infinitely efficient".
 *
 * @module dsh-roundtable-harness/judge
 */

import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { callModel, userMessage } from './providers.js';
import { resolvePersona, type ParticipantConfig } from './config.js';
import type { Speech } from './roundtable.js';
import {
  SCORE_DIMENSIONS,
  SCORE_DIMENSION_HINTS,
  SCORE_DIMENSION_LABELS,
  weightedTotal,
  type DimensionScores,
  type ScoreDimension,
} from './dimensions.js';

/** The default referee persona, used when neither config nor `JUDGE_PERSONA` sets one. */
export const DEFAULT_JUDGE_PERSONA = [
  '你是赛博圆桌的首席裁判。你毒舌、冷静、只看证据，不接受任何自我表扬。',
  `你负责给每位选手打六个维度的分（每个 0-100 整数）：${SCORE_DIMENSIONS.map((dimension) => `${SCORE_DIMENSION_LABELS[dimension]}（${SCORE_DIMENSION_HINTS[dimension]}）`).join('；')}。`,
  '不要因为选手自我表扬、字数多、语气强硬就给高分；只按上面每个维度的定义判。',
  '性价比由系统用真实账单计算，你不需要也不允许给出性价比分数。',
  '边界声明：拒绝讨论任何敏感、违法、危害国家安全或破坏社会稳定的内容；遇到这类内容直接把相关项分数打到 0 并在 comment 中说明。',
  '只输出一个 JSON 对象，不要输出任何解释性文字或 Markdown 代码块标记。',
].join('\n');

/** Whether a participant's spend could be attributed. */
export type CostStatus = 'measured' | 'unmeasured' | 'no-ledger';

/**
 * The mandatory disclaimer for anything a referee model produced.
 *
 * The judge is a language model: it can be wrong, inconsistent, or simply
 * absent. Every surface that shows its verdict — the Markdown report, the docx,
 * the settings page — states that up front, because a scoreboard otherwise reads
 * as authoritative.
 */
export const AI_JUDGE_DISCLAIMER = '本内容由 AI 裁判自动生成，可能存在错误，不构成权威结论。';

/**
 * Longest transcript the referee prompt carries.
 *
 * A 20-round multi-speaker debate can exceed any model's window on its own, and
 * a request the provider rejects is worse than a slightly short one: old
 * speeches are dropped from the *start* of the prompt and the truncation is
 * reported, never silent.
 */
export const JUDGE_TRANSCRIPT_MAX_CHARS = 60_000;

/** Longest single speech rendered into the referee prompt. */
export const JUDGE_SPEECH_MAX_CHARS = 4_000;

/** One participant's judged dimensions plus the derived cost figures. */
export interface JudgeScore extends DimensionScores {
  participantId: string;
  name: string;
  /** Weighted composite of the six dimensions, 0-100, one decimal. */
  total: number;
  comment: string;
  /** Ledger cost attributed to this participant across the whole discussion. */
  cost: number;
  /** Whether that cost is real data or a gap. */
  costStatus: CostStatus;
  /** 0-100 cost-effectiveness, present only when `costStatus === 'measured'`. */
  value?: number;
  /** 1-based place in the cost-effectiveness ranking, same condition. */
  valueRank?: number;
  /** Output tokens this participant produced. */
  outputTokens: number;
}

/** The referee's verdict on a finished discussion. */
export interface JudgeOutcome {
  /** Whether the judge model answered; `false` means the fallback ran. */
  judged: boolean;
  /** Why the fallback ran, when it did. */
  note?: string;
  /**
   * True when the referee reply was unusable — absent, unparseable, or keyed by
   * ids that match nobody — so the six dimensions are the deterministic fallback
   * rather than the model's judgement.
   */
  degraded: boolean;
  /** The referee model actually used, for the report and the page. */
  provider: string;
  model: string;
  /** When the referee ran, or 0 when it never did. */
  at: number;
  scores: JudgeScore[];
  /** Winning participant id by composite score, or `undefined` when nobody scored. */
  championId?: string;
  /** Free-form closing remark from the referee. */
  summary: string;
  /** Whether cost data covered the whole field, part of it, or none of it. */
  costSource: 'ledger' | 'partial' | 'unavailable';
  /** Participants excluded from the cost-effectiveness ranking, with the reason. */
  unmeasured: { participantId: string; name: string; reason: string }[];
  /** Participant ids in cost-effectiveness order, best first. */
  valueRanking: string[];
  /** How many transcript characters were dropped to fit the prompt budget. */
  transcriptDroppedChars: number;
  /** Elapsed judge-call time in milliseconds, 0 when not judged. */
  elapsedMs: number;
}

/** The JSON the referee is asked to produce. */
interface JudgePayload {
  scores?: Record<string, unknown>[];
  summary?: unknown;
}

const clampScore = (value: unknown): number => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(100, Math.max(0, Math.round(numeric)));
};

/**
 * Parse the referee's reply.
 * Models wrap JSON in prose or fences often enough that a strict `JSON.parse`
 * alone would silently disable scoring, so the first balanced object is
 * extracted before parsing.
 * @param text - the raw reply.
 * @returns the parsed payload, or `undefined` when no object could be read.
 */
export function parseJudgePayload(text: string): JudgePayload | undefined {
  const attempt = (candidate: string): JudgePayload | undefined => {
    try {
      const parsed: unknown = JSON.parse(candidate);
      return parsed !== null && typeof parsed === 'object' ? parsed as JudgePayload : undefined;
    } catch {
      return undefined;
    }
  };
  const direct = attempt(text.trim());
  if (direct !== undefined) return direct;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1] !== undefined) {
    const parsed = attempt(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return attempt(text.slice(start, end + 1));
  return undefined;
}

/** One participant's cost data, as far as the engine knows it. */
export interface ParticipantCost {
  /** Attributed cost; only meaningful when `measured`. */
  cost: number;
  /** True only when every turn of this participant was attributed. */
  measured: boolean;
  /** Turns this participant took. */
  turns: number;
  /** Turns whose spend was attributed. */
  measuredTurns: number;
  /** Why it is not measured, for the report. */
  reason?: string;
}

/**
 * Rank cost-effectiveness among the participants that have real cost data.
 *
 * The ratio is the composite score per unit of spend: the best ratio in the
 * field scores 100 and the rest scale linearly against it. Participants without
 * data are absent from the result by construction — there is no floor, and no
 * proxy, that could let a missing price outrank a measured one.
 * @param entries - one entry per participant.
 * @returns the value score and rank for the measured entries only.
 */
export function computeValueScores(
  entries: readonly { participantId: string; total: number; cost: number; measured: boolean }[],
): Map<string, { value: number; rank: number }> {
  const measured = entries.filter((entry) => entry.measured && entry.cost > 0);
  if (measured.length === 0) return new Map();
  const ratios = measured.map((entry) => ({ id: entry.participantId, ratio: entry.total / entry.cost }));
  ratios.sort((a, b) => b.ratio - a.ratio);
  const best = ratios[0]?.ratio ?? 0;
  const scores = new Map<string, { value: number; rank: number }>();
  ratios.forEach((entry, index) => {
    scores.set(entry.id, {
      value: best > 0 ? Math.round((entry.ratio / best) * 100) : 0,
      rank: index + 1,
    });
  });
  return scores;
}

/** Build the referee prompt from the finished transcript, under a size budget. */
export function buildJudgePrompt(options: {
  topic: string;
  participants: readonly ParticipantConfig[];
  speeches: readonly Speech[];
}): { prompt: string; droppedChars: number } {
  // The referee must judge against the persona the speaker actually performed.
  // A speaker reads `resolvePersona()` (mirror file first); using the inline
  // `persona` here made a hand-edited `personas/<id>.md` score against stale
  // text, which is exactly what 人物形象还原度 is supposed to measure.
  const roster = options.participants.map((participant) => {
    const persona = resolvePersona(participant).trim();
    return `- id=${participant.id} · ${participant.name} · ${participant.provider}/${participant.model}\n  人设：${persona.length > 0 ? persona.replace(/\s+/g, ' ').slice(0, 400) : '（未设置，按默认通用风格判）'}`;
  }).join('\n');

  // Render newest-last, then keep the *tail* that fits: the closing rounds decide
  // the verdict far more than the opening ones, and the report still carries the
  // full transcript.
  const rendered = options.speeches.map((speech) => {
    const label = speech.status === 'ok' ? '' : `（${speech.status}${speech.note !== undefined ? `：${speech.note}` : ''}）`;
    const body = speech.text.length > JUDGE_SPEECH_MAX_CHARS
      ? `${speech.text.slice(0, JUDGE_SPEECH_MAX_CHARS)}\n…（本条超长，已截断）`
      : speech.text;
    return `[第 ${speech.round} 轮 · ${speech.name} / ${speech.provider}:${speech.model}]${label}\n${body}`;
  });
  const kept: string[] = [];
  let used = 0;
  let droppedChars = 0;
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const block = rendered[index] ?? '';
    if (used + block.length > JUDGE_TRANSCRIPT_MAX_CHARS) {
      droppedChars += block.length;
      continue;
    }
    kept.unshift(block);
    used += block.length + 2;
  }
  const transcript = kept.join('\n\n');
  const dimensionSchema = SCORE_DIMENSIONS.map((dimension) => `"${dimension}":<0-100 整数>`).join(',');
  const prompt = [
    `讨论话题：${options.topic}`,
    '',
    '选手名单：',
    roster,
    '',
    `评分维度（每个 0-100 整数）：`,
    ...SCORE_DIMENSIONS.map((dimension) => `- ${dimension}（${SCORE_DIMENSION_LABELS[dimension]}）：${SCORE_DIMENSION_HINTS[dimension]}`),
    '',
    '完整发言记录（按发言顺序）：',
    droppedChars > 0 ? `（较早的 ${droppedChars} 字因超出预算未附上，请基于可见部分评分）` : '',
    transcript.length > 0 ? transcript : '（无有效发言）',
    '',
    '请输出 JSON：',
    `{"scores":[{"id":"<选手 id>",${dimensionSchema},"comment":"<一句话点评，中文，不超过 60 字>"}],"summary":"<整场总结，中文，不超过 200 字>"}`,
    'scores 必须覆盖上面每一位选手 id，不许新增或省略，六个维度一个都不能少。',
  ].filter((line) => line !== '').join('\n');
  return { prompt, droppedChars };
}

/**
 * Run the referee and assemble the final scoreboard.
 * @param llm - the Harness LLM service.
 * @param options - judge target, persona, participants, transcript, per-participant cost, and weights.
 * @returns the verdict; when the judge call fails the six dimensions fall back
 *   to a deterministic heuristic and `judged` is `false`.
 */
export async function runJudge(
  llm: LlmRuntime,
  options: {
    topic: string;
    provider: string;
    model: string;
    persona: string;
    participants: readonly ParticipantConfig[];
    speeches: readonly Speech[];
    /** Cost data per participant id. */
    costByParticipant: Record<string, ParticipantCost>;
    /** Active weights for the six dimensions. */
    weights: Record<ScoreDimension, number>;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<JudgeOutcome> {
  const outputTokens = new Map<string, number>();
  for (const speech of options.speeches) {
    outputTokens.set(
      speech.participantId,
      (outputTokens.get(speech.participantId) ?? 0) + (speech.usage.outputTokens ?? 0),
    );
  }

  const elapsed = { value: 0 };
  let payload: JudgePayload | undefined;
  let note: string | undefined;
  let judgeAt = 0;
  let promptDroppedChars = 0;
  if (options.signal?.aborted !== true) {
    const built = buildJudgePrompt({
      topic: options.topic,
      participants: options.participants,
      speeches: options.speeches,
    });
    promptDroppedChars = built.droppedChars;
    judgeAt = Date.now();
    const outcome = await callModel(llm, {
      provider: options.provider,
      model: options.model,
      system: options.persona.trim().length > 0 ? options.persona : DEFAULT_JUDGE_PERSONA,
      messages: [userMessage(built.prompt)],
      maxTokens: 2_000,
      temperature: 0.2,
      ...options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
      ...options.signal !== undefined ? { signal: options.signal } : {},
    });
    elapsed.value = outcome.elapsedMs;
    if (outcome.ok) {
      payload = parseJudgePayload(outcome.text);
      if (payload === undefined) note = '裁判返回内容不是可解析的 JSON';
    } else {
      note = `裁判调用失败（${outcome.kind}）：${outcome.message}`;
    }
  } else {
    note = '讨论已被终止，未运行裁判';
  }

  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of payload?.scores ?? []) {
    byId.set(String(entry.id ?? ''), entry);
  }
  // A reply full of ids that match nobody is not a judgement. Requiring a
  // participant match is what keeps the report from claiming "已裁判" while every
  // number in it came from the deterministic fallback.
  const matchedParticipants = options.participants.filter((participant) => byId.has(participant.id));
  const judged = payload !== undefined && matchedParticipants.length > 0;
  if (payload !== undefined && !judged) {
    note = `裁判返回的 ${byId.size} 个 id 没有任何一个能对上选手（收到：${[...byId.keys()].slice(0, 5).join('、')}${byId.size > 5 ? '…' : ''}）`;
  } else if (judged && matchedParticipants.length < options.participants.length) {
    const missing = options.participants.filter((participant) => !byId.has(participant.id));
    note = `裁判漏评了 ${missing.map((participant) => participant.name).join('、')}，这些选手按字数估算`;
  }
  const degraded = !judged;

  /** Length of substantive output: the only model-independent signal available. */
  const fallbackScore = (participantId: string): number => {
    const tokens = outputTokens.get(participantId) ?? 0;
    return Math.min(100, Math.round(Math.sqrt(tokens) * 1.8));
  };

  const dimensionOf = (participant: ParticipantConfig, dimension: ScoreDimension): number => {
    if (judged) {
      const entry = byId.get(participant.id);
      if (entry !== undefined && entry[dimension] !== undefined) return clampScore(entry[dimension]);
    }
    // Without a referee, length is the only order-preserving signal; the four
    // qualitative dimensions stay neutral at 50 rather than being invented.
    return dimension === 'attack' || dimension === 'logic' || dimension === 'depth'
      ? fallbackScore(participant.id)
      : 50;
  };

  const draft = options.participants.map((participant) => {
    const dimensions = {} as DimensionScores;
    for (const dimension of SCORE_DIMENSIONS) dimensions[dimension] = dimensionOf(participant, dimension);
    const cost = options.costByParticipant[participant.id];
    return {
      participant,
      dimensions,
      total: weightedTotal(dimensions, options.weights),
      cost,
      outputTokens: outputTokens.get(participant.id) ?? 0,
    };
  });

  const valueScores = computeValueScores(draft.map((entry) => ({
    participantId: entry.participant.id,
    total: entry.total,
    cost: entry.cost?.cost ?? 0,
    measured: entry.cost?.measured === true,
  })));

  const verdict = (entry: { cost?: ParticipantCost }): CostStatus => {
    if (entry.cost?.measured === true) return 'measured';
    // The engine always supplies an entry; a missing one means no ledger at all.
    return entry.cost === undefined ? 'no-ledger' : 'unmeasured';
  };

  const scores: JudgeScore[] = draft.map((entry) => {
    const costStatus = verdict(entry);
    const value = valueScores.get(entry.participant.id);
    const comment = judged
      ? String(byId.get(entry.participant.id)?.comment ?? '').slice(0, 200)
      : '裁判缺席，攻击性/逻辑/深度按有效输出量估算，其余维度记中性 50 分。';
    return {
      participantId: entry.participant.id,
      name: entry.participant.name,
      ...entry.dimensions,
      total: entry.total,
      comment,
      cost: entry.cost?.cost ?? 0,
      costStatus,
      ...value !== undefined ? { value: value.value, valueRank: value.rank } : {},
      outputTokens: entry.outputTokens,
    };
  });
  // Ranked by the six-dimension composite; the cost-efficiency place is reported
  // separately so a cheap-but-mediocre turn cannot top the scoreboard.
  scores.sort((a, b) => b.total - a.total);

  const unmeasured = draft
    .filter((entry) => entry.cost?.measured !== true)
    .map((entry) => ({
      participantId: entry.participant.id,
      name: entry.participant.name,
      reason: entry.cost?.reason ?? '账本不可读或未安装 dsh-cost-meter',
    }));

  const measuredCount = draft.filter((entry) => entry.cost?.measured === true).length;
  const costSource: JudgeOutcome['costSource'] = measuredCount === 0
    ? 'unavailable'
    : measuredCount === draft.length ? 'ledger' : 'partial';

  const champion = scores.find((score) => score.total > 0);
  return {
    judged,
    ...note !== undefined ? { note } : {},
    degraded,
    provider: options.provider,
    model: options.model,
    at: judgeAt,
    scores,
    ...champion !== undefined ? { championId: champion.participantId } : {},
    summary: judged
      ? String(payload?.summary ?? '').slice(0, 800)
      : '裁判模型未能给出有效评分，本场六维分由系统按有效输出量估算（降级状态）。',
    costSource,
    unmeasured,
    valueRanking: [...valueScores.entries()].sort((a, b) => a[1].rank - b[1].rank).map(([id]) => id),
    transcriptDroppedChars: promptDroppedChars,
    elapsedMs: elapsed.value,
  };
}
