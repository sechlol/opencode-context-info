# Discrepancies Verification — `docs/implementation_notes.md` vs the OpenCode v2 documentation

> **Date:** 2026-10-24 (evening, +0300)
> **Environment:** OpenCode **v2.1.4** (`opencode --version`; also npm `latest` for
> `@opencode/plugin`, i.e. the same version the live docs at <https://opencode.ai/v2/docs>
> describe), macOS, Node v24.22.0, npm 12.2.0.
> **Goal:** independently re-verify every contradiction between the implementation notes and
> the official documentation, *assuming the docs are correct*, then refactor the code towards
> the documented behavior where the implementation is wrong, and collect report-ready evidence
> where the docs are wrong.
>
> **Safety constraints observed throughout:** no process was ever killed by name (`pkill` was
> never used — the user's two running TUIs and background service were live throughout);
> experiments used isolated config directories (`OPENCODE_CONFIG_DIR`) or self-terminating
> processes (`perl -e 'alarm N; exec …'`); the one experiment that had to touch the user's real
> `~/.config/opencode/opencode.json` was restored **byte-identical** (verified by `diff`) with
> the `mcp` section intact.

## Summary of verdicts

| # | Claim in `implementation_notes.md` | Docs say | Verdict |
|---|---|---|---|
| V1 | §4.2 / Attempt 2: absolute local paths in `opencode.json` `plugins` are *silently ignored* on 2.1.4 | Configure: absolute paths, `file://` URLs and relative paths load | **Docs correct — notes wrong** |
| V2 | §4.1 / Attempt 1: local directory paths in `cli.json` are *inert*; docs "only ever show package names" there | `/cli/plugins` shows `./…`, `/…` and `file://…` path entries in `cli.json` | **Docs correct — notes wrong** |
| V3 | §4.6: the directory feature-detection convention (`index.ts` = server, `tui.*` = TUI) is *undocumented* | `/plugins` Discover + `/cli/plugins` document `~/.config/opencode/plugins/`, `<project>/.opencode/plugins/`, and the `index.ts` + `tui.ts` layout | **Docs correct — notes wrong** (both `tui.ts` and `tui.tsx` work) |
| V4 | §4.3: docs example says `@opentui/* >=0.6.6` but `@opencode/plugin@2.1.4` needs `>=0.6.8`; npm hard-fails | package.json example: `"@opentui/core": ">=0.6.6"` | **Docs wrong — notes correct** (ERESOLVE reproduced; evidence below) |
| V5 | §1.6: `opencode plugin list` lists *server* plugins only | Manage/`check`: plugin CLI covers "server and TUI-only package plugins" | **Docs roughly correct — notes wrong** (`list` shows `cli.json` and discovery entries) |
| V6 | §1.6/§5: the service *caches* config; you must restart the **service** after config changes | Reload: "Changes under watched config directories reload automatically" | **Docs correct — notes wrong** (hot-reload proven on the live service) |
| V7 | §4.4: `dialog.show` takes a thunk (`render: () => JSX.Element`) | CLI docs example: `show(() => <box>…, onClose)` | **Both agree** (verified in installed `.d.ts`) |
| V8 | §4.5: server `ctx.location.project.{id,directory,canonical}` vs bare/optional TUI `location` | `/build/plugins` shows `.project` on the server context | **Both agree** (verified in installed `.d.ts`) |
| V9 | (n/a — found while implementing the stats dialog) | `dialog.set({size, centered})` is shown *before* `dialog.show()` | **Docs wrong — evidence captured** (set-before-show is a no-op on 2.1.4) |

**Net result:** 6 of the notes' documentation claims are disproven, 2 are confirmed accurate
(V7/V8, both agreeing with the docs), and exactly **one real documentation error** was found
(V4 — the peer-dependency example).

---

## V1 — local paths in `opencode.json` `plugins`

**Claim (notes, Attempt 2 / §4.2):** "config-file local-path entries simply aren't wired up in
2.1.4 … A trace-level log of a fresh standalone boot … contained **zero** attempts to resolve
our path."

**Docs (`/v2/docs/plugins` → Configure):** the example lists
`./plugins/local`, `../shared/plugin`, `/absolute/path/plugin`, `file:///home/me/plugins/local`,
plus: *"Relative paths resolve from the config file containing the entry. Configured local paths
must be directories. OpenCode loads the directory's `server` or `index` module, such as
`index.ts`. A path to a single file is skipped."*

**How verified:**

1. Created an isolated config dir with `opencode.json` containing
   `"plugins": ["<scratch>/probe-v1"]` where the probe is a plugin whose `setup()` writes a
   marker file (proves execution, not just parsing). The probe deliberately uses **no imports**
   to rule out module-resolution failures as a confound.
2. Booted a fresh server with `OPENCODE_CONFIG_DIR=<scratch> opencode --print-logs --log-level all run --standalone "Reply with OK only."`
   — a message is required to reach *location activation*, where plugins load (see "Why the
   implementer likely saw 'zero attempts'" below).
3. Repeated with all four documented path forms in one config: absolute dir, `file://` URL,
   relative `./plugins/rel` (relative to the config file's directory), and a single-file path.

**Evidence:**

```
msg="loading plugin" id=<scratch>/probe-v1 entrypoint=file://<scratch>/probe-v1/index.ts role=server
```
Marker files written (i.e. `setup()` ran): `MARKER_probe-abs`, `MARKER_probe-fileurl`, `MARKER_rel`.
Single file → correct documented behavior with an explicit warning:
```
level=WARN message="configured plugin path must be a directory" target=<scratch>/probe-single-file.ts role=server
```
Relative path resolved against the **config file's directory** exactly as documented.

**Verdict: docs correct on every detail; the notes' Attempt 2 conclusion is disproven.**

**Why the implementer likely saw "zero attempts":** plugin loading happens when a *location* is
activated (a session/request), not during idle server boot. I reproduced two "zero plugin lines"
situations while testing: (a) an idle `opencode serve` produces no plugin-loading lines at all
until it receives a location-bearing request, and (b) `opencode run --standalone` **without a
message** exits immediately with `Error: You must provide a message` after three log lines —
zero attempts to resolve anything. Concluding "the supervisor never received the entry" from a
boot-only trace is a methodology error.

---

## V2 — local paths in `cli.json`

**Claim (notes, Attempt 1 / §4.1):** `cli.json` with `{"plugins": ["/absolute/path/to/repo"]}`
was "never loaded … never discovered, never set up, no error logged", and *"the docs example only
ever shows package names in `cli.json.plugins` (`"opencode-acme-plugin"`)."*

**Docs (`/v2/docs/cli/plugins`):** the `cli.json` example explicitly contains:

```jsonc
"plugins": [
  "opencode.example", "opencode.example@1.0.0",
  "@example/opencode-tui", "@example/opencode-tui@1.0.0",
  "./plugins/status", "../plugins/status",
  "/home/user/plugins/status", "file:///home/user/plugins/status"
]
```

**How verified:**

1. Isolated config dir with a `cli.json` containing a matrix of local-path entries:
   - `cliA/` = `index.ts` + `tui.tsx` (the notes' claimed convention)
   - `cliB/` = `index.ts` + `tui.ts` (**the docs' documented layout**)
   - `cliC/` = `tui.tsx` only · `cliD/` = `tui.ts` only
   - `cliE.ts` = single file
   - `@definitely/not-a-real-plugin-xyz` as a **read-proof control**: if `cli.json` were not
     read at all, this entry would never be processed.
2. Launched the real TUI in a pty (`script -q /dev/null opencode --print-logs --log-level debug`),
   ~10 s, then terminated by **exact child PID** (never by name).

**Evidence (from the run):**

```
stage=read target=<scratch>/cliA entrypoint=file://…/cliA/tui.tsx  role=cli
stage=read target=<scratch>/cliB entrypoint=file://…/cliB/tui.ts   role=cli
stage=read target=<scratch>/cliC entrypoint=file://…/cliC/tui.tsx  role=cli
stage=read target=<scratch>/cliD entrypoint=file://…/cliD/tui.ts    role=cli
stage=prepare target=@definitely/not-a-real-plugin-xyz install=true role=cli
stage=prepare failed  error=NpmInstallFailedError                    role=cli
stage=setup   plugin=verify.cliA … role=cli   (and cliB, cliC, cliD)
```

Marker files written: `MARKER_cliA`, `MARKER_cliB`, `MARKER_cliC`, `MARKER_cliD` — `setup()`
executed in the CLI process. The nonexistent package triggered an npm install attempt, which
**proves `cli.json` was parsed** (control ✓). The single-file entry `cliE.ts` was silently
skipped, matching the docs' single-file rule. Note `index.ts` was *not* read CLI-side
(`MARKER_cliA-server` absent) — correct: `index.ts` is the server entry only.

**Verdict: docs correct (including the layout `index.ts` + `tui.ts`); the notes' Attempt 1
conclusion and their sub-claim about the docs showing only package names are both disproven.**

**Why the implementer likely failed:** unresolved. The most plausible causes are (a) inspecting
a TUI process that had already started before the `cli.json` edit (the file is read at CLI
startup), or (b) checking a config file other than the one the running CLI reads. Their
observation "13 builtin `opencode.*` plugins set up" matches what I saw when the probe entries
were absent — i.e. the entries they were watching were not in the config the process actually
loaded.

---

## V3 — directory discovery / feature-detection convention is "undocumented"

**Claim (notes §4.6):** *"nothing in the docs describes the directory feature-detection
convention (`index.ts` = server, `tui.tsx` = TUI). It's only discoverable from the binary or
from community plugins. This is the single most load-bearing fact for local TUI plugin
development, and it's undocumented."*

**Docs:**

- `/v2/docs/plugins` → **Discover**: *"OpenCode also loads direct `.ts` and `.js` files and
  immediate plugin package directories from every discovered `.opencode/plugins/` directory"*,
  with an explicit tree, and *"Global plugins use the same discovery layout under the OpenCode
  config directory `~/.config/opencode/plugins/`"*.
- `/v2/docs/cli/plugins`: *"Each plugin uses the same layout as a published package, with server
  and TUI entrypoints kept together"* with the exact tree:

  ```text
  <global-config>/plugins/status/index.ts
  <global-config>/plugins/status/tui.ts
  <project>/.opencode/plugins/status/index.ts
  <project>/.opencode/plugins/status/tui.ts
  ```

**How verified (functional, not just documentary):** ran the TUI with an isolated config dir
containing `<config>/plugins/disco-probe/{index.ts,tui.tsx}` and a cwd containing
`.opencode/plugins/proj-probe/{index.ts,tui.ts}`; each `tui` file writes a marker in `setup()`.

**Evidence:**

```
stage=discover directories=["<scratch>/cfg-v2/plugins","<empty-cwd>/.opencode/plugins"] role=cli
stage=read  target=<scratch>/cfg-v2/plugins/disco-probe entrypoint=…/disco-probe/tui.tsx role=cli
stage=read  target=<empty-cwd>/.opencode/plugins/proj-probe entrypoint=…/proj-probe/tui.ts  role=cli
stage=setup plugin=verify.disco / plugin=verify.proj role=cli
```

Markers written: `MARKER_disco`, `MARKER_proj` (and `MARKER_proj-server` — the service also
loaded the project plugin's `index.ts` for that location, confirming discovery server-side too).

**Verdict: the convention *is* documented, and both documented layouts work. The notes are
wrong on the "undocumented" claim.** Two nuances remain genuinely undocumented and were
confirmed empirically instead: the marker may be **`tui.ts` or `tui.tsx`** (docs show only
`tui.ts`; the notes and this repo use `tui.tsx` — both load), and the server entry may be
**`index.ts` or `server.ts`** (see V1b below).

### V1b — the `server` module alternative (docs detail, verified)

The docs say the directory's *"`server` or `index`" module* is loaded. A directory containing
**only `server.ts`** (no `index.ts`) was configured and loaded on a fresh server boot:

```
msg="loading plugin" id=<scratch>/probe-serveronly entrypoint=file://…/probe-serveronly/server.ts
```
`MARKER_server-entry` written ✓. A directory with **neither** `index.ts` nor `server.ts` (this
repo root, before the fix below) was **silently skipped** — a small undocumented gap worth
reporting alongside V4 (the docs don't say a directory lacking both is ignored, nor that
`package.json` `exports` is *not* consulted for config-path directories).

---

## V4 — peer-dependency ranges (the one real docs error)

**Claim (notes §4.3):** the docs example pins `@opentui/core >=0.6.6`, but
`@opencode/plugin@2.1.4` declares `>=0.6.8`, and npm hard-fails on the lower pin.

**Docs (`/v2/docs/build/plugins/cli` → Publish and load):**

```json
"peerDependencies": { "@opentui/core": ">=0.6.6", "@opentui/solid": ">=0.6.6", "solid-js": ">=1.9.0" }
```

**Registry fact (npm registry, `@opencode/plugin@2.1.4`):**

```json
"peerDependencies": { "solid-js": ">=1.9.0", "@opentui/core": ">=0.6.8", "@opentui/solid": ">=0.6.8", "@opencode/theme": "2.1.4" }
"peerDependenciesMeta": { "@opentui/core": { "optional": true }, … }
```

**How verified:** three npm installs in clean scratch dirs:

| Test | package.json | Result |
|---|---|---|
| A | docs example as written, no pin | ✅ installs; npm picks `@opentui/core@0.6.8` |
| B | docs example + explicit `@opentui/core@0.6.6` (allowed by `>=0.6.6`) | ❌ **ERESOLVE** |
| C | this repo (`>=0.6.8` + `@opencode/theme`) | ✅ installs (the repo itself) |

**Evidence (test B, verbatim npm output):**

```
npm error While resolving: @opencode/plugin@2.1.4
npm error Found: @opentui/core@0.6.6
npm error Could not resolve dependency:
npm error peerOptional @opentui/core@">=0.6.8" from @opencode/plugin@2.1.4
npm error Conflicting peer dependency: @opentui/core@0.6.8
```

**Verdict: the notes are correct and the docs are wrong.** The docs example advertises a range
whose lower bound cannot actually be installed alongside `@opencode/plugin@2.1.4`, and it omits
the `@opencode/theme` peer the package declares.

### Report-ready evidence for an opencode docs issue

> **Page:** <https://opencode.ai/v2/docs/build/plugins/cli> ("Publish and load" `package.json` example)
> **Problem 1:** the example declares `"@opentui/core": ">=0.6.6"` / `"@opentui/solid": ">=0.6.6"`,
> but `@opencode/plugin@2.1.4` declares `peerOptional` `>=0.6.8` for both. Following the docs
> and installing any `@opentui/*` version in `[0.6.6, 0.6.8)` fails with ERESOLVE (full npm
> output above, reproduced on npm 12.2.0 / Node 24 / macOS against `@opencode/plugin@2.1.4`).
> Suggested fix: `>=0.6.8` (or simply mirror `@opencode/plugin`'s own peer ranges).
> **Problem 2 (minor):** the example omits the `"@opencode/theme"` peer (exact version) that
> `@opencode/plugin@2.1.4` declares.
> **Problem 3 (minor, from V1b):** `/v2/docs/plugins` says configured local paths load the
> directory's "`server` or `index` module" but doesn't say a directory containing neither is
> silently skipped (package `exports` are not consulted).

---

## V5 — scope of `opencode plugin list`

**Claim (notes §1.6):** *"`opencode plugin list` lists **server** plugins only. It is not
evidence about CLI plugins."*

**How verified:** ran `opencode plugin list` (a) with the real config and (b) with an isolated
config dir whose `cli.json` contained a local path entry and whose `plugins/` dir contained a
discovery entry.

**Evidence:**

```
$ OPENCODE_CONFIG_DIR=<scratch> opencode plugin list
ID                 VERSION  SOURCE
-                  local    <scratch>/cfg-v2/plugins/disco-probe   ← discovery entry
-                  local    <scratch>/cliA                         ← cli.json-only entry
context-usage      local    ~/.config/opencode/plugins/context-usage/index.ts
loaf.tokens-usage  local    ~/.config/opencode/plugins/tokens-usage/index.ts
```

A `cli.json`-only entry (`cliA`, never loaded by any server — hence ID `-`) is listed. So the
command reports local config + discovery entries as well as server-loaded plugins.

**Verdict: notes wrong as a categorical statement.** The docs' phrasing ("server and TUI-only
package plugins", "global package plugins") is consistent with what is observed. (The exact
output of `plugin check` was not exercised — no updatable packages installed.)

---

## V6 — config caching vs automatic reload

**Claim (notes §1.6/§5):** *"The service boots once and **caches its config**. Editing
`opencode.json` and restarting the TUI is not enough for server-side config — the service must
restart too."*

**Docs (`/v2/docs/plugins` → Reload):** *"Changes under watched config directories reload
automatically."* (with `touch …` + `opencode service restart` offered only for plugin *files*
and an explicit hedge for "unwatched local dependencies").

**How verified — three steps against the user's live background service (PID 65394, running
since 18:04, never restarted):**

1. `touch ~/.config/opencode/opencode.json` (content unchanged) → within seconds the service
   re-created its config-derived watchers (log lines `run=7f86261b … watcher subscribe …`), no
   restart.
2. Added `"plugins": ["<scratch>/probe-hot"]` to the real `opencode.json` (atomic write) → the
   service **immediately attempted to load it**:
   ```
   level=WARN run=7f86261b message="failed to load plugin" target=<scratch>/probe-hot
   cause="Cause([Die(Error: ENOENT …"      ← my bug: directory not created yet
   ```
3. Created the directory + `index.ts` → seconds later:
   ```
   msg="loading plugin" id=<scratch>/probe-hot entrypoint=file://…/probe-hot/index.ts role=server
   ```
   `MARKER_probe-hot` written — **a brand-new plugin loaded into the running service with no
   restart whatsoever.**
4. Restored the original config; verified `diff` → **IDENTICAL**, `mcp.servers` intact.

**Verdict: docs correct, notes wrong.** The service watches and hot-reloads its config. What the
notes probably observed: *plugin source files* (`plugins/*/index.ts`) may need a `touch`/`/reload`
if their dependency tree changed, and the docs hedge for "unwatched local dependencies" covers
that — but the categorical "must restart the service" claim is false for config changes.

---

## V9 — `dialog.set()` ordering and size presets (found 2026-10-25)

**Docs (`/v2/docs/build/plugins/cli` → Dialogs and toasts):**

```ts
context.ui.dialog.set({ size: "large", centered: true })
context.ui.dialog.show(() => (<box>…</box>), onClose)
```

i.e. `set()` is shown **before** `show()`.

**How verified:** a throwaway probe plugin (isolated config dir, global
`plugins/` discovery) auto-opened dialogs of every size from `setup()` — no
input driving — while the TUI ran in a `script` pty (`stty cols 140 rows 40`),
and the raw transcripts were replayed through a `pyte` terminal emulator to
measure the *rendered* frames exactly (border row → left offset and width).

**Evidence (140×40 pty, emulator-measured):**

| probe | `set()` timing | rendered result |
|---|---|---|
| geom-b | **before** `show()` (docs order) | all sizes → **width 60** (default); no effect |
| geom-c | **synchronously right after** `show()` returns | medium → 60 @ left 40, large → **88 @ left 26**, xlarge → **116 @ left 12** — all exactly centered |
| geom-d | 80 ms after `show()` | all → 60; no effect |
| geom-e | inside the render thunk | 116 @ left 12 — works |
| geom-e | no `set()` at all (default) | 60 @ left 40 — **already horizontally centered by default** |

Conclusions:

- **Presets are fixed column widths** — medium 60 / large 88 / xlarge 116 —
  *not* fractions of the terminal (settles a contradiction between two
  comments in this repo's own history).
- **`set()` before `show()` (the documented order) is silently ignored.**
  It applies only while a dialog is already active and mounting: immediately
  after `show()` returns, or inside the render thunk.
- `show()` dialogs are horizontally centered even without `set({centered})`.
- `set()` before the promise-based `select()` could not be measured (the
  select frame has no box borders to measure); it is *unverified*, and the
  stats selector was left at the host default size rather than guessing.

**Consequence for this repo:** `src/tui.tsx` opens the stats dialog with the
verified order (`show()` → `set()` immediately after) and picks the largest
preset that fits the terminal via the typed `ctx.renderer.width`
(medium/large/xlarge thresholds 92/120 cols), replacing the old
"85%-of-terminal content box" workaround and the size-guessing comments.

### Report-ready evidence for the docs issue

> **Page:** <https://opencode.ai/v2/docs/build/plugins/cli> ("Dialogs and toasts",
> custom JSX dialog example)
> **Problem:** the example calls `context.ui.dialog.set({ size, centered })`
> *before* `context.ui.dialog.show(...)`. On OpenCode 2.1.4 this ordering has no
> effect: dialogs stay on the default 60-column preset regardless of `size`
> (measured with emulator-replayed pty transcripts; four probe variants,
> orders: before/immediately-after/80 ms-after/inside-render). Calling `set()`
> **immediately after `show()` returns** applies size and re-centers correctly
> (60/88/116 on 140 cols, left 40/26/12 = exact centering).
> **Suggested fix:** show the example as `show(...); set(...)` — or make
> `set()` before `show()` queue the options for the next dialog.
> **Also worth documenting:** preset widths are fixed columns (60/88/116), and
> `show()` dialogs are horizontally centered by default.

---

## V7 / V8 — API-shape claims (both agree with the docs)

Verified against the **installed** type definitions (the notes' own recommended method), in
`node_modules` from npm `@opencode/plugin@2.1.4` / `@opencode/client@2.1.4`:

- **V7** — `@opencode/plugin/dist/tui/context.d.ts:329`:
  `show(render: () => JSX.Element, onClose?: () => void): void` — the docs' example
  (`show(() => <box>…`, `() => console.log("closed")`) matches exactly. The notes correctly
  attribute the error to their own plan's pseudocode, not to the docs. No discrepancy.
- **V8** — server context (`dist/promise/plugin.d.ts`): `readonly location: Location.Info` where
  `Location.Info` includes `project: { id, directory, canonical }`
  (`@opencode/schema/dist/location.d.ts`); TUI context (`dist/tui/context.d.ts:481`):
  `readonly location: LocationRef | undefined` with `LocationRef = { directory, workspaceID? }`
  (`@opencode/client` `types.d.ts:801`) — **no `project` field**. Both the server docs and the
  notes are right; mixing the two contexts is a real hazard, exactly as the notes say.

Additional notes-claims checked against docs/types and found **consistent** (no discrepancy):
`@opencode/plugin/tui` import path, package `exports` layout (`.` + `./tui`), `setup` required,
`keymap.layer` + `slash`/`palette`/`mode:"global"`, `dialog.select` search running for the empty
query, `ctx.data.session.*` surface, and the "loose files under `plugins/` are picked up as
plugin candidates" gotcha (the service log shows `watcher subscribe … tokenizer-registry.mjs`;
the docs say direct `.ts`/`.js` files are loaded — `.mjs` handling itself was not separately
exercised).

---

## Code changes made (implementation follows the docs)

Because V1, V2, V3 and V6 established that the documented mechanisms all work on 2.1.4, the
loading-related implementation was refactored to the documented path:

1. **`index.ts` (new, repo root)** — one-line shim re-exporting `src/index.ts`. A configured
   local directory must expose an `index`/`server` module at its root (verified in V1/V1b); the
   repo previously only had the root `tui.tsx` shim, so a config-path entry would have been
   silently skipped (confirmed: it *was* skipped until this file was added, then loaded:
   `msg="loading plugin" id=/Users/loaf/git/opencode-context-info entrypoint=…/index.ts role=server`).

2. **`install.sh` (rewritten)** — now performs the documented Configure-style install:
   - atomically merges `"plugins": ["<repo>"]` into `~/.config/opencode/opencode.json`
     (idempotent; **refuses to touch invalid/JSONC config** instead of corrupting it; preserves
     file mode; round-trip install→uninstall verified byte-identical against a copy of the real
     config);
   - **migrates** the legacy generated-shim directory (`plugins/tokens-usage`) — removed only if
     its files carry the old installer's marker/`opencode-context-info/src/` re-export (foreign
     directories are left alone with a warning);
   - **no `cli.json` entry is written** — verified unnecessary: a plugin configured only in
     `opencode.json` has its `tui.tsx` read and set up by the CLI via the server-reported list:
     ```
     stage=read  target=/Users/loaf/git/opencode-context-info entrypoint=…/index.ts→tui.tsx role=cli
     stage=setup plugin=loaf.tokens-usage target=/Users/loaf/git/opencode-context-info role=cli
     ```
     (full chain re-verified end-to-end against a dedicated server + TUI, no errors);
   - header/help text now states only verified facts and cites this document;
   - `--dry-run` / `--uninstall` / `--config FILE` / `--legacy-dir DIR` retained/added.

3. **`package.json` (unchanged, deliberately)** — its `>=0.6.8` peers + `@opencode/theme` match
   the installed package (V4 shows this is the *correct* side of the disagreement).

4. **`docs/implementation_notes.md` (not touched)** — it carries an uncommitted edit by another
   session; its §2/§4 loading claims are superseded by this document.

5. **`src/` alignment refactor (commit "Align src/ with documented APIs")** — `LoadContext`
   Pick-ed from the real `Context` type (casts removed), the broken `session.list` response
   guess fixed (V9-era bug: the selector always got `[]`), discriminated-union narrowing
   instead of structural casts, context limit from the model registry instead of a
   max-across-models guess, and the documented `data.on` auto-refresh. Tests 35/35.

6. **Stats dialog presentation (2026-10-25, V9 follow-up)** — `src/tui.tsx` + `src/view.tsx`
   moved from the fullscreen `session.panel` back to a **centered dialog** using the verified
   `show()` → `set()` order and a terminal-width preset picker (replacing the historical
   "85%-of-terminal content box" hack), fresh signals per open, an idempotent escape/close
   path, and the dead `onClose` prop removed from `StatsView`.

## How to reproduce (quick reference)

```bash
# V1: config-path load (server side)
OPENCODE_CONFIG_DIR=<scratchcfg> opencode --print-logs --log-level all run --standalone "Reply with OK only."
#   with <scratchcfg>/opencode.json: { "plugins": ["<abs probe dir>"] }   → look for: msg="loading plugin"

# V2/V3: cli.json paths + discovery (CLI side), then stop by exact child PID
OPENCODE_CONFIG_DIR=<scratchcfg> script -q /dev/null opencode --print-logs --log-level debug
#   with <scratchcfg>/cli.json: { "plugins": ["<probe dir>", "@nonexistent/pkg"] }

# V4: peer range conflict
mkdir t && cd t && npm init -y
#   deps @opencode/plugin@2.1.4, devDeps @opentui/core@0.6.6 → npm install → ERESOLVE

# V6: hot reload — add "plugins" entry to opencode.json while service runs →
#   grep 'loading plugin' ~/.local/share/opencode/log/opencode.log → new entry appears, no restart

# Safety: never `pkill -f opencode`; self-terminate with `perl -e 'alarm N; exec @ARGV' …`
# and kill only PIDs you spawned (verify with ps -o pid,lstart,command).
```

## Open items (untested / unresolved)

- Whether `cli.json` parse errors are surfaced anywhere (a syntactically invalid `cli.json` was
  silently ignored in my control run — worth a separate docs question: is failure silent by
  design?).
- `opencode plugin check` output (no updatable packages present).
- `.mjs`/`.json` loose files under `plugins/` (the notes claim they fail as plugins; the docs
  only promise `.ts`/`.js`).
- Exact precedence when a directory contains both `server.ts` and `index.ts`, and whether
  `tui.ts` wins over `tui.tsx` (both were loaded in separate directories; the combined case was
  not exercised).