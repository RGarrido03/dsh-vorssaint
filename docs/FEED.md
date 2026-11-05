# DSH usage feed — contract v1

The `dsh-vorssaint` DSH plugin writes one JSONL file per DeepSeek Harness
session. Vorssaint's `DSHReader` tails those files to report usage, API value
and live runs for the DeepSeek Harness provider.

The plugin is the only writer; Vorssaint is the only reader. The contract is
versioned with the `v` field on every line and only changes with a new major
version of the plugin.

## Location

```
~/.vorssaint/agents/dsh/<session-id>.jsonl
```

* The directory is created on demand, mode `0700`; files are mode `0600`.
  Existing paths are tightened to the same modes on first use.
* `<session-id>` is the DSH session id (`session-<uuid>` or `<uuid>` for
  subagent sessions) with every character outside `[A-Za-z0-9._-]` replaced by
  `_`.
* Files are UTF-8, one JSON object per line, `\n` terminated. A torn final
  line (no trailing newline) is ignored by the reader and removed by the
  writer the next time it opens the file.
* The directory can be overridden in the plugin config (`feedDir`), but
  Vorssaint only reads this default path.

## Lines

Every line is an object with `v` (always `1`) and `type`. Times are epoch
**milliseconds**. Unknown fields and unknown line types are ignored by the
reader. The writer adds `seq` (the DSH event sequence) to every line it can;
it uses it to skip replayed events and Vorssaint ignores it.

### `session`

Written first in a file. A restart appends to the existing file instead of
rewriting it, so the header normally appears once.

```json
{"v":1,"type":"session","session":"session-7fe88e4c-4773-4582-ab38-d5b56f942811","ts":1793850692328,"cwd":"/Users/ruben/dsh-plugins","preset":"standard"}
```

| field | type | meaning |
|---|---|---|
| `session` | string | DSH session id |
| `ts` | number | `SessionHeader.createdAt` |
| `cwd` | string, optional | session working directory; the reader derives the project name from its last path component |
| `parent` | string, optional | the session this one was created from, informational. DSH also records it for ordinary forks, so it does **not** mean "subagent". |
| `subagent` | `true`, optional | present only when DSH's `SessionHeader.origin` is `subagent`; the reader then counts usage but shows no live run |
| `preset` | string, optional | DSH agent preset at creation |

### `turn`

```json
{"v":1,"type":"turn","ts":1793850830395,"turn":1,"phase":"start"}
{"v":1,"type":"turn","ts":1793850866520,"turn":1,"phase":"end","completed":true}
```

| field | type | meaning |
|---|---|---|
| `ts` | number | DSH event time |
| `turn` | integer | DSH turn number |
| `phase` | `"start"` or `"end"` | |
| `completed` | boolean, on `end` | `true` when the turn ended normally: reason `completed` or `max-tokens`; `false` for `aborted`, `interrupted`, `blocked`, `error`, `forked` |
| `seq` | integer, optional | the DSH event sequence, present on every turn line the writer emits |

Turn lines in a subagent session (`subagent: true`) are ignored by the reader:
the subagent's work is part of the run it serves. Its usage is still counted.
A session that merely has a `parent` (an ordinary fork) keeps its turn lines.

### `usage`

One line per assembled model response that reported usage. This is the billing
record.

```json
{"v":1,"type":"usage","ts":1793850842900,"turn":1,"step":2,"seq":20,"request":"eb7abe7f-9bfe-4df1-b072-4c365a8112a5","model":"deepseek/deepseek-v4.1-flash","provider":"commandcode","tokens":{"input":4819,"cacheWrite":0,"cacheRead":77568,"output":339,"reasoning":78},"cost":0.0004}
```

