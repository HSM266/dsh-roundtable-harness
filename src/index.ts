/**
 * dsh-roundtable-harness — 多模型圆桌辩论插件。
 *
 * The plugin is a `bundle` row: the Harness loads this module, calls
 * {@link apply}, and everything registered here is disposed with the plugin's
 * fiber. There is deliberately no module-level mutable state.
 *
 * What it publishes:
 *   - the `roundtable` Cordis service, discovered by the Typert Gateway through
 *     its `typertRemote` binding so the settings page can call it as
 *     `ctx.remote.roundtable.*`;
 *   - three agent tools (`roundtable_start` / `roundtable_status` /
 *     `roundtable_export`);
 *   - one system-prompt section describing the capability and its boundaries.
 *
 * @module dsh-roundtable-harness
 */

import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { BOUNDARY_CLAUSE } from './roundtable.js';
import { RoundtableEndpoints, REMOTE_METHODS } from './service.js';
import { registerRoundtableTools } from './tools.js';

/** Plugin name, also the Loader row id used by `cordis.patch.yml`. */
export const name = 'roundtable';

/**
 * The plugin cannot do anything without the LLM service, and it must not
 * activate in a profile that has none.
 */
export const inject = ['llm'];

/** Composition-level knobs. Everything the *user* tunes lives in `roundtable.json`. */
export interface Config {
  /** Register the three agent tools. */
  exposeTools: boolean;
  /** Contribute a system-prompt section describing the roundtable and its roster. */
  injectPromptSection: boolean;
  /**
   * Order of that section. 0 is the deployment persona; 1 puts the roundtable
   * notice immediately after it, which is the high-priority slot personas are
   * meant to occupy.
   */
  promptOrder: number;
}

/** Schema for the Loader row's `config`. */
export const Config: Schema<Config> = Schema.object({
  exposeTools: Schema.boolean().default(true)
    .description('是否注册 roundtable_start / roundtable_status / roundtable_export 三个工具。'),
  injectPromptSection: Schema.boolean().default(true)
    .description('是否向 system prompt 注入圆桌会议说明与选手人设摘要。'),
  promptOrder: Schema.number().default(1)
    .description('该 prompt 段落的位置；0 是部署人格，1 紧跟其后。'),
});

/**
 * The compliance statement the plugin logs at startup, as required for a
 * plugin that orchestrates model-to-model argument.
 */
export const COMPLIANCE_NOTICE = [
  '[roundtable] 合规约束声明：',
  '  · 本插件只做多模型观点辩论，严禁生成或讨论任何敏感、违法、危害国家安全或破坏社会稳定的内容；',
  '  · 每次发言都按用户配置的词库与正则做一次敏感内容扫描，命中即替换为 [内容已过滤] 并记入异常记录；',
  '  · 命中次数超过阈值时立即终止讨论，并在战报中标记终止原因；',
  '  · 每位选手的 system prompt 都强制附加不可被对话覆盖的边界声明；',
  '  · Provider 与 API Key 全部沿用 DSH 自身的模型配置与凭据库，本插件不落盘任何密钥。',
].join('\n');

/** The remote namespace the settings page calls. */
export const REMOTE_NAMESPACE = 'roundtable';

/** Cordis service key the operations are provided under. */
export const SERVICE_KEY = 'roundtable';

/**
 * Attach Typert Remote markers to a class prototype without decorator syntax.
 *
 * The markers are what lets the Gateway resolve `namespace/method` against the
 * live service in source mode; the shim is the same technique the shipped
 * plain-JavaScript plugins use, because `emitDecoratorMetadata` is not part of
 * this bundle's build.
 * @param klass - the class whose prototype methods are Remote endpoints.
 * @param methods - public method names, in wire order.
 * @returns whether the protocol package was available and markers were applied.
 */
