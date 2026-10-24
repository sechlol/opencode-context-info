// Root-level server-entry shim for config-file registration.
// A directory configured in `plugins` loads its `index` (or `server`) module
// as the server entry; this re-exports the real no-op server plugin.
export { default } from "./src/index.ts"