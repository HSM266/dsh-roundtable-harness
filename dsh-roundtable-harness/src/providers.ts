/**
 * Provider catalogue and the one-shot model call.
 *
 * Providers are *configuration* in the Harness, not adapter code: the LLM
 * service already routes every configured gateway (Yomi, 百炼/dashscope, 灵途,
 * DeepSeek official, …). This module therefore never stores an endpoint or a
 * key — it enumerates what the installation already has and streams through it.
 *
 * @module dsh-roundtable-harness/providers
 */

import {
  createAssistantMessage,
  createUserMessage,
  type LlmRuntime,
  type LlmModelInfo,
  type Message,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm';

/** One selectable model. */
export interface ModelOption {
  id: string;
  name: string;
}

/** One provider route with its advertised models. */
export interface ProviderOption {
  id: string;
  name: string;
  models: ModelOption[];
  /** Populated when the catalogue could not be read for this route. */
  error?: string;
}

/** Plugin name stamped on every message this plugin creates. */
export const MESSAGE_SOURCE_PLUGIN = 'dsh-roundtable-harness';

/** How a call ended. */
export type CallFailureKind =
  | 'timeout'
  | 'rate-limited'
  | 'bad-gateway'
  | 'aborted'
  | 'error'
  | 'empty'
  | 'no-provider';

/** Successful call outcome. */
export interface CallSuccess {
  ok: true;
  text: string;
  usage: TokenUsage;
  elapsedMs: number;
  finishKind: string;
}

/** Failed call outcome. */
export interface CallFailure {
  ok: false;
  kind: CallFailureKind;
  message: string;
  status?: number;
  elapsedMs: number;
}

export type CallOutcome = CallSuccess | CallFailure;

/** Failures that must abort the whole discussion immediately. */
export function isFatalFailure(kind: CallFailureKind): boolean {
  return kind === 'rate-limited' || kind === 'bad-gateway';
}

/**
 * Estimate tokens for a piece of text.
 *
 * The Harness ships a real estimator (`ctx.tokenMeter`), but it needs a
 * `Session`; a roundtable turn is not a session. This heuristic is deliberately
 * conservative (it over-counts rather than under-counts) so the budget trips
 * early instead of overflowing a provider window: CJK glyphs count ≈1 token,
 * other characters ≈1/3.5.
 * @param text - the text to measure.
 * @returns an estimated token count, never below 1 for non-empty text.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let cjk = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) {
      cjk += 1;
    }
  }
  const other = text.length - cjk;
  return Math.max(1, Math.ceil(cjk + other / 3.5));
}

/** Estimate the tokens of a whole message list plus a system prompt. */
export function estimateMessagesTokens(system: string, messages: readonly Message[]): number {
  let total = estimateTokens(system);
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
        total += estimateTokens((block as { text: string }).text);
      }
    }
    total += 4;
  }
  return total;
}

/** Build one user-role message carrying plain text. */
export function userMessage(text: string): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: MESSAGE_SOURCE_PLUGIN },
  });
}

/** Build one assistant-role message attributed to a provider/model. */
export function assistantMessage(provider: string, model: string, text: string): Message {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider, model },
  });
}

/**
 * Enumerate every provider the installation has configured, with its models.
 * A route whose model listing fails is still reported, carrying `error`, so the
 * settings page can show it and the user can test it.
 * @param llm - the Harness LLM service.
 * @param aliases - optional `alias -> provider route` map applied as extra rows.
 * @returns providers in registration order, aliases first.
 */
