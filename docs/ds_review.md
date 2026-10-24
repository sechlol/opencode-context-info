# Architecture & Developer Review — `/tokens_usage` CLI Plugin Plan

- **Reviewed:** `docs/tokens-usage-plugin.md`
- **Date:** 2026-10-24
- **Target:** OpenCode v2.1.4, `@opencode/plugin@2.1.4`, `@opencode/client@2.1.4`
- **Repo state at review:** docs and `reference/` only; no `package.json`, `src/`, tests, or CI yet.

## Verdict

The direction is strong: using reported usage telemetry instead of re-tokenizing is the right call, and the plan mostly uses the correct v2 primitives (router, keymap, dialog, cached session data). It also correctly avoids the legacy LLM-command and tokenizer-vendor problems.

The plan is **not ready to implement as written**. There are four blocker-level issues (three API/type mismatches plus the CLI-config location mistake), several token-accounting ambiguities that can produce visibly wrong numbers, and important gaps in state handling, testing, and installation. None are fundamental; they are fixable before build.

**Recommended action:** revise the plan around a clearer data flow (pure aggregation vs. I/O), make token semantics explicit, fix the CLI-context API calls, and add a small test/CI plan. Then implement.

## Findings at a glance

| ID | Severity | Area | Finding |
|---|---|---|---|
| B1 | Blocker | API | `ctx.location.project.id` does not exist in the CLI-plugin context |
| B2 | Blocker | API | `Plugin.define({ id })` is missing the required `setup` function |
| B3 | Blocker | API/UI | `dialog.show()` takes a render callback, not JSX; `esc` is not automatic |
| B4 | Blocker | Distribution | A repo-root `cli.json` is not read; CLI config is global-only |
| H1 | High | Correctness | The proposed “total” formula double-counts or mislabels categories across providers |
| H2 | High | Correctness | Assistant-only aggregation misses compaction and unattributed usage |
| H3 | High | Correctness | `tools: "summary"` cannot provide “top tools” |
| H4 | High | Architecture | `stats.ts` is described as pure but also owns subagent/project I/O |
| H5 | High | Architecture | No loading/error/empty/refresh state model or concurrency handling |
| H6 | High | Developer | No tests, typecheck, or CI despite non-trivial aggregation math |
| H7 | Medium | UX | Session selector is not `/sessions`-equivalent (cache cap, local-only search) |
| H8 | Medium | Correctness | Subagent aggregation has root/nesting/freshness ambiguities |
| H9 | Medium | API | Assistant `tokens`/`cost` are optional; `ModelRef` field is `id`, not `modelID` |
| H10 | Medium | Verification | `opencode plugin list` appears server-scoped and is not enough to verify a CLI plugin |
| H11 | Medium | Packaging | Peer dependency versions and direct `@opencode/client` usage are not declared correctly |
| H12 | Medium | UX | `xlarge` can overflow; bar scaling and number formatting are underspecified |
| H13 | Medium | Distribution | Adding the plugin to both `opencode.json` and `cli.json` can double-load the TUI plugin |
| H14 | Medium | Distribution | Installer must preserve JSON/JSONC, arrays, object-form entries, and env overrides safely |

---

## 1. API and type verification

I checked the plan against the installed v2.1.4 type definitions and a live 2.1.4 service. Most of the research is accurate, but these points need correction.

### B1. `ctx.location.project.id` is invalid in a CLI plugin — Blocker

The plan uses:

```ts
ctx.client.session.stats({ project: ctx.location.project.id, tools: "summary" })
```

In the **CLI** plugin context, `location` is typed as:

```ts
// @opencode/plugin@2.1.4 dist/tui/context.d.ts
readonly location: LocationRef | undefined
```

and `LocationRef` is only:

```ts
// @opencode/client@2.1.4
type LocationRef = {
  directory: AbsolutePath
  workspaceID?: WorkspaceID
}
```

The `project` metadata exists on the **server** plugin context (and on `LocationPublicInfo`), not on this CLI `LocationRef`. The plan appears to have merged the server-plugin and CLI-plugin contexts. As written, this will not typecheck; at runtime `ctx.location.project` may be undefined.

Also note `ctx.location` itself is optional. The docs’ own pattern is:

```ts
const location = context.location ?? context.data.location.default()
```

**Recommended fix:**

