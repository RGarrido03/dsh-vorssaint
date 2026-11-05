/**
 * The Vorssaint usage feed: line builders and an append-only writer.
 *
 * One file per DSH session under the feed directory. The contract lives in
 * `docs/FEED.md`; this module is the only writer of it.
 *
 * @module dsh-vorssaint/feed
 */

import { appendFile, chmod, mkdir, open, stat, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ModelRate, Pricing, TokenCounts } from './pricing.js'
import { costOf, resolveRate } from './pricing.js'

/** Contract version written on every line. */
export const FEED_VERSION = 1

/** Where one DSH session's lines go and what the reader derives from them. */
export interface SessionIdentity {
  /** DSH session id. */
  session: string
  /** Session creation time, epoch milliseconds. */
  ts: number
  /** Working directory; the reader takes the project name from it. */
  cwd?: string
  /**
   * The session this one was created from. DSH records it for ordinary forks
   * too, so it is informational and must not classify a subagent.
   */
  parent?: string
  /** DSH marks a subagent session with `origin: 'subagent'`. */
  subagent?: boolean
  /** DSH agent preset at creation. */
  preset?: string
}

/** One line ready to append, tagged with the DSH event it came from. */
export interface FeedEntry {
  /** DSH session event sequence; the writer skips sequences already on disk. */
  seq: number
  /** Serialized feed line, without the trailing newline. */
  line: string
}

/** The slice of a logger this plugin needs. */
export interface LoggerLike {
  warn(message: string): void
}

/**
 * A session event reduced to the fields the feed reads. Backfill parses plain
 * JSON rows into this shape, so both paths share one mapping.
 */
export interface FeedEventLike {
  type: string
  seq: number
  time: number
  data: unknown
}

/**
 * The feed identity of a live session.
 * @param session - the DSH session.
 * @returns its id and creation metadata.
 */
export function identityOf(session: Session): SessionIdentity {
  const header = session.header
  return {
    session: String(header.id),
    ts: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSession === undefined ? {} : { parent: header.parentSession }),
    ...(header.origin === 'subagent' ? { subagent: true } : {}),
    ...(header.agentPreset === undefined ? {} : { preset: header.agentPreset }),
  }
}

/**
 * The `session` line that opens a feed file.
 * @param identity - the session it describes.
 * @returns serialized line.
 */
export function sessionLine(identity: SessionIdentity): string {
  const line: Record<string, unknown> = {
    v: FEED_VERSION,
    type: 'session',
    session: identity.session,
    ts: identity.ts,
  }
  if (identity.cwd !== undefined && identity.cwd !== '') line.cwd = identity.cwd
  if (typeof identity.parent === 'string' && identity.parent !== '') line.parent = identity.parent
  if (identity.subagent === true) line.subagent = true
  if (identity.preset !== undefined && identity.preset !== '') line.preset = identity.preset
  return JSON.stringify(line)
}

/**
 * The feed lines one committed session event produces.
 * @param event - a committed DSH session event.
 * @param pricing - configured model rates.
 * @returns zero or more entries; empty for events Vorssaint does not read.
 */
