// Server-side sibling entry. OpenCode loads `exports["."]` as the main plugin;
// the TUI lives in ./tui. This plugin is CLI-only, so the server entry is a
// no-op that keeps the package's main export a valid plugin definition.

import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "loaf.tokens-usage",
  setup() {
    // No server-side behavior: /tokens_usage is implemented entirely in the
    // CLI plugin (src/tui.tsx).
  },
})
