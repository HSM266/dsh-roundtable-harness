/**
 * docx 战报 generation.
 *
 * `docx` writes the OOXML package from scratch, which is what this report
 * needs: a cover with embedded avatar thumbnails, one chapter per round, and a
 * deterministic anomaly chapter. `docxtemplater` would force a template file
 * and `mammoth` converts the wrong direction, so neither applies here.
 *
 * The package is imported **lazily**, on the first export. It is a large dual
 * ESM/CJS dependency that only one code path needs, and loading it at plugin
 * activation would make the whole plugin hostage to it.
 *
 * An avatar that cannot be read is *not* fatal: the paragraph falls back to the
 * participant's name and the failure is appended to the anomaly chapter, so a
 * broken image path never costs the user the whole report.
 *
 * @module dsh-roundtable-harness/docx-export
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { RunState, Speech, AnomalyRecord } from './roundtable.js';
import { describeCostSource, describeCostStatus, describeStopReason, sanitizeText, timestampSlug } from './report.js';
import { SCORE_DIMENSIONS, SCORE_DIMENSION_LABELS, describeWeights } from './dimensions.js';
import { AI_JUDGE_DISCLAIMER } from './judge.js';
import type { ParticipantConfig } from './config.js';

/** The `docx` module namespace, loaded on demand. */
type DocxModule = typeof import('docx');

let docxModule: Promise<DocxModule> | undefined;

/**
 * Load `docx` once per process.
 * @returns the module namespace.
 * @throws when the dependency is missing, with an actionable message.
 */
async function loadDocx(): Promise<DocxModule> {
  docxModule ??= import('docx').catch((error: unknown) => {
    docxModule = undefined;
    throw new Error(`docx 依赖不可用：${(error as Error).message}。请在插件目录执行 npm install，或重新安装本 bundle。`);
  });
  return docxModule;
}

/** Options for {@link buildDocxReport}. */
export interface DocxOptions {
  /** Directory the .docx is written to; created by the caller. */
  outputDir: string;
  /** Participants, used for the cover roster and avatar resolution. */
  participants: readonly ParticipantConfig[];
  /** File-name stem; defaults to `roundtable-<timestamp>`. */
  fileStem?: string;
}

/** Image types the OOXML package accepts for an inline drawing. */
type ImageType = 'png' | 'jpg' | 'gif' | 'bmp';

const IMAGE_TYPES: Record<string, ImageType> = {
  '.png': 'png',
  '.jpg': 'jpg',
  '.jpeg': 'jpg',
  '.gif': 'gif',
  '.bmp': 'bmp',
};

/** Longest a remote avatar download may take. */
export const AVATAR_TIMEOUT_MS = 8_000;

/** Largest avatar the exporter will read into the document. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** Content types the exporter accepts, mapped to the OOXML drawing type. */
const CONTENT_TYPE_TO_IMAGE: Record<string, ImageType> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
};

/** Hostname suffixes that never name a public internet host. */
const BLOCKED_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa', '.lan'];

/**
 * Parse an IPv6 literal into its eight 16-bit groups.
 *
 * Classification has to work on values, not on the surface spelling: the same
 * loopback address has many legal textual forms (`::1`, `0:0:0:0:0:0:0:1`,
 * `[::1]`, `::ffff:127.0.0.1`, `0:0:0:0:0:0:ffff:7f00:1`, …). Any check built
 * from string prefixes misses most of them.
 * @param address - an IPv6 literal; brackets and a zone id are allowed.
 * @returns the eight groups, or `undefined` when the text is not IPv6.
 */
