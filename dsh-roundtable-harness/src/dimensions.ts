/**
 * The six scoring dimensions.
 *
 * They live in their own module because both `config.ts` (which validates the
 * user's weights) and `judge.ts` (which applies them) need them, and a shared
 * constant avoids dragging `config.ts` into a runtime import cycle.
 *
 * `性价比` is deliberately **not** one of them: a model cannot know what it
 * cost, so cost-effectiveness is derived from the ledger and kept outside the
 * judged composite.
 *
 * @module dsh-roundtable-harness/dimensions
 */

/** Dimension keys, in the order the report and the settings page render them. */
export const SCORE_DIMENSIONS = ['attack', 'logic', 'persona', 'fun', 'strategy', 'depth'] as const;

/** One scoring dimension. */
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

/** Chinese label for each dimension. */
export const SCORE_DIMENSION_LABELS: Record<ScoreDimension, string> = {
  attack: '攻击性',
  logic: '逻辑',
  persona: '人物形象还原度',
  fun: '趣味度',
  strategy: '策略',
  depth: '深度',
};

/** One-line explanation of each dimension, used in the judge prompt and the UI. */
export const SCORE_DIMENSION_HINTS: Record<ScoreDimension, string> = {
  attack: '对他人论点的正面冲击力：有没有真的顶上去，而不是绕开。',
  logic: '论证结构的严密程度：前提、推理、结论是否站得住，有无以偏概全与循环论证。',
  persona: '发言与所指定人设、语言风格的贴合度，有没有出戏或通用 AI 腔。',
  fun: '表达是否有梗、有画面感、让人愿意继续听，而不是干巴巴念稿。',
  strategy: '整场博弈的选择：什么时候强攻、什么时候承认、什么时候换角度，是否服务于赢下这一场。',
  depth: '议题被推进的深度：有没有触及更底层的前提、反例或代价，而不止于表面互喷。',
};

/**
 * Default weights: all six equal.
 *
 * Equal weighting is the honest default — the operator asked for a composite
 * and gave no relative priorities, so inventing a ranking would be an unearned
 * editorial choice. `scoreWeights` in the config overrides any subset.
 */
export const DEFAULT_SCORE_WEIGHTS: Record<ScoreDimension, number> = {
  attack: 1,
  logic: 1,
  persona: 1,
  fun: 1,
  strategy: 1,
  depth: 1,
};

/** One row of a scoreboard: the six judged dimensions. */
export type DimensionScores = Record<ScoreDimension, number>;

/**
 * Repair a user-supplied weight map.
 * Missing, non-finite, or negative entries fall back to the default; an
 * all-zero map collapses to the defaults rather than dividing by zero.
 * @param value - the raw `scoreWeights` value from the document.
 * @returns a complete, finite, non-negative weight map.
 */
export function normalizeScoreWeights(value: unknown): Record<ScoreDimension, number> {
  const raw = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const weights = {} as Record<ScoreDimension, number>;
  for (const dimension of SCORE_DIMENSIONS) {
    const candidate = raw[dimension];
    const numeric = typeof candidate === 'number' ? candidate : Number(candidate);
    weights[dimension] = Number.isFinite(numeric) && numeric >= 0 ? numeric : DEFAULT_SCORE_WEIGHTS[dimension];
  }
  return Object.values(weights).some((weight) => weight > 0) ? weights : { ...DEFAULT_SCORE_WEIGHTS };
}

/**
 * Weighted mean of the six dimensions, on the same 0-100 scale.
 * @param dimensions - the judged scores.
 * @param weights - the active weight map.
 * @returns the composite, rounded to one decimal.
 */
export function weightedTotal(
  dimensions: DimensionScores,
  weights: Record<ScoreDimension, number>,
): number {
  let sum = 0;
  let total = 0;
  for (const dimension of SCORE_DIMENSIONS) {
    const weight = weights[dimension];
    sum += dimensions[dimension] * weight;
    total += weight;
  }
  if (total <= 0) return 0;
  return Math.round((sum / total) * 10) / 10;
}

/** Render the active weights as `攻击性 1 · 逻辑 1 · …` for the report. */
export function describeWeights(weights: Record<ScoreDimension, number>): string {
  return SCORE_DIMENSIONS
    .map((dimension) => `${SCORE_DIMENSION_LABELS[dimension]} ${weights[dimension]}`)
    .join(' · ');
}