```ts
const location = ctx.location ?? ctx.data.location.default()
const session = sessionID ? ctx.data.session.get(sessionID) : undefined

const projectID =
  session?.projectID ??
  (
    await ctx.client.location.get({
      location: { directory: location.directory },
    })
  ).project.id
```

Cache the project ID per directory in memory for the dialog’s lifetime. If the lookup fails, render the project section as unavailable rather than failing the whole dialog.

### B2. `Plugin.define` requires `setup` — Blocker (small)

The plan’s `src/index.ts` is described as:

```ts
Plugin.define({ id: "tokens-usage" })
```

The 2.1.4 definition is:

```ts
export interface Definition {
  readonly id: string
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
}
```

`setup` is required. Use:

```ts
export default Plugin.define({
  id: "example.tokens-usage",
  setup() {},
})
```

Also consider namespacing the plugin ID; a generic `tokens-usage` is more likely to collide with another package.

### B3. Dialog API and close behavior — Blocker

`Dialog.show` is:

```ts
show(render: () => JSX.Element, onClose?: () => void): void
```

The plan says `ctx.ui.dialog.show(<StatsView/>)`. That is a JSX element, not a render function. Use:

```ts
ctx.ui.dialog.set({ size: "xlarge" })
ctx.ui.dialog.show(() => <StatsView state={state()} onClose={close} onRefresh={refresh} />)
```

Two related points:

- `dialog.set` sets options for the **active dialog**. Call it immediately before `show`; do not assume it is scoped to your component or that it resets afterward.
- Custom JSX dialogs do not have a documented automatic `esc` close. The plan says “closes with `esc`” but only describes an `r` layer. Add an explicit `escape` binding inside the dialog component and call `ctx.ui.dialog.clear()`.

The `r` layer also needs to be scoped. `KeymapLayer.mode` defaults to `"base"`; a dialog may not be in that mode. Use a `target` pointing at the dialog’s renderable and/or an explicit mode/priority, and verify that plain `r` does not fire while typing elsewhere.

### B4. CLI config is global-only — Blocker for distribution

The planned repo layout includes a root `cli.json` and says to add the repo path to `plugins` in `cli.json`. That conflates the plugin repository with the user’s CLI settings.

The v2 docs are explicit:

- CLI settings live in `~/.config/opencode/cli.json`, or `$XDG_CONFIG_HOME/opencode/cli.json`.
- There is **no project-local CLI settings file**.
- `OPENCODE_CLI_CONFIG_CONTENT` merges inline settings over the file; nested objects merge, but **arrays and scalars from the environment replace** the file values.

So a `cli.json` committed at the repo root is not loaded by OpenCode. Rename it to `cli.example.json` or move it into the README as a snippet, and have `install.sh` write the real global file. The installer must also warn when `OPENCODE_CLI_CONFIG_CONTENT` is set, because edits to `cli.json` may be ignored for the `plugins` array.

### Confirmed accurate

These plan claims check out against 2.1.4:

- `import { Plugin } from "@opencode/plugin/tui"` and `Plugin.define({ id, setup })`.
- `ctx.keymap.layer()` with `commands`, `palette`, `slash`, and `run`.
- `ctx.ui.router.current()` returning `home`, `session`, or `plugin` routes.
- `ctx.ui.dialog.select()` and `ctx.data.session.list()`.
- `ctx.data.session.message.sync()` / `.list()` / `.invalidate()`.
- `ctx.data.session.family()`, `session.root()`, `session.cost()`, `session.status()`.
- `ctx.client.session.stats()` exists in the generated promise client (backed by the experimental endpoint) and accepts `project` and `tools: "none" | "summary" | "detail"`.
- Assistant messages carry `tokens`, `cost`, `model`, `agent`, `time`, and `content`.
- `SessionInfo` carries `tokens`, `cost`, `parentID`, `projectID`, `location`, and `time`.
- `ctx.theme`, `@opentui/solid`, and `usePlugin()`.

### H3. `tools: "summary"` does not include per-tool usage — High

`SessionStatsInfo.tools` is a union:

```ts
type SessionStatsTools =
  | { mode: "none" }
  | { mode: "summary"; totals: SessionStatsToolTotals }
  | { mode: "detail"; totals: ...; usage: SessionStatsToolUsage[] }
```

The plan requests `"summary"` and then promises “top models/top tools.” Top models are available in `models`, but top tools require `"detail"`. Choose one:

