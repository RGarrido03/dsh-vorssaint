# dsh-vorssaint

[![npm](https://img.shields.io/npm/v/dsh-vorssaint)](https://www.npmjs.com/package/dsh-vorssaint)
[![ci](https://github.com/RGarrido03/dsh-vorssaint/actions/workflows/ci.yml/badge.svg)](https://github.com/RGarrido03/dsh-vorssaint/actions/workflows/ci.yml)

Report [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
usage to [Vorssaint](https://vorssaint.com): token spend, live runs, models and
projects, and — with your model prices — the API value that feeds the daily
budget.

Vorssaint already follows Claude, Codex, OpenCode and GitHub Copilot by reading
their local session logs. DSH keeps its logs compressed and rotates them, so
this plugin writes the small, stable JSONL feed that Vorssaint's DSH reader
tails instead:

```
~/.vorssaint/agents/dsh/<session-id>.jsonl
```

The plugin starts reporting from the moment it loads; usage from recent
sessions is imported from DSH's own logs on first run, so the current day and
month are not empty after installing it.

## Requirements

- DeepSeek Harness `0.2.2-rc.1` or newer in the `0.2.x` line.
- A Vorssaint build with DeepSeek Harness support (the `dsh` provider).
- Node.js `22.15` or newer for backfill; without it the live feed still works.

## Install

```bash
dsh plugin --profile web add dsh-vorssaint
```

Use `--profile desktop` when your app runs the desktop profile. From a local
checkout, before the npm release:

```bash
dsh plugin --profile web add link:$PWD
```

Enable the bundle if the Plugin Manager did not (add `"dsh-vorssaint"` to
`dsh.profile.bundles` in `~/.dsh/profiles/<profile>/package.json`), then
**restart DSH**. The installer marks a new bundle as requiring a restart because
the running host cannot pick up a plugin that is not in its live list.

Finally, open Vorssaint → Settings → the AI page and switch **DeepSeek Harness**
on. It is enabled by default like the other agents once the feature is
installed.

## Prices and the daily budget

DSH reports tokens per response, not a price, and a gateway can report any
model id it likes. The plugin therefore ships no prices: configure the rates
you are actually billed, in USD per million tokens, keyed by the exact model id
Vorssaint will show (the id DSH reports in `assistant/message`). Add a `*`
entry as the fallback for ids you did not list.

Add this to `~/.dsh/profiles/<profile>/cordis.patch.yml` (the file's existing
entries stay):

```yaml
- id: vorssaint
  config:
    pricing:
      "deepseek/deepseek-v4.1-flash":
        input: 0.28
        output: 0.42
        cacheRead: 0.028
        cacheWrite: 0.28
      "*":
        input: 1
        output: 2
```

`cacheRead` and `cacheWrite` default to the input rate. Reasoning tokens are
already part of output and are not billed twice. Without a price the feed still
carries tokens, model, project and runs; only API value and the daily budget
stay empty for those responses.

Change the values to the rates on your provider's pricing page — the numbers
above are a shape example, not a quote.

## How it works

1. The plugin listens to DSH's committed `session/event` stream.
2. Every response that reports usage becomes one `usage` line with input,
   cache-write, cache-read, output and reasoning tokens, the model id and the
   provider route, plus `cost` when the model has a rate.
3. Turn boundaries become `turn` lines, which Vorssaint shows as a live run.
4. One file per session, append-only and serialized; the writer skips sequences
   already on disk, so restarts and re-reads never double count. Vorssaint also
   dedupes by the response id.
5. On start, before buffered live events are written, the plugin imports the
   usage already in DSH's session logs from the last `backfillDays` days. A
   session whose feed is newer than its log is skipped, so a normal restart
   costs nothing. A fork's inherited prefix is not billed again.

The exact line schema, tolerances and golden lines are in
[`docs/FEED.md`](docs/FEED.md).

## Configuration

| field | default | meaning |
| --- | --- | --- |
| `feedDir` | `~/.vorssaint/agents/dsh` | Where the feed is written. Vorssaint only reads the default path; change it only together with the app side. |
| `pricing` | `{}` | USD per million tokens by exact model id; `*` is the fallback. |
| `backfill` | `true` | Import usage already in recent DSH session logs on start. |
| `backfillDays` | `30` | How far back to import. `0` disables the scan. |
| `sessionsDir` | `$DSH_HOME/sessions`, else `~/.dsh/sessions` | DSH's session-log directory, for backfill. |

Configuration is validated by the loader; invalid rates are dropped rather than
guessed. The feed directory and files are created with `0700`/`0600`.

## Privacy

Only the fields in [`docs/FEED.md`](docs/FEED.md) are written: session id,
working directory, timestamps, turn numbers, model/provider ids, token counts
and the optional cost. No prompt text, tool arguments, model output, file
contents or credentials ever enter the feed. Writes are fire-and-forget: a full
disk or a closed permissions dialog is logged once and never blocks or fails an
agent turn.

## Troubleshooting

- **No DeepSeek Harness entry in Vorssaint.** Update Vorssaint to a build with
  the DSH provider, then enable it on the AI settings page.
- **Plugin not loaded.** `dsh --profile web --dump-config | grep vorssaint`
  should show the `vorssaint` row. If it does not, enable the bundle and restart
  DSH.
- **No data.** Check that `~/.vorssaint/agents/dsh` exists after a DSH turn. A
  turn with no model response (for example, cancelled before the first step)
  writes no usage line.
- **Tokens but no budget.** Configure `pricing` (above).

## Development

```bash
pnpm install
pnpm check        # typecheck, build, unit tests
```

The tests cover the line mapping, cost rules, backfill parsing (including fork
cuts and subagents), the append-only writer's restart behavior, and the package
metadata the loader reads.

## License

MIT © Rúben Garrido
