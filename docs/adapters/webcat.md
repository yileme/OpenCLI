# webcat — 云译客 WebCAT online CAT from the CLI

Drive the 云译客 WebCAT online translation editor (`https://webcat-dl.iol8.com/...`) like the web UI does, but from the command line — so an AI agent can read source segments and fill translations for you.

## How it works

The WebCAT editor is a Vue SPA over a JSON API:

- `POST /api/...` with a hard-coded HTTP Basic client credential,
- a `ck` header copied from the editor URL query string (the *task key*),
- your normal iol8.com login cookies.

This adapter replays the same calls the page makes (`flowGetSentence`,
`batch-save-target`, `confirmSentences`, `finishTask`, …). Nothing is
screen-scraped, so translations you write appear in the real editor instantly.

> The CLI is a client like your browser. Whoever is logged into the session in
> `~/.opencli/webcat.json` owns the writes — treat `fill`/`confirm`/`submit`
> with the same care as clicking in the web editor.

## Setup (once)

```sh
# 1. Login: opens a Chrome window (its own profile), sign in to iol8.com and
#    open the task document you want. The CLI watches until the doc is open.
opencli webcat login

# Reuse an already-running debug Chrome instead of launching one:
opencli webcat login --cdp http://127.0.0.1:9222

# 2. Later, switch tasks by pasting a fresh editor URL from your browser:
opencli webcat open "https://webcat-dl.iol8.com/?ck=<...>&splitIndex=0#/project"
```

Session is stored at `~/.opencli/webcat.json` (mode 0600). Sessions expire when
WebCAT logs you out; rerun `login`, or `open` with `--cookie "ck=...; CASID=..."`.

## Commands

| Command | Access | What it does |
| --- | --- | --- |
| `webcat login` | write | Capture the browser session + task key |
| `webcat open <url>` | write | Point the session at another task document |
| `webcat status` | read | Current doc, language pair, progress |
| `webcat count` | read | Raw sentence counters |
| `webcat sentences` | read | Read segments (source/target/status/tags) |
| `webcat fill` | write | Write translations (batch) |
| `webcat confirm` | write | Confirm / un-confirm segments |
| `webcat submit` | write | Finish the task (needs `--yes`) |
| `webcat import` | write | Backfill from a Wordfast TXLF export (aligned, tags auto-injected) |
| `webcat restore` | write | Roll targets back from a fill backup snapshot |
| `webcat terms` | read/write | Terminology: extract candidates / add to termbase / list / consistency check |
| `webcat qa` | read | Run QA and classify false positives (real issues only) |

## Safe writes: idempotent fill, backups, resume

- `fill` is **diff-only by default**: segments whose current target already
  matches are skipped (`skipped_identical`), so re-running the same command is
  safe and doubles as the resume mechanism after a failure. Use `--force` to
  rewrite everything.
- Before writing, `fill` snapshots current targets to
  `~/.opencli/webcat-backups/<docId>-<timestamp>.json` (disable with
  `--no-backup`). Roll back with `webcat restore` (newest snapshot by default,
  or pass a file; `--dry-run` previews).
- Failed chunks are retried with backoff (auth errors fail fast); if chunks
  still fail, the error tells you to re-run the same command to resume.

## Terminology

```sh
webcat terms extract --min-count 3 --max 50   # frequency candidates + repeat inconsistencies
webcat terms list                             # termbase entries
webcat terms add --file terms.json            # [{source,target},…] → termbase (--dry-run to preview)
webcat terms check                            # segments violating an approved rendering
```

`extract` deliberately does **not** guess translations: it ranks CJK n-gram
candidates (stop-char edges removed) and separately reports
`repeat_inconsistencies` — identical source segments translated differently,
which are genuine consistency defects with segment ids attached.

## QA with false-positive filtering

```sh
webcat qa                  # run QA, classify, report only review/real entries
webcat qa --no-run         # classify the existing QA logs without re-running
webcat qa --min-verdict real   # only hard errors
```

Every QA log gets a verdict: `false_positive` (benign by rule), `review`
(needs human eyes), `real` (hard defect). Rules cover NUMBER (reformatted
dates, 万/亿 scale conversion, entity-digit artifacts), PUNCT/SPACE
(target-language convention), TAG/FORMAT (entity spelling), SPELL (proper
nouns kept verbatim). Counts come back as `{real, review, false_positive}` —
on the 740-segment pilot deck: 340 logs → 323 filtered, 17 worth reviewing,
0 hard errors.

