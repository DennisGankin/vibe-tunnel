#!/usr/bin/env bash
set -euo pipefail

# setup.sh --------------------------------------------------------------------
# On the cluster:
#   1. build the container image images/vibe-tunnel.sif (or point at an
#      existing image: --image FILE, or --euler-vibe DIR to reuse claude-mobile.sif)
#   2. download Microsoft's standalone VS Code CLI into cli/code
#   3. write site settings to ~/.vibe-tunnel/env
#   4. optionally put bin/ on your PATH
# Safe to re-run. Needs the proxy for downloads and the build: `module load eth_proxy`.
#
# On your laptop (no slurm here), `./setup.sh --client` instead puts bin/ on
# your PATH and writes the client settings (ssh host, cluster path of this
# repo, how to open tunnels) via `vibe-tunnel client-setup`.
#
# Shared installation: when this directory is not writable by you (a lab-wide
# install maintained by someone else), setup only checks that image and CLI
# are there, writes your private ~/.vibe-tunnel/env and adds bin/ to your PATH.
# The maintainer runs it once with write access to build/download.

REPO=$(cd "$(dirname "$(realpath "$0")")" && pwd)
STATE_DIR=${VT_STATE_DIR:-$HOME/.vibe-tunnel}
ENV_FILE=$STATE_DIR/env
CLI=$REPO/cli/code
IMAGE=${VT_IMAGE:-$REPO/images/vibe-tunnel.sif}
DEF_REL=images/vibe-tunnel.def
BEGIN_MARK='# >>> vibe-tunnel >>>'
END_MARK='# <<< vibe-tunnel <<<'
RC_FILE=${RC_FILE:-$HOME/.bashrc}
DO_CLI=1 DO_PATH=1 DO_BUILD=1 FORCE=0 YES=0 CLIENT=0 LOW_MEM=0
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
       ./setup.sh --client [--host H] [--remote-dir DIR] [--open-with code|browser|none] [--no-remote-setup]
                                                     (on your laptop; also runs DIR/setup.sh on the cluster)
  --image FILE       use this container image instead of building images/vibe-tunnel.sif
  --euler-vibe DIR   reuse the claude-mobile.sif (and sandbox home) of an euler-vibe checkout
  --no-build         skip building the image
  --low-mem          cap mksquashfs resources (use if the build gets OOM-killed)
  --no-cli           skip downloading the VS Code CLI
  --no-path          skip adding bin/ to your shell rc
  --force            rebuild the image, re-download the CLI, rewrite the PATH block
  --rc FILE          shell rc file to edit (default: ~/.bashrc)
  -y, --yes          do not prompt
USAGE
}
while [ $# -gt 0 ]; do
    case "$1" in
        --client)  CLIENT=1 ;;
        --no-remote-setup) CLIENT_ARGS+=("$1") ;;
        --host|--remote-dir|--open-with) CLIENT_ARGS+=("$1" "$2"); shift ;;
        --euler-vibe) shift; EULER_VIBE_DIR=$1 ;;
        --image)   shift; IMAGE=$1 ;;
        --no-build) DO_BUILD=0 ;;
        --low-mem) LOW_MEM=1 ;;
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
    step "Client settings + cluster-side setup"
    [ "$YES" -eq 1 ] && CLIENT_ARGS+=(--yes)
    "$REPO/bin/vibe-tunnel-client" client-setup "${CLIENT_ARGS[@]+"${CLIENT_ARGS[@]}"}"
    step "Done"
    say "  Start a new shell (or: source $RC_FILE), then run:  ${CYAN}vibe-tunnel${RST}"
    exit 0
fi

# --- shared installation: nothing to build or download as a plain user ----------
SHARED=0; [ -w "$REPO" ] || SHARED=1
if [ "$SHARED" -eq 1 ]; then
    # shellcheck disable=SC1091
    [ -f "$REPO/site.env" ] && . "$REPO/site.env"
    IMAGE=${VT_IMAGE:-$IMAGE}
    step "Shared installation"
    say "  ${DIM}$REPO is not writable by you: using it as installed${VT_MAINTAINER:+ (maintainer: $VT_MAINTAINER)}${RST}"
    [ -e "$IMAGE" ] && ok "image: $IMAGE ($(du -h "$IMAGE" | cut -f1))" || warn "image missing: $IMAGE — ask the maintainer"
    if [ -x "$CLI" ]; then ok "VS Code CLI: $CLI ($("$CLI" --version 2>/dev/null | head -n1))"
    elif [ -x "$HOME/code" ]; then ok "VS Code CLI: $HOME/code (your own copy)"
    else warn "VS Code CLI missing: $CLI — ask the maintainer"; fi
    DO_BUILD=0; DO_CLI=0
fi

# --- 1. container image -----------------------------------------------------------
[ "$SHARED" -eq 1 ] || step "Container image"
if [ "$SHARED" -eq 1 ]; then :
elif [ -n "$EULER_VIBE_DIR" ]; then
    EULER_VIBE_DIR=$(realpath "$EULER_VIBE_DIR")
    [ -d "$EULER_VIBE_DIR" ] || die "euler-vibe checkout not found: $EULER_VIBE_DIR"
    CLAUDE_MOBILE_IMAGE=$EULER_VIBE_DIR/images/claude-mobile.sif
    if [ -e "$CLAUDE_MOBILE_IMAGE" ]; then
        ok "reusing euler-vibe's image: $CLAUDE_MOBILE_IMAGE ($(du -h "$CLAUDE_MOBILE_IMAGE" | cut -f1))"
        say "  ${DIM}(the default sandbox home stays $EULER_VIBE_DIR/home/claude-mobile, so existing logins carry over)${RST}"
        DO_BUILD=0
    else
        warn "no built image in $EULER_VIBE_DIR; building vibe-tunnel's own instead"
    fi
