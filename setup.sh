#!/usr/bin/env bash
set -euo pipefail

# setup.sh --------------------------------------------------------------------
# On the cluster:
#   1. locate your euler-vibe checkout and its built claude-mobile.sif
#   2. download Microsoft's standalone VS Code CLI into cli/code
#   3. write site settings to ~/.vibe-tunnel/env
#   4. optionally put bin/ on your PATH
# Safe to re-run. Needs the proxy for the download: `module load eth_proxy`.
#
# On your laptop (no slurm here), `./setup.sh --client` instead puts bin/ on
# your PATH and writes the client settings (ssh host, cluster path of this
# repo, how to open tunnels) via `vibe-tunnel client-setup`.

REPO=$(cd "$(dirname "$(realpath "$0")")" && pwd)
STATE_DIR=${VT_STATE_DIR:-$HOME/.vibe-tunnel}
ENV_FILE=$STATE_DIR/env
CLI=$REPO/cli/code
BEGIN_MARK='# >>> vibe-tunnel >>>'
END_MARK='# <<< vibe-tunnel <<<'
RC_FILE=${RC_FILE:-$HOME/.bashrc}
DO_CLI=1 DO_PATH=1 FORCE=0 YES=0 CLIENT=0
EULER_VIBE_DIR=${EULER_VIBE_DIR:-}
CLIENT_ARGS=()

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    BOLD=$'\033[1m'; DIM=$'\033[2m'; RST=$'\033[0m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; CYAN=$'\033[36m'
else BOLD= DIM= RST= GREEN= YELLOW= RED= CYAN=; fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s%s\n' "$CYAN" "$RST" "$BOLD" "$*" "$RST"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RST" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RST" "$*"; }
die()  { printf '  %s✗ %s%s\n' "$RED" "$*" "$RST" >&2; exit 1; }
confirm() {
    [ "$YES" -eq 1 ] && return 0
    [ -t 0 ] || { warn "not a terminal; skipping (use --yes)"; return 1; }
    local r; read -r -p "  $1 [y/N] " r || return 1
    case "$r" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

usage() {
    cat <<USAGE
Usage: ./setup.sh [options]                 (on the cluster)
       ./setup.sh --client [--host H] [--remote-dir DIR] [--open-with code|browser|none]   (on your laptop)
  --euler-vibe DIR   path to the euler-vibe checkout (default: ../euler-vibe or ~/euler-vibe)
  --no-cli           skip downloading the VS Code CLI
  --no-path          skip adding bin/ to your shell rc
  --force            re-download the CLI / rewrite the PATH block
  --rc FILE          shell rc file to edit (default: ~/.bashrc)
  -y, --yes          do not prompt
USAGE
}
while [ $# -gt 0 ]; do
    case "$1" in
        --client)  CLIENT=1 ;;
        --host|--remote-dir|--open-with) CLIENT_ARGS+=("$1" "$2"); shift ;;
        --euler-vibe) shift; EULER_VIBE_DIR=$1 ;;
        --no-cli)  DO_CLI=0 ;;
        --no-path) DO_PATH=0 ;;
        --force)   FORCE=1 ;;
        --rc)      shift; RC_FILE=$1; RC_FILE_SET=1 ;;
        -y|--yes)  YES=1 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; die "unknown option: $1" ;;
    esac; shift
done

add_path_block() {
    step "PATH"
    local block tmp
    block=$(printf '%s\n# Added by vibe-tunnel setup.sh — delete this block to undo.\nexport PATH="%s/bin:$PATH"\n%s' "$BEGIN_MARK" "$REPO" "$END_MARK")
    if [ -e "$RC_FILE" ] && grep -Fq "$BEGIN_MARK" "$RC_FILE"; then
        if grep -Fq "$REPO/bin" "$RC_FILE" && [ "$FORCE" -eq 0 ]; then ok "$RC_FILE already points at $REPO/bin"
        elif confirm "Update the vibe-tunnel block in $RC_FILE?"; then
            tmp=$(mktemp)
            awk -v b="$BEGIN_MARK" -v e="$END_MARK" 'index($0,b){skip=1} !skip{print} index($0,e){skip=0}' "$RC_FILE" > "$tmp"
            printf '%s\n' "$block" >> "$tmp"; cp "$RC_FILE" "$RC_FILE.vibe-tunnel.bak"; mv "$tmp" "$RC_FILE"
            ok "updated"
        else warn "left $RC_FILE unchanged"; fi
    elif confirm "Add $REPO/bin to your PATH via $RC_FILE?"; then
        [ -e "$RC_FILE" ] && printf '\n' >> "$RC_FILE"
        printf '%s\n' "$block" >> "$RC_FILE"; ok "added to $RC_FILE"
    else warn "skipped — call $REPO/bin/vibe-tunnel by full path"; fi
}

printf '%s%s vibe-tunnel setup %s\n' "$BOLD" "$CYAN" "$RST"
say "  repo: $REPO"

