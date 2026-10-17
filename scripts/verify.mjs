/**
 * Verification harness.
 *
 * Builds the shipped artifacts, then bundles `test/verify-entry.ts` with the
 * Harness packages aliased to stubs so the whole engine can be exercised
 * offline — no API key, no provider, no Harness installation.
 *
 * Usage: `npm run verify`
 * Exit code 0 only when every check passes.
 *
 * @module dsh-roundtable-harness/scripts/verify
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from './build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workDir = resolve(root, 'test/.build');

/** Bundle the verification entry against stubbed Harness packages. */
async function bundleVerifyEntry(esbuild) {
  mkdirSync(workDir, { recursive: true });
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['test/verify-entry.ts'],
    outfile: 'test/.build/verify-entry.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    minify: false,
    external: ['docx'],
    // The client imports its launcher artwork as a PNG; the harness bundles the
    // same source, so it needs the same loader.
    loader: { '.png': 'dataurl' },
    alias: {
      '@deepseek-ai/dsh-llm': resolve(root, 'test/stubs/dsh-llm.ts'),
      '@deepseek-ai/dsh-tools': resolve(root, 'test/stubs/dsh-tools.ts'),
      '@deepseek-ai/dsh-typert-protocol': resolve(root, 'test/stubs/dsh-typert-protocol.ts'),
      '@deepseek-ai/schemastery': resolve(root, 'test/stubs/schemastery.ts'),
      'react': resolve(root, 'test/stubs/react.ts'),
    },
    logLevel: 'warning',
  });
  return resolve(workDir, 'verify-entry.mjs');
}

/**
 * Static check: no hook may appear after an early return in a component.
 *
 * React aborts the whole tree with "rendered more hooks than during the previous
 * render" (#310) the moment the hook count changes between renders, and an early
 * `return` above a `useMemo` does exactly that. The bug shipped once; this keeps
 * it from shipping again.
 * @returns a check result.
 */
function checkHookOrder() {
  const source = readFileSync(resolve(root, 'src/client.tsx'), 'utf8');
  const offset = source.indexOf('function SettingsPage');
  if (offset < 0) {
    return { name: '客户端 hook 顺序：组件内所有 hook 都在早返回之前', ok: false, detail: '找不到 SettingsPage' };
  }
  const body = (() => {
    // Bound the scan to this one function: other components further down may
    // legitimately have hooks after their own guards.
    const open = source.indexOf('{', source.indexOf(')', offset));
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
      const character = source[index];
      if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(offset, index);
      }
    }
    return source.slice(offset);
  })();
  // Find the first top-level guard that actually returns: that is the line any
  // later hook would sit behind.
  const lines = body.split('\n');
  let earlyReturn = -1;
  let cursor = 0;
  for (const [index, line] of lines.entries()) {
    // Two spaces or a tab: indentation style is not the point, the top-level
    // guard is.
    if (/^(?: {2}|\t)if \(/.test(line)) {
      const window = lines.slice(index, index + 8).join('\n');
      if (window.includes('return (')) {
        earlyReturn = cursor;
        break;
      }
    }
    cursor += line.length + 1;
  }
  const hookCall = /\bReact\.use[A-Z][A-Za-z]*\(/g;
  const offenders = [];
  let match = hookCall.exec(body);
  while (match !== null) {
    if (earlyReturn >= 0 && match.index > earlyReturn) offenders.push(match[0]);
    match = hookCall.exec(body);
  }
  return {
    name: '客户端 hook 顺序：组件内所有 hook 都在早返回之前（防 React #310）',
    ok: earlyReturn >= 0 && offenders.length === 0,
    detail: earlyReturn < 0
      ? '没找到早返回，检查失效'
      : `早返回位置 ${earlyReturn}，其后的 hook 调用：${offenders.length === 0 ? '无' : offenders.join(',')}`,
  };
}

/**
 * Static check: the client registers its three slot seats.
 *
 * The settings section, the sidebar-foot button and the overlay window are plain
 * `ctx.slots.inject` calls, so a removed or renamed one would only surface after
 * a browser refresh — this catches it at build time.
 * @returns a check result.
 */
function checkClientSlots() {
  const source = readFileSync(resolve(root, 'src/client.tsx'), 'utf8');
  const wanted = ['settings.section', 'shell.overlay'];
  const missing = wanted.filter((name) => !source.includes(`slots.inject('${name}'`));
  const registersWindow = source.includes("id: 'roundtable.window'");
  const hasWidget = source.includes('function mountWidget') && source.includes('dataset.roundtableWidget');
  // The launcher must be a body-level element with its own listeners: the overlay
  // layer swallows pointer events for anything but its direct children, and
  // pointer capture throws inside some containers.
  const draggable = source.includes("button.addEventListener('mousedown'")
    && source.includes('WIDGET_POSITION_KEY')
    && source.includes("addEventListener('mousemove'")
    && source.includes('document.body.appendChild(button)')
    && !source.includes('pointer capture');
  // The sidebar-foot duplicate was removed on request; guard against re-adding it.
  const noSidebarDuplicate = !source.includes("slots.inject('sidebar.footer.action'");
  return {
    name: '客户端注册：设置页 + 覆盖窗口 + 可拖动挂件（且不再重复一个侧栏按钮）',
    ok: missing.length === 0 && registersWindow && hasWidget && draggable && noSidebarDuplicate,
    detail: `缺失=${missing.join(',') || '无'} window=${registersWindow} widget=${hasWidget} drag=${draggable} 无侧栏重复=${noSidebarDuplicate}`,
  };
}

async function main() {
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch (error) {
    console.error(`[verify] 需要 esbuild 才能运行验证：${error.message}`);
    console.error('[verify] 先执行 npm install（或 pnpm install）。');
    process.exitCode = 1;
    return;
  }

  console.log('[verify] 构建 lib/index.js 与 lib/client.js …');
  const { outfiles } = await build({ esbuild, logLevel: 'warning' });
  for (const path of outfiles) console.log(`[verify]   ✓ ${path}`);

  console.log('[verify] 打包离线验证入口 …');
  const entry = await bundleVerifyEntry(esbuild);

  // A mock run must not sleep through cost-meter's write debounce.
  process.env.ROUNDTABLE_LEDGER_SETTLE_MS = process.env.ROUNDTABLE_LEDGER_SETTLE_MS ?? '0';
  process.env.DSH_HOME = resolve(workDir, 'dsh-home');

  const module = await import(`${pathToFileURL(entry).href}?t=${Date.now()}`);
  const results = await module.runAllChecks();
  results.push(...module.runSettingsPageChecks());
  results.push(...await module.runCrashPathChecks());
  results.push(await module.runEnvelopeCheck());
  results.push(await module.runWiringCheck());
  results.push(module.checkPollingWiring());
  results.push(checkHookOrder());
  results.push(checkClientSlots());

  let failed = 0;
  console.log('');
  for (const [index, result] of results.entries()) {
    const mark = result.ok ? '✓' : '✗';
    if (!result.ok) failed += 1;
    console.log(`[verify] ${mark} ${index + 1}. ${result.name}`);
    console.log(`[verify]     ${result.detail}`);
  }
  console.log('');
  console.log(`[verify] ${results.length - failed}/${results.length} 项通过`);

  try {
    rmSync(resolve(workDir, 'dsh-home'), { recursive: true, force: true });
  } catch {
    // Leaving an empty temp home behind is harmless.
  }
  if (failed > 0) process.exitCode = 1;
}

await main();
