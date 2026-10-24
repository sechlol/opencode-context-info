# Implementation Notes — Building a `/tokens_usage` TUI Plugin for OpenCode v2

> **Audience:** future plugin authors targeting OpenCode v2 (verified against **v2.1.4**,
> `@opencode/plugin@2.1.4`, `@opencode/client@2.1.4`, macOS, Node 24, no Bun).
> **What this documents:** the approach that reached a *working* `/tokens_usage` slash command —
> a fully script-based TUI dialog with session token statistics, zero LLM involvement —
> including everything that failed along the way and why.
> **Claims below are verified against OpenCode v2.1.4.** The full evidence and verdicts live in
> `docs/discrepancies_verification.md` (V1–V10), which is the source of truth; this guide
> cross-references those V-numbers instead of restating the proofs.
>
> Working code: `src/`, `install.sh`, `test/`.

---

## 1. The correct way to implement a plugin for OpenCode (v2.1.4, verified)

### 1.1 Decide: server plugin, CLI plugin, or both

OpenCode v2 has two distinct plugin kinds, loaded from different places and running in
different processes:

| Kind | Import | Runs in | Can do |
|---|---|---|---|
| **Server plugin** | `@opencode/plugin` | the server process | tools, hooks (`session.hook`), transforms (providers/models/commands/agents…), `ctx.client` API access, `ctx.location.project` |
| **CLI (TUI) plugin** | `@opencode/plugin/tui` | the TUI process | slash/palette commands via `keymap.layer`, dialogs, slots, routes, toasts, cached reactive data (`ctx.data.*`), `ctx.client` |

Our plugin is **CLI-only**: the entire feature is a slash command that opens a dialog.
The server-side entry (`src/index.ts`) exists only because publishing requires a main export —
it is a no-op `Plugin.define({ id, setup() {} })`. (`setup` is **required**; `{ id }` alone
fails the definition schema.)

### 1.2 Package layout that loads

```
package.json     "type": "module"
                 exports: { ".": "./src/index.ts", "./tui": "./src/tui.tsx" }
                 dependencies:  @opencode/plugin, @opencode/client
                 peerDeps:      @opentui/core >=0.6.8, @opentui/solid >=0.6.8,
                                solid-js >=1.9.0, @opencode/theme 2.1.4
src/index.ts     server entry (no-op)
src/tui.tsx      CLI plugin: Plugin.define({ id, setup(ctx) })
index.ts         ROOT-LEVEL shim re-exporting src/index.ts  ← required: a config-path
                 plugin directory must contain an `index` (or `server`) module at its
                 root, or the whole directory is silently skipped (V1b)
tui.tsx          ROOT-LEVEL shim re-exporting src/tui.tsx   ← the TUI entrypoint the
                 CLI-side feature detection picks up for a directory entry
```

- Import from `@opencode/plugin/tui`, **not** `@opencode-ai/plugin` (the v1 package — its
  npm `@opencode-ai/plugin@1.x` exports only `tool` and the old `api`-style TUI contract).
- Peer ranges matter: the *official docs example* says `@opentui/* >=0.6.6` and is **wrong** —
  `@opencode/plugin@2.1.4` itself declares `>=0.6.8` (plus an `@opencode/theme` peer the docs
  example omits), and npm hard-fails with ERESOLVE on any `@opentui/*` in `[0.6.6, 0.6.8)` (V4).
  Use `>=0.6.8` + `@opencode/theme 2.1.4` — the ranges the plugin package declares.
- For a CLI-only plugin installed from a local path you don't need npm publish — **multiple
  mechanisms work and are documented**: config-file path registration, `cli.json` paths for
  CLI-only plugins, and directory auto-discovery. All of them are in §3.

### 1.3 The v2 TUI API that actually works (all verified live)

