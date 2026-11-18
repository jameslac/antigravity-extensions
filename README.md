# Antigravity Extensions

A collection of plugins, UI sidecars, skills, and customizations for [Google Antigravity](https://antigravity.google).

## Available Plugins

| Plugin | Display Name | Description |
| :--- | :--- | :--- |
| [`usage-monitor`](./plugins/usage-monitor) | **Model & Token Usage** | Live Antigravity model quota & usage dashboard in the sidebar (`Model Usage`), plus a per-conversation context window & token inspector in the auxiliary pane (`Context & Tokens`). |

---

## Quick Install

### One-line install (macOS / Linux)

Install all plugins in this repository:

```bash
curl -fsSL https://raw.githubusercontent.com/jameslac/antigravity-extensions/main/install.sh | bash
```

Or install a specific plugin (for example, `usage-monitor`):

```bash
curl -fsSL https://raw.githubusercontent.com/jameslac/antigravity-extensions/main/install.sh | bash -s -- usage-monitor
```

Antigravity automatically discovers and loads plugins placed in `~/.gemini/config/plugins/`.

### Install from a local clone

```bash
git clone https://github.com/jameslac/antigravity-extensions.git
cd antigravity-extensions
./install.sh
```

Other handy commands:

```bash
./install.sh --list                    # List plugins in this repository
./install.sh usage-monitor             # Install or update one plugin
./install.sh --uninstall usage-monitor # Remove an installed plugin
```

### Alternative: Load directly via `~/.gemini/config/plugins.json`

If you prefer loading plugins straight from your git clone without copying files on updates, register the `plugins/` folder in `~/.gemini/config/plugins.json`:

```json
{
  "entries": [
    {
      "path": "/absolute/path/to/antigravity-extensions/plugins"
    }
  ]
}
```

---

## Collaborating & Updating Extensions

Multiple contributors can build on existing plugins or add new ones in this repository:

1. Fork or branch `main`.
2. Edit an existing plugin under `plugins/<plugin-name>/` or add a new plugin directory (see [CONTRIBUTING.md](./CONTRIBUTING.md)).
3. Sync your changes into Antigravity locally to test live:
   ```bash
   ./install.sh <plugin-name>
   ```
   *(Or open this repository directly as a workspace in Antigravity — `.agents/plugins.json` auto-discovers `plugins/` inside the workspace.)*
4. Open a Pull Request. Once merged, anyone can update by pulling and running `./install.sh`, or re-running the one-line curl installer.

## License

[MIT](./LICENSE)
