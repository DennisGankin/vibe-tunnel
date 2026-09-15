# vibe-tunnel

VS Code + Claude Code **inside a sandboxed container** on an Euler compute node, opened from your laptop with one command. Standalone: one repo, one `vibe-tunnel` command on the laptop and on the cluster.

## Setup for lab members: one command

The Beltrao lab has a shared installation on Euler at `/cluster/project/beltrao/software/vibe-tunnel`
(scripts, built image, VS Code CLI). You never build anything. You need: VS Code desktop with the `code`
command ([how](https://code.visualstudio.com/docs/setup/mac#_launching-from-the-command-line)), a working
`ssh euler` (alias in `~/.ssh/config`), and a Unix shell (macOS, Linux, or WSL on Windows).

```bash
# on your laptop: VS Code with the `code` command + a working `ssh euler`, then
git clone https://github.com/DennisGankin/vibe-tunnel.git ~/vibe-tunnel && cd ~/vibe-tunnel && ./setup.sh --client
```
Answer with your ssh alias (`euler`) and the installation path `/cluster/project/beltrao/software/vibe-tunnel`.
The client then runs that installation's `setup.sh` on the cluster for you, which writes only your private
`~/.vibe-tunnel` and adds `bin/` to your PATH there. Then, in a new shell:

```bash
vibe-tunnel
```
Three one-time logins on the first tunnel, all stored in your private sandbox home: the VS Code tunnel (GitHub
device code, handled by the launcher), Claude inside the container (`claude` in a VS Code terminal), and
installing the Claude Code extension in the tunnel.

Your configs, profiles, logs and sandbox home live in `~/.vibe-tunnel` (mode 700); nothing you do touches the
shared directory. Problems? See [Troubleshooting](#troubleshooting). Other groups: see the maintainer guide in
[docs/CLUSTER_SETUP.md](docs/CLUSTER_SETUP.md) to create such an installation.

## What it is

It grew out of two things the lab used before and replaces both:

- [`codeserver_tunnel`](../codeserver_tunnel.py): submit a slurm job, run `code tunnel` on the node, open the link locally.
- [euler-vibe](https://github.com/jurgjn/euler-vibe/tree/claude-launch-fixes): run Claude Code in a Singularity container with a persistent sandbox home, a workspace mount and explicit read-only / read-write binds (`claude-launch`, `claude-mobile`). Its launch menu, mount logic and container recipe live on here in adapted form; an existing euler-vibe checkout can still be reused for its image and sandbox home (`setup.sh --euler-vibe DIR`).

The key idea: the VS Code tunnel is started **inside the container**, not on the node. So the VS Code server, every integrated terminal, and the Claude Code extension all run in the sandbox. Claude sees exactly the directories you bound, nothing else, and using it from VS Code feels like a normal local setup. Without VS Code, the same sandbox is available as a terminal session (`vibe-tunnel claude`, `vibe-tunnel shell`).

```
laptop                       login node                 compute node (slurm job)
──────                       ──────────                 ────────────────────────────────────
vibe-tunnel ──── ssh ──►  vibe-tunnel launch/submit ─ sbatch ─►  vibe-tunnel-job (host side)
                                                             │  binds: workspace, sandbox home,
                                                             │  extra ro/rw dirs, VS Code CLI
                                                             ▼
                                                           singularity exec vibe-tunnel.sif
                                                             └─ vibe-tunnel-entry
                                                                  ├─ ~/.bashrc, claude self-update
                                                                  └─ code tunnel --name …
VS Code desktop ◄─────────── Microsoft tunnel relay ◄──────────────────┘
(Remote - Tunnels)           (via eth_proxy)
```

The VS Code CLI is not baked into the image: it is a static binary that gets bind-mounted in, so the image only changes when Claude's runtime does.

## What you get

- **Sandbox configs.** `vibe-tunnel launch` assembles workspace, home, ro/rw binds, resource profile and label in one menu and saves them as named configs. Configs saved with euler-vibe's `claude-launch` are read as well. Or pass `--workspace`, `--rw`, `--ro` directly.
- **Persistent home.** Auth for Claude, the VS Code login, the downloaded VS Code server and extensions live in the sandbox home (`/home` in the container, `~/.vibe-tunnel/home` by default), so the second start is fast and needs no logins.
- **Stable tunnel names.** A config's tunnel is named after the config unless you set a label, so VS Code's recent list and `vibe-tunnel open NAME` keep working across jobs.
- **Several tunnels at once**, each with its own label, node and resources. Reopen a running one instead of resubmitting.
- **Resources are editable in the menu.** Profiles (`profiles/*.sbatch`) are presets; the *Resources* entry shows time, CPUs, memory per CPU, GPUs, partition and account, lets you change any of them, and saves the values with the config. Overrides are passed to `sbatch` as flags and beat the profile's `#SBATCH` lines. `vibe-tunnel profiles edit|new NAME` edits or creates a preset (your copies live in `~/.vibe-tunnel/profiles/` and shadow the repo's).
- **One command, both places.** `vibe-tunnel` is bash: on the cluster it is the CLI, on the laptop (no slurm) it drives the cluster copy over ssh. No Python, no environment.

## Quick start (own installation, other groups)

### Once, on the cluster
See [docs/CLUSTER_SETUP.md](docs/CLUSTER_SETUP.md) for details and the verification checklist.

```bash
git clone https://github.com/DennisGankin/vibe-tunnel.git ~/vibe-tunnel
cd ~/vibe-tunnel && module load eth_proxy && ./setup.sh   # builds images/vibe-tunnel.sif, downloads the VS Code CLI, writes ~/.vibe-tunnel/env
vibe-tunnel doctor
```
Already running euler-vibe? `./setup.sh --euler-vibe /path/to/euler-vibe` skips the build and reuses its image and sandbox home, so existing Claude logins carry over. A shared image elsewhere: `./setup.sh --image /path/to/file.sif`.

### Once, on your laptop
```bash
git clone https://github.com/DennisGankin/vibe-tunnel.git ~/vibe-tunnel
cd ~/vibe-tunnel && ./setup.sh --client      # asks for the ssh host, the cluster path of the repo, how to open tunnels
```
Needs a working `ssh euler` (alias in `~/.ssh/config`) and VS Code desktop with the `code` command on PATH. The
client installs the *Remote - Tunnels* extension if missing. Settings go to `~/.config/vibe-tunnel/client`.

### Every time
```bash
vibe-tunnel
```
The same `vibe-tunnel` command works on the laptop and on the cluster; on the laptop it drives the cluster copy over ssh.

1. the menu opens on the cluster. The home screen lists your running tunnels and asks what to do: reconnect to one, start a new VS Code tunnel, or run Claude / a shell in the container without VS Code
2. for a new run you pick a saved config (or start from scratch), then a setup screen shows the choice and has two submenus: *Sandbox* (workspace, home, extra read-only / read-write directories, Tab-completes cluster paths) and *Resources* (profile, time, CPUs, memory, GPUs), plus the tunnel label; save it as a config for next time
3. Launch submits the job; the laptop waits, handles the one-time VS Code login (opens GitHub's device page, copies the code), then opens desktop VS Code at the workspace inside the container. Reconnecting to a running tunnel opens VS Code straight away

Other laptop commands (all run on the cluster over ssh):
```bash
vibe-tunnel submit --config myproj           # non-interactive: submit, wait, open
vibe-tunnel status                           # running tunnels + links
vibe-tunnel open myproj                      # (re)open a running tunnel in VS Code
vibe-tunnel stop myproj
vibe-tunnel logs <jobid> -f
```

### From a login node instead
```bash
vibe-tunnel launch                   # arrow-key menu: workspace, home, binds, profile, label -> submit + wait
```
The menu (adapted from euler-vibe's `claude-launch`) starts with your running tunnels and the choice
reconnect / new tunnel / Claude in a terminal / shell; a new run gets a setup screen with Sandbox and Resources
submenus and can be saved as a named config. Saved configs live in
`~/.vibe-tunnel/configs/NAME.conf` and include the resource profile and label, so a later start is just:
```bash
vibe-tunnel submit --config myproj   # profile, resources + label come from the config; flags override
vibe-tunnel submit --config myproj --time 2-00:00:00 --gpus a100:2   # one-off resource changes
vibe-tunnel wait <jobid>             # prints TUNNEL= / LINK= / DESKTOP= once the tunnel is up
vibe-tunnel status
vibe-tunnel stop myproj
```
Configs saved earlier with `claude-launch` are picked up as well (read-only, shown as "from claude-launch").
Then on the laptop: `code --folder-uri 'vscode-remote://tunnel+myproj/<cluster path of the workspace>'` (printed by `wait`) or open the vscode.dev link.

Without VS Code, on a compute node (e.g. after `srun ... --pty bash`):
```bash
vibe-tunnel claude --config myproj          # Claude Code in the same sandbox, in this terminal
vibe-tunnel shell --workspace ~/proj        # just a shell in the container
```
The menu offers these as *mode* too (tunnel / claude / shell).

## Inside the container

| Path | Comes from | Notes |
|---|---|---|
| the workspace, at its **cluster path** (also as `/workspace`) | config `WORKSPACE` or `--workspace` | VS Code opens here; absolute paths, symlinks, environments and Claude's per-project memory stay valid |
| `/home` | config `CLAUDE_MOBILE_HOME`, `--home`, default `~/.vibe-tunnel/home` (or euler-vibe's home when its image is reused) | persistent: Claude auth, `~/.local/bin/claude`, `.vscode-cli`, `.vscode-server`, `.bashrc`. Not your cluster home. |
| `/tmp` | `$TMPDIR/vibe-tunnel.<jobid>` on local scratch | per run, deleted at the end |
| extra binds | config `RW_BINDS` / `RO_BINDS`, `--rw`, `--ro` | `SRC[:DEST]`; read-only unless listed as read-write |
| `/opt/vibe-tunnel/code` | `cli/code` | static VS Code CLI (read-only; copied to `/tmp` so it can self-update) |
| `/opt/vibe-tunnel/shellrc` | `bin/vibe-tunnel-shellrc` | sourced from `~/.bashrc` in every terminal |

- `claude` in a terminal is a shell function that adds `--dangerously-skip-permissions` (Claude's own sandbox cannot run inside Apptainer; the container is the sandbox). Set `VT_CLAUDE_ASK=1` to keep the prompts. The **Claude Code extension** spawns the `claude` binary directly and uses normal permission prompts in the VS Code UI.
- The first start of a home installs a self-updating native Claude build to `~/.local/bin` (the one in the image's read-only `/usr` cannot update itself). Log in to Claude once per home.
- `git`/`ssh` config from your cluster `$HOME` is *not* visible (that is the point of the sandbox). Put a `.gitconfig` into the sandbox home, or add `--ro ~/.ssh` if you need to push over ssh.
- Extensions and VS Code settings live in `/home/.vscode-server` of the **sandbox** home, not your cluster `$HOME`, so a new sandbox home starts without them. Copy them over once or install from the Extensions view; see docs/CLUSTER_SETUP.md section 6. The `--extensions` preinstall did not work with CLI 1.125.1.
- The image (`images/vibe-tunnel.def`): Ubuntu 24.04, Node 24, Claude Code, uv, Python 3 with build tools, git, ripgrep. GPU access via `--nv`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `vibe-tunnel` on the laptop hangs, or `ssh euler failed` although plain `ssh euler` works | A half-dead multiplexed ssh connection after a VPN/network hiccup. The client detects and resets it automatically; by hand: `ssh -O exit -o ControlPath=~/.ssh/vibe-tunnel-%C euler` |
| Menu keys react slowly | Usually the same stale ssh connection (above). If `squeue -u $USER` itself takes seconds on Euler, slurm is slow; the menu waits for it when drawing the home screen |
| "Uh oh, we couldn't find anything" on GitHub's device page | An already-used login code was shown (fixed for reopen). A fresh job that really needs a login prints a new code in `vibe-tunnel logs <jobid>` |
| Asked to log in to VS Code on every job | The saved token is not being reused: look for `reusing saved VS Code login` in the job log and for `token.json` in `<sandbox home>/.vscode-cli/` |
| Job ends before the link appears | `vibe-tunnel logs <jobid>`: a missing workspace directory, a wrong account/partition (`sbatch` error), or the container image missing |
| No Claude Code extension in the tunnel | Extensions live in the sandbox home, not your cluster home. Install it once from the Extensions view (choose the install button for the tunnel), or copy `~/.vscode-server/extensions` into `<sandbox home>/.vscode-server/` |
| VS Code opens but the terminal starts in `/` | No folder open: File → Open Folder → your workspace path, or use the `code --folder-uri …` line that `vibe-tunnel wait` prints |
| `claude` asks for login although you logged in before | Different sandbox home: each home has its own login. Check `Home` in the menu's Sandbox screen; the default is `~/.vibe-tunnel/home` |
| Windows | See [Windows](#windows) below |

Logs: `vibe-tunnel logs <jobid>` (cluster or laptop), `vibe-tunnel status`, `vibe-tunnel doctor`.

## VS Code extension (optional GUI)

The same thing as a sidebar inside VS Code: running tunnels (click to connect, stop, log), saved configs
(click to launch, edit, delete, run Claude or a shell in that sandbox), and *New tunnel…* as a step-by-step
setup with a remote directory browser. Install the `.vsix` from [vscode-extension/](vscode-extension/):

```bash
code --install-extension vscode-extension/vibe-tunnel-0.1.1.vsix
```
Set *vibe-tunnel › Host* and *Remote Dir* in the settings (defaults: `euler` and the Beltrao lab's shared
installation). The extension needs ssh to work without prompts: an ssh key in your agent, or *Log in via
terminal* once from the sidebar (macOS/Linux; the connection is then reused for 15 minutes). It runs on Windows
without WSL, since Windows ships OpenSSH. Details in [vscode-extension/README.md](vscode-extension/README.md).

The sidebar and the terminal menu use the same `vibe-tunnel` commands on the cluster and see the same configs.

## Windows

The laptop side is bash + ssh + the `code` command, so it runs in either of Windows' Unix-like shells. Nothing is
installed on Windows itself beyond VS Code.

**WSL (recommended).** In PowerShell once: `wsl --install` (Ubuntu), then inside WSL follow the member setup
above exactly as on Linux: install `ssh` if missing (`sudo apt install openssh-client`), put your Euler alias and
key into WSL's `~/.ssh/config`, clone, `./setup.sh --client`. Install the *WSL* extension in VS Code so the
`code` command works inside WSL (VS Code on Windows stays the editor; the tunnel opens there). The device-code
login page opens in your Windows browser and the code lands in the Windows clipboard.

**Git Bash** (comes with Git for Windows) also works: same steps in a Git Bash window, `~/.ssh/config` lives in
`C:\Users\<you>\.ssh`. ssh connection multiplexing is disabled there automatically, so each command
authenticates again; use an ssh key with the agent (`eval $(ssh-agent); ssh-add`) to avoid retyping.

Not supported: plain PowerShell/cmd (no bash). Status: implemented but not yet tested by a Windows user; please
report what you see.

## Repository layout

```
bin/vibe-tunnel           one entry point: cluster CLI (launch / submit / claude / shell / wait / status / show /
                          logs / stop / configs / config / profiles / ls / doctor), or laptop client when there is no slurm
bin/vibe-tunnel-launch    the interactive menu behind `vibe-tunnel launch` (adapted from claude-launch)
bin/vibe-tunnel-client    laptop side: runs the remote menu over ssh, waits, opens VS Code (plain bash + ssh)
bin/vibe-tunnel-lib       shared: site settings, config validation, sandbox resolution, container arguments
bin/vibe-tunnel-job       host side of a run: resolves the sandbox, starts the container (tunnel / claude / shell)
bin/vibe-tunnel-entry     inside the container: home bootstrap, then `code tunnel`, claude, or a shell
bin/vibe-tunnel-shellrc   sourced by every shell in the container (claude on PATH, self-update, claude function)
images/vibe-tunnel.def    container recipe; the built .sif is gitignored
profiles/*.sbatch         resource presets: #SBATCH lines + exec bin/vibe-tunnel-job (values editable in the menu)
setup.sh                  cluster: build image, download VS Code CLI, write ~/.vibe-tunnel/env; laptop: --client
docs/CLUSTER_SETUP.md     cluster steps, design notes, things to verify on first use
cli/code                  VS Code CLI binary (downloaded by setup.sh, gitignored)
site.env.example          lab-wide defaults for a shared installation (copy to site.env, gitignored)
vscode-extension/         the VS Code sidebar extension (TypeScript; built .vsix committed for one-click install)
```

Cluster-side state lives in `~/.vibe-tunnel/`: `env` (site settings), `logs/<jobid>.log` (the job log `wait` polls), `jobs/*.env` (per-run settings), `profiles/` (your own sbatch profiles), `last-job` (most recent submission). `configs/` (saved configs) and `home/` (default sandbox home) live there too. Laptop settings: `~/.config/vibe-tunnel/client`.

## How the pieces map to the two original projects

| Concern | codeserver_tunnel | euler-vibe | vibe-tunnel |
|---|---|---|---|
| resources | `tunnel_scripts/*.sh` | interactive job / `srun` | `profiles/*.sbatch` (headers only) |
| sandbox definition | none (host `$HOME`) | `claude-launch` saved configs | reused as-is via `--config` |
| container | none | `claude-mobile` builds the `singularity exec`; `claude-mobile.def` | `bin/vibe-tunnel-lib` (same binds and proxy handling); `images/vibe-tunnel.def` without Happy/Codex |
| VS Code | `code tunnel` on the node, per-job `--cli-data-dir` | none | `code tunnel` inside the container, per-job data dir + shared login token |
| laptop side | paramiko, uploads script, parses log | none | plain bash + ssh, runs the remote menu, `vibe-tunnel wait` |
| session tracking | local `tunnel_sessions.json` | none | `squeue` job names `vibe-tunnel-<label>` (no local state) |
