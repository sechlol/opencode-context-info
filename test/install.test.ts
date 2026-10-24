import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"

// The installer is a shell wrapper plus scripts/install.ts, both of which
// write to $XDG_CONFIG_HOME. Every test gets a throwaway config directory so
// the real ~/.config/opencode/opencode.json is never touched.
const repo = realpathSync(join(import.meta.dirname, ".."))
const installSh = join(repo, "install.sh")
const installTs = join(repo, "scripts/install.ts")
const skip = process.platform === "win32" && "requires bash"

const sandboxes: string[] = []
after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true })
})

function sandbox(): { dir: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), "opencode-install-"))
  sandboxes.push(dir)
  return { dir, config: join(dir, "opencode/opencode.json") }
}

function run(command: string, args: string[], xdg: string): { status: number | null; output: string } {
  const result = spawnSync(command, args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: xdg },
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

const shell = (xdg: string, ...args: string[]) => run("bash", [installSh, ...args], xdg)
const direct = (xdg: string, ...args: string[]) => run(installTs, args, xdg)

const readDoc = (config: string) => JSON.parse(readFileSync(config, "utf8"))
const plugins = (config: string): unknown => readDoc(config).plugins

test("installer: registers the checkout, is idempotent, unregisters", { skip }, () => {
  const { dir, config } = sandbox()

  const added = shell(dir)
  assert.equal(added.status, 0, added.output)
  assert.deepEqual(plugins(config), [repo])

  const before = readFileSync(config, "utf8")
  const again = shell(dir)
  assert.equal(again.status, 0, again.output)
  assert.match(again.output, /Already registered/)
  assert.equal(readFileSync(config, "utf8"), before)

  const removed = shell(dir, "--uninstall")
  assert.equal(removed.status, 0, removed.output)
  assert.equal("plugins" in readDoc(config), false)

  const absent = shell(dir, "--uninstall")
  assert.equal(absent.status, 0, absent.output)
  assert.match(absent.output, /Not registered/)
})

test("installer: keeps unrelated config and object-form plugins", { skip }, () => {
  const { dir, config } = sandbox()
  const original = {
    $schema: "https://opencode.ai/config.json",
    model: "anthropic/claude",
    plugins: ["other-plugin", { package: "opt-plugin", options: { strict: true } }],
  }
  mkdirSync(join(dir, "opencode"), { recursive: true })
  writeFileSync(config, `${JSON.stringify(original, null, 2)}\n`)

  const added = shell(dir)
  assert.equal(added.status, 0, added.output)
  assert.deepEqual(plugins(config), [...original.plugins, repo])

  const removed = shell(dir, "--uninstall")
  assert.equal(removed.status, 0, removed.output)
  const doc = readDoc(config)
  assert.deepEqual(doc.plugins, original.plugins)
  assert.equal(doc.model, original.model)
  assert.equal(doc.$schema, original.$schema)
})

test("installer: refuses invalid JSON without touching the file", { skip }, () => {
  const { dir, config } = sandbox()
  const broken = '{ "plugins": [ "x", ] }\n'
  mkdirSync(join(dir, "opencode"), { recursive: true })
  writeFileSync(config, broken)

  const result = shell(dir)
  assert.equal(result.status, 1)
  assert.match(result.output, /not valid JSON/)
  assert.equal(readFileSync(config, "utf8"), broken)
})

test("installer: help and unknown flags", { skip }, () => {
  const { dir } = sandbox()

  const help = shell(dir, "--help")
  assert.equal(help.status, 0, help.output)
  assert.match(help.output, /--uninstall/)

  const unknown = shell(dir, "--nope")
  assert.equal(unknown.status, 1)
  assert.match(unknown.output, /unknown option/)
})

test("installer: scripts/install.ts runs directly", { skip }, () => {
  const { dir, config } = sandbox()
  const result = direct(dir)
  assert.equal(result.status, 0, result.output)
  assert.deepEqual(plugins(config), [repo])
})
