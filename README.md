# Chat Pin for Codex Desktop

Chat Pin is a local UI injector for Codex Desktop on Windows and macOS. It does not modify the Codex installation package or read or copy cookies, login data, or chat databases.

For the design and implementation boundaries of Collection mode, see [`docs/COLLECTION_MODE_DESIGN.md`](docs/COLLECTION_MODE_DESIGN.md).

## Getting Started

```powershell
npm start
```

On Windows, you can also double-click `ChatGPT_Pin.cmd` in the project root or use the “Codex Chat Pin” shortcut installed on the desktop or Start menu. The startup script uses an ASCII-only filename and content to remain compatible with different Windows command-line code pages, and switches the console to UTF-8 before Node.js starts. The shortcut uses the official Codex app icon copied to `assets/codex.ico`. The shortcut still opens a terminal window; keep it running, and close it to stop the dedicated Pin instance. Collection progress is printed in this same terminal; the App Server protocol itself is not exposed as an interactive prompt.

The launcher opens a Codex window with an isolated profile stored inside the project and injects the UI through a private CDP pipe. The first time you use this isolated window, you may need to sign in manually. Keep the launcher window running; closing it stops the Codex window managed by the launcher.

The launcher locates the official app using the same desktop launch approach as Codex Taskboard. On Windows, it looks for `app\\ChatGPT.exe` inside the Microsoft Store package. On macOS, it searches `/Applications` and `~/Applications` for `ChatGPT.app` and `Codex.app`. It then passes the isolated profile and private CDP pipe arguments directly to the desktop app. `resources\\codex.exe` (or `Contents/Resources/codex` on macOS) is the CLI and is not used to launch the desktop UI.

Some Windows installations prevent Node.js from creating the desktop process inside WindowsApps and return `spawn EPERM`. When this happens, the launcher automatically activates the app through its registered Codex AUMID, passes the same isolated profile, and continues injection over a random `127.0.0.1` CDP WebSocket port. Use `--windows-activation` to test this path explicitly. This port has no additional authentication, so only trusted local programs should run while the launcher is active.

By default, the isolated profile is stored in `.codex-pin-profile` in the project. For testing or multiple instances, use `CODEX_PIN_PROFILE` to specify another directory.

Collection mode requires a separately installed, executable Codex CLI. Enabling the mode resolves the independent CLI path and persists the mode immediately; the launcher checks both `codex --version` and `codex app-server --help` when the first queued item starts. This prevents a cold App Server startup from blocking the UI. It does not treat the bundled CLI inside the Microsoft Store desktop package as usable when that executable returns `EPERM`. If the CLI is not in a standard location, set:

```powershell
$env:CODEX_PIN_CLI_PATH = "C:\path\to\codex.cmd"
npm start
```

On macOS, `CODEX_PIN_CLI_PATH` can likewise point to the `codex` executable. Chat Pin does not install or upgrade the CLI automatically or modify the system `PATH`.

Each Collection item snapshots the model and reasoning effort currently selected beside the Codex Desktop composer (for example, `5.6 Sol` and `high`) and passes that selection to the independent CLI. If the UI label cannot be recognized, Collection execution falls back to its automatic profile: `gpt-5.6-terra` with `medium` reasoning for routine archive work, or `gpt-5.6-sol` with `high` reasoning when deterministic checks identify security research, repository migration, redirects, or same-name conflicts. Explicit environment variables take precedence over the Desktop selection:

```powershell
$env:CODEX_PIN_COLLECTION_PROFILE = "routine" # routine, complex, or inherit
$env:CODEX_PIN_COLLECTION_MODEL = "gpt-5.6-terra"
$env:CODEX_PIN_COLLECTION_EFFORT = "medium"
$env:CODEX_PIN_COLLECTION_COMPACT_TOKENS = "100000" # 0 disables the launcher override
$env:CODEX_PIN_COLLECTION_COMPACT_SCOPE = "body_after_prefix" # or total
```

The default compaction threshold counts context growth after the stable carried prefix. Codex App Server performs compaction only after that growth crosses 100,000 tokens; Chat Pin does not add a separate summarization request before every collection item.

If the app is installed in a non-default location, specify it explicitly. On macOS, you can pass either the `.app` path or the internal executable; on Windows, pass the desktop `ChatGPT.exe`:

```powershell
node scripts/pin-launcher.mjs --launch --watch --app-path "C:\\path\\to\\ChatGPT.exe"
```

```bash
node scripts/pin-launcher.mjs --launch --watch --app-path "/custom/Codex.app"
```

You can also use the `CODEX_PIN_APP_PATH` environment variable. `explorer.exe shell:AppsFolder\\<AUMID>` works for a normal launch, but it cannot create the private CDP pipe required by this project and bind it to the current Node.js process, so it is not used as an injection launch path.

## Current Features