export function parseIPv6(address: string): number[] | undefined {
  let text = address.trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  // Drop a zone id (`fe80::1%eth0`); it does not change the range.
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (text.length === 0 || !text.includes(':')) return undefined;

  // A trailing dotted IPv4 ("::ffff:127.0.0.1") occupies the last two groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.');
    if (octets.length !== 4) return undefined;
    const numbers = octets.map((octet) => Number(octet));
    if (numbers.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = numbers;
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const parseHalf = (half: string): number[] | undefined => {
    if (half.length === 0) return [];
    const parts = half.split(':');
    const values: number[] = [];
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
      values.push(Number.parseInt(part, 16));
    }
    return values;
  };
  const head = parseHalf(halves[0] ?? '');
  if (head === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const back = parseHalf(halves[1] ?? '');
  if (back === undefined) return undefined;
  const missing = 8 - head.length - back.length;
  if (missing < 1) return undefined;
  const groups = [...head, ...new Array<number>(missing).fill(0), ...back];
  return groups.length === 8 ? groups : undefined;
}

/** Compose the 32-bit integer of an IPv4 literal, or `undefined`. */
export function parseIPv4(address: string): number | undefined {
  const parts = address.trim().split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/** Whether a 32-bit IPv4 value is a public unicast address. */
function isPublicIPv4(value: number): boolean {
  const a = (value >>> 24) & 0xff;
  const b = (value >>> 16) & 0xff;
  const c = (value >>> 8) & 0xff;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;              // CGNAT 100.64/10
  if (a === 169 && b === 254) return false;                        // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;               // private
  if (a === 192 && b === 168) return false;                        // private
  if (a === 192 && b === 0) return false;                          // 192.0.0/24, 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return false;           // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;            // 198.51.100/24
  if (a === 203 && b === 0 && c === 113) return false;             // 203.0.113/24
  return true;
}

/**
 * Whether an IP literal is safe to fetch from.
 *
 * Blocks loopback, private, link-local, CGNAT, multicast, reserved,
 * documentation, ULA, site-local and unspecified ranges for both families,
 * including every textual form of an IPv4-mapped / IPv4-compatible / NAT64 /
 * 6to4 address. The point is to keep an `avatar` URL from turning the exporter
 * into a probe of the operator's own network.
 * @param address - an IP literal (not a hostname).
 * @returns `true` when the address is a public unicast address.
 */
export function isPublicAddress(address: string): boolean {
  const trimmed = address.trim();
  if (trimmed.length === 0) return false;
  const plain = trimmed.replace(/^\[|\]$/g, '');

  const v4 = parseIPv4(plain);
  if (v4 !== undefined) return isPublicIPv4(v4);

  const groups = parseIPv6(plain);
  if (groups === undefined) return false;

  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const embedded = (high: number, low: number): number => (((high & 0xffff) << 16) | (low & 0xffff)) >>> 0;

  // ::/96 — unspecified, loopback, or an IPv4-compatible address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    if (g6 === 0 && g7 === 0) return false;                  // ::
    if (g6 === 0 && g7 === 1) return false;                  // ::1
    return isPublicIPv4(embedded(g6, g7));                   // ::a.b.c.d
  }
  // ::ffff:0:0/96 — IPv4-mapped.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPublicIPv4(embedded(g6, g7));
  }
  // 0064:ff9b::/96 — NAT64 well-known prefix.
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPublicIPv4(embedded(g6, g7));
  }
  // 2002::/16 — 6to4; the embedded IPv4 lives in groups 1-2.
  if (g0 === 0x2002) return isPublicIPv4(embedded(g1, g2));
  // 2001:0::/32 — Teredo tunnel.
  if (g0 === 0x2001 && g1 === 0) return false;
  // 2001:db8::/32 — documentation.
  if (g0 === 0x2001 && g1 === 0x0db8) return false;
  // 0100::/64 — discard-only.
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return false;
  // fc00::/7 — unique local.
  if ((g0 & 0xfe00) === 0xfc00) return false;
  // fe80::/10 — link-local.
  if ((g0 & 0xffc0) === 0xfe80) return false;
  // fec0::/10 — deprecated site-local.
  if ((g0 & 0xffc0) === 0xfec0) return false;
  // ff00::/8 — multicast.
  if ((g0 & 0xff00) === 0xff00) return false;
  return true;
}

/**
 * Reject a URL that points at a host the exporter must not touch.
 *
 * Both the literal host and every DNS answer are checked, because a public name
 * can resolve to a private address.
 * @param url - the parsed avatar URL.
 * @returns an error message, or `undefined` when the host is acceptable.
 */
async function assertPublicHost(url: URL): Promise<string | undefined> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `不支持的协议：${url.protocol}`;
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname.length === 0) return '形象图 URL 没有主机名';
  if (hostname === 'localhost' || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return `形象图 URL 指向本机/内网主机：${hostname}`;
  }
  // Decide "is this a literal?" with our own parsers, not `net.isIP`: Node
  // rejects legal mixed forms such as `0:0:0:0:0:0:ffff:127.0.0.1`, which would
  // otherwise be handed to the DNS resolver instead of being classified here.
  const isLiteral = parseIPv4(hostname) !== undefined || parseIPv6(hostname) !== undefined;
  if (isLiteral) {
    return isPublicAddress(hostname) ? undefined : `形象图 URL 指向内网地址：${hostname}`;
  }
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0) return `形象图 URL 的域名无法解析：${hostname}`;
    const blocked = addresses.find((entry) => !isPublicAddress(entry.address));
    return blocked === undefined ? undefined : `形象图 URL 解析到内网地址：${hostname} → ${blocked.address}`;
  } catch (error) {
    return `形象图 URL 的域名解析失败：${(error as Error).message}`;
  }
}

