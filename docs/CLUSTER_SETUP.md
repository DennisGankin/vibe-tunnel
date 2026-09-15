# Cluster setup and first-run checklist

Everything in this file has to happen on Euler (login node unless stated). The laptop client assumes it is done.

## 1. Install and build

```bash
git clone <this repo> ~/vibe-tunnel        # anywhere; the path is what the laptop client needs as "remote dir"
cd ~/vibe-tunnel
module load eth_proxy
./setup.sh                                 # 1. builds images/vibe-tunnel.sif  2. downloads cli/code  3. writes ~/.vibe-tunnel/env  4. PATH
vibe-tunnel doctor
```
The build pulls `ubuntu:24.04` and the uv image from ghcr.io/docker.io and Node from nodesource, so it needs
the proxy. It takes a while (a few minutes) and a few GB of scratch. If `mksquashfs` gets OOM-killed on a
login node: `./setup.sh --low-mem --force`, or build in an interactive job.

Alternatives to building:
- `./setup.sh --euler-vibe /path/to/euler-vibe` reuses that checkout's `claude-mobile.sif` **and** its sandbox
  home `home/claude-mobile` as the default, so existing Claude logins carry over. Saved `claude-launch` configs
  are read either way.
- `./setup.sh --image /shared/path/vibe-tunnel.sif` uses an image someone else built (e.g. one per lab).

`setup.sh` also downloads Microsoft's standalone VS Code CLI (`cli-alpine-x64`, static, ~15 MB) into `cli/code`.
It is the same binary `codeserver_tunnel` used as `$HOME/code`; if that exists, it is used as a fallback.

## 2. Profiles and configs