- Adds a Pin icon only to the action area of final assistant responses. It is not added to user messages or next to copy buttons in code blocks.
- Clicking Pin converts the entire assistant response to Markdown, saves it, and then opens it in Codex’s native **Open File** sidebar page.
- Adds **Open Pin File** to the bottom of both the sidebar entry menu when the sidebar is closed and the sidebar tab **+** menu. Selecting it opens the Markdown file for the current task directly.
- When Codex does not expose a stable accessible name for the top-right sidebar icon, the launcher uses the native sidebar keyboard shortcut to expand the right pane before continuing to open the file.
- Keeps the native file tab pinned at the top of the sidebar. Pinning the same conversation again reuses the tab with the same name whenever possible, avoiding duplicate tabs.
- Exact filename filtering selects the first native result first. The slower indexing compatibility flow runs only if the fast path fails. A success notification reports the time taken by the native open operation.
- Isolates Pins by conversation. The primary copy is stored as `pins/pin_<conversation-ID>.md` in this project. If a reliable conversation ID is unavailable, a stable route digest is used. Unpinning does not delete the corresponding file.
- When the current Codex task uses another local workspace, the launcher creates a same-named Pin mirror in that workspace’s `pins/` directory and opens the mirror through the native file filter. The current task workspace therefore does not have to be the Chat Pin project itself.
- Adds the primary copy and workspace mirror to each Git repository’s local `.git/info/exclude`, preventing Pin content from entering Git without modifying the target project’s `.gitignore`. The corresponding local exclusion rule is removed briefly while the file is opened natively and restored immediately afterward. A non-Git workspace has no local exclusion file, so the mirror remains as a normal file in its `pins/` directory. Legacy `temp/pin_*.md` files are migrated automatically.
- Converts headings, paragraphs, bold, italics, strikethrough, blockquotes, lists, code blocks, links, images, and tables to Markdown. Code blocks omit Codex toolbar labels such as “Plain text” and “Copy code” and preserve language identifiers such as Python and JavaScript where possible. Complex custom rendering may still fall back to plain text.
- Adds a **Revise** button to the left of **View Source** after opening the current task’s Pin Markdown file. When enabled, a persistent revision target appears above the input box. The input box contains only the user’s requested changes; when the user sends the request, the launcher appends the file-editing constraints so Codex edits the Pin file in the current workspace directly instead of extracting and overwriting Markdown from a response body.
- Before each revision request is sent, saves a local snapshot under `revision-history/` in the isolated profile. After the final assistant response completes, it compares file hashes. If the file changed, the workspace mirror is synchronized back to the primary Pin copy in this project. If it did not change, Chat Pin reports that clearly instead of treating an ordinary answer as a successful revision.
- Binds Revision mode only to the current task and current Pin file. Switching tasks disables it safely. Pinning a new response while a revision is active requires confirmation to avoid accidentally replacing the document being edited.
- Shows a temporary error notification if writing or native file opening fails, without obscuring or replacing the Codex chat UI.
- Does not inject a standalone Pin page. **Open Pin File** opens the native Markdown file page and does not create a custom page.
- Adds **Collect** to the left of **View Source** on every native Markdown file page. Pin file pages retain the order **Collect**, **Revise**, **View Source**. The file page where **Collect** is selected becomes the active collection rule directly; Pin files and ordinary open files behave the same, and switching the source does not require a second confirmation. While enabled, the file-page button prominently displays **Collecting**, and the same persistent green status bar above the chat input shows the current filename and queue status. Sending does not submit the message to the current Codex Desktop conversation. Instead, it adds a snapshot of the current rule file together with the current input to a local FIFO queue.
- While Collection mode is active, mouse input is captured by a separate transparent button positioned over the native send control, while the native control no longer receives pointer events. Keyboard and form submission are intercepted at the window capture phase. This prevents one input from being sent to both the collection CLI and the normal Desktop task.
- Creates a new thread with Codex App Server `thread/start` for every collection item. Items do not inherit the desktop task or the history of previous collection items. Codex system rules, account configuration, and workspace instructions still apply, so “no context” here means no prior conversation history.
- Treats the selected Markdown file as an executable collection workflow. Each CLI thread uses the active task workspace as its `cwd` and runs with `workspaceWrite`, restricted to that workspace. When the rules require source records, indexes, tags, or validation, Codex must inspect the existing project, write the actual files, and verify them instead of returning a proposed collection document. The rule file itself remains unchanged unless the current input explicitly asks to edit that rule.
- Preserves the rule Markdown and current input verbatim in the CLI prompt. Before starting the model turn, a deterministic preflight extracts URLs, dates, Markdown link labels, and GitHub repository slugs; searches the workspace for exact input URLs with bounded results; and checks GitHub repositories concurrently with `HEAD` requests. The resulting compact JSON is a lookup aid only and never replaces the original text.
- Instructs the collection thread to return only exact search matches, counts, and small relevant sections instead of complete file trees or large indexes. GitHub verification keeps only reachability, final URL, redirect, and status fields; detailed pages are reserved for ambiguous repositories. The local report shows preflight time, total time, first-tool time, first-write time, model profile, and any compaction count.
- Stores queue state and concise execution reports in the plugin's `.codex-pin-profile/collection-queue/`; it no longer creates `<workspace>/collections/collection_<conversation-ID>.md`. Existing legacy aggregate files are left untouched. Collection mode is persisted per task and restored after switching away and back. Completed items appear as explicitly local **Collection execution report** cards above that task's composer; these cards are operational reports, not native assistant messages, and do not enter the desktop task's model context. While an item is pending, the status bar identifies preparation/preflight, independent-turn startup, or **independent CLI execution** and shows elapsed time. The injected UI periodically reconciles this state with the launcher so a missed runtime event cannot leave a stale “running” display. The native Desktop send button is disabled and covered by the Collection submit control; DOM replacements are guarded immediately so the same input cannot race into both the independent CLI and the Desktop task. The report panel and each report preserve their own collapsed/expanded state across unrelated UI refreshes; the panel can also be hidden until the next completion or cleared independently. Clearing reports removes only completed local reports; it does not cancel pending work, close Collection mode, or undo workspace changes. Failed items can be retried. **Clear** in the Collection status bar removes the current queue records and reports but keeps Collection mode enabled.
- Prints bounded progress to the existing launcher terminal: rule file and workspace, preflight counts, selected model, App Server/thread/turn startup, sampled tool events, file-change paths, retry notices, context compaction, a 20-second heartbeat, and final success or failure. It never prints the full collection input or full model output. The CLI cannot be used as a human interactive prompt in that terminal because stdin/stdout carry App Server JSONL messages.
- Pending items created by a pre-0.9.0 read-only queue are not silently upgraded to write access. After restart they are marked failed with a confirmation message and run only if the user explicitly selects **Retry**.
- Continues waiting for automatic reconnection and transport fallback when Codex CLI reports `willRetry: true`. A collection item is marked as failed only after a non-retryable error, a final failure status, or the overall timeout.
- Checks collection capabilities reported by the launcher. If the injection script hot-reloads while the launcher is still an older process, unavailable actions are hidden and the UI asks for a full `ChatGPT_Pin.cmd` and dedicated Codex restart instead of sending an unknown operation.
- Makes Collection and Revision modes mutually exclusive. A missing independent CLI path prevents Collection mode from opening. If the resolved CLI cannot start or does not support `app-server`, the queued item is marked failed with a retryable error; it is never forwarded to the normal Desktop conversation, and Revision mode remains unaffected.

