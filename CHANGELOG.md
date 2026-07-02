# Changelog

## 0.1.2

Fix the internal baseline repository growing without bound. Every Accept leaves the superseded baseline blob behind as unreachable garbage, and nothing ever reclaimed it: Git's own `gc --auto` is never triggered by the plumbing commands the extension uses, and it would keep young unreachable objects for weeks anyway. Each trusted project now reclaims this garbage once at activation, when nothing else is waiting on the repository.

## 0.1.1

Fix Marketplace README image URLs.

## 0.1.0

First public release.

- Inline Diff is an inline change-control layer before Git, not a replacement for Git diff.
- Project initialization with an extension-owned accepted baseline, fully isolated from your Git repository, index, and configuration.
- Activity Bar review of added, modified, deleted, and binary-modified files.
- File-level Accept and Reject actions.
- Hunk-level Accept and Reject actions in VS Code's inline diff editor.
- Keep for Review to park uncertain changes and bulk-accept the rest.
- Accept All and Reject All project actions with result summaries.
- Encoding-aware text handling, with binary and oversized files kept out of the text diff path.
- Dual-licensed under `MIT OR Apache-2.0`.
