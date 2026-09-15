#!/usr/bin/env python3
"""vibe_tunnel.py -- laptop launcher for vibe-tunnel.

Starts (or reopens) a VS Code tunnel that runs *inside* euler-vibe's sandboxed
Claude container on an Euler compute node, then opens it in your desktop VS Code.

All cluster logic lives in the cluster clone of this repo (bin/vibe-tunnel);
this script only drives it over plain `ssh`, so your ~/.ssh/config, keys,
agent and aliases are used as-is. Standard library only.

    python vibe_tunnel.py                 # interactive: reopen a running tunnel or start one
    python vibe_tunnel.py start --profile gpu_4h --config myproj --name llmag
    python vibe_tunnel.py list            # running tunnels + links
    python vibe_tunnel.py open JOBID      # (re)open a running tunnel in VS Code
    python vibe_tunnel.py logs JOBID
    python vibe_tunnel.py stop JOBID|LABEL

Settings come from vibe_tunnel.cfg next to this file (see vibe_tunnel.cfg.example),
overridable with --host / --remote-dir.
"""
import argparse
import configparser
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
CFG_FILE = os.path.join(HERE, 'vibe_tunnel.cfg')
LOCAL_PROFILES = os.path.join(HERE, 'profiles')

DEVICE_RE = re.compile(r'log into\s+(https?://\S+)\s+and use code\s+([A-Za-z0-9-]+)')
LINK_RE = re.compile(r'Open this link in your browser\s+(https?://\S+)')
TUNNEL_RE = re.compile(r'^VT_TUNNEL_NAME=(\S+)', re.M)
ERROR_RE = re.compile(r'^(?:\[[^\]]*\] )?(?:vibe-tunnel: )?(?:ERROR|error)[: ].*', re.M)
ACTIVE_STATES = {'PENDING', 'CONFIGURING', 'RUNNING', 'COMPLETING', 'REQUEUED', 'SUSPENDED'}

DEFAULTS = {
    'host': 'euler',
    'remote_dir': '~/vibe-tunnel',
    'sync_profiles': 'true',
    'open_with': 'code',     # code | browser | none
    'poll_seconds': '10',
}


def load_cfg():
    cfg = dict(DEFAULTS)
    if os.path.exists(CFG_FILE):
        parser = configparser.ConfigParser()
        parser.read(CFG_FILE)
        for section in parser.sections():
            cfg.update(parser[section])
    return cfg


def say(msg=''):
    print(msg, flush=True)


def warn(msg):
    print(f'  ! {msg}', file=sys.stderr, flush=True)


def die(msg, code=1):
    print(f'vibe-tunnel: {msg}', file=sys.stderr, flush=True)
    sys.exit(code)


# --- ssh ---------------------------------------------------------------------
class Cluster:
    """Thin wrapper over the system ssh with a shared control connection, so the
    launcher authenticates once and every later call is fast."""

    def __init__(self, host, remote_dir):
        self.host = host
        self.remote_dir = remote_dir
        self.control = os.path.expanduser('~/.ssh/vibe-tunnel-%C')
        self.base = ['ssh', '-o', 'ControlMaster=auto', '-o', f'ControlPath={self.control}',
                     '-o', 'ControlPersist=15m', host]

    def connect(self):
        # Interactive: lets you type a passphrase / OTP once; later calls reuse the master.
        say(f'Connecting to {self.host} ...')
        rc = subprocess.call(self.base + ['true'])
        if rc != 0:
            die(f'ssh {self.host} failed (exit {rc}). Check your ~/.ssh/config and network/VPN.')

    def run(self, cmd, stdin=None, check=True):
        p = subprocess.run(self.base + [cmd], input=stdin, text=True, capture_output=True)
        if check and p.returncode != 0:
            die(f'remote command failed ({p.returncode}): {cmd}\n{p.stderr.strip()}')
        return p

    def vt(self, *args, check=True):
        cmd = ' '.join([f'{self.remote_dir}/bin/vibe-tunnel'] + [shlex.quote(a) for a in args])
        # Non-interactive ssh sessions do not read ~/.bashrc, so give colours no chance.
        return self.run(f'NO_COLOR=1 {cmd}', check=check)

    def check_install(self):
        p = self.run(f'test -x {self.remote_dir}/bin/vibe-tunnel', check=False)
        if p.returncode != 0:
            die(f'{self.remote_dir}/bin/vibe-tunnel not found on {self.host}.\n'
                f'  Clone this repo on the cluster and run ./setup.sh there (see docs/CLUSTER_SETUP.md),\n'
                f'  or point remote_dir in vibe_tunnel.cfg at the clone.')

    def sync_profiles(self):
        if not os.path.isdir(LOCAL_PROFILES):
            return
        files = sorted(f for f in os.listdir(LOCAL_PROFILES) if f.endswith('.sbatch'))
        if not files:
            return
        # One round trip: a tar stream unpacked into the user profile dir.
        import io
        import tarfile
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode='w') as tar:
            for f in files:
                tar.add(os.path.join(LOCAL_PROFILES, f), arcname=f)
        p = subprocess.run(self.base + ['mkdir -p ~/.vibe-tunnel/profiles && tar -x -C ~/.vibe-tunnel/profiles'],
                           input=buf.getvalue(), capture_output=True)
        if p.returncode == 0:
            say(f'  synced {len(files)} local profile(s) to ~/.vibe-tunnel/profiles on {self.host}')
        else:
            warn(f'could not sync profiles: {p.stderr.decode().strip()}')


