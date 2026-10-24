/** @jsxImportSource @opentui/solid */
// Presentational components for the stats dialog. All data arrives as a
// ready-made StatsViewModel; this module owns no aggregation.
//
// OpenTUI note: <text> accepts fg/attributes directly (TextOptions), but
// <span> only honors style={{ fg, bg, attributes }} (see reconciler setProperty).

import { ErrorBoundary, For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { StatsViewModel, StepRow } from "./types.ts"
import { formatClock, formatCompact, formatCost, formatNumber, formatRange, truncateMiddle } from "./format.ts"
import { STEP_ROWS } from "./stats.ts"

export type ViewState =
  | { status: "loading"; previous?: StatsViewModel }
  | { status: "ready"; model: StatsViewModel }
  | { status: "error"; message: string; previous?: StatsViewModel }

export interface StatsViewProps {
  state: ViewState
  refreshing: boolean
}

const DIM = "#888888"
const FAINT = "#666666"
const WARN = "#d29922"
const ERR = "#f85149"
const VALUE = "#adb5bd"

function usageSum(u: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }) {
  return u.input + u.output + u.reasoning + u.cacheRead + u.cacheWrite
}

/** Bar with the numeric value always adjacent (never color-only). */
function Bar(props: { value: number; max: number; width?: number; color: string }) {
  const width = props.width ?? 20
  const filled = props.max > 0 ? Math.min(width, Math.max(0, Math.round((props.value / props.max) * width))) : 0
  return (
    <span>
      <span style={{ fg: props.color }}>{"█".repeat(filled)}</span>
      <span style={{ fg: FAINT }}>{"░".repeat(width - filled)}</span>
    </span>
  )
}

function Header(props: { model: StatsViewModel }) {
  const m = () => props.model
  const steps = () => m().attributedSteps + m().runningSteps
  return (
    <box flexDirection="column">
      <text attributes={1}>{m().title}</text>
      <text fg={DIM}>
        {m().status === "running" ? "running…" : "idle"} · {m().models.length} model
        {m().models.length === 1 ? "" : "s"} · {steps()} step{steps() === 1 ? "" : "s"}
      </text>
      <text>
        <span style={{ attributes: 1 }}>COST </span>
        <span style={{ fg: VALUE }}>{formatCost(m().totalCost)}</span>
        <span style={{ fg: DIM }}> · Σ reported </span>
        <span>{formatNumber(usageSum(m().totals))}</span>
        <span style={{ fg: FAINT }}> tk*</span>
      </text>
    </box>
  )
}

function Composition(props: { model: StatsViewModel }) {
  const m = () => props.model
  const max = () => Math.max(usageSum(m().totals), 1)
  const parts = () => [
    { label: "INPUT", value: m().totals.input, color: "#79c0ff" },
    { label: "OUTPUT", value: m().totals.output, color: "#7ee787" },
    { label: "REASONING", value: m().totals.reasoning, color: "#d2a8ff" },
    { label: "CACHE READ", value: m().totals.cacheRead, color: "#ffa657" },
    { label: "CACHE WRITE", value: m().totals.cacheWrite, color: "#f0883e" },
  ]
  return (
    <box flexDirection="column">
      <For each={parts()}>
        {(p) => (
          <text>
            <span style={{ fg: DIM }}>{p.label.padEnd(13)}</span>
            <Bar value={p.value} max={max()} color={p.color} />
            <span> {formatNumber(p.value).padStart(9)}</span>
          </text>
        )}
      </For>
      <text fg={FAINT}>* categories may overlap by provider; cost is the comparable figure</text>
      <Show when={m().unattributedCost > 0.0001 || usageSum(m().unattributed) > 0}>
        <text fg={WARN}>
          other/auxiliary: {formatNumber(usageSum(m().unattributed))} tk · {formatCost(m().unattributedCost)}
        </text>
      </Show>
    </box>
  )
}

function ContextWindow(props: { model: StatsViewModel }) {
  const c = () => props.model.context
  return (
    <Show when={c()}>
      {(ctx) => (
        <box flexDirection="column">
          <text attributes={1}>CONTEXT WINDOW</text>
          <text>
            <Bar value={ctx().used} max={ctx().limit} color="#56d364" />
            <span>
              {" "}
              {formatCompact(ctx().used)} / {formatCompact(ctx().limit)} (
              {Math.min(999, Math.round((ctx().used / ctx().limit) * 100))}%)
            </span>
          </text>
          <text fg={FAINT}>last completed step's prompt · estimate</text>
        </box>
      )}
    </Show>
  )
}