- Use `"detail"` if top tools are required.
- Keep `"summary"` and show only aggregate tool totals (calls/succeeded/failed/unfinished).
- Drop the top-tools section from the mock.

### H9. Optional fields and model shape — Medium

Two implementation traps:

- `SessionMessageAssistant.tokens` and `.cost` are optional. In-progress, errored, or retried steps may not have them. Guard every access; decide whether an in-progress step is shown as “running” and excluded from totals.
- `SessionMessageAssistant.model` is a `ModelRef`:

  ```ts
  type ModelRef = { id: string; providerID: ProviderID; variant?: string }
  ```

  The model key is `${model.providerID}/${model.id}`; there is no `model.modelID` field. Include `variant` in the display or grouping if two variants of the same model can have different pricing.

Also handle `SessionInfo.title` being optional and `SessionInfo.time.archived` when building the selector.

### H10. `opencode plugin list` is not sufficient verification — Medium

On this machine, `opencode plugin list` shows only the server plugin:

```
context-usage  local  <global-config>/plugins/context-usage/index.ts
```

It did not show the TUI plugin registered through the legacy `tui.json`. It appears to be a server-plugin listing. A CLI-only plugin in `cli.json` may not appear there either. Do not make step 1 of the verification plan the primary acceptance test. Verify by opening the TUI, running `/tokens_usage`, and checking the CLI log; use `opencode plugin list` only as a secondary probe.

### H11. Packaging and peer versions — Medium

The plan says peer `@opentui/core >=0.6.6` and `@opentui/solid >=0.6.6`. `@opencode/plugin@2.1.4` declares:

```json
"peerDependencies": {
  "@opencode/theme": "2.1.4",
  "@opentui/core": ">=0.6.8",
  "@opentui/solid": ">=0.6.8",
  "solid-js": ">=1.9.0"
}
```

Use `>=0.6.8` for 2.1.4 to avoid peer warnings and API drift. Also:

- The plan imports `SessionMessageInfo` / `SessionInfo` types from `@opencode/client` but only lists `@opencode/plugin`. Add `@opencode/client` as an explicit dev/peer dependency, or import only through a re-export that is guaranteed by `@opencode/plugin`.
- Pin `@opencode/plugin` to a compatible range (e.g. `^2.1.4` or `>=2.1.4 <3`) rather than `latest`. The CLI plugin API is new and still moving.
- For a source-loaded local plugin, prefer `@opencode/plugin` as a dev/type dependency and rely on the host’s runtime resolution. If you install a second copy under the plugin’s `node_modules`, you risk version skew. If you publish to npm, follow the docs’ `dependencies` example and test that the host copy wins.

---

## 2. Architecture and layering

### What the plan gets right

The intended split is sensible:

- `tui.tsx` registers the command and handles routing/selection.
- `stats.ts` aggregates.
- `view.tsx` renders.
- `index.ts` is a minimal server sibling.

The problem is that `stats.ts` is specified as both “pure functions over `SessionMessageInfo[]`” and the place where subagent and project I/O happens. That is not a pure layer, and it makes the most valuable logic harder to test.

### H4. Split I/O from aggregation — High

Recommended layout:

```text
src/
  index.ts        # server entry: Plugin.define({ id, setup() {} })
  tui.tsx         # command registration, route resolution, dialog lifecycle
  data.ts         # async I/O: sync/read session, messages, family, project stats
  stats.ts        # pure: normalize + aggregate + reconcile
  format.ts       # pure: token/cost/time/number formatting
  view.tsx        # presentational Solid/OpenTUI components
  types.ts        # view-model types, independent of OpenCode schemas
test/
  stats.test.ts
  format.test.ts
  fixtures.ts
```

Define a narrow internal model so `stats.ts` does not depend on the full OpenCode union:

```ts
type Usage = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

type UsageRecord = {
  at: number
  completed: boolean
  kind: "assistant" | "compaction"
  agent?: string
  model: { providerID: string; id: string; variant?: string }
  usage?: Usage
  cost: number
  toolCalls: number
}
```

`data.ts` converts `SessionMessageInfo[]` into `UsageRecord[]` and handles every optional field and union case. `stats.ts` then has no `ctx`, no client, and no OpenCode imports. That makes fixture-based tests trivial and protects the UI from schema changes.

Suggested data flow:

