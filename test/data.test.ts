import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeMessages } from "../src/data.ts"
import type { LoadContext } from "../src/data.ts"
import { listRootSessions, loadSnapshot } from "../src/data.ts"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client"

const assistantMsg = (over: Record<string, unknown> = {}): SessionMessageInfo =>
  ({
    id: "m1",
    type: "assistant",
    time: { created: 1700000000000 },
    agent: "build",
    model: { id: "glm-flash", providerID: "openrouter" },
    tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 200, write: 30 } },
    cost: 0.02,
    content: [
      { type: "text", text: "hi" },
      { type: "tool", tool: "read" },
      { type: "tool", tool: "edit" },
    ],
    ...over,
  }) as SessionMessageInfo

test("normalizeMessages: full assistant message", () => {
  const { records, skipped } = normalizeMessages([assistantMsg()])
  assert.equal(skipped, 0)
  assert.equal(records.length, 1)
  const r = records[0]!
  assert.equal(r.kind, "assistant")
  assert.equal(r.completed, true)
  assert.equal(r.usage?.input, 100)
  assert.equal(r.usage?.cacheRead, 200)
  assert.equal(r.usage?.cacheWrite, 30)
  assert.equal(r.cost, 0.02)
  assert.equal(r.toolCalls, 2)
  assert.equal(r.model.providerID, "openrouter")
  assert.equal(r.model.id, "glm-flash")
})

test("normalizeMessages: missing tokens/cost handled", () => {
  const { records } = normalizeMessages([assistantMsg({ tokens: undefined, cost: undefined })])
  const r = records[0]!
  assert.equal(r.usage, undefined)
  assert.equal(r.cost, 0)
  assert.equal(r.completed, false) // no usage → not completed
})

test("normalizeMessages: errored step not completed", () => {
  const { records } = normalizeMessages([assistantMsg({ finish: "error" })])
  assert.equal(records[0]!.completed, false)
})

test("normalizeMessages: compaction completed and failed", () => {
  const completed = {
    id: "c1",
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary: "sum",
    time: { created: 1700000000001 },
    tokens: { input: 500, output: 60, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0.03,
  }
  const failed = {
    id: "c2",
    type: "compaction",
    status: "failed",
    reason: "auto",
    error: "boom",
    time: { created: 1700000000002 },
  }
  const { records } = normalizeMessages([completed, failed] as never as SessionMessageInfo[])
  assert.equal(records.length, 2)
  assert.equal(records[0]!.kind, "compaction")
  assert.equal(records[0]!.completed, true)
  assert.equal(records[0]!.usage?.input, 500)
  assert.equal(records[1]!.completed, false)
})

test("normalizeMessages: unknown shapes skipped and counted", () => {
  const { records, skipped } = normalizeMessages([
    { id: "u1", type: "user", time: { created: 1 } },
    { id: "u2", type: "step-start", time: { created: 2 } },
    assistantMsg(),
  ] as never)
  assert.equal(records.length, 1)
  assert.equal(skipped, 2)
})

test("loadSnapshot: nested subagent descendants are not double-counted", async () => {
  const ctx = makeCtx()
  // family: [self, direct child, grandchild]. The grandchild's root is the
  // direct child (another member of the family), so it must be dropped —
  // the child's SessionInfo already reports its subtree.
  ctx.data.session.family = () => ["s1", "child1", "grandchild"]
  ctx.data.session.root = (id: string) => (id === "grandchild" ? "child1" : "s1")
  ctx.data.session.get = (id: string) => {
    if (id === "child1") {
      return {
        id: "child1",
        title: "direct child",
        cost: 0.2,
        tokens: { input: 500, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 2 },
      } as never
    }
    if (id === "grandchild") {
      return {
        id: "grandchild",
        title: "nested",
        cost: 0.1,
        tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 2 },
      } as never
    }
    return undefined
  }
  const snap = await loadSnapshot(ctx, "s1")
  assert.equal(snap.subagents.length, 1)
  assert.equal(snap.subagents[0]!.sessionID, "child1")
  assert.equal(snap.subagents[0]!.tokens, 550)
})

test("loadSnapshot: empty subagent list yields no rows", async () => {
  const ctx = makeCtx()
  ctx.data.session.family = () => ["s1"]
  const snap = await loadSnapshot(ctx, "s1")
  assert.equal(snap.subagents.length, 0)
})