export async function loadProviderCatalog(
  llm: LlmRuntime,
  aliases: Record<string, string> = {},
): Promise<ProviderOption[]> {
  const providers: ProviderOption[] = [];
  const seen = new Set<string>();

  let live: { id: string; name: string }[] = [];
  try {
    live = llm.listProviders();
  } catch (error) {
    console.warn(`[roundtable] 读取 Provider 列表失败：${(error as Error).message}`);
  }

  const known = new Map(live.map((entry) => [entry.id, entry.name]));
  for (const [alias, target] of Object.entries(aliases)) {
    if (seen.has(alias)) continue;
    seen.add(alias);
    providers.push({
      id: alias,
      name: `${alias} → ${target}`,
      models: await listModelsSafely(llm, target),
    });
  }

  for (const entry of live) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    providers.push({
      id: entry.id,
      name: entry.name.length > 0 ? entry.name : entry.id,
      models: await listModelsSafely(llm, entry.id),
    });
  }

  // An alias pointing at a route that is not registered is still worth showing.
  for (const target of Object.values(aliases)) {
    if (known.has(target) || providers.some((entry) => entry.id === target)) continue;
    providers.push({ id: target, name: target, models: [], error: '未注册的 Provider 路由' });
  }
  return providers;
}

async function listModelsSafely(llm: LlmRuntime, provider: string): Promise<ModelOption[]> {
  try {
    const models: LlmModelInfo[] = await llm.listModels(provider);
    return models.map((model) => ({
      id: model.id,
      name: model.name.length > 0 ? model.name : model.id,
    }));
  } catch (error) {
    console.warn(`[roundtable] 读取 ${provider} 的模型列表失败：${(error as Error).message}`);
    return [];
  }
}

/**
 * Resolve a friendly `qwen`-style name to a real provider route.
 * @param llm - the Harness LLM service.
 * @param hint - an exact route, an alias, or a loose display hint.
 * @param aliases - configured `alias -> route` map.
 * @returns the chosen route and model, or `undefined` when nothing matches.
 */
export async function resolveTarget(
  llm: LlmRuntime,
  hint: { provider: string; model: string },
  aliases: Record<string, string> = {},
): Promise<{ provider: string; model: string } | undefined> {
  const providers = await loadProviderCatalog(llm, aliases);
  const providerHint = hint.provider.trim().toLowerCase();
  const modelHint = hint.model.trim().toLowerCase();

  const pick = (predicate: (provider: ProviderOption) => boolean): ProviderOption | undefined =>
    providers.find(predicate);

  let target: ProviderOption | undefined;
  if (providerHint.length > 0) {
    target = pick((entry) => entry.id.toLowerCase() === providerHint)
      ?? pick((entry) => entry.name.toLowerCase().includes(providerHint));
  }
  if (target === undefined && modelHint.length > 0) {
    target = pick((entry) => entry.models.some((model) => model.id.toLowerCase() === modelHint));
  }
  if (target === undefined && (providerHint.length > 0 || modelHint.length > 0)) {
    // The documented first-run default: a qwen route, else the first route with models.
    target = pick((entry) => /qwen|dashscope|bailian|百炼/i.test(`${entry.id} ${entry.name}`))
      ?? pick((entry) => entry.models.length > 0);
  }
  if (target === undefined) return undefined;

  const models = target.models;
  const model = modelHint.length > 0
    ? models.find((entry) => entry.id.toLowerCase() === modelHint)?.id
      ?? models.find((entry) => entry.id.toLowerCase().includes(modelHint))?.id
      ?? (models.length > 0 ? models[0]!.id : hint.model.trim())
    : models.find((entry) => /qwen/i.test(entry.id))?.id ?? (models.length > 0 ? models[0]!.id : '');
  if (model.length === 0) return undefined;
  return { provider: target.id, model };
}

/** Options for {@link callModel}. */
export interface CallModelOptions {
  provider: string;
  model: string;
  system?: string;
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Caller cancellation; combined with the internal timeout. */
  signal?: AbortSignal;
}

/**
 * Stream one model call to completion and assemble its text.
 *
 * A timeout aborts this call only (the caller records the AI as absent for the
 * round); 429 and 502/503/504 are reported as fatal so the engine can stop the
 * whole discussion.
 * @param llm - the Harness LLM service.
 * @param options - the request.
 * @returns the assembled text and usage, or a classified failure.
 */