```ts
async function showUsage(ctx: Context, sessionID: string) {
  const snapshot = await loadSnapshot(ctx, sessionID) // data.ts
  const model = buildViewModel(snapshot)             // stats.ts
  ctx.ui.dialog.set({ size: "xlarge" })
  ctx.ui.dialog.show(() => <StatsView model={model} onRefresh={refresh} />)
}
```

`loadSnapshot` should use `Promise.allSettled`:

- `data.session.sync(sessionID)` and `data.session.message.sync(sessionID)`.
- Read `data.session.get(sessionID)`, `data.session.message.list(sessionID)`, `data.session.cost(sessionID)`.
- `data.session.family(sessionID)` for subagents; sync their session info if cheap.
- `client.session.stats(...)` for project totals; failure is non-fatal.
- Return partial data plus an `errors` list.

### H5. State, refresh, and failure handling are missing — High

`dialog.show` is synchronous, but loading messages and project stats is asynchronous. The plan does not say what the user sees while data loads, or how `r` updates the already-mounted component.

A concrete approach:

```ts
type ViewState =
  | { status: "loading"; previous?: StatsViewModel }
  | { status: "ready"; model: StatsViewModel; warnings: string[] }
  | { status: "error"; message: string; previous?: StatsViewModel }

const [state, setState] = createSignal<ViewState>({ status: "loading" })
```

Then `dialog.show(() => <StatsView state={state()} ... />)` and update the signal on refresh. This works because `show` takes a reactive render callback.

Additional requirements:

- **Loading:** show a loading line; do not open an empty dialog and then jump.
- **Empty:** a session with no messages should say “No usage recorded yet,” not render zeros as if real.
- **Running:** use `data.session.status(sessionID)` for “running” and show in-progress steps distinctly.
- **Errors:** toast on total failure; for partial failure, show cached data with a warning row (“project totals unavailable”).
- **Concurrency:** guard against two `run` invocations and overlapping `r` refreshes. Use a request generation counter or an abort flag; ignore stale results.
- **Route changes:** after an `await`, verify the route/session is still the one the user requested before showing the dialog.
- **Cleanup:** use the dialog’s `onClose` callback to dispose signals/listeners. Do not leave an `r` layer or event subscription active after close.
- **Auto-refresh (optional):** while the dialog is open, subscribe to `data.on("session.execution.succeeded", ...)` with a debounce and refresh. This is a better UX than requiring `r`, but it must be scoped to the dialog lifecycle.

Also wrap the view in a Solid `ErrorBoundary`. A rendering exception in a TUI plugin can take down the whole interface; the legacy notes already mention crash-class plugin bugs.

---

## 3. Token accounting correctness

This is the most important area to tighten. The plan says “exact billed telemetry,” but the UI’s headline “TOTAL” is not defined precisely and is not portable across providers.

### H1. The proposed total can double-count — High

The mock computes:

```text
12,340 input + 3,210 output + 1,870 reasoning + 45k cache = 62,420
```

That assumes all four categories are disjoint. They are not universally disjoint:

- **Reasoning vs. output:** for some providers, reasoning tokens are a subset of output tokens; for others they are reported separately. Live project data here shows reasoning greater than output for a GLM model, so it cannot be assumed to be a subset; conversely, OpenAI-style reasoning models commonly include reasoning in output. One formula cannot be correct for both.
- **Cache vs. input:** for some providers, cached tokens are a subset of prompt/input tokens; for others, input excludes cache reads/writes. OpenCode may normalize some of this, but the plan does not state a normalization contract.
- **Cache write vs. cache read:** these have different pricing and should not be collapsed into one “CACHE” bar.

**Recommendation:** do not present a grand “total tokens” as the primary number. Show the components, and make cost the comparable headline. If a total is required, define it explicitly, for example:

> `reportedTotal = input + output + reasoning + cache.read + cache.write` — “sum of reported categories; reasoning/cache may overlap with input/output depending on provider.”

Better still, use the host’s aggregate as the authoritative session total (`SessionInfo.tokens` / `data.session.cost`) and show the message-derived breakdown as an attribution, not as the source of truth.

If the repo’s “context info” identity matters, add a **separate** “current context” metric:

```text
currentPrompt = last assistant message's input + cache.read + cache.write
```

and compare it to the model’s `limit.context`. That answers “how full is my context window?” Cumulative session tokens answer a different question. The plan currently blurs the two, and the mock’s “TOTAL” can easily be mistaken for context-window occupancy.