/** Identify an image from its leading bytes, so a lying Content-Type cannot smuggle one in. */
export function sniffImageType(bytes: Uint8Array): ImageType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
  return undefined;
}

/**
 * Read a response body with a hard byte cap.
 * `arrayBuffer()` would happily buffer whatever the server sends.
 * @param response - the streaming response.
 * @param limit - maximum accepted bytes.
 * @returns the bytes, or an error message when the cap is exceeded.
 */
async function readCapped(response: Response, limit: number): Promise<{ bytes: Uint8Array } | { error: string }> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    return { error: `形象图超过上限（${declared} > ${limit} 字节）` };
  }
  const body = response.body;
  if (body === null) return { error: '形象图响应没有正文' };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return { error: `形象图超过上限（> ${limit} 字节）` };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

/** Download one remote avatar under the SSRF, size, and type rules. */
async function downloadAvatar(url: URL): Promise<{ bytes: Uint8Array; type: ImageType } | { error: string }> {
  const hostError = await assertPublicHost(url);
  if (hostError !== undefined) return { error: hostError };
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS),
    });
  } catch (error) {
    return { error: `下载形象图失败：${(error as Error).message}` };
  }
  if (!response.ok) return { error: `下载形象图失败：HTTP ${response.status}` };
  const read = await readCapped(response, AVATAR_MAX_BYTES);
  if ('error' in read) return read;
  const sniffed = sniffImageType(read.bytes);
  if (sniffed === undefined) return { error: '形象图内容不是 png/jpg/gif/bmp（按文件头判断）' };
  const declared = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (declared.length > 0 && CONTENT_TYPE_TO_IMAGE[declared] === undefined) {
    return { error: `形象图 Content-Type 不受支持：${declared}` };
  }
  // The header may only confirm the sniffed type, never contradict it.
  if (declared.length > 0 && CONTENT_TYPE_TO_IMAGE[declared] !== sniffed) {
    return { error: `形象图 Content-Type（${declared}）与实际内容（${sniffed}）不符` };
  }
  return { bytes: read.bytes, type: sniffed };
}

/**
 * Resolve a local avatar reference to a path that is safe to read.
 *
 * A relative reference must stay inside `baseDir`; an absolute one may point
 * anywhere the operator typed explicitly, but must not smuggle `..` segments
 * through.
 * @param reference - the configured path.
 * @param baseDir - the directory relative paths resolve against.
 * @returns the absolute path.
 * @throws when the reference would leave `baseDir` or contains `..`.
 */
export function resolveAvatarPath(reference: string, baseDir: string): string {
  const trimmed = reference.trim();
  const absolute = isAbsolute(trimmed);
  const path = absolute ? resolve(trimmed) : resolve(baseDir, trimmed);
  if (!absolute) {
    const rel = relative(baseDir, path);
    if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`形象图路径超出导出目录：${trimmed}`);
    }
  } else if (trimmed.split(/[\\/]+/).includes('..')) {
    throw new Error(`形象图路径不允许包含 ..：${trimmed}`);
  }
  return path;
}

/** Resolve an avatar reference to bytes, or report why it could not. */
async function readAvatar(
  reference: string,
  baseDir: string,
): Promise<{ bytes: Uint8Array; type: ImageType } | { error: string }> {
  const trimmed = reference.trim();
  if (trimmed.length === 0) return { error: '未设置形象图' };
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      return await downloadAvatar(new URL(trimmed));
    }
    const path = resolveAvatarPath(trimmed, baseDir);
    const extensionType = IMAGE_TYPES[extname(path).toLowerCase()];
    // Check the size *before* reading, so an oversized or special file is never
    // pulled into memory in the first place.
    const stats = statSync(path);
    if (!stats.isFile()) return { error: `形象图不是普通文件：${path}` };
    if (stats.size > AVATAR_MAX_BYTES) {
      return { error: `形象图超过上限（${stats.size} > ${AVATAR_MAX_BYTES} 字节）` };
    }
    const bytes = new Uint8Array(readFileSync(path));
    if (bytes.byteLength > AVATAR_MAX_BYTES) {
      return { error: `形象图超过上限（${bytes.byteLength} > ${AVATAR_MAX_BYTES} 字节）` };
    }
    const sniffed = sniffImageType(bytes);
    if (sniffed === undefined) return { error: `形象图内容不是 png/jpg/gif/bmp：${path}` };
    if (extensionType !== undefined && extensionType !== sniffed) {
      return { error: `形象图扩展名（${extensionType}）与实际内容（${sniffed}）不符：${path}` };
    }
    return { bytes, type: sniffed };
  } catch (error) {
    return { error: `读取形象图失败：${(error as Error).message}` };
  }
}

