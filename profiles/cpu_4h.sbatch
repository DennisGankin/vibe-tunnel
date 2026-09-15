#!/usr/bin/env bash
# vibe-tunnel resource profile "cpu_4h". Edit the #SBATCH lines only; the job logic
# lives in bin/vibe-tunnel-job. Submit with:
#   vibe-tunnel submit cpu_4h [--name LABEL] [--config CLAUDE_LAUNCH_CONFIG]
# (--job-name, --output and --export are added by the submit command.)
#SBATCH --job-name=vibe-tunnel
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=16
#SBATCH --mem-per-cpu=2G
#SBATCH --time=04:00:00
#SBATCH --partition=es_beltrao
#SBATCH --account=es_beltrao
##SBATCH --gpus=rtx_4090:1      # uncomment for a GPU
# TERM 2 min before the time limit, so the tunnel gets unregistered cleanly.
#SBATCH --signal=B:TERM@120

exec "${VIBE_TUNNEL_DIR:-$HOME/vibe-tunnel}/bin/vibe-tunnel-job"
