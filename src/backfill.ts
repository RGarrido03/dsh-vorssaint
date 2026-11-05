/**
 * Import the usage already in DSH's own session logs, so a fresh install
 * reports the current day (or month) instead of starting from zero.
 *
 * DSH stores one zstd-compressed JSONL file per session below `sessions/`.
 * The plugin reads the recent ones once at start, maps the same events the
 * live listener sees, and hands them to the feed writer. A log's inherited
 * fork prefix ends at its `session/end-seed` marker with `inherited: true`;
 * counting those events again would bill the parent's work twice, so they
 * are skipped.
 *
 * Decompression is optional: Node gained `zstdDecompressSync` in 22.15, and
 * a host that predates it simply gets no backfill.
 *
 * @module dsh-vorssaint/backfill
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import * as zlib from 'node:zlib'
import type { FeedEntry, FeedEventLike, SessionIdentity } from './feed.js'
import { feedEntriesForEvent, feedFileName } from './feed.js'
import type { Pricing } from './pricing.js'

/** DSH session logs, whatever the format generation in their name. */
const SESSION_LOG = /^session.*\.jsonl\.zstd$/
/** A session log larger than this is skipped rather than held in memory. */
const MAX_LOG_BYTES = 64 * 1024 * 1024
const INTERESTING = ['"turn/start"', '"turn/end"', '"assistant/message"'] as const
const END_SEED = '"session/end-seed"'

type Zstd = (buffer: Buffer) => Buffer
const zstdDecompressSync: Zstd | undefined = (
  zlib as unknown as { zstdDecompressSync?: Zstd }
).zstdDecompressSync

/** One session recovered from a log file. */
export interface BackfillItem {
  identity: SessionIdentity
  entries: FeedEntry[]
}

/** What a backfill pass reads. */
export interface BackfillOptions {
  /** Backfill window, measured from now. */
  sinceMs: number
  /** Configured model rates. */
  pricing: Pricing
  /**
   * Feed directory. When supplied, a session whose feed file already covers
   * its log is skipped, so a normal restart does not decompress every log.
   */
  feedDir?: string
  /** Decompressor override; tests pass an identity function. */
  decompress?: Zstd
}

/**
 * Session logs under `sessionsDir` touched since `sinceMs`, newest first.
 * @param sessionsDir - DSH's sessions directory.
 * @param sinceMs - only files modified at or after now minus this.
 * @returns absolute log paths; empty when the directory is missing.
 */
export async function discoverSessionLogs(sessionsDir: string, sinceMs: number): Promise<string[]> {
  let entries
  try {
    entries = await readdir(sessionsDir, { recursive: true, withFileTypes: true })
  } catch {
    return []
  }
  const cutoff = Date.now() - sinceMs
  const files: Array<{ path: string; modified: number }> = []
  for (const entry of entries) {
    if (!entry.isFile() || !SESSION_LOG.test(entry.name)) continue
    const path = join(entry.parentPath, entry.name)
    try {
      const info = await stat(path)
      if (info.size === 0 || info.size > MAX_LOG_BYTES || info.mtimeMs < cutoff) continue
      files.push({ path, modified: info.mtimeMs })
    } catch {
      // A log removed between the listing and the stat is simply gone.
    }
  }
  files.sort((left, right) => right.modified - left.modified)
  return files.map((file) => file.path)
}

/**
 * Every recent session's feed entries, one session at a time.
 * @param sessionsDir - DSH's sessions directory.
 * @param options - window, rates, and the feed directory used to skip
 *   sessions already captured live.
 */
export async function* backfillSessions(
  sessionsDir: string,
  options: BackfillOptions,
): AsyncGenerator<BackfillItem> {
  const decompress = options.decompress ?? zstdDecompressSync
  if (decompress === undefined) return
  for (const path of await discoverSessionLogs(sessionsDir, options.sinceMs)) {
    try {
      if (options.feedDir !== undefined && (await feedCoversLog(path, options.feedDir))) continue
      const text = decompress(await readFile(path)).toString('utf8')
      const parsed = parseSessionLog(text, options.pricing)
      if (parsed !== undefined && parsed.entries.length > 0) yield parsed
    } catch {
      // A log being written, or one in a format this reader does not know,
      // is not worth failing the plugin over: live usage still gets through.
    }
  }
}

