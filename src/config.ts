/**
 * Configuration model, defaults, and the `roundtable.json` store.
 *
 * Layering (highest wins):
 *   1. environment overrides — `JUDGE_MODEL`, `JUDGE_PERSONA`, `ROUNDTABLE_OUTPUT_DIR`
 *   2. the stored document (`$DSH_HOME/roundtable.json`, else `~/.dsh/roundtable.json`)
 *   3. {@link defaultConfig}
 *
 * Secrets never enter this document. Providers are read from the Harness LLM
 * service, so their API keys stay in the DSH credential store; the only
 * credential-shaped field here is `apiKeyEnv`, a *name*.
 *
 * @module dsh-roundtable-harness/config
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_SCORE_WEIGHTS, normalizeScoreWeights, type ScoreDimension } from './dimensions.js';

/** One debating AI: identity, model binding, persona, and artwork. */
export interface ParticipantConfig {
  /** Stable slug used in file names and transcripts. */
  id: string;
  /** Display name shown in the transcript and the report. */
  name: string;
  /** Harness provider route (as `ctx.llm.listProviders()` reports it). */
  provider: string;
  /** Model id accepted by that provider. */
  model: string;
  /** Inline persona text. Mirrored to `personas/<id>.md` on save. */
  persona: string;
  /**
   * Persona file to read, as a path **relative to the persona directory**.
   * Absolute paths and `..` escapes are dropped on load: the field names a file
   * inside `personas/`, never an arbitrary path the plugin would then read or
   * overwrite.
   */
  personaFile?: string;
  /** Local image path or http(s) URL used on the report cover. */
  avatar?: string;
  /** Marks a low-cost model; summaries prefer these. */
  cheap?: boolean;
}

/** The rotating referee. */
export interface JudgeConfig {
  enabled: boolean;
  /** Provider route for the judge; empty resolves to the first qwen-ish route. */
  provider: string;
  /** Model id for the judge; empty resolves to that provider's first qwen-ish model. */
  model: string;
  /** Referee persona; `JUDGE_PERSONA` overrides it. */
  persona: string;
}

/** Sensitive-content scanning policy. */
export interface SensitiveConfig {
  /** Scan with the built-in Chinese/English baseline list. */
  builtin: boolean;
  /** Extra literal words (matched case-insensitively). */
  words: string[];
  /** Extra regular expressions (case-insensitive, must be valid). */
  patterns: string[];
}

/** The complete persisted document. */
export interface RoundtableConfig {
  /** Document schema version, bumped by migrations. */
  version: number;
  /** Discussion topic; the settings page may override it per run. */
  topic: string;
  /** Number of speaking rounds, 1–20. */
  maxRounds: number;
  /** Output-token cap for a single speaker turn. */
  maxTokensPerTurn: number;
  /** Per-request timeout in milliseconds; a timeout makes that AI absent for the round. */
  requestTimeoutMs: number;
  /** Estimated-context budget; exceeding it compresses old rounds into a summary. */
  tokenBudget: number;
  /** Compression turns kept verbatim after the summary. */
  keepRecentRounds: number;
  /** Abort the discussion after this many sensitive-content hits. */
  sensitiveThreshold: number;
  /** Directory the report and the docx are written to. */
  outputDir: string;
  /** Declared participants, in speaking order. */
  participants: ParticipantConfig[];
  judge: JudgeConfig;
  sensitive: SensitiveConfig;
  /** Optional display aliases, e.g. `{ "qwen": "dashscope" }`. */
  providerAliases: Record<string, string>;
  /** Relative weight of each of the six judged dimensions. */
  scoreWeights: Record<ScoreDimension, number>;
}

/** Environment overrides read once per call so a restart is never required for the judge. */
export interface EnvironmentOverrides {
  judgeModel?: string;
  judgePersona?: string;
  outputDir?: string;
}

/** Resolve the Harness home the same way the installation does. */
export function resolveDshHome(): string {
  const configured = process.env.DSH_HOME;
  if (configured !== undefined && configured.trim().length > 0) return resolve(configured);
  return join(homedir(), '.dsh');
}

/** Absolute path of the stored document. */
export function resolveConfigPath(): string {
  return join(resolveDshHome(), 'roundtable.json');
}

/** Absolute path of the persona mirror directory. */
export function resolvePersonaDir(): string {
  return join(resolveDshHome(), 'roundtable', 'personas');
}