```ts
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "your.plugin.id",
  setup(ctx) {
    // 1) Register a slash command (this is how you get an LLM-free command!)
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "my.command", title: "...", group: "...",
        palette: true,
        slash: { name: "my_command", aliases: ["alias"] },
        run: () => { /* pure script, no prompt turn */ },
      }],
    }))

    // 2) Know where the user is
    const route = ctx.ui.router.current()
    // { type: "home" } | { type: "session", sessionID } | { type: "plugin", ... }

    // 3) Promise-based selector (escape resolves undefined)
    const picked = await ctx.ui.dialog.select({ title, options, search })

    // 4) Custom dialog — show() takes a THUNK, not JSX
    ctx.ui.dialog.show(() => <MyView .../>, onClose)  // onClose = dispose your state
    ctx.ui.dialog.set({ size: fittedDialogSize(ctx) }) // MUST be called immediately AFTER
                                             // show() returns — set-before-show is a silent
                                             // no-op on 2.1.4 (the docs show the wrong
                                             // order; V9)
    ctx.ui.dialog.clear()                   // close it yourself (e.g. on escape)

    // 5) Cached reactive data (no raw client calls needed for common reads)
    ctx.data.session.get(id) / .list() / .family(id) / .root(id)
    ctx.data.session.status(id) / .cost(id) / .sync(id) / .invalidate(id)
    ctx.data.session.message.list(id) / .sync(id) / .invalidate(id)

    // 6) Documented event API — returns an unsubscribe function:
    const stop = ctx.data.on("session.execution.succeeded", handler)
    //    we use it (debounced) for auto-refresh while the dialog is open, and
    //    call stop() from the cleanup function returned by setup().

    // 7) Inside dialog/slot/route components, get at ctx with:
    //    import { usePlugin } from "@opencode/plugin/tui"   →  const ctx = usePlugin()
  },
})
```

Dialog geometry, pinned by emulator-measured pty transcripts (V9): size presets are **fixed
column widths** — medium 60 / large 88 / xlarge 116 — chosen by fitting `ctx.renderer.width`,
and `show()` dialogs are **horizontally centered by default**, even with no `set({centered})`.

Data shapes worth pinning (from `@opencode/client@2.1.4` types):

- `client.session.list(...)` returns `SessionsResponse = { data: SessionInfo[], cursor }` —
  there is **no `sessions` key** at either level. Guessing `{ sessions }` (in code *and* in the
  test mock) made the selector always return `[]` (V10).
- `TokenUsageInfo = { input, output, reasoning, cache: { read, write } }` — on assistant
  messages **and on `SessionInfo`** (authoritative session totals).
- `SessionMessageAssistant.tokens` and `.cost` are **optional** (in-progress / errored /
  retried steps may lack them). Same for `SessionInfo.title`.
- `ModelRef = { id, providerID, variant? }` — there is **no `modelID` field**; group models by
  `${providerID}/${id}` and consider `variant`.
- Compaction messages (`type: "compaction"`, `status: "completed" | "failed"`) also carry
  optional `tokens`/`cost` — don't drop them from usage accounting.
- `client.session.stats({ project?, from?, to?, tools? })` is an **experimental** endpoint;
  `tools: "detail"` is required to get per-tool usage (`"summary"` returns only totals). It
  returns a `range` you should display.
- The TUI `ctx.location` is `LocationRef | undefined = { directory, workspaceID? }` — **no
  `.project`** (that exists only on the server plugin context). Resolve a project ID via
  `data.session.get(id)?.projectID` or `client.location.get({ location: { directory } })`.

### 1.4 Inside JSX (OpenTUI + Solid)

