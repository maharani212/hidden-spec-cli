[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122/maharani212/hidden-spec-cli/rank.svg?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard)
[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122/maharani212/hidden-spec-cli/reward.svg?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend

`mend` is one patch tool for every AI edit format. It reads a patch in any of four
formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the
V4A patch format, and text-editor tool calls as JSON — and applies it to a tree of
text files, to the specification in the kit's `SPEC.md`.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file, relative to the working directory. When it is
  absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or
  `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and
  no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## What it does

- Finds the lines an edit names even when the model drifted their whitespace or
  indentation, at three matching tiers (exact, trailing whitespace, leading and
  trailing whitespace), with re-indentation of added lines at the loosest tier.
- Applies unified hunks at the occurrence nearest the hunk's (possibly wrong) line
  number, handles creations, deletions and renames, and honours `\ No newline at end
  of file`.
- Applies SEARCH/REPLACE blocks (including creates, and reporting `ambiguous` when the
  old lines occur more than once), V4A patches (anchors, cursor, end-of-file chunks,
  moves) and JSON tool calls (`create`, `str_replace`, `insert`).
- Changes every file or none: a failed edit changes nothing, the edits after it still
  run, and when any edit failed no file is written. Exit codes and stdout follow the
  specification exactly.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks from the
  environment and runs `main.ts` on each one.

## Verification

Practice score: **1000** (100 of 100 practice checks pass), plus 73 hand-built edge
cases covering specification sentences the practice set does not show. Verified with
the kit's `check.ts` harness against `main.ts` and `runner.ts`.
