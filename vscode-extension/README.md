# vibe-tunnel for VS Code

Sidebar for [vibe-tunnel](https://github.com/DennisGankin/vibe-tunnel): VS Code + Claude Code inside a
sandboxed container on the Euler cluster. Start a tunnel from a saved config, reconnect to a running one,
stop it, read its log, or set up a new one step by step — without leaving VS Code.

## Install

Download `vibe-tunnel-<version>.vsix` from the repository's `vscode-extension/` folder (or a release), then in
VS Code: *Extensions* → `···` → *Install from VSIX…*. Or from a terminal: `code --install-extension vibe-tunnel-<version>.vsix`.

If you use VS Code **profiles**, extensions are per profile: install it in the profile you work in (*Install from
VSIX…* inside that profile, or `code --profile <name> --install-extension …`).

## Requirements

- ssh access to the cluster that works **without prompts**: an ssh key loaded in your agent, or (macOS/Linux)
  a connection opened once via *Log in via terminal* in the sidebar, which the extension then reuses for 15 minutes.
- The vibe-tunnel installation on the cluster (your group's shared one, or your own). Set its path and the ssh
  host under *Settings → vibe-tunnel*.
- The *Remote - Tunnels* extension (offered for installation when first needed).

Works on macOS, Linux and Windows (Windows ships OpenSSH; no WSL needed for the extension).

## Use

The **vibe-tunnel** view in the activity bar has two start rows at the top (also as buttons in the view's title bar):

- **New container tunnel…** (shield): VS Code runs inside the sandbox container. Terminals and the Claude Code
  extension only see the directories you bind. This is the default kind.
- **New node tunnel…** (server): VS Code runs on the compute node itself, with your cluster home and extensions and
  no container. Nothing is sandboxed until you run `vibe-tunnel claude` in a terminal of that window, which starts
  the container with the sandbox you chose.

Either one starts from a saved config (as saved, or adjusted first) or from scratch, and walks through workspace
(with a remote directory browser), sandbox home, extra read-only / read-write directories, resources (profile plus
per-field overrides) and label, then saves and/or launches.

Below that, **Running tunnels** shows each tunnel's kind (shield + "container", or server + "node · no sandbox");
click to connect, or stop / show the log from the inline buttons. **Saved configs** launch with a click, as the
kind they were saved as (configs saved as node tunnels are marked "node"); the context menu has *Launch as
container tunnel*, *Launch as node tunnel*, edit, delete, and Claude / a shell in that sandbox in a terminal.

While a job starts, a progress notification follows it; if the VS Code tunnel needs its one-time GitHub login,
the code is copied to your clipboard and a button opens GitHub. When the tunnel is up, a new VS Code window
opens at the workspace inside the container.

Everything the extension does is a `vibe-tunnel` command on the cluster, so the terminal menu
(`vibe-tunnel launch`) and the sidebar see the same tunnels and configs.
