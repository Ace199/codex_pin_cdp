# Local Pin files

Chat Pin writes session Markdown snapshots into this directory as `pin_<session-id>.md`.

The launcher excludes those generated files through the local `.git/info/exclude` file rather than the repository `.gitignore`, so Codex can index and open them without committing conversation content.
