# Pi 1.3.0 native tool rendering: evidence and extension integration contract

## Scope and source identity

This is source research, not an implementation or an SSH behavior review. It examines Pi's installed primary documentation, declarations, examples, and JavaScript. Repository HEAD at inspection was `744c374`. Existing uncommitted SSH menu changes were not edited. No sessions, credentials, remote hosts, network services, installations, or child agents were used.

Source-path abbreviations in citations below are exact filesystem roots:

- **P** = `/mnt/d/Temp/pi-mono/node_modules/@earendil-works/pi-coding-agent`
- **G** = `/home/klein/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent`
- **A** = `/mnt/d/Temp/pi-mono/node_modules/@earendil-works/pi-agent-core`
- **T** = `/mnt/d/Temp/pi-mono/node_modules/@earendil-works/pi-tui`

Both Pi package manifests report **1.3.0** (`P/package.json:1-4`, `G/package.json:1-4`). Pi declares agent-core and TUI dependencies at 1.3.0 (`P/package.json:38-44`). The global and repository copies of `docs/extensions.md`, `docs/tui.md`, `dist/core/tools/bash.js`, and `dist/modes/interactive/components/tool-execution.js` were byte-compared and are identical. Citations use installed `dist/*.js` line numbers, **not** guessed upstream TypeScript line numbers. The inspected bash source map contains `sourcesContent` and identifies `../../../src/core/tools/bash.ts`; extracting that source is unnecessary for the findings here.

Read completely before conclusions: `G/docs/extensions.md`, `G/docs/tui.md`; the relevant linked `P/docs/themes.md`, `keybindings.md`, `packages.md`, `settings.md`, `configuration.md`, and `terminal-setup.md`; and `P/examples/extensions/hello.ts`, `todo.ts`, `truncated-tool.ts`, `dynamic-tools.ts`, `ssh.ts`, and `tool-override.ts`. No web evidence was needed. Examples are integration illustrations, not stronger evidence than the installed runtime.

## Executive finding

**A registered `ssh_*` tool already gets the host's themed pending/success/error frame, streaming-result replacement, and global expansion action when it uses the default rendering shell. It does not automatically get bash's `$ command` header, timeout annotation, five-line tail preview, exit-status text, or visible `Elapsed`/`Took` line.** Pi records execution duration generically, but a renderer must display it.

The requested example—`$ ... (timeout 45s)`, output, `Command exited with code 124`, and `Took 40.1s`—matches the **model-callable bash tool**, not the user's `!command` UI. These are distinct components and execution paths. Copying `BashExecutionComponent` would copy the wrong presentation.

| Behavior | Generic host / registered tool without custom renderers | Native model-callable bash | Extension implication |
|---|---|---|---|
| Pending, success, error background | Yes, default shell | Same host shell | Keep default shell; report actual errors correctly. |
| Tool-call header | Tool name and argument summary | `$ command` and optional timeout | Add/adapt `renderCall` for shell-like presentation. |
| Streaming output | Host replaces the current partial result | Bash sends bounded cumulative snapshots | Emit snapshots, not raw output deltas. |
| Result preview | First 10 logical lines | Last 5 **visual** lines | Custom/reused result renderer needed for bash parity. |
| Ctrl+O | Host toggles `expanded`; fallback honors it | Renderer honors it | Do not register a competing shortcut. |
| Duration measurement | `durationMs` recorded for executed calls | Same measurement | Available to custom renderers as final context metadata. |
| Visible elapsed / Took | **No** in generic fallback | Renderer-owned live clock and final duration | Reuse/adapt renderer or display context duration yourself. |
| Exit status | No interpretation of arbitrary result text/details | Executor appends nonzero status text and sets `isError` | Executor/result contract, not frame behavior. |
| Full-output log / truncation | Not automatically created | Executor/accumulator create it | Extension must provide bounded output and any retrieval path. |

Evidence: `P/dist/modes/interactive/components/tool-execution.js:74-110,134-142,199-264`; `P/dist/core/tools/render-utils.js:75-148`; `P/dist/core/tools/renderers/bash.js:14-85`; `P/dist/core/tools/bash.js:175-323`; `A/dist/agent-loop.js:568-593,647-669`.

## 1. Two different shell UIs

### Model-callable `bash`

`createBashToolDefinition()` returns an executable tool definition with shell renderers spread into it. `createShellRenderers("$")` creates the header and result components. The interactive host puts these components inside `ToolExecutionComponent`'s standard colored box. Sources: `P/dist/core/tools/bash.js:158-174,309-332`; `P/dist/core/tools/renderers/bash.js:16-21,72-87`; `P/dist/modes/interactive/components/tool-execution.js:35-60,199-264`.

