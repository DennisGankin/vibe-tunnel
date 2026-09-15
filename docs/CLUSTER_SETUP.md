# Cluster setup and first-run checklist

Everything in this file has to happen on Euler (login node unless stated). The laptop launcher assumes it is done.

## 1. euler-vibe with a built image

The lab setup. If you already have it, skip.

```bash
git clone -b claude-launch-fixes https://github.com/jurgjn/euler-vibe.git ~/euler-vibe
cd ~/euler-vibe
module load eth_proxy
./setup.sh            # builds images/claude-mobile.sif (~680 MB, takes a while), adds bin/ to PATH
```
Building on a login node may hit memory limits; euler-vibe's README suggests `./setup.sh --low-mem` or building in a job. A shared image works too: point `CLAUDE_MOBILE_IMAGE` in `~/.vibe-tunnel/env` at it.

Create at least one sandbox config with `claude-launch` -> *Save current config*, so `vibe-tunnel configs` has something to offer. (Not required: `--workspace` works without configs.)

## 2. vibe-tunnel

```bash
git clone <this repo> ~/vibe-tunnel        # or anywhere; next to euler-vibe is auto-detected
cd ~/vibe-tunnel
module load eth_proxy
./setup.sh                                 # --euler-vibe DIR if it is not in ../euler-vibe or ~/euler-vibe
vibe-tunnel doctor
```
`setup.sh` downloads Microsoft's standalone VS Code CLI (`cli-alpine-x64`, static, ~15 MB) into `cli/code`. It is the same binary `codeserver_tunnel` uses as `$HOME/code`; if that exists, it is used as a fallback.

Adjust `profiles/*.sbatch` for your account/partition. Profiles in `~/.vibe-tunnel/profiles/` take precedence over the repo's and are what the laptop launcher syncs to.

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

Then, on the laptop: `code --folder-uri 'vscode-remote://tunnel+test/workspace'`. The integrated terminal should show the `(claude-mobile)` prompt from euler-vibe's shellrc, `pwd` = `/workspace`, `claude --version` works, and `ls /` shows the container, not the node.

`scancel` (or `vibe-tunnel stop test`) should leave `vibe-tunnel: tunnel 'test' unregistered` at the end of the log.

## 4. Things to verify on the first run

Status after the first real run on Euler (2026-09-15, CLI 1.125.1 from `~/code`, image 651 MB):

- confirmed: tunnel relay reachable from inside the container via the forwarded proxy; `vscode-remote://tunnel+NAME/workspace` opens in desktop VS Code; `~/.bashrc` block and euler-vibe shellrc active in VS Code terminals (`claude` function present); `HOME=/home` with the sandbox state; laptop launcher submit / wait / open / reopen.
- not confirmed: `--install-extension` did not preinstall Claude Code with CLI 1.125.1 (see section 6); `token.json` reuse and `unregister` on stop still to be checked in the log.

Each remaining assumption has a fallback; fix the script if reality differs.

| Assumption | Where | If wrong |
|---|---|---|
| The tunnel relay is reachable from inside the container via the `eth_proxy` variables forwarded with `SINGULARITYENV_*`/`APPTAINERENV_*` | `bin/vibe-tunnel-job` | `code tunnel` logs connection errors. `codeserver_tunnel` works on the host with the same proxy, so compare `env | grep -i proxy` inside a `claude-mobile shell` |
| `VSCODE_CLI_USE_FILE_KEYCHAIN=1` makes the CLI keep its login in `<cli-data-dir>/token.json`, so copying that file between per-job data dirs shares the login | `bin/vibe-tunnel-entry` | you get the device-code prompt on every job (current `codeserver_tunnel` behaviour). Look in `~/.vscode-cli/jobs/<jobid>/` in the sandbox home for the real file name and adjust `SHARED_TOKEN` |
| `code tunnel --install-extension ID` exists in the current CLI | `bin/vibe-tunnel-entry` (checked at runtime via `--help`) | it is skipped with a log line; install Claude Code from the Extensions view once, it persists in `/home/.vscode-server` |
| `code tunnel unregister` on exit frees the tunnel name (accounts are capped at a handful of tunnels) | `bin/vibe-tunnel-entry` | stale tunnels accumulate; clean up with `code tunnel unregister` / the Remote Explorer in VS Code |
| `--signal=B:TERM@120` reaches the job script and Apptainer forwards TERM into the container | `profiles/*.sbatch`, `bin/vibe-tunnel-job` | the tunnel is killed without unregistering (harmless, see previous row) |
| `vscode-remote://tunnel+<name>/workspace` opens the tunnel in desktop VS Code | `vibe_tunnel.py` | use the printed `https://vscode.dev/tunnel/...` link and its *Open in VS Code Desktop* button |
| `--nv` on a non-GPU node only warns | `bin/vibe-tunnel-job` | drop `--nv` for CPU profiles via an env toggle (euler-vibe passes it unconditionally too) |

## 5. Operational notes

- **Logs**: `~/.vibe-tunnel/logs/<jobid>.log` is the slurm output and the only log; the launcher parses it. `vibe-tunnel show <jobid>` prints state + log in one go.
- **Concurrency**: one job per label. Each job has its own `--cli-data-dir` (`/home/.vscode-cli/jobs/<jobid>`), which avoids the singleton-lock retries seen in the old `tunnel_output_*.log` files when a data dir was reused across nodes. Dirs older than 7 days are pruned at job start.
- **Disk**: the VS Code server (~200 MB per VS Code version) and extensions live in `/home/.vscode-server` of the sandbox home, shared by all jobs of that home.
- **Time limits**: the tunnel dies with the job. VS Code shows a reconnect dialog; start a new job and reopen.
- **Several homes**: a different `CLAUDE_MOBILE_HOME` means separate Claude login, VS Code login, server cache and `.bashrc`. Choose it per config in `claude-launch` or with `--home`.
- **Cleaning up**: `rm -rf ~/.vibe-tunnel/jobs/*` (settings of past submissions) and old logs are safe to delete any time.

## 6. Extensions and settings live in the sandbox home

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

Prompt note: Apptainer overrides `PS1`, so terminals show `Apptainer>` instead of euler-vibe's `(claude-mobile)`.
