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
