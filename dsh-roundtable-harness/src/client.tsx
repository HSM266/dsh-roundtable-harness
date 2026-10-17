/**
 * The Roundtable settings page (Client half).
 *
 * ## State model
 *
 * This page keeps exactly two configuration objects, and the whole design
 * depends on not mixing them:
 *
 *   - `saved` — what the Host reported from `getState`. Written **only** by a
 *     successful load/save.
 *   - `draft` — the form the user is editing. Changes with each keystroke and
 *     triggers **no** network request.
 *
 * `dirty` is the two compared once per render (memoized). Everything that used
 * to be a symptom — a re-fetch per keystroke, a polling timer rebuilt on every
 * character, a stale snapshot rolling back a fresh save — follows from keeping
 * these apart, so they are not patched individually.
 *
 * ## Rules this file follows
 *
 *   1. `load` is held in a ref and never appears in an effect's dependency list,
 *      so polling is created once per mounted `remote`.
 *   2. Every request carries a monotonic `reqId`; a reply older than the newest
 *      issued request is dropped.
 *   3. When `remote` arrives the page re-renders (`setRemote`), because writing
 *      only a ref leaves a failed mount unrecoverable.
 *   4. `pending` is keyed by operation. A global lock made 「终止讨论」
 *      unreachable while a provider probe was running.
 *   5. Numeric inputs keep their raw text; clamping happens on commit. Binding a
 *      number straight to the input makes multi-digit values impossible to type.
 *   6. Multi-line lists are arrays of rows: Enter appends a row, empty rows are
 *      kept, and nothing `split`s on every keystroke.
 *   7. Every value rendered from the Host goes through `num`/`str`/`arr`, so a
 *      missing field hides one block instead of throwing the page away.
 *   8. Each panel is a pure component taking `draft` and callbacks; all network
 *      calls live in the page component.
 *
 * @module dsh-roundtable-harness/client
 */

import React from 'react';

import {
  SCORE_DIMENSIONS,
  SCORE_DIMENSION_HINTS,
  SCORE_DIMENSION_LABELS,
  type ScoreDimension,
} from './dimensions.js';
import { WIDGET_IMAGE } from './widget-image.js';

/** Package id; must equal the `package.json` name for the loader to bind the factory. */
const PACKAGE = 'dsh-roundtable-harness';
/** Remote namespace exposed by the Host service. */
const NAMESPACE = 'roundtable';
/** Our cell in the settings sidebar. */
const SECTION_ID = 'roundtable';
/** Display position, after memes (25) and before cost-meter (30). */
const SECTION_ORDER = 26;
/** Idle poll cadence (ms): fast while a discussion runs, slow otherwise. */
const POLL_MS = 2_000;
/** Every Nth idle tick also refreshes, so an externally started run is noticed. */
const IDLE_POLL_EVERY = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Wire schemas
//
// The Gateway decodes arguments with the codec's `parse`; strict codecs are
// built from ordinary objects that expose `parse` and nothing else is required.
// ─────────────────────────────────────────────────────────────────────────────

interface WireSchema<T = unknown> {
  parse(value: unknown): T;
}

function strictCodec(typeSymbol: string, schema: WireSchema): {
  mode: 'strict'; typeSymbol: string; schema: WireSchema; create: () => WireSchema;
} {
  return { mode: 'strict', typeSymbol, schema, create: () => schema };
}

function vAny(): WireSchema {
  return { parse: (value) => value };
}

function vString(min: number, max: number): WireSchema<string> {
  return {
    parse: (value) => {
      if (typeof value !== 'string') throw new TypeError('expected string');
      const text = value.length > max ? value.slice(0, max) : value;
      if (text.length < min) throw new TypeError(`expected at least ${min} characters`);
      return text;
    },
  };
}

function vNumber(min: number, max: number): WireSchema<number> {
  return {
    parse: (value) => {
      const numeric = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(numeric)) throw new TypeError('expected number');
      return Math.min(max, Math.max(min, numeric));
    },
  };
}

/** A string list, used by the preview call so the Host screens unsaved rules. */
function vStringList(): WireSchema<string[]> {
  return {
    parse: (value) => {
      if (value === undefined || value === null) return [];
      if (!Array.isArray(value)) throw new TypeError('expected string array');
      return value.map((entry) => String(entry)).slice(0, 500);
    },
  };
}

function jsonParameter(name: string, schema: WireSchema): {
  name: string; wire: string; source: 'json'; codec: ReturnType<typeof strictCodec>;
} {
  return { name, wire: name, source: 'json', codec: strictCodec(name, schema) };
}

function remoteMethod(method: string, parameters: ReturnType<typeof jsonParameter>[]): {
  id: string; service: string; namespace: string; method: string;
  invocation: { kind: 'direct' }; parameters: ReturnType<typeof jsonParameter>[]; result: ReturnType<typeof strictCodec>;
} {
  return {
    id: `${PACKAGE}#${NAMESPACE}/${method}`,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters,
    // Results stay permissive on purpose: a strict result codec turns one
    // malformed field into a thrown decode, which blanks the whole page with no
    // way to see the data. Validation lives in the View instead — every field is
    // read through `num`/`str`/`arr`/`money`, which are total functions.
    result: strictCodec('JsonValue', vAny()),
  };
}

const REMOTE_CONTRIBUTION = {
  package: PACKAGE,
  descriptors: [
    remoteMethod('getState', []),
    remoteMethod('refreshProviders', []),
    remoteMethod('testProvider', [jsonParameter('provider', vString(1, 200))]),
    remoteMethod('saveConfig', [jsonParameter('patch', vAny())]),
    remoteMethod('reloadConfig', []),
    remoteMethod('scanPreview', [
      jsonParameter('text', vString(0, 20_000)),
      jsonParameter('words', vStringList()),
      jsonParameter('patterns', vStringList()),
    ]),
    remoteMethod('startRun', [jsonParameter('topic', vString(0, 2_000)), jsonParameter('rounds', vNumber(0, 20))]),
    remoteMethod('continueRun', [jsonParameter('rounds', vNumber(0, 20))]),
    remoteMethod('stopRun', []),
    remoteMethod('clearRun', []),
    remoteMethod('exportDocx', []),
    remoteMethod('getReport', []),
    remoteMethod('rejudge', []),
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared types (structural mirrors of the Host shapes)
// ─────────────────────────────────────────────────────────────────────────────

interface Participant {
  id: string;
  name: string;
  provider: string;
  model: string;
  persona: string;
  personaFile?: string;
  avatar?: string;
  cheap?: boolean;
}

interface RoundtableConfig {
  version: number;
  topic: string;
  maxRounds: number;
  maxTokensPerTurn: number;
  requestTimeoutMs: number;
  tokenBudget: number;
  keepRecentRounds: number;
  sensitiveThreshold: number;
  outputDir: string;
  participants: Participant[];
  judge: { enabled: boolean; provider: string; model: string; persona: string };
  sensitive: { builtin: boolean; words: string[]; patterns: string[] };
  providerAliases: Record<string, string>;
  scoreWeights: Record<ScoreDimension, number>;
}

interface ProviderOption {
  id: string;
  name: string;
  models: { id: string; name: string }[];
  error?: string;
}

type CostStatus = 'measured' | 'unmeasured' | 'no-ledger';

interface Speech {
  participantId: string;
  name: string;
  provider: string;
  model: string;
  round: number;
  text: string;
  status: string;
  usage?: { outputTokens?: number };
  cost: number;
  costStatus: CostStatus;
  elapsedMs: number;
  sensitiveHits: number;
  note?: string;
}

interface JudgeScore extends Record<ScoreDimension, number> {
  participantId: string;
  name: string;
  total: number;
  comment: string;
  cost: number;
  costStatus: CostStatus;
  value?: number;
  valueRank?: number;
  outputTokens: number;
}

interface JudgeOutcome {
  judged: boolean;
  note?: string;
  degraded: boolean;
  provider: string;
  model: string;
  at: number;
  transcriptDroppedChars?: number;
  scores: JudgeScore[];
  unmeasured: { participantId: string; name: string; reason: string }[];
  valueRanking: string[];
  championId?: string;
  summary: string;
  elapsedMs: number;
}

interface Anomaly {
  at: number;
  round: number;
  kind: string;
  message: string;
  participantId?: string;
}

interface RunState {
  id: string;
  topic: string;
  startedAt: number;
  endedAt?: number;
  status: string;
  stopReason?: string;
  rounds: number;
  plannedRounds: number;
  speeches: Speech[];
  anomalies: Anomaly[];
  judge?: JudgeOutcome;
  lastContextTokens: number;
  totalCost: number;
  costSource: string;
  summary: string;
  weights?: Record<ScoreDimension, number>;
  continuedFrom?: string;
  reportPath?: string;
  docxPath?: string;
  error?: string;
}

interface StateView {
  config: RoundtableConfig;
  providers: ProviderOption[];
  resolvedJudge?: { provider: string; model: string };
  ledger: { path: string; available: boolean; error?: string };
  running: boolean;
  run?: RunState;
  configPath: string;
  personaDir: string;
}

interface PreviewResult {
  hits: string[];
  redacted: string;
  ruleCount: number;
  rejected: string[];
  timedOut: string[];
}

/** The envelope every Client Remote method resolves. */
export interface RemoteResult<T> {
  ok: boolean;
  value?: T;
  error?: { message?: string; code?: string };
}

/** Error carrying the Host's code, so the page can show it. */
export class RemoteCallError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'RemoteCallError';
    this.code = code;
  }
}

/**
 * Unwrap a Remote envelope.
 * A method never rejects; it resolves `{ok:true,value}` or `{ok:false,error}`,
 * so treating the envelope as the payload makes every field `undefined`.
 * @param result - the envelope, or a plain value from a non-gateway namespace.
 * @returns the payload.
 * @throws {RemoteCallError} when the envelope reports a failure.
 */
export function unwrap<T>(result: RemoteResult<T> | T): T {
  if (result !== null && typeof result === 'object' && 'ok' in (result as Record<string, unknown>)) {
    const envelope = result as RemoteResult<T> & { error?: { message?: string; code?: string } | string };
    if (envelope.ok === true) return envelope.value as T;
    const error = envelope.error;
    const message = typeof error === 'string'
      ? error
      : (error?.message ?? '宿主返回了失败但没有错误信息');
    const code = typeof error === 'string' ? undefined : error?.code;
    throw new RemoteCallError(message, code);
  }
  return result as T;
}

/** Raw namespace: every method returns the envelope. */
interface RawRemote {
  getState(): Promise<RemoteResult<StateView>>;
  refreshProviders(): Promise<RemoteResult<ProviderOption[]>>;
  testProvider(provider: string): Promise<RemoteResult<{ ok: boolean; models?: number; message: string }>>;
  saveConfig(patch: RoundtableConfig): Promise<RemoteResult<RoundtableConfig>>;
  reloadConfig(): Promise<RemoteResult<RoundtableConfig>>;
  scanPreview(text: string, words: string[], patterns: string[]): Promise<RemoteResult<PreviewResult>>;
  startRun(topic: string, rounds: number): Promise<RemoteResult<RunState>>;
  continueRun(rounds: number): Promise<RemoteResult<RunState>>;
  stopRun(): Promise<RemoteResult<RunState>>;
  clearRun(): Promise<RemoteResult<boolean>>;
  exportDocx(): Promise<RemoteResult<string>>;
  getReport(): Promise<RemoteResult<string>>;
  rejudge(): Promise<RemoteResult<RunState>>;
}

