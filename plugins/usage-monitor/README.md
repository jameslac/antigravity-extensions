# Model & Token Usage (`usage-monitor`)

An Antigravity UI plugin that adds:

1. **Sidebar Model Usage Dashboard (`Model Usage`)**: Located in the left-hand sidebar's Plugins section (`SIDECAR_UI_ENTRYPOINT_SIDEBAR`). Shows live Antigravity model quota buckets (`RetrieveUserQuotaSummary`, `GetAvailableModels`, `GetCascadeModelConfigData`), quota reset countdowns, total token usage aggregated by model across conversations, and a searchable/sortable list of conversations by token usage.
2. **Conversation Context & Token Inspector (`Context & Tokens`)**: Available in the right-hand auxiliary pane (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) for each open conversation. Automatically tracks `window.sidecar.conversationId` and shows real-time context window usage (`used / max`, `%`, cached prefix vs. new uncached input, and `tokenBreakdown` sections/tools/messages), cumulative conversation totals (uncached input, cache read + hit rate %, cache write, output + thinking split, latency), per-model breakdown, and a turn-by-turn token timeline.

## Files

- `plugin.json` — Plugin manifest
- `assets/logo.svg` — Plugin icon
- `skills/usage-monitor/SKILL.md` — Agent skill for surfacing the pane pill and querying usage data
- `sidecars/usage_dashboard/` — Node.js sidecar (`main.mjs`) and Web UI (`index.html`, `styles.css`, `app.js`)

## Standalone Development

Run outside the Language Server with `ANTIGRAVITY_LS_ADDRESS`, `ANTIGRAVITY_CSRF_TOKEN`, and `ANTIGRAVITY_SIDECAR_WEB_PORT` set:

```bash
ANTIGRAVITY_SIDECAR_WEB_PORT=4321 node sidecars/usage_dashboard/main.mjs
```

Then open `http://127.0.0.1:4321/` for the Sidebar view or `http://127.0.0.1:4321/conversation?conversationId=<uuid>` for the Conversation view.
