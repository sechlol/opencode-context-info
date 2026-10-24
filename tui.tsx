// Root-level TUI shim. The server's plugin-feature detection for a directory
// entry may probe conventional file names (tui.ts/tui.tsx) rather than reading
// package.json exports; this shim satisfies both.
export { default } from "./src/tui.tsx"
