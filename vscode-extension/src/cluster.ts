// Talks to the cluster copy of vibe-tunnel over ssh. Pure Node (no vscode
// import) so it can be tested against a fake ssh. Every method maps to one
// `vibe-tunnel` subcommand; parsing of the --porcelain formats lives here.
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as readline from 'node:readline';

export interface RunResult { code: number; stdout: string; stderr: string; }

export interface Tunnel {
  jobId: string; jobName: string; state: string; node: string; elapsed: string; left: string;
  tunnel: string; link: string; workspace: string;
}
export interface ConfigSummary { name: string; workspace: string; home: string; profile: string; label: string; source: string; }
export interface Profile { name: string; path: string; summary: string; }
export interface ConfigDetail {
  name: string; file: string; source: string; workspace: string; mode: string; home: string; profile: string; label: string;
  time: string; cpus: string; mem: string; gpus: string; partition: string; account: string; rw: string[]; ro: string[];
}
export interface SubmitResult { job_id: string; job_name: string; tunnel_name: string; log: string; profile: string; config: string; resources?: string; }

export class SshError extends Error {
  constructor(message: string, public readonly code: number, public readonly stderr: string) { super(message); }
}

/** Quote for the remote POSIX shell. */
export function shellQuote(s: string): string {
  if (s !== '' && /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(s)) { return s; }
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class Cluster {
  constructor(
    public readonly host: string,
    public readonly remoteDir: string,
    public readonly sshPath = 'ssh',
    /** ssh connection multiplexing (shared with the bash client); off on Windows */
    public readonly mux = process.platform !== 'win32',
  ) {}

  private muxArgs(): string[] {
    if (!this.mux) { return []; }
    const control = `${os.homedir()}/.ssh/vibe-tunnel-%C`;
    return ['-o', 'ControlMaster=auto', '-o', `ControlPath=${control}`, '-o', 'ControlPersist=15m'];
  }
  private commonArgs(): string[] {
    return ['-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', ...this.muxArgs()];
  }
  /** Command line for `vibe-tunnel ARGS` on the cluster. */
  remoteCommand(args: string[]): string {
    return ['NO_COLOR=1', shellQuote(`${this.remoteDir}/bin/vibe-tunnel`), ...args.map(shellQuote)].join(' ');
  }
  /** ssh invocation (non-interactive) for use with spawn. */
  sshArgs(args: string[]): string[] {
    return [...this.commonArgs(), '-o', 'BatchMode=yes', this.host, this.remoteCommand(args)];
  }
  /** ssh invocation with a tty, for a VS Code terminal (menus, editors, interactive logins). */
  terminalArgs(args: string[] | null): string[] {
    const base = ['-t', ...this.commonArgs(), this.host];
    return args ? [...base, this.remoteCommand(args)] : base;
  }

  run(args: string[]): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.sshPath, this.sshArgs(args), { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', (e) => reject(new SshError(`cannot start ${this.sshPath}: ${e.message}`, -1, '')));
      child.on('close', (code) => {
        // 255 is ssh itself (connection/auth); anything else came from vibe-tunnel
        if (code === 255) { reject(new SshError(`ssh ${this.host} failed: ${stderr.trim() || 'connection or authentication problem'}`, 255, stderr)); return; }
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  /** Run and fail with vibe-tunnel's own message when it exits non-zero. */
  async runOk(args: string[]): Promise<string> {
    const r = await this.run(args);
    if (r.code !== 0) { throw new Error((r.stderr || r.stdout).trim().replace(/^vibe-tunnel: /, '')); }
    return r.stdout;
  }

  /** Stream stdout+stderr line by line; resolves with the exit code. */
  stream(args: string[], onLine: (line: string) => void, signal?: AbortSignal): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.sshPath, this.sshArgs(args), { stdio: ['ignore', 'pipe', 'pipe'] });
      const onAbort = () => child.kill();
      signal?.addEventListener('abort', onAbort, { once: true });
      for (const s of [child.stdout, child.stderr]) {
        readline.createInterface({ input: s }).on('line', onLine);
      }
      child.on('error', (e) => reject(new SshError(`cannot start ${this.sshPath}: ${e.message}`, -1, '')));
      child.on('close', (code) => { signal?.removeEventListener('abort', onAbort); resolve(code ?? -1); });
    });
  }

  // --- subcommands ------------------------------------------------------------
  async status(): Promise<Tunnel[]> {
    const out = await this.runOk(['status', '--porcelain']);
    return parsePorcelain(out, 9).map(f => ({
      jobId: f[0], jobName: f[1], state: f[2], node: f[3], elapsed: f[4], left: f[5], tunnel: f[6], link: f[7], workspace: f[8],
    }));
  }
  async configs(): Promise<ConfigSummary[]> {
    const out = await this.runOk(['configs', '--porcelain']);
    return parsePorcelain(out, 6).map(f => ({ name: f[0], workspace: f[1], home: f[2], profile: f[3], label: f[4], source: f[5] }));
  }
  async profiles(): Promise<Profile[]> {
    const out = await this.runOk(['profiles', '--porcelain']);
    return parsePorcelain(out, 3).map(f => ({ name: f[0], path: f[1], summary: f[2] }));
  }
  async configShow(name: string): Promise<ConfigDetail> {
    const out = await this.runOk(['config', 'show', name, '--porcelain']);
    const kv: Record<string, string> = {}; const rw: string[] = []; const ro: string[] = [];
    for (const line of out.split('\n')) {
      const i = line.indexOf('='); if (i < 0) { continue; }
      const k = line.slice(0, i), v = line.slice(i + 1);
      if (k === 'RW') { rw.push(v); } else if (k === 'RO') { ro.push(v); } else { kv[k] = v; }
    }
    return {
      name: kv.NAME ?? name, file: kv.FILE ?? '', source: kv.SOURCE ?? '', workspace: kv.WORKSPACE ?? '', mode: kv.MODE || 'tunnel',
      home: kv.HOME ?? '', profile: kv.PROFILE ?? '', label: kv.LABEL ?? '', time: kv.TIME ?? '', cpus: kv.CPUS ?? '', mem: kv.MEM ?? '',
      gpus: kv.GPUS ?? '', partition: kv.PARTITION ?? '', account: kv.ACCOUNT ?? '', rw, ro,
    };
  }
  async ls(dir: string): Promise<{ dir: string; entries: string[] }> {
    const out = await this.runOk(['ls', dir, '--porcelain']);
    const lines = out.split('\n').filter(l => l.length > 0);
    const first = lines.shift() ?? '';
    return { dir: first.startsWith('DIR=') ? first.slice(4) : dir, entries: lines };
  }
  async submit(args: string[]): Promise<SubmitResult> {
    const out = await this.runOk(['submit', ...args, '--json']);
    const last = out.trim().split('\n').pop() ?? '';
    return JSON.parse(last) as SubmitResult;
  }
  async stop(target: string): Promise<string> { return (await this.runOk(['stop', target])).trim(); }
  async logs(jobId: string): Promise<string> { const r = await this.run(['logs', jobId]); return r.stdout + r.stderr; }
  async doctor(): Promise<string> { const r = await this.run(['doctor']); return r.stdout + r.stderr; }
  async configDelete(name: string): Promise<string> { return (await this.runOk(['config', 'delete', name])).trim(); }
  async configSave(name: string, d: Omit<ConfigDetail, 'name' | 'file' | 'source'>): Promise<string> {
    return (await this.runOk(['config', 'save', name, ...configArgs(d)])).trim();
  }
}