| field | type | meaning |
|---|---|---|
| `ts` | number | DSH event time |
| `turn`, `step` | integer | position in the session (informational) |
| `seq` | integer, optional | DSH event sequence; used by the writer, ignored by the reader |
| `request` | string, optional | assistant message id; with `session` it forms the reader's dedupe key |
| `model` | string | model id exactly as the provider route reported it |
| `provider` | string, optional | DSH provider route (informational) |
| `tokens.input` | integer | prompt tokens that missed the cache |
| `tokens.cacheWrite` | integer | prompt tokens written to the cache |
| `tokens.cacheRead` | integer | prompt tokens served from the cache |
| `tokens.output` | integer | completion tokens; includes reasoning tokens |
| `tokens.reasoning` | integer | reasoning tokens included in `output` |
| `cost` | number, optional | API list value of this response in US dollars, when the plugin has a price for the model; omitted when unknown |

## Reader semantics (Vorssaint `DSHReader`)

* `session` → adopt `session`, compute `project` with the existing
  `AgentLogParser.projectName(cwd)`, remember `subagent: true` (never infer it
  from `parent`).
* `turn` `start` (root session) → `.turnBegan(ts)`.
* `turn` `end` (root session) → `.turnEnded(ts, completed: completed, duration: nil)`.
* `usage` → `.usage(key: "dsh:" + (request or "<session>:<turn>:<step>:<ts>"),
  record: AgentUsageRecord(provider: .dsh, date: ts, model: model,
  project: state.project, session: state.session, tokens: tokens,
  cost: cost, savings: 0, reportedCost: cost != nil), billable: AgentBillable(tokens: tokens))`.
* Missing `tokens` fields default to 0; negative or non-finite values are
  clamped to 0. A usage line with an empty `model` is ignored.
* The reader tolerates a file that starts mid-session: absent metadata leaves
  the session/project empty and only usage is counted.
* Vorssaint's store dedupes `usage` records by `key`, so the same response
  written twice never double counts. `turn` lines have no key: a re-read can
  replay a turn boundary, which the store's idempotence rules absorb.
* `DSHReader.readsFullHistoryFirst` is `false`.

## Golden lines

```json
{"v":1,"type":"session","session":"s-dsh","ts":1790088000000,"cwd":"/Users/me/code/app","preset":"standard"}
{"v":1,"type":"turn","ts":1790088000000,"turn":1,"phase":"start","seq":0}
{"v":1,"type":"usage","ts":1790088010000,"turn":1,"step":1,"request":"m1","model":"deepseek/deepseek-v4.1-flash","provider":"commandcode","tokens":{"input":100,"cacheWrite":20,"cacheRead":300,"output":40,"reasoning":10},"cost":0.001}
{"v":1,"type":"turn","ts":1790088020000,"turn":1,"phase":"end","completed":true}
```

```json
{"v":1,"type":"session","session":"s-sub","ts":1790088000000,"cwd":"/Users/me/code/app","parent":"s-dsh","subagent":true}
{"v":1,"type":"turn","ts":1790088000000,"turn":1,"phase":"start","seq":0}
{"v":1,"type":"usage","ts":1790088010000,"turn":1,"step":1,"request":"m2","model":"deepseek/deepseek-v4.1-flash","tokens":{"input":10,"output":5}}
```

The subagent file's usage is counted; its turn lines produce no live runs.

## Writer-side behavior worth knowing

* **Backfill.** On start the plugin reads `session*.jsonl.zstd` under the DSH
  sessions directory for the last `backfillDays` days (default 30) and writes
  the usage/turn lines already present. For a seeded (forked) session it skips
  every event up to and including the `session/end-seed` marker whose
  `inherited` is `true`, so forked history is not billed twice.
* **Live.** Lines are appended as the session commits them. Writes are queued
  per file, so order inside a file is preserved.
* **Restarts.** Existing files are appended to, not rewritten; a missing file
  for a recent session is rebuilt from that session's log.
* **Privacy.** Only the fields above are written. No prompt text, tool
  arguments, model output or file paths beyond `cwd` ever enter the feed.
