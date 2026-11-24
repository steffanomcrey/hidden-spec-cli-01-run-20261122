# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/steffanomcrey/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/steffanomcrey/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. Every format is read as SPEC.md says, and every file is changed or nothing is.

Matching runs at three tiers: exact lines, then lines equal once trailing spaces and tabs are removed, then lines equal once leading and trailing spaces and tabs are removed. Unified hunks take the occurrence nearest to their stated line number; SEARCH/REPLACE blocks refuse an ambiguous match; V4A chunks walk a cursor through the file.

## Run it

```sh
node main.ts [options] [PATCH]
```

`--format=NAME` reads the patch in one format (`unified`, `search-replace`, `v4a`, `json`; `auto`, the default, detects it). `--check` does everything but write. `--strict` matches lines exactly. With PATCH absent or `-`, the patch is read from standard input.

---

<sub>Entered on [make.fun](https://make.fun/?ref=kiyelsauter&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
