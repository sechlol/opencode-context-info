/** @jsxImportSource @opentui/solid */
// Presentational components for the stats dialog. All data arrives as a
// ready-made StatsViewModel; this module owns no aggregation.
//
// The view renders inside the host's dialog content area, whose width comes
// from the DialogSize preset (fixed columns — chosen to fit the terminal by
// tui.tsx); the root box fills that width. The host does not bound the
// dialog's height (auto-height, centered), so sections live in a scrollbox
// whose terminal-derived maxHeight keeps long content scrolling inside the
// dialog instead of running off the screen. Colors come from semantic theme
// tokens via usePlugin() — no hardcoded hex.
//
// OpenTUI note: <text> accepts fg/attributes directly (TextOptions), but
// <span> only honors style={{ fg, bg, attributes }} (see reconciler setProperty).

import { ErrorBoundary, For, Show, createSignal, onCleanup } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
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
  /** Called for the `r` refresh binding (dialog-scoped keymap layer). */
  onRefresh: () => void
}

type Theme = ReturnType<typeof usePlugin>["theme"]

function useTones() {
  const t = usePlugin().theme
  return {
    value: t.text.base,
    dim: t.text.muted,
    faint: t.text.faint,
    warn: t.text.feedback.warning.base,
    err: t.text.feedback.error.base,
    bg: t.background.base,
    border: t.border.base,
  }
}

/**
 * Category color from the theme's categorical hue scales
 * (accent / interactive / neutral; steps 100..900). Deterministic per index.
 */
function categoryColor(theme: Theme, index: number) {
  const steps = [500, 600, 400, 700, 300] as const
  const scale = theme.categorical[index % theme.categorical.length]
  if (!scale) return theme.text.muted
  const hueName = Object.keys(scale)[0] as keyof typeof scale | undefined
  if (!hueName) return theme.text.muted
  const hue = scale[hueName]
  if (!hue) return theme.text.muted
  const step = steps[index % steps.length] as keyof typeof hue | undefined
  return (step ? hue[step] : undefined) ?? theme.text.muted
}

function usageSum(u: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }) {
  return u.input + u.output + u.reasoning + u.cacheRead + u.cacheWrite
}

type PanelTone = { toString(): string } | number | undefined

/** Bar with the numeric value always adjacent (never color-only). */
function Bar(props: { value: number; max: number; width?: number; color: PanelTone; faint: PanelTone }) {
  const width = props.width ?? 20
  const filled = props.max > 0 ? Math.min(width, Math.max(0, Math.round((props.value / props.max) * width))) : 0
  return (
    <span>
      <span style={{ fg: props.color }}>{"█".repeat(filled)}</span>
      <span style={{ fg: props.faint }}>{"░".repeat(width - filled)}</span>
    </span>
  )
}

function Header(props: { model: StatsViewModel }) {
  const tones = useTones()
  const m = () => props.model
  const steps = () => m().attributedSteps + m().runningSteps
  return (
    <box flexDirection="column">
      <text attributes={1}>{m().title}</text>
      <text fg={tones.dim}>
        {m().status === "running" ? "running…" : "idle"} · {m().models.length} model
        {m().models.length === 1 ? "" : "s"} · {steps()} step{steps() === 1 ? "" : "s"}
      </text>
      <text>
        <span style={{ attributes: 1 }}>COST </span>
        <span style={{ fg: tones.value }}>{formatCost(m().totalCost)}</span>
        <span style={{ fg: tones.dim }}> · Σ reported </span>
        <span>{formatNumber(usageSum(m().totals))}</span>
        <span style={{ fg: tones.faint }}> tk*</span>
      </text>
    </box>
  )
}