The header uses `toolTitle` and bold for `$ command`, `muted` for ` (timeout Ns)`, an ellipsis for an empty command, and an invalid-argument marker for non-string input. It does not itself enforce the timeout. Command wrapping is handled by the returned `Text` component. Source: `P/dist/core/tools/renderers/bash.js:16-21,74-78`.

### User-entered `!command` and `!!command`

The interactive mode emits `user_bash`, optionally accepts extension-provided operations or a complete result, and creates a **`BashExecutionComponent`**. Normal execution forwards output **chunks** to `appendOutput()`. Session storage uses `role: "bashExecution"`, not `toolResult`. Sources: `P/dist/modes/interactive/interactive-mode.js:5870-5939`; `P/dist/core/agent-session.js:3121-3176`.

This component has `bashMode` borders/title (`dim` for `!!`, whose output is excluded from model context), a `Running...` loader, muted output, a 20-line preview, `(cancelled)` or `(exit N)`, and truncation warnings. It does **not** contain the model-tool timer or use pending/success/error tool-box backgrounds. Its `setComplete()` treats an undefined/null exit code differently from the model bash executor, so it is not a suitable status-semantics template either. Sources: `P/dist/modes/interactive/components/bash-execution.js:12-42,60-90,93-177`.

`recordBashResult()` stores command, output, exit code, cancelled/truncated flags, path, timestamp, and context-exclusion flag, but no `durationMs`. Source: `P/dist/core/agent-session.js:3154-3176`. These differences explain why searching for “bash execution” alone can lead to the wrong implementation.

## 2. What the host provides to every registered tool

### Framing and error colors

`ToolExecutionComponent` starts partial, creates a `Box` with `toolPendingBg`, and selects the final background from the final `isError`: `toolErrorBg` or `toolSuccessBg`. The host manages horizontal `outputPad`. Custom call/result renderers do not have to repaint the outer background. Selecting `renderShell: "self"` opts out of that standard box and makes the renderer responsible for framing/padding. Sources: `P/dist/modes/interactive/components/tool-execution.js:23-28,45-60,72-74,163-198,199-213`; `P/dist/core/extensions/types.d.ts:468-469`.

Do **not** encode “running = gray, completed = blue” as RGB values. The contract is semantic theme tokens. In this installation the dark and light themes use distinct pending/success/error OKHSL values; success is not specified as blue. The system theme assigns pending to neutral, success to green, error to red, and derives actual colors from the terminal. It can fall back to panels without a background when terminal colors are unavailable. Sources: `P/dist/modes/interactive/theme/dark.json:37-41`; `light.json:37-41`; `system-theme.js:44-46`; `P/docs/themes.md:5-24,105-119`.

Theme changes invalidate the UI, and the tool component's `invalidate()` rebuilds its display. Theme-dependent strings must be rebuilt rather than retained indefinitely in application state. Sources: `P/dist/modes/interactive/interactive-mode.js:791-794`; `P/dist/modes/interactive/components/tool-execution.js:155-158`; `P/docs/tui.md:78-104`.

### Fallback rendering is not bash rendering

For a registered definition lacking callbacks, the host draws a generic name/argument header and the first 10 logical output lines, with an expansion hint when more remain. The generic header collapses arguments to a 100-character `key=value` summary; expanded mode lists argument values underneath. The fallback has **no timer footer**. Sources: `P/dist/modes/interactive/components/tool-execution.js:6,95-110,215-255`; `P/dist/core/tools/render-utils.js:75-100`.

There is a separate, less capable fallback when **no renderer definition exists at all**: it shows the name, JSON arguments, and text output. That branch does not implement the registered-definition preview/expanded selection. This matters when resuming with an extension unavailable; do not promise full expansion parity for orphaned tool names. Source: `P/dist/modes/interactive/components/tool-execution.js:69-71,258-263,308-323`.

Built-in renderer inheritance is an exact-name lookup (`bash`, `read`, etc.), not a tool-name suffix convention. `ssh_bash` or `ssh_exec` does not inherit bash renderers merely by having a command parameter. Sources: `P/dist/core/tools/renderers/index.js:17-45`; `P/dist/modes/interactive/interactive-mode.js:1701-1706`.

### Global expansion

`app.tools.expand` defaults to `ctrl+o`. The editor registers it to `toggleToolOutputExpansion()`, which changes an in-memory global flag and calls `setExpanded()` on expandable transcript components. New tool rows receive the same flag. Custom renderers receive the current `expanded` value, but must actually use it to reveal more content. Sources: `P/dist/core/keybindings.js:37`; `P/dist/modes/interactive/interactive-mode.js:291,2460,2852-2859,3736-3754`; `P/dist/modes/interactive/components/tool-execution.js:139-142,244-245`.

