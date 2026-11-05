import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backfillSessions, discoverSessionLogs, parseSessionLog } from '../lib/backfill.js'

const pricing = { 'deepseek/flash': { input: 1, output: 2 } }

const header = {
  type: 'session',
  version: 4,
  id: 'session-abc',
  createdAt: 1793850692328,
  cwd: '/Users/me/code/app',
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: 'standard',
}

const assistant = (seq, request, usage = { inputTokens: 10, outputTokens: 5 }) => ({
  type: 'assistant/message',
  seq,
  time: 1000 + seq,
  data: {
    turn: 1,
    step: 1,
    message: { id: request, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'deepseek/flash' } },
    usage,
    stream: [],
  },
})

const log = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'

test('a log maps to its identity and usage lines', () => {
  const parsed = parseSessionLog(
    log([
      header,
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      assistant(1, 'm1'),
      { type: 'turn/end', seq: 2, time: 1002, data: { turn: 1, reason: { kind: 'completed' } } },
    ]),
    pricing,
  )
  assert.equal(parsed.identity.session, 'session-abc')
  assert.equal(parsed.identity.ts, 1793850692328)
  assert.equal(parsed.identity.cwd, '/Users/me/code/app')
  assert.equal(parsed.identity.preset, 'standard')
  assert.deepEqual(
    parsed.entries.map((entry) => JSON.parse(entry.line).type),
    ['turn', 'usage', 'turn'],
  )
  assert.equal(JSON.parse(parsed.entries[1].line).cost, 0.00002)
})

test('a forked log does not bill its inherited prefix again', () => {
  const parsed = parseSessionLog(
    log([
      { ...header, isSeeded: true, parentSession: 'session-parent' },
      { type: 'turn/start', seq: 0, time: 900, data: { turn: 1 } },
      assistant(1, 'inherited'),
      { type: 'session/end-seed', seq: 2, time: 950, data: { inherited: true } },
      { type: 'turn/start', seq: 3, time: 1000, data: { turn: 2 } },
      assistant(4, 'live'),
    ]),
    pricing,
  )
  assert.equal(parsed.identity.parent, 'session-parent')
  assert.deepEqual(
    parsed.entries.map((entry) => JSON.parse(entry.line).type),
    ['turn', 'usage'],
  )
  assert.equal(JSON.parse(parsed.entries[1].line).request, 'live')
})

test('an ordinary end-seed marker is not a fork cut', () => {
  const parsed = parseSessionLog(
    log([
      header,
      assistant(1, 'm1'),
      { type: 'session/end-seed', seq: 2, time: 1002, data: {} },
      assistant(3, 'm2'),
    ]),
    pricing,
  )
  assert.deepEqual(
    parsed.entries.map((entry) => JSON.parse(entry.line).request),
    ['m1', 'm2'],
  )
})

test('only origin marks a subagent; a fork keeps its parent without it', () => {
  const subagent = parseSessionLog(
    log([{ ...header, origin: 'subagent', parentSession: 'session-parent', delegationDepth: 1 }, assistant(1, 'm1')]),
    pricing,
  )
  assert.equal(subagent.identity.parent, 'session-parent')
  assert.equal(subagent.identity.subagent, true)
  assert.equal(subagent.entries.length, 1)

  const fork = parseSessionLog(log([{ ...header, isSeeded: true, parentSession: 'session-parent' }, assistant(1, 'm1')]), pricing)
  assert.equal(fork.identity.parent, 'session-parent')
  assert.equal(fork.identity.subagent, undefined)
})

test('a pre-v1 seeded log cuts its inherited prefix by seedLength', () => {
  const parsed = parseSessionLog(
    log([
      { type: 'session', version: 0, id: 'session-v0', createdAt: 1793850692328, cwd: '/Users/me/code/app', parentSession: 'session-parent', seedLength: 3 },
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      assistant(1, 'inherited'),
      assistant(2, 'inherited-too'),
      { type: 'turn/start', seq: 3, time: 2000, data: { turn: 2 } },
      assistant(4, 'live'),
    ]),
    pricing,
  )
  assert.deepEqual(
    parsed.entries.map((entry) => JSON.parse(entry.line).type),
    ['turn', 'usage'],
  )
  assert.equal(JSON.parse(parsed.entries[1].line).request, 'live')
})

test('a log without a session header is refused, damaged rows are skipped', () => {
  assert.equal(parseSessionLog('not json\n{}\n', pricing), undefined)
  const parsed = parseSessionLog(log([header, assistant(1, 'm1')]) + '{broken\n', pricing)
  assert.equal(parsed.entries.length, 1)
})

test('discovery finds nested session logs and honours the window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sessions-'))
  const recent = join(dir, '--Users-me-app--', 'session-a')
  const old = join(dir, '--Users-me-old--', 'session-b')
  await mkdir(recent, { recursive: true })
  await mkdir(old, { recursive: true })
  await writeFile(join(recent, 'session.v4.jsonl.zstd'), log([header]))
  await writeFile(join(old, 'session.v4.jsonl.zstd'), log([header]))
  await writeFile(join(recent, 'notes.jsonl'), log([header]))
  const past = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
  await utimes(join(old, 'session.v4.jsonl.zstd'), past, past)

  const found = await discoverSessionLogs(dir, 30 * 24 * 60 * 60 * 1000)
  assert.deepEqual(found, [join(recent, 'session.v4.jsonl.zstd')])
})

test('a session whose feed already covers its log is skipped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sessions-'))
  const feedDir = await mkdtemp(join(tmpdir(), 'dsh-feed-'))
  const session = join(dir, '--Users-me-app--', 'session-abc')
  await mkdir(session, { recursive: true })
  await writeFile(join(session, 'session.v4.jsonl.zstd'), log([header, assistant(1, 'm1')]))
  await writeFile(join(feedDir, 'session-abc.jsonl'), '{"v":1,"type":"session"}\n')

  const covered = []
  for await (const item of backfillSessions(dir, {
    sinceMs: 60_000,
    pricing,
    feedDir,
    decompress: (buffer) => buffer,
  })) covered.push(item)
  assert.equal(covered.length, 0)

  const past = new Date(Date.now() - 120_000)
  await utimes(join(feedDir, 'session-abc.jsonl'), past, past)
  const stale = []
  for await (const item of backfillSessions(dir, {
    sinceMs: 60_000,
    pricing,
    feedDir,
    decompress: (buffer) => buffer,
  })) stale.push(item)
  assert.equal(stale.length, 1)
})

test('backfill yields the entries of every recent session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sessions-'))
  const session = join(dir, '--Users-me-app--', 'session-a')
  await mkdir(session, { recursive: true })
  await writeFile(join(session, 'session.v4.jsonl.zstd'), log([header, assistant(1, 'm1')]))

  const items = []
  for await (const item of backfillSessions(dir, {
    sinceMs: 60_000,
    pricing,
    decompress: (buffer) => buffer,
  })) items.push(item)
  assert.equal(items.length, 1)
  assert.equal(items[0].identity.session, 'session-abc')
  assert.equal(items[0].entries.length, 1)
})
