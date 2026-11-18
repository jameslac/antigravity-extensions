---
name: usage-monitor
description: Inspect Antigravity model quotas, per-model usage, and per-conversation context window and token usage. Use when the user asks about their model quota, token usage, context window usage, cache hit rate, or wants to open the Model Usage sidebar or Context & Tokens side pane.
---

# Model & Token Usage (`usage-monitor`)

This plugin provides two live UI views backed by the `usage-monitor/usage_dashboard` sidecar:

1. **Model Usage** (`SIDECAR_UI_ENTRYPOINT_SIDEBAR`, path `/`): Listed in the left-hand sidebar's Plugins section. Shows Antigravity model quota buckets (`RetrieveUserQuotaSummary`), per-model quota limits (`GetCascadeModelConfigData` / `GetAvailableModels`), aggregated token usage across models, and a ranked list of conversations.
2. **Context & Tokens** (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`, path `/conversation`): Opens in the right-hand auxiliary pane for the currently active conversation and shows live context window fill (`used / max` tokens, `%`, `tokenBreakdown` groups), cumulative conversation token totals (uncached input, cache read, cache write, output, thinking vs. response), per-model split, and turn-by-turn token timeline.

## Opening the UI Panel

When the user asks to view context/token usage for a conversation or open the inspector pane, emit the Aux Pane pill link on its own line (if the `usage-monitor` plugin is enabled):

```markdown
[Context & Tokens](sidecar://usage-monitor/usage_dashboard/conversation)
```

Also let the user know they can open the **Model Usage** view directly from the **Plugins** section of the left-hand sidebar.

## Querying Usage via Language Server RPCs

If the user asks for a direct text summary of their quota or current conversation token usage in chat:

1. **Model Quota Summary**:
   Query `RetrieveUserQuotaSummary` and `GetCascadeModelConfigData` via `POST http://$ANTIGRAVITY_LS_ADDRESS/exa.language_server_pb.LanguageServerService/<Method>` with header `x-codeium-csrf-token: $ANTIGRAVITY_CSRF_TOKEN`.
2. **Conversation Context & Token Usage**:
   Query `GetCascadeTrajectoryGeneratorMetadata` with `{"cascadeId": "<conversationId>", "includeMessages": false}` for exact per-turn `usage` (`inputTokens`, `outputTokens`, `thinkingOutputTokens`, `responseOutputTokens`, `cacheReadTokens`, `cacheWriteTokens`) and `chatStartMetadata.contextWindowMetadata` (`estimatedTokensUsed`, `maxContextTokens`, `tokenBreakdown`), or inspect `<appDataDir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`.