Use the exported `keyHint("app.tools.expand", ...)` / `keyText(...)` helpers instead of a hardcoded Ctrl+O hint: keybindings can be replaced or disabled and `/reload` applies changes. Sources: `P/dist/modes/interactive/components/keybinding-hints.js:24-32`; `P/dist/index.d.ts:37`; `P/docs/keybindings.md:7-30,163-172`.

A result-bearing tool row also wraps its components in a mouse region that toggles that row on left click. Mouse routing is a fullscreen feature, not a replacement for keyboard expansion. Sources: `P/dist/modes/interactive/components/tool-execution.js:112-119`; `P/docs/tui.md:56-62`.

## 3. Renderer API, result channels, and public export boundaries

### Callback contract

The installed declarations define:

- `renderCall(args, theme, context) -> Component`
- `renderResult(result, { expanded, isPartial }, theme, context) -> Component`
- `renderShell?: "default" | "self"`

The context contains `args`, `toolCallId`, `invalidate`, `lastComponent`, per-row shared `state`, `cwd`, `executionStarted`, `argsComplete`, `isPartial`, `expanded`, `showImages`, `isError`, `durationMs`, and `outputPad`. `lastComponent` is separate for call and result render slots; `state` is shared between the two. The host catches callback errors and falls back to generic rendering. Sources: `P/dist/core/extensions/types.d.ts:340-379,468-469,513-526`; `P/dist/modes/interactive/components/tool-execution.js:11-15,75-93,215-255`.

Arguments can be incomplete while the model streams its tool call. The host updates arguments before execution, then marks argument completion and execution start separately. Renderers should tolerate missing/malformed fields and avoid side effects. Sources: `P/dist/modes/interactive/interactive-mode.js:2844-2870,2901-2905,2917-2935`; `P/dist/core/tools/renderers/bash.js:16-21`.

The **interactive host passes only `{ content, details }` as the first `renderResult` argument**. Despite the broad `AgentToolResult` callback type, `structuredContent`, top-level `isError`, usage, and duration are not passed in that argument. Read error/duration from **context**, and keep reconstructible display metadata in **details**. Source: `P/dist/modes/interactive/components/tool-execution.js:75-93,244-245`.

### Content versus details versus structuredContent

- **`content`**: text/image blocks sent to the model; also the default human-visible output. Do not add purely decorative TUI timing text here merely to make a timer appear.
- **`details`**: structured tool/UI metadata, persisted with the final tool-result message; supply `undefined` when absent. This is the appropriate channel for display metadata that must survive replay.
- **`structuredContent`**: machine-readable data matching `outputSchema`, consumed by programmatic callers such as codemode. It is not model-facing text and is not an automatic rendering or persistence channel.
- **`isError: true`**: supported returned failure that preserves details and structured content. Throwing also fails the tool, but the core constructs a new error result with text and empty details.

Sources: `P/docs/extensions.md:133-151,225-238`; `A/dist/types.d.ts:369-407`; `A/dist/agent-loop.js:568-593,601-645,657-669`.

The final transcript message explicitly copies content, details, usage, isError, and duration, **not structuredContent**. Thus a status kept only in structuredContent cannot be relied on after reload. A result hook replacing `content` without replacing `structuredContent` drops the latter, to avoid stale or unredacted data. Sources: `A/dist/agent-loop.js:611-625,657-669`; `P/docs/extensions.md:149`.

### Safe public APIs in 1.3.0

The package export map exposes the root and `./rpc-entry`, not arbitrary `dist/...` subpaths (`P/package.json:11-23`). Inspection of internal files is evidence, not permission to import them in an extension.

Public root exports relevant here:

| API | Evidence / qualification |
|---|---|
| `ToolDefinition`, `ToolRenderers`, `ToolRendererResolver`, `ToolRenderResultOptions`, `AgentToolResult`, `AgentToolUpdateCallback` | `P/dist/index.d.ts:8` |
| `defineTool`, `ExtensionAPI.registerTool()` and `registerToolRenderer()` | `P/dist/index.d.ts:8-9`; `P/dist/core/extensions/types.d.ts:1256` |
| `createBashToolDefinition`, `BashOperations`, `BashToolDetails`, `BashToolOptions` | `P/dist/index.d.ts:26`; runtime factory export in `P/dist/index.js:30` |
| `createBashTool` | `P/dist/index.d.ts:20`; **AgentTool wrapper, not renderer-bearing definition** |
| `DEFAULT_MAX_LINES`, `DEFAULT_MAX_BYTES`, `truncateHead`, `truncateTail`, `formatSize` | `P/dist/index.d.ts:26` |
| `keyHint`, `keyText`, `truncateToVisualLines` | `P/dist/index.d.ts:37`; runtime exports in `P/dist/index.js:43` |
| `Theme` and semantic theme types | `P/dist/index.d.ts:38` |
| `Text`, `Container`, `Spacer`, `Component`, width/wrapping utilities | `T/dist/index.d.ts:16-17,32,35` |