function Composition(props: { model: StatsViewModel }) {
  const tones = useTones()
  const theme = usePlugin().theme
  const m = () => props.model
  const max = () => Math.max(usageSum(m().totals), 1)
  const parts = () => [
    { label: "INPUT", value: m().totals.input },
    { label: "OUTPUT", value: m().totals.output },
    { label: "REASONING", value: m().totals.reasoning },
    { label: "CACHE READ", value: m().totals.cacheRead },
    { label: "CACHE WRITE", value: m().totals.cacheWrite },
  ]
  return (
    <box flexDirection="column">
      <For each={parts()}>
        {(p, i) => (
          <text>
            <span style={{ fg: tones.dim }}>{p.label.padEnd(13)}</span>
            <Bar value={p.value} max={max()} color={categoryColor(theme, i())} faint={tones.faint} />
            <span> {formatNumber(p.value).padStart(9)}</span>
          </text>
        )}
      </For>
      <text fg={tones.faint}>* categories may overlap by provider; cost is the comparable figure</text>
      <Show when={m().unattributedCost > 0.0001 || usageSum(m().unattributed) > 0}>
        <text fg={tones.warn}>
          other/auxiliary: {formatNumber(usageSum(m().unattributed))} tk · {formatCost(m().unattributedCost)}
        </text>
      </Show>
    </box>
  )
}

function ContextWindow(props: { model: StatsViewModel }) {
  const tones = useTones()
  const theme = usePlugin().theme
  const c = () => props.model.context
  return (
    <Show when={c()}>
      {(ctx) => (
        <box flexDirection="column">
          <text attributes={1}>CONTEXT WINDOW</text>
          <text>
            <Bar value={ctx().used} max={ctx().limit} color={categoryColor(theme, 1)} faint={tones.faint} />
            <span>
              {" "}
              {formatCompact(ctx().used)} / {formatCompact(ctx().limit)} (
              {Math.min(999, Math.round((ctx().used / ctx().limit) * 100))}%)
            </span>
          </text>
          <text fg={tones.faint}>last completed step's prompt · estimate</text>
        </box>
      )}
    </Show>
  )
}

function ByModel(props: { model: StatsViewModel }) {
  const tones = useTones()
  return (
    <Show when={props.model.models.length > 0}>
      <box flexDirection="column">
        <text attributes={1}>BY MODEL</text>
        <For each={props.model.models}>
          {(m) => (
            <text>
              <span>{truncateMiddle(`${m.providerID}/${m.id}${m.variant ? `@${m.variant}` : ""}`, 34).padEnd(34)}</span>
              <span style={{ fg: tones.value }}>{formatNumber(m.tokens).padStart(9)}</span>
              <span> tk </span>
              <span style={{ fg: tones.value }}>{formatCost(m.cost).padStart(8)}</span>
              <span style={{ fg: tones.faint }}> {m.steps} steps</span>
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

function Steps(props: { model: StatsViewModel }) {
  const tones = useTones()
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
              <span style={{ fg: tones.dim }}>{formatClock(s.at)}</span>
              <span> {truncateMiddle(s.model, 24).padEnd(24)} </span>
              <Show
                when={s.status === "ok"}
                fallback={<span style={{ fg: tones.warn }}>{s.status === "running" ? "running…" : "error"}</span>}
              >
                <span style={{ fg: tones.value }}>{`in ${formatCompact(s.input)} out ${formatCompact(s.output)}`.padEnd(24)}</span>
                <span>{formatCost(s.cost).padStart(8)}</span>
                <Show when={s.toolCalls > 0}>
                  <span style={{ fg: tones.faint }}> {s.toolCalls} tools</span>
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
  const tones = useTones()
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
              <span style={{ fg: tones.value }}>{formatNumber(s.tokens).padStart(9)}</span>
              <span> tk </span>
              <span style={{ fg: tones.value }}>{formatCost(s.cost).padStart(8)}</span>
            </text>
          )}
        </For>
        <text fg={tones.faint}>reported for child sessions; not added to session totals</text>
      </box>
    </Show>
  )
}

function Project(props: { model: StatsViewModel }) {
  const tones = useTones()
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
          <text fg={tones.faint}>
            {proj().prompts} prompts · {proj().steps} steps · {proj().subagents} subagents (incl. this session)
          </text>
        </box>
      )}
    </Show>
  )
}

