# Contributing & commit attribution

Thank you for respecting how this repository stays maintainable and how GitHub counts contributors.

## Attribution policy

- **Do not** add `Co-authored-by: …` trailers for **AI coding tools** (e.g. Cursor Agent, Copilot, etc.) or other automated agents when committing to this repo.
- Attribution on `main` should reflect **human maintainers only** (currently **DVThomas01**).
- If you use assistants while coding, keep that in your own notes—**not** in Git commit footers.

Disabling “add co-author” / similar options in your IDE prevents trailers from being injected on `git commit`.

## Practical tips

- Prefer `git commit --no-verify` only when you trust it; the real issue is **co-author injection**, not hooks in general.
- For a commit message you need to be 100% trailer-free, **`git commit-tree`** (see Git docs) builds the commit without going through editor/hook flows that might append lines.