export async function callModel(llm: LlmRuntime, options: CallModelOptions): Promise<CallOutcome> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('roundtable request timeout'));
  }, timeoutMs);
  const externalAbort = (): void => controller.abort(options.signal?.reason);
  if (options.signal !== undefined) {
    if (options.signal.aborted) externalAbort();
    else options.signal.addEventListener('abort', externalAbort, { once: true });
  }

  let text = '';
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let finishKind = 'unknown';
  let failure: { message: string; code?: string; status?: number } | undefined;

  try {
    const stream: AsyncIterable<StreamChunk> = llm.stream({
      provider: options.provider,
      model: options.model,
      messages: options.messages,
      ...options.system !== undefined && options.system.length > 0 ? { system: options.system } : {},
      ...options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
      ...options.temperature !== undefined ? { temperature: options.temperature } : {},
      signal: controller.signal,
    });
    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'text-delta':
          text += chunk.text;
          break;
        case 'block-end':
          if (chunk.block.type === 'text' && typeof (chunk.block as { text?: unknown }).text === 'string') {
            // Adapters emit deltas and the assembled block; trust the block when
            // the deltas were suppressed, never append both.
            const blockText = (chunk.block as { text: string }).text;
            if (text.length === 0) text = blockText;
          }
          break;
        case 'usage':
          usage = chunk.usage;
          break;
        case 'finish':
          finishKind = chunk.reason.kind;
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            failure = {
              message: chunk.reason.failure?.message ?? '模型调用失败',
              ...chunk.reason.failure?.code !== undefined ? { code: chunk.reason.failure.code } : {},
              ...chunk.reason.failure?.status !== undefined ? { status: chunk.reason.failure.status } : {},
            };
          }
          break;
        default:
          break;
      }
    }
  } catch (error) {
    failure = { message: (error as Error).message };
  } finally {
    clearTimeout(timer);
    if (options.signal !== undefined) options.signal.removeEventListener('abort', externalAbort);
  }

  const elapsedMs = Date.now() - started;
  if (failure !== undefined) {
    return { ...classifyFailure(failure, timedOut, options.signal), elapsedMs };
  }
  if (timedOut || controller.signal.aborted) {
    return {
      ok: false,
      kind: options.signal?.aborted === true && !timedOut ? 'aborted' : 'timeout',
      message: timedOut ? `请求超过 ${timeoutMs} ms 未返回` : '调用被取消',
      elapsedMs,
    };
  }
  if (text.trim().length === 0) {
    return { ok: false, kind: 'empty', message: '模型返回内容为空', elapsedMs };
  }
  return { ok: true, text, usage, elapsedMs, finishKind };
}

function classifyFailure(
  failure: { message: string; code?: string; status?: number },
  timedOut: boolean,
  signal: AbortSignal | undefined,
): Omit<CallFailure, 'elapsedMs'> {
  const status = failure.status;
  if (status === 429) return { ok: false, kind: 'rate-limited', message: failure.message, status };
  if (status !== undefined && status >= 500 && status <= 504) {
    return { ok: false, kind: 'bad-gateway', message: failure.message, status };
  }
  if (timedOut) return { ok: false, kind: 'timeout', message: failure.message };
  if (failure.code === 'ABORTED' || signal?.aborted === true) {
    return { ok: false, kind: 'aborted', message: failure.message };
  }
  return {
    ok: false,
    kind: 'error',
    message: failure.message,
    ...status !== undefined ? { status } : {},
  };
}

/**
 * Probe one provider route so the settings page can report connectivity.
 * @param llm - the Harness LLM service.
 * @param provider - the route to probe.
 * @returns whether the route answered, and how many models it advertised.
 */
export async function probeProvider(
  llm: LlmRuntime,
  provider: string,
): Promise<{ ok: boolean; models: number; message: string }> {
  try {
    if (!llm.listProviders().some((entry) => entry.id === provider)) {
      return { ok: false, models: 0, message: `未注册的 Provider 路由「${provider}」` };
    }
    const models = await llm.listModels(provider);
    return { ok: true, models: models.length, message: `连接正常，发现 ${models.length} 个模型` };
  } catch (error) {
    return { ok: false, models: 0, message: (error as Error).message };
  }
}
