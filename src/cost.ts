/**
 * Real-money cost attribution through the `dsh-cost-meter` ledger.
 *
 * The ledger is the only place a Harness deployment records what a call
 * actually cost. `dsh-cost-meter` wraps `llm/stream` globally and accounts
 * every call — including the ones this plugin makes, which carry no session —
 * into `days.<YYYY-MM-DD>.byProviderModel["<provider>:<model>"].cost`.
 *
 * It debounces disk writes by two seconds, so the reader waits for the file to
 * change (up to {@link LEDGER_SETTLE_MS}) before reading a delta.
 *
 * When the ledger cannot be read, or a call cannot be tied to the speaker's
 * model, the turn is reported as **no data** and that speaker is excluded from
 * the cost-effectiveness ranking. There is no proxy estimate: a guess dressed
 * as a price is worse than an explicit gap.
 *
 * @module dsh-roundtable-harness/cost
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDshHome } from './config.js';

/**
 * Delay that lets `dsh-cost-meter` flush its two-second write debounce plus the model's own bookkeeping; six seconds is long enough for a slow route to land and short enough not to stall a debate.
 * `ROUNDTABLE_LEDGER_SETTLE_MS` overrides it (the verification harness sets it
 * to 0 so a mock run does not sleep for the debounce it is not waiting on).
 */
export const LEDGER_SETTLE_MS = ((): number => {
  const raw = process.env.ROUNDTABLE_LEDGER_SETTLE_MS;
  if (raw === undefined) return 6_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 6_000;
})();

/** Cronological-ish key set the ledger uses for the five disjoint token buckets. */
interface LedgerBucket {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  calls?: number;
  cost?: number;
  apiCost?: number;
}

/** One read of the ledger, reduced to what judging needs. */
export interface CostSnapshot {
  /** Whether a readable ledger was found. */
  available: boolean;
  /** Ledger path that was read, or the path that was looked for. */
  path: string;
  /** Local day key the totals were taken from. */
  day: string;
  /** Total cost of that day, in the ledger's currency (USD). */
  totalCost: number;
  /** Cost per `provider:model` key. */
  byKey: Record<string, number>;
  /** Reason the read failed, when it did. */
  error?: string;
}

/**
 * What one turn's spend could be tied to.
 *
 * `no-ledger` means the ledger was unreadable (the plugin is absent, or the day
 * has no record); `unmatched` means the ledger moved but no key named this
 * turn's model. Both are reported to the operator and treated as **no data**,
 * never as zero cost for ranking purposes.
 */
export interface CostAttribution {
  /** Attributed cost; 0 whenever `status !== 'matched'`. */
  cost: number;
  status: 'matched' | 'unmatched' | 'no-ledger';
  /** Keys that spent money in this window without matching this turn's model. */
  unattributedKeys: string[];
  /** Keys that matched this turn's model. */
  matchedKeys: string[];
}

/** Absolute path of the `dsh-cost-meter` ledger. */
export function resolveLedgerPath(home: string = resolveDshHome()): string {
  return join(home, 'storages', 'cost-meter', 'ledger.json');
}