export function feedEntriesForEvent(event: FeedEventLike, pricing: Pricing): FeedEntry[] {
  if (!Number.isSafeInteger(event.seq) || event.seq < 0 || !Number.isFinite(event.time)) return []
  switch (event.type) {
    case 'turn/start': {
      const turn = integer(record(event.data)?.turn)
      if (turn === undefined) return []
      return [{ seq: event.seq, line: turnLine(event.time, turn, 'start', event.seq) }]
    }
    case 'turn/end': {
      const turn = integer(record(event.data)?.turn)
      if (turn === undefined) return []
      const reason = record(record(event.data)?.reason)
      const kind = typeof reason?.kind === 'string' ? reason.kind : ''
      // A max-tokens stop is how the model ends a turn normally when it runs
      // out of room; only aborts, errors and interruptions are unfinished.
      const completed = kind === 'completed' || kind === 'max-tokens'
      return [{ seq: event.seq, line: turnLine(event.time, turn, 'end', event.seq, completed) }]
    }
    case 'assistant/message': {
      const data = record(event.data)
      if (data === undefined) return []
      const usage = record(data.usage)
      const message = record(data.message)
      const source = record(message?.source)
      const model = typeof source?.model === 'string' ? source.model : ''
      // With no usage the provider billed nothing reportable; with no model
      // the record cannot be attributed, and Vorssaint skips those as well.
      if (usage === undefined || model === '') return []
      const tokens: TokenCounts = {
        input: count(usage.inputTokens),
        cacheWrite: count(usage.cacheWriteTokens),
        cacheRead: count(usage.cacheReadTokens),
        output: count(usage.outputTokens),
        reasoning: count(usage.reasoningTokens),
      }
      const row: Record<string, unknown> = {
        v: FEED_VERSION,
        type: 'usage',
        ts: event.time,
        seq: event.seq,
      }
      const turn = integer(data.turn)
      const step = integer(data.step)
      if (turn !== undefined) row.turn = turn
      if (step !== undefined) row.step = step
      if (typeof message?.id === 'string' && message.id !== '') row.request = message.id
      row.model = model
      if (typeof source?.provider === 'string' && source.provider !== '') row.provider = source.provider
      row.tokens = tokens
      const rate: ModelRate | undefined = resolveRate(pricing, model)
      const cost = costOf(rate, tokens)
      if (cost !== undefined) row.cost = cost
      return [{ seq: event.seq, line: JSON.stringify(row) }]
    }
    default:
      return []
  }
}

/**
 * An append-only feed writer, one chain per session file.
 *
 * Appends are serialized so lines keep DSH's event order, and the writer skips
 * sequences already on disk, which keeps a restart or a re-read from writing
 * the same response twice. Vorssaint also dedupes usage by the response id, so
 * a torn last line is at worst replayed, never double counted.
 *
 * Failures are swallowed after one warning: a read-only home directory or a
 * full disk must never fail, block or delay an agent turn.
 */
export class FeedWriter {
  private readonly files = new Map<string, FileState>()
  private readonly opening = new Map<string, Promise<FileState>>()
  private directory?: Promise<void>
  private warned = false

  constructor(
    private readonly dir: string,
    private readonly pricing: Pricing,
    private readonly log?: LoggerLike,
  ) {}

  /**
   * Append the entries not already written for their session.
   * @param identity - the session the entries belong to.
   * @param entries - ordered entries; filtered by their sequence.
   * @returns a promise that never rejects.
   */
  ingest(identity: SessionIdentity, entries: readonly FeedEntry[]): Promise<void> {
    if (entries.length === 0) return Promise.resolve()
    return this.ensure(identity)
      .then((state) => {
        const fresh = entries.filter((entry) => entry.seq > state.lastSeq)
        if (fresh.length === 0) return
        // Advancing before the append resolves keeps a burst of events from
        // queueing the same sequence twice; a failed append loses that line
        // rather than replaying older ones on every later event.
        state.lastSeq = fresh[fresh.length - 1]!.seq
        const text = fresh.map((entry) => entry.line).join('\n') + '\n'
        state.chain = state.chain
          .then(() => appendFile(state.path, text, { mode: 0o600 }))
          .catch((error: unknown) => {
            this.warn(`could not append usage to ${state.path}: ${describe(error)}`)
          })
        return state.chain
      })
      .catch((error: unknown) => {
        // The directory promise is cached; clear it so a fixed home directory
        // is retried by the next event instead of replaying this failure.
        this.directory = undefined
        this.warn(`could not open the usage feed at ${this.dir}: ${describe(error)}`)
      })
  }

