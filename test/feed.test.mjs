import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FeedWriter, feedEntriesForEvent, feedFileName, sessionLine } from '../lib/feed.js'

const pricing = { 'deepseek/flash': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 } }
const identity = { session: 'session-abc', ts: 1793850692328, cwd: '/Users/me/code/app', preset: 'standard' }

const assistant = (overrides = {}) => ({
  type: 'assistant/message',
  seq: 20,
  time: 1793850842900,
  data: {
    turn: 1,
    step: 2,
    message: {
      id: 'message-1',
      role: 'assistant',
      source: { kind: 'model', provider: 'commandcode', model: 'deepseek/flash' },
    },
    usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 300, cacheWriteTokens: 20, reasoningTokens: 10 },
    ...overrides,
  },
})

test('the session line carries identity and omits absent metadata', () => {
  const line = JSON.parse(sessionLine(identity))
  assert.deepEqual(line, { v: 1, type: 'session', session: 'session-abc', ts: 1793850692328, cwd: '/Users/me/code/app', preset: 'standard' })
  const minimal = JSON.parse(sessionLine({ session: 's', ts: 1, parent: null }))
  assert.deepEqual(minimal, { v: 1, type: 'session', session: 's', ts: 1 })
  const subagent = JSON.parse(sessionLine({ session: 's', ts: 1, parent: 'parent' }))
  assert.equal(subagent.parent, 'parent')
})

test('a turn start and both outcomes map to turn lines', () => {
  const start = feedEntriesForEvent({ type: 'turn/start', seq: 7, time: 1000, data: { turn: 3 } }, pricing)
  assert.deepEqual(JSON.parse(start[0].line), { v: 1, type: 'turn', ts: 1000, turn: 3, phase: 'start', seq: 7 })
  for (const [kind, completed] of [
    ['completed', true],
    ['max-tokens', true],
    ['aborted', false],
    ['interrupted', false],
    ['blocked', false],
    ['error', false],
  ]) {
    const [entry] = feedEntriesForEvent({ type: 'turn/end', seq: 8, time: 2000, data: { turn: 3, reason: { kind } } }, pricing)
    assert.equal(JSON.parse(entry.line).completed, completed, kind)
  }
})

test('a usage line carries tokens, attribution and the resolved cost', () => {
  const [entry] = feedEntriesForEvent(assistant(), pricing)
  const line = JSON.parse(entry.line)
  assert.equal(line.type, 'usage')
  assert.equal(line.request, 'message-1')
  assert.equal(line.model, 'deepseek/flash')
  assert.equal(line.provider, 'commandcode')
  assert.deepEqual(line.tokens, { input: 100, cacheWrite: 20, cacheRead: 300, output: 40, reasoning: 10 })
  // (100*1 + 20*0.5 + 300*0.1 + 40*2) / 1e6
  assert.ok(Math.abs(line.cost - 0.00022) < 1e-12)
})

test('usage without a configured rate keeps the tokens and omits cost', () => {
  const [entry] = feedEntriesForEvent(assistant(), {})
  const line = JSON.parse(entry.line)
  assert.equal(line.cost, undefined)
  assert.equal(line.tokens.output, 40)
})

test('unusable usage lines produce nothing', () => {
  assert.deepEqual(feedEntriesForEvent(assistant({ usage: undefined }), pricing), [])
  const noModel = assistant()
  delete noModel.data.message.source
  assert.deepEqual(feedEntriesForEvent(noModel, pricing), [])
  assert.deepEqual(feedEntriesForEvent({ type: 'tool/result', seq: 1, time: 1, data: {} }, pricing), [])
  assert.deepEqual(feedEntriesForEvent({ type: 'assistant/message', seq: -1, time: 1, data: {} }, pricing), [])
})

test('damaged token counts are clamped instead of trusted', () => {
  const [entry] = feedEntriesForEvent(
    assistant({ usage: { inputTokens: -5, outputTokens: 'many', cacheReadTokens: 1.9, cacheWriteTokens: null } }),
    {},
  )
  assert.deepEqual(JSON.parse(entry.line).tokens, { input: 0, cacheWrite: 0, cacheRead: 1, output: 0, reasoning: 0 })
})

test('a session file is appended once per sequence and survives a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vorssaint-'))
  const turn = (seq) => ({ seq, line: JSON.stringify({ v: 1, type: 'turn', ts: 1000, turn: seq, phase: 'start', seq }) })
  const first = new FeedWriter(dir, pricing)
  await first.ingest(identity, [turn(5), turn(6)])
  await first.close()

  const second = new FeedWriter(dir, pricing)
  await second.ingest(identity, [turn(6), turn(7)])
  await second.close()

  const text = await readFile(join(dir, feedFileName(identity.session)), 'utf8')
  const lines = text.trimEnd().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(lines.map((line) => line.seq ?? line.type), ['session', 5, 6, 7])
  assert.equal(lines[0].session, 'session-abc')
})

test('a fresh session file gets its header before its first line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vorssaint-'))
  const writer = new FeedWriter(dir, pricing)
  await writer.ingest(identity, [{ seq: 1, line: '{"n":1}' }])
  await writer.ingest(identity, [{ seq: 2, line: '{"n":2}' }])
  await writer.close()
  const lines = (await readFile(join(dir, feedFileName(identity.session)), 'utf8')).trimEnd().split('\n')
  assert.equal(JSON.parse(lines[0]).type, 'session')
  assert.equal(lines.length, 3)
})

test('session ids cannot escape the feed directory', () => {
  assert.equal(feedFileName('session-1'), 'session-1.jsonl')
  assert.equal(feedFileName('../evil'), '__evil.jsonl')
  assert.equal(feedFileName('a/b c'), 'a_b_c.jsonl')
  assert.equal(feedFileName('...'), '_.jsonl')
})
