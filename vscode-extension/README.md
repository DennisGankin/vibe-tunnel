# vibe-tunnel for VS Code

Sidebar for [vibe-tunnel](https://github.com/DennisGankin/vibe-tunnel): VS Code + Claude Code inside a
sandboxed container on the Euler cluster. Start a tunnel from a saved config, reconnect to a running one,
stop it, read its log, or set up a new one step by step — without leaving VS Code.

## Install

Download `vibe-tunnel-<version>.vsix` from the repository's `vscode-extension/` folder (or a release), then in
VS Code: *Extensions* → `···` → *Install from VSIX…*. Or from a terminal: `code --install-extension vibe-tunnel-<version>.vsix`.

## Requirements

- ssh access to the cluster that works **without prompts**: an ssh key loaded in your agent, or (macOS/Linux)
  a connection opened once via *Log in via terminal* in the sidebar, which the extension then reuses for 15 minutes.
- The vibe-tunnel installation on the cluster (your group's shared one, or your own). Set its path and the ssh
  host under *Settings → vibe-tunnel*.
- The *Remote - Tunnels* extension (offered for installation when first needed).

Works on macOS, Linux and Windows (Windows ships OpenSSH; no WSL needed for the extension).

## Use

The **vibe-tunnel** view in the activity bar lists your **running tunnels** (click to connect, or stop / log
from the inline buttons) and your **saved configs** (click to launch; edit, delete, or run Claude / a shell in
that sandbox from the context menu). **New tunnel…** starts from a saved config or from scratch and walks
through workspace (with a remote directory browser), sandbox home, extra read-only / read-write directories,
mode, resources (profile plus per-field overrides) and label, then saves and/or launches.

While a job starts, a progress notification follows it; if the VS Code tunnel needs its one-time GitHub login,
the code is copied to your clipboard and a button opens GitHub. When the tunnel is up, a new VS Code window
opens at the workspace inside the container.

Everything the extension does is a `vibe-tunnel` command on the cluster, so the terminal menu
(`vibe-tunnel launch`) and the sidebar see the same tunnels and configs.