## Importing from Wordfast (TXLF backfill)

Already translated the same file in Wordfast Pro? Push those translations into
the WebCAT task instead of re-translating:

```sh
opencli webcat import --file job.docx.txlf --dry-run   # alignment report only
opencli webcat import --file job.docx.txlf             # write tag-correct targets
```

What it does (and refuses to do):

- Five alignment passes: exact match → table-row cell → consecutive merge →
  `其中：/例如：` prefix cell → row tail. Unmatchable segments land on the
  `no_match` review list instead of being guessed.
- Inline tags are rebuilt for WebCAT: TXLF `bx/ex`/`bpt/ept` wrappers map onto
  WebCAT `rs/re` `<img>` pairs (LIFO nesting, payloads dropped), soft line
  breaks become newlines. A write is refused if any segment's target tag set
  does not equal its source tag set (`tag_mismatches` gate).
- Locked segments are never touched; segments whose current target already
  equals the TXLF translation are skipped (`--overwrite` to redo).
- Empty aligned targets are never written — a mis-split table cell goes to the
  review list with `reason: empty target cell`.
- Report fields: `matched_by_pass`, `filled`, `identical_skipped`,
  `locked_skipped`, `no_match_segments`, `tag_mismatches`, then `verified` /
  `mismatch_count` after writing.

## Agent translation loop

```sh
# 1. Where am I?
opencli webcat status

# 2. Pull untranslated segments (whole doc, compact payload)
opencli webcat sentences --filter untranslated --strip-html --out /tmp/seg.jsonl

# 3. Translate /tmp/seg.jsonl … then write back a JSON/JSONL file:
#    [{"sentId":"123","text":"译文"}, …]
opencli webcat fill --file /tmp/translations.jsonl

# 4. Confirm the ones you verified
opencli webcat confirm --filter translated

# 5. Hand the task back (preview first, --yes to execute)
opencli webcat submit
```

`fill` accepts any of these shapes:

```jsonc
// JSON array
[{"sentId":"123","text":"译文"}, {"sentId":"124","html":"译文<img src=\"…\">"}]
// JSON Lines — one object per line
{"sentId":"123","text":"译文"}
// {"sentId": "text"} map
{"123": "译文"}
// or a single pair on the command line
opencli webcat fill --sent-id 123 --text "译文"
```

Safety rails:

- locked segments are skipped unless `--keep-locked`;
- after writing, `fill` re-reads every segment and reports mismatches;
- `--dry-run` validates the payload without writing;
- `submit` is a preview unless `--yes` is passed;
- inline tags from the source are surfaced in `sourceTags` — put them back via
  the `html` field when a translation must keep them.

## Options worth knowing

- `webcat sentences --ids 1,2,3` — fetch specific segments only
- `webcat sentences --filter untranslated|translated|unconfirmed|confirmed|locked|unlocked`
- `webcat fill --chunk 50` — segments per request (editor itself batches ~50)
- `webcat fill --snapshot` — ask WebCAT to snapshot before writing
- `webcat status --skip-counts` — fewer API calls
- `webcat status` also resolves language names (`简体中文 (Simplified Chinese)`)
  via `/mt/info/getLanguageList`, so a wrong-direction task is visible at a glance
- `-f table|json|plain|md|csv|yaml` — output format on every command (JSON is default; `ok`/`data` envelope)

## Troubleshooting

- `AUTH_REQUIRED [000005]` — the WebCAT session expired or the task key
  changed. Reopen the task in the browser and run `opencli webcat open "<url>"`,
  or redo `opencli webcat login`.
- `CKID` cookie missing / doc refuses to load — your account may not have this
  task assigned; open it once in the browser first.
- Segment writes verify as mismatched — someone edited the same segments in the
  editor; re-run `sentences` and merge your translation with the current target.
- Dev/testing: `WEBCAT_BASE_URL=http://127.0.0.1:19837` overrides the API origin
  (used by the mock server in tests); production use never sets it.

## Limitations

- One document at a time (per session file). Switch with `opencli webcat open`.
- Excel-style split workbooks use WebCAT's `splitIndex`; the URL you paste
  already carries the right value and the CLI keeps it.
- Confirm-all / QA check / MT re-translate are not implemented (they cost
  account balance in WebCAT); only translation writes, confirms and submit.

## Tests

```sh
npx vitest run --project adapter clis/webcat/webcat.test.js   # 24 unit tests
node dist/src/main.js adapter check webcat                     # static validation
```