### H2. Assistant-only aggregation misses compaction and auxiliary usage — High

`SessionMessageCompactionCompleted` and `SessionMessageCompactionFailed` both carry optional `tokens` and `cost`. The plan says totals come from `SessionMessageAssistant.tokens` / `.cost`, so compaction usage is silently omitted.

In a live sample here, after syncing, the assistant-message sums matched `SessionInfo.tokens` exactly; the risk is compaction, auxiliary calls, and timing/staleness, not an inherent mismatch. Additional unattributed usage can come from retries, title generation, or other auxiliary model calls that are not represented as assistant steps. The safest design is:

- **Session totals:** `SessionInfo.tokens` and `SessionInfo.cost` (after `session.sync`), or `data.session.cost(sessionID)`.
- **Breakdown:** assistant + completed compaction records.
- **Reconciliation:** compute `unattributed = sessionTotals - sum(records)` and show an “other/auxiliary” row when non-zero. If the delta is material, the user can see that the step table does not explain the whole bill.

This also avoids a confusing mismatch between the dialog’s total and the session’s own cost display.

### H8. Subagent aggregation needs explicit rules — Medium

`family(sessionID)` returns IDs, but the plan does not define:

- Whether the array includes the current/root session. If it does, adding every `SessionInfo.tokens` double-counts the current session.
- Whether nested subagents are returned individually. If a child’s `SessionInfo.tokens` includes its own descendants, summing the family double-counts.
- Whether `SessionInfo` for a child is fresh. `session.list()`/`get()` are cached; call `session.sync(childID)` or accept a staleness indicator.
- What happens when the current route is itself a subagent session. `family(child)` may include the parent and siblings; “session + subagents” is then misleading.

**Recommendation:** use `data.session.root(sessionID)` to identify the scope, filter the current session out of the subagent sum, and document whether nested descendants are included. Test with a nested subagent family. If exactness is hard, show subagent totals as “reported for child sessions” and avoid adding them to the main session total.

### Project totals — Medium

Passing `project` is correct, but:

- Resolve the project ID as described in B1.
- Label the range. `session.stats` has optional `from`/`to`; the current API returns a `range`. The plan’s “PROJECT · 4 sessions · 310k tk” does not say whether that is all-time, today, or last 7 days.
- `sessions` and `subagents` are separate counts; decide whether the displayed “sessions” number is roots only or the sum.
- The project total likely includes the current session and its subagents. Label it “project total (includes this session)”.
- Treat the endpoint as best-effort: it is marked experimental in the API, and it can fail on an older/remote server. A failed project call must not hide session stats.

### Cost and number formatting — Medium

`MoneyUSD` is a number, and cost may be provider-reported or computed from model pricing. Do not claim invoice-level exactness. Practical rules:

- Use 4–6 significant digits for small costs; avoid rounding a real cost to `$0.00`.
- Show `free` or `—` deliberately for zero/unknown cost; do not conflate “free model” with “usage unavailable.”
- Use one token formatter everywhere. The mock mixes `12,340` and `45k`; choose exact-with-separators or compact (`12.3k`) and apply it consistently.
- Pin the locale or use a deterministic custom formatter; `Intl.NumberFormat` can emit locale-specific separators that break column widths and tests.

---

## 4. UI and interaction

### H12. `xlarge` and the proposed layout are fragile — Medium

`xlarge` is a valid `DialogSize`, but it can exceed an 80×24 terminal, especially with a header, four bars, per-model rows, ten steps, subagents, project totals, and a footer. The plan has no responsive behavior.

Recommendations:

- Use `useTerminalDimensions()` from `@opentui/solid` and fall back to `large` on narrow terminals.
- Wrap content in a `scrollbox`; cap “recent steps” based on available height.
- Truncate long model IDs in the middle (OpenRouter IDs are long) and right-align numeric columns.
- Separate `cache.read` and `cache.write`; they have different cost semantics.
- Prefer a single stacked composition bar (input, cache read, cache write, output, reasoning) over four independently scaled bars. Independent bars invite false comparisons unless they share an explicit scale.
- Keep the numeric value next to every bar; do not make color or bar length the only carrier of meaning.
- Use semantic theme tokens only; no raw hex colors. Verify contrast in both light and dark themes.
- Add an ASCII fallback option (`#`/`-`) if block characters render poorly in some terminals.