# --- laptop client -----------------------------------------------------------
if [ "$CLIENT" -eq 1 ] || { ! command -v sbatch >/dev/null 2>&1 && [ -z "${VT_ON_CLUSTER:-}" ]; }; then
    [ "$CLIENT" -eq 1 ] || warn "no slurm on this machine: setting it up as a laptop client (use VT_ON_CLUSTER=1 to override)"
    # macOS default shell is zsh; pick the rc file that matches unless --rc was given.
    [ -n "${RC_FILE_SET:-}" ] || case "${SHELL:-}" in */zsh) RC_FILE=$HOME/.zshrc ;; esac
    [ "$DO_PATH" -eq 1 ] && add_path_block
    step "Client settings"
    "$REPO/bin/vibe-tunnel-client" client-setup "${CLIENT_ARGS[@]+"${CLIENT_ARGS[@]}"}"
    step "Done"
    say "  Start a new shell (or: source $RC_FILE), then run:  ${CYAN}vibe-tunnel${RST}"
    exit 0
fi

# --- 1. euler-vibe -----------------------------------------------------------
step "euler-vibe"
if [ -z "$EULER_VIBE_DIR" ]; then
    for c in "$(dirname "$REPO")/euler-vibe" "$HOME/euler-vibe"; do
        [ -d "$c" ] && { EULER_VIBE_DIR=$c; break; }
    done
fi
[ -n "$EULER_VIBE_DIR" ] && [ -d "$EULER_VIBE_DIR" ] \
    || die "euler-vibe not found. Clone it next to this repo (git clone https://github.com/jurgjn/euler-vibe.git) or pass --euler-vibe DIR"
EULER_VIBE_DIR=$(realpath "$EULER_VIBE_DIR")
ok "checkout: $EULER_VIBE_DIR"
IMAGE=${CLAUDE_MOBILE_IMAGE:-$EULER_VIBE_DIR/images/claude-mobile.sif}
if [ -e "$IMAGE" ]; then ok "image: $IMAGE ($(du -h "$IMAGE" | cut -f1))"
else
    warn "image not built yet: $IMAGE"
    warn "build it with:  cd $EULER_VIBE_DIR && module load eth_proxy && ./setup.sh"
fi
[ -f "$EULER_VIBE_DIR/bin/claude-mobile-shellrc" ] && ok "shellrc found" || warn "bin/claude-mobile-shellrc missing in euler-vibe (terminals will lack the claude helpers)"

# --- 2. VS Code CLI ------------------------------------------------------------
step "VS Code CLI"
if [ "$DO_CLI" -eq 0 ]; then say "  ${DIM}skipped (--no-cli)${RST}"
elif [ -x "$CLI" ] && [ "$FORCE" -eq 0 ]; then ok "present: $CLI ($("$CLI" --version 2>/dev/null | head -n1)) — --force to re-download"
else
    case "$(uname -m)" in
        x86_64)  target=cli-alpine-x64 ;;
        aarch64) target=cli-alpine-arm64 ;;
        *) die "unsupported architecture $(uname -m)" ;;
    esac
    if [ -z "${http_proxy:-}${HTTP_PROXY:-}" ]; then
        warn "no http_proxy set — on Euler run 'module load eth_proxy' first"
        confirm "Try the download anyway?" || die "aborted"
    fi
    mkdir -p "$REPO/cli"
    url="https://code.visualstudio.com/sha/download?build=stable&os=$target"
    say "  ${DIM}downloading $url${RST}"
    tmp=$(mktemp -d)
    curl -fsSL "$url" -o "$tmp/cli.tar.gz" || die "download failed"
    tar -xzf "$tmp/cli.tar.gz" -C "$tmp"
    [ -f "$tmp/code" ] || die "archive did not contain a 'code' binary"
    install -m 755 "$tmp/code" "$CLI"; rm -rf "$tmp"
    ok "installed $CLI ($("$CLI" --version | head -n1))"
    say "  ${DIM}(the alpine build is static and also runs inside the Ubuntu container)${RST}"
fi

# --- 3. site settings --------------------------------------------------------------
step "Site settings"
mkdir -p "$STATE_DIR/profiles" "$STATE_DIR/logs" "$STATE_DIR/jobs"
{
    printf '# vibe-tunnel site settings (written by setup.sh %s). Sourced by bin/vibe-tunnel and the job.\n' "$(date '+%Y-%m-%d')"
    printf 'EULER_VIBE_DIR=%q\n' "$EULER_VIBE_DIR"
    printf '# CLAUDE_MOBILE_IMAGE=%q\n' "$IMAGE"
    printf '# VT_CODE_CLI=%q\n' "$CLI"
    printf '# CLAUDE_LAUNCH_CONFIG_DIR=%q\n' "${XDG_CONFIG_HOME:-$HOME/.config}/claude-launch/configs"
} > "$ENV_FILE"
ok "wrote $ENV_FILE"
say "  ${DIM}your own sbatch profiles go in $STATE_DIR/profiles/NAME.sbatch${RST}"

# --- 4. PATH -----------------------------------------------------------------------
if [ "$DO_PATH" -eq 0 ]; then step "PATH"; say "  ${DIM}skipped (--no-path)${RST}"
else add_path_block; fi

step "Done"
say "  Check everything with:   ${CYAN}$REPO/bin/vibe-tunnel doctor${RST}"
say "  Start a tunnel by hand:  ${CYAN}vibe-tunnel submit cpu_4h --name test${RST}"
say "  …or from your laptop:    clone this repo there and run ${CYAN}./setup.sh --client${RST}"