/** One inline image paragraph at the given pixel size. */
function imageParagraph(docx: DocxModule, bytes: Uint8Array, type: ImageType, size: number): InstanceType<DocxModule['Paragraph']> {
  return new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    children: [
      new docx.ImageRun({
        type,
        data: bytes,
        transformation: { width: size, height: size },
      }),
    ],
  });
}

/** A paragraph of body text that preserves line breaks. */
function bodyParagraphs(docx: DocxModule, text: string): InstanceType<DocxModule['Paragraph']>[] {
  return sanitizeText(text).split('\n').map((line) => new docx.Paragraph({
    spacing: { after: 120 },
    children: [new docx.TextRun({ text: line, size: 22 })],
  }));
}

/** The speech meta line under a heading. */
function speechMeta(docx: DocxModule, speech: Speech): InstanceType<DocxModule['Paragraph']> {
  return new docx.Paragraph({
    spacing: { after: 80 },
    children: [new docx.TextRun({
      text: `${speech.provider}/${speech.model} · ${speech.status} · 输出 ${speech.usage.outputTokens} tokens`
        + ` · 花费 ${speech.costStatus === 'measured' ? `$${speech.cost.toFixed(6)}` : `口径不可用（${describeCostStatus(speech.costStatus)}）`}`
        + ` · ${speech.elapsedMs} ms`
        + (speech.sensitiveHits > 0 ? ` · 过滤 ${speech.sensitiveHits} 处` : ''),
      italics: true,
      size: 18,
      color: '666666',
    })],
  });
}

/** The anomaly chapter table. */
function anomalyTable(docx: DocxModule, anomalies: readonly AnomalyRecord[]): InstanceType<DocxModule['Table']> {
  const cell = (value: string, bold = false): InstanceType<DocxModule['TableCell']> => new docx.TableCell({
    children: [new docx.Paragraph({ children: [new docx.TextRun({ text: sanitizeText(value), bold, size: 18 })] })],
  });
  const header = new docx.TableRow({
    tableHeader: true,
    children: ['时间', '轮次', '选手', '类型', '详情'].map((label) => cell(label, true)),
  });
  const rows = anomalies.map((anomaly) => new docx.TableRow({
    children: [
      new Date(anomaly.at).toLocaleTimeString('zh-CN'),
      anomaly.round > 0 ? `${anomaly.round}` : '—',
      anomaly.participantId ?? '—',
      anomaly.kind,
      anomaly.message,
    ].map((value) => cell(value)),
  }));
  return new docx.Table({
    width: { size: 100, type: docx.WidthType.PERCENTAGE },
    rows: [header, ...rows],
  });
}

/**
 * Render the docx 战报.
 * @param state - the finished run state.
 * @param options - output settings.
 * @returns the absolute path written.
 * @throws when `docx` is unavailable or the output directory is not writable.
 */
