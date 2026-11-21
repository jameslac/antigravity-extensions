# Repository Guidelines

## Git & Pull Request Workflow (Mandatory)

All changes to this repository must go through feature branches and Pull Requests so progress is cleanly tracked.

1. **Never commit or push directly to `main`.**
2. **Fetch and branch off `origin/main` before starting work:**
   ```bash
   git fetch origin
   git checkout -b feat/<short-name> origin/main
   ```
   Use descriptive branch prefixes such as `feat/`, `fix/`, `docs/`, or `chore/`.
3. **Keep commits scoped and clear** (for example, `feat(usage-monitor): ...`, `fix(usage-monitor): ...`, `docs: ...`).
4. **Push the branch and open a Pull Request against `main`:**
   ```bash
   git push -u origin <branch>
   gh pr create --base main
   ```
   Include a concise summary of the changes and the verification steps run in the PR description.

## Plugin Verification Notes

- Run syntax checks (`node --check <file>`) on any modified JS/MJS sidecar files before committing.
- Run `./install.sh <plugin-name>` to sync changes into `~/.gemini/config/plugins/` when testing in Antigravity locally (installed plugins must be real directories rather than symlinks so the Language Server discovers them).
- If modifying a sidecar's backend code (such as `main.mjs`), update `sidecar.json` (or toggle the plugin off/on in Customizations) so Antigravity's Language Server detects the change and reloads the running sidecar process.
