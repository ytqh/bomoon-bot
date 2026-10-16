# REVIEW.md format

`REVIEW.md` lives at the root of the reviewed repository. It is Markdown with an optional YAML front matter. The front matter tells bomoon-bot which files to load and which questions to answer; the body is free guidance for the reviewer.

bomoon-bot reads `REVIEW.md` and every file it loads **at the pull request's base commit**.

## Front matter

| Field | Type | Meaning |
|---|---|---|
| `load` | list | Repository files given to the reviewer as rules. Each entry is a path, or `{ path, when }`: load `path` only when a changed file matches the `when` glob(s). |
| `questions` | list | The checklist, answered one by one: `{ id, ask, when?, on_yes? }`. A question whose `when` globs match no changed file is answered `n/a`. |
| `ignore` | list | Topics the reviewer must not report (e.g. `style`, `naming`, `performance`). |

Globs: `*` (within a path segment), `**` (any depth), `?`. A `{module}` placeholder in both `path` and `when` loads one file per touched module, e.g. `{ path: "contract/{module}/AGENTS.md", when: "contract/{module}/**" }`.

Reserved for later (accepted and passed to the reviewer as text today): `on_yes` (`request_changes` / `escalate`), `re_review`, `evidence`, `verdict`, `tests`.

Limits: up to 30 loaded files, 200 KB each; a missing file is reported, not an error.

## Body

Plain Markdown: what a real problem means in this repo, examples, what never to report. Keep it short; long background belongs in the files you `load`.

## Output

One review on the PR with the header `🤖 bomoon-bot review (rules: REVIEW.md@<base sha>) @ <head sha>`, one line per question (`ok`, `n/a`, or a finding that cites the file, the rule and the quoted rule text), then any other findings.
