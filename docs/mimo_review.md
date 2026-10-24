# Review: `docs/tokens-usage-plugin.md` (plan for `/tokens_usage` CLI plugin)

**Reviewer:** MiMo (automated review)
**Date:** 2026-10-24
**Verdict:** ✅ **Approve with amendments** — the plan is fundamentally sound and its core API
research is accurate, but 3 concrete API errors and several spec ambiguities should be fixed in the
plan *before* Build mode so they don't surface as mid-build surprises.

## How this was verified

| Source | Used to check |
|---|---|
| `@opencode/plugin@2.1.4` tarball (`dist/tui/*.d.ts`) | `Plugin.define`, `Context`, `Keymap`, `Dialog`, `Router`, `Data`, `UI` shapes |
| `@opencode/client@2.1.4` tarball (`generated/types.d.ts`, `client.d.ts`) | `SessionInfo`, `SessionMessageAssistant`, `TokenUsageInfo`, `SessionStatsInput/Info`, `LocationRef`, `ModelRef` |
| opencode.ai v2 docs (`/docs/plugins`, `/docs/build/plugins`, `/docs/build/plugins/cli`) | publish/load rules, `cli.json`, `dialog.show`, keymap layers, `search` semantics |
| Installed binary `~/.opencode/bin/opencode` (2.1.4) | `cli.json` schema + `tui.json` → `cli.json` migration behavior |
| `reference/context_plugin_summary.md` | legacy gotchas referenced by the plan |

---

## Claims verified as correct ✅

The plan's "Research findings" section is mostly accurate. Confirmed line-by-line:

- `import { Plugin } from "@opencode/plugin/tui"` → `Plugin.define({ id, setup })` — matches
  `dist/tui/index.d.ts` (`export * as Plugin from "./plugin.js"`) and the official CLI-plugin doc.