### H7. Selector behavior — Medium

The plan says “same interaction pattern as `/sessions`,” but `DialogSelectOptions.search` is synchronous, so it cannot perform server-side search per keystroke. `ctx.data.session.list()` is a cache and the underlying `session.list` API defaults to the newest 50 sessions. This is not equivalent to `/sessions`.

Decide explicitly:

- **MVP:** load the cached list, filter to root sessions in the current project, hide archived sessions, sort by `time.updated` descending, and search locally. Document the cap.
- **Fuller:** fetch `client.session.list({ directory, parentID: "null", limit: 100 or more })` before opening the selector, then search locally. Still a cap, but a deliberate one.
- **Custom dialog:** only if true server-side search is required; `dialog.select` cannot do it.

Also handle an empty list (“No sessions in this project”), sessions with no title, running sessions, and sessions from other projects/worktrees. Use `description` for updated time/status/tokens and `footer` for cost.

### Empty, running, and error states — Medium

The mock shows a happy path only. Add explicit states:

- No messages: “No usage recorded yet.”
- Running step: “running…” with partial totals; exclude or mark the incomplete step.
- Project stats unavailable: hide the section or show a muted warning; do not blank the dialog.
- Corrupt/unknown message shape: skip it, count it in a warning, and keep the rest.
- Loading/refreshing: footer says `refreshing…`; disable `r` while a refresh is in flight.

### Esc, `r`, and focus — Medium

- Add an explicit `escape` handler that calls `dialog.clear()`; do not assume the host closes custom dialogs.
- Scope the `r` binding to the dialog renderable and/or the dialog mode. A plain global `r` can steal input from other components.
- If using `useKeyboard` inside the component instead of a keymap layer, remember it receives events while mounted; still check focus/mode and prevent default where appropriate.
- The footer should reflect actual keys: `esc close · r refresh`, and show `refreshing…` when disabled.

---

## 5. Developer experience and tests

### H6. Add a testable core and CI — High

The aggregation logic is the product’s core value and is entirely testable without a TUI. The plan has no test files or scripts.

Recommended:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --test",
    "check": "npm run typecheck && npm test"
  }
}
```

Node 24 is installed here and supports running TypeScript tests via type stripping for simple `.ts` files; if that proves awkward, use `tsx` or Vitest as a dev dependency. Do not require Bun.

Minimum fixtures/tests:

- Assistant message with full tokens/cost.
- Assistant message without tokens (in-progress) and without cost.
- Errored/retried step.
- Completed and failed compaction messages with tokens/cost.
- Multiple models, including the same model with different variants.
- Empty session; zero-cost/free model; very large counts.
- Subagent family including root and nested children (once semantics are confirmed).
- Reconciliation: session totals vs. attributed records, including an “unattributed” delta.
- Formatters: 0, 999, 1k, 1.05M, tiny costs, zero/unknown costs, negative/invalid input.
- `loadSnapshot` with a fake client that rejects project stats but succeeds for messages.

### TypeScript configuration

The plan mentions `tsconfig.json` but not the settings that matter for TSX/OpenTUI:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "preserve",
    "jsxImportSource": "@opentui/solid",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "test/**/*.ts"]
}
```

Add a `/** @jsxImportSource @opentui/solid */` pragma to `.tsx` files if the loader does not read `tsconfig.json` (the legacy reference does this). Verify both `tui.tsx` and `view.tsx`.

Other developer hygiene:

- Add `.gitignore` for `node_modules`, `.DS_Store`, and local config backups.
- Add a `LICENSE`.
- Add a minimal CI workflow: install, typecheck, test.
- Add a debug option (`options.debug === true`) that logs raw snapshot counts and deltas with a stable prefix. This will make “why does this number differ?” reports much easier.
- Avoid `any` at the OpenCode boundary; normalize once in `data.ts` and keep the rest typed.

### Error boundary and load safety

- Wrap `StatsView` in a Solid `ErrorBoundary` and render a small fallback with a close hint.
- Register the keymap command as early as possible in `setup`; do not `await` data or project resolution during setup.
- Keep static imports minimal. A failure to import a heavy UI dependency should not prevent the command from registering; if that is not practical, at least keep the entry module free of top-level I/O.
- Return a cleanup function if you add event subscriptions or timers.

---

## 6. Distribution and installer