**Not root-exported:** `createShellRenderers`, `startToolTimer`, `toolTimerText`, `formatToolDuration`, `OutputAccumulator`, and `VisualLinePreview`. `ToolRenderContext` is declared internally but is also **not** in the root export list in 1.3.0. Use contextual inference from `ToolDefinition`/`defineTool`, or derive callback parameter types from exported definitions, rather than deep-importing it. The root exposes `truncateToVisualLines`, not `VisualLinePreview`. Evidence: complete export lists `P/dist/index.d.ts:1-45`, `P/dist/index.js:1-50`, and `P/dist/core/extensions/types.d.ts:347-379`.

`ToolExecutionComponent` and `BashExecutionComponent` happen to be public exports, but an ordinary tool renderer should return its inner components rather than instantiate a second transcript/execution shell. The documented integration point is the tool renderer; there is no need for a second TUI. Sources: `P/dist/index.d.ts:37`; `P/docs/tui.md:7-18`.

### Public route to native bash presentation

`createBashToolDefinition(cwd, options)` returns a `ToolDefinition` containing the native call/result renderers. Its operations seam can delegate execution, or its callbacks can be adapted for a separately registered command tool. In contrast, `createBashTool()` calls `wrapToolDefinition()`, which deliberately copies execution/schema fields but omits render callbacks. Spreading that AgentTool and renaming it to `ssh_exec` does **not** preserve bash presentation. Sources: `P/dist/core/tools/bash.js:309-332`; `P/dist/core/tools/bash.d.ts:96-98`; `P/dist/core/tools/tool-definition-wrapper.js:1-13`.

The bundled SSH example spreads `createBashTool()` and retains the name `bash`; exact-name host fallback supplies its renderer. It is not evidence that arbitrary SSH-prefixed tools inherit it. The example also intercepts `user_bash` separately, reinforcing the two-path distinction. Sources: `P/examples/extensions/ssh.ts:117-123,170-183,202-207`; `P/dist/core/tools/renderers/index.js:17-45`.

A renderer resolver can handle restored calls even before a tool is registered. Resolvers run in extension load order; `next()` delegates to subsequent resolvers and finally the tool's rendering definition. Normal registration is enough when the extension's tools are already available. Sources: `P/docs/extensions.md:191-193`; `P/dist/core/extensions/runner.js:541-547`.

## 4. Streaming means replacement snapshots, not append deltas

The model-tool pipeline is:

1. Executor calls `onUpdate(partialResult)`.
2. Agent core emits `tool_execution_update` containing that partial result.
3. Interactive mode calls `component.updateResult({ ...partialResult, isError: false }, true)`.
4. `updateResult()` **replaces** `this.result` and rebuilds the display.
5. `tool_execution_end` supplies the authoritative final result, error flag, and duration.

Sources: `A/dist/agent-loop.js:541-548,568-582,647-655`; `P/dist/modes/interactive/interactive-mode.js:2936-2953`; `P/dist/modes/interactive/components/tool-execution.js:134-138`.

Therefore each update should contain a **complete current display snapshot** (possibly a bounded tail), including any metadata still needed. Sending only the latest SSH chunk makes earlier output disappear; the host does not concatenate it. Likewise details are not merged across updates. Avoid mutating a previously emitted snapshot in place. This differs from the `!shell` path, whose `appendOutput(chunk)` explicitly concatenates chunks (`P/dist/modes/interactive/components/bash-execution.js:60-77`).

Native bash accumulates bytes with a streaming UTF-8 decoder, sends an initial empty update, emits cumulative bounded snapshots, throttles updates to 100 ms, and flushes a final update before completion. The initial update lets `renderResult` start displaying elapsed time even when the command produces no output. Sources: `P/dist/core/tools/bash.js:175-237`; `P/dist/core/tools/renderers/bash.js:14-15,80-85`; `P/dist/core/tools/output-accumulator.js:19,39-89`.

The agent's callback stops accepting updates after the execute promise settles. It waits for already-issued update event promises before finishing the outcome. Still, the executor should stop its own producers/timers/listeners on completion, abort, and failure; ignoring late UI updates does not clean up remote work. Sources: `A/dist/agent-loop.js:568-597`; `A/dist/types.d.ts:401-407`; `P/docs/extensions.md:261-267`.