/**
 * Map one session log's text to its identity and feed entries.
 * @param text - decompressed JSONL.
 * @param pricing - configured model rates.
 * @returns the session, or undefined when the log does not start with a
 *   session header this reader understands.
 */
export function parseSessionLog(text: string, pricing: Pricing): BackfillItem | undefined {
  const rows = text.split('\n')
  const header = firstHeader(rows)
  if (header === undefined) return undefined
  const identity: SessionIdentity = {
    session: header.id,
    ts: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSession === undefined ? {} : { parent: header.parentSession }),
    ...(header.agentPreset === undefined ? {} : { preset: header.agentPreset }),
  }
  const inherited = inheritedCut(rows)
  const entries: FeedEntry[] = []
  let lastSeq = inherited
  for (const row of rows) {
    if (!INTERESTING.some((needle) => row.includes(needle))) continue
    const event = eventOf(row)
    if (event === undefined || event.seq <= lastSeq) continue
    lastSeq = event.seq
    entries.push(...feedEntriesForEvent(event, pricing))
  }
  return { identity, entries }
}

/**
 * Whether a session's feed was written at or after its log's last change.
 * When it was, live capture already holds the latest event and decompressing
 * the whole log again would only replay it.
 */
async function feedCoversLog(logPath: string, feedDir: string): Promise<boolean> {
  try {
    const [feed, log] = await Promise.all([
      stat(join(feedDir, feedFileName(basename(dirname(logPath))))),
      stat(logPath),
    ])
    // The two writes race at shutdown; two seconds of slack is enough to
    // recognise a live-captured log without trusting a stale feed.
    return feed.mtimeMs + 2000 >= log.mtimeMs
  } catch {
    return false
  }
}

interface LogHeader {
  id: string
  createdAt: number
  cwd?: string
  parentSession?: string
  agentPreset?: string
}

function firstHeader(rows: readonly string[]): LogHeader | undefined {
  const first = rows.find((row) => row.trim() !== '')
  if (first === undefined) return undefined
  const parsed = json(first)
  if (parsed === undefined || parsed.type !== 'session') return undefined
  const id = parsed.id
  const createdAt = parsed.createdAt
  if (typeof id !== 'string' || id === '' || typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    return undefined
  }
  return {
    id,
    createdAt,
    ...(typeof parsed.cwd === 'string' && parsed.cwd !== '' ? { cwd: parsed.cwd } : {}),
    ...(typeof parsed.parentSession === 'string' && parsed.parentSession !== ''
      ? { parentSession: parsed.parentSession }
      : {}),
    ...(typeof parsed.agentPreset === 'string' && parsed.agentPreset !== ''
      ? { agentPreset: parsed.agentPreset }
      : {}),
  }
}

/** The sequence through which a log is a copy of another session's history. */
function inheritedCut(rows: readonly string[]): number {
  let cut = -1
  for (const row of rows) {
    if (!row.includes(END_SEED)) continue
    const parsed = json(row)
    if (parsed === undefined || parsed.type !== 'session/end-seed') continue
    const data = record(parsed.data)
    if (data?.inherited !== true) continue
    const seq = parsed.seq
    if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq > cut) cut = seq
  }
  return cut
}

function eventOf(row: string): FeedEventLike | undefined {
  const parsed = json(row)
  if (parsed === undefined) return undefined
  const type = parsed.type
  const seq = parsed.seq
  const time = parsed.time
  if (typeof type !== 'string' || typeof seq !== 'number' || typeof time !== 'number') return undefined
  if (!Number.isSafeInteger(seq) || seq < 0 || !Number.isFinite(time)) return undefined
  return { type, seq, time, data: parsed.data }
}

function json(row: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(row) as unknown
    return record(parsed)
  } catch {
    return undefined
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