/** Read `JUDGE_MODEL` / `JUDGE_PERSONA` / `ROUNDTABLE_OUTPUT_DIR`. */
export function readEnvironmentOverrides(env: NodeJS.ProcessEnv = process.env): EnvironmentOverrides {
  const nonEmpty = (value: string | undefined): string | undefined =>
    value !== undefined && value.trim().length > 0 ? value : undefined;
  return {
    judgeModel: nonEmpty(env.JUDGE_MODEL),
    judgePersona: nonEmpty(env.JUDGE_PERSONA),
    outputDir: nonEmpty(env.ROUNDTABLE_OUTPUT_DIR),
  };
}

/**
 * Split a `JUDGE_MODEL` value into a provider route and a model id.
 * Accepts `provider/model`, `provider:model`, or a bare model id (empty provider).
 * @param raw - the raw environment value.
 * @returns the parsed pair; `model` is empty when `raw` carries no model.
 */
export function parseJudgeModel(raw: string): { provider: string; model: string } {
  const value = raw.trim();
  const separator = value.search(/[/:]/);
  if (separator <= 0) return { provider: '', model: value };
  return {
    provider: value.slice(0, separator).trim(),
    model: value.slice(separator + 1).trim(),
  };
}

/** Fresh default document. */
export function defaultConfig(): RoundtableConfig {
  return {
    version: 1,
    topic: '',
    maxRounds: 3,
    maxTokensPerTurn: 1024,
    requestTimeoutMs: 60_000,
    tokenBudget: 24_000,
    keepRecentRounds: 2,
    sensitiveThreshold: 3,
    outputDir: '',
    participants: [],
    judge: { enabled: true, provider: '', model: '', persona: '' },
    sensitive: { builtin: true, words: [], patterns: [] },
    providerAliases: {},
    scoreWeights: { ...DEFAULT_SCORE_WEIGHTS },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** Repair one participant entry read from disk, or `undefined` when it has no model binding. */
function normalizeParticipant(value: unknown, index: number): ParticipantConfig | undefined {
  const raw = asRecord(value);
  const provider = asString(raw.provider, '').trim();
  const model = asString(raw.model, '').trim();
  if (provider.length === 0 || model.length === 0) return undefined;
  const name = asString(raw.name, '').trim() || `选手 ${index + 1}`;
  const id = slug(asString(raw.id, '').trim() || name, `participant-${index + 1}`);
  const avatar = asString(raw.avatar, '').trim();
  // A persona file is only ever a name inside the persona directory. An
  // absolute path or a `..` escape is dropped here, so no other code path — the
  // reader, the writer, or the report — ever has to re-check it.
  const rawPersonaFile = asString(raw.personaFile, '').trim();
  const personaFile = isSafePersonaFile(rawPersonaFile) ? rawPersonaFile : '';
  return {
    id,
    name,
    provider,
    model,
    persona: asString(raw.persona, ''),
    ...personaFile.length > 0 ? { personaFile } : {},
    ...avatar.length > 0 ? { avatar } : {},
    ...raw.cheap === true ? { cheap: true } : {},
  };
}

/**
 * Whether a persona-file value is usable.
 *
 * Accepts only a relative path that stays inside the persona directory: no
 * absolute path, no `..` segment, no NUL, no drive-relative form.
 * @param value - the raw field value.
 * @returns `true` when the value may be resolved against the persona directory.
 */
export function isSafePersonaFile(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes('\0')) return false;
  if (isAbsolute(trimmed)) return false;
  // Windows drive-relative (`C:foo`) and UNC-ish leading separators.
  if (/^[A-Za-z]:/.test(trimmed)) return false;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return false;
  const segments = trimmed.split(/[\\/]+/);
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/**
 * Turn arbitrary text into a file-safe slug.
 * @param value - source text.
 * @param fallback - used when the text yields no usable characters.
 * @returns a lowercase `[a-z0-9-]` slug.
 */
export function slug(value: string, fallback: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Normalize a document read from disk or supplied by the settings page.
 * Unknown keys are dropped and out-of-range numbers are clamped, so a hand
 * edit can never wedge the engine.
 * @param value - raw document.
 * @returns a complete, in-range configuration.
 */
export function normalizeConfig(value: unknown): RoundtableConfig {
  const base = defaultConfig();
  const raw = asRecord(value);
  const judgeRaw = asRecord(raw.judge);
  const sensitiveRaw = asRecord(raw.sensitive);
  const participantsRaw = Array.isArray(raw.participants) ? raw.participants : [];
  const participants: ParticipantConfig[] = [];
  /** Ids already taken; a duplicate would merge two speakers' scores and costs. */
  const usedIds = new Set<string>();
  for (const [index, entry] of participantsRaw.entries()) {
    const participant = normalizeParticipant(entry, index);
    if (participant === undefined) continue;
    if (usedIds.has(participant.id)) {
      // Keep the participant, rename it: dropping a configured speaker because
      // two names slugged to the same id would silently shrink the field.
      let suffix = 2;
      while (usedIds.has(`${participant.id}-${suffix}`)) suffix += 1;
      participant.id = `${participant.id}-${suffix}`;
    }
    usedIds.add(participant.id);
    participants.push(participant);
  }
  const aliasesRaw = asRecord(raw.providerAliases);
  const providerAliases: Record<string, string> = {};
  for (const [key, alias] of Object.entries(aliasesRaw)) {
    if (typeof alias === 'string' && key.trim().length > 0 && alias.trim().length > 0) {
      providerAliases[key.trim()] = alias.trim();
    }
  }
  return {
    version: base.version,
    topic: asString(raw.topic, base.topic),
    maxRounds: asNumber(raw.maxRounds, base.maxRounds, 1, 20),
    maxTokensPerTurn: asNumber(raw.maxTokensPerTurn, base.maxTokensPerTurn, 16, 64_000),
    requestTimeoutMs: asNumber(raw.requestTimeoutMs, base.requestTimeoutMs, 1_000, 600_000),
    tokenBudget: asNumber(raw.tokenBudget, base.tokenBudget, 512, 1_000_000),
    keepRecentRounds: asNumber(raw.keepRecentRounds, base.keepRecentRounds, 0, 10),
    sensitiveThreshold: asNumber(raw.sensitiveThreshold, base.sensitiveThreshold, 1, 100),
    outputDir: asString(raw.outputDir, base.outputDir),
    participants,
    judge: {
      enabled: judgeRaw.enabled !== false,
      provider: asString(judgeRaw.provider, '').trim(),
      model: asString(judgeRaw.model, '').trim(),
      persona: asString(judgeRaw.persona, ''),
    },
    sensitive: {
      builtin: sensitiveRaw.builtin !== false,
      words: asStringArray(sensitiveRaw.words),
      patterns: asStringArray(sensitiveRaw.patterns),
    },
    providerAliases,
    scoreWeights: normalizeScoreWeights(raw.scoreWeights),
  };
}

/**
 * Apply `JUDGE_MODEL` / `JUDGE_PERSONA` / `ROUNDTABLE_OUTPUT_DIR` on top of a document.
 * @param config - the stored configuration.
 * @param overrides - values read from the environment.
 * @returns a new configuration; the input is not mutated.
 */
export function applyEnvironmentOverrides(
  config: RoundtableConfig,
  overrides: EnvironmentOverrides,
): RoundtableConfig {
  const next: RoundtableConfig = {
    ...config,
    judge: { ...config.judge },
  };
  if (overrides.judgeModel !== undefined) {
    const parsed = parseJudgeModel(overrides.judgeModel);
    next.judge.enabled = true;
    if (parsed.provider.length > 0) next.judge.provider = parsed.provider;
    if (parsed.model.length > 0) next.judge.model = parsed.model;
  }
  if (overrides.judgePersona !== undefined) next.judge.persona = overrides.judgePersona;
  if (overrides.outputDir !== undefined) next.outputDir = overrides.outputDir;
  return next;
}

/** Read the stored document, falling back to defaults when it is absent or unreadable. */
export function loadConfig(path: string = resolveConfigPath()): RoundtableConfig {
  try {
    if (!existsSync(path)) return defaultConfig();
    return normalizeConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    console.warn(`[roundtable] 读取 ${path} 失败，改用默认配置：${(error as Error).message}`);
    return defaultConfig();
  }
}

/**
 * Write the document atomically (temp file + rename), so a crash mid-write
 * cannot truncate a working configuration.
 * @param config - the document to persist.
 * @param path - destination; defaults to the resolved path.
 */
export function saveConfig(config: RoundtableConfig, path: string = resolveConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

/**
 * Deep-merge a patch into the stored document and persist it.
 * Arrays replace wholesale, so a participant list edit is never half-applied.
 * @param patch - partial document from the settings page.
 * @param path - document path; defaults to the resolved path.
 * @returns the merged, normalized document.
 */
export function mergeConfig(
  patch: unknown,
  path: string = resolveConfigPath(),
): RoundtableConfig {
  const current = loadConfig(path) as unknown as Record<string, unknown>;
  const incoming = asRecord(patch);
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const existing = current[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)
      && existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
      merged[key] = { ...existing as Record<string, unknown>, ...asRecord(value) };
    } else {
      merged[key] = value;
    }
  }
  const next = normalizeConfig(merged);
  saveConfig(next, path);
  ensurePersonaFiles(next);
  return next;
}

/** Absolute path of one participant's persona mirror. */
export function personaFilePath(participantId: string): string {
  return join(resolvePersonaDir(), `${slug(participantId, 'participant')}.md`);
}

/**
 * Resolve the persona file one participant reads and writes.
 *
 * The result is always inside the persona directory: an unsafe `personaFile`
 * falls back to the participant's own `<id>.md`, so a hand-edited document can
 * never turn this field into an arbitrary read or write.
 * @param participant - the participant whose persona file to resolve.
 * @returns an absolute path inside the persona directory.
 */
export function resolvePersonaTarget(participant: ParticipantConfig): string {
  const dir = resolvePersonaDir();
  const declared = participant.personaFile;
  if (declared === undefined || !isSafePersonaFile(declared)) return personaFilePath(participant.id);
  const candidate = resolve(dir, declared);
  const rel = relative(dir, candidate);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    return personaFilePath(participant.id);
  }
  return candidate;
}

/**
 * Mirror every inline persona into the persona directory.
 * The mirror is what makes a persona diffable and hand-editable; it is written
 * only when its content would change, so saving settings is not a disk churn.
 * @param config - the document whose participants to mirror.
 */
export function ensurePersonaFiles(config: RoundtableConfig): void {
  mkdirSync(resolvePersonaDir(), { recursive: true });
  for (const participant of config.participants) {
    if (participant.persona.trim().length === 0) continue;
    const target = resolvePersonaTarget(participant);
    try {
      if (existsSync(target) && readFileSync(target, 'utf8') === participant.persona) continue;
      writeFileSync(target, participant.persona, 'utf8');
    } catch (error) {
      console.warn(`[roundtable] 写入人格文件 ${target} 失败：${(error as Error).message}`);
    }
  }
}

/**
 * Resolve the persona text used for one participant at call time.
 * The persona file wins over the inline text so a hand edit takes effect without
 * going through the settings page; the path is always the sanitized one.
 * @param participant - the participant to resolve.
 * @returns the persona text, or `''` when neither source has content.
 */
export function resolvePersona(participant: ParticipantConfig): string {
  // A mirror only speaks for the participant while there is something for it to
  // mirror, or while the document named that file explicitly. Clearing the
  // inline persona therefore clears the persona, instead of resurrecting a
  // stale file.
  const mirrorAuthoritative = participant.persona.trim().length > 0 || participant.personaFile !== undefined;
  if (mirrorAuthoritative) {
    const target = resolvePersonaTarget(participant);
    try {
      if (existsSync(target)) {
        const text = readFileSync(target, 'utf8');
        if (text.trim().length > 0) return text;
      }
    } catch {
      // A missing or unreadable mirror simply falls through to the inline text.
    }
  }
  return participant.persona;
}

/**
 * Resolve the directory that reports and docx files are written into.
 *
 * An empty `outputDir` used to mean "the host process's working directory",
 * which on this machine was the *profile* directory — the export really did
 * write there, but it is a program directory, it sits on the system drive, and
 * nobody thinks to look inside it. The default is now `$DSH_HOME/roundtable`,
 * next to `personas/`, so reports live with the rest of the plugin's data.
 *
 * A relative path still resolves against the working directory, so "reports"
 * keeps meaning what it looks like: relative to the host.
 * @param config - the stored configuration.
 * @returns an absolute directory path (not guaranteed to exist yet).
 */
export function resolveOutputDir(config: RoundtableConfig): string {
  const configured = config.outputDir.trim();
  if (configured.length === 0) return join(resolveDshHome(), 'roundtable', 'reports');
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

/**
 * Create the output directory if it is missing.
 *
 * Writing a report used to assume the directory existed; a first run with a
 * fresh `$DSH_HOME` therefore failed with ENOENT instead of just working.
 * @param directory - the directory to ensure.
 */
export function ensureOutputDir(directory: string): void {
  mkdirSync(directory, { recursive: true });
}