async function markRemoteMethods(klass: new (...args: never[]) => unknown, methods: readonly string[]): Promise<boolean> {
  let protocol: { Remote?: unknown } | undefined;
  try {
    protocol = await import('@deepseek-ai/dsh-typert-protocol') as { Remote?: unknown };
  } catch (error) {
    console.warn(`[roundtable] 未能加载 @deepseek-ai/dsh-typert-protocol，设置页将无法远程调用：${(error as Error).message}`);
    return false;
  }
  const Remote = protocol?.Remote;
  if (typeof Remote !== 'function') return false;
  for (const method of methods) {
    const decorator = (Remote as (name: string) => (value: unknown, context: unknown) => void)(method);
    const initializers: ((this: unknown) => void)[] = [];
    decorator(undefined, {
      name: method,
      private: false,
      static: false,
      addInitializer(callback: (this: unknown) => void) {
        initializers.push(callback);
      },
    });
    const receiver = Object.create(klass.prototype) as object;
    for (const initializer of initializers) initializer.call(receiver);
  }
  return true;
}

/**
 * Build the system-prompt section text for the current configuration.
 * Personas are summarized, never injected verbatim: the agent does not speak
 * them, and a full persona dump would compete with the real prompt.
 * @param service - the operations object, read for the current roster.
 * @returns the section text, or `''` when there is no roster to announce.
 */
function promptSectionText(service: RoundtableEndpoints): string {
  const roster = service.rosterSnapshot();
  if (roster.length === 0) return '';
  const lines = [
    '## 赛博圆桌（dsh-roundtable-harness）',
    '',
    '本机已启用多模型圆桌辩论能力。用户配置了以下选手，可以用 `roundtable_start` 让他们就同一话题多轮互喷：',
    ...roster.map((entry) =>
      `- ${entry.name}（${entry.provider}/${entry.model}）${entry.personaHint.length > 0 ? `：${entry.personaHint}` : ''}`),
    '',
    '规则：全部选手共享同一份历史发言；讨论结束后由裁判模型按六维（攻击性 / 逻辑 / 人物形象还原度 / 趣味度 / 策略 / 深度）'
    + '加权平均打分；性价比另行取 dsh-cost-meter 的真实账单计算，且只统计口径可用的选手——'
    + '没测到花费的人不入性价比榜。最后输出 Markdown《赛博圆桌战报》并可导出 docx。',
    '设置页的「续前讨论」可以在上一场基础上继续加轮次，轮次与上下文连续。',
    '在用户明确要求发起圆桌讨论之前，不要主动启动它。',
    '',
    BOUNDARY_CLAUSE,
  ];
  return lines.join('\n');
}

/**
 * Plugin entry point.
 * @param ctx - the owning context; every registration is disposed with it.
 * @param config - the validated Loader row configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  console.log(COMPLIANCE_NOTICE);

  const service = new RoundtableEndpoints(ctx, ctx.llm);
  const marked = await markRemoteMethods(
    RoundtableEndpoints as unknown as new (...args: never[]) => unknown,
    REMOTE_METHODS,
  );
  Object.defineProperty(service, 'typertRemote', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: { service, serviceKey: SERVICE_KEY, namespace: REMOTE_NAMESPACE },
  });
  ctx.provide(SERVICE_KEY, service);
  console.log(`[roundtable] 服务已注册为 ctx.${SERVICE_KEY}（Remote namespace ${REMOTE_NAMESPACE}，${marked ? `${REMOTE_METHODS.length} 个方法` : '未标记可远程方法'}）`);

  if (config?.exposeTools !== false) {
    ctx.inject(['tools'], (toolCtx) => {
      const disposers = registerRoundtableTools(toolCtx, service, toolCtx.tools);
      toolCtx.effect(() => () => {
        for (const dispose of disposers.reverse()) dispose();
      }, 'roundtable: tools');
      console.log('[roundtable] 已注册工具 roundtable_start / roundtable_status / roundtable_export');
    });
  }

  if (config?.injectPromptSection !== false) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.systemPrompt.section({
        name: 'roundtable:personas',
        order: Number.isFinite(config?.promptOrder) ? config.promptOrder : 1,
        text: () => promptSectionText(service),
      });
      console.log('[roundtable] 已注入 system prompt 段落 roundtable:personas');
    });
  }

  // Read the roster once at startup so a broken document is reported in the log
  // rather than at the moment the user presses 开始讨论.
  const roster = service.rosterSnapshot();
  console.log(`[roundtable] 已加载 ${roster.length} 位选手：${roster.map((entry) => entry.name).join('、') || '（无，请在设置页添加）'}`);
  console.log(`[roundtable] 配置文件 ${service.configPathSnapshot()}；人格镜像 ${service.personaDirSnapshot()}`);
}