/** Local `YYYY-MM-DD` day key. */
export function localDayKey(at: number = Date.now()): string {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Read today's account from the cost-meter ledger.
 * @param options - optional ledger path and day key.
 * @returns a snapshot; `available: false` when the ledger is absent or unreadable.
 */
export function readCostSnapshot(
  options: { path?: string; day?: string } = {},
): CostSnapshot {
  const path = options.path ?? resolveLedgerPath();
  const day = options.day ?? localDayKey();
  const empty: CostSnapshot = { available: false, path, day, totalCost: 0, byKey: {} };
  try {
    if (!existsSync(path)) return { ...empty, error: '未安装 dsh-cost-meter 或账本尚未生成' };
    const document = JSON.parse(readFileSync(path, 'utf8')) as {
      days?: Record<string, { cost?: number; byProviderModel?: Record<string, LedgerBucket> }>;
    };
    const record = document.days?.[day];
    if (record === undefined) return { ...empty, available: true };
    const byKey: Record<string, number> = {};
    for (const [key, bucket] of Object.entries(record.byProviderModel ?? {})) {
      byKey[key] = typeof bucket.cost === 'number' ? bucket.cost : 0;
    }
    return {
      available: true,
      path,
      day,
      totalCost: typeof record.cost === 'number' ? record.cost : 0,
      byKey,
    };
  } catch (error) {
    return { ...empty, error: (error as Error).message };
  }
}

/**
 * Cost a single turn accrued.
 *
 * Only an exact `<provider>:<model>` key whose delta is positive counts. There
 * is deliberately **no day-total fallback**: when a routing wrapper books the
 * call under a key this reader cannot tie to the participant's model, the turn
 * is reported `unmatched` with cost 0. Charging one speaker another speaker's
 * spend would be worse than admitting the attribution failed, and the reason is
 * carried back so the report can say so.
 * @param before - snapshot taken before the call.
 * @param after - snapshot taken after the call.
 * @param model - the model id the turn requested.
 * @returns the attributed cost and why it is what it is.
 */
export function attributeTurnCost(
  before: CostSnapshot,
  after: CostSnapshot,
  model: string,
): CostAttribution {
  if (!before.available || !after.available) {
    return { cost: 0, status: 'no-ledger', unattributedKeys: [], matchedKeys: [] };
  }
  const keys = new Set([...Object.keys(before.byKey), ...Object.keys(after.byKey)]);
  const positive: { key: string; delta: number }[] = [];
  for (const key of keys) {
    const delta = (after.byKey[key] ?? 0) - (before.byKey[key] ?? 0);
    if (delta > 0) positive.push({ key, delta });
  }
  const matched = positive.filter((entry) => modelOfKey(entry.key) === model);
  if (matched.length === 0) {
    return {
      cost: 0,
      status: positive.length === 0 ? 'no-ledger' : 'unmatched',
      unattributedKeys: positive.map((entry) => entry.key),
      matchedKeys: [],
    };
  }
  const matchedNames = new Set(matched.map((entry) => entry.key));
  return {
    cost: matched.reduce((sum, entry) => sum + entry.delta, 0),
    status: 'matched',
    // Keys that spent money in this window but belong to some other route; they
    // are reported, never charged to this speaker.
    unattributedKeys: positive.filter((entry) => !matchedNames.has(entry.key)).map((entry) => entry.key),
    matchedKeys: [...matchedNames],
  };
}

/** The model id a ledger key names, tolerating a missing `<provider>:` prefix. */
function modelOfKey(key: string): string {
  const separator = key.indexOf(':');
  return separator < 0 ? key : key.slice(separator + 1);
}


/** A cheap fingerprint of the ledger file, used to detect that a write landed. */
export interface LedgerStamp {
  mtimeMs: number;
  size: number;
}

/**
 * Read the ledger file's stamp.
 * @param path - ledger path; defaults to the resolved one.
 * @returns the stamp, or `undefined` when the file does not exist yet.
 */
export function ledgerStamp(path: string = resolveLedgerPath()): LedgerStamp | undefined {
  try {
    const stats = statSync(path);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return undefined;
  }
}

/** Poll interval while waiting for the ledger write. */
export const LEDGER_POLL_MS = 100;

/**
 * Wait until the ledger shows a **new cost for one specific model**.
 *
 * The old loop returned as soon as the file's stamp changed, which is not the
 * same thing: cost-meter batches writes, so the first write after a call can
 * still be the *previous* speaker's — the report then said "cannot attribute
 * glm-5.3, the ledger shows dashscope:kimi-k3", one speaker behind. Waiting for
 * the model's own delta to appear either returns quickly (the write landed) or
 * honestly times out, which the attribution reports as `unmatched`.
 * @param before - snapshot taken before the call.
 * @param model - the model id the call requested.
 * @param signal - caller cancellation.
 * @param path - ledger path; defaults to the resolved one.
 */
export async function waitForModelCost(
  before: CostSnapshot,
  model: string,
  signal?: AbortSignal,
  path: string = resolveLedgerPath(),
): Promise<void> {
  if (signal?.aborted === true) return;
  const sawModel = (snapshot: CostSnapshot): boolean => Object.entries(snapshot.byKey)
    .some(([key, cost]) => modelOfKey(key) === model && cost > (before.byKey[key] ?? 0));
  let aborted = false;
  const onAbort = (): void => { aborted = true; };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const deadline = Date.now() + LEDGER_SETTLE_MS;
    for (;;) {
      if (sawModel(readCostSnapshot({ path }))) return;
      if (Date.now() >= deadline) return;
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, LEDGER_POLL_MS);
        signal?.addEventListener('abort', done, { once: true });
      });
      if (aborted) return;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Wait until `dsh-cost-meter` writes the ledger, or the deadline passes.
 *
 * The previous implementation slept a fixed two seconds after every call, which
 * cost 44 seconds of pure waiting in a four-speaker, five-round debate even when
 * the ledger had already been flushed. This polls the file's stamp instead: it
 * returns as soon as a write lands and gives up at {@link LEDGER_SETTLE_MS},
 * which stays configurable through `ROUNDTABLE_LEDGER_SETTLE_MS`.
 * @param baseline - stamp taken before the call; `undefined` when there was none.
 * @param signal - caller cancellation.
 * @param path - ledger path; defaults to the resolved one.
 */
export async function waitForLedger(
  baseline?: LedgerStamp,
  signal?: AbortSignal,
  path: string = resolveLedgerPath(),
): Promise<void> {
  if (signal?.aborted === true) return;
  // A local flag: `AbortSignal.aborted` is narrowed by the check above and would
  // look constant to the compiler even though it can flip during the await.
  let aborted = false;
  const onAbort = (): void => { aborted = true; };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const deadline = Date.now() + LEDGER_SETTLE_MS;
    for (;;) {
      const current = ledgerStamp(path);
      if (baseline === undefined) {
        // No ledger before the call: wait for one to appear at all.
        if (current !== undefined) return;
      } else if (current !== undefined
        && (current.mtimeMs !== baseline.mtimeMs || current.size !== baseline.size)) {
        return;
      }
      if (Date.now() >= deadline) return;
      // One listener per wait, not per poll: the timer removes its own handler
      // when it fires, so a long settle leaves no trail of abort handlers.
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, LEDGER_POLL_MS);
        signal?.addEventListener('abort', done, { once: true });
      });
      if (aborted) return;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
