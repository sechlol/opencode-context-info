# Implementation Notes — Building a `/tokens_usage` TUI Plugin for OpenCode v2

> **Audience:** future plugin authors targeting OpenCode v2 (verified against **v2.1.4**,
> `@opencode/plugin@2.1.4`, `@opencode/client@2.1.4`, macOS, Node 24, no Bun).
> **What this documents:** the approach that reached a *working* `/tokens_usage` slash command —
> a fully script-based TUI dialog with session token statistics, zero LLM involvement —
> including everything that failed along the way and why.
>
> Companion documents: `docs/tokens-usage-plugin.md` (the plan), `docs/ds_review.md` and
> `docs/mimo_review.md` (independent reviews that caught real API errors before build).
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
tui.tsx          ROOT-LEVEL shim re-exporting src/tui.tsx  ← load detection reads this
```

- Import from `@opencode/plugin/tui`, **not** `@opencode-ai/plugin` (the v1 package — its
  npm `@opencode-ai/plugin@1.x` exports only `tool` and the old `api`-style TUI contract).
- Peer ranges matter: the *official docs example* says `@opentui/* >=0.6.6`, but
  `@opencode/plugin@2.1.4` itself declares `>=0.6.8`. Use the latter or npm ERESOLVEs.
- For a CLI-only plugin installed from a local path, **you don't need npm publish** — but you
  *do* need the discovery mechanism described in §3.

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
    ctx.ui.dialog.set({ size: "xlarge" })            // applies to the ACTIVE dialog; call right before show
    ctx.ui.dialog.show(() => <MyView .../>, onClose)  // onClose = dispose your state
    ctx.ui.dialog.clear()                            // close it yourself (e.g. on escape)

    // 5) Cached reactive data (no raw client calls needed for common reads)
    ctx.data.session.get(id) / .list() / .family(id) / .root(id)
    ctx.data.session.status(id) / .cost(id) / .sync(id) / .invalidate(id)
    ctx.data.session.message.list(id) / .sync(id) / .invalidate(id)
  },
})
```

Data shapes worth pinning (from `@opencode/client@2.1.4` types):

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
  inside the dialog lifecycle, and dispose in `dialog.show`'s `onClose`.
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
  The service boots once and **caches its config**. Editing `opencode.json` and restarting the
  TUI is *not* enough for server-side config — the service must restart too. TUI-side plugin
  registration happens in the TUI process (role=cli) during its plugin reconciliation.
- `opencode plugin list` lists **server** plugins only. It is not evidence about CLI plugins.
- `opencode run --standalone` boots a *fresh* server that reads current config — the cleanest
  way to test server-side plugin loading without touching the running service.
- TUI-side verification ultimately requires the real TUI. Don't burn hours trying to drive it
  from scripts; screen-scraping a pty is unreliable (input timing, 12KB scrollback caps).
- **Never `pkill -f opencode`** — it matches the user's own running session. If you must spawn
  throwaway instances, make them self-terminate (`perl -e 'alarm N; exec @ARGV' …`, since macOS
  has no GNU `timeout`) and never kill by name.

---

## 2. What we tried, and why it didn't work

### Attempt 1 — `cli.json` with a local path (rev 1 plan)

```jsonc
// ~/.config/opencode/cli.json
{ "plugins": ["/absolute/path/to/repo"] }
```

**Result: never loaded.** TUI debug logs showed the CLI plugin reconciliation running (13
builtin `opencode.*` plugins set up) but our path was never discovered, never set up, no error
logged. The `cli.json` schema does have a `plugins` array, and the docs say CLI-only packages
are configured there — but on 2.1.4 a **local directory path** entry is inert.

*Post-mortem:* the docs example only ever shows **package names** in `cli.json.plugins`
(`"opencode-acme-plugin"`). Local-path support there is undocumented/unverified, and in this
build absent.

### Attempt 2 — `opencode.json` `plugins` with a local path (rev 3 fix)

```jsonc
// ~/.config/opencode/opencode.json
{ "$schema": "https://opencode.ai/config.json", "plugins": ["/absolute/path/to/repo"] }
```

**Result: also never loaded — and silently.** A trace-level log of a *fresh* standalone boot
(one that provably read this same config file — the `mcp` section in it connected) contained
**zero** attempts to resolve our path. The supervisor never received the entry at all, so it
isn't a load failure; config-file local-path entries simply aren't wired up in 2.1.4.

*Post-mortem:* the v2 docs' `plugins` examples show package names, npm specs, and `./relative`
local paths. Whether relative paths work was not tested (our entry was absolute); a relative
entry resolved against the *config directory* might behave differently. What *is* proven:
config-file entries are the wrong mechanism for local development on 2.1.4.

### Attempt 3 — driving the TUI from scripts to "verify" the command

`script`/`expect` driving a pty, typing `/tokens_usage` + Enter, screen-scraping output.

**Result: unreliable and harmful.** Enter delivery was flaky; the `script` scrollback capped at
12KB so post-keystroke frames were cut off; and the cleanup (`pkill -f "^opencode$"`) killed the
user's own running CLI twice. Abandoned in favor of: fresh standalone boots for *loading*
verification, and the human user for *interaction* verification.

---

## 3. The fix that made it work (rev 4)

**Directory auto-discovery under `~/.config/opencode/plugins/`.** This is the mechanism the
legacy community plugin already used successfully on this machine, and it's what the binary
actually implements. Reading `PluginModule.load` in the binary (via `strings`) shows a directory
target is inspected and yields a feature record `{ server, tui?, rpc? }`:

- `<dir>/index.ts` — the **server entry** (only this file is loaded as a server plugin; loose
  support files in the directory are *not* separately loaded — that's a feature, see gotchas)
- `<dir>/tui.tsx` — presence at the **directory root** marks the **TUI feature**, activating
  the CLI plugin on the TUI side
- (`rpc` analogous; not used here)

Our sources live in `src/`, so the installer writes two one-line **shims** into the deployed
directory:

```ts
// ~/.config/opencode/plugins/tokens-usage/index.ts
export { default } from "/abs/path/to/repo/src/index.ts"

// ~/.config/opencode/plugins/tokens-usage/tui.tsx
export { default } from "/abs/path/to/repo/src/tui.tsx"
```

`install.sh` deploys these (with `--dry-run` / `--target` / `--uninstall`), warns about stale
config-file registrations, and is idempotent. Verification that it works:

```
$ opencode --print-logs run … (fresh standalone boot)
msg="loading plugin" id=/Users/loaf/.config/opencode/plugins/tokens-usage
                     entrypoint=file:///…/tokens-usage/index.ts
```

…with no load errors, and the slash command appearing in the TUI.

**Package-name alternative:** the same directory convention works if you copy the package into
`plugins/`, or (untested here) you publish to npm and register by name in the config files —
the docs' package-name examples are the *supported* path for distribution; local paths in
config files are what's broken on 2.1.4.

---

## 4. Documentation errors that misled us

1. **`cli.json` "Configure a CLI-only package in cli.json"** — true for *published package
   names*, but the docs never say local paths don't work there on 2.1.4. We assumed path
   entries were supported because the schema accepts strings. **Cost: a full attempt cycle.**
2. **`opencode.json` `plugins` with `./plugins/local` style local paths** — the docs show this
   form prominently. On 2.1.4, a *local directory path* entry is silently ignored (no load
   attempt, no error). **Cost: a second attempt cycle, and a misleading "it works on the docs"
   confidence.** (Relative-path forms may work; absolute paths provably don't.)
3. **Peer dependency ranges** — the docs' `package.json` example says `@opentui/core >=0.6.6`,
   but `@opencode/plugin@2.1.4` declares `>=0.6.8` and npm hard-fails resolution on the lower
   pin. Use the version the plugin package itself declares.
4. **`docs` vs reality for `dialog.show`** — the docs' prose is fine, but the plan's pseudocode
   (`dialog.show(<StatsView/>)`) was wrong: the signature is
   `show(render: () => JSX.Element, onClose?)`. Two reviews caught this pre-build. The lesson:
   **verify every API against the installed type definitions** (`node_modules/@opencode/plugin/dist/tui/*.d.ts`
   and `@opencode/client`'s `dist/promise/generated/types.d.ts`), not against docs or memory.
5. **`ctx.location.project`** — the *server* plugin docs show `ctx.location.project.{id,canonical}`;
   the TUI context's `location` is a bare `LocationRef`. Mixing the two contexts is easy and
   typechecking catches it only if the types are actually installed and checked.
6. **General docs gap:** nothing in the docs describes the *directory feature-detection*
   convention (`index.ts` = server, `tui.tsx` = TUI). It's only discoverable from the binary or
   from community plugins. This is the single most load-bearing fact for local TUI plugin
   development, and it's undocumented.

---

## 5. Gotchas and best practices (collected)

### Loading & discovery
- **Directory plugins load only their `index.ts`.** Loose `.ts`/`.mjs`/`.json` files sitting in
  `~/.config/opencode/plugins/` get picked up *as plugins* and fail
  (`Plugin must export a default definition…`). Keep support files inside a directory whose
  entry point is the plugin, or outside `plugins/` entirely.
- **TUI feature = `tui.tsx` at the directory root.** Without it, the server plugin loads but
  the slash command never appears in the TUI.
- **The background service caches config.** After any config change: restart the *service*
  (or use `--standalone` to verify with a fresh process), not just the TUI.
- Plugin-load failures from a stale service can persist after you fix the files
  (`Cannot find package` etc.). `touch` the file to force a watcher reload; verify with a fresh
  process. Check `~/.local/share/opencode/log/opencode.log` timestamps before assuming a fix failed.
- `/reload` is the first thing to try after changing plugin code; a full restart is the fallback.

### API & typing
- Install `@opencode/plugin` and `@opencode/client` as real dependencies and **typecheck
  against them** (`tsc --noEmit`). It caught three real API errors in our plan before any code
  was written: `ctx.location.project` (doesn't exist on TUI), optional `tokens`/`cost`,
  `dialog.show` thunk signature.
- Optional-field discipline: `tokens?`, `cost?`, `title?` are real in production data
  (in-progress steps, errored steps, untitled sessions). Guard everything; decide explicitly
  how in-progress/errored steps appear in the UI vs totals.
- `search` in `dialog.select` runs for **every query including the empty one** and must return
  the full option list in display order for `""`.
- `dialog.set({ size })` applies to the *active* dialog — call it immediately before `show`.
- `SessionListInput` supports server-side filtering (`parentID: null`, `archived`, `directory`,
  `project`, `order`, `limit`) — prefer it over filtering the ~50-entry client cache when you
  need a session list.
- `family(sessionID)` may include the session itself and nested descendants; dedupe via
  `root(sessionID)` and exclude self, or you'll double-count subagent usage.

### TUI / OpenTUI
- `<span>` props ≠ `<text>` props (see §1.4). When in doubt, read the reconciler:
  `node_modules/@opentui/solid/index.js` → `setProperty`.
- `xlarge` dialogs overflow an 80×24 terminal. Check the renderer width and fall back to
  `large`; put scrollable content in a `scrollbox`; always render the numeric value next to a
  bar (never color/length alone).
- Use semantic theme tokens where possible; if you must use hex (as we did for category colors),
  verify contrast in both light and dark themes.

### Process & safety
- Two common sources of "my plugin randomly broke": the stale background service (§1.6) and
  **npm peer conflicts** at install time (pin the exact peer versions the plugin package uses).
- Node 24 runs TypeScript tests directly via type stripping (`node --test "test/*.test.ts"` —
  note: pass a glob, *not* a directory; `node --test test/` fails with MODULE_NOT_FOUND).
  Keep the tested layer pure so you never need a TUI to test logic.
- When debugging plugin loading: `opencode plugin list` (server-side, against the *running*
  service), `opencode --print-logs --log-level debug run --standalone …` (fresh-process truth),
  and the log file at `~/.local/share/opencode/log/opencode.log` (cross-check timestamps —
  stale error lines predate your fix).
- Strings in the binary are a legitimate last-resort API reference when docs and types disagree
  (`strings ~/.opencode/bin/opencode | grep …`). It's how the directory feature-detection
  convention was confirmed. Careful: output is enormous — always pipe through `grep -oE`.

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
- Whether config-file `plugins` entries support relative paths or only package names on 2.1.4
  (absolute local paths are confirmed inert).
- Event-driven auto-refresh while the dialog is open (`data.on("session.execution.succeeded")`
  debounced) — `r` manual refresh is the current baseline.
- npm publish + `cli.json` package-name registration as the stable distribution path; the
  current shim install is machine-specific by design and re-runs after a repo move.