- `exports["./tui"]` publish pattern + `index.ts` as required sibling ("Export `./tui` beside the
  main plugin for automatic loading") — **exactly** matches the docs' `package.json` example,
  including the peer ranges `@opentui/core >=0.6.6`, `@opentui/solid >=0.6.6`, `solid-js >=1.9.0`.
- `cli.json` with a **`plugins`** array is the correct home for a CLI-only plugin — confirmed in
  the docs *and* in the binary (`https://opencode.ai/v2/cli.json` schema; legacy `tui.json` +
  `kv.json` are auto-migrated into `cli.json` on first run).
- `ctx.keymap.layer(() => ({ mode, commands: [{ id, palette, slash: { name, aliases }, run }] }))` —
  matches `Keymap`/`KeymapCommand`; docs confirm `layer` may be called from a component and is
  disposed with it (validates the `r`-refresh design).
- `ctx.ui.router.current()` → `{ type: "home" } | { type: "session", sessionID } | { type: "plugin", ... }`
  — exact match with the `Route` union. The legacy event-hacking replacement is correct.
- `ctx.ui.dialog.select({ title, options, search, actions })` returning `Promise<Value | undefined>`;
  Escape resolves `undefined` — confirmed by types and docs.
- `ctx.data.session.list() / .family(id) / .message.sync() / .message.list() / .message.invalidate()`
  — all present with the stated signatures. `ctx.data.session.cost(id)` and `.status(id)` also exist
  (useful for the header/`idle` indicator and for cross-checks).
- `SessionInfo` carries `id, title?, parentID?, time.created/updated, cost, tokens` — confirmed
  (plus `projectID`, see finding #1).
- `TokenUsageInfo = { input, output, reasoning, cache: { read, write } }` — exact match.
- `SessionStatsInfo` has `sessions, subagents, prompts, steps, tokens, cost, tools, activity, models`
  — exact match; `tools: "summary"` is a valid enum value (`"none" | "summary" | "detail"`).
- `ctx.client.session.stats(input?)` exists as `stats(input?: SessionStatsInput)`.
- `ctx.theme` is a `ResolvedTheme`; `usePlugin()` exported from `@opencode/plugin/tui`.
- `r` is not bound by any default keybind (scanned the binary's keybind table), so a bare `r`
  refresh command has low conflict risk.
- Mockup arithmetic is self-consistent (12,340 + 3,210 + 1,870 + 45,000 = 62,420). ✔

The strategic decisions (reported-telemetry over tokenizers, modal dialog, repo layout, gotcha
mitigations) all look right. Dropping the tokenizer/vendor dependency chain alone eliminates most
of the pain documented in `reference/context_plugin_summary.md`.

---

## Findings — must fix before Build 🔴

### 1. `ctx.location.project.id` does not exist on the TUI context

Plan §3 says: `ctx.client.session.stats({ project: ctx.location.project.id, tools: "summary" })`.

In `@opencode/plugin@2.1.4` the **TUI** `Context.location` is:

```ts
readonly location: LocationRef | undefined   // may be undefined
type LocationRef = { directory: AbsolutePath; workspaceID?: WorkspaceID }  // no `project`!
```

(The `ctx.location.project.{id,canonical}` shape documented at `/v2/docs/build/plugins` applies to
the *server* plugin context, not the TUI one. The plan appears to have mixed the two.)

**Fix options (pick one, or verify `project` may simply be omitted):**

- `project` is optional in `SessionStatsInput` — first check whether omitting it defaults to the
  current directory's project server-side (likely; then just pass `{ tools: "summary" }`).
- If a project ID is required: from a session route use
  `ctx.data.session.get(sessionID)?.projectID` (`SessionInfo.projectID` exists), or resolve via
  `ctx.data.project.list()` matched against `ctx.location?.directory ?? ctx.data.location.default().directory`.
- Always guard `ctx.location` being `undefined` (docs pattern: `context.location ?? context.data.location.default()`).

Also confirm whether `SessionStatsInput.project` expects a `ProjectID` or a path — the type is just
`string`.

### 2. Assistant telemetry fields are **optional**

Plan §3 says assistant messages "carry `tokens` … `cost`". Actual types:

```ts
type SessionMessageAssistant = {
  ...
  cost?: MoneyUSD;      // optional
  tokens?: TokenUsageInfo;  // optional
  error?: ...; retry?: ...;
}
```

Error/retry/interrupted steps may have no `tokens`/`cost`. The aggregation layer must treat these
as `?? 0` (and decide whether such messages count as "steps" in the mockup's step count).
Similarly `SessionInfo.title?` is optional — the session selector needs an untitled fallback
(e.g. `Untitled · <relative time>`).

### 3. `dialog.show()` takes a thunk, not an element

Plan §4 writes `ctx.ui.dialog.show(<StatsView/>)`. The signature is:

```ts
show(render: () => JSX.Element, onClose?: () => void): void
```

Correct usage: `ctx.ui.dialog.show(() => <StatsView />)` (the docs example confirms). The optional
`onClose` is also the right place to dispose anything the dialog owns.

---

## Findings — should resolve in the plan 🟠

### 4. `family()` / double-counting semantics unspecified

`ctx.data.session.family(sessionID): string[]` almost certainly includes `sessionID` itself, and
includes the whole subtree. The plan should state:

- Filter `id !== sessionID` when listing subagents.
- Whether "SESSION total" (computed from the session's own messages) **excludes** subagent usage —
  it does, since subagent steps live in child sessions. The UI should say so explicitly
  ("Session (excl. subagents)") or show a combined line, otherwise users will read 62,420 and
  9,200 as overlapping or under-counted.
- Deduplicate if the family contains nested subagent trees.

### 5. Project-stats time window is undefined

`SessionStatsInput.from/to` are omitted in the plan, and `SessionStatsInfo` returns
`range: { from, to }`. The default window (likely a rolling 30 days or similar) must be verified
and **displayed** in the PROJECT section — "PROJECT · 4 sessions · 310k tk" without a window is
misleading. Suggested: render `range` as a subtitle, and/or pass explicit `from`/`to`.

### 6. `dialog.select` `search` contract

`search` "runs for every query, **including the empty one**, receives only enabled options, and
must return matching options in display order." So the callback must return the full option list
for `""` (not `undefined`/boolean), and always return option objects. Plan says "search by title"
— worth spelling out the empty-query case.

### 7. Escape-to-close for a **custom** JSX dialog is not documented

The docs guarantee Escape → `undefined` for the *promise* dialogs (`select/prompt/confirm`). For a
custom `dialog.show()` JSX dialog, auto-close-on-Escape is unconfirmed. Verify at runtime; if it
doesn't close, add a keymap layer inside `StatsView` binding `escape` → `ctx.ui.dialog.clear()`.
The mockup footer promises "esc close", so this should be an explicit verification step.

### 8. Refresh layer's `mode` / scope

`KeymapLayer.mode` defaults to `"base"`, not `"global"`. While a dialog owns input it's unclear
which mode is active. Recommend the in-dialog layer use `mode: "global"` (as the command layer
does) or a `target`, and verify `r` actually dispatches while the dialog is open. The `r`→
invalidate → await `sync` → recompute flow should also show some "refreshing" state since `sync()`
is async and can take a beat on long transcripts.

### 9. `install.sh` vs opencode's own `cli.json` writer

The binary acquires a lock file and rewrites `cli.json` itself (config migration/update path).
An installer that edits `cli.json` while opencode is running can race that writer. Recommend:
document "run installer while opencode is closed" (or re-check after start), keep the backup+idempotent
behavior, and note that legacy `tui.json`/`kv.json` are **auto-migrated** to `cli.json` by opencode —
the installer must not fight that migration (i.e. don't try to migrate `tui.json` itself).

Also: docs only show **package names** in `cli.json.plugins`; whether a local directory path is
accepted there is unconfirmed (the plan already schedules `opencode plugin list` verification and an
`opencode.json` `plugins` fallback — good, keep both).

---

## Findings — minor / polish 🟡

10. **`ModelRef` field naming**: it's `{ id, providerID, variant? }` — there is no `modelID` field
    on messages. Grouping "by `providerID/modelID`" should use `model.providerID` + `model.id`, and
    consider whether to split by `variant` too (the server's `SessionStatsModelUsage` may).
11. **Cache definition**: state whether CACHE = `cache.read + cache.write` or read-only; the mockup
    implies a single number that feeds TOTAL.
12. **Slash alias `usage`** is very generic — verify no collision via the palette /
    `opencode plugin list` after load (low risk, but it's user-facing).
13. **Perf note**: `message.sync()` loads the full transcript; very long sessions could make the
    first open sluggish. Consider rendering after sync with a loading state (ties into #8).
14. **Peer ranges**: plan's `>=0.6.6` matches the official docs example; `@opencode/plugin` itself
    declares peers at `>=0.6.8`. Either is fine — just be aware `plugin check`/installers may warn.
15. **`docs/plan.md` in the layout** vs the actual file living at `docs/tokens-usage-plugin.md` —
    reconcile names so the build doesn't create a duplicate.
16. The plan's mockup footer ("esc close · r refresh") should be mirrored in README usage docs.

---

## Suggested additions to the Verification steps

The existing 5 steps are good. Add:

6. `npx tsc --noEmit` (or the repo's `tsconfig.json` typecheck) passes — this is what would have
   caught findings #1–#3.
7. Escape actually closes the custom dialog; `r` actually dispatches while it's open (findings #7–#8).
8. `opencode plugin check` clean; palette shows `/tokens_usage` with no `usage` alias collision.
9. Explicit check of the PROJECT section's time window vs. raw `session.stats()` output (finding #5).
10. Re-run `./install.sh` twice (idempotency + backup) and confirm `opencode plugin list` after a
    fresh start, with opencode closed during the install (finding #9).

---

## Summary

| Area | Assessment |
|---|---|
| Strategy (telemetry, no LLM, no tokenizer deps) | Strong — eliminates the legacy dependency saga |
| API research accuracy | ~90% correct; 3 concrete errors (`location.project`, optional `tokens/cost`, `dialog.show` thunk) |
| Layout / distribution | Matches official docs' publish pattern; `cli.json` + `plugins` key confirmed |
| UX spec (dialog, selector, refresh) | Well designed; 4 runtime-behavior questions to verify (#5–#8) |
| Verification plan | Solid; add typecheck + escape/refresh/install-idempotency checks |

Fix the three 🔴 items in the plan text, resolve the 🟠 ambiguities (even just as explicit
"verify at runtime" notes), and the plan is ready for Build mode.