function Warnings(props: { model: StatsViewModel }) {
  const tones = useTones()
  return (
    <Show when={props.model.warnings.length > 0}>
      <box flexDirection="column">
        <For each={props.model.warnings}>{(w) => <text fg={tones.warn}>⚠ {w}</text>}</For>
      </box>
    </Show>
  )
}

function Empty() {
  const tones = useTones()
  return (
    <box flexDirection="column">
      <text>No usage recorded yet.</text>
      <text fg={tones.dim}>Send a prompt, then run /tokens_usage again.</text>
    </box>
  )
}

/**
 * Terminal rows, tracked across resizes. The host renders custom dialogs
 * auto-height (its dialog box gets only a width preset, never a height), so
 * nothing upstream bounds our content area — the scrollbox has to carry its
 * own vertical bound derived from the terminal. Returns undefined when the
 * renderer is unavailable, in which case the bound is omitted and content
 * simply flows (it can never collapse to zero height this way).
 */
function useScrollMaxHeight(): () => number | undefined {
  const renderer = usePlugin().renderer
  const [rows, setRows] = createSignal<number | undefined>(renderer?.height)
  try {
    const onResize = () => setRows(renderer?.height)
    renderer?.on("resize", onResize)
    onCleanup(() => renderer?.off("resize", onResize))
  } catch {
    // No resize stream — the value captured at render time still applies.
  }
  // Rows reserved outside the scrollbox: the host dialog's paddingTop (1),
  // the root box's paddingTop (1), the gap above the footer (1), the footer
  // line (1), and 2 rows of margin around the centered dialog. Clamped to ≥1
  // so the scrollbox always keeps at least one row of content visible.
  return () => {
    const r = rows()
    return r === undefined ? undefined : Math.max(1, r - 6)
  }
}

export function StatsView(props: StatsViewProps) {
  const tones = useTones()
  const model = () => (props.state.status === "ready" ? props.state.model : props.state.previous)
  // Layout: the dialog content area has a definite width (the chosen preset)
  // but auto height, so the root box fills the width, paints the background,
  // and caps the scrollbox with a terminal-derived maxHeight. The scrollbox
  // scrolls/clips the sections when they exceed that bound (flexGrow/shrink
  // also let it take or give space if a host ever bounds the dialog box
  // itself); when nothing constrains it, it sizes to its content and renders
  // fully. The footer sits outside the scrollbox so it stays visible below.
  const scrollMaxHeight = useScrollMaxHeight()
  const tonesBg = tones.bg
  return (
    <ErrorBoundary
      fallback={(err) => (
        <box flexDirection="column" padding={1} backgroundColor={tonesBg}>
          <text fg={tones.err}>Failed to render stats: {String(err)}</text>
          <text fg={tones.dim}>esc close</text>
        </box>
      )}
    >
      <box flexDirection="column" width="100%" flexGrow={1} backgroundColor={tonesBg} paddingLeft={2} paddingTop={1} gap={1}>
        <scrollbox
          width="100%"
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          maxHeight={scrollMaxHeight()}
          contentOptions={{ gap: 1 }}
          focused
        >
          <Show when={props.state.status === "loading" && !model()}>
            <text fg={tones.dim}>Loading token usage…</text>
          </Show>
          <Show when={props.state.status === "error" && !model()}>
            <box flexDirection="column">
              <text fg={tones.err}>{(props.state as { message: string }).message}</text>
              <text fg={tones.dim}>esc close · r retry</text>
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
        </scrollbox>
        <text fg={tones.faint}>{props.refreshing ? "refreshing…" : "esc close · r refresh"}</text>
      </box>
    </ErrorBoundary>
  )
}