function ByModel(props: { model: StatsViewModel }) {
  return (
    <Show when={props.model.models.length > 0}>
      <box flexDirection="column">
        <text attributes={1}>BY MODEL</text>
        <For each={props.model.models}>
          {(m) => (
            <text>
              <span>{truncateMiddle(`${m.providerID}/${m.id}${m.variant ? `@${m.variant}` : ""}`, 34).padEnd(34)}</span>
              <span style={{ fg: VALUE }}>{formatNumber(m.tokens).padStart(9)}</span>
              <span> tk </span>
              <span style={{ fg: VALUE }}>{formatCost(m.cost).padStart(8)}</span>
              <span style={{ fg: FAINT }}> {m.steps} steps</span>
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

function Steps(props: { model: StatsViewModel }) {
  const rows = (): StepRow[] => props.model.steps.slice(0, STEP_ROWS)
  return (
    <Show when={props.model.steps.length > 0}>
      <box flexDirection="column">
        <text attributes={1}>
          RECENT STEPS (last {Math.min(STEP_ROWS, props.model.steps.length)} of {props.model.steps.length})
        </text>
        <For each={rows()}>
          {(s) => (
            <text>
              <span style={{ fg: DIM }}>{formatClock(s.at)}</span>
              <span> {truncateMiddle(s.model, 24).padEnd(24)} </span>
              <Show
                when={s.status === "ok"}
                fallback={<span style={{ fg: WARN }}>{s.status === "running" ? "running…" : "error"}</span>}
              >
                <span style={{ fg: VALUE }}>{`in ${formatCompact(s.input)} out ${formatCompact(s.output)}`.padEnd(24)}</span>
                <span>{formatCost(s.cost).padStart(8)}</span>
                <Show when={s.toolCalls > 0}>
                  <span style={{ fg: FAINT }}> {s.toolCalls} tools</span>
                </Show>
              </Show>
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

function Subagents(props: { model: StatsViewModel }) {
  const total = () => props.model.subagents.reduce((n, s) => n + s.tokens, 0)
  return (
    <Show when={props.model.subagents.length > 0}>
      <box flexDirection="column">
        <text attributes={1}>
          SUBAGENTS ({props.model.subagents.length}) · {formatNumber(total())} tk
        </text>
        <For each={props.model.subagents}>
          {(s) => (
            <text>
              <span>{truncateMiddle(s.title, 24).padEnd(24)}</span>
              <span style={{ fg: VALUE }}>{formatNumber(s.tokens).padStart(9)}</span>
              <span> tk </span>
              <span style={{ fg: VALUE }}>{formatCost(s.cost).padStart(8)}</span>
            </text>
          )}
        </For>
        <text fg={FAINT}>reported for child sessions; not added to session totals</text>
      </box>
    </Show>
  )
}

function Project(props: { model: StatsViewModel }) {
  const p = () => props.model.project
  return (
    <Show when={p()}>
      {(proj) => (
        <box flexDirection="column">
          <text attributes={1}>PROJECT · {formatRange(proj().rangeFrom, proj().rangeTo)}</text>
          <text>
            <span>{proj().sessions} sessions · </span>
            <span>{formatNumber(proj().tokens)} tk · </span>
            <span>{formatCost(proj().cost)}</span>
          </text>
          <text fg={FAINT}>
            {proj().prompts} prompts · {proj().steps} steps · {proj().subagents} subagents (incl. this session)
          </text>
        </box>
      )}
    </Show>
  )
}

function Warnings(props: { model: StatsViewModel }) {
  return (
    <Show when={props.model.warnings.length > 0}>
      <box flexDirection="column">
        <For each={props.model.warnings}>{(w) => <text fg={WARN}>⚠ {w}</text>}</For>
      </box>
    </Show>
  )
}

function Empty() {
  return (
    <box flexDirection="column">
      <text>No usage recorded yet.</text>
      <text fg={DIM}>Send a prompt, then run /tokens_usage again.</text>
    </box>
  )
}

export function StatsView(props: StatsViewProps) {
  const model = () => (props.state.status === "ready" ? props.state.model : props.state.previous)
  // Host dialog presets are fixed widths (medium 60 / large 88 / xlarge 116
  // columns), so to honor "adapt to the window", size our own content box:
  // 85% of the terminal width (≈15% margin per side), clamped to what the
  // host's xlarge container allows. Reactive: re-renders on terminal resize.
  const dims = useTerminalDimensions()
  const contentWidth = () => {
    const w = dims().width
    if (!w || w <= 0) return undefined
    return Math.max(40, Math.min(Math.floor(w * 0.85), w - 2))
  }
  return (
    <ErrorBoundary
      fallback={(err) => (
        <box flexDirection="column" padding={1}>
          <text fg={ERR}>Failed to render stats: {String(err)}</text>
          <text fg={DIM}>esc close</text>
        </box>
      )}
    >
      <box flexDirection="column" padding={1} gap={1} width={contentWidth()}>
        <Show when={props.state.status === "loading" && !model()}>
          <text fg={DIM}>Loading token usage…</text>
        </Show>
        <Show when={props.state.status === "error" && !model()}>
          <box flexDirection="column">
            <text fg={ERR}>{(props.state as { message: string }).message}</text>
            <text fg={DIM}>esc close · r retry</text>
          </box>
        </Show>
        <Show when={model()}>
          {(m) => (
            <Show when={m().attributedSteps > 0} fallback={<Empty />}>
              <Header model={m()} />
              <Composition model={m()} />
              <ContextWindow model={m()} />
              <ByModel model={m()} />
              <Steps model={m()} />
              <Subagents model={m()} />
              <Project model={m()} />
              <Warnings model={m()} />
            </Show>
          )}
        </Show>
        <text fg={FAINT}>{props.refreshing ? "refreshing…" : "esc close · r refresh"}</text>
      </box>
    </ErrorBoundary>
  )
}