Profiles (`profiles/*.sbatch`) are presets for time, CPUs, memory, GPUs, partition and account. You rarely need to
edit them: the launch menu's *Resources* entry changes any value for the current setup and saves it with the config
(keys `TIME CPUS MEM GPUS PARTITION ACCOUNT`; empty = the profile's value). At submit time the overrides become
`sbatch --time= --cpus-per-task= --mem-per-cpu= --gpus= --partition= --account=` flags, which win over the
file's `#SBATCH` lines. To change a preset itself: `vibe-tunnel profiles edit NAME` (copies a repo preset to
`~/.vibe-tunnel/profiles/` first, where your copies shadow the repo's) or `vibe-tunnel profiles new NAME --from BASE`.
Both open `$EDITOR` and also work from the laptop.

Sandbox configs are created with `vibe-tunnel launch` -> *Save current config* (configs you saved earlier with
`claude-launch` are read too). Not required: `--workspace` works without configs.

## 3. First tunnel, by hand

```bash
vibe-tunnel submit cpu_4h --workspace ~/some/project --name test
vibe-tunnel logs <jobid> -f
```
Expected in the log, in order:
1. the `vibe-tunnel job` banner with the resolved binds and `VT_TUNNEL_NAME=test`
2. `vibe-tunnel: claude: /home/.local/bin/claude 2.x` (first time: the native install runs before that)
3. `vibe-tunnel: vscode cli: 1.1xx`
4. first time per home: `To grant access to the server, please log into https://github.com/login/device and use code XXXX-XXXX`
5. `Open this link in your browser https://vscode.dev/tunnel/test/workspace`

Then, on the laptop: the `code --folder-uri ...` line that `vibe-tunnel wait` prints (the workspace keeps its cluster path inside the container). The integrated terminal should show the `(vibe-tunnel)` prompt, `pwd` = the workspace's cluster path, `claude --version` works, and `ls /` shows the container, not the node.

`scancel` (or `vibe-tunnel stop test`) should leave `vibe-tunnel: tunnel 'test' unregistered` at the end of the log.

## 4. Things to verify on the first run

Status after the first real run on Euler (2026-09-15, CLI 1.125.1 from `~/code`, euler-vibe's image 651 MB; the standalone `images/vibe-tunnel.def` was built on Euler on 2026-09-15 via `setup.sh` and runs tunnels):

- confirmed: tunnel relay reachable from inside the container via the forwarded proxy; `vscode-remote://tunnel+NAME/workspace` opens in desktop VS Code; `~/.bashrc` block and euler-vibe shellrc active in VS Code terminals (`claude` function present); `HOME=/home` with the sandbox state; laptop-side submit / wait / open / reopen (with the earlier Python launcher; the bash client uses the same remote commands).
- not confirmed: `--install-extension` did not preinstall Claude Code with CLI 1.125.1 (see section 6); `token.json` reuse and `unregister` on stop still to be checked in the log.

Each remaining assumption has a fallback; fix the script if reality differs.

| Assumption | Where | If wrong |
|---|---|---|
| The tunnel relay is reachable from inside the container via the `eth_proxy` variables forwarded with `SINGULARITYENV_*`/`APPTAINERENV_*` | `bin/vibe-tunnel-job` | `code tunnel` logs connection errors. `codeserver_tunnel` works on the host with the same proxy, so compare `env | grep -i proxy` inside a `claude-mobile shell` |
| `VSCODE_CLI_USE_FILE_KEYCHAIN=1` makes the CLI keep its login in `<cli-data-dir>/token.json`, so copying that file between per-job data dirs shares the login | `bin/vibe-tunnel-entry` | you get the device-code prompt on every job (current `codeserver_tunnel` behaviour). Look in `~/.vscode-cli/jobs/<jobid>/` in the sandbox home for the real file name and adjust `SHARED_TOKEN` |
| `code tunnel --install-extension ID` exists in the current CLI | `bin/vibe-tunnel-entry` (checked at runtime via `--help`) | it is skipped with a log line; install Claude Code from the Extensions view once, it persists in `/home/.vscode-server` |
| `code tunnel unregister` on exit frees the tunnel name (accounts are capped at a handful of tunnels) | `bin/vibe-tunnel-entry` | stale tunnels accumulate; clean up with `code tunnel unregister` / the Remote Explorer in VS Code |
| `--signal=B:TERM@120` reaches the job script and Apptainer forwards TERM into the container | `profiles/*.sbatch`, `bin/vibe-tunnel-job` | the tunnel is killed without unregistering (harmless, see previous row) |
| `vscode-remote://tunnel+<name>/workspace` opens the tunnel in desktop VS Code | `bin/vibe-tunnel-client` | use the printed `https://vscode.dev/tunnel/...` link and its *Open in VS Code Desktop* button |
| Apptainer creates bind destinations that do not exist in the image (the workspace is mounted at its `/cluster/...` path; needs the default underlay/overlay support) | `bin/vibe-tunnel-lib` | fall back to `/workspace` only: drop the same-path bind |
| `--nv` on a non-GPU node only warns | `bin/vibe-tunnel-lib` | drop `--nv` for CPU profiles via an env toggle (euler-vibe passes it unconditionally too) |

## 5. Shared installation for a group (maintainer)

One person installs once; everyone else runs the installation's `setup.sh` and gets only their private state.

```bash
cd /cluster/project/<group>/software
git clone <this repo> vibe-tunnel && cd vibe-tunnel
module load eth_proxy && ./setup.sh          # builds images/vibe-tunnel.sif, downloads cli/code, your own env + PATH
cp site.env.example site.env && $EDITOR site.env   # maintainer name, image path if elsewhere, default home policy
chmod -R a+rX .                              # group can read/execute; nobody but you can write
```
Updating: `git pull` in that directory (and `./setup.sh --force` when the image recipe or the CLI should be
refreshed). Running jobs are unaffected; the next launch uses the new scripts.

What users get when they run `/cluster/project/<group>/software/vibe-tunnel/setup.sh`:
- the check that image and CLI exist (nothing is built or downloaded, the directory is not writable for them)
- `~/.vibe-tunnel/env` (their overrides) and `~/.vibe-tunnel` created mode 700
- the PATH line in their `~/.bashrc`

Per-user state (never in the shared directory): `~/.vibe-tunnel/{configs,profiles,logs,jobs,home,env,last-job}`.
`vibe-tunnel profiles edit NAME` copies a shared preset to the user's `profiles/` before editing, so presets stay
as installed. `vibe-tunnel doctor` reports "shared installation" and the maintainer from `site.env`.

Slurm accounts: the presets carry the group's accounts; a user on a different account changes it once under
*Resources* and saves the config, or creates an own profile.

## 6. Operational notes

- **Logs**: `~/.vibe-tunnel/logs/<jobid>.log` is the slurm output and the only log; `vibe-tunnel wait` parses it. `vibe-tunnel show <jobid>` prints state + log in one go.
- **Concurrency**: one job per label. Each job has its own `--cli-data-dir` (`/home/.vscode-cli/jobs/<jobid>`), which avoids the singleton-lock retries seen in the old `tunnel_output_*.log` files when a data dir was reused across nodes. Dirs older than 7 days are pruned at job start.
- **Disk**: the VS Code server (~200 MB per VS Code version) and extensions live in `/home/.vscode-server` of the sandbox home, shared by all jobs of that home.
- **Time limits**: the tunnel dies with the job. VS Code shows a reconnect dialog; start a new job and reopen.
- **Several homes**: a different `CLAUDE_MOBILE_HOME` means separate Claude login, VS Code login, server cache and `.bashrc`. Choose it per config in the launch menu or with `--home`. The default is `~/.vibe-tunnel/home` (set `VT_DEFAULT_HOME` in `~/.vibe-tunnel/env` to put it on project storage), or euler-vibe's `home/claude-mobile` when its image is reused.
- **Terminal use without VS Code**: `vibe-tunnel claude|shell [--config N | --workspace D ...]` runs the same container interactively on the current node; use it inside an interactive slurm job.
- **Cleaning up**: `rm -rf ~/.vibe-tunnel/jobs/*` (settings of past submissions) and old logs are safe to delete any time. Configs in `~/.vibe-tunnel/configs` and the sandbox home in `~/.vibe-tunnel/home` are the state you want to keep.

## 7. Extensions and settings live in the sandbox home

With `codeserver_tunnel` the VS Code server ran on the node with your cluster `$HOME`, so extensions were in
`/cluster/home/$USER/.vscode-server/extensions`. Inside the container the server's data dir is `/home/.vscode-server`
in the *sandbox* home, which starts empty. Hence a fresh tunnel shows no extensions even though they exist on the host.

One-time fix per sandbox home (`<sandbox-home>` = the config's `CLAUDE_MOBILE_HOME`, see `vibe-tunnel configs`):

```bash
cp -a ~/.vscode-server/extensions/. <sandbox-home>/.vscode-server/extensions/
```

Then reload the VS Code window. Machine settings can be copied the same way from `~/.vscode-server/data/Machine/`.
Alternatively add `/cluster/home/$USER/.vscode-server` as a read-write bind mounted at `/home/.vscode-server` in the
claude-launch config to share it with the host, at the cost of Claude being able to write there.

Prompt note: Apptainer may override `PS1`, so VS Code terminals can show `Apptainer>` instead of `(vibe-tunnel)`.
