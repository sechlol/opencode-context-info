#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
// Add or remove this checkout in the OpenCode global config.
//
// Called by ../install.sh; can also be run directly:
//   ./scripts/install.ts [--uninstall]

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs"
import { dirname, join } from "node:path"

const repo = dirname(import.meta.dirname)
const home = process.env.HOME

// Synchronous writes so output cannot be lost when the process exits early.
const say = (line: string): void => {
  writeSync(1, `${line}\n`)
}

function fail(message: string): never {
  writeSync(2, `error: ${message}\n`)
  process.exit(1)
}

const configBase = process.env.XDG_CONFIG_HOME ?? (home ? join(home, ".config") : fail("HOME is not set"))
const config = join(configBase, "opencode/opencode.json")

const arg = process.argv[2]
if (arg === "-h" || arg === "--help") {
  say(`Usage: ./install.sh [--uninstall]

  (no flag)    register this checkout in ${config}
  --uninstall  remove the entry again`)
  process.exit(0)
}
if (arg !== undefined && arg !== "--uninstall") fail(`unknown option: ${arg} (see --help)`)
const remove = arg === "--uninstall"

for (const file of ["index.ts", "tui.tsx"]) {
  if (!existsSync(join(repo, file))) fail(`${repo} is not the plugin checkout (${file} missing)`)
}

let parsed: unknown = {}
if (existsSync(config)) {
  try {
    const raw = readFileSync(config, "utf8")
    parsed = raw.trim() ? JSON.parse(raw) : {}
  } catch (error) {
    fail(`${config} is not valid JSON (${(error as Error).message}); not modified`)
  }
}
if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
  fail(`${config} is not a JSON object; not modified`)
}

const doc = parsed as Record<string, unknown>
const plugins = doc.plugins ?? []
if (!Array.isArray(plugins)) fail(`${config}: "plugins" is not an array; not modified`)

const same = (item: unknown): boolean =>
  item === repo || (typeof item === "object" && item !== null && (item as { package?: unknown }).package === repo)
const registered = plugins.some(same)

if (remove) {
  if (!registered) {
    say(`Not registered in ${config}`)
    process.exit(0)
  }
  const kept = plugins.filter((item) => !same(item))
  if (kept.length > 0) doc.plugins = kept
  else delete doc.plugins
} else {
  if (registered) {
    say(`Already registered in ${config}`)
    process.exit(0)
  }
  doc.plugins = [...plugins, repo]
}

mkdirSync(dirname(config), { recursive: true })
const temp = `${config}.tmp`
writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`)
if (existsSync(config)) chmodSync(temp, statSync(config).mode)
renameSync(temp, config)
say(`${remove ? "Unregistered" : "Registered"} ${repo} in ${config}`)
