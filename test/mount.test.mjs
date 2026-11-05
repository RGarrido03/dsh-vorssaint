import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, resolveConfig } from '../lib/index.js'

const session = {
  header: { id: 'session-live', createdAt: 1793850692328, cwd: '/Users/me/code/app' },
}

const usage = {
  type: 'assistant/message',
  seq: 2,
  time: 1793850842900,
  data: {
    turn: 1,
    step: 1,
    message: { id: 'm1', role: 'assistant', source: { kind: 'model', provider: 'commandcode', model: 'deepseek/flash' } },
    usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 300, cacheWriteTokens: 20, reasoningTokens: 10 },
    stream: [],
  },
}

test('a mounted plugin turns committed events into a readable feed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vorssaint-mount-'))
  const ctx = new Context()
  apply(ctx, resolveConfig({ feedDir: dir, backfill: false }))

  ctx.emit('session/event', session, { type: 'turn/start', seq: 1, time: 1793850830395, data: { turn: 1 } })
  ctx.emit('session/event', session, usage)
  ctx.emit('session/event', session, { type: 'turn/end', seq: 3, time: 1793850847000, data: { turn: 1, reason: { kind: 'completed' } } })
  ctx.emit('session/event', session, { type: 'tool/result', seq: 4, time: 1793850848000, data: {} })
  await new Promise((resolve) => setTimeout(resolve, 100))

  const lines = (await readFile(join(dir, 'session-live.jsonl'), 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(lines.map((line) => line.type), ['session', 'turn', 'usage', 'turn'])
  assert.deepEqual(lines[1], { v: 1, type: 'turn', ts: 1793850830395, turn: 1, phase: 'start', seq: 1 })
  assert.deepEqual(lines[2].tokens, { input: 100, cacheWrite: 20, cacheRead: 300, output: 40, reasoning: 10 })
  assert.equal(lines[2].cost, undefined)
  assert.equal(lines[3].completed, true)

})

test('the plugin writes no feed for events it does not read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vorssaint-mount-'))
  const ctx = new Context()
  apply(ctx, resolveConfig({ feedDir: dir, backfill: false }))
  ctx.emit('session/event', session, { type: 'tool/call', seq: 1, time: 1, data: {} })
  await new Promise((resolve) => setTimeout(resolve, 50))
  await assert.rejects(readFile(join(dir, 'session-live.jsonl'), 'utf8'))
})
