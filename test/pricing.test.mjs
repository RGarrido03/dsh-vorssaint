import test from 'node:test'
import assert from 'node:assert/strict'
import { costOf, resolveRate } from '../lib/pricing.js'

const rate = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 }

test('the exact model rate wins over the wildcard', () => {
  const pricing = { 'deepseek/a': rate, '*': { input: 9, output: 9 } }
  assert.deepEqual(resolveRate(pricing, 'deepseek/a'), rate)
  assert.deepEqual(resolveRate(pricing, 'deepseek/unknown'), { input: 9, output: 9 })
  assert.equal(resolveRate(pricing, ''), undefined)
  assert.equal(resolveRate(undefined, 'deepseek/a'), undefined)
})

test('cost prices input, cache and output at their own rates', () => {
  const cost = costOf(rate, { input: 100, cacheWrite: 20, cacheRead: 300, output: 40, reasoning: 10 })
  assert.ok(cost !== undefined && Math.abs(cost - 0.00022) < 1e-12)
})

test('cache rates fall back to the input rate', () => {
  const cost = costOf({ input: 2, output: 0 }, { input: 0, cacheWrite: 5, cacheRead: 5, output: 0, reasoning: 0 })
  assert.ok(cost !== undefined && Math.abs(cost - 0.00002) < 1e-12)
})

test('reasoning is already inside output and is not billed twice', () => {
  const tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 10, reasoning: 10 }
  assert.equal(costOf(rate, tokens), costOf(rate, { ...tokens, reasoning: 0 }))
})

test('no rate means no cost', () => {
  assert.equal(costOf(undefined, { input: 1, cacheWrite: 0, cacheRead: 0, output: 1, reasoning: 0 }), undefined)
})