Partial updates are displayed as pending, even if they contain `isError: true`, because interactive mode overrides their flag to false. The final result determines success/error framing. Source: `P/dist/modes/interactive/interactive-mode.js:2936-2950`.

## 5. Duration: collection is generic, presentation is not

Agent core measures `execute()` with `performance.now()`, rounds to milliseconds, and stores `durationMs` for both returned and thrown outcomes. It excludes preparation/validation and before/after hooks; confirmation performed **inside** execute is part of execute duration. A call blocked or rejected before execute has no measured duration. Sources: `A/dist/agent-loop.js:375-399,482-539,568-593,599-638`.

The end event and final `toolResult` message both carry duration. `AgentSession` persists finalized messages, and `SessionManager` serializes the whole message into JSONL. Sources: `A/dist/agent-loop.js:647-669`; `P/dist/core/agent-session.js:752-769`; `P/dist/core/session-manager.js:794-838`.

For native bash's UI:

- `renderCall` starts row-local timing once `context.executionStarted` is true.
- `renderResult` asks for timer text. During partial output it starts a one-second invalidation interval and displays `Elapsed ...`.
- Final rendering stops the interval and prefers `context.durationMs` over its own clock.
- Without recorded duration it can fall back to row-local start/end timestamps; without either duration or a start timestamp it emits no time.
- Formatting is one decimal second below a minute, then minutes/seconds, then hours/minutes/seconds.

Sources: `P/dist/core/tools/renderers/bash.js:69-85`; `P/dist/core/tools/render-utils.js:101-148`.

The live clock and final measurement are **not exactly the same boundary**. A `tool_execution_start` event is emitted before preparation; the UI sets `executionStarted` from that event. Consequently live elapsed time can include validation/approval/queueing that final execute duration excludes. Do not silently redefine remote-process duration to mean host-tool duration. Sources: `A/dist/agent-loop.js:375-399,411-450`; `P/dist/modes/interactive/interactive-mode.js:2917-2933`; `P/dist/core/tools/render-utils.js:114-148`.

Native bash also returns `structuredContent.wall_time_seconds`, measured inside its own executor and rounded to tenths. That is a different channel and measurement from the host `durationMs` used by the final TUI timer. Source: `P/dist/core/tools/bash.js:255-303`.

**Practical consequence:** merely adding a `duration` key to details or returning structured wall time does not cause `Took` to appear. Keep timing UI-only and read the host's recorded duration unless a separately labeled remote-runtime metric is explicitly required.

## 6. Native exit status, failure, timeout, and cancellation

The shell output schema contains `output`, `truncated`, optional `full_output_path`, `exit_code`, and `wall_time_seconds`. `BashToolDetails` contains truncation metadata and full-output path, **not exit status**. Sources: `P/dist/core/tools/bash.js:40-46`; `P/dist/core/tools/bash.d.ts:19-30`.

Native command outcomes:

| Outcome | Native model bash result |
|---|---|
| Exit 0 | Returns output, or `(no output)`. No explicit `Command exited with code 0` line. |
| Nonzero numeric exit | Appends `Command exited with code N`; returns `isError: true`, retaining details and structured content. |
| Operations return `null` exit | Throws `Command terminated without an exit code`, including accumulated output. |
| Operations throw `Error("aborted")` | Flushes output and throws text ending `Command aborted`. |
| Operations throw `Error("timeout:N")` | Flushes output and throws text ending `Command timed out after N seconds`. |
| Other backend failure | Flushes/finishes output, then rethrows the error; not every generic backend failure includes accumulated output in the final error text. |

Evidence: `P/dist/core/tools/bash.js:239-323`; `A/dist/agent-loop.js:584-593,640-645`.

The **renderer does not invent exit status**; it renders the content text. A nonzero result is an error-colored tool row because the executor/core error flag says so, not because the UI scans `Command exited...`. Returning text such as `Error: ...` or a details error field without `isError` still counts as a successful return. Sources: `P/dist/core/tools/renderers/bash.js:23-51`; `A/dist/agent-loop.js:579-582`; `P/docs/extensions.md:139-145`.

The local backend validates positive finite timeouts, enforces the timer limit, kills a process tree on abort/timeout, and converts a signal-terminated local process to `128 + signal number` (or a failure fallback), so it does not accidentally report success. These guarantees belong to that backend, **not** to arbitrary remote operations. The public operations type permits `number | null` and documents null as failure. Sources: `P/dist/core/tools/bash.js:12-26,48-123`; `P/dist/core/tools/bash.d.ts:32-51`.

