/**
 * Ambient declarations for the DeepSeek Harness packages this bundle consumes.
 *
 * The Harness resolves `@deepseek-ai/*` specifiers from its own installation at
 * runtime, and those packages are not published for out-of-tree type checkers.
 * These stubs therefore declare exactly the surface this plugin uses, so
 * `tsc --noEmit` passes in a bare checkout or in CI. Every signature below was
 * read from the version this plugin was verified against
 * (`@deepseek-ai/dsh-*` 0.2.0-rc.2) — see README "API 依据".
 *
 * Do not widen these types to make code compile; widen the code instead.
 */

declare module '@deepseek-ai/cordis' {
  /** Cleanup returned by every registration helper. */
  export type Disposable = () => void;

  export interface Context {
    /** Cordis service lookup; `undefined` when the service is absent. */
    get<T = unknown>(name: string): T | undefined;
    /** Register a value under a Cordis service key. */
    provide(name: string, value: unknown): void;
    /** Register a resource whose disposer runs when this context unloads. */
    effect(callback: () => Disposable | void | Generator<unknown, Disposable | void, unknown>, label?: string): Disposable;
    /** Run `callback` once the named services exist, and again if they return. */
    inject(names: string[], callback: (ctx: Context) => void): Disposable;
    /** Subscribe to one Cordis or Harness event. */
    on(event: string, listener: (...args: any[]) => unknown): Disposable;
    /** Register a child plugin. */
    plugin(plugin: unknown, config?: unknown): Disposable;
    /** Mount another context as a child. */
    scope?: unknown;
    readonly llm: import('@deepseek-ai/dsh-llm').LlmRuntime;
    readonly tools: import('@deepseek-ai/dsh-tools').ToolRuntime;
    readonly systemPrompt: import('@deepseek-ai/dsh-system-prompt').SystemPrompt;
    [key: string]: any;
  }

  export class Service<T = never> {
    protected constructor(ctx: Context, name: string);
    readonly name: string;
    protected readonly ctx: Context;
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  import type { Context, Service as CordisService } from '@deepseek-ai/cordis';

  /** Binding the Typert Gateway reads for source-mode Remote discovery. */
  export interface TypertGatewayBinding<Subject extends object> {
    readonly service: Subject;
    readonly serviceKey: string;
    readonly namespace: string;
  }

  /** Cordis Service base that also exposes itself to the Typert Gateway. */
  export abstract class TypertRemoteService<out T = never> extends CordisService<T> {
    readonly typertRemote: TypertGatewayBinding<any>;
    protected constructor(ctx: Context, serviceKey: string, options?: { namespace?: string });
  }

  /** Mark one method as a directly invocable Remote endpoint. */
  export function Remote(exportName: string): (value: unknown, context: any) => void;
  export function Remote(value: unknown, context: any): void;

  /** Structured failure a Remote call surfaces to the Client. */
  export class RemoteError extends Error {
    constructor(code: string, message: string, details?: unknown, options?: unknown);
    readonly code: string;
  }
}

declare module '@deepseek-ai/dsh-llm' {
  export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  }

  export interface TextBlock { type: 'text'; text: string }
  export type ContentBlock = { type: string; [key: string]: unknown } | TextBlock;

  export interface Message {
    readonly id: string;
    readonly role: 'system' | 'user' | 'assistant';
    readonly content: readonly ContentBlock[];
    readonly source: Record<string, unknown>;
  }

  export interface LlmProviderInfo { id: string; name: string }
  export interface LlmModelInfo {
    provider: string;
    id: string;
    name: string;
    description?: string;
  }
  export interface LlmResolvedModelInfo extends LlmModelInfo {
    context?: { contextWindow: number };
    defaultMaxTokens?: number;
  }

  export interface GenerateOptions {
    provider: string;
    model: string;
    messages: Message[];
    system?: string;
    tools?: { name: string; description: string; parameters: Record<string, unknown> }[];
    temperature?: number;
    maxTokens?: number;
    stop?: string[];
    signal?: AbortSignal;
  }

  export type FinishReason =
    | { kind: 'stop' }
    | { kind: 'tool-calls' }
    | { kind: 'max-tokens' }
    | { kind: 'aborted'; failure?: { code?: string; message?: string; status?: number } }
    | { kind: 'error'; failure?: { code?: string; message?: string; status?: number } };

  export type StreamChunk =
    | { type: 'block-start'; index: number; blockType: string }
    | { type: 'text-delta'; index: number; text: string }
    | { type: 'reasoning-delta'; index: number; text: string }
    | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
    | { type: 'block-end'; index: number; block: ContentBlock }
    | { type: 'usage'; usage: TokenUsage }
    | { type: 'finish'; reason: FinishReason };

  export class LlmError extends Error {
    constructor(message: string, code: string, options?: unknown);
    readonly code: string;
  }

  export class LlmRuntime {
    listProviders(): LlmProviderInfo[];
    listModels(provider: string): Promise<LlmModelInfo[]>;
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  }

  /** Create one immutable user-role message. */
  export function createUserMessage(input: {
    content: ContentBlock[];
    source: Record<string, unknown>;
  }): Message;

  /** Create one immutable assistant-role message. */
  export function createAssistantMessage(input: {
    content: ContentBlock[];
    source: { provider: string; model: string; replayState?: unknown };
  }): Message;
}

declare module '@deepseek-ai/dsh-tools' {
  export interface ToolResultContent { type: 'text'; text: string }

  export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output?: {
      schema: Record<string, unknown>;
      render: (args: unknown, value: unknown) => ToolResultContent[];
    };
    execute: (args: any) => Promise<unknown> | unknown;
  }

  export class ToolRuntime {
    register(definition: ToolDefinition): () => void;
  }

  /** Build a tool definition, inferring argument types from `parameters`. */
  export function defineTool<T extends ToolDefinition>(definition: T): T;
}

declare module '@deepseek-ai/dsh-system-prompt' {
  export interface PromptSection {
    name: string;
    order: number;
    text: string | ((context: unknown) => string);
    complete?: boolean;
  }

  export class SystemPrompt {
    section(section: PromptSection): () => void;
    getSectionOrder(name: string): number;
  }
}

declare module '@deepseek-ai/schemastery' {
  interface Schema<T> {
    default(value: T): Schema<T>;
    required(): Schema<T>;
    description(text: string): Schema<T>;
  }
  interface SchemaStatic {
    <T>(value?: unknown): Schema<T>;
    object<T extends Record<string, unknown>>(shape: { [K in keyof T]: Schema<T[K]> }): Schema<T>;
    string(): Schema<string>;
    number(): Schema<number>;
    boolean(): Schema<boolean>;
    array<T>(inner: Schema<T>): Schema<T[]>;
    union<T>(values: readonly T[]): Schema<T>;
    dict<T>(inner: Schema<T>): Schema<Record<string, T>>;
    const<T>(value: T): Schema<T>;
    any(): Schema<unknown>;
  }
  const Schema: SchemaStatic;
  export default Schema;
}

/** Bundler-inlined assets: esbuild's  loader turns these into strings. */
declare module '*.png' {
  const url: string;
  export default url;
}