# --- parsing helpers ----------------------------------------------------------
def parse_porcelain(text, n):
    rows = []
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = line.split('|')
        parts += [''] * (n - len(parts))
        rows.append(parts[:n])
    return rows


def parse_show(text):
    head, _, log = text.partition('---LOG---\n')
    meta = dict(line.split('=', 1) for line in head.splitlines() if '=' in line)
    return meta, log


def choose(prompt, options, allow_empty=False):
    for i, o in enumerate(options, 1):
        say(f'  {i}) {o}')
    while True:
        reply = input(f'{prompt} ').strip()
        if not reply and allow_empty:
            return None
        if reply.isdigit() and 1 <= int(reply) <= len(options):
            return int(reply) - 1
        say('  please enter a number from the list')


# --- opening ----------------------------------------------------------------------
def copy_to_clipboard(text):
    try:
        import pyperclip  # optional
        pyperclip.copy(text)
        return True
    except Exception:
        pass
    cmds = {'darwin': [['pbcopy']], 'win32': [['clip']]}.get(
        sys.platform, [['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input'], ['wl-copy']])
    for cmd in cmds:
        try:
            subprocess.run(cmd, input=text.encode(), check=True)
            return True
        except Exception:
            continue
    return False


def open_tunnel(tunnel, link, how):
    """Open the tunnel in desktop VS Code (via the Remote - Tunnels extension) or the browser."""
    folder_uri = f'vscode-remote://tunnel+{tunnel}/workspace'
    web = link or f'https://vscode.dev/tunnel/{tunnel}/workspace'
    say()
    say(f'  tunnel  : {tunnel}')
    say(f'  desktop : code --folder-uri {shlex.quote(folder_uri)}')
    say(f'  browser : {web}')
    if how == 'none':
        return
    code = shutil.which('code')
    if how == 'code' and code:
        try:
            exts = subprocess.run([code, '--list-extensions'], capture_output=True, text=True, timeout=60).stdout
            if 'ms-vscode.remote-server' not in exts:
                say('  installing the "Remote - Tunnels" extension in your VS Code ...')
                subprocess.run([code, '--install-extension', 'ms-vscode.remote-server'], timeout=300)
        except Exception as e:
            warn(f'could not check VS Code extensions: {e}')
        say('  opening in VS Code ...')
        subprocess.Popen([code, '--folder-uri', folder_uri])
        return
    if how == 'code':
        warn("'code' CLI not on PATH (VS Code: Shell Command: Install 'code' command); opening in the browser instead")
    webbrowser.open(web)


# --- commands ---------------------------------------------------------------------
def running_tunnels(cl):
    return parse_porcelain(cl.vt('status', '--porcelain').stdout, 8)


def cmd_list(cl, args, cfg):
    rows = running_tunnels(cl)
    if not rows:
        say('No vibe-tunnel jobs queued or running.')
        return
    say(f'{"JOBID":<10} {"NAME":<28} {"STATE":<9} {"NODE":<10} {"ELAPSED":<9} {"LEFT":<9} TUNNEL')
    for jid, name, state, node, elapsed, left, tunnel, link in rows:
        say(f'{jid:<10} {name:<28} {state:<9} {node or "-":<10} {elapsed:<9} {left:<9} {tunnel or "-"}')
        if link:
            say(f'{"":<10} {link}')