For the user's example, the command itself runs external `timeout 40s`, which can return status 124 before Pi's own 45-second timeout. That is the **numeric nonzero-exit branch**, not Pi's `timeout:45` exception branch. This is a semantic explanation of the example, not a command executed in this research.

An SSH connection close, cancellation request, or transport error does not establish a remote exit code. Preserve “unknown” as unknown; do not fabricate zero. Whether an SSH-specific outcome is a tool error, warning, cancellation, or partial completion is a product/execution contract outside this native-UI research. In particular, closing local transport is not evidence the remote process stopped.

## 7. Three separate output limits

### Model-facing data limit

Native bash's output is limited to the last **2,000 lines or 50 KiB**, whichever is reached first. `OutputAccumulator` keeps a bounded decoded tail, counts the complete stream, and spills raw output to a file once limits require it. `snapshot({ persistIfTruncated: true })` returns tail content plus full-stream truncation metadata and path. Sources: `P/dist/core/tools/truncate.js:10-11,123-125`; `P/dist/core/tools/output-accumulator.js:7-12,33-89,148-213`; `P/dist/core/tools/bash.js:165,183-194`.

### Human collapsed preview

Bash's renderer trims output text, styles it with `toolOutput`, and shows the last **five visual lines** when collapsed, not five newline-delimited records. Expanded mode displays all **retained result content**, not the saved full log. The preview helper renders at the available width and caches by width, with an expand hint for hidden lines. Sources: `P/dist/core/tools/renderers/bash.js:14,23-51`; `P/dist/modes/interactive/components/visual-truncate.js:19-31,33-65`.

Truncation/path warnings are rendered outside that preview, followed by the timer. The renderer may remove a final textual truncation footer when it can replace it from details. Its removal requires the output to end with `]`; if a nonzero status was appended after the footer, that condition need not hold. Do not assume every native error output deduplicates every warning. Source: `P/dist/core/tools/renderers/bash.js:25-32,53-70`.

### Programmatic output limit and saved file

Native `structuredContent.output` can contain up to a 1 MiB byte budget from the complete output; beyond it the accumulator keeps head and tail around an omission marker. This differs from the 50 KiB model-facing tail. The structured `full_output_path` is added when that structured output is itself truncated. Sources: `P/dist/core/tools/bash.js:13-14,284-303`; `P/dist/core/tools/output-accumulator.js:111-146`.

Saved logs are local OS-temp files using random names, exclusive creation, and mode `0600`; the accumulator flushes before completing. They are not session-embedded durable archives. Expansion does not read them; a separate tool must retrieve them, and files may no longer exist later. Sources: `P/dist/utils/output-files.js:1-29`; `P/dist/core/tools/output-accumulator.js:90-109,201-213`; `P/dist/core/tools/bash.js:224-231`.

Native display extraction strips ANSI sequences, sanitizes binary output, and removes carriage returns before styling. It is not simply rendering remote terminal escape sequences verbatim. Source: `P/dist/core/tools/render-utils.js:56-73`.

For custom tools, the host does not automatically impose these executor limits or create logs. The official truncated-tool example explicitly performs truncation, saves complete output, returns details, and adds a model-facing retrieval notice. Its result renderer is illustrative, not native bash parity. Sources: `P/examples/extensions/truncated-tool.ts:1-14,91-138,141-194`; `P/docs/extensions.md:141-143`.

## 8. Replay, reload, nesting, and non-TUI limitations

### Interactive persistence/reload

The session rebuild creates tool rows from assistant tool calls, supplies current renderer definitions, applies the current global expansion flag, then matches stored tool results by ID. Final `details`, `isError`, and `durationMs` therefore survive ordinary interactive reload/resume when those fields were recorded. Live partial snapshots, renderer `state`, component instances, and timer intervals are not the persisted display contract. Sources: `P/dist/modes/interactive/interactive-mode.js:3230-3314`; `A/dist/agent-loop.js:657-669`.

`/reload` refuses while streaming or compacting, reloads extensions, rebuilds chat, and reloads keybindings. The global expansion flag remains on that interactive-mode instance, whereas a fresh process initializes it to false. Per-row mouse expansion is component-local and is lost on reconstruction in favor of the global flag. Sources: `P/dist/modes/interactive/interactive-mode.js:291,3736-3754,5370-5416`; `P/dist/modes/interactive/components/tool-execution.js:23,112-119,139-142`.