### H13. Avoid double-loading the TUI plugin — Medium

The v2 docs say plugins configured in `opencode.json(c)` that expose a TUI component are loaded automatically by the CLI. If the plugin is also listed in `cli.json`, the TUI entrypoint can be loaded twice: duplicate command IDs, duplicate palette entries, and potentially two dialogs.

Choose one supported installation path and document it:

- **CLI-only (recommended for this plugin):** `cli.json` only. Works against remote servers and does not require the server plugin to load.
- **Server + TUI:** `opencode.json(c)` only. The empty `src/index.ts` server entry is harmless, but the CLI will auto-load the TUI component.

The installer should detect an existing entry in the other config file and warn or skip. Do not present “fallback” as if both can be used simultaneously without consequence.

### H14. Installer safety — Medium

A config-editing installer is a trust boundary. The plan says “idempotent, backs up first,” which is good, but the details matter:

- Default to `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/cli.json`, not just `~/.config/opencode`.
- Preserve `$schema` and all unrelated settings.
- Preserve both string and object forms in `plugins`:
  ```json
  ["pkg", { "package": "./plugin", "options": {} }]
  ```
- Normalize paths for deduplication (`./x`, `x`, absolute, `file://`). Decide which form is canonical.
- If the file contains JSONC comments, a `JSON.parse`/`JSON.stringify` rewrite will destroy them or fail. Either use a comment-preserving parser, or refuse to edit and print the exact snippet to add. At minimum, never silently rewrite a file you could not parse.
- Write atomically: temp file in the same directory, `fsync` if practical, then rename. Preserve the original mode; `cli.json` may be `0600`.
- Back up with a collision-resistant suffix, validate the result, and restore the backup on failure.
- Detect `OPENCODE_CLI_CONFIG_CONTENT`; explain that its `plugins` array replaces the file’s array.
- Add `--dry-run`, `--target DIR`, and `--uninstall`. Print the resolved config path and the exact entry added.
- Warn if the plugin path is absolute and the repo may move; document that moving the repo breaks the install. Consider a copy/symlink install or a published package as the stable option.
- Do not copy the old vendor-tokenizer logic or patch the global `package.json`; those were workarounds for the legacy approach. The new package has its own `package.json` with `"type": "module"`.

### Local-path loading needs an explicit test

The docs support local paths in `cli.json` and plugin discovery under `plugins/`, but the plan does not say whether the entry should be the repo root, `src/tui.tsx`, or a shim directory. Test all three against 2.1.4 in a sandbox config:

- repo root (does it honor `package.json` `exports["./tui"]`?),
- `./src/tui.tsx` (file URL / path),
- a copied directory with `index.ts` + `tui.tsx`.

Pick the form that actually loads, and put it in the README and installer. Do not rely on `opencode plugin list` alone.

### README and lifecycle docs

The current README is two lines. Before release it should cover:

- What the plugin shows and what it does **not** show (cumulative usage vs. current context window).
- Install, verify, upgrade, uninstall.
- `cli.json` vs `opencode.json` precedence and the double-load warning.
- `OPENCODE_CLI_CONFIG_CONTENT`.
- Troubleshooting: `/reload`, `opencode service status`, logs at `~/.local/share/opencode/log/opencode.log`, and `opencode --standalone` for isolating stale service state.
- Compatibility: tested OpenCode version and plugin API version.
- Privacy: all data stays local; no prompts or content are sent anywhere.
- Known limits: session list cap, experimental project stats, provider-dependent token semantics.

Note that config changes normally apply without a restart. Use `/reload` first; reserve service restart/`--standalone` for stuck plugin-load failures, not ordinary installation.

---

## 7. Verification plan (expanded)

Replace the current five steps with a checklist that covers correctness and failure modes.

### Static

1. `npm run typecheck` against `@opencode/plugin@2.1.4` and `@opencode/client@2.1.4`.
2. `npm test` covering `stats.ts` and `format.ts`.
3. Confirm no imports from `reference/` and no tokenizer/vendor dependencies.

### Session data

4. In a normal session, compare the dialog’s totals to `opencode api get /api/session/{id}` and to the session’s own cost display.
5. Compare the per-step sum + “unattributed” row to the session total.
6. Test a session with compaction; confirm compaction tokens/cost are included or explicitly labeled.
7. Test a session with nested subagents; confirm no root/child double-count and correct family scope.
8. Test a free model and a model with zero reported cost; confirm the display is not misleading.
9. Test an empty session and a session with an in-progress step.
10. Test a session with >50 root sessions and archived sessions; confirm selector filtering and cap behavior.
11. Test a session in another project; confirm it does not appear in the current project selector.