def cmd_open(cl, args, cfg, job_id=None):
    job_id = job_id or args.job_id
    meta, log = parse_show(cl.vt('show', job_id).stdout)
    if meta.get('STATE') not in ACTIVE_STATES:
        die(f'job {job_id} is not running (state {meta.get("STATE")}). Start a new tunnel.')
    m = TUNNEL_RE.search(log)
    if not m:
        die(f'job {job_id} has not reported its tunnel name yet; try again in a moment or check: vibe-tunnel logs {job_id}')
    link = LINK_RE.findall(log)
    open_tunnel(m.group(1), link[-1] if link else None, 'browser' if args.browser else cfg['open_with'])


def cmd_logs(cl, args, cfg):
    say(cl.vt('logs', args.job_id, check=False).stdout)


def cmd_stop(cl, args, cfg):
    p = cl.vt('stop', args.target, check=False)
    say((p.stdout + p.stderr).strip())


def wait_for_tunnel(cl, job_id, cfg, how):
    """Poll the job log until the tunnel link appears. Handles the one-time
    device-code login by opening GitHub's device page with the code copied."""
    poll = int(cfg['poll_seconds'])
    seen_codes, last_state, started = set(), None, time.time()
    say(f'\nWaiting for job {job_id} (Ctrl-C stops waiting; the job keeps running) ...')
    while True:
        meta, log = parse_show(cl.vt('show', job_id).stdout)
        state, node = meta.get('STATE', '?'), meta.get('NODE', '')
        if state != last_state:
            say(f'  [{time.strftime("%H:%M:%S")}] job {job_id}: {state}' + (f' on {node}' if node and '(' not in node else ''))
            last_state = state

        for url, code in DEVICE_RE.findall(log):
            if code in seen_codes:
                continue
            seen_codes.add(code)
            copied = copy_to_clipboard(code)
            say()
            say('  VS Code tunnel login needed (once per sandbox home):')
            say(f'    open  {url}')
            say(f'    code  {code}' + ('   (copied to clipboard)' if copied else ''))
            say('  Sign in with the GitHub account you use for VS Code tunnels.')
            webbrowser.open(url)

        links = LINK_RE.findall(log)
        tunnel = TUNNEL_RE.search(log)
        if links and tunnel:
            say(f'\n  Tunnel is up after {int(time.time() - started)}s.')
            open_tunnel(tunnel.group(1), links[-1], how)
            say(f'\n  Later:  python vibe_tunnel.py open {job_id}      stop:  python vibe_tunnel.py stop {job_id}')
            return 0

        if state not in ACTIVE_STATES:
            say(f'\n  Job {job_id} ended ({state}) before the tunnel came up. Last log lines:')
            for line in log.strip().splitlines()[-25:]:
                say('    ' + line)
            errs = ERROR_RE.findall(log)
            if errs:
                say('\n  Errors:')
                for e in errs[-5:]:
                    say('    ' + e)
            return 1
        time.sleep(poll)


