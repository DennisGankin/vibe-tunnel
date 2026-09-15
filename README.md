# vibe-tunnel

VS Code + Claude Code **inside** the euler-vibe sandbox, on an Euler compute node, opened from your laptop with one command.

It combines two things the lab already uses:

- [`codeserver_tunnel`](../codeserver_tunnel.py): submit a slurm job, run `code tunnel` on the node, open the link locally.
- [euler-vibe](https://github.com/jurgjn/euler-vibe/tree/claude-launch-fixes): run Claude Code in a Singularity container with a persistent sandbox home, a workspace mount and explicit read-only / read-write binds (`claude-launch`, `claude-mobile`).

The difference to `codeserver_tunnel`: the VS Code tunnel is started **inside the container**, not on the node. So the VS Code server, every integrated terminal, and the Claude Code extension all run in the sandbox. Claude sees exactly the directories you bound, nothing else, and using it from VS Code feels like a normal local setup.

```
laptop                       login node                 compute node (slurm job)
──────                       ──────────                 ────────────────────────────────────
vibe-tunnel ──── ssh ──►  vibe-tunnel launch/submit ─ sbatch ─►  vibe-tunnel-job (host side)
                                                             │  binds: workspace, sandbox home,
                                                             │  extra ro/rw dirs, VS Code CLI
                                                             ▼
                                                           singularity exec claude-mobile.sif
                                                             └─ vibe-tunnel-entry
                                                                  ├─ ~/.bashrc, claude self-update
                                                                  └─ code tunnel --name …
VS Code desktop ◄─────────── Microsoft tunnel relay ◄──────────────────┘
(Remote - Tunnels)           (via eth_proxy)
```

No new container image: the VS Code CLI is a static binary that gets bind-mounted into euler-vibe's existing `claude-mobile.sif`.

## What you get

- **Sandbox configs.** `vibe-tunnel launch` assembles workspace, home, ro/rw binds, resource profile and label in one menu and saves them as named configs. Configs saved with euler-vibe's `claude-launch` are read as well. Or pass `--workspace`, `--rw`, `--ro` directly.
- **Persistent home.** Auth for Claude, the VS Code login, the downloaded VS Code server and extensions live in the sandbox home (`/home` in the container), so the second start is fast and needs no logins.
- **Several tunnels at once**, each with its own label, node and resources. Reopen a running one instead of resubmitting.
- **Resource profiles** are plain sbatch files: `profiles/` in the cluster clone, or your own in `~/.vibe-tunnel/profiles/` (which shadow them).
- **One command, both places.** `vibe-tunnel` is bash: on the cluster it is the CLI, on the laptop (no slurm) it drives the cluster copy over ssh. No Python, no environment.

## Quick start

### Once, on the cluster
See [docs/CLUSTER_SETUP.md](docs/CLUSTER_SETUP.md) for details and the verification checklist.

```bash
# euler-vibe with a built image (the lab setup)
git clone -b claude-launch-fixes https://github.com/jurgjn/euler-vibe.git ~/euler-vibe
cd ~/euler-vibe && module load eth_proxy && ./setup.sh

# this repo, next to it
git clone <this repo> ~/vibe-tunnel
cd ~/vibe-tunnel && module load eth_proxy && ./setup.sh     # downloads the VS Code CLI, writes ~/.vibe-tunnel/env
vibe-tunnel doctor
```

### Once, on your laptop
```bash
git clone <this repo> ~/vibe-tunnel
cd ~/vibe-tunnel && ./setup.sh --client      # asks for the ssh host, the cluster path of the repo, how to open tunnels
```
Needs a working `ssh euler` (alias in `~/.ssh/config`) and VS Code desktop with the `code` command on PATH. The
client installs the *Remote - Tunnels* extension if missing. Settings go to `~/.config/vibe-tunnel/client`.

### Every time
```bash
vibe-tunnel
```
The same `vibe-tunnel` command works on the laptop and on the cluster; on the laptop it drives the cluster copy over ssh.

1. the launch menu opens on the cluster: workspace, sandbox home, extra read-only / read-write directories (Tab-completes cluster paths), resource profile and tunnel label, all visible at once; save or reuse named configs
2. Launch submits the job; the laptop waits, handles the one-time VS Code login (opens GitHub's device page, copies the code), then opens desktop VS Code at `/workspace` inside the container

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
The menu shows the whole setup at once (like euler-vibe's `claude-launch`, which it is adapted from), Tab-completes
cluster paths, and can save the setup as a named config. Saved configs live in
`~/.config/vibe-tunnel/configs/NAME.conf` and include the resource profile and label, so a later start is just:
```bash
vibe-tunnel submit --config myproj   # profile + label come from the config; flags override
vibe-tunnel wait <jobid>             # prints TUNNEL= / LINK= / DESKTOP= once the tunnel is up
vibe-tunnel status
vibe-tunnel stop myproj
```
Configs saved earlier with `claude-launch` are picked up as well (read-only, shown as "from claude-launch").
Then on the laptop: `code --folder-uri 'vscode-remote://tunnel+myproj/workspace'` or open the printed vscode.dev link.

## Inside the container

| Path | Comes from | Notes |
|---|---|---|
| `/workspace` | config `WORKSPACE` or `--workspace` | VS Code opens here |
| `/home` | config `CLAUDE_MOBILE_HOME`, `--home`, default `euler-vibe/home/claude-mobile` | persistent: Claude auth, `~/.local/bin/claude`, `.vscode-cli`, `.vscode-server`, `.bashrc` |
| `/tmp` | `$TMPDIR/vibe-tunnel.<jobid>` on local scratch | per job, deleted at the end |
| extra binds | config `RW_BINDS` / `RO_BINDS`, `--rw`, `--ro` | same semantics as `claude-launch` |
| `/opt/vibe-tunnel/code` | `cli/code` | static VS Code CLI (read-only; copied to `/tmp` so it can self-update) |
| `/opt/vibe-tunnel/shellrc` | `euler-vibe/bin/claude-mobile-shellrc` | sourced from `~/.bashrc` in every VS Code terminal |

- `claude` in a VS Code terminal is euler-vibe's shell function, i.e. it runs with `--dangerously-skip-permissions` (Claude's own sandbox cannot run inside Apptainer). The **Claude Code extension** spawns the `claude` binary directly and uses normal permission prompts in the VS Code UI. Set the extension's permission mode in VS Code settings if you want it to match.
- The first start of a home installs a self-updating native Claude build to `~/.local/bin` (same mechanism as euler-vibe). Log in to Claude once per home from a VS Code terminal or the extension.
- `git`/`ssh` config from your cluster `$HOME` is *not* visible (that is the point of the sandbox). Put a `.gitconfig` into the sandbox home, or add `--ro ~/.ssh` if you need to push over ssh.
- Extensions and VS Code settings live in `/home/.vscode-server` of the **sandbox** home, not your cluster `$HOME`, so a new sandbox home starts without them. Copy them over once or install from the Extensions view; see docs/CLUSTER_SETUP.md section 6. The `--extensions` preinstall did not work with CLI 1.125.1.

## Repository layout

```
profiles/*.sbatch         resource profiles: #SBATCH lines + exec bin/vibe-tunnel-job
setup.sh                  cluster: find euler-vibe, download VS Code CLI, write ~/.vibe-tunnel/env; laptop: --client
bin/vibe-tunnel           one entry point: cluster CLI (launch / submit / wait / status / show / logs / stop /
                          configs / profiles / doctor), or laptop client when there is no slurm
bin/vibe-tunnel-client    laptop side: runs the remote menu over ssh, waits, opens VS Code (plain bash + ssh)
bin/vibe-tunnel-launch    the interactive menu behind `vibe-tunnel launch` (adapted from claude-launch)
bin/vibe-tunnel-job       runs in the slurm job on the host: resolves the sandbox, starts the container
bin/vibe-tunnel-entry     runs inside the container: home bootstrap, token seeding, `code tunnel`
docs/CLUSTER_SETUP.md     cluster steps, design notes, things to verify on first use
cli/code                  VS Code CLI binary (downloaded by setup.sh, gitignored)
```

Cluster-side state lives in `~/.vibe-tunnel/`: `env` (site settings), `logs/<jobid>.log` (the job log the launcher polls), `jobs/*.env` (per-submission settings), `profiles/` (your own sbatch profiles), `last-job` (most recent submission). Saved configs are in `~/.config/vibe-tunnel/configs/`.

## How the pieces map to the two original projects

| Concern | codeserver_tunnel | euler-vibe | vibe-tunnel |
|---|---|---|---|
| resources | `tunnel_scripts/*.sh` | interactive job / `srun` | `profiles/*.sbatch` (headers only) |
| sandbox definition | none (host `$HOME`) | `claude-launch` saved configs | reused as-is via `--config` |
| container | none | `claude-mobile` builds the `singularity exec` | `bin/vibe-tunnel-job` mirrors its binds and proxy handling |
| VS Code | `code tunnel` on the node, per-job `--cli-data-dir` | none | `code tunnel` inside the container, per-job data dir + shared login token |
| laptop side | paramiko, uploads script, parses log | none | plain bash + ssh, runs the remote menu, `vibe-tunnel wait` |
| session tracking | local `tunnel_sessions.json` | none | `squeue` job names `vibe-tunnel-<label>` (no local state) |
