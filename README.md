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

Requirements: OpenCode **v2.1.4+**. No tokenizer dependencies, no LLM usage.

Close OpenCode first, then:

```bash
git clone <this-repo-url> && cd opencode-context-info
./install.sh            # deploys plugin shims into ~/.config/opencode/plugins/
```

`install.sh` flags: `--dry-run`, `--target DIR`, `--uninstall`, `--help`.

> **Why shims?** Verified on v2.1.4: plugins auto-load from *directories* under
> `~/.config/opencode/plugins/` (the directory's `index.ts` is the server entry;
> a `tui.tsx` at the directory root marks the TUI feature). Registering local
> paths in `cli.json` or `opencode.json` `plugins` arrays was tested and is
> **not applied** by v2.1.4, so the installer writes two one-line shim files
> that re-export this repo's `src/index.ts` and `src/tui.tsx` instead.

The shims reference the repo by absolute path — if you move the repo, re-run
`./install.sh`. Publishing the package to npm and registering it by name is the
stable long-term option.

### Do not double-register

Do not also add this repo to `cli.json` or `opencode.json` `plugins` — if config
entries gain local-path support in a future version, that would double-load the
TUI entry (duplicate `/tokens_usage` commands). The installer warns if it finds
stale config references.

## Uninstall

```bash
./install.sh --uninstall
```

If you registered the repo in `cli.json`/`opencode.json` during earlier attempts,
remove those entries too.

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