- Add `/** @jsxImportSource @opentui/solid */` to every `.tsx` (the loader does not read
  `tsconfig.json`'s `jsxImportSource`; keep both anyway).
- **`<text>` accepts `fg`/`bg`/`attributes` directly; `<span>` does NOT** — the reconciler
  only maps `style` and `href` onto text nodes. Use `<span style={{ fg: "#..." }}>`. A bare
  `<span fg>` is silently ignored (typecheck catches this only if you're lucky).
- Custom JSX dialogs have **no guaranteed escape-to-close**. Bind it yourself:
  `ctx.keymap.layer(() => ({ mode: "global", priority: 100, commands: [{ id, bind: "escape", run: () => ctx.ui.dialog.clear() }] }))`
  inside the dialog lifecycle, and dispose in `dialog.show`'s `onClose`. A layer created inside
  the dialog component itself is disposed automatically when the dialog closes (documented
  lifecycle) — which is why we attach the in-dialog bindings there.
- Keymap layers default to `mode: "base"`; while a dialog owns input that may not be the active
  mode. Use `mode: "global"` (+ `priority`) for in-dialog bindings.
- Wrap your view in a Solid `ErrorBoundary` — an unhandled render exception in a TUI plugin can
  take down the whole interface.

### 1.5 Data-flow architecture that pays off

Split I/O from computation; it made the aggregation layer fully unit-testable without a TUI:

```
src/data.ts    async I/O + normalization (only module that knows OpenCode schemas;
               Promise.allSettled so partial failures degrade to warnings)
src/stats.ts   PURE aggregation over an internal record model — no ctx, no client
src/format.ts  PURE formatting (deterministic, locale-independent — no Intl)
src/types.ts   view-model types independent of OpenCode schemas
src/view.tsx   presentational components only
src/tui.tsx    command registration, routing, dialog lifecycle, state signal
```

Token-accounting lessons baked into `stats.ts`:

- Categories (input/output/reasoning/cache) are **not universally disjoint** across providers.
  Don't present a grand "TOTAL" as fact; show components, make **cost** the headline, and
  reconcile message-derived attribution against the authoritative `SessionInfo` totals with an
  explicit "other/auxiliary" row.
- `cache.read` and `cache.write` have different pricing — never collapse them into one bar.
- If your plugin is about "context", show **context-window occupancy** (last completed step's
  `input + cache.read + cache.write` vs the model's `limit.context`) as a *separate* metric from
  cumulative session usage. They answer different questions and users conflate them.

### 1.6 Process model and verification

- The TUI is a **thin client over a long-running background service** (`opencode serve --service`).
  TUI-side plugin registration happens in the TUI process (role=cli) during its plugin
  reconciliation. Config changes in watched config directories **hot-reload automatically** —
  verified live on the running service: a `plugins` entry added to `opencode.json` was picked
  up and loaded with no restart whatsoever (V6). Restart the service only for unwatched local
  dependencies or when you suspect a stale cache; `/reload` in the TUI is the first thing to
  try, and a fresh process is the tiebreaker.
- `opencode plugin list` shows server-loaded plugins **and** local config/discovery entries —
  a `cli.json`-only entry appears with ID `-` — so it *is* evidence about local registration;
  `plugin check` covers server and TUI-only package plugins (V5).
- `opencode run --standalone` boots a *fresh* server that reads current config — the cleanest
  way to test server-side plugin loading without touching the running service. Methodology
  lesson from V1: plugins load at **location activation** (a session/request), not during idle
  boot. An idle `serve` shows zero plugin lines, and `run` without a message exits immediately
  with `Error: You must provide a message` — a boot-only trace showing "zero attempts" proves
  nothing about whether an entry was wired up.
- TUI-side verification: driving *input* from scripts stays unreliable — leave interaction
  verification to the human (see Attempt 3). Static *rendering*, however, CAN be verified
  reliably: a probe plugin can auto-open UI from `setup()` with no input at all, record the pty
  transcript, and replay it through a terminal emulator (pyte) to measure rendered frames —
  that is exactly how the `dialog.set()` behavior was pinned (V9).
- **Never `pkill -f opencode`** — it matches the user's own running session. If you must spawn
  throwaway instances, make them self-terminate (`perl -e 'alarm N; exec @ARGV' …`, since macOS
  has no GNU `timeout`) and never kill by name.

---

## 2. What we tried, and why it didn't work

> **Retraction.** An earlier revision of this document claimed that local paths in `cli.json`
> (Attempt 1) and `opencode.json` (Attempt 2) were inert on 2.1.4. Both conclusions were
> **disproven**: all config-file local-path forms work — absolute, `file://`, and relative, in
> both `opencode.json` and `cli.json` (V1/V2). For Attempt 2 the methodology error was pinned
> down: a boot-only trace that never reached location activation (reproduced — an idle `serve`
> logs no plugin lines at all, and `run` without a message exits before loading anything, V1).
> For Attempt 1 the cause was never pinned down (plausible: inspecting a TUI that started
> before the `cli.json` edit, or watching the wrong config file — V2). The two attempt
> write-ups have been removed; see V1/V2 for the evidence.

### Attempt 3 — driving the TUI from scripts to "verify" the command

`script`/`expect` driving a pty, typing `/tokens_usage` + Enter, screen-scraping output.

**Result: unreliable and harmful.** Enter delivery was flaky; the `script` scrollback capped at
12KB so post-keystroke frames were cut off; and the cleanup (`pkill -f "^opencode$"`) killed the
user's own running CLI twice. Abandoned in favor of: fresh standalone boots for *loading*
verification, the human user for *interaction* verification — and, for static rendering only,
the auto-open-from-`setup()` + emulator-replay technique described in §1.6 (V9), which needs no
input driving at all.

---

## 3. Loading mechanisms that work (all verified)

### 1. Config-file registration (what `install.sh` does now)

```jsonc
// ~/.config/opencode/opencode.json
{ "plugins": ["/abs/path/to/repo"] }
```

The server loads the directory's `index` module (our root `index.ts` shim). The CLI then reads
and sets up the directory's `tui.tsx` automatically via the server-reported plugin list, so
**no `cli.json` entry is needed**. Verified end-to-end against a dedicated server + TUI:

```
stage=read  target=<repo> entrypoint=<repo>/tui.tsx   role=cli
stage=setup plugin=loaf.tokens-usage                  role=cli
```

Config changes hot-reload — no restart (V6); `/reload` in the TUI if the slash command doesn't
appear yet.

`install.sh`'s current behavior: it atomically merges the repo path into the `plugins` array of
`opencode.json` (idempotent, refuses to touch a config that isn't valid JSON, preserves the
file's mode), migrates the legacy generated-shim directory (removed only when its files carry
the old installer's marker — foreign directories are left alone with a warning), and supports
`--dry-run`, `--uninstall`, `--config FILE`, `--legacy-dir DIR`.

### 2. Directory auto-discovery (documented — no longer a binary-only secret)

The docs (Plugins → **Discover**, and `/cli/plugins`) now describe the convention explicitly:

```
~/.config/opencode/plugins/<name>/     entry: index.ts OR server.ts
<project>/.opencode/plugins/<name>/   TUI marker: tui.ts OR tui.tsx
```

Both locations and both marker spellings were verified functionally (V3), including the
`server.ts`-only variant (V1b). Two caveats the docs don't state: a directory with **neither**
`index` nor `server` is **silently skipped**, and `package.json` `exports` is **not consulted**
for config-path directories (V1b) — hence the root shims in §1.2. The docs also say direct
`.ts`/`.js` files in the plugins dir are loaded *as plugins*, so keep support files inside your
plugin directory rather than loose next to it.

### 3. `cli.json` local paths for CLI-only plugins (documented and verified)

`/cli/plugins` shows `./…`, `/…` and `file://…` entries right in the example, and V2 verified
them: `{"plugins": ["<abs dir>"]}` in `~/.config/opencode/cli.json` makes the CLI read and set
up the directory's `tui.*` entry (`stage=read … role=cli`, marker written in the CLI process).
Note `index.ts` is *not* read CLI-side — it's the server entry only. Not needed if you use
mechanism 1, but genuinely useful for CLI-only plugins.

### 4. Package-name registration (npm publish)

Still the docs' distribution path for sharing: publish to npm, then register by package name in
`opencode.json` / `cli.json`. Untested here.

---

## 4. Documentation errors that misled us

Only errors that survived independent verification — full evidence in
`docs/discrepancies_verification.md`:

1. **Peer dependency example.** The docs' `package.json` example says `@opentui/* >=0.6.6`, but
   `@opencode/plugin@2.1.4` declares `>=0.6.8` (and the example omits the `@opencode/theme`
   peer entirely). Installing any `@opentui/*` in `[0.6.6, 0.6.8)` hard-fails with ERESOLVE —
   reproduced on npm 12.2.0 / Node 24 (V4). Use the ranges the plugin package itself declares.
2. **`dialog.set` shown before `dialog.show`** in the "Dialogs and toasts" example. On 2.1.4
   that ordering is a **silent no-op** — dialogs stay on the default 60-column preset. The
   working order is `show(...)` → `set(...)` immediately after. The docs also don't say that
   presets are fixed column widths (medium 60 / large 88 / xlarge 116) or that `show()`
   dialogs are horizontally centered by default (V9).
3. **Minor gaps.** The docs don't say that a config-path directory lacking **both** `index` and
   `server` is silently skipped (nor that package `exports` aren't consulted for such
   directories — V1b); and their examples show only `tui.ts` although `tui.tsx` works too
   (both verified, V3).

---

## 5. Gotchas and best practices (collected)

### Loading & discovery
- **Directory plugins load only their entry module** (`index`/`server` server-side, `tui.*`
  CLI-side). The docs say direct `.ts`/`.js` files in `~/.config/opencode/plugins/` are loaded
  as plugins too (V3) — so loose support files sitting there get picked up and fail
  (`Plugin must export a default definition…`). Keep support files inside a directory whose
  entry point is the plugin, or outside `plugins/` entirely. (`.mjs`/`.json` behavior was
  observed but not separately verified; the docs only promise `.ts`/`.js`.)
- **TUI feature = `tui.ts` OR `tui.tsx` at the directory root.** Both verified working; the
  docs show `tui.ts`. Without one, the server plugin loads but the slash command never appears
  in the TUI.
- **Config changes hot-reload** — watched config directories reload automatically, verified on
  the live service (a `plugins` entry added to `opencode.json` loaded with no restart, V6). No
  service restart for config edits; restart only for unwatched local dependencies or stale-cache
  confusion, and prefer `/reload` / a fresh process (below).
- Plugin-load failures from a stale service can persist after you fix the files
  (`Cannot find package` etc.). `touch` the file to force a watcher reload; verify with a fresh
  process. Check `~/.local/share/opencode/log/opencode.log` timestamps before assuming a fix failed.
- `/reload` is the first thing to try after changing plugin code; a full restart is the fallback.

### API & typing
- **Verify every API against the installed type definitions** —
  `node_modules/@opencode/plugin/dist/tui/*.d.ts` and `@opencode/client`'s generated types —
  not against docs or memory. It caught the `dialog.show` thunk signature, the optional
  `tokens`/`cost` fields, and (later) the real `session.list` response shape (V10).
- Install `@opencode/plugin` and `@opencode/client` as real dependencies and **typecheck
  against them** (`tsc --noEmit`). It caught three real API errors in our plan before any code
  was written: `ctx.location.project` (doesn't exist on TUI), optional `tokens`/`cost`,
  `dialog.show` thunk signature.
- Optional-field discipline: `tokens?`, `cost?`, `title?` are real in production data
  (in-progress steps, errored steps, untitled sessions). Guard everything; decide explicitly
  how in-progress/errored steps appear in the UI vs totals.
- `search` in `dialog.select` runs for **every query including the empty one** and must return
  the full option list in display order for `""`.
- `dialog.set({ size })` applies to the *active* dialog — call it immediately **after** `show()`
  returns; before `show()` it is silently ignored on 2.1.4 (docs order is wrong, V9).
- `SessionListInput` supports server-side filtering (`parentID: null`, `archived`, `directory`,
  `project`, `order`, `limit`) — prefer it over filtering the ~50-entry client cache when you
  need a session list. The response is `{ data, cursor }` — read `res.data` (V10).
- `family(sessionID)` may include the session itself and nested descendants; dedupe via
  `root(sessionID)` and exclude self, or you'll double-count subagent usage.

### TUI / OpenTUI
- `<span>` props ≠ `<text>` props (see §1.4). When in doubt, read the reconciler:
  `node_modules/@opentui/solid/index.js` → `setProperty`.
- Size presets are fixed columns (60 / 88 / 116) — pick the largest that fits
  `ctx.renderer.width` (`>=120` → xlarge, `>=92` → large, else medium); don't guess terminal
  proportions. Wrap long content in a `<scrollbox>` with the footer line outside it: the host
  dialog bounds only the **width** (no height), so the scrollbox must carry its own
  terminal-derived `maxHeight` (e.g. `renderer.height` minus the rows reserved for paddings,
  gap and footer; reactive to resize; omit the bound if the renderer is unavailable so content
  flows instead of collapsing) — and route `gap` through `contentOptions`, because the
  scrollbox root is a row layout (top-level `gap` would space wrapper↔scrollbar, not
  sections). Always render the numeric value next to a bar (never color/length alone).
- Use semantic theme tokens for coloring (`usePlugin().theme`) — the current code uses them
  throughout, including category colors from `theme.categorical`; if you ever fall back to hex,
  verify contrast in both light and dark themes.

### Process & safety
- Two common sources of "my plugin randomly broke": a stale background service (§1.6) and
  **npm peer conflicts** at install time (pin the exact peer versions the plugin package uses).
- Node 24 runs TypeScript tests directly via type stripping (`node --test "test/*.test.ts"` —
  note: pass a glob, *not* a directory; `node --test test/` fails with MODULE_NOT_FOUND).
  Keep the tested layer pure so you never need a TUI to test logic.
- When debugging plugin loading: `opencode plugin list` (shows server-loaded plugins *and*
  local config/discovery entries, so it's evidence about local registration — V5),
  `opencode --print-logs --log-level debug run --standalone …` (fresh-process truth), and the
  log file at `~/.local/share/opencode/log/opencode.log` (cross-check timestamps — stale error
  lines predate your fix).
- Strings in the binary are a genuine **last-resort** API reference when docs and types disagree
  (`strings ~/.opencode/bin/opencode | grep …`) — but note the directory feature-detection
  convention is now documented (V3), so start with the docs. Careful: output is enormous —
  always pipe through `grep -oE`.

### Design
- A slash command registered via a CLI plugin's `keymap.layer` **does not enter the prompt
  loop** — this is the correct v2 answer to the v1-era gap where server-side commands always
  cost an LLM turn. Pure-script commands belong in CLI plugins, period.
- Reuse opencode's own recorded data instead of recomputing it. Our v1-era predecessor
  re-tokenized every message with js-tiktoken + HuggingFace transformers (~1.5 GB model cache,
  fragile model→tokenizer mapping for OpenRouter slugs). The v2 telemetry (`tokens`, `cost` on
  messages and sessions) made all of that disappear — fewer deps, exact numbers, instant open.

---

## 6. Open questions / future work

- Whether `SessionInfo.tokens` for a parent includes subagent usage (we display subagents
  separately and never add them into session totals, so either answer renders honestly).
- Whether `dialog.set()` before the promise-based `select()` has any effect — **unverified**:
  the select frame has no measurable borders, so the stats selector was left at the host
  default size rather than guessing (V9).
- Whether the terminal-derived scrollbox bound (`renderer.height − 6`) holds up on a small
  80×24 terminal — the formula scales with the renderer, but measurements were taken at
  140×40; mouse-wheel scrolling is also unverified (pty injection can't deliver it).
- npm publish + `cli.json` package-name registration as the stable distribution path; the
  current config-path install stores the repo's absolute path, so it is machine-specific by
  design and must be re-run after a repo move.