  /** Wait for every in-flight open and queued append; called on unload. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.opening.values()])
    await Promise.allSettled([...this.files.values()].map((state) => state.chain))
  }

  private ensure(identity: SessionIdentity): Promise<FileState> {
    const existing = this.files.get(identity.session)
    if (existing !== undefined) return Promise.resolve(existing)
    const opening = this.opening.get(identity.session)
    if (opening !== undefined) return opening
    const created = this.open(identity).finally(() => this.opening.delete(identity.session))
    this.opening.set(identity.session, created)
    return created
  }

  private async open(identity: SessionIdentity): Promise<FileState> {
    await this.ensureDirectory()
    const path = join(this.dir, feedFileName(identity.session))
    let size = 0
    try {
      size = (await stat(path)).size
    } catch {
      size = 0
    }
    // A torn last line from an earlier crash would otherwise merge with the
    // next record and make both unreadable. Cut it back to the last newline.
    if (size > 0) {
      const complete = await completeLength(path, size)
      if (complete < size) {
        try {
          await truncate(path, complete)
          size = complete
        } catch {
          // Left in place: the next append starts a new line anyway.
        }
      }
    }
    const lastSeq = size > 0 ? await lastWrittenSeq(path) : -1
    const state: FileState = { path, lastSeq, chain: Promise.resolve() }
    if (size === 0) {
      state.chain = writeFile(path, sessionLine(identity) + '\n', { mode: 0o600 }).catch((error: unknown) => {
        this.warn(`could not open the usage feed at ${path}: ${describe(error)}`)
      })
    }
    state.chain = state.chain.then(() => chmod(path, 0o600).catch(() => undefined))
    this.files.set(identity.session, state)
    return state
  }

  private ensureDirectory(): Promise<void> {
    this.directory ??= mkdir(this.dir, { recursive: true, mode: 0o700 })
      .then(() => chmod(this.dir, 0o700))
      .catch((error: unknown) => {
        // The caller clears this cached failure; report it once here.
        this.warn(`could not create the usage feed directory ${this.dir}: ${describe(error)}`)
        throw error
      })
    return this.directory
  }

  private warn(message: string): void {
    if (this.warned) return
    this.warned = true
    this.log?.warn(`vorssaint: ${message}`)
  }
}

interface FileState {
  path: string
  lastSeq: number
  chain: Promise<void>
}

/**
 * One file name for a session id. DSH ids are already safe; sanitizing keeps
 * a hand-made or future id from escaping the feed directory.
 */
export function feedFileName(session: string): string {
  const safe = session.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')
  return `${safe === '' ? 'session' : safe}.jsonl`
}

/** The length of a file up to and including its last newline. */
async function completeLength(path: string, size: number): Promise<number> {
  const handle = await open(path, 'r')
  try {
    let start = Math.max(0, size - 64 * 1024)
    for (;;) {
      const length = size - start
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, start)
      const newline = buffer.lastIndexOf(0x0a)
      if (newline !== -1) return start + newline + 1
      if (start === 0) return 0
      start = Math.max(0, start - 64 * 1024)
    }
  } finally {
    await handle.close()
  }
}

/**
 * The highest sequence already in a feed file, read from its last complete
 * line. -1 when the file has none (new file, or only the session header).
 */
async function lastWrittenSeq(path: string): Promise<number> {
  let handle
  try {
    handle = await open(path, 'r')
    const size = (await handle.stat()).size
    const length = Math.min(size, 64 * 1024)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    let body = buffer.toString('utf8')
    // A torn final line is not trusted: read the line before it.
    body = body.endsWith('\n') ? body.slice(0, -1) : body.slice(0, body.lastIndexOf('\n'))
    if (body === '') return -1
    const start = body.lastIndexOf('\n')
    const line = start === -1 ? body : body.slice(start + 1)
    const parsed = record(JSON.parse(line) as unknown)
    const seq = integer(parsed?.seq)
    return seq ?? -1
  } catch {
    return -1
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function turnLine(ts: number, turn: number, phase: 'start' | 'end', seq: number, completed?: boolean): string {
  const line: Record<string, unknown> = { v: FEED_VERSION, type: 'turn', ts, turn, phase, seq }
  if (phase === 'end') line.completed = completed === true
  return JSON.stringify(line)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