/** Flags shared by `config save` and `submit` for a setup. */
export function configArgs(d: Omit<ConfigDetail, 'name' | 'file' | 'source'>, forSubmit = false): string[] {
  const a: string[] = [];
  if (!forSubmit) { a.push('--mode', d.mode || 'tunnel'); }
  if (d.profile) { a.push(forSubmit ? d.profile : '--profile', ...(forSubmit ? [] : [d.profile])); }
  if (d.workspace) { a.push('--workspace', d.workspace); }
  if (d.home) { a.push('--home', d.home); }
  for (const b of d.rw) { a.push('--rw', b); }
  for (const b of d.ro) { a.push('--ro', b); }
  if (d.label) { a.push('--name', d.label); }
  if (d.time) { a.push('--time', d.time); }
  if (d.cpus) { a.push('--cpus', d.cpus); }
  if (d.mem) { a.push('--mem', d.mem); }
  if (d.gpus) { a.push('--gpus', d.gpus); }
  if (d.partition) { a.push('--partition', d.partition); }
  if (d.account) { a.push('--account', d.account); }
  return a;
}

export function parsePorcelain(text: string, n: number): string[][] {
  return text.split('\n').filter(l => l.trim().length > 0).map(l => {
    const f = l.split('|'); while (f.length < n) { f.push(''); } return f.slice(0, n);
  });
}

/** Lines printed by `vibe-tunnel wait` that a client reacts to. */
export interface WaitEvent { kind: 'device' | 'ready' | 'text'; url?: string; code?: string; tunnel?: string; workspace?: string; link?: string; text?: string; }
export class WaitParser {
  private url = ''; private tunnel = ''; private workspace = ''; private link = '';
  feed(line: string): WaitEvent | null {
    if (line.startsWith('DEVICE_URL=')) { this.url = line.slice(11); return null; }
    if (line.startsWith('DEVICE_CODE=')) { return { kind: 'device', url: this.url, code: line.slice(12) }; }
    if (line.startsWith('TUNNEL=')) { this.tunnel = line.slice(7); return null; }
    if (line.startsWith('WORKSPACE=')) { this.workspace = line.slice(10); return null; }
    if (line.startsWith('LINK=')) { this.link = line.slice(5); return null; }
    if (line.startsWith('DESKTOP=')) { return { kind: 'ready', tunnel: this.tunnel, workspace: this.workspace || '/workspace', link: this.link }; }
    const t = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
    return t ? { kind: 'text', text: t } : null;
  }
}

export function tunnelUri(tunnel: string, workspace: string): string {
  return `vscode-remote://tunnel+${tunnel}${workspace.startsWith('/') ? workspace : '/' + workspace}`;
}