Historical results lacking duration cannot recover actual elapsed time from timestamps alone. Rebuilt rows do not receive a real execution-start event; the native timer correctly has no reliable start clock for those old rows. Source: `P/dist/core/tools/render-utils.js:114-148`; `P/dist/modes/interactive/interactive-mode.js:3261-3305`.

### Nested tool calls

Nested calls carry `parentToolCallId`; the interactive handler does not create an independent row for nested starts. Their presentation is owned by the parent tool. Thus an SSH tool invoked through codemode may not display its own normal standalone renderer. Source: `P/dist/modes/interactive/interactive-mode.js:2917-2921`; `P/docs/extensions.md:149`.

### HTML export caveat in this installed version

Documentation says tool renderers also participate in HTML exports. However the HTML renderer constructs context with `executionStarted: true`, a no-op invalidator, and **`durationMs: undefined`**; its result method accepts content/details/error, not recorded duration. It renders collapsed and expanded variants. Sources: `P/docs/extensions.md:191-193`; `P/dist/core/export-html/tool-renderer.js:27-57,60-104`; `P/dist/core/export-html/index.js:133-146`.

Consequently the native timer fallback can time construction of an export row rather than actual execution when used there. Do not claim accurate persisted `Took` parity in HTML based on TUI behavior alone. An extension relying only on `context.durationMs` should omit unavailable duration rather than manufacture one. Any separate persisted duration field or HTML-specific accommodation requires an explicit later design decision; none is implemented here.

### Other modes

The renderer contract is interactive/HTML presentation. JSON, print, and RPC callers still need meaningful content and results without a terminal. `ctx.ui.custom()` is not a way to render a normal tool transcript across all modes; supported RPC dialogs differ from custom terminal components. Sources: `P/docs/extensions.md:245-255`; `P/docs/tui.md:7-18`.

## 9. Recommended minimal integration contract (no implementation)

1. **Keep the existing execution/authorization policies separate from rendering.** Do not rename tools to `bash`, replace authorization, or intercept `user_bash` merely to achieve the visual request. Different SSH operations may need different headers; this research does not decide which must look like commands.
2. **Use a registered ToolDefinition with default render shell.** Let Pi own pending/success/error backgrounds, output padding, redraw scheduling, image display, and global expansion. Do not hardcode gray/blue or wrap an entire `ToolExecutionComponent` inside another one.
3. **For command-like tools, choose either public native callbacks or small extension callbacks.** `createBashToolDefinition()` is the public route to native bash callbacks. Adapt arguments/details to the shell renderer contract without accidentally replacing the SSH executor or schema. Preserve native call-renderer timing initialization if reusing its result timer. Do not import internal timer or renderer modules. Other tools can use custom headers/results through `ToolDefinition` inference.
4. **Emit bounded cumulative snapshots through onUpdate.** Send an initial empty/progress snapshot if idle streaming needs a visible running timer; include current details each time. Flush a final authoritative result and stop producers/listeners on completion or cancellation.
5. **Make final outcomes explicit.** Human-readable nonzero/error status belongs in content or renderer-consumed details; the final error flag belongs in `isError` or a thrown failure. Preserve unknown exit status. A renderer cannot infer remote termination from a transport event.
6. **Use host `context.durationMs` for the final Took line.** Omit unavailable measurements. If live elapsed time is required, prefer the native callback lifecycle or carefully scoped per-row state/invalidation; do not put decorative timer ticks in model-facing content. Remote-process time, if requested separately, needs its own labeled contract.
7. **Honor expanded/isPartial and theme changes.** Use current semantic tokens, width-safe TUI components, a compact tail preview for command output, and a keybinding-aware expansion hint. Expansion reveals retained data, not data already truncated away.
8. **Persist display facts in final details, not renderer state or structuredContent alone.** Keep details compatible with older sessions and missing fields. Keep outputSchema/structuredContent for programmatic callers if needed, independently of human presentation.
9. **Decide log location/retention/redaction in the execution layer, not in a UI patch.** Native local temp logs demonstrate the pattern, but remote/local retrieval and sensitive-output handling must follow the SSH extension's actual requirements. No new product policy is selected here.
10. **Validate later against the correct baseline.** Compare actual tool-call bash and the SSH command renderer in the same Pi/theme, with silent streaming, split UTF-8, long wrapped lines, numeric nonzero exit, timeout, cancellation/unknown status, theme change, Ctrl+O remapping, reload, and legacy results. HTML and nested-codemode presentation require separate checks.

## 10. Parent verification: current SSH integration gaps

The parent inspected `packages/pi-remote-ssh/src/tools.ts` (`executeTool`, `toolResult`, `registerTools`) and `src/transport.ts` (`ExecOptions`, `Output`, `Connection.exec`) after the native research completed.