function makeCtx(over: {
  statsFails?: boolean
  locationFails?: boolean
  noSession?: boolean
} = {}): LoadContext {
  const session = over.noSession
    ? undefined
    : ({
        id: "s1",
        title: "Test session",
        cost: 0.5,
        tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 500, write: 50 } },
        time: { created: 1, updated: 2 },
        projectID: "proj_1",
      } as never)
  const messages = over.noSession ? [assistantMsg()] : [assistantMsg()]
  return {
    client: {
      session: {
        stats: over.statsFails
          ? () => Promise.reject(new Error("boom"))
          : () =>
              Promise.resolve({
                range: { from: 0, to: 86_400_000 },
                sessions: 4,
                subagents: 2,
                prompts: 9,
                steps: 40,
                tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 1, write: 1 } },
                cost: 1.02,
                tools: { mode: "none" },
                activeDays: 1,
                streak: 1,
                activity: [],
                models: [],
              }),
        // SessionsResponse: { data: SessionInfo[], cursor }
        list: () => Promise.resolve({ data: [], cursor: {} }),
      },
      location: {
        get: over.locationFails
          ? () => Promise.reject(new Error("no location"))
          : () => Promise.resolve({ directory: "/d", project: { id: "proj_x", directory: "/d", canonical: "/d" } }),
      },
    },
    data: {
      session: {
        list: () => [],
        get: (id: string) => (over.noSession ? undefined : session),
        root: () => "s1",
        family: () => ["s1", "child1"],
        cost: () => 0.5,
        status: () => "idle",
        sync: () => Promise.resolve(),
        message: {
          list: () => messages,
          sync: () => Promise.resolve(),
          invalidate: () => undefined,
        },
      },
      location: {
        default: () => ({ directory: "/work/dir" }),
        model: { list: () => [] },
      },
    },
    ui: {
      model: { current: () => undefined },
    },
  }
}

test("loadSnapshot: happy path", async () => {
  const snap = await loadSnapshot(makeCtx(), "s1", { projectStats: true })
  assert.equal(snap.title, "Test session")
  assert.equal(snap.status, "idle")
  assert.equal(snap.sessionTokens?.input, 1000)
  assert.equal(snap.sessionCost, 0.5)
  assert.equal(snap.records.length, 1)
  assert.equal(snap.subagents.length, 1) // self excluded
  assert.equal(snap.subagents[0]!.sessionID, "child1")
  assert.equal(snap.project?.sessions, 4)
  assert.equal(snap.contextUsed, 100 + 200 + 30)
  assert.equal(snap.warnings.length, 0)
})

test("loadSnapshot: project stats failure is non-fatal", async () => {
  const snap = await loadSnapshot(makeCtx({ statsFails: true }), "s1")
  assert.equal(snap.project, undefined)
  assert.ok(snap.warnings.some((w) => w.includes("project totals unavailable")))
  assert.equal(snap.records.length, 1) // session data intact
})

test("loadSnapshot: works with messages but no cached session info", async () => {
  const ctx = makeCtx({ noSession: true })
  const snap = await loadSnapshot(ctx, "s1")
  assert.equal(snap.title, undefined) // graceful without session info
  assert.equal(snap.records.length, 1)
  assert.equal(snap.project?.sessions, 4) // projectID resolved via location.get
})

test("loadSnapshot: rejects when nothing is known about the session", async () => {
  const ctx = makeCtx({ noSession: true })
  ctx.data.session.message.list = () => []
  await assert.rejects(() => loadSnapshot(ctx, "missing"), /not found/)
})

test("loadSnapshot: message sync failure degrades to warning", async () => {
  const ctx = makeCtx()
  ctx.data.session.message.sync = () => Promise.reject(new Error("offline"))
  const snap = await loadSnapshot(ctx, "s1")
  assert.ok(snap.warnings.some((w) => w.includes("message sync failed")))
})

test("listRootSessions: returns the response data array", async () => {
  const ctx = makeCtx()
  const listed = [{ id: "s2" }, { id: "s1" }] as never as SessionInfo[]
  ctx.client.session.list = () => Promise.resolve({ data: listed, cursor: {} })
  const out = await listRootSessions(ctx, "/work/dir", 5)
  assert.equal(out.length, 2)
  assert.equal(out[0]!.id, "s2")
})

test("listRootSessions: falls back to root sessions from the cache when the server fails", async () => {
  const ctx = makeCtx()
  ctx.client.session.list = () => Promise.reject(new Error("offline"))
  ctx.data.session.list = () =>
    [
      { id: "root-old", time: { created: 1, updated: 3 } },
      { id: "root-new", time: { created: 1, updated: 9 } },
      { id: "child", parentID: "root-new", time: { created: 1, updated: 99 } },
    ] as never as SessionInfo[]
  const out = await listRootSessions(ctx, "/work/dir")
  assert.deepEqual(
    out.map((s) => s.id),
    ["root-new", "root-old"], // newest first, children excluded
  )
})

test("loadSnapshot: context limit comes from the step's model in the location registry", async () => {
  const ctx = makeCtx()
  ctx.data.location.model.list = () =>
    [
      { providerID: "openrouter", id: "glm-flash", modelID: "glm-flash", limit: { context: 200_000, output: 8_000 } },
    ] as never
  const snap = await loadSnapshot(ctx, "s1")
  assert.equal(snap.contextLimit, 200_000)
  assert.equal(snap.contextUsed, 100 + 200 + 30)
})

test("loadSnapshot: falls back to the prompt's selected model for the context limit", async () => {
  const ctx = makeCtx()
  ctx.data.location.model.list = () =>
    [{ providerID: "other", id: "big", modelID: "big", limit: { context: 1_000_000, output: 8_000 } }] as never
  ctx.ui.model.current = () => ({ providerID: "other", modelID: "big" })
  const snap = await loadSnapshot(ctx, "s1")
  assert.equal(snap.contextLimit, 1_000_000)
})

test("loadSnapshot: unknown model hides the context row instead of guessing", async () => {
  const snap = await loadSnapshot(makeCtx(), "s1")
  assert.equal(snap.contextLimit, undefined)
})
