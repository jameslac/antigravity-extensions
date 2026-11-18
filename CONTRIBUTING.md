# Contributing to Antigravity Extensions

Contributions—bug fixes, UI improvements, new skills, and brand new plugins—are welcome!

## Repository Layout

Each plugin lives in its own folder under `plugins/<plugin-name>/`:

```text
plugins/<plugin-name>/
├── plugin.json             # Required manifest (lowercase kebab-case name)
├── README.md               # User-facing documentation
├── assets/
│   └── logo.svg            # Optional square icon (>=128x128, transparent bg)
├── skills/
│   └── <skill-name>/
│       └── SKILL.md        # Optional agent skill
├── agents/                 # Optional subagent definitions (*.md)
├── rules/
│   └── AGENTS.md           # Optional always-on rules when plugin is enabled
├── mcp_config.json         # Optional MCP server configuration
├── hooks.json              # Optional lifecycle hooks (must be at plugin root)
└── sidecars/
    └── <sidecar-id>/
        ├── sidecar.json    # Sidecar process + UI entrypoint config
        └── ...             # Backend & Web UI assets
```

## Plugin & Sidecar Authoring Guidelines

1. **`plugin.json` fields**: Only use supported top-level fields (`name`, `displayName`, `version`, `description`, `logo`, `author`, `homepage`, `repository`, `suggestedPrompts`, `disabled`). Unknown top-level keys are ignored by the loader.
2. **Globally unique `name`**: `name` shares a global namespace across all installed Antigravity plugins. Use lowercase `kebab-case`.
3. **Sidecar `ui_config.views` paths**: Use clean pathnames without query strings (e.g., `"/"` or `"/conversation"`), because the Antigravity host appends `?token=...&conversationId=...` directly to `path`.
4. **Sidecar entrypoints**:
   - `SIDECAR_UI_ENTRYPOINT_SIDEBAR` — listed in the left-hand sidebar's **Plugins** section.
   - `SIDECAR_UI_ENTRYPOINT_AUX_PANE` — opens in the conversation's right-hand auxiliary pane (and can be triggered from chat via `[Title](sidecar://<plugin>/<sidecar>/<path>)`).
5. **No symlinks in `~/.gemini/config/plugins/`**: Use `./install.sh <plugin-name>` (which copies real directories) or `.agents/plugins.json` when testing locally so the Language Server discovers directories reliably.

## Development Workflow

```bash
git clone https://github.com/jameslac/antigravity-extensions.git
cd antigravity-extensions
git checkout -b feat/my-update

# Make changes under plugins/<plugin-name>/, then sync to your local Antigravity config:
./install.sh <plugin-name>
```

If you modify a sidecar's `main.mjs` or backend code, note that the Antigravity Language Server reloads sidecars when `sidecar.json` changes (or when toggling the plugin off/on in Customizations).