def cmd_start(cl, args, cfg):
    how = 'browser' if args.browser else ('none' if args.no_open else cfg['open_with'])

    interactive = not (args.profile or args.config or args.workspace or args.name)
    if interactive:
        rows = running_tunnels(cl)
        if rows:
            say('Running tunnels:')
            labels = [f'{jid}  {name:<26} {state:<8} {node or "-":<10} left {left}' for jid, name, state, node, _, left, *_ in rows]
            idx = choose('Number to (re)open it, or Enter to start a new one:', labels, allow_empty=True)
            if idx is not None:
                return cmd_open(cl, args, cfg, job_id=rows[idx][0])

    # --- sandbox: a saved claude-launch config, or plain workspace dir ---
    config, workspace = args.config, args.workspace
    if not config and not workspace:
        configs = parse_porcelain(cl.vt('configs', '--porcelain').stdout, 3)
        say('\nSandbox (what the container can see):')
        labels = [f'{n:<20} {ws}   (home: {hd})' for n, ws, hd in configs]
        labels.append('no config: pick a workspace directory (sandbox home = euler-vibe default)')
        idx = choose('Choose:', labels)
        if idx < len(configs):
            config = configs[idx][0]
        else:
            workspace = input('Workspace directory on the cluster (absolute path): ').strip()
            if not workspace:
                die('a workspace is required')

    # --- resources ---
    profile = args.profile
    if not profile:
        profiles = parse_porcelain(cl.vt('profiles', '--porcelain').stdout, 3)
        if not profiles:
            die('no sbatch profiles found on the cluster (add some to profiles/ and rerun)')
        say('\nResources (sbatch profile):')
        idx = choose('Choose:', [f'{n:<18} {summary}' for n, _, summary in profiles])
        profile = profiles[idx][0]

    name = args.name
    if name is None and interactive:
        name = input('\nOptional label for the tunnel (a-z, 0-9, -; Enter to skip): ').strip()

    submit = ['submit', profile, '--json']
    if config:
        submit += ['--config', config]
    if workspace:
        submit += ['--workspace', workspace]
    if args.home:
        submit += ['--home', args.home]
    for b in args.rw or []:
        submit += ['--rw', b]
    for b in args.ro or []:
        submit += ['--ro', b]
    if name:
        submit += ['--name', name]
    if args.extensions is not None:
        submit += ['--extensions', args.extensions]

    p = cl.vt(*submit, check=False)
    if p.returncode != 0:
        die((p.stderr or p.stdout).strip().replace('vibe-tunnel: ', '', 1))
    info = json.loads(p.stdout.strip().splitlines()[-1])
    say(f'\nSubmitted job {info["job_id"]} ({info["job_name"]}), profile {profile}'
        + (f', config {config}' if config else f', workspace {workspace}'))
    say(f'  cluster log: {info["log"]}')
    try:
        return wait_for_tunnel(cl, info['job_id'], cfg, how)
    except KeyboardInterrupt:
        say(f'\n  Stopped waiting. The job keeps running; reopen with:  python vibe_tunnel.py open {info["job_id"]}')
        return 0


def main():
    cfg = load_cfg()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--host', default=cfg['host'], help=f"ssh host/alias (default: {cfg['host']})")
    ap.add_argument('--remote-dir', default=cfg['remote_dir'], help=f"cluster clone of this repo (default: {cfg['remote_dir']})")
    ap.add_argument('--no-sync', action='store_true', help='do not upload local profiles/*.sbatch')
    sub = ap.add_subparsers(dest='cmd')

    s = sub.add_parser('start', help='start a new tunnel (interactive unless options are given)')
    s.add_argument('--profile', help='sbatch profile name (see: list of profiles)')
    s.add_argument('--config', help='saved claude-launch config name on the cluster')
    s.add_argument('--workspace', help='workspace directory on the cluster (instead of --config)')
    s.add_argument('--home', help='persistent sandbox home on the cluster (overrides the config)')
    s.add_argument('--rw', action='append', metavar='DIR[:DEST]', help='extra read-write bind (repeatable)')
    s.add_argument('--ro', action='append', metavar='DIR[:DEST]', help='extra read-only bind (repeatable)')
    s.add_argument('--name', help='tunnel label (a-z, 0-9, -; max 20)')
    s.add_argument('--extensions', help='comma-separated extension ids to preinstall (default: anthropic.claude-code)')
    s.add_argument('--browser', action='store_true', help='open vscode.dev instead of desktop VS Code')
    s.add_argument('--no-open', action='store_true', help='only print the links')

    sub.add_parser('list', help='show running tunnels')
    o = sub.add_parser('open', help='open a running tunnel in VS Code')
    o.add_argument('job_id')
    o.add_argument('--browser', action='store_true')
    lg = sub.add_parser('logs', help='show the job log')
    lg.add_argument('job_id')
    st = sub.add_parser('stop', help='cancel a tunnel job')
    st.add_argument('target', help='JOBID or label')

    args = ap.parse_args()
    if args.cmd is None:  # bare `vibe_tunnel.py [--host X]` means `start`
        args = ap.parse_args(sys.argv[1:] + ['start'])

    cl = Cluster(args.host, args.remote_dir)
    cl.connect()
    cl.check_install()
    if args.cmd == 'start' and cfg['sync_profiles'].lower() in ('1', 'true', 'yes') and not args.no_sync:
        cl.sync_profiles()

    rc = {'start': cmd_start, 'list': cmd_list, 'open': cmd_open, 'logs': cmd_logs, 'stop': cmd_stop}[args.cmd](cl, args, cfg)
    sys.exit(rc or 0)


if __name__ == '__main__':
    main()
