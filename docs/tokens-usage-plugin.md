# Plan: `/tokens_usage` CLI plugin for opencode v2

> Target repo: `/Users/loaf/git/opencode-context-info`
> Status: approved plan, rev 2 (2026-10-24) — incorporates `docs/ds_review.md` and `docs/mimo_review.md`.
> Legacy code under `reference/` is informational only; nothing is imported from it.

## Goal

A `/tokens_usage` TUI plugin for opencode v2 that:

- Collects token usage for a session
- Visualizes the token statistics to the user
- Is fully script-based — no LLM in the middle
- Shows the current session's stats when opencode is inside a session; shows a `/sessions`-style
  session selector when on the main screen

## Decisions (confirmed by user)

| Decision | Choice |
|---|---|
| Data source | **Reported usage telemetry** — exact tokens + cost opencode records per message/session. Zero tokenizer/vendor deps. |
| Presentation | **Modal dialog** (`xlarge`, responsive fallback to `large`), bars + tables, `esc` closes. |
| Stats scope | **Session + subagents + project totals** (via `client.session.stats()`). |
| Distribution | **Both**: README local-path install instructions **and** a v2-correct `install.sh`. |
| Headline metric (rev 2) | **Cost is the headline number.** Token categories are shown as components with an explicit "sum of reported categories" label — no grand "TOTAL" that implies disjoint categories. A separate **CONTEXT** section answers "how full is my context window?" (the repo's identity). |
| Install path (rev 2, amended rev 3) | Register in the user's **`opencode.json` `plugins`** array. Originally planned as `cli.json`; **rev 3 amendment**: `cli.json` local paths were tested on 2.1.4 and do not load (CLI reconciliation ignored the entry), so `opencode.json` is the verified path. Never both (double-load). |

## Research findings (verified against `@opencode/plugin@2.1.4` / `@opencode/client@2.1.4` type defs)

- CLI plugins: `import { Plugin } from "@opencode/plugin/tui"` → `Plugin.define({ id, setup(ctx) })`.
  **`setup` is required** in `Definition`. Published via `exports["./tui"]`; CLI-only packages are
  registered in the **user's global** `~/.config/opencode/cli.json` (`$XDG_CONFIG_HOME` respected).
  A `cli.json` at the repo root is **not read** by opencode — the repo ships only `cli.example.json`.
- Slash command: `ctx.keymap.layer(() => ({ mode, commands: [{ id, palette: true, slash: { name }, run }] }))`.
  Layer `mode` defaults to `"base"` — the in-dialog refresh layer must set `mode: "global"` (or `target`)
  explicitly and be verified at runtime.
- Session detection: `ctx.ui.router.current()` → `{ type: "home" } | { type: "session", sessionID } | { type: "plugin", ... }`.
- Dialogs:
  - `ctx.ui.dialog.select({ title, options, search, actions })` → `Promise<Value | undefined>`;
    Escape resolves `undefined`. **`search` runs for every query including the empty one** and must
    return the full option list in display order for `""`.
  - `ctx.ui.dialog.show(render: () => JSX.Element, onClose?)` — **takes a thunk, not a JSX element**.
    `dialog.set({ size })` applies to the *active* dialog: call it immediately before `show`.
    **Escape-close is NOT guaranteed for custom JSX dialogs** — bind `escape` → `ctx.ui.dialog.clear()`
    explicitly inside the component and dispose state via `onClose`.
- **CLI context has no `ctx.location.project`**: TUI `Context.location` is
  `LocationRef | undefined` = `{ directory, workspaceID? }` and may be `undefined`
  (docs pattern: `ctx.location ?? ctx.data.location.default()`). Resolve `projectID` via
  `data.session.get(sessionID)?.projectID` or `client.location.get({ location: { directory } })`
  → `LocationPublicInfo.project.id`; cache per directory; failure is non-fatal.
- Session data (`ctx.data.session.*`): `list()`, `get(id)`, `root(id)`, `family(id)`, `cost(id)`,
  `status(id)` (`"idle" | "running"`), `sync(id)`, `invalidate(id)`, `message.{sync,list,get,invalidate}`.
- Telemetry shapes (all optional fields guarded):
  - `TokenUsageInfo = { input, output, reasoning, cache: { read, write } }`.
  - `SessionMessageAssistant`: `tokens?`, `cost?`, `model: ModelRef`, `agent`, `time`, `content` (tool parts), `error?`, `retry?`.
  - `ModelRef = { id, providerID, variant? }` — **no `modelID` field**; group by `${providerID}/${id}` (+ `variant` where pricing differs).
  - `SessionMessageCompaction{Completed,Failed}` also carry optional `tokens`/`cost` — compaction usage must not be dropped.
  - `SessionInfo`: `id, title?, parentID?, projectID, cost, tokens, time.{created,updated,archived?}, ...`.
- Session listing: `client.session.list({ parentID: null, archived: false, directory, project, order: "desc", limit, search, cursor })`
  — lets the selector fetch root sessions server-side instead of relying on the ~50-entry cache.
- Project stats: `client.session.stats({ project?, from?, to?, tools?: "none"|"summary"|"detail" })`
  → `SessionStatsInfo` with `range: { from, to }`, `sessions`, `subagents`, `prompts`, `steps`,
  `tokens`, `cost`, `tools`, `models`, `activity`. **Top tools require `tools: "detail"`**
  (`"summary"` returns totals only). Endpoint is experimental — treat as best-effort.
- Theme/UI: `ctx.theme` is `ResolvedTheme` (semantic tokens only, no raw hex); `usePlugin()` from
  `@opencode/plugin/tui`; JSX via `@opentui/solid` (add `/** @jsxImportSource @opentui/solid */` pragma).
- Peer ranges to declare: `@opentui/core >=0.6.8`, `@opentui/solid >=0.6.8`, `solid-js >=1.9.0`,
  `@opencode/theme 2.1.4` (matches `@opencode/plugin@2.1.4`'s own peers — the docs example's
  `>=0.6.6` is stale).
- `opencode plugin list` lists **server** plugins only — not a valid acceptance test for a CLI-only
  plugin. Verify CLI plugins by running `/tokens_usage` in the TUI + checking CLI logs.

## Repo layout (rev 2)

```
opencode-context-info/
├── package.json          # "type": "module"; exports { ".": "./src/index.ts", "./tui": "./src/tui.tsx" }
│                         # devDeps: @opencode/plugin ^2.1.4, @opencode/client ^2.1.4 (types)
│                         # peerDeps: @opentui/core >=0.6.8, @opentui/solid >=0.6.8, solid-js >=1.9.0, @opencode/theme 2.1.4
├── cli.example.json      # snippet the installer/README reference (repo-root cli.json is NOT read by opencode)
├── install.sh            # one-command installer (v2-correct, atomic, JSONC-safe)
├── README.md             # install/verify/upgrade/uninstall, limits, troubleshooting, privacy
├── docs/
│   ├── plan.md           # this plan
│   ├── ds_review.md      # architecture review (input)
│   └── mimo_review.md    # API review (input)
├── tsconfig.json         # see "Tooling" below
├── .gitignore            # node_modules, .DS_Store, config backups
├── LICENSE
├── .github/workflows/ci.yml   # install → typecheck → test
└── src/
    ├── index.ts          # server sibling: Plugin.define({ id: "loaf.tokens-usage", setup() {} })
    ├── tui.tsx           # command registration, route resolution, dialog lifecycle, state signal
    ├── data.ts           # async I/O: snapshot loading, normalization (sole owner of `any`-ish boundary)
    ├── stats.ts          # PURE: aggregate UsageRecord[] → StatsViewModel (no ctx, no client, no opencode imports)
    ├── format.ts         # PURE: deterministic token/cost/time/number formatting
    ├── types.ts          # view-model types, independent of OpenCode schemas
    └── view.tsx          # presentational Solid/OpenTUI components
└── test/
    ├── stats.test.ts
    ├── format.test.ts
    └── fixtures.ts
```

## 1. Command registration (`src/tui.tsx`)

```ts
ctx.keymap.layer(() => ({
  mode: "global",
  commands: [{
    id: "tokens-usage.show",
    title: "Show token usage",
    group: "Tokens",
    palette: true,
    slash: { name: "tokens_usage", aliases: ["usage"] },
    run: () => show(),
  }],
}))
```

- Register the command **first** in `setup`, before any awaited work; entry module has no top-level I/O.
- Slash + palette only, no global key binding. Verify the `usage` alias has no palette collision
  after loading (low risk; drop the alias if it collides).

## 2. Session detection

`ctx.ui.router.current()`:

- `{ type: "session", sessionID }` → show stats for that session.
- Otherwise → **session selector** (see §6).

After any `await`, **re-check the route** and only show the dialog if the route/session still matches
what the user requested (guards against mid-load navigation).

## 3. Data flow and state (`src/data.ts`, `src/tui.tsx`)

```ts
async function showUsage(ctx: Context, sessionID: string) {
  const snapshot = await loadSnapshot(ctx, sessionID)   // data.ts, Promise.allSettled
  const model = buildViewModel(snapshot)                // stats.ts (pure)
  ctx.ui.dialog.set({ size: sizeForTerminal() })        // xlarge, or large on narrow terminals
  ctx.ui.dialog.show(() => <StatsView state={state()} onClose={close} onRefresh={refresh} />, close)
}
```

- `loadSnapshot` uses `Promise.allSettled` over: `session.sync(id)`, `session.message.sync(id)`,
  `session.get(id)`, `session.message.list(id)`, `session.cost(id)`, `session.status(id)`,
  `session.family(id)` (+ child `session.sync(childID)`), project stats via `client.session.stats(...)`
  (non-fatal). Returns partial data + an `errors`/`warnings` list.
- `data.ts` converts `SessionMessageInfo[]` → `UsageRecord[]` (internal model in `types.ts`),
  guarding every optional field and union case. No `any` leaks past this boundary.

```ts
type UsageRecord = {
  at: number
  completed: boolean            // false = in-progress/errored step
  kind: "assistant" | "compaction"
  agent?: string
  model: { providerID: string; id: string; variant?: string }
  usage?: Usage                 // { input, output, reasoning, cacheRead, cacheWrite }
  cost: number                  // 0 when unknown; distinguished via usage presence
  toolCalls: number
}
```

- UI state model (Solid signal, updated by `refresh`):

```ts
type ViewState =
  | { status: "loading"; previous?: StatsViewModel }
  | { status: "ready"; model: StatsViewModel; warnings: string[] }
  | { status: "error"; message: string; previous?: StatsViewModel }
```

- **Concurrency**: request-generation counter; stale results from overlapping `run`/`r` invocations are discarded; `r` disabled while a refresh is in flight (footer shows `refreshing…`).
- **Cleanup**: dialog `onClose` disposes signals, the in-dialog keymap layer, and any event subscription.
- **Error boundary**: `StatsView` wrapped in Solid `ErrorBoundary` with a fallback + close hint — a rendering exception in a TUI plugin can take down the whole interface (legacy gotcha).
- Optional auto-refresh: while open, `data.on("session.execution.succeeded", ...)` debounced refresh, scoped to dialog lifecycle. Implement only if time permits; `r` is the baseline.

## 4. Token accounting rules (`src/stats.ts`)

Token categories are **not universally disjoint** across providers (reasoning may be a subset of
output; cached tokens may or may not be inside input). Therefore:

1. **Session totals (authoritative)**: `SessionInfo.tokens` / `SessionInfo.cost` (or `data.session.cost(id)`) — what opencode itself reports.
2. **Breakdown (attribution)**: sum of `UsageRecord`s from assistant + completed/failed compaction messages.
3. **Reconciliation row**: `unattributed = sessionTotals − Σ(records)`; shown as "other/auxiliary" when material, so the step table visibly explains (or fails to explain) the bill. Also catches provider-specific overlap.
4. **No grand "TOTAL"**: components displayed separately; `cache.read` and `cache.write` are **separate** lines (different pricing). If a combined figure is shown it is labeled `Σ reported categories` with a footnote that categories may overlap by provider.
5. **Cost is the headline.** Cost formatting: 4–6 significant digits; `$0.00` never fabricated from rounding — show `free` (model-reported zero) vs `—` (unknown) distinctly.
6. **Current-context metric (separate section)**: `last assistant step: input + cache.read + cache.write` vs the model's `limit.context` (from `data.location.model.list`), rendered as "context window occupancy". This answers the repo's core question ("context info") and must not be confused with cumulative usage.
7. **In-progress/errored steps**: shown as `running`/`error`, excluded from totals.
8. Formatters are deterministic (no locale-dependent `Intl` output); one token formatter everywhere.

### Subagent rules

- Scope = `data.session.root(sessionID)`; **exclude the current session's own ID** from the subagent sum (`family()` may include it).
- Nested-descendant double-counting is unverified — at runtime, check whether child `SessionInfo.tokens` already includes grandchildren; if it does, aggregate only direct children. Defensive default: label subagent figures as "reported for child sessions" and never add them into the main session total.
- Sync each child (`session.sync(childID)`) before reading; display per-child rows + a subtotal.
- If the current route IS a subagent session, scope the view to that session itself and note its root.

### Project totals

- Resolve `projectID` once per directory: `session.get(id)?.projectID ?? client.location.get({ location: { directory } }).project.id`; cached in memory. On failure the PROJECT section renders "unavailable" — the rest of the dialog still works.
- `tools: "detail"` (needed for top-tools). Display the returned `range` as a subtitle and label the section "includes this session".
- `sessions` vs `subagents` counts displayed separately.

## 5. Visualization (`src/view.tsx`)

```
┌ Token Usage ─────────────────────────────────────────────┐
│ "Fix auth bug" · 3 models · 24 steps · running…          │
│ SESSION COST $0.184 · Σ reported 62,420 tk*              │
│                                                          │
│ INPUT 12,340 · OUTPUT 3,210 · REASONING 1,870            │
│ CACHE READ 41,000 · CACHE WRITE 4,000      (*may overlap)│
│ [stacked composition bar: input|cacheR|cacheW|out|reas]  │
│                                                          │
│ CONTEXT WINDOW ▓▓▓▓▓▓▓░░░░ 52.3k / 200k (26%)            │
│                                                          │
│ BY MODEL                                                 │
│  anthropic/claude-s…  38,120 tk  $0.1500  18 steps       │
│  openrouter/~z-ai/g…  24,300 tk  $0.0340   6 steps       │
│                                                          │
│ RECENT STEPS (last 10 of 24)                             │
│  14:32  glm-5.3      in 8.2k  out 640   $0.0110  3 tools │
│  14:31  glm-5.3      running…                            │
│                                                          │
│ SUBAGENTS (2) 9,200 tk            PROJECT · last 30 days │
│  explore  6,100 tk $0.009         4 sessions · 310k tk   │
│  review   3,100 tk $0.004         $1.02 (incl. this sess)│
│                                                          │
│ esc close · r refresh                                    │
└──────────────────────────────────────────────────────────┘
```

- `r` → invalidate + re-sync + recompute; in-dialog keymap layer uses `mode: "global"` (or `target` on the dialog renderable) — **verify `r` dispatches while the dialog owns input**; disabled + `refreshing…` while in flight.
- Explicit `escape` binding → `ctx.ui.dialog.clear()` (not guaranteed for custom dialogs); `onClose` cleanup.
- Responsive: `useTerminalDimensions()` from `@opentui/solid`; fall back to `large` on narrow terminals; wrap content in a `scrollbox`; cap recent-steps rows to available height.
- Single **stacked** composition bar (shared scale) instead of four independent bars; numeric value always adjacent to every bar/segment (never color-only).
- Long model IDs truncated in the middle; numeric columns right-aligned.
- Semantic theme tokens only; verify contrast in light + dark; ASCII fallback (`#`/`-`) if block glyphs render poorly (verify on user's terminal).
- Empty state: "No usage recorded yet" — never render zeros as if real. Corrupt/unknown message shapes: skipped + counted in a warning row.

## 6. Session selector

- Fetch root sessions server-side before opening: `client.session.list({ parentID: null, archived: false, directory: location.directory, order: "desc", limit: 100 })` (deliberate cap, documented in README). Fallback to `data.session.list()` if the call fails.
- Filter: root sessions, current project/directory, not archived. Sort: `time.updated` desc.
- Option `title` = `session.title ?? "Untitled"`; `description` = relative time + running/idle status + tokens; `footer` = cost.
- `search` is synchronous/local — must return the full filtered list for the empty query `""`.
- Empty list → "No sessions in this project" (non-fatal dialog).

## 7. Distribution

- **Verified install path (rev 3)**: the installer/README register the repo path in the user's
  **`opencode.json` `plugins`** array — this is the form that loads on v2.1.4. **`cli.json` local
  paths were tested and do NOT load**: the CLI plugin reconciliation on 2.1.4 only ran built-in
  `opencode.*` TUI plugins; a `cli.json` local path entry was never discovered or set up
  (observed in debug logs, 2026-10-24). `cli.example.json` was removed accordingly.
- The installer **detects and warns** if the plugin is present in `cli.json` (double-load →
  duplicate commands/dialogs) instead of adding both.
- Which local form loads on 2.1.4 (repo root honoring `exports["./tui"]` vs `./src/tui.tsx` vs a copied directory with `index.ts` + `tui.tsx`) is **explicitly tested in a sandbox config** during implementation; the winning form goes into README + installer.
- **`install.sh`**:
  - Default target `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json`.
  - Atomic write (temp file in same dir + rename), preserve file mode (may be `0600`), preserve `$schema` and unrelated settings, preserve string **and** object-form plugin entries, normalize paths (`./x`, absolute, `file://`) for dedup.
  - **JSONC safety**: if the file contains comments and can't be parsed as JSON, refuse to rewrite and print the exact snippet to add instead — never silently destroy comments.
  - Collision-resistant backup; validate result; restore backup on failure.
  - Warn when `OPENCODE_CONFIG_CONTENT` is set (its `plugins` array **replaces** the file's array — env wins).
  - Instruct: run while opencode is closed (opencode rewrites `cli.json` itself and holds a lock; avoid racing). Do **not** touch legacy `tui.json`/`kv.json` (opencode auto-migrates them).
  - Flags: `--dry-run`, `--target DIR`, `--uninstall`. Print resolved config path + exact entry added. Warn that absolute paths break if the repo moves.
  - No vendor/tokenizer logic, no global `package.json` patching (legacy workarounds are obsolete).
- Platforms: bash installer targets macOS/Linux (matches user environment; Windows out of scope for now).

## 8. Tooling, tests, CI

- `tsconfig.json`: `target/module ESNext`, `moduleResolution: "Bundler"`, `jsx: "preserve"`, `jsxImportSource: "@opentui/solid"`, `strict`, `noEmit`, `skipLibCheck`, `allowImportingTsExtensions`; include `src/**` and `test/**`.
- Scripts: `"typecheck": "tsc --noEmit"`, `"test": "node --test"` (Node 24 type stripping; fall back to `tsx`/Vitest devDep if awkward), `"check": "typecheck && test"`. No Bun required.
- Fixtures/tests (stats + format are pure, so all fixture-based):
  - assistant with full tokens/cost; without tokens (in-progress); without cost; errored/retried step
  - completed + failed compaction with tokens/cost
  - multiple models; same model with different variants
  - empty session; free model; zero-cost; very large counts; locale-independent formatting (0 / 999 / 1k / 1.05M / tiny costs / unknown cost)
  - subagent family incl. root + nested children (once semantics confirmed)
  - reconciliation: session totals vs. attributed records incl. non-zero "unattributed"
  - `loadSnapshot` with fake client: project-stats rejection → partial snapshot + warning
- CI: install → typecheck → test.
- `options.debug === true` plugin option logs raw snapshot counts + deltas with a stable prefix (makes "why does this number differ?" debuggable).
- Cleanup returns from `setup` if event subscriptions/timers are added.

## 9. Verification checklist

**Static**
1. `npm run typecheck` against `@opencode/plugin@2.1.4` + `@opencode/client@2.1.4` (would have caught the three original API errors).
2. `npm test` green; no imports from `reference/`; no tokenizer/vendor deps.

**Session data**
3. Dialog totals match the session's own cost display and raw API (`/api/session/{id}`).
4. Per-step sum + "unattributed" row reconciles with session total.
5. Session with compaction: compaction tokens/cost included or explicitly labeled.
6. Session with nested subagents: no root/child double-count; family scope correct.
7. Free/zero-cost model renders honestly (`free` vs `—`).
8. Empty session and in-progress step render correctly.
9. >50 root sessions + archived sessions: selector filtering + cap behavior.
10. Session from another project doesn't appear in the selector.

**Project stats**
11. Project section matches raw `session.stats()` output; `range` label matches returned range.
12. Project-stats failure (remote/old server): session stats still render.

**UI**
13. In-session `/tokens_usage` → direct stats; home → selector → stats; `esc` closes **the custom dialog** (runtime check).
14. `r` dispatches while the dialog owns input; repeated `r` doesn't stack requests.
15. 80×24 and wide terminals: no overflow; scroll works; light + dark themes readable.
16. Command run twice quickly → no duplicate dialog/stale result; route change during load → no wrong-session dialog.

**Install**
17. Clean config install → verify → uninstall.
18. Existing `cli.json` with `$schema`, other settings, string + object entries: all preserved; re-run is idempotent with backup; JSONC file → snippet printed, file untouched.
19. `XDG_CONFIG_HOME` and `OPENCODE_CLI_CONFIG_CONTENT` cases handled.
20. Plugin already in `opencode.json` → installer warns about double-loading.
21. Repo moved after install → failure mode documented.
22. `opencode plugin list` used only as a secondary probe (server plugins); CLI plugin verified by running `/tokens_usage` in the TUI; palette shows the command with no `usage` alias collision.

## Resolutions of review open-questions

| Question | Resolution |
|---|---|
| Headline number | Cost (headline) + labeled component sums + separate CONTEXT-window occupancy section (§4) |
| "Total tokens" definition | `Σ reported categories`, explicitly footnoted as possibly overlapping; session authoritative total from `SessionInfo.tokens` with reconciliation (§4) |
| Does `SessionInfo.tokens` include subagents/compaction/aux? | Verify at runtime (legacy data suggests assistant-sum matched it exactly); reconciliation row makes either answer visible (§4) |
| Does `family()` include self / nested descendants? | Verify at runtime; defensively exclude self, aggregate direct children, label as "reported for child sessions" (§4) |
| `opencode plugin list` for CLI plugins? | No — server-only listing; verify via TUI + logs (§9) |
| `cli.json` JSON vs JSONC? | Assume worst case; installer refuses non-JSON-parseable files and prints the snippet (§7) |
| Platforms | macOS/Linux bash; Windows out of scope (§7) |
| Local-path vs published package | Both documented; absolute-path brittleness warned; npm publish is the stable long-term option (§7) |

## Implementation order

1. Scaffold: `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`, scripts, CI.
2. `types.ts` + `stats.ts` + `format.ts` with fixtures/tests first.
3. `data.ts` with fake client + failure cases.
4. `tui.tsx` command registration + route resolution.
5. `view.tsx` with loading/error/empty/ready states, scoped `r`, explicit `esc`, ErrorBoundary.
6. Project-ID resolution + project section with range/error handling.
7. Selector filters, sorting, empty state.
8. `install.sh` with atomic merge, backups, validation, duplicate detection.
9. README (install/verify/uninstall/troubleshooting, limits, privacy, known caps).
10. Full verification checklist against a clean v2.1.4 install.