## Current Limitations

- Each Codex conversation supports only one active Pin. Multiple Pins or tabs within one conversation are not yet supported.
- Responses and send controls are identified through accessible names and DOM structure. Selector updates may be required after Codex UI changes.
- This version does not implement inline marking, context menus, quote chips, exact backlinks to the original response, diff previews, or one-click restore.
- A workspace mirror synchronizes back to the primary copy only when a revision transaction completes or Revision mode is disabled. Manual edits made on the native file page while Revision mode is disabled are not synchronized automatically.
- Revision mode depends on Codex actually editing the file and does not bypass Codex permission prompts. If the model only explains what to do without changing the target file, Chat Pin reports that the file did not change.
- Collection mode uses a single-concurrency queue. Disabling the mode stops accepting new requests but lets queued tasks continue. Clearing the queue immediately discards all queue records and asks App Server to interrupt the active turn, so a hidden cleared task does not keep the queue occupied. Generation checks still prevent any late completion from being recorded as a current execution report. Files already changed before cancellation cannot be rolled back automatically.
- While Collection mode is enabled, Chat Pin takes over pointer events on the native send button. It synchronously clears the input before adding the item to the separate queue. If enqueueing fails, it restores the content after the original event chain completes, and only if the input remains empty. The status bar reports the number of historical failures separately; **Queue idle** means only that no item is currently queued or running.
- Collection items use a non-interactive approval policy and a `workspaceWrite` sandbox whose writable root is the active task workspace. This authorizes in-scope project edits required by the selected rules, but not writes outside the workspace, destructive operations, or external side effects. Managed Codex policies can still reject a command or network request.
- Ordinary Markdown rule files are resolved by the current task workspace and active filename. If multiple Markdown files with the same name exist in one workspace, Chat Pin refuses to enable collection and reports the ambiguity instead of guessing.
- Deterministic URL lookup scans only common text formats, at most 4,000 files and 24 MiB per item, and reports when it was truncated. GitHub reachability is unauthenticated and cannot distinguish a missing repository from a private repository; those results are marked `not-found-or-private`. Tool-output limits beyond the deterministic preflight are prompt constraints enforced by the model, not a hard App Server byte cap.
- Native file opening depends on the sidebar menu, file filter, and result-row layout of the current Codex version. It must be revalidated after major Codex updates.