- `registerTools` registers ten tools without `renderCall`, `renderResult`, or a self-rendered shell. They therefore use the normal registered-tool fallback, including theme backgrounds and expansion. Final `toolResult` sets `isError` from `value.ok === false`, so error framing already has an explicit source.
- `toolResult` currently exposes JSON text with structured `details`. A custom renderer can provide readable presentation without changing the existing model-facing JSON contract. Very large results become a bounded JSON preview; a UI cannot recover fields discarded by this final truncation step.
- `registerTools` forwards transfer byte progress through `onUpdate`, but `ssh_shell_exec` supplies no output callback to `connection.exec`. `ExecOptions` has no streaming callback. Remote stdout/stderr chunks are collected internally and returned only when the command settles. This requires an execution-to-UI bridge, not merely a renderer change.
- `Connection.exec` retains separate stdout and stderr prefixes (128 KiB each by default), rather than native bash's bounded tail plus full temporary log. It does not preserve a merged chronological display stream or save the discarded bytes. Native-like merged streaming and complete-log retention are separate changes requiring explicit choices.
- `Output.text()` calls `StringDecoder.end()` when not truncated. It is a finalization method, not a safe incremental snapshot API: a streaming implementation must not call it on every chunk, especially across split UTF-8 characters.
- Sudo stderr passes through `SudoExchange` before the `output` callback reaches the accumulator. Any UI stream must use that filtered callback, never raw sudo stderr, so authentication markers and prompts do not become display output.
- `ssh_shell_exec` already reports `exitCode`, `outcome`, `timedOut`, `cancelled`, and optional elevation/signal metadata, and only reports `ok: true` for exit zero with a known exited outcome and no timeout/cancellation. Renderers should preserve those distinctions and never invent an exit code on lost connections.
- Upload/download can keep their existing byte-progress semantics. File reads/searches and host management tools need operation-specific headers/results, not fictitious shell commands or exit codes.

These observations are static source verification. Source symbols are cited instead of fixed SSH line ranges because the worktree already contains uncommitted menu changes and may continue to evolve. No changes to SSH execution, rendering, or output retention were made during this research.

## 11. User-selected direction and implementation follow-up

After reviewing the findings, the user selected:

- Apply a consistent native-style presentation to all ten SSH tools. Only command execution uses a shell command header and exit-code semantics; transfers retain byte progress and other operations use appropriate summaries.
- Merge stdout and filtered stderr in the human-visible stream in client-observed arrival order. Preserve the separate stdout/stderr fields in agent-facing results; no claim of a globally exact remote ordering is implied.
- Keep a bounded display preview and save complete output to a private local temporary file when output limits are exceeded. Expansion shows retained content, not automatic full-file loading.
- Follow native bash's temporary-log retention: no deletion on tool completion, extension reload, or normal exit; cleanup is left to the user or operating system. Do not promise automatic expiry, crash cleanup, or durable archival.

The proposed implementation also identifies the remote target explicitly, retains existing tool names/parameters and cancellation/unknown-outcome semantics, uses semantic theme colors rather than fixed gray/blue, and shows Pi-recorded tool-call duration rather than claiming pure remote-process time. The user subsequently confirmed implementation. The follow-up uses public native callbacks in `packages/pi-remote-ssh/src/render.ts`, filtered output capture and private logs in `src/output.ts`, and a streaming bridge through `src/transport.ts` and `src/tools.ts`. The original research remains static evidence; runtime validation is now covered separately by `test/output.test.ts`, `test/streaming.test.ts`, the real-Pi `test/render-smoke.ts`, real SSH integration tests, and the offline transcript/actual Ctrl+O path in `test/native-tui.py`. No private Pi imports or local-bash overrides are used.

## Evidence limitations and residual risks

- This is static source/declaration research against installed **1.3.0**, not a terminal screenshot, runtime import, remote execution, or cross-platform test. No test suite or network command was run.
- The four stated global/repository comparisons establish identity for those specific files; remaining detailed citations are to the repository-installed primary package. Future Pi releases may change contracts or export surfaces.
- The initial native-Pi research did not inspect SSH implementation files. The parent subsequently verified the SSH-specific observations in the addendum below; no functional implementation or terminal comparison was performed for this research.
- Actual colors depend on active theme, terminal palette, capability detection, and terminal path. The source cannot establish the user's exact visible blue/gray shades.
- Native examples include simplified error/remote handling; they are not an authorization, process-lifecycle, or production SSH specification.
- Accurate HTML duration, vanished extensions on replay, missing historical durations, lost temporary logs, nested-call presentation, and independent remote cancellation remain explicit caveats rather than hidden parity claims.
