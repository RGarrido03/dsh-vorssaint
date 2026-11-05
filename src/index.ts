/**
 * dsh-vorssaint — report DeepSeek Harness usage, API value and live runs to
 * Vorssaint.
 *
 * Vorssaint follows coding agents by reading their local session logs. DSH
 * compresses and rotates its own logs, so this plugin writes a small,
 * stable JSONL feed that Vorssaint's DSH reader tails instead:
 *
 *   ~/.vorssaint/agents/dsh/<session-id>.jsonl
 *
 * The feed carries token counts per model response, the turn boundaries the
 * island shows as a live run, and — when the user configured model rates —
 * the response's API list value. It never carries prompt text, tool
 * arguments or model output.
 *
 * Usage produced while the plugin was not loaded is recovered once at start
 * from DSH's recent session logs (`backfill`), so budgets do not reset on a
 * plugin install or a DSH upgrade.
 *
 * @module dsh-vorssaint
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { backfillSessions } from './backfill.js'
import type { FeedEntry, FeedEventLike, SessionIdentity } from './feed.js'
import { FeedWriter, feedEntriesForEvent, identityOf } from './feed.js'
import type { ModelRate, Pricing } from './pricing.js'

/** Plugin name; also the loader row id and logger name. */
export const name = 'vorssaint'

const DEFAULT_FEED_DIR = '~/.vorssaint/agents/dsh'
const DEFAULT_BACKFILL_DAYS = 30
const MAX_BACKFILL_DAYS = 3650
const DAY_MS = 24 * 60 * 60 * 1000

/** One model's rates, in USD per million tokens. */
const Rate = z.object({
  input: z.number().min(0),
  output: z.number().min(0),
  cacheRead: z.number().min(0),
  cacheWrite: z.number().min(0),
})

export const Config = z.object({
  feedDir: z
    .string()
    .default(DEFAULT_FEED_DIR)
    .description('Directory Vorssaint reads the usage feed from. Change only together with the app side.'),
  pricing: z
    .dict(Rate)
    .default({})
    .description(
      'USD per million tokens, keyed by exact DSH model id; "*" is the fallback. ' +
        'Without a price the feed reports tokens and runs but no API value.',
    ),
  backfill: z
    .boolean()
    .default(true)
    .description('Import usage already in recent DSH session logs when the plugin starts.'),
  backfillDays: z
    .number()
    .min(0)
    .max(MAX_BACKFILL_DAYS)
    .default(DEFAULT_BACKFILL_DAYS)
    .description('How far back to import DSH session logs. 0 disables the scan.'),
  sessionsDir: z
    .string()
    .default('')
    .description('DSH sessions directory. Empty uses $DSH_HOME/sessions, or ~/.dsh/sessions.'),
})

/** Configuration after defaults and validation. */
export interface ResolvedConfig {
  feedDir: string
  pricing: Pricing
  backfill: boolean
  backfillDays: number
  sessionsDir: string
}

/**
 * Normalize the config the loader (or a direct mount in a test) supplies.
 * @param raw - user configuration, possibly empty or partial.
 * @returns usable settings with every default applied.
 */
export function resolveConfig(raw: unknown): ResolvedConfig {
  const values = record(raw)
  const feedDir = text(values?.feedDir) ?? DEFAULT_FEED_DIR
  const sessionsDir = text(values?.sessionsDir)
  const days = values?.backfillDays
  return {
    feedDir: expandHome(feedDir),
    pricing: pricingOf(values?.pricing),
    backfill: values?.backfill === undefined ? true : values.backfill === true,
    backfillDays:
      typeof days === 'number' && Number.isFinite(days) && days >= 0
        ? Math.min(Math.trunc(days), MAX_BACKFILL_DAYS)
        : DEFAULT_BACKFILL_DAYS,
    sessionsDir: expandHome(sessionsDir ?? defaultSessionsDir()),
  }
}

/**
 * Subscribe to committed session events and write the feed. The loader owns
 * the fiber, so unloading the plugin stops every listener.
 */
export function apply(ctx: Context, config: unknown): void {
  const settings = resolveConfig(config)
  const logger = ctx.logger(name)
  const writer = new FeedWriter(settings.feedDir, settings.pricing, logger)

  // Backfill runs before any buffered live event is written, so a session's
  // history lands in the file before its ongoing turns do.
  let ready = !settings.backfill || settings.backfillDays === 0
  let disposed = false
  const pending: Array<{ identity: SessionIdentity; entries: FeedEntry[] }> = []

  const flush = async (): Promise<void> => {
    const items = pending.splice(0)
    await Promise.all(items.map((item) => writer.ingest(item.identity, item.entries)))
  }

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (disposed) return
    try {
      const entries = feedEntriesForEvent(event as unknown as FeedEventLike, settings.pricing)
      if (entries.length === 0) return
      const identity = identityOf(session)
      if (ready) void writer.ingest(identity, entries)
      else pending.push({ identity, entries })
    } catch (error) {
      logger.warn(`could not record session usage: ${describe(error)}`)
    }
  })

  if (!ready) {
    void (async () => {
      try {
        for await (const item of backfillSessions(settings.sessionsDir, {
          sinceMs: settings.backfillDays * DAY_MS,
          pricing: settings.pricing,
          feedDir: settings.feedDir,
        })) {
          if (disposed) return
          await writer.ingest(item.identity, item.entries)
        }
      } catch (error) {
        logger.warn(`could not backfill usage from session logs: ${describe(error)}`)
      } finally {
        if (!disposed) {
          ready = true
          void flush()
        }
      }
    })()
  }

  ctx.effect(() => async () => {
    disposed = true
    ready = true
    await flush()
    await writer.close()
  })
}

function defaultSessionsDir(): string {
  const home = process.env.DSH_HOME?.trim()
  return join(home !== undefined && home !== '' ? expandHome(home) : join(homedir(), '.dsh'), 'sessions')
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function pricingOf(value: unknown): Pricing {
  const pricing: Pricing = {}
  const entries = record(value)
  if (entries === undefined) return pricing
  for (const [model, raw] of Object.entries(entries)) {
    if (model === '') continue
    const rate = rateOf(raw)
    if (rate !== undefined) pricing[model] = rate
  }
  return pricing
}

function rateOf(value: unknown): ModelRate | undefined {
  const raw = record(value)
  if (raw === undefined) return undefined
  const input = number(raw.input)
  const output = number(raw.output)
  if (input === undefined || output === undefined) return undefined
  const rate: ModelRate = { input, output }
  const cacheRead = number(raw.cacheRead)
  const cacheWrite = number(raw.cacheWrite)
  if (cacheRead !== undefined) rate.cacheRead = cacheRead
  if (cacheWrite !== undefined) rate.cacheWrite = cacheWrite
  return rate
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