/** Bound namespace: every method resolves the payload or throws. */
export interface RoundtableRemote {
  getState(): Promise<StateView>;
  refreshProviders(): Promise<ProviderOption[]>;
  testProvider(provider: string): Promise<{ ok: boolean; models?: number; message: string }>;
  saveConfig(patch: RoundtableConfig): Promise<RoundtableConfig>;
  reloadConfig(): Promise<RoundtableConfig>;
  scanPreview(text: string, words: string[], patterns: string[]): Promise<PreviewResult>;
  startRun(topic: string, rounds: number): Promise<RunState>;
  continueRun(rounds: number): Promise<RunState>;
  stopRun(): Promise<RunState>;
  clearRun(): Promise<boolean>;
  exportDocx(): Promise<string>;
  getReport(): Promise<string>;
  rejudge(): Promise<RunState>;
}

/**
 * Bind a raw namespace, unwrapping every call exactly once.
 * @param raw - the namespace from `ctx.get('remote.roundtable')`.
 * @returns the same surface with envelopes removed.
 */
export function bindRemote(raw: RawRemote): RoundtableRemote {
  return {
    getState: () => raw.getState().then((result) => unwrap<StateView>(result)),
    refreshProviders: () => raw.refreshProviders().then((result) => unwrap<ProviderOption[]>(result)),
    testProvider: (provider) => raw.testProvider(provider).then((result) => unwrap<{ ok: boolean; models?: number; message: string }>(result)),
    saveConfig: (patch) => raw.saveConfig(patch).then((result) => unwrap<RoundtableConfig>(result)),
    reloadConfig: () => raw.reloadConfig().then((result) => unwrap<RoundtableConfig>(result)),
    scanPreview: (text, words, patterns) => raw.scanPreview(text, words, patterns).then((result) => unwrap<PreviewResult>(result)),
    startRun: (topic, rounds) => raw.startRun(topic, rounds).then((result) => unwrap<RunState>(result)),
    continueRun: (rounds) => raw.continueRun(rounds).then((result) => unwrap<RunState>(result)),
    stopRun: () => raw.stopRun().then((result) => unwrap<RunState>(result)),
    clearRun: () => raw.clearRun().then((result) => unwrap<boolean>(result)),
    exportDocx: () => raw.exportDocx().then((result) => unwrap<string>(result)),
    getReport: () => raw.getReport().then((result) => unwrap<string>(result)),
    rejudge: () => raw.rejudge().then((result) => unwrap<RunState>(result)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Total helpers
//
// A View must never throw on malformed data: one `undefined.toFixed()` kills the
// whole page's interaction and the cause is invisible from the outside. Every
// value that reaches the DOM goes through one of these.
// ─────────────────────────────────────────────────────────────────────────────

/** Any value as a finite number. */
function num(value: unknown, fallback = 0): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/** Any value as a string. */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Any value as an array. */
function arr<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

/** Any value as a string array, trimmed, with blanks removed. */
function strList(value: unknown): string[] {
  return arr<unknown>(value)
    .map((entry) => String(entry ?? '').trim())
    .filter((entry) => entry.length > 0);
}

/** Format a cost, `—` when unknown. */
function money(value: unknown, digits = 6): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? `$${numeric.toFixed(digits)}` : '—';
}

/** Describe an unknown thrown value. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** Lower-case slug used to derive a participant id from its name; `''` when empty. */
function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[\s\\/:*?"<>|]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug.slice(0, 32);
}

/** Make every id unique, appending `-2`, `-3`… on collisions. */
function uniqueId(candidate: string, taken: Set<string>): string {
  if (!taken.has(candidate)) return candidate;
  let suffix = 2;
  while (taken.has(`${candidate}-${suffix}`)) suffix += 1;
  return `${candidate}-${suffix}`;
}

/** Clamp a number into a range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Whether every weight is zero, which the save path replaces with all-ones. */
export function totalWeightZero(config: { scoreWeights?: Record<string, number> }): boolean {
  return SCORE_DIMENSIONS.every((dimension) => num(config.scoreWeights?.[dimension]) === 0);
}

/**
 * Turn the editing draft into the payload that gets saved.
 *
 * This is the one place where "what the form shows" becomes "what the Host
 * stores", so every rule from the spec lands here instead of being scattered
 * across onChange handlers:
 *
 *   - integers are clamped on submit, never while typing;
 *   - participants without a provider/model are dropped (they are highlighted in
 *     the panel, and the page warns how many will be skipped);
 *   - ids are slugged and made unique with `-2`, `-3` suffixes, which also keeps
 *     `personas/<id>.md` from two speakers colliding on one file;
 *   - all-zero weights fall back to equal weights;
 *   - blank rows in the word/pattern lists are removed.
 * @param draft - the form state.
 * @returns a config safe to send.
 */
export function finalizeDraft(draft: RoundtableConfig): RoundtableConfig {
  const taken = new Set<string>();
  const participants = arr<Participant>(draft.participants)
    .filter((participant) => str(participant.provider).length > 0 && str(participant.model).length > 0)
    .map((participant) => {
      const base = slugify(str(participant.id)) || slugify(str(participant.name)) || 'player';
      const id = uniqueId(base, taken);
      taken.add(id);
      return {
        ...participant,
        id,
        name: str(participant.name, id),
        persona: str(participant.persona),
        avatar: str(participant.avatar),
        cheap: participant.cheap === true,
      };
    });
  const weights = { ...draft.scoreWeights } as Record<ScoreDimension, number>;
  if (totalWeightZero(draft)) {
    // All zero carries no information; equal weights are the documented fallback
    // rather than a division by zero somewhere downstream.
    for (const dimension of SCORE_DIMENSIONS) weights[dimension] = 1;
  }
  return {
    ...draft,
    participants,
    scoreWeights: weights,
    maxRounds: clamp(num(draft.maxRounds, 2), 1, 20),
    maxTokensPerTurn: clamp(num(draft.maxTokensPerTurn, 2_000), 16, 64_000),
    tokenBudget: clamp(num(draft.tokenBudget, 60_000), 512, 1_000_000),
    keepRecentRounds: clamp(num(draft.keepRecentRounds), 0, 10),
    requestTimeoutMs: clamp(num(draft.requestTimeoutMs, 120_000), 1_000, 600_000),
    sensitiveThreshold: clamp(num(draft.sensitiveThreshold, 3), 1, 100),
    topic: str(draft.topic),
    outputDir: str(draft.outputDir),
    judge: {
      enabled: draft.judge?.enabled === true,
      provider: str(draft.judge?.provider),
      model: str(draft.judge?.model),
      persona: str(draft.judge?.persona),
    },
    sensitive: {
      builtin: draft.sensitive?.builtin === true,
      words: strList(draft.sensitive?.words),
      patterns: strList(draft.sensitive?.patterns),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const CSS = `
.rt-root{display:flex;flex:1 1 auto;min-height:0;min-width:0;flex-direction:column;gap:14px;padding:0 0 24px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.rt-scroll{display:flex;flex-direction:column;gap:14px;min-height:0;overflow:auto;padding-right:4px}
.rt-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.rt-card>h3{margin:0;font-size:13px;font-weight:600}
.rt-card>p.rt-desc{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.rt-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.rt-field>label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-field>small{font-size:11px;color:var(--dsw-alias-label-secondary)}
.rt-field.rt-invalid>label{color:var(--dsw-alias-state-error-primary)}
input.rt-input,select.rt-input,textarea.rt-input{box-sizing:border-box;width:100%;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;outline:none}
input.rt-input:focus,select.rt-input:focus,textarea.rt-input:focus{border-color:var(--dsw-alias-brand-primary)}
input.rt-input.rt-bad,select.rt-input.rt-bad{border-color:var(--dsw-alias-state-error-primary)}
textarea.rt-input{resize:vertical;min-height:64px;font-family:inherit}
textarea.rt-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
button.rt-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
button.rt-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,var(--dsw-alias-bg-layer-2))}
button.rt-btn:disabled{opacity:.5;cursor:not-allowed}
button.rt-btn.rt-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
button.rt-btn.rt-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
button.rt-btn.rt-tiny{padding:1px 6px;font-size:11px}
.rt-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-secondary)}
.rt-ok{color:var(--dsw-alias-state-success-primary)}
.rt-warn{color:var(--dsw-alias-state-warn-primary)}
.rt-err{color:var(--dsw-alias-state-error-primary)}
.rt-participant{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-base)}
.rt-participant.rt-invalid{border-color:var(--dsw-alias-state-error-primary)}
.rt-list{display:flex;flex-direction:column;gap:10px}
.rt-provider{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:4px;background:var(--dsw-alias-bg-base)}
.rt-models{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.rt-lines{display:flex;flex-direction:column;gap:4px}
.rt-line{display:flex;align-items:center;gap:6px}
.rt-line>span{width:20px;text-align:right;font-size:11px;color:var(--dsw-alias-label-secondary)}
.rt-speech{border-left:2px solid var(--dsw-alias-border-l1);padding-left:10px;display:flex;flex-direction:column;gap:2px}
.rt-speech-head{font-size:12px;font-weight:600}
.rt-speech-meta{font-size:11px;color:var(--dsw-alias-label-secondary)}
.rt-speech-body{white-space:pre-wrap;word-break:break-word}
.rt-table{width:100%;border-collapse:collapse;font-size:12px}
.rt-table th,.rt-table td{border-bottom:1px solid var(--dsw-alias-border-l1);padding:4px 6px;text-align:left;vertical-align:top}
.rt-table td.rt-num{text-align:right;font-variant-numeric:tabular-nums}
.rt-pre{margin:0;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px}
.rt-sticky{position:sticky;top:0;z-index:2;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 0;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-banner{border-radius:8px;padding:8px 10px;font-size:12px;border:1px solid var(--dsw-alias-border-l1)}
.rt-foot-btn{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;text-align:left}
.rt-foot-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.rt-foot-btn.rt-foot-btn-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}
.rt-foot-btn.rt-foot-btn-rail{width:auto;justify-content:center;padding:6px}
.rt-widget{position:fixed;z-index:61;width:56px;height:56px;padding:0;border:none;background:transparent;box-shadow:none;line-height:0;cursor:grab;touch-action:none;user-select:none;filter:drop-shadow(0 3px 6px rgba(0,0,0,.28));transition:transform .12s ease}
.rt-widget:hover{transform:scale(1.06)}
.rt-widget.rt-widget-dragging{transform:scale(1.04);cursor:grabbing;transition:none}
.rt-widget:active{cursor:grabbing;transform:scale(.98)}
.rt-widget>img{display:block;width:100%;height:100%;object-fit:contain;pointer-events:none;-webkit-user-drag:none}
.rt-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.42)}
.rt-window{display:flex;flex-direction:column;width:min(1040px,100%);height:min(86vh,900px);border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);box-shadow:0 24px 64px rgba(0,0,0,.35);overflow:hidden}
.rt-window-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:13px}
.rt-window-body{flex:1 1 auto;min-height:0;overflow:auto;padding:12px 16px}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Primitives (stateless)
// ─────────────────────────────────────────────────────────────────────────────

/** One titled panel. */
function Panel(props: { title: string; description?: string; children?: React.ReactNode }): React.ReactElement {
  return (
    <section className="rt-card">
      <h3>{props.title}</h3>
      {props.description !== undefined ? <p className="rt-desc">{props.description}</p> : null}
      {props.children}
    </section>
  );
}

/** One labelled field. */
function Field(props: { label: string; hint?: string; invalid?: boolean; children: React.ReactNode }): React.ReactElement {
  return (
    <div className={`rt-field${props.invalid === true ? ' rt-invalid' : ''}`}>
      <label>{props.label}</label>
      {props.children}
      {props.hint !== undefined ? <small>{props.hint}</small> : null}
    </div>
  );
}

/** A checkbox with a label. */
function Toggle(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }): React.ReactElement {
  return (
    <label className="rt-row" style={{ cursor: 'pointer' }}>
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      <span>{props.label}</span>
    </label>
  );
}

/**
 * Parse one numeric input's text into a committed value.
 *
 * Kept pure so the two rules that matter — "can I type `100000`?" and "does `0.1`
 * survive?" — are testable without a DOM. `undefined` means "not a value yet":
 * the field keeps the text and commits nothing, which is what lets an empty box
 * and a lone `.` exist while typing.
 * @param raw - the input text.
 * @param min - lower bound applied on commit.
 * @param max - upper bound applied on commit.
 * @param decimals - accepted decimal places; 0 means integers only.
 * @returns the clamped, rounded value, or `undefined`.
 */
export function parseNumericInput(raw: string, min: number, max: number, decimals = 0): number | undefined {
  const pattern = decimals > 0 ? /^\d*\.?\d*$/ : /^\d*$/;
  if (!pattern.test(raw)) return undefined;
  if (raw.length === 0 || raw === '.') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  const clamped = Math.min(max, Math.max(min, parsed));
  return decimals > 0 ? Number(clamped.toFixed(decimals)) : Math.round(clamped);
}

/**
 * A numeric field that keeps its own text.
 *
 * Binding a `number` to `<input type="number">` makes intermediate states
 * impossible: clearing the field becomes `0`, and typing `100` passes through
 * `1` → `0`. The text lives here; the number is committed when it parses, and
 * clamping to `min`/`max` happens on commit and on blur — never mid-typing.
 *
 * Decimals are accepted when `decimals > 0`: the weights are relative values and
 * `0.1` is a meaningful one.
 */
function NumberField(props: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  /** Accepted decimal places; 0 means integers only (the default). */
  decimals?: number;
  /** Called with a clamped, rounded value whenever the text parses. */
  onCommit: (value: number) => void;
}): React.ReactElement {
  const decimals = props.decimals ?? 0;
  const pattern = decimals > 0 ? /^\d*\.?\d*$/ : /^\d*$/;
  const [text, setText] = React.useState(() => `${props.value}`);
  const committed = React.useRef(props.value);
  React.useEffect(() => {
    if (props.value !== committed.current) {
      committed.current = props.value;
      setText(`${props.value}`);
    }
  }, [props.value]);
  return (
    <Field label={props.label} {...props.hint !== undefined ? { hint: props.hint } : {}}>
      <input
        className="rt-input"
        type="text"
        inputMode={decimals > 0 ? 'decimal' : 'numeric'}
        value={text}
        onChange={(event) => {
          const raw = event.target.value;
          // Reject characters that cannot belong in this field at all, then keep
          // whatever the user typed — `.` and an empty box are mid-typing states.
          if (!pattern.test(raw)) return;
          setText(raw);
          const next = parseNumericInput(raw, props.min, props.max, decimals);
          if (next === undefined) return;
          committed.current = next;
          props.onCommit(next);
        }}
        onBlur={() => {
          // Converge the visible text to what was actually accepted.
          const next = parseNumericInput(text, props.min, props.max, decimals) ?? committed.current;
          setText(`${next}`);
          committed.current = next;
          props.onCommit(next);
        }}
      />
    </Field>
  );
}

/**
 * A multi-line list editor backed by an array of rows.
 *
 * Enter appends an empty row, Backspace on an empty row removes it, and blank
 * rows survive until save — a `split('\n').filter(Boolean)` on every keystroke
 * deletes the newline the user just typed, which is why that approach made this
 * feature unusable.
 */
function LinesField(props: {
  label: string;
  hint?: string;
  values: string[];
  mono?: boolean;
  placeholder?: string;
  onChange: (values: string[]) => void;
}): React.ReactElement {
  const rows = props.values.length > 0 ? props.values : [''];
  const commit = (next: string[]): void => props.onChange(next);
  return (
    <Field label={props.label} {...props.hint !== undefined ? { hint: props.hint } : {}}>
      <div className="rt-lines">
        {rows.map((value, index) => (
          <div className="rt-line" key={index}>
            <span>{index + 1}</span>
            <input
              className={`rt-input${props.mono === true ? ' rt-mono' : ''}`}
              value={value}
              placeholder={props.placeholder}
              onChange={(event) => {
                const next = [...rows];
                next[index] = event.target.value;
                commit(next);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  const next = [...rows];
                  next.splice(index + 1, 0, '');
                  commit(next);
                } else if (event.key === 'Backspace' && rows[index] === '' && rows.length > 1) {
                  event.preventDefault();
                  const next = rows.filter((_, position) => position !== index);
                  commit(next);
                }
              }}
            />
            <button
              className="rt-btn rt-tiny"
              title="删除这一行"
              onClick={() => commit(rows.filter((_, position) => position !== index))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="rt-row">
        <button className="rt-btn rt-tiny" onClick={() => commit([...rows, ''])}>+ 新增一行</button>
      </div>
    </Field>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Error boundary
//
// A settings section is one entry in the host's slot list: if it throws while
// rendering, the shell reports a broken slot and the user is left with a blank
// page and no way back. The boundary keeps the failure inside our cell, shows
// enough of it to be reportable, and accepts a `resetKey` so a retry can clear
// the state that caused it.
// ─────────────────────────────────────────────────────────────────────────────

interface BoundaryProps {
  children?: React.ReactNode;
  /** Bumped by the parent to clear the caught error. */
  resetKey?: number;
  /** When provided, the retry button delegates to the parent (real state). */
  onRetry?: () => void;
}
interface BoundaryState { error?: Error; attempt: number }

class PanelErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { attempt: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }

  componentDidUpdate(previous: BoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error !== undefined) {
      this.setState((current) => ({ error: undefined, attempt: current.attempt + 1 }));
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[roundtable] 设置页渲染崩溃：', error, info.componentStack);
  }

  render(): React.ReactNode {
    const { error, attempt } = this.state;
    if (error === undefined) {
      // The key remounts the subtree on retry: re-rendering the same broken state
      // would just crash again.
      return <React.Fragment key={attempt}>{this.props.children}</React.Fragment>;
    }
    return (
      <div className="rt-root">
        <style>{CSS}</style>
        <Panel title="圆桌会议（渲染出错）">
          <p className="rt-err">{error.message}</p>
          <p className="rt-desc">
            这个错误被限制在「圆桌会议」这一页里，宿主的其他设置页不受影响。
            点「重试渲染」会用干净的状态重建本页；把上面这行文字发给插件作者即可定位。
          </p>
          <div className="rt-row">
            <button
              className="rt-btn"
              onClick={() => {
                if (this.props.onRetry !== undefined) {
                  // The parent owns the counter; its new resetKey clears us.
                  this.props.onRetry();
                  return;
                }
                this.setState((current) => ({ error: undefined, attempt: current.attempt + 1 }));
              }}
            >
              重试渲染
            </button>
          </div>
          {error.stack !== undefined ? <pre className="rt-pre">{error.stack.slice(0, 2_000)}</pre> : null}
        </Panel>
      </div>
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Panels
// ─────────────────────────────────────────────────────────────────────────────

/** ① Provider catalog: read-only list plus per-provider connectivity probes. */
function ProviderPanel(props: {
  providers: ProviderOption[];
  probing: string | undefined;
  onProbe: (provider: ProviderOption) => void;
  parsing: boolean;
  onRefresh: () => void;
  aliases: Record<string, string>;
}): React.ReactElement {
  return (
    <Panel
      title="① Provider 目录"
      description="直接读取 DSH 已配置的全部 Provider 与模型（Yomi、百炼/灵途、DeepSeek 官方…）。增删 Provider 与 API Key 请到「设置 → 模型」页，密钥由 DSH 凭据库托管，本插件不落盘任何密钥。"
    >
      <div className="rt-row">
        <button className="rt-btn" disabled={props.probing !== undefined} onClick={() => props.onRefresh()}>
          {props.parsing ? '正在刷新…' : '刷新目录（跳过 5 秒缓存）'}
        </button>
        {Object.keys(props.aliases).length > 0 ? (
          <span className="rt-chip">
            别名：{Object.entries(props.aliases).map(([alias, target]) => `${alias}→${target}`).join('、')}
          </span>
        ) : null}
      </div>
      <div className="rt-list">
        {props.providers.length === 0 ? <p className="rt-desc">没有发现任何 Provider。</p> : null}
        {props.providers.map((provider) => (
          <div className="rt-provider" key={provider.id}>
            <div className="rt-row">
              <strong>{provider.id}</strong>
              <span className="rt-chip">{provider.name}</span>
              <span className="rt-chip">{arr<unknown>(provider.models).length} 个模型</span>
              {provider.error !== undefined ? <span className="rt-chip rt-warn">{provider.error}</span> : null}
              <button
                className="rt-btn"
                disabled={props.probing !== undefined}
                onClick={() => props.onProbe(provider)}
              >
                {props.probing === provider.id ? '正在测试…' : '测试连通性'}
              </button>
            </div>
            {arr<{ id: string }>(provider.models).length > 0 ? (
              <div className="rt-models">{arr<{ id: string }>(provider.models).map((model) => str(model.id)).join(' · ')}</div>
            ) : null}
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** ② Participants: one card per speaker. */
function ParticipantPanel(props: {
  participants: Participant[];
  providers: ProviderOption[];
  onChange: (participants: Participant[]) => void;
}): React.ReactElement {
  const modelsOf = (providerId: string): { id: string; name: string }[] =>
    arr<{ id: string; name: string }>(props.providers.find((entry) => entry.id === providerId)?.models);

  const update = (index: number, mutate: (participant: Participant) => void): void => {
    const next = props.participants.map((entry, position) => {
      if (position !== index) return entry;
      const copy = { ...entry };
      mutate(copy);
      return copy;
    });
    props.onChange(next);
  };

  return (
    <Panel
      title="② 参赛选手"
      description="每位选手绑定一个 Provider/模型，并单独注入拟人化人设。人设会镜像到 personas/<id>.md，保存后直接改那个 md 文件也会在下一次发言时生效。ID 默认由名字生成；手动改过之后就不再跟随名字。"
    >
      <div className="rt-row">
        <button
          className="rt-btn"
          onClick={() => {
            const taken = new Set(props.participants.map((entry) => entry.id));
            const first = props.providers[0];
            props.onChange([...props.participants, {
              id: uniqueId(`player-${props.participants.length + 1}`, taken),
              name: `选手 ${props.participants.length + 1}`,
              provider: str(first?.id),
              model: str(arr<{ id: string }>(first?.models)[0]?.id),
              persona: '',
              avatar: '',
              cheap: false,
            }]);
          }}
        >
          + 添加选手
        </button>
        {props.providers.length === 0 ? <span className="rt-chip rt-warn">先到「设置 → 模型」配一个 Provider</span> : null}
      </div>
      <div className="rt-list">
        {props.participants.length === 0 ? <p className="rt-desc">还没有选手。没有选手时无法开始讨论。</p> : null}
        {props.participants.map((participant, index) => {
          const complete = participant.provider.length > 0 && participant.model.length > 0;
          return (
            <div className={`rt-participant${complete ? '' : ' rt-invalid'}`} key={`${participant.id}-${index}`}>
              <div className="rt-grid">
                <Field label="名字" hint="会出现在战报里">
                  <input
                    className="rt-input"
                    value={str(participant.name)}
                    onChange={(event) => update(index, (next) => {
                      const before = slugify(next.name);
                      next.name = event.target.value;
                      // Follow the name only while the id is still derived from it.
                      if (next.id === before || next.id.length === 0) next.id = slugify(next.name);
                    })}
                  />
                </Field>
                <Field label="ID" hint="人设文件名；重复时保存会自动加后缀">
                  <input
                    className="rt-input rt-mono"
                    value={str(participant.id)}
                    onChange={(event) => update(index, (next) => { next.id = slugify(event.target.value); })}
                  />
                </Field>
                <Field label="Provider" invalid={!complete}>
                  <select
                    className={`rt-input${complete ? '' : ' rt-bad'}`}
                    value={str(participant.provider)}
                    onChange={(event) => update(index, (next) => {
                      next.provider = event.target.value;
                      const first = modelsOf(event.target.value)[0];
                      next.model = str(first?.id);
                    })}
                  >
                    <option value="">（未选择）</option>
                    {props.providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>{provider.id}</option>
                    ))}
                  </select>
                </Field>
                <Field label="模型" invalid={!complete}>
                  <select
                    className={`rt-input${complete ? '' : ' rt-bad'}`}
                    value={str(participant.model)}
                    onChange={(event) => update(index, (next) => { next.model = event.target.value; })}
                  >
                    <option value="">（未选择）</option>
                    {modelsOf(participant.provider).map((model) => (
                      <option key={model.id} value={model.id}>{str(model.name, model.id)}</option>
                    ))}
                    {participant.model.length > 0 && !modelsOf(participant.provider).some((model) => model.id === participant.model)
                      ? <option value={str(participant.model)}>{participant.model}（目录里没有）</option>
                      : null}
                  </select>
                </Field>
              </div>
              <Field label="人设" hint="注入该次调用的 system prompt；留空则用通用辩论风格">
                <textarea
                  className="rt-input"
                  rows={3}
                  value={str(participant.persona)}
                  onChange={(event) => update(index, (next) => { next.persona = event.target.value; })}
                />
              </Field>
              <div className="rt-grid">
                <Field label="形象图" hint="本地路径（相对导出目录或绝对）或 http(s) URL；导出失败会记入异常章节">
                  <input
                    className="rt-input"
                    value={str(participant.avatar)}
                    onChange={(event) => update(index, (next) => { next.avatar = event.target.value; })}
                  />
                </Field>
                <Field label="压缩摘要优先用它" hint="标记为低成本模型">
                  <Toggle
                    label="低成本"
                    checked={participant.cheap === true}
                    onChange={(checked) => update(index, (next) => { next.cheap = checked; })}
                  />
                </Field>
              </div>
              <div className="rt-row">
                <button
                  className="rt-btn rt-danger rt-tiny"
                  onClick={() => props.onChange(props.participants.filter((_, position) => position !== index))}
                >
                  删除该选手
                </button>
                {complete ? null : <span className="rt-chip rt-warn">未选 Provider/模型：保存时会被跳过</span>}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/** ③ Judge. */
function JudgePanel(props: {
  judge: RoundtableConfig['judge'];
  providers: ProviderOption[];
  resolved?: { provider: string; model: string };
  onChange: (judge: RoundtableConfig['judge']) => void;
}): React.ReactElement {
  const models = arr<{ id: string; name: string }>(props.providers.find((entry) => entry.id === props.judge.provider)?.models);
  return (
    <Panel
      title="③ 裁判"
      description="讨论结束后由裁判按六维打分。provider/model 留空时按 JUDGE_MODEL 环境变量或 qwen 路由解析。裁判也是模型：跑完会标「AI 裁判自动生成」，并区分「正常」与「降级」。"
    >
      <Toggle
        label="启用裁判"
        checked={props.judge.enabled}
        onChange={(checked) => props.onChange({ ...props.judge, enabled: checked })}
      />
      <div className="rt-grid">
        <Field label="Provider" hint="留空则自动解析">
          <select
            className="rt-input"
            value={str(props.judge.provider)}
            onChange={(event) => props.onChange({ ...props.judge, provider: event.target.value })}
          >
            <option value="">（自动解析）</option>
            {props.providers.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.id}</option>
            ))}
          </select>
        </Field>
        <Field label="模型" hint="留空则自动解析">
          <select
            className="rt-input"
            value={str(props.judge.model)}
            onChange={(event) => props.onChange({ ...props.judge, model: event.target.value })}
          >
            <option value="">（自动解析）</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>{str(model.name, model.id)}</option>
            ))}
            {props.judge.model.length > 0 && !models.some((model) => model.id === props.judge.model)
              ? <option value={str(props.judge.model)}>{props.judge.model}（目录里没有）</option>
              : null}
          </select>
        </Field>
      </div>
      {props.resolved !== undefined ? (
        <span className="rt-chip rt-ok">当前实际裁判：{props.resolved.provider}/{props.resolved.model}</span>
      ) : (
        <span className="rt-chip rt-warn">当前解析不到裁判模型，本场不会出分</span>
      )}
      <Field label="裁判人格" hint="留空使用内置毒舌裁判">
        <textarea
          className="rt-input"
          rows={4}
          value={str(props.judge.persona)}
          onChange={(event) => props.onChange({ ...props.judge, persona: event.target.value })}
        />
      </Field>
    </Panel>
  );
}

/** ④ Six scoring weights. */
function WeightPanel(props: {
  weights: Record<ScoreDimension, number>;
  onChange: (weights: Record<ScoreDimension, number>) => void;
}): React.ReactElement {
  const allZero = SCORE_DIMENSIONS.every((dimension) => num(props.weights?.[dimension]) === 0);
  return (
    <Panel
      title="④ 六维权重"
      description="总分为六个维度的加权平均（0-100）。权重是相对值：各项都填 1 就等于等权平均。"
    >
      <div className="rt-grid">
        {SCORE_DIMENSIONS.map((dimension) => (
          <NumberField
            key={dimension}
            label={SCORE_DIMENSION_LABELS[dimension]}
            hint={SCORE_DIMENSION_HINTS[dimension]}
            value={num(props.weights?.[dimension])}
            min={0}
            max={100}
            decimals={2}
            onCommit={(value) => props.onChange({ ...props.weights, [dimension]: value })}
          />
        ))}
      </div>
      {allZero ? (
        <p className="rt-desc rt-warn">六项全为 0：保存时会回退到「全 1」的等权平均，否则总分无意义。</p>
      ) : null}
    </Panel>
  );
}

/** ⑤ Discussion parameters. */
function RunParamsPanel(props: {
  draft: RoundtableConfig;
  onChange: (mutate: (next: RoundtableConfig) => void) => void;
  pickDirectory?: () => Promise<string | undefined>;
  picking: boolean;
  onPick: () => void;
}): React.ReactElement {
  const patch = props.onChange;
  return (
    <Panel title="⑤ 讨论参数" description="这些值决定一次讨论怎么跑。数字在保存时才收敛到合法范围，输入框不会强行改写。">
      <div className="rt-grid">
        <Field label="默认话题">
          <input
            className="rt-input"
            value={str(props.draft.topic)}
            onChange={(event) => patch((next) => { next.topic = event.target.value; })}
          />
        </Field>
        <NumberField
          label="轮数 maxRounds" hint="1 – 20"
          value={num(props.draft.maxRounds, 2)} min={1} max={20}
          onCommit={(value) => patch((next) => { next.maxRounds = value; })}
        />
        <NumberField
          label="单次 max_tokens" hint="16 – 64000；思考型模型建议 2000 起"
          value={num(props.draft.maxTokensPerTurn, 2_000)} min={16} max={64_000}
          onCommit={(value) => patch((next) => { next.maxTokensPerTurn = value; })}
        />
        <NumberField
          label="tokenBudget" hint="512 – 1000000；上下文超过它先压缩旧轮次"
          value={num(props.draft.tokenBudget, 60_000)} min={512} max={1_000_000}
          onCommit={(value) => patch((next) => { next.tokenBudget = value; })}
        />
        <NumberField
          label="保留最近轮数（原文）" hint="0 – 10"
          value={num(props.draft.keepRecentRounds)} min={0} max={10}
          onCommit={(value) => patch((next) => { next.keepRecentRounds = value; })}
        />
        <NumberField
          label="请求超时 (ms)" hint="1000 – 600000"
          value={num(props.draft.requestTimeoutMs, 120_000)} min={1_000} max={600_000}
          onCommit={(value) => patch((next) => { next.requestTimeoutMs = value; })}
        />
        <NumberField
          label="敏感命中阈值" hint="1 – 100；累计命中达到它就终止讨论"
          value={num(props.draft.sensitiveThreshold, 3)} min={1} max={100}
          onCommit={(value) => patch((next) => { next.sensitiveThreshold = value; })}
        />
      </div>
      <Field label="输出目录" hint="留空 = 宿主进程工作目录；战报与 docx 写在这里">
        <div className="rt-row">
          <input
            className="rt-input"
            style={{ flex: '1 1 260px' }}
            value={str(props.draft.outputDir)}
            onChange={(event) => patch((next) => { next.outputDir = event.target.value; })}
          />
          {props.pickDirectory !== undefined ? (
            <button className="rt-btn" disabled={props.picking} onClick={() => props.onPick()}>
              {props.picking ? '选择中…' : '浏览…'}
            </button>
          ) : null}
        </div>
      </Field>
    </Panel>
  );
}

/** ⑥ Sensitive word list. */
function SensitivePanel(props: {
  sensitive: RoundtableConfig['sensitive'];
  onChange: (sensitive: RoundtableConfig['sensitive']) => void;
  previewText: string;
  onPreviewText: (text: string) => void;
  preview: PreviewResult | undefined;
  scanning: boolean;
  onScan: () => void;
}): React.ReactElement {
  return (
    <Panel
      title="⑥ 敏感词库"
      description="讨论开始前扫描话题与全部人设，每次发言后再扫描一遍；命中即替换为 [内容已过滤] 并记入异常记录，累计超过阈值就终止。扫描前会做 Unicode（NFKC）折叠，全角字绕不过去。"
    >
      <Toggle
        label="启用内置中英文基础词库"
        checked={props.sensitive.builtin}
        onChange={(checked) => props.onChange({ ...props.sensitive, builtin: checked })}
      />
      <LinesField
        label="自定义敏感词"
        hint="一行一个，大小写不敏感，按字面匹配；回车新增一行，空行不会丢"
        values={arr<string>(props.sensitive.words)}
        placeholder="例如：某个不该出现的词"
        onChange={(values) => props.onChange({ ...props.sensitive, words: values })}
      />
      <LinesField
        label="自定义正则规则"
        hint="一行一条。零宽匹配（\b、前瞻/后顾）、嵌套量词（如 (a+)+）、反向引用会被拒绝并列出原因；被拒的条目不影响其他条保存"
        values={arr<string>(props.sensitive.patterns)}
        mono
        placeholder="例如：(?i)secret\s+plan"
        onChange={(values) => props.onChange({ ...props.sensitive, patterns: values })}
      />
      <Field label="试扫" hint="用的是当前编辑中的词库，不要求先保存">
        <div className="rt-row">
          <input
            className="rt-input"
            style={{ flex: '1 1 260px' }}
            placeholder="输入一段话，看当前词库怎么过滤"
            value={props.previewText}
            onChange={(event) => props.onPreviewText(event.target.value)}
          />
          <button className="rt-btn" disabled={props.scanning || props.previewText.length === 0} onClick={() => props.onScan()}>
            {props.scanning ? '扫描中…' : '试扫'}
          </button>
        </div>
      </Field>
      {props.preview !== undefined ? (
        <div className="rt-banner">
          生效规则 {num(props.preview.ruleCount)} 条 · 命中 {arr<string>(props.preview.hits).length} 条
          {arr<string>(props.preview.hits).length > 0 ? `（${arr<string>(props.preview.hits).join('、')}）` : ''}
          {arr<string>(props.preview.rejected).length > 0
            ? <div className="rt-err">被拒绝的规则：{arr<string>(props.preview.rejected).join('；')}</div>
            : null}
          {arr<string>(props.preview.timedOut).length > 0
            ? <div className="rt-warn">超时被停用：{arr<string>(props.preview.timedOut).join('、')}</div>
            : null}
          <div className="rt-pre" style={{ marginTop: 6 }}>{str(props.preview.redacted)}</div>
        </div>
      ) : null}
    </Panel>
  );
}

/** ⑦ Run, watch, export. */
function RunPanel(props: {
  state: StateView;
  run?: RunState;
  topic: string;
  rounds: number;
  onTopic: (topic: string) => void;
  onRounds: (rounds: number) => void;
  report?: string;
  onStart: () => void;
  onStop: () => void;
  onContinue: () => void;
  onExport: () => void;
  onRejudge: () => void;
  onClear: () => void;
  onReport: () => void;
  pending: Record<string, boolean>;
  dirty: boolean;
}): React.ReactElement {
  const run = props.run;
  const judge = run?.judge;
  const scores = arr<JudgeScore>(judge?.scores);
  const speeches = arr<Speech>(run?.speeches);
  const anomalies = arr<Anomaly>(run?.anomalies);
  const valueRanking = arr<string>(judge?.valueRanking);
  const unmeasured = arr<{ name: string; reason: string }>(judge?.unmeasured);
  const attributed = speeches.filter((speech) => speech.costStatus === 'measured').length;
  const running = props.state.running;
  return (
    <Panel title="⑦ 开一场" description="结束后自动写出 Markdown《赛博圆桌战报》，可再导出 docx。">
      <div className="rt-row">
        <input
          className="rt-input"
          style={{ flex: '1 1 280px' }}
          placeholder="临时话题（留空用上面保存的话题）"
          value={props.topic}
          onChange={(event) => props.onTopic(event.target.value)}
        />
        <NumberField
          label="轮数"
          value={props.rounds} min={1} max={20}
          onCommit={(value) => props.onRounds(value)}
        />
        <button
          className="rt-btn rt-primary"
          disabled={running || props.dirty || props.pending.start === true}
          onClick={() => props.onStart()}
        >
          {props.pending.start === true ? '正在启动…' : '开始讨论'}
        </button>
        {/* Never disabled by an unrelated operation: a probe must not be able to
            lock the user out of stopping a live discussion. */}
        <button className="rt-btn rt-danger" disabled={!running} onClick={() => props.onStop()}>
          终止讨论
        </button>
        <button
          className="rt-btn"
          disabled={running || run === undefined || speeches.length === 0 || props.pending.continue === true}
          onClick={() => props.onContinue()}
        >
          续前讨论
        </button>
        <button
          className="rt-btn"
          disabled={running || run === undefined || props.pending.export === true}
          onClick={() => props.onExport()}
        >
          导出 docx
        </button>
        <button
          className="rt-btn"
          disabled={running || run === undefined || props.pending.rejudge === true}
          onClick={() => props.onRejudge()}
        >
          重新裁判
        </button>
        <button
          className="rt-btn"
          disabled={run === undefined || props.pending.report === true}
          onClick={() => props.onReport()}
        >
          查看战报
        </button>
        <button
          className="rt-btn"
          disabled={running || run === undefined || props.pending.clear === true}
          onClick={() => props.onClear()}
        >
          清空记录
        </button>
        {props.dirty ? <span className="rt-chip rt-warn">有未保存改动，先保存再开</span> : null}
      </div>

      {run !== undefined ? (
        <>
          <div className="rt-row">
            <span className="rt-chip">状态 {str(run.status, '—')}</span>
            <span className="rt-chip">轮次 {num(run.rounds)}/{num(run.plannedRounds)}</span>
            <span className="rt-chip">终止 {str(run.stopReason, '—')}</span>
            <span className="rt-chip">发言 {speeches.length}</span>
            <span className="rt-chip">总花费 {money(run.totalCost)}</span>
            <span className={`rt-chip ${str(run.costSource) === 'ledger' ? 'rt-ok' : 'rt-warn'}`}>
              口径 {str(run.costSource) === 'ledger' ? '真实账本（全员已归因）'
                : str(run.costSource) === 'partial' ? '真实账本（部分归因失败）'
                  : '不可用（未读到账本）'}
            </span>
            <span className="rt-chip">上下文估算 {num(run.lastContextTokens)}</span>
            {run.continuedFrom !== undefined ? <span className="rt-chip">续接自 {str(run.continuedFrom)}</span> : null}
            {run.reportPath !== undefined ? <span className="rt-chip">战报 {str(run.reportPath)}</span> : null}
            {run.docxPath !== undefined ? <span className="rt-chip">docx {str(run.docxPath)}</span> : null}
          </div>

          {judge !== undefined && scores.length > 0 ? (
            <>
              <div className="rt-banner rt-warn">
                ⚠️ 本内容由 AI 裁判自动生成，可能存在错误，不构成权威结论。
              </div>
              <div className="rt-row">
                <span className="rt-chip">
                  裁判 {str(judge.model).length > 0 ? `${str(judge.provider)}/${str(judge.model)}` : '未记录'}
                </span>
                <span className="rt-chip">
                  出分时间 {num(judge.at) > 0 ? new Date(num(judge.at)).toLocaleString('zh-CN') : '—'}
                </span>
                <span className={`rt-chip ${judge.degraded ? 'rt-err' : 'rt-ok'}`}>
                  {judge.degraded ? '⚠️ 降级：字数估算，非模型评分' : '裁判正常'}
                </span>
                {judge.note !== undefined ? <span className="rt-chip rt-warn">{str(judge.note)}</span> : null}
                {num(judge.transcriptDroppedChars) > 0
                  ? <span className="rt-chip rt-warn">裁判只看到部分发言（省略 {num(judge.transcriptDroppedChars)} 字）</span>
                  : null}
              </div>
              <table className="rt-table">
                <thead>
                  <tr>
                    <th>名次</th><th>选手</th>
                    {SCORE_DIMENSIONS.map((dimension) => (
                      <th key={dimension} title={SCORE_DIMENSION_HINTS[dimension]}>
                        {SCORE_DIMENSION_LABELS[dimension]}
                      </th>
                    ))}
                    <th>总分</th><th>花费</th><th>口径</th><th>点评</th>
                  </tr>
                </thead>
                <tbody>
                  {scores.map((score, index) => (
                    <tr key={str(score.participantId, `${index}`)}>
                      <td>{judge.championId === score.participantId ? '🏆 ' : ''}{index + 1}</td>
                      <td>{str(score.name)}</td>
                      {SCORE_DIMENSIONS.map((dimension) => (
                        <td key={dimension} className="rt-num">{num(score[dimension])}</td>
                      ))}
                      <td className="rt-num"><strong>{num(score.total)}</strong></td>
                      <td className="rt-num">{score.costStatus === 'measured' ? money(score.cost) : '—'}</td>
                      <td className={score.costStatus === 'measured' ? '' : 'rt-warn'}>
                        {score.costStatus === 'measured' ? '已归因' : '口径不可用'}
                      </td>
                      <td>{str(score.comment)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="rt-row">
                <span className="rt-chip">性价比榜（实验性 · 只收数据完整的选手）</span>
                <span className="rt-chip">口径覆盖率 {attributed}/{speeches.length}</span>
              </div>
              <p className="rt-desc rt-warn">
                实验功能：花费来自外部账本，少归因一轮就会低估花费、虚高性价比，因此只收每一轮都归因成功的选手，名次仅供参考。
              </p>
              {valueRanking.length > 0 ? (
                <table className="rt-table">
                  <thead>
                    <tr><th>名次</th><th>选手</th><th>总分</th><th>花费</th><th>性价比</th></tr>
                  </thead>
                  <tbody>
                    {valueRanking.map((id) => {
                      const score = scores.find((entry) => entry.participantId === id);
                      // Rendering filter: a row without real cost data never ships.
                      if (score === undefined || score.value === undefined || score.costStatus !== 'measured') return null;
                      return (
                        <tr key={id}>
                          <td>{num(score.valueRank, 0) > 0 ? num(score.valueRank) : '—'}</td>
                          <td>{str(score.name)}</td>
                          <td className="rt-num">{num(score.total)}</td>
                          <td className="rt-num">{money(score.cost)}</td>
                          <td className="rt-num">{num(score.value)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <p className="rt-desc">本场没有数据完整到可以参与性价比排名的选手。</p>
              )}
              {unmeasured.length > 0 ? (
                <p className="rt-desc rt-warn">
                  未纳入性价比排名（数据不全 ≠ 最划算）：
                  {unmeasured.map((entry) => `${str(entry.name)}（${str(entry.reason)}）`).join('；')}
                </p>
              ) : null}
            </>
          ) : null}

          <div className="rt-list">
            {speeches.map((speech, index) => (
              <div className="rt-speech" key={`${str(speech.participantId)}-${num(speech.round)}-${index}`}>
                <div className="rt-speech-head">
                  第 {num(speech.round)} 轮 · {str(speech.name)}
                  <span className="rt-speech-meta">
                    {' '}· {str(speech.provider)}/{str(speech.model)} · {str(speech.status)}
                    {' '}· {num(speech.usage?.outputTokens)} out ·{' '}
                    {speech.costStatus === 'measured' ? money(speech.cost) : '口径不可用'}
                    {' '}· {num(speech.elapsedMs)} ms
                    {num(speech.sensitiveHits) > 0 ? ` · 过滤 ${num(speech.sensitiveHits)} 处` : ''}
                  </span>
                </div>
                <div className="rt-speech-body">{str(speech.text)}</div>
              </div>
            ))}
          </div>

          {anomalies.length > 0 ? (
            <details>
              <summary>异常记录（{anomalies.length}）</summary>
              <table className="rt-table">
                <thead>
                  <tr><th>时间</th><th>轮次</th><th>选手</th><th>类型</th><th>详情</th></tr>
                </thead>
                <tbody>
                  {anomalies.map((anomaly, index) => (
                    <tr key={index}>
                      <td>{num(anomaly.at) > 0 ? new Date(num(anomaly.at)).toLocaleTimeString('zh-CN') : '—'}</td>
                      <td>{num(anomaly.round) > 0 ? num(anomaly.round) : '—'}</td>
                      <td>{str(anomaly.participantId, '—')}</td>
                      <td>{str(anomaly.kind)}</td>
                      <td>{str(anomaly.message)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ) : null}

          {props.report !== undefined ? (
            <details open>
              <summary>Markdown 战报</summary>
              <pre className="rt-pre">{props.report}</pre>
            </details>
          ) : null}
        </>
      ) : (
        <p className="rt-desc">还没有讨论记录。点「开始讨论」跑一场。</p>
      )}
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The page
// ─────────────────────────────────────────────────────────────────────────────

/** Human-readable name per pending key, used in error messages. */
const PENDING_LABEL: Record<string, string> = {
  save: '保存配置',
  reload: '重新加载',
  refresh: '刷新 Provider',
  pick: '选择目录',
  scan: '试扫',
  start: '开始讨论',
  continue: '续前讨论',
  export: '导出 docx',
  rejudge: '重新裁判',
  report: '查看战报',
  clear: '清空记录',
  stop: '终止讨论',
};

/**
 * Observable holder for the mounted namespace.
 *
 * A late `remote` activation happens outside React, so writing a plain ref left
 * the page stuck on its error card forever. The store notifies subscribers, and
 * the page subscribes once.
 */
interface RemoteStore {
  current: RoundtableRemote | undefined;
  listeners: Set<() => void>;
  set(next: RoundtableRemote | undefined): void;
  subscribe(listener: () => void): () => void;
}

/** Observable boolean, used for the docked window's open state. */
interface ToggleStore {
  get(): boolean;
  set(next: boolean): void;
  subscribe(listener: () => void): () => void;
}

/** Create one toggle store. */
function createToggle(initial = false): ToggleStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (value === next) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** Small round-table glyph, drawn rather than imported so no asset ships. */
function RoundtableIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="3.4" r="1.5" fill="currentColor" />
      <circle cx="3.4" cy="10.2" r="1.5" fill="currentColor" />
      <circle cx="12.6" cy="10.2" r="1.5" fill="currentColor" />
    </svg>
  );
}

/** Launcher edge length in CSS pixels; matches the 96px artwork 1:1. */
const WIDGET_SIZE = 96;
/** Gap kept between the launcher and the frame edge. */
const WIDGET_MARGIN = 16;
/**
 * Where the launcher was last left, in CSS pixels from the frame's top-left.
 * Versioned so a position stored by an older build is not inherited: the default
 * moved from the top-left corner to the top-right one.
 */
const WIDGET_POSITION_KEY = 'roundtable.widget.position.v2';
/** How far the pointer must travel before a press counts as a drag, not a click. */
const WIDGET_DRAG_THRESHOLD = 4;

/** The default seat: the frame's top-right corner. */
function defaultWidgetPosition(): { x: number; y: number } {
  return {
    x: Math.max(WIDGET_MARGIN, window.innerWidth - WIDGET_SIZE - WIDGET_MARGIN),
    y: WIDGET_MARGIN,
  };
}

/** Clamp a position so the whole launcher stays inside the viewport. */
function clampWidgetPosition(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - WIDGET_SIZE)),
    y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - WIDGET_SIZE)),
  };
}

/** Read the stored launcher position, clamped into the viewport. */
function readWidgetPosition(): { x: number; y: number } {
  const fallback = defaultWidgetPosition();
  try {
    const raw = window.localStorage.getItem(WIDGET_POSITION_KEY);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
    const x = Number(parsed.x);
    const y = Number(parsed.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return fallback;
    return clampWidgetPosition(x, y);
  } catch {
    return fallback;
  }
}

/**
 * Mount the floating launcher directly on `document.body`.
 *
 * It deliberately does **not** live in the React tree: the shell's overlay layer
 * is `pointer-events:none` and only its *direct* children are re-enabled, so a
 * React child nested any deeper is visible but unreachable — exactly what "it
 * shows but will not drag" looked like. A plain element on `body`, styled
 * inline, has no such inheritance to fight and survives every shell re-render.
 *
 * @param store - open/closed state, shared with the window.
 * @returns the disposer that removes the element and its listeners.
 */
function mountWidget(store: ToggleStore): () => void {
  const button = document.createElement('button');
  button.type = 'button';
  button.title = '圆桌会议（可拖动）';
  button.setAttribute('aria-label', '打开圆桌会议');
  button.dataset.roundtableWidget = 'true';
  Object.assign(button.style, {
    position: 'fixed',
    // Above the shell chrome: this is a deliberate always-on-top launcher.
    zIndex: '2147483000',
    width: `${WIDGET_SIZE}px`,
    height: `${WIDGET_SIZE}px`,
    padding: '0',
    margin: '0',
    border: '0',
    background: 'transparent',
    boxShadow: 'none',
    lineHeight: '0',
    cursor: 'grab',
    pointerEvents: 'auto',
    userSelect: 'none',
    touchAction: 'none',
    filter: 'drop-shadow(0 3px 6px rgba(0,0,0,.28))',
    transition: 'transform .12s ease',
  });

  const image = document.createElement('img');
  image.src = WIDGET_IMAGE;
  image.alt = '';
  image.draggable = false;
  Object.assign(image.style, {
    display: 'block',
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    pointerEvents: 'none',
    userSelect: 'none',
  });
  button.appendChild(image);

  let position = readWidgetPosition();
  const clampPosition = clampWidgetPosition;
  const applyPosition = (next: { x: number; y: number }): void => {
    position = next;
    button.style.left = `${next.x}px`;
    button.style.top = `${next.y}px`;
  };
  applyPosition(position);

  // Drag state lives in this closure, not in React: no re-render can drop it, and
  // no pointer-capture is involved (it throws inside some containers).
  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = position.x;
    const originY = position.y;
    let moved = false;

    const onMove = (moveEvent: MouseEvent): void => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < WIDGET_DRAG_THRESHOLD) return;
      moved = true;
      moveEvent.preventDefault();
      applyPosition(clampPosition(originX + dx, originY + dy));
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      button.style.cursor = 'grab';
      button.style.transform = '';
      if (moved) {
        try {
          window.localStorage.setItem(WIDGET_POSITION_KEY, JSON.stringify(position));
        } catch {
          // A blocked storage just means the position does not survive a reload.
        }
        return;
      }
      // A press that never moved is a click.
      store.set(true);
    };

    button.style.cursor = 'grabbing';
    button.style.transform = 'scale(.97)';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const onResize = (): void => applyPosition(clampPosition(position.x, position.y));
  const syncVisibility = (): void => {
    button.style.display = store.get() ? 'none' : 'block';
  };

  button.addEventListener('mousedown', onMouseDown);
  window.addEventListener('resize', onResize);
  const unsubscribe = store.subscribe(syncVisibility);
  syncVisibility();
  document.body.appendChild(button);

  return () => {
    unsubscribe();
    button.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('resize', onResize);
    button.remove();
  };
}

/**
 * The round table window itself, plus the floating launcher.
 *
 * The window lives in `shell.overlay` — a documented frame-wide layer — rather
 * than in `main`: a main panel has to join the shell's panel navigation, while an
 * overlay only has to render. Closed means unmounted, so no polling runs while
 * the window is shut.
 */
function RoundtableSurface(props: {
  store: ToggleStore;
  remote?: RoundtableRemote;
  remoteStore: RemoteStore;
  mountError?: string;
  retryMount?: () => Promise<RoundtableRemote | undefined>;
  pickDirectory?: () => Promise<string | undefined>;
}): React.ReactElement {
  const [open, setOpen] = React.useState(props.store.get());
  React.useEffect(() => {
    setOpen(props.store.get());
    return props.store.subscribe(() => setOpen(props.store.get()));
  }, [props.store]);
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.store.set(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, props.store]);
  return (
    <>
      {open ? (
        <div
          className="rt-backdrop"
          role="presentation"
          style={{ pointerEvents: 'auto' }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) props.store.set(false);
      }}
    >
      <div className="rt-window" role="dialog" aria-modal="true" aria-label="圆桌会议">
        <div className="rt-window-head">
          <RoundtableIcon />
          <strong>圆桌会议</strong>
          <span className="rt-chip">多模型辩论</span>
          <button
            type="button"
            className="rt-btn rt-tiny"
            style={{ marginLeft: 'auto' }}
            onClick={() => props.store.set(false)}
          >
            关闭
          </button>
        </div>
        <div className="rt-window-body">
          <PanelErrorBoundary>
            <SettingsPage
              {...props.remote !== undefined ? { remote: props.remote } : {}}
              store={props.remoteStore}
              {...props.mountError !== undefined ? { mountError: props.mountError } : {}}
              {...props.retryMount !== undefined ? { retryMount: props.retryMount } : {}}
              {...props.pickDirectory !== undefined ? { pickDirectory: props.pickDirectory } : {}}
            />
          </PanelErrorBoundary>
        </div>
      </div>
        </div>
      ) : null}
    </>
  );
}

interface PageProps {
  /** The mounted Remote namespace; absent when the mount failed. */
  remote?: RoundtableRemote;
  /** Subscription source for a namespace that mounts late. */
  store?: RemoteStore;
  /** Why the namespace is absent, surfaced verbatim. */
  mountError?: string;
  /** Re-attempt the namespace mount. */
  retryMount?: () => Promise<RoundtableRemote | undefined>;
  /** Optional native directory picker, when the host exposes one. */
  pickDirectory?: () => Promise<string | undefined>;
}

type Message = { tone: 'ok' | 'warn' | 'err'; text: string };

function SettingsPage(props: PageProps): React.ReactElement {
  /** What the Host reported; written only by a successful load/save. */
  const [saved, setSaved] = React.useState<RoundtableConfig | undefined>(undefined);
  /** The form being edited; never written by a poll. */
  const [draft, setDraft] = React.useState<RoundtableConfig | undefined>(undefined);
  const [view, setView] = React.useState<Pick<StateView, 'providers' | 'ledger' | 'running' | 'configPath' | 'personaDir' | 'resolvedJudge' | 'run'> | undefined>(undefined);
  const [remote, setRemote] = React.useState<RoundtableRemote | undefined>(props.remote);
  const [message, setMessage] = React.useState<Message | undefined>(undefined);
  /** Per-operation flags, so one slow action cannot disable all controls. */
  const [pending, setPending] = React.useState<Record<string, boolean>>({});
  const [probing, setProbing] = React.useState<string | undefined>(undefined);
  const [runTopic, setRunTopic] = React.useState('');
  const [runRounds, setRunRounds] = React.useState(2);
  const [previewText, setPreviewText] = React.useState('');
  const [preview, setPreview] = React.useState<PreviewResult | undefined>(undefined);
  const [report, setReport] = React.useState<string | undefined>(undefined);

  const alive = React.useRef(true);
  /** Monotonic request id; a reply older than the newest issued one is dropped. */
  const reqSeq = React.useRef(0);
  /** Latest `load`, so polling can call it without depending on it. */
  const loadRef = React.useRef<(resetDraft: boolean) => Promise<void>>(async () => {});
  /** Latest draft/view, read by request handlers without re-creating them. */
  const latest = React.useRef<{ draft?: RoundtableConfig; view?: typeof view; running: boolean }>({ running: false });

  latest.current = { draft, view, running: view?.running === true };

  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // A late-arriving namespace must re-render: writing only a ref leaves a failed
  // mount permanently unrecoverable.
  React.useEffect(() => { setRemote(props.remote); }, [props.remote]);

  React.useEffect(() => {
    const store = props.store;
    if (store === undefined) return undefined;
    setRemote(store.current);
    return store.subscribe(() => setRemote(store.current));
  }, [props.store]);

  const applyEffect = React.useCallback((effect: (next: RoundtableConfig) => void) => {
    setDraft((current) => {
      if (current === undefined) return current;
      const next: RoundtableConfig = JSON.parse(JSON.stringify(current)) as RoundtableConfig;
      effect(next);
      return next;
    });
  }, []);

  /** Read the Host state. `resetDraft` replaces the form with the Host's copy. */
  const load = React.useCallback(async (resetDraft: boolean): Promise<void> => {
    const active = remote;
    if (active === undefined) {
      if (alive.current) setMessage({ tone: 'err', text: `读取失败：${props.mountError ?? '客户端没有拿到 remote.roundtable'}` });
      return;
    }
    const ticket = ++reqSeq.current;
    try {
      const next = await active.getState();
      if (!alive.current || ticket !== reqSeq.current) return;
      if (next === null || typeof next !== 'object' || next.config === undefined) {
        setMessage({ tone: 'err', text: `读取状态失败：宿主返回的数据缺少 config 字段（收到 ${JSON.stringify(next)?.slice(0, 160) ?? 'undefined'}）` });
        return;
      }
      setSaved(next.config);
      setView({
        providers: arr<ProviderOption>(next.providers),
        ledger: next.ledger ?? { path: '', available: false },
        running: next.running === true,
        configPath: str(next.configPath),
        personaDir: str(next.personaDir),
        ...next.resolvedJudge !== undefined ? { resolvedJudge: next.resolvedJudge } : {},
        ...next.run !== undefined ? { run: next.run } : {},
      });
      if (resetDraft) {
        setDraft(JSON.parse(JSON.stringify(next.config)) as RoundtableConfig);
        if (next.config.topic.length > 0) setRunTopic(next.config.topic);
        setRunRounds(num(next.config.maxRounds, 2));
      } else {
        setDraft((current) => current ?? JSON.parse(JSON.stringify(next.config)) as RoundtableConfig);
      }
    } catch (error) {
      if (alive.current && ticket === reqSeq.current) {
        setMessage({ tone: 'err', text: `读取状态失败：${errorText(error)}` });
      }
    }
  }, [remote, props.mountError]);

  loadRef.current = load;

  React.useEffect(() => { void load(true); }, [load]);

  // Polling is created once per `remote`. `load` is reached through a ref, so
  // typing cannot rebuild this timer (and cannot issue a request per keystroke).
  React.useEffect(() => {
    if (remote === undefined) return undefined;
    let tick = 0;
    const timer = setInterval(() => {
      tick += 1;
      // Fast while a discussion runs, slow otherwise (still notices an external
      // start within ~10 s without hammering the Host when idle).
      if (latest.current.running || tick % IDLE_POLL_EVERY === 0) void loadRef.current(false);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [remote]);

  /** Run one operation under its own flag. */
  const run = React.useCallback(async (key: string, action: () => Promise<void>): Promise<void> => {
    setPending((current) => ({ ...current, [key]: true }));
    try {
      await action();
    } catch (error) {
      if (alive.current) {
        setMessage({ tone: 'err', text: `${PENDING_LABEL[key] ?? key} 失败：${errorText(error)}` });
      }
    } finally {
      if (alive.current) setPending((current) => ({ ...current, [key]: false }));
    }
  }, []);

  const dirty = React.useMemo(() => {
    if (draft === undefined || saved === undefined) return false;
    return JSON.stringify(draft) !== JSON.stringify(saved);
  }, [draft, saved]);

  if (remote === undefined || draft === undefined || view === undefined || saved === undefined) {
    const failure = message?.text ?? (remote === undefined ? `读取失败：${props.mountError ?? '客户端没有拿到 remote.roundtable'}` : undefined);
    return (
      <div className="rt-root">
        <style>{CSS}</style>
        <Panel title="圆桌会议">
          <p className={`rt-desc ${failure !== undefined ? 'rt-err' : ''}`}>{failure ?? '正在读取配置…'}</p>
          {failure !== undefined ? (
            <>
              <p className="rt-desc">
                宿主插件行：<code>roundtable-harness</code>（包 <code>dsh-roundtable-harness</code>）。
                若这里是「读取失败」而插件已安装，通常是宿主进程还没重启、或服务没起来。
              </p>
              <div className="rt-row">
                <button
                  className="rt-btn"
                  onClick={() => void (async () => {
                    setMessage(undefined);
                    if (remote === undefined && props.retryMount !== undefined) {
                      try {
                        const mounted = await props.retryMount();
                        if (mounted !== undefined) { setRemote(mounted); return; }
                        setMessage({ tone: 'err', text: `重新挂载 remote.roundtable 仍未成功：${props.mountError ?? '未取得命名空间'}` });
                        return;
                      } catch (error) {
                        setMessage({ tone: 'err', text: `重新挂载失败：${errorText(error)}` });
                        return;
                      }
                    }
                    await load(true);
                  })()}
                >
                  {remote === undefined ? '重新挂载并重试' : '重试'}
                </button>
              </div>
            </>
          ) : null}
        </Panel>
      </div>
    );
  }

  const providers = arr<ProviderOption>(view.providers);
  const active = remote;

  const buildPayload = (): RoundtableConfig => finalizeDraft(draft);

  const droppedCount = arr<Participant>(draft.participants).length
    - arr<Participant>(draft.participants).filter((participant) =>
      str(participant.provider).length > 0 && str(participant.model).length > 0).length;

  return (
    <div className="rt-root">
      <style>{CSS}</style>

      <div className="rt-sticky">
        <button
          className="rt-btn rt-primary"
          disabled={!dirty || pending.save === true}
          onClick={() => void run('save', async () => {
            const payload = buildPayload();
            const notes: string[] = [];
            if (totalWeightZero(draft)) notes.push('六维权重全为 0，已回退到「全 1」等权。');
            if (droppedCount > 0) {
              notes.push(`有 ${droppedCount} 位选手没选 Provider/模型，保存时已跳过（它们的配置不会写进 roundtable.json）。`);
            }
            if (notes.length > 0) setMessage({ tone: 'warn', text: notes.join(' ') });
            const next = await active.saveConfig(payload);
            setSaved(next);
            setDraft(JSON.parse(JSON.stringify(next)) as RoundtableConfig);
            await load(true);
            // Keep the warnings visible: they explain what the save actually did.
            setMessage((current) => current?.tone === 'warn'
              ? current
              : { tone: 'ok', text: '配置已写入 roundtable.json。' });
          })}
        >
          {pending.save === true ? '正在保存…' : '保存配置'}
        </button>
        <button
          className="rt-btn"
          disabled={pending.reload === true}
          onClick={() => void run('reload', async () => {
            await active.reloadConfig();
            await load(true);
            setMessage({ tone: 'ok', text: '已从磁盘重新加载。' });
          })}
        >
          放弃改动并重载
        </button>
        <button
          className="rt-btn"
          disabled={pending.refresh === true}
          onClick={() => void run('refresh', async () => {
            const next = await active.refreshProviders();
            setView((current) => current === undefined ? current : { ...current, providers: next });
            setMessage({ tone: 'ok', text: `已刷新，发现 ${arr<unknown>(next).length} 个 Provider。` });
          })}
        >
          刷新 Provider
        </button>
        <span className="rt-chip">{dirty ? '有未保存改动' : '已同步'}</span>
        <span className="rt-chip">
          <span className={view.ledger.available ? 'rt-ok' : 'rt-warn'}>●</span>
          cost-meter {view.ledger.available ? '账本可用' : '账本不可用'}
        </span>
        <span className="rt-chip">
          裁判 {view.resolvedJudge !== undefined
            ? `${str(view.resolvedJudge.provider)}/${str(view.resolvedJudge.model)}`
            : '未配置'}
        </span>
        {view.running ? <span className="rt-chip rt-ok">讨论进行中</span> : null}
      </div>

      {message !== undefined ? (
        <div className={`rt-banner rt-${message.tone}`}>{message.text}</div>
      ) : null}

      <div className="rt-scroll">
        <ProviderPanel
          providers={providers}
          probing={probing}
          parsing={pending.refresh === true}
          aliases={draft.providerAliases ?? {}}
          onRefresh={() => void run('refresh', async () => {
            const next = await active.refreshProviders();
            setView((current) => current === undefined ? current : { ...current, providers: next });
            setMessage({ tone: 'ok', text: `已刷新，发现 ${arr<unknown>(next).length} 个 Provider。` });
          })}
          onProbe={(provider) => void (async () => {
            setProbing(provider.id);
            setMessage(undefined);
            try {
              const result = await active.testProvider(provider.id);
              setMessage({ tone: result.ok ? 'ok' : 'err', text: `${provider.id}：${result.message}` });
            } catch (error) {
              setMessage({ tone: 'err', text: `测试 ${provider.id} 失败：${errorText(error)}` });
            } finally {
              if (alive.current) setProbing(undefined);
            }
          })()}
        />

        <ParticipantPanel
          participants={arr<Participant>(draft.participants)}
          providers={providers}
          onChange={(participants) => applyEffect((next) => { next.participants = participants; })}
        />

        <JudgePanel
          judge={draft.judge ?? { enabled: false, provider: '', model: '', persona: '' }}
          providers={providers}
          resolved={view.resolvedJudge}
          onChange={(judge) => applyEffect((next) => { next.judge = judge; })}
        />

        <WeightPanel
          weights={(draft.scoreWeights ?? {}) as Record<ScoreDimension, number>}
          onChange={(weights) => applyEffect((next) => { next.scoreWeights = weights; })}
        />

        <RunParamsPanel
          draft={draft}
          onChange={applyEffect}
          picking={pending.pick === true}
          onPick={() => void run('pick', async () => {
            if (props.pickDirectory === undefined) return;
            const picked = await props.pickDirectory();
            if (picked !== undefined && picked.length > 0) {
              applyEffect((next) => { next.outputDir = picked; });
            }
          })}
          {...props.pickDirectory !== undefined ? { pickDirectory: props.pickDirectory } : {}}
        />

        <SensitivePanel
          sensitive={draft.sensitive ?? { builtin: true, words: [], patterns: [] }}
          onChange={(sensitive) => applyEffect((next) => { next.sensitive = sensitive; })}
          previewText={previewText}
          onPreviewText={setPreviewText}
          preview={preview}
          scanning={pending.scan === true}
          onScan={() => void run('scan', async () => {
            // Screen with what is on screen, not with the last saved policy.
            const result = await active.scanPreview(
              previewText,
              strList(draft.sensitive?.words),
              strList(draft.sensitive?.patterns),
            );
            setPreview(result);
          })}
        />

        <RunPanel
          state={{ ...view, config: saved, providers, resolvedJudge: view.resolvedJudge }}
          {...view.run !== undefined ? { run: view.run } : {}}
          topic={runTopic}
          rounds={runRounds}
          onTopic={setRunTopic}
          onRounds={setRunRounds}
          {...report !== undefined ? { report } : {}}
          pending={pending}
          dirty={dirty}
          onStart={() => void run('start', async () => {
            const payload = buildPayload();
            if (droppedCount > 0) {
              setMessage({ tone: 'warn', text: `有 ${droppedCount} 位选手没选 Provider/模型，本次不会参与。` });
            }
            await active.saveConfig(payload);
            await active.startRun(runTopic, runRounds);
            setReport(undefined);
            await load(true);
          })}
          onStop={() => void (async () => {
            try {
              await active.stopRun();
              setMessage({ tone: 'warn', text: '已发送终止信号：中断当前请求并跳过裁判环节。' });
              await load(false);
            } catch (error) {
              setMessage({ tone: 'err', text: `终止讨论失败：${errorText(error)}` });
            }
          })()}
          onContinue={() => void run('continue', async () => {
            await active.continueRun(runRounds);
            setReport(undefined);
            setMessage({ tone: 'ok', text: `已接上一场继续讨论（再跑 ${runRounds} 轮）。` });
            await load(false);
          })}
          onExport={() => void run('export', async () => {
            const path = await active.exportDocx();
            setMessage({ tone: 'ok', text: `docx 已写入：${path}` });
            await load(false);
          })}
          onRejudge={() => void run('rejudge', async () => {
            await active.rejudge();
            setMessage({ tone: 'ok', text: '已用当前裁判重新评分。' });
            await load(false);
          })}
          onReport={() => void run('report', async () => {
            const text = await active.getReport();
            setReport(str(text, '（空战报）'));
          })}
          onClear={() => void run('clear', async () => {
            await active.clearRun();
            setReport(undefined);
            setPreview(undefined);
            setMessage({ tone: 'ok', text: '已清空本场记录。' });
            await load(false);
          })}
        />

        <Panel title="⑧ 路径与运行信息">
          <div className="rt-row">
            <span className="rt-chip">配置文件 {str(view.configPath, '—')}</span>
            <span className="rt-chip">人格目录 {str(view.personaDir, '—')}</span>
            <span className="rt-chip">账本 {str(view.ledger.path, '—')}</span>
          </div>
        </Panel>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin wiring
// ─────────────────────────────────────────────────────────────────────────────

export const inject = ['slots', 'remote'];

interface SlotContext {
  get<T>(name: string): T | undefined;
  inject(names: string[], callback: (ctx: SlotContext) => void): unknown;
  on(event: string, callback: () => void): unknown;
  effect(callback: () => void | (() => void), label?: string): void;
  slots: {
    inject(name: string, callback: () => void): unknown;
    register(meta: { name: string; id: string; order: number; label: () => string }, render: (props: unknown) => React.ReactNode): () => void;
  };
}

/**
 * Register the settings cell.
 * @param ctx - the client context.
 */
export function apply(ctx: SlotContext): void {
  /** Observable slot for the namespace, so a late mount still re-renders. */
  const store: RemoteStore = {
    current: undefined,
    listeners: new Set<() => void>(),
    set(next) {
      this.current = next;
      for (const listener of [...this.listeners]) listener();
    },
    subscribe(listener) {
      this.listeners.add(listener);
      return () => { this.listeners.delete(listener); };
    },
  };
  let mounted = false;
  let mountError: string | undefined;
  /** Disposer of the previous `$mount`, so a retry cannot leak the old one. */
  let disposeMount: (() => Promise<void>) | undefined;
  /** A native directory picker, when the harness exposes one. */
  let pickDirectory: (() => Promise<string | undefined>) | undefined;

  const discoverPicker = (source: SlotContext): void => {
    for (const name of ['directoryPicker', 'remote.directoryPicker', 'directory-picker']) {
      const service = source.get<{ pick?: (options?: unknown) => Promise<string | undefined> }>(name);
      if (service !== undefined && typeof service.pick === 'function') {
        pickDirectory = () => service.pick!({ title: '选择战报输出目录' });
        return;
      }
    }
  };

  /** Mount the namespace once `remote` is available. */
  const mount = async (
    remoteService: { $mount?: (contribution: unknown) => Promise<() => Promise<void>> } | undefined,
    force = false,
  ): Promise<void> => {
    if (mounted && !force) return;
    if (remoteService === undefined || typeof remoteService.$mount !== 'function') {
      mountError = '客户端还没有 remote 服务（api-gateway 未激活）';
      return;
    }
    // A retry must retire the previous contribution first: mounting the same
    // descriptors twice leaves two live handlers and a stale disposer.
    if (disposeMount !== undefined) {
      try {
        await disposeMount();
      } catch (error) {
        console.warn(`[roundtable] 旧的 Remote 贡献销毁失败：${errorText(error)}`);
      }
      disposeMount = undefined;
    }
    mounted = true;
    try {
      const dispose = await remoteService.$mount(REMOTE_CONTRIBUTION);
      disposeMount = dispose;
      ctx.effect(() => () => { void dispose(); }, 'roundtable: remote contribution');
      const namespace = ctx.get<RawRemote>(`remote.${NAMESPACE}`);
      if (namespace === undefined) {
        mountError = `挂载成功但取不到 remote.${NAMESPACE}（宿主侧 roundtable 服务未注册）`;
      } else {
        // Every call resolves a {ok, value} envelope; bind the unwrapping once.
        store.set(bindRemote(namespace));
        mountError = undefined;
      }
    } catch (error) {
      mounted = false;
      mountError = `挂载 Remote 失败：${errorText(error)}`;
      console.error(`[roundtable] ${mountError}`);
    }
  };

  /** Re-attempt the mount for the page's retry button. */
  const retryMount = async (): Promise<RoundtableRemote | undefined> => {
    type RemoteService = { $mount?: (contribution: unknown) => Promise<() => Promise<void>> };
    const injectFn = ctx.inject;
    let remoteService = ctx.get<RemoteService>('remote');
    if (remoteService === undefined && typeof injectFn === 'function') {
      remoteService = await new Promise<RemoteService | undefined>((resolve) => {
        injectFn.call(ctx, ['remote'], (remoteCtx) => {
          resolve(remoteCtx.get<RemoteService>('remote'));
          return () => {};
        });
      });
    }
    await mount(remoteService, true);
    return store.current;
  };

  discoverPicker(ctx);
  // `mount` catches its own failures, but a rejected `$mount` promise must not
  // become an unhandled rejection either.
  void mount(ctx.get('remote')).catch((error: unknown) => {
    mountError = `挂载 Remote 失败：${errorText(error)}`;
  });
  if (store.current === undefined && typeof ctx.inject === 'function') {
    // A late-activating `remote` still mounts the namespace, and `store.set`
    // notifies the page so it re-renders instead of sitting on its error card.
    ctx.inject(['remote'], (remoteCtx) => {
      void mount(remoteCtx.get('remote')).catch((error: unknown) => {
        mountError = `挂载 Remote 失败：${errorText(error)}`;
      });
    });
  }

  /**
   * The cell body: owns the retry counter, so the boundary's「重试渲染」bumps a
   * real piece of React state rather than a closure variable that never changes.
   */
  const Render = (props: Record<string, unknown>): React.ReactElement => {
    const [resetTick, setResetTick] = React.useState(0);
    return React.createElement(PanelErrorBoundary, {
      resetKey: resetTick,
      onRetry: () => setResetTick((current) => current + 1),
    }, React.createElement(SettingsPage, {
      ...props,
      key: resetTick,
      remote: store.current,
      store,
      mountError,
      retryMount,
      ...pickDirectory !== undefined ? { pickDirectory } : {},
    } as unknown as PageProps));
  };

  ctx.effect(() => {
    const dispose = ctx.slots.inject('settings.section', () => ctx.slots.register(
      {
        name: 'settings.section',
        id: SECTION_ID,
        order: SECTION_ORDER,
        label: () => '圆桌会议',
      },
      (props: unknown) => React.createElement(Render, (props ?? {}) as Record<string, unknown>),
    ));
    // `inject` hands back the deregistration handle; it has to be *called*, not
    // just evaluated, or the section outlives the plugin.
    return () => {
      if (typeof dispose === 'function') (dispose as () => void)();
    };
  }, 'roundtable: settings section');

  // ── Launcher + window ────────────────────────────────────────────────────
  //
  // Two different homes on purpose:
  //   - the window body lives in `shell.overlay` (rendered, escapable, no shell
  //     navigation to join);
  //   - the launcher is a plain element on `document.body`, because the overlay
  //     layer is `pointer-events:none` for everything but its direct children.
  const windowOpen = createToggle();

  ctx.effect(() => {
    const dispose = ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      { name: 'shell.overlay', id: 'roundtable.window', order: 40, label: () => '圆桌会议' },
      (props: unknown) => React.createElement(RoundtableSurface, {
        ...(props ?? {}) as Record<string, unknown>,
        store: windowOpen,
        remoteStore: store,
        ...store.current !== undefined ? { remote: store.current } : {},
        ...mountError !== undefined ? { mountError } : {},
        retryMount,
        ...pickDirectory !== undefined ? { pickDirectory } : {},
      }),
    ));
    return () => {
      if (typeof dispose === 'function') (dispose as () => void)();
    };
  }, 'roundtable: overlay window');

  ctx.effect(() => mountWidget(windowOpen), 'roundtable: launcher');
}

export const name = PACKAGE;