### Project stats

12. Compare the project section to `opencode api get '/api/experimental/session/stats?project={id}&tools=summary'`.
13. Confirm the range label matches the returned `range`.
14. Simulate project-stats failure (remote/old server); session stats must still render.

### UI

15. Home → `/tokens_usage` → selector → choose → stats; `esc` closes.
16. Session → `/tokens_usage` → direct stats; `esc` closes.
17. `r` refreshes a newly completed step; repeated `r` does not stack requests.
18. Narrow terminal (80×24) and wide terminal; no overflow; scroll works.
19. Light and dark themes; bars/numbers remain readable without color.
20. Run the command twice quickly; no duplicate dialog or stale result.
21. Change route/session while loading; no dialog for the wrong session.

### Install

22. Clean config: install, verify, uninstall.
23. Existing `cli.json` with `$schema`, other settings, string and object plugin entries; preserve all.
24. Re-run installer; no duplicate entry, no lost comments, backup present.
25. `XDG_CONFIG_HOME` and `OPENCODE_CLI_CONFIG_CONTENT` cases.
26. Plugin already in `opencode.json`; installer warns about duplicate loading.
27. Move the repo after install; document/verify the failure mode.

---

## 8. Open questions

Answer these before implementation; each changes the design.

1. **What is the headline number?** Cumulative session usage, current context-window occupancy, or cost? The plan currently shows cumulative usage under the repo name “context-info.”
2. **What exactly is “total tokens”?** Are reasoning and cache fields disjoint from input/output for every provider you care about? If not, what is the label and formula?
3. **Does `SessionInfo.tokens` include subagents, compaction, and auxiliary calls?** If yes, the plan’s subagent addition is a double-count. If no, reconciliation is required.
4. **Does `family(sessionID)` include the given session?** Does each child’s `SessionInfo` include its descendants?
5. **Does `opencode plugin list` show CLI-only plugins on 2.1.4?** If not, what is the supported verification command?
6. **Is `cli.json` JSON/JSONC, and which parser can the installer safely use?**
7. **Which platforms are supported?** Bash installer on macOS/Linux only, or also Windows?
8. **Is local-path installation acceptable long-term, or should this be published as a package?** Absolute paths are brittle and machine-specific.

---

## 9. What is good about this plan

- **Telemetry over tokenization is the right architectural choice.** It removes a large dependency and correctness surface, and it aligns the display with what OpenCode actually recorded.
- **The v2 primitives are the right ones.** `router.current()`, `keymap.layer()`, `dialog.show/select`, `data.session.*`, and `client.session.stats()` are the intended extension points; the legacy event-hacking is correctly abandoned.
- **No LLM path is a genuine feature.** A slash command that opens a dialog, not a prompt turn, is the correct UX and avoids the old command-hook workarounds.
- **The modal + selector flow matches existing TUI conventions.** Session detection from the router is cleaner than tracking selection events.
- **The intended pure aggregation layer is a good instinct.** With the I/O split suggested above, it becomes a real testable core.
- **The legacy gotchas are already understood.** Directory-plugin loading, module type, stale service state, and support-file placement are all called out; the new approach eliminates most of them.

The main work is not a redesign. It is tightening the contract: correct CLI-context APIs, explicit token semantics, one authoritative total with reconciliation, a reactive loading/refresh state, and a tested data layer.

---

## Appendix: Suggested implementation order

1. Scaffold `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`, scripts, and CI.
2. Implement `types.ts` + `stats.ts` + `format.ts` with fixtures/tests first.
3. Implement `data.ts` with a fake client and failure cases.
4. Implement `tui.tsx` command registration and route resolution.
5. Implement `view.tsx` with loading/error/empty/ready states, scoped `r`, and explicit `esc`.
6. Resolve project ID via `client.location.get` or session `projectID`; add project section with range/error handling.
7. Implement selector filters, sorting, and empty state.
8. Write the installer with atomic merge, backups, validation, and duplicate detection.
9. Expand README with install/verify/uninstall/troubleshooting and known limits.
10. Run the expanded verification checklist against a clean v2.1.4 install.
