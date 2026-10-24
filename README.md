# opencode-context-info

Token usage statistics for [OpenCode](https://opencode.ai) v2 sessions — `/tokens_usage`,
fully script-based, **no LLM in the loop**.

## What it shows

Run `/tokens_usage` (alias `/usage`) or pick **Show token usage** in the command palette:

- **Inside a session** → a dialog with that session's stats:
  - Session cost (the headline figure) and the sum of reported token categories
  - Component breakdown: input, output, reasoning, cache read, cache write (rendered as one
    stacked-composition view with per-component bars)
  - **Context window** occupancy — the last completed step's prompt size vs the model's context
    limit (an estimate; answers "how full is my context window?")
  - Per-model breakdown (steps, tokens, cost) and recent steps (time, model, tokens, cost, tools)
  - Subagent usage, reported per child session
  - Project totals from opencode's stats endpoint, with the time range labeled
- **On the main screen** → a session selector (newest first, searchable) — pick any session to
  visualize.

Keys inside the dialog: `esc` close · `r` refresh.

Numbers come from the usage telemetry opencode already records per message and per session
(what the provider billed) — nothing is re-tokenized, no prompts are sent anywhere, and no
LLM is involved.

### What the numbers mean

- **COST** is the session's reported cost — the comparable headline.
- Token categories (input / output / reasoning / cache read / cache write) are **not universally
  disjoint** across providers: some providers include reasoning in output, or cached tokens in
  input. The dialog therefore does *not* present a grand "TOTAL"; it shows the components plus a
  "Σ reported" sum with that caveat.
- Session totals are read from opencode's own session record; per-step rows are attribution and
  reconcile against the total via an "other/auxiliary" row when usage isn't explained by steps.
- Subagent tokens are reported per child session and are **not added** into the session total.
- Project totals come from an experimental endpoint; if it's unavailable the rest of the dialog
  still works.

## Install

Requirements: OpenCode **v2.1.4+**, Node 22+ (only if you run the test suite), no tokenizer
dependencies.

Close OpenCode first (it rewrites its config itself and holds a lock).

```bash
git clone <this-repo-url> && cd opencode-context-info
./install.sh            # registers the plugin path in opencode.json
```

`install.sh` flags: `--dry-run`, `--target DIR`, `--uninstall`, `--help`.
It edits only `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json`, preserves existing
settings and plugin entries (string or object form), backs up the file first, and refuses to
rewrite files containing JSONC comments (it prints the snippet to add instead).

> Why not `cli.json`? OpenCode v2.1.4 does not load local plugin paths from the global CLI
> config's `plugins` array (verified on this machine — the CLI reconciliation never picked it
> up). The `opencode.json` `plugins` entry is the form that loads the `./tui` export.

If `OPENCODE_CONFIG_CONTENT` is set, its `plugins` array **replaces** the file's array — the
installer warns and prints the manual snippet.

### Manual install

Add the absolute path of this repo to the `plugins` array of your `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-context-info"]
}
```

### Do not double-register

Register this plugin in **`opencode.json` only**. It also must **not** be added to the global
`cli.json` — loading it from both configs double-loads the TUI entry (duplicate `/tokens_usage`
commands and dialogs). The installer warns if it detects a duplicate in `cli.json`.

Because the absolute path is machine-specific, moving the repo breaks the install — re-run
`./install.sh` after moving, or publish the package to npm and register it by name instead.

## Verify

- Start OpenCode, run `/tokens_usage` in a session and from the home screen.
- Note: `opencode plugin list` lists **server** plugins only — it is not evidence about CLI
  plugins. If the command doesn't appear, check the CLI log at
  `~/.local/share/opencode/log/opencode.log`, try `/reload`, and as a last resort restart the
  background service (`opencode service status`) or boot once with `opencode` after closing all
  instances to clear stale plugin-load state.

## Uninstall

```bash
./install.sh --uninstall
```

If you had registered it manually in `cli.json` at some point, remove that entry too
(the installer also offers `--target ~/.config/opencode/cli.json --uninstall`).

## Development

```bash
npm install
npm run check   # typecheck + tests
```

Layout: `src/tui.tsx` (command, routing, dialog) · `src/data.ts` (OpenCode I/O and
normalization) · `src/stats.ts` (pure aggregation) · `src/format.ts` (pure formatting) ·
`src/view.tsx` (OpenTUI/Solid rendering) · `test/` (fixtures + unit tests for the pure layers).

## Known limits

- The session selector lists up to 100 root sessions of the current project, searched locally.
- Context-window occupancy is an estimate based on the last completed step.
- Project totals depend on an experimental endpoint and need a reachable project ID.
- Cost reflects provider-reported values; for free models it shows `$0`, for unknown values `—`.

## Compatibility

- Tested against OpenCode 2.1.4, `@opencode/plugin` 2.1.4, `@opencode/client` 2.1.4.
- The plan and review history live in `docs/`; legacy v1 exploration (not imported) in `reference/`.

## Privacy

Everything runs locally against your OpenCode server. No message content leaves your machine.
