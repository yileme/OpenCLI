# WebcatCLI — OpenCLI fork with a 云译客 WebCAT adapter

This is a fork of [jackwener/opencli](https://github.com/jackwener/opencli)
(Apache-2.0) that adds **`opencli webcat …`**, a CLI for the 云译客 WebCAT
online CAT editor (`https://webcat-dl.iol8.com`). It lets an AI agent read the
source segments of a translation task and fill in the translations exactly like
the web editor does — over the editor's own JSON API, not screen scraping.

See **[docs/adapters/webcat.md](docs/adapters/webcat.md)** for the full guide.

## Quick start

```sh
npm install && npm run build          # builds dist/ and cli-manifest.json
alias opencli="node $(pwd)/dist/src/main.js"

opencli webcat login                  # opens Chrome: sign in + open your task
opencli webcat status                 # shows doc / progress
opencli webcat sentences --filter untranslated --strip-html --out /tmp/seg.jsonl

# … translate /tmp/seg.jsonl with your agent …

opencli webcat fill --file /tmp/translations.jsonl
opencli webcat confirm --filter translated
opencli webcat submit                 # add --yes to actually submit
```

## Commands

`webcat login | open | status | count | sentences | fill | confirm | submit`
— read/write access is enforced per command, `fill` verifies every write by
re-reading, locked segments are skipped unless forced, and `submit` is a
preview unless `--yes`.

Everything else in this repository (browser bridge, 170+ site adapters,
skills) is upstream OpenCLI, unchanged. Upstream README: [README.md](README.md) /
[README.zh-CN.md](README.zh-CN.md).