fi
if [ "$SHARED" -eq 1 ]; then :
elif [ "$DO_BUILD" -eq 0 ]; then
    if [ -e "$IMAGE" ]; then ok "image: $IMAGE ($(du -h "$IMAGE" | cut -f1))"
    elif [ -z "${CLAUDE_MOBILE_IMAGE:-}" ] || [ ! -e "$CLAUDE_MOBILE_IMAGE" ]; then warn "no image at $IMAGE (--no-build); nothing can launch until one exists"; fi
elif [ -e "$IMAGE" ] && [ "$FORCE" -eq 0 ]; then
    ok "already present: $IMAGE ($(du -h "$IMAGE" | cut -f1)) — use --force to rebuild"
else
    SINGULARITY=$(command -v singularity || command -v apptainer || true)
    [ -n "$SINGULARITY" ] || die "neither singularity nor apptainer found on PATH"
    [ -e "$REPO/$DEF_REL" ] || die "build recipe missing: $REPO/$DEF_REL"
    # The image pulls base layers from ghcr.io/docker.io, which needs the cluster proxy.
    if [ -z "${http_proxy:-}${HTTP_PROXY:-}" ]; then
        warn "no http_proxy set — on Euler run 'module load eth_proxy' first,"
        warn "otherwise the build cannot reach ghcr.io / docker.io / deb.nodesource.com"
        confirm "Continue anyway?" || die "aborted"
    fi
    mkdir -p "$(dirname "$IMAGE")"
    args=()
    if [ "$LOW_MEM" -eq 1 ]; then
        args+=(--mksquashfs-args "-processors 4 -mem 2048M")
        say "  ${DIM}using capped mksquashfs resources${RST}"
    fi
    say "  ${DIM}building $IMAGE — takes a while and needs a few GB of scratch${RST}"
    ( cd "$REPO" && "$SINGULARITY" build "${args[@]+"${args[@]}"}" "$IMAGE" "$DEF_REL" ) \
        || die "build failed. If mksquashfs was killed, retry with: ./setup.sh --low-mem --force"
    [ -e "$IMAGE" ] || die "build reported success but $IMAGE does not exist"
    ok "built $IMAGE ($(du -h "$IMAGE" | cut -f1))"
fi

# --- 2. VS Code CLI ------------------------------------------------------------
[ "$SHARED" -eq 1 ] || step "VS Code CLI"
if [ "$SHARED" -eq 1 ]; then :
elif [ "$DO_CLI" -eq 0 ]; then say "  ${DIM}skipped (--no-cli)${RST}"
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
mkdir -p "$STATE_DIR/profiles" "$STATE_DIR/logs" "$STATE_DIR/jobs" "$STATE_DIR/configs"
chmod 700 "$STATE_DIR"   # holds login tokens (sandbox home)
{
    printf '# vibe-tunnel site settings (written by setup.sh %s). Sourced by bin/vibe-tunnel-lib.\n' "$(date '+%Y-%m-%d')"
    if [ "$IMAGE" != "$REPO/images/vibe-tunnel.sif" ] && [ "$IMAGE" != "${VT_IMAGE:-}" ]; then printf 'VT_IMAGE=%q\n' "$IMAGE"; else printf '# VT_IMAGE=%q\n' "$IMAGE"; fi
    if [ -n "$EULER_VIBE_DIR" ]; then printf 'EULER_VIBE_DIR=%q\n' "$EULER_VIBE_DIR"; else printf '# EULER_VIBE_DIR=/path/to/euler-vibe   # optional: reuse its image + sandbox home\n'; fi
    printf '# VT_CODE_CLI=%q\n' "$CLI"
    printf '# VT_DEFAULT_HOME=%q   # per-user sandbox home (Claude + VS Code logins, extensions)\n' "$STATE_DIR/home"
} > "$ENV_FILE"
ok "wrote $ENV_FILE"
say "  ${DIM}your own sbatch profiles go in $STATE_DIR/profiles/NAME.sbatch${RST}"

# --- 4. PATH -----------------------------------------------------------------------
if [ "$DO_PATH" -eq 0 ]; then step "PATH"; say "  ${DIM}skipped (--no-path)${RST}"
else add_path_block; fi

step "Done"
if [ "$SHARED" -eq 0 ] && [ "$DO_BUILD$DO_CLI" != "00" ]; then
    say "  ${DIM}To offer this as a shared installation: chmod -R a+rX $REPO, copy site.env.example to site.env,${RST}"
    say "  ${DIM}and tell people to run $REPO/setup.sh (they only get PATH + private settings).${RST}"
fi
say "  Check everything with:   ${CYAN}$REPO/bin/vibe-tunnel doctor${RST}"
say "  Start a tunnel by hand:  ${CYAN}vibe-tunnel submit cpu_4h --name test${RST}"
say "  …or from your laptop:    clone this repo there and run ${CYAN}./setup.sh --client${RST}"
