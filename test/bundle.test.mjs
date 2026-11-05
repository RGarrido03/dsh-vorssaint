import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config, name, resolveConfig } from '../lib/index.js'

const root = new URL('..', import.meta.url)

test('the package is a publishable DSH bundle', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.equal(pkg.name, 'dsh-vorssaint')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, './lib/index.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(pkg.files.includes('lib'))
  assert.ok(pkg.files.includes('docs'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))

  const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8')
  assert.match(patch, /id: vorssaint/)
  assert.match(patch, /name: "dsh-vorssaint"/)

  const feed = await readFile(new URL('docs/FEED.md', root), 'utf8')
  assert.match(feed, /~\/\.vorssaint\/agents\/dsh/)
})

test('the plugin name matches the loader row id', () => {
  assert.equal(name, 'vorssaint')
})

test('the config schema provides the documented defaults', () => {
  const defaults = Config({})
  assert.equal(defaults.feedDir, '~/.vorssaint/agents/dsh')
  assert.deepEqual(defaults.pricing, {})
  assert.equal(defaults.backfill, true)
  assert.equal(defaults.backfillDays, 30)
  assert.equal(defaults.sessionsDir, '')
})

test('resolved config expands paths and keeps only usable rates', () => {
  const resolved = resolveConfig({
    feedDir: '~/custom-feed',
    sessionsDir: '~/custom-sessions',
    backfill: false,
    backfillDays: 7.9,
    pricing: {
      'deepseek/flash': { input: 1, output: 2, cacheRead: 0.1 },
      'deepseek/bad': { input: -1, output: 2 },
      '*': { input: 0.5, output: 1, cacheWrite: 2 },
      empty: 'nope',
    },
  })
  assert.equal(resolved.feedDir, join(homedir(), 'custom-feed'))
  assert.equal(resolved.sessionsDir, join(homedir(), 'custom-sessions'))
  assert.equal(resolved.backfill, false)
  assert.equal(resolved.backfillDays, 7)
  assert.deepEqual(resolved.pricing, {
    'deepseek/flash': { input: 1, output: 2, cacheRead: 0.1 },
    '*': { input: 0.5, output: 1, cacheWrite: 2 },
  })
})

test('an unset sessions directory follows DSH_HOME', () => {
  const saved = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    assert.equal(resolveConfig({}).sessionsDir, join(homedir(), '.dsh', 'sessions'))
    process.env.DSH_HOME = '/tmp/dsh-home'
    assert.equal(resolveConfig({}).sessionsDir, '/tmp/dsh-home/sessions')
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})
