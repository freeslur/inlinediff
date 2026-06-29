<!-- marketplace-readme -->

<div align="center">

<img src="https://raw.githubusercontent.com/freeslur/inlinediff/main/media/icon.png" width="96" height="96" alt="Inline Diff icon">

# Inline Diff

**Review AI and tool-generated edits change by change before they reach Git.**

[GitHub](https://github.com/freeslur/inlinediff) · [Issues](https://github.com/freeslur/inlinediff/issues) · [Korean README](https://github.com/freeslur/inlinediff/blob/main/README.ko.md)

<img src="https://raw.githubusercontent.com/freeslur/inlinediff/main/media/inline-diff-screenshot.png" alt="Inline Diff showing changed files and inline accept/reject controls" width="920">

</div>

## Why Inline Diff

AI agents, formatters, scripts, and editor tools can change a lot of files before you
are ready to commit. Inline Diff gives those edits a review layer before Git history:
scan what changed, open an inline diff, accept the good parts, reject the bad parts,
and keep uncertain hunks for another pass.

Inline Diff stores its own accepted baseline inside `.inlinediff/`. It does not use
your Git index, HEAD, stash, branches, or global Git configuration as scratch space.

## What You Can Do

- Review added, modified, deleted, and binary-changed files from the Activity Bar
- Open inline diffs against the real file on disk
- Accept or reject a whole file
- Accept, reject, or keep individual inline changes
- Bulk-accept everything except changes marked **Keep for Review**
- Keep Git staging free for commit shaping after the review is done

## Getting Started

1. Install **Inline Diff** from the VS Code Marketplace.
2. Open a workspace folder.
3. Open the **Inline Diff** view in the Activity Bar.
4. Click **Initialize Project**.
5. Let an AI agent, formatter, script, or editor tool change files.
6. Review the changes from the Inline Diff view.

Add a `.diffignore` file at the workspace root to hide generated files or local-only
paths from review. It affects Inline Diff only; it never changes Git ignore behavior.

## Requirements

- VS Code 1.80 or newer
- Git 2.32 or newer on `PATH`

## Safety

Reject writes baseline content back over the selected part of a file. If another
editor, formatter, build tool, or script is writing to the same file at the same time,
outside changes can be overwritten while reject is applied.

Only reject when nothing else is actively writing to the target file.

## Status

Inline Diff is an early `0.1.1` release. The core loop is covered by tests: scan,
open, accept, reject, and keep-for-review. Please report issues on
[GitHub](https://github.com/freeslur/inlinediff/issues).
