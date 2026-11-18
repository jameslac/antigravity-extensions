#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${ANTIGRAVITY_EXTENSIONS_REPO:-https://github.com/jameslac/antigravity-extensions.git}"
REPO_BRANCH="${ANTIGRAVITY_EXTENSIONS_BRANCH:-main}"
TARGET_PLUGINS_DIR="${ANTIGRAVITY_PLUGINS_DIR:-$HOME/.gemini/config/plugins}"

usage() {
  cat <<'EOF'
Install, update, or uninstall Antigravity plugins from antigravity-extensions.

Usage:
  ./install.sh                    Install or update all plugins in ./plugins/
  ./install.sh <name> [...]       Install or update specific plugin(s)
  ./install.sh --list             List available plugins in the repository
  ./install.sh --uninstall <name> Remove an installed plugin from ~/.gemini/config/plugins/
  ./install.sh --help             Show this help message

Remote one-liner:
  curl -fsSL https://raw.githubusercontent.com/jameslac/antigravity-extensions/main/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/jameslac/antigravity-extensions/main/install.sh | bash -s -- usage-monitor
EOF
}

SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" ]] && [[ -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

CLEANUP_DIR=""
cleanup() {
  if [[ -n "$CLEANUP_DIR" && -d "$CLEANUP_DIR" ]]; then
    rm -rf "$CLEANUP_DIR"
  fi
}
trap cleanup EXIT

resolve_plugins_src() {
  if [[ -n "$SCRIPT_DIR" && -d "$SCRIPT_DIR/plugins" ]]; then
    echo "$SCRIPT_DIR/plugins"
    return 0
  fi
  if ! command -v git >/dev/null 2>&1; then
    echo "Error: git is required when running remotely." >&2
    exit 1
  fi
  CLEANUP_DIR="$(mktemp -d)"
  echo "Cloning $REPO_URL ($REPO_BRANCH)..." >&2
  git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$CLEANUP_DIR/repo" >/dev/null 2>&1
  echo "$CLEANUP_DIR/repo/plugins"
}

list_plugins() {
  local src="$1"
  echo "Available plugins:"
  for dir in "$src"/*; do
    [[ -d "$dir" && -f "$dir/plugin.json" ]] || continue
    local name
    name="$(basename "$dir")"
    echo "  - $name"
  done
}

install_plugin() {
  local src="$1"
  local name="$2"
  local src_dir="$src/$name"
  local dest_dir="$TARGET_PLUGINS_DIR/$name"

  if [[ ! -d "$src_dir" || ! -f "$src_dir/plugin.json" ]]; then
    echo "Error: plugin '$name' not found under $src" >&2
    exit 1
  fi

  mkdir -p "$TARGET_PLUGINS_DIR"

  # Replace symlinks or prior installs with a real directory copy so the
  # Antigravity Language Server discovers the plugin cleanly via os.ReadDir.
  if [[ -L "$dest_dir" ]]; then
    rm -f "$dest_dir"
  elif [[ -d "$dest_dir" ]]; then
    rm -rf "$dest_dir"
  fi

  cp -R "$src_dir" "$dest_dir"
  echo "Installed '$name' -> $dest_dir"
}

uninstall_plugin() {
  local name="$1"
  local dest_dir="$TARGET_PLUGINS_DIR/$name"
  if [[ -L "$dest_dir" ]]; then
    rm -f "$dest_dir"
    echo "Removed '$name' ($dest_dir)"
  elif [[ -d "$dest_dir" ]]; then
    rm -rf "$dest_dir"
    echo "Removed '$name' ($dest_dir)"
  else
    echo "Plugin '$name' is not installed at $dest_dir"
  fi
}

main() {
  if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    usage
    exit 0
  fi

  if [[ "${1:-}" == "--uninstall" ]]; then
    shift
    if [[ $# -eq 0 ]]; then
      echo "Error: --uninstall requires at least one plugin name." >&2
      exit 1
    fi
    for name in "$@"; do
      uninstall_plugin "$name"
    done
    exit 0
  fi

  local plugins_src
  plugins_src="$(resolve_plugins_src)"

  if [[ "${1:-}" == "--list" ]]; then
    list_plugins "$plugins_src"
    exit 0
  fi

  local targets=()
  if [[ $# -gt 0 ]]; then
    targets=("$@")
  else
    for dir in "$plugins_src"/*; do
      [[ -d "$dir" && -f "$dir/plugin.json" ]] || continue
      targets+=("$(basename "$dir")")
    done
  fi

  if [[ ${#targets[@]} -eq 0 ]]; then
    echo "No plugins found in $plugins_src" >&2
    exit 1
  fi

  for name in "${targets[@]}"; do
    install_plugin "$plugins_src" "$name"
  done

  echo ""
  echo "Done! Antigravity discovers plugins in $TARGET_PLUGINS_DIR automatically."
}

main "$@"
