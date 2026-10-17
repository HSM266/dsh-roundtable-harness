/**
 * The plugin's Host operations, shared by the settings page and the agent tools.
 *
 * Every operation is implemented here exactly once and exposed two ways: as a
 * Typert Remote method for the settings page, and as an agent tool in
 * `tools.ts`. The UI and the tool path therefore cannot drift.
 *
 * Two constraints are load-bearing and must survive future edits:
 *   - the Remote method parameter lists are read back from the *source text* of
 *     these prototype methods, so they take plain positional identifiers only
 *     (no destructuring, no defaults, no rest) — and the build must not minify
 *     identifiers;
 *   - every method returns JSON-serializable data, because the wire carries it.
 *
 * @module dsh-roundtable-harness/service
 */

import { mkdirSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import {
  applyEnvironmentOverrides,
  ensurePersonaFiles,
  loadConfig,
  mergeConfig,
  readEnvironmentOverrides,
  resolveConfigPath,
  resolveOutputDir,
  resolvePersona,
  resolvePersonaDir,
  type RoundtableConfig,
} from './config.js';
import {
  loadProviderCatalog,
  probeProvider,
  resolveTarget,
  type ProviderOption,
} from './providers.js';
import { compileScanner, screen } from './sensitive.js';
import { readCostSnapshot, resolveLedgerPath } from './cost.js';
import { RoundtableRun, participantCostsOf, type RunState } from './roundtable.js';
import { buildDocxReport } from './docx-export.js';
import { buildMarkdownReport, renderMarkdownReport } from './report.js';
import { runJudge, type JudgeOutcome } from './judge.js';

/** Remote methods this service publishes, in wire order. */
export const REMOTE_METHODS = [
  'getState',
  'refreshProviders',
  'testProvider',
  'saveConfig',
  'reloadConfig',
  'scanPreview',
  'startRun',
  'continueRun',
  'stopRun',
  'clearRun',
  'exportDocx',
  'getReport',
  'rejudge',
] as const;

/** What the settings page and the tools both read. */
export interface RoundtableStateView {
  /** Current persisted configuration, after environment overrides. */
  config: RoundtableConfig;
  /** Live provider catalogue from the Harness LLM service. */
  providers: ProviderOption[];
  /** The last or currently running discussion, when there is one. */
  run?: RunState;
  /** Whether a discussion is in flight. */
  running: boolean;
  /** Where a discussion would be judged: the resolved target after env overrides. */
  resolvedJudge?: { provider: string; model: string };
  /** Where the ledger was read from, and whether it was found. */
  ledger: { path: string; available: boolean; error?: string };
  /** Absolute path of the persisted document. */
  configPath: string;
  /** Absolute path of the persona mirror directory. */
  personaDir: string;
}

/** Per-run logger, kept as a field so tests can silence it. */
export type LogSink = (line: string) => void;

/** Operations the UI actions and the tools both call. */
export class RoundtableEndpoints {
  private readonly hostCtx: Context;
  private readonly llm: LlmRuntime;
  private readonly log: LogSink;
  private current: RoundtableRun | undefined;
  private lastRun: RunState | undefined;
  private cachedProviders: ProviderOption[] = [];
  private providersAt = 0;

  constructor(ctx: Context, llm: LlmRuntime, log: LogSink = (line) => console.log(line)) {
    this.hostCtx = ctx;
    this.llm = llm;
    this.log = log;
  }

  /** Load the stored document with environment overrides applied. */
  private config(): RoundtableConfig {
    return applyEnvironmentOverrides(loadConfig(), readEnvironmentOverrides());
  }

  /**
   * Providers are cached for five seconds: the settings page polls this method
   * while a discussion runs, and re-enumerating every route's model list on
   * every tick would hit every gateway on every poll.
   */
  private async providers(force = false): Promise<ProviderOption[]> {
    const now = Date.now();
    if (!force && this.cachedProviders.length > 0 && now - this.providersAt < 5_000) {
      return this.cachedProviders;
    }
    this.cachedProviders = await loadProviderCatalog(this.llm, this.config().providerAliases);
    this.providersAt = now;
    return this.cachedProviders;
  }

  /** Resolve the referee, honouring `JUDGE_MODEL` and the qwen-by-default rule. */
  private async judgeTarget(config: RoundtableConfig): Promise<{ provider: string; model: string } | undefined> {
    if (!config.judge.enabled) return undefined;
    return resolveTarget(
      this.llm,
      { provider: config.judge.provider, model: config.judge.model },
      config.providerAliases,
    );
  }

  /** The run the settings page should display, live one first. */
  private visibleRun(): RunState | undefined {
    return this.current?.state ?? this.lastRun;
  }

  /**
   * Everything the settings page renders.
   * @returns the configuration, provider catalogue, and run status.
   */
  async getState(): Promise<RoundtableStateView> {
    // Disk truth and the resolved view are two different things. `config` is
    // what is actually stored — the form must round-trip it, so a save cannot
    // silently bake an environment override (JUDGE_MODEL, an env output dir) into
    // roundtable.json. The resolved referee is reported separately.
    const config = loadConfig();
    const effective = applyEnvironmentOverrides(config, readEnvironmentOverrides());
    const providers = await this.providers();
    const resolvedJudge = await this.judgeTarget(effective);
    const ledger = readCostSnapshot();
    const run = this.visibleRun();
    return {
      config,
      providers,
      ...run !== undefined ? { run } : {},
      running: this.current !== undefined,
      ...resolvedJudge !== undefined ? { resolvedJudge } : {},
      ledger: {
        path: resolveLedgerPath(),
        available: ledger.available,
        ...ledger.error !== undefined ? { error: ledger.error } : {},
      },
      configPath: resolveConfigPath(),
      personaDir: resolvePersonaDir(),
    };
  }

  /**
   * Re-enumerate providers, bypassing the cache.
   * @returns the refreshed catalogue.
   */
  async refreshProviders(): Promise<ProviderOption[]> {
    return this.providers(true);
  }

  /**
   * Probe one provider route.
   * @param provider - the route to test.
   * @returns whether it answered and how many models it advertised.
   */
  async testProvider(provider: string): Promise<{ ok: boolean; models: number; message: string }> {
    return probeProvider(this.llm, provider);
  }

  /**
   * Merge a patch into the stored document and persist it.
   * @param patch - partial document from the settings page.
   * @returns the merged document with environment overrides applied.
   */
  async saveConfig(patch: unknown): Promise<RoundtableConfig> {
    // Return exactly what was written. Applying the environment overrides here
    // would feed a merged view back into the form, and the next save would then
    // persist an override the user never typed.
    return mergeConfig(patch);
  }

  /**
   * Re-read the document from disk, discarding unsaved in-memory edits.
   * @returns the reloaded document.
   */
  async reloadConfig(): Promise<RoundtableConfig> {
    return this.config();
  }

  /**
   * Screen a passage so the settings page can show what the current word list
   * actually catches.
   * @param text - the passage to screen.
   * @param words - the word list being edited, when it differs from the saved one.
   * @param patterns - the pattern list being edited, likewise.
   * @returns the matched rules, the redacted result, and the active rule count.
   */
  async scanPreview(
    text: string,
    words?: string[],
    patterns?: string[],
  ): Promise<{
    hits: string[];
    redacted: string;
    ruleCount: number;
    rejected: string[];
    timedOut: string[];
  }> {
    const config = this.config();
    const scanner = compileScanner({
      builtin: config.sensitive.builtin,
      // The page passes what is currently in the form, so a preview reflects
      // unsaved edits instead of the last saved policy.
      words: Array.isArray(words) ? words.map(String) : config.sensitive.words,
      patterns: Array.isArray(patterns) ? patterns.map(String) : config.sensitive.patterns,
    });
    const result = screen(scanner, text);
    return {
      hits: [...new Set(result.hits.map((hit) => hit.rule))],
      redacted: result.text,
      ruleCount: scanner.ruleCount,
      // Flatten to display strings here: the reason belongs next to the rule on
      // the settings page, and the wire only carries JSON.
      rejected: scanner.rejected.map((entry) => `${entry.rule}（${entry.reason}）`),
      timedOut: [...scanner.timedOut],
    };
  }

  /**
   * Start a discussion and return immediately.
   *
   * The run continues in the background: the settings page polls
   * {@link getState} for progress, and the `roundtable_start` tool waits on the
   * same run through {@link whenRunSettles}.
   * @param topic - topic override; empty keeps the stored topic.
   * @param rounds - round override; 0 keeps the stored value.
   * @returns the new run's initial state.
   * @throws when a discussion is already running or no participant is configured.
   */
  async startRun(topic: string, rounds: number): Promise<RunState> {
    if (this.current !== undefined) {
      throw new Error('已有一场讨论正在进行，请先终止或等待结束。');
    }
    let config = this.config();
    const patch: Record<string, unknown> = {};
    if (typeof topic === 'string' && topic.trim().length > 0 && topic.trim() !== config.topic) {
      patch.topic = topic.trim();
    }
    if (typeof rounds === 'number' && rounds > 0 && rounds !== config.maxRounds) {
      patch.maxRounds = Math.min(20, Math.max(1, Math.trunc(rounds)));
    }
    if (Object.keys(patch).length > 0) config = mergeConfig(patch);
    config = applyEnvironmentOverrides(config, readEnvironmentOverrides());
    if (config.participants.length === 0) {
      throw new Error('还没有配置任何选手，请先在「圆桌会议」设置页添加选手。');
    }
    ensurePersonaFiles(config);
    return this.launch(new RoundtableRun({ llm: this.llm, config, log: this.log }, config.topic));
  }

  /**
   * Continue the last finished discussion for more rounds.
   *
   * The new run is seeded with the previous transcript and digest, so round
   * numbering, shared context and the closing report all describe one debate
   * rather than two unrelated ones. It is never a resume of a killed process:
   * only a finished run in this session can be continued.
   * @param rounds - additional rounds; 0 or negative uses the stored `maxRounds`.
   * @returns the new run's initial state.
   * @throws when a discussion is running or there is nothing to continue.
   */
  async continueRun(rounds: number): Promise<RunState> {
    if (this.current !== undefined) {
      throw new Error('已有一场讨论正在进行，请先终止或等待结束。');
    }
    const previous = this.lastRun;
    if (previous === undefined) throw new Error('还没有可以续接的讨论记录。');
    if (previous.speeches.length === 0) throw new Error('上一场没有任何发言，无法续接。');
    let config = this.config();
    const extra = typeof rounds === 'number' && rounds > 0 ? Math.min(20, Math.trunc(rounds)) : config.maxRounds;
    if (extra !== config.maxRounds) config = mergeConfig({ maxRounds: extra });
    config = applyEnvironmentOverrides(config, readEnvironmentOverrides());
    if (config.participants.length === 0) {
      throw new Error('还没有配置任何选手，请先在「圆桌会议」设置页添加选手。');
    }
    ensurePersonaFiles(config);
    return this.launch(new RoundtableRun({ llm: this.llm, config, log: this.log }, previous.topic, {
      previousId: previous.id,
      completedRounds: previous.rounds,
      speeches: previous.speeches,
      summary: previous.summary,
    }));
  }

  /** Wire a run into the background driving and the visible-state slot. */
  private launch(run: RoundtableRun): RunState {
    this.current = run;
    this.lastRun = run.state;
    void run.execute().then((state) => {
      this.lastRun = state;
    }).catch((error: unknown) => {
      console.warn(`[roundtable] 讨论异常结束：${(error as Error).message}`);
    }).finally(() => {
      if (this.current === run) this.current = undefined;
    });
    return run.state;
  }

  /**
   * Stop the running discussion.
   * @returns the run state at the moment of the request.
   * @throws when nothing is running.
   */
  async stopRun(): Promise<RunState> {
    const run = this.current;
    if (run === undefined) throw new Error('当前没有正在进行的讨论。');
    run.stop('user-stop');
    return run.state;
  }

  /**
   * Forget the finished discussion the settings page is displaying.
   * @returns whether a finished run was cleared.
   * @throws when a discussion is running.
   */
  async clearRun(): Promise<boolean> {
    if (this.current !== undefined) throw new Error('讨论进行中，不能清空。');
    const had = this.lastRun !== undefined;
    this.lastRun = undefined;
    return had;
  }

  /**
   * Write the docx 战报 for the last finished discussion.
   * @returns the absolute path written.
   * @throws when no discussion has finished yet.
   */
  async exportDocx(): Promise<string> {
    const state = this.visibleRun();
    if (state === undefined) throw new Error('还没有可导出的讨论记录。');
    if (this.current !== undefined) throw new Error('讨论还在进行中，请等结束后再导出。');
    const config = this.config();
    const directory = resolveOutputDir(config);
    mkdirSync(directory, { recursive: true });
    const path = await buildDocxReport(state, { outputDir: directory, participants: config.participants });
    state.docxPath = path;
    this.lastRun = state;
    return path;
  }

  /**
   * Read the Markdown 战报 for the last finished discussion.
   * @returns the Markdown document, or an explanation when there is none.
   */
  async getReport(): Promise<string> {
    const state = this.visibleRun();
    if (state === undefined) return '还没有任何讨论记录。';
    return renderMarkdownReport(state, { outputDir: '', judgePersona: this.config().judge.persona });
  }

  /**
   * Score the last finished discussion again with the current referee and
   * rewrite its Markdown 战报.
   * @returns the refreshed run state.
   * @throws when no discussion has finished or no referee is available.
   */
  async rejudge(): Promise<RunState> {
    const state = this.visibleRun();
    if (state === undefined) throw new Error('还没有可重判的讨论记录。');
    if (this.current !== undefined) throw new Error('讨论还在进行中。');
    const config = this.config();
    const target = await this.judgeTarget(config);
    if (target === undefined) throw new Error('没有可用的裁判模型，请配置 JUDGE_MODEL 或裁判 provider/model。');
    state.judge = await runJudge(this.llm, {
      topic: state.topic,
      provider: target.provider,
      model: target.model,
      persona: config.judge.persona,
      participants: config.participants,
      speeches: state.speeches,
      costByParticipant: participantCostsOf(state.speeches, config.participants),
      weights: config.scoreWeights,
      timeoutMs: Math.max(config.requestTimeoutMs, 120_000),
    });
    const directory = resolveOutputDir(config);
    mkdirSync(directory, { recursive: true });
    state.reportPath = buildMarkdownReport(state, { outputDir: directory, judgePersona: config.judge.persona });
    this.lastRun = state;
    return state;
  }

  /**
   * Wait until the background run settles.
   * Used by the `roundtable_start` tool, which reports a finished discussion
   * rather than a started one.
   * @returns the settled run state, or the previous one when nothing is running.
   */
  async whenRunSettles(): Promise<RunState | undefined> {
    const run = this.current;
    if (run === undefined) return this.lastRun;
    while (this.current === run) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return this.lastRun ?? run.state;
  }

  /** The referee verdict of the visible run, for tool summaries. */
  judgeOfVisibleRun(): JudgeOutcome | undefined {
    return this.visibleRun()?.judge;
  }

  /** The persona text one configured participant would use, for diagnostics. */
  personaOf(participantId: string): string | undefined {
    const participant = this.config().participants.find((entry) => entry.id === participantId);
    return participant === undefined ? undefined : resolvePersona(participant);
  }

  /**
   * A compact roster for the system-prompt section and the startup log.
   * @returns one entry per participant, with a one-line persona hint.
   */
  rosterSnapshot(): { id: string; name: string; provider: string; model: string; personaHint: string }[] {
    return this.config().participants.map((participant) => ({
      id: participant.id,
      name: participant.name,
      provider: participant.provider,
      model: participant.model,
      personaHint: resolvePersona(participant).replace(/\s+/g, ' ').slice(0, 60),
    }));
  }

  /** Absolute path of the persisted document, without reading it. */
  configPathSnapshot(): string {
    return resolveConfigPath();
  }

  /** Absolute path of the persona mirror directory. */
  personaDirSnapshot(): string {
    return resolvePersonaDir();
  }

  /** The owning context, kept so the tools half can register against it. */
  get context(): Context {
    return this.hostCtx;
  }
}