export async function buildDocxReport(state: RunState, options: DocxOptions): Promise<string> {
  const docx = await loadDocx();
  const children: (InstanceType<DocxModule['Paragraph']> | InstanceType<DocxModule['Table']>)[] = [];
  const anomalies: AnomalyRecord[] = [...state.anomalies];
  const baseDir = options.outputDir;

  // ── 封面 ─────────────────────────────────────────────────────────────────
  children.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: { before: 1200, after: 240 },
    children: [new docx.TextRun({ text: '赛博圆桌战报', bold: true, size: 56 })],
  }));
  children.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: { after: 480 },
    children: [new docx.TextRun({ text: state.topic.length > 0 ? state.topic : '（未设置话题）', size: 28 })],
  }));
  children.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    children: [new docx.TextRun({ text: new Date(state.startedAt).toLocaleString('zh-CN'), size: 20, color: '555555' })],
  }));
  children.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    children: [new docx.TextRun({
      text: `轮数 ${state.rounds} / ${state.plannedRounds} · ${describeStopReason(state.stopReason)}`
        + ` · 总花费 $${state.totalCost.toFixed(6)}`,
      size: 20,
      color: '555555',
    })],
  }));
  children.push(new docx.Paragraph({ children: [] }));
  children.push(new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    children: [new docx.TextRun({ text: `⚠️ ${AI_JUDGE_DISCLAIMER}`, size: 18, color: 'B00020' })],
  }));
  children.push(new docx.Paragraph({ children: [] }));

  // Participant roster with avatar thumbnails.
  for (const participant of options.participants) {
    if (participant.avatar !== undefined && participant.avatar.trim().length > 0) {
      const avatar = await readAvatar(participant.avatar, baseDir);
      if ('error' in avatar) {
        anomalies.push({
          at: Date.now(),
          round: 0,
          participantId: participant.id,
          kind: '形象图缺失',
          message: `选手「${participant.name}」：${avatar.error}`,
        });
      } else {
        children.push(imageParagraph(docx, avatar.bytes, avatar.type, 96));
      }
    }
    children.push(new docx.Paragraph({
      alignment: docx.AlignmentType.CENTER,
      children: [new docx.TextRun({ text: participant.name, bold: true, size: 24 })],
    }));
    children.push(new docx.Paragraph({
      alignment: docx.AlignmentType.CENTER,
      children: [new docx.TextRun({
        text: `${participant.provider}/${participant.model}`,
        size: 18,
        color: '666666',
      })],
    }));
    children.push(new docx.Paragraph({ children: [] }));
  }

  // ── 评分榜 ───────────────────────────────────────────────────────────────
  children.push(new docx.Paragraph({ pageBreakBefore: true, heading: docx.HeadingLevel.HEADING_1, text: '评分榜' }));
  if (state.judge === undefined || state.judge.scores.length === 0) {
    children.push(new docx.Paragraph({ children: [new docx.TextRun({ text: '本场没有裁判结果。', size: 22 })] }));
  } else {
    children.push(new docx.Paragraph({
      children: [new docx.TextRun({
        text: `⚠️ ${AI_JUDGE_DISCLAIMER}`,
        size: 18,
        color: 'B00020',
      })],
    }));
    children.push(new docx.Paragraph({
      children: [new docx.TextRun({
        text: `裁判模型：${state.judge.model.length > 0 ? `${state.judge.provider}/${state.judge.model}` : '（未配置）'}`
          + ` · 出分时间：${state.judge.at > 0 ? new Date(state.judge.at).toLocaleString('zh-CN') : '—'}`
          + ` · 状态：${state.judge.degraded ? '降级（字数估算，非模型评分）' : '正常'}`,
        size: 18,
        color: state.judge.degraded ? 'B00020' : '666666',
      })],
    }));
    children.push(new docx.Paragraph({
      children: [new docx.TextRun({
        text: `评分维度与权重：${describeWeights(state.weights)}；总分 = 六维加权平均。`
          + `花费口径：${describeCostSource(state.costSource)}`,
        size: 18,
        color: '666666',
      })],
    }));
    if (!state.judge.judged) {
      children.push(new docx.Paragraph({
        children: [new docx.TextRun({ text: `裁判不可用，已降级为字数估算：${sanitizeText(state.judge.note ?? '未给出有效评分')}`, size: 20, color: 'B00020' })],
      }));
    }
    const scoreCell = (value: string, bold = false): InstanceType<DocxModule['TableCell']> => new docx.TableCell({
      children: [new docx.Paragraph({ children: [new docx.TextRun({ text: sanitizeText(value), bold, size: 18 })] })],
    });
    const header = new docx.TableRow({
      tableHeader: true,
      children: [
        '名次', '选手',
        ...SCORE_DIMENSIONS.map((dimension) => SCORE_DIMENSION_LABELS[dimension]),
        '总分', '花费(USD)', '口径', '点评',
      ].map((label) => scoreCell(label, true)),
    });
    const rows = state.judge.scores.map((score, index) => new docx.TableRow({
      children: [
        `${index + 1}`,
        score.name,
        ...SCORE_DIMENSIONS.map((dimension) => `${score[dimension]}`),
        `${score.total}`,
        score.costStatus === 'measured' ? score.cost.toFixed(6) : '—',
        describeCostStatus(score.costStatus),
        score.comment,
      ].map((value) => scoreCell(value)),
    }));
    children.push(new docx.Table({
      width: { size: 100, type: docx.WidthType.PERCENTAGE },
      rows: [header, ...rows],
    }));

    children.push(new docx.Paragraph({ heading: docx.HeadingLevel.HEADING_2, text: '性价比榜（实验性）' }));
    const attributedTurns = state.speeches.filter((speech) => speech.costStatus === 'measured').length;
    children.push(new docx.Paragraph({
      children: [new docx.TextRun({
        text: `口径覆盖率 ${attributedTurns}/${state.speeches.length} 条发言完成归因。`
          + '本榜在 0.2.x 仍是实验功能，只收每一轮花费都成功归因的选手；名次仅供参考。',
        size: 18,
        color: '666666',
      })],
    }));
    if (state.judge.valueRanking.length === 0) {
      children.push(new docx.Paragraph({
        children: [new docx.TextRun({ text: '本场没有数据完整到可以参与性价比排名的选手。', size: 20 })],
      }));
    } else {
      const valueCell = (value: string, bold = false): InstanceType<DocxModule['TableCell']> => new docx.TableCell({
        children: [new docx.Paragraph({ children: [new docx.TextRun({ text: sanitizeText(value), bold, size: 18 })] })],
      });
      const valueHeader = new docx.TableRow({
        tableHeader: true,
        children: ['名次', '选手', '总分', '花费(USD)', '性价比'].map((label) => valueCell(label, true)),
      });
      const valueRows = state.judge.valueRanking.flatMap((id) => {
        const score = state.judge?.scores.find((entry) => entry.participantId === id);
        // Rendering filter: rows without real cost data never reach the table.
        if (score === undefined || score.value === undefined || score.costStatus !== 'measured') return [];
        return [new docx.TableRow({
          children: [
            `${score.valueRank ?? '—'}`,
            score.name,
            `${score.total}`,
            score.cost.toFixed(6),
            `${score.value}`,
          ].map((value) => valueCell(value)),
        })];
      });
      children.push(new docx.Table({
        width: { size: 100, type: docx.WidthType.PERCENTAGE },
        rows: [valueHeader, ...valueRows],
      }));
    }
    for (const entry of state.judge.unmeasured) {
      children.push(new docx.Paragraph({
        children: [new docx.TextRun({
          text: `未纳入性价比排名：${entry.name} —— ${entry.reason}`,
          size: 18,
          color: 'B00020',
        })],
      }));
    }
    if (state.judge.summary.length > 0) {
      children.push(new docx.Paragraph({ heading: docx.HeadingLevel.HEADING_2, text: '裁判总结' }));
      children.push(...bodyParagraphs(docx, state.judge.summary));
    }
  }

  // ── 逐轮记录 ─────────────────────────────────────────────────────────────
  let currentRound = 0;
  for (const speech of state.speeches) {
    if (speech.round !== currentRound) {
      currentRound = speech.round;
      children.push(new docx.Paragraph({
        pageBreakBefore: currentRound > 1,
        heading: docx.HeadingLevel.HEADING_1,
        text: `第 ${currentRound} 轮`,
      }));
    }
    children.push(new docx.Paragraph({ heading: docx.HeadingLevel.HEADING_2, text: speech.name }));
    children.push(speechMeta(docx, speech));
    children.push(...bodyParagraphs(docx, speech.status === 'ok' ? speech.text : `[${speech.status}] ${speech.text}`));
  }

  // ── 异常记录 ─────────────────────────────────────────────────────────────
  children.push(new docx.Paragraph({ pageBreakBefore: true, heading: docx.HeadingLevel.HEADING_1, text: '异常记录' }));
  if (anomalies.length === 0) {
    children.push(new docx.Paragraph({ children: [new docx.TextRun({ text: '本场无异常。', size: 22 })] }));
  } else {
    children.push(anomalyTable(docx, anomalies));
  }

  children.push(new docx.Paragraph({ children: [] }));
  children.push(new docx.Paragraph({
    children: [new docx.TextRun({
      text: `运行 ID ${state.id} · 由 dsh-roundtable-harness 生成 · 敏感内容按配置词库过滤`,
      size: 16,
      color: '888888',
    })],
  }));

  const document = new docx.Document({
    creator: 'dsh-roundtable-harness',
    title: `赛博圆桌战报 - ${state.topic}`,
    description: '由 dsh-roundtable-harness 自动生成',
    sections: [{ properties: {}, children }],
  });
  const buffer = await docx.Packer.toBuffer(document);
  const stem = options.fileStem ?? `roundtable-${timestampSlug(state.startedAt)}`;
  const path = join(options.outputDir, `${stem}-战报.docx`);
  writeFileSync(path, buffer);
  return path;
}
