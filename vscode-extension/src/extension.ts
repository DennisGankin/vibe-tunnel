// vibe-tunnel VS Code extension: a sidebar for the tunnels and configs on the
// cluster, plus a step-by-step "new tunnel" flow. Thin by design: every action
// is one `vibe-tunnel` subcommand over ssh (see cluster.ts); validation and all
// job logic stay on the cluster, shared with the terminal client.
import * as vscode from 'vscode';
import { Cluster, ConfigDetail, ConfigSummary, SshError, Tunnel, WaitParser, configArgs, tunnelUri } from './cluster';

let cluster: Cluster;
let tree: TreeProvider;
let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('vibe-tunnel');
  cluster = makeCluster();
  tree = new TreeProvider();
  const view = vscode.window.createTreeView('vibeTunnel.view', { treeDataProvider: tree, showCollapseAll: false });

  // periodic refresh while the view is visible
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) { clearInterval(timer); timer = undefined; }
    const secs = vscode.workspace.getConfiguration('vibeTunnel').get<number>('refreshSeconds', 30);
    if (view.visible && secs > 0) { timer = setInterval(() => tree.refresh(), secs * 1000); }
  };
  view.onDidChangeVisibility(() => { if (view.visible) { tree.refresh(); } schedule(); });
  schedule();

  context.subscriptions.push(
    view, output,
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('vibeTunnel')) { cluster = makeCluster(); tree.refresh(); schedule(); }
    }),
    vscode.commands.registerCommand('vibeTunnel.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('vibeTunnel.newTunnel', () => guard(newTunnel)),
    vscode.commands.registerCommand('vibeTunnel.connect', (item?: TunnelItem) => guard(() => connect(item))),
    vscode.commands.registerCommand('vibeTunnel.stop', (item?: TunnelItem) => guard(() => stop(item))),
    vscode.commands.registerCommand('vibeTunnel.logs', (item?: TunnelItem) => guard(() => logs(item))),
    vscode.commands.registerCommand('vibeTunnel.launchConfig', (item?: ConfigItem) => guard(() => launchConfig(item))),
    vscode.commands.registerCommand('vibeTunnel.editConfig', (item?: ConfigItem) => guard(() => editConfig(item))),
    vscode.commands.registerCommand('vibeTunnel.deleteConfig', (item?: ConfigItem) => guard(() => deleteConfig(item))),
    vscode.commands.registerCommand('vibeTunnel.claudeTerminal', (item?: ConfigItem) => runInTerminal('claude', item)),
    vscode.commands.registerCommand('vibeTunnel.shellTerminal', (item?: ConfigItem) => runInTerminal('shell', item)),
    vscode.commands.registerCommand('vibeTunnel.openMenu', () => openTerminal('vibe-tunnel menu', ['launch'])),
    vscode.commands.registerCommand('vibeTunnel.loginTerminal', loginTerminal),
    vscode.commands.registerCommand('vibeTunnel.doctor', () => guard(async () => { output.clear(); output.appendLine(await cluster.doctor()); output.show(true); })),
  );
  tree.refresh();
}

export function deactivate(): void { /* nothing to clean up */ }

function makeCluster(): Cluster {
  const cfg = vscode.workspace.getConfiguration('vibeTunnel');
  return new Cluster(cfg.get<string>('host', 'euler'), cfg.get<string>('remoteDir', '~/vibe-tunnel'), cfg.get<string>('sshPath', 'ssh'));
}

/** Run an action; turn ssh/CLI errors into messages with a way forward. */
async function guard(fn: () => Promise<void>): Promise<void> {
  try { await fn(); }
  catch (e) {
    if (e instanceof SshError) {
      void vscode.commands.executeCommand('setContext', 'vibeTunnel.state', 'error');
      const pick = await vscode.window.showErrorMessage(e.message, 'Log in via terminal', 'Settings');
      if (pick === 'Log in via terminal') { loginTerminal(); }
      if (pick === 'Settings') { void vscode.commands.executeCommand('workbench.action.openSettings', 'vibeTunnel'); }
    } else if (e instanceof Error && e.message !== 'cancelled') {
      void vscode.window.showErrorMessage(`vibe-tunnel: ${e.message}`);
    }
  }
}

// --- tree --------------------------------------------------------------------
class GroupItem extends vscode.TreeItem {
  constructor(label: string, public readonly kind: 'tunnels' | 'configs', count: number) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = String(count);
    this.contextValue = 'group';
  }
}
class TunnelItem extends vscode.TreeItem {
  constructor(public readonly tunnel: Tunnel) {
    super(tunnel.tunnel || '(starting…)', vscode.TreeItemCollapsibleState.None);
    const t = tunnel;
    this.description = `${t.state.toLowerCase()}${t.node ? ' · ' + t.node : ''}${t.left ? ' · ' + t.left + ' left' : ''}`;
    this.tooltip = `job ${t.jobId} (${t.jobName})\nworkspace: ${t.workspace || '?'}\n${t.link || 'tunnel not up yet'}`;
    this.iconPath = new vscode.ThemeIcon(t.link ? 'plug' : 'loading~spin');
    this.contextValue = t.link ? 'tunnel' : 'tunnel-pending';
    if (t.link) { this.command = { command: 'vibeTunnel.connect', title: 'Connect', arguments: [this] }; }
  }
}
class ConfigItem extends vscode.TreeItem {
  constructor(public readonly config: ConfigSummary) {
    super(config.name, vscode.TreeItemCollapsibleState.None);
    this.description = `${shorten(config.workspace)}${config.profile ? ' · ' + config.profile : ''}`;
    this.tooltip = `workspace: ${config.workspace}\nhome: ${config.home}\nprofile: ${config.profile || '(none)'}\nlabel: ${config.label || config.name}\nsource: ${config.source}`;
    this.iconPath = new vscode.ThemeIcon(config.source === 'vibe-tunnel' ? 'file-code' : 'file-symlink-file');
    this.contextValue = config.source === 'vibe-tunnel' ? 'config-own' : 'config-other';
    this.command = { command: 'vibeTunnel.launchConfig', title: 'Launch', arguments: [this] };
  }
}
type Item = GroupItem | TunnelItem | ConfigItem;

class TreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly emitter = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private tunnels: Tunnel[] = []; private configs: ConfigSummary[] = [];
  private loading: Promise<void> | undefined;

  refresh(): void { this.loading = undefined; this.emitter.fire(undefined); }
  getTreeItem(e: Item): vscode.TreeItem { return e; }
  async getChildren(e?: Item): Promise<Item[]> {
    if (!e) {
      this.loading ??= this.load();
      await this.loading;
      return [new GroupItem('Running tunnels', 'tunnels', this.tunnels.length), new GroupItem('Saved configs', 'configs', this.configs.length)];
    }
    if (e instanceof GroupItem) {
      return e.kind === 'tunnels' ? this.tunnels.map(t => new TunnelItem(t)) : this.configs.map(c => new ConfigItem(c));
    }
    return [];
  }
  private async load(): Promise<void> {
    try {
      [this.tunnels, this.configs] = await Promise.all([cluster.status(), cluster.configs()]);
      void vscode.commands.executeCommand('setContext', 'vibeTunnel.state', 'ok');
    } catch (e) {
      this.tunnels = []; this.configs = [];
      void vscode.commands.executeCommand('setContext', 'vibeTunnel.state', 'error');
      if (e instanceof SshError) { output.appendLine(`[refresh] ${e.message}`); } else { throw e; }
    }
  }
}

function shorten(p: string): string {
  return p.replace(/^\/cluster\/(home|project|scratch)\//, '$1:').replace(/^\/cluster\//, '');
}

// --- actions --------------------------------------------------------------------
async function pickTunnel(item?: TunnelItem, onlyReady = true): Promise<Tunnel | undefined> {
  if (item) { return item.tunnel; }
  const list = (await cluster.status()).filter(t => !onlyReady || t.link);
  if (list.length === 0) { void vscode.window.showInformationMessage('No running tunnels.'); return undefined; }
  const pick = await vscode.window.showQuickPick(list.map(t => ({ label: t.tunnel || '(starting)', description: `${t.state} · ${t.node} · job ${t.jobId}`, t })), { placeHolder: 'Tunnel' });
  return pick?.t;
}

async function connect(item?: TunnelItem): Promise<void> {
  const t = await pickTunnel(item); if (!t) { return; }
  await openTunnel(t.tunnel, t.workspace || '/workspace', t.link);
}

async function openTunnel(tunnel: string, workspace: string, link: string): Promise<void> {
  const openIn = vscode.workspace.getConfiguration('vibeTunnel').get<string>('openIn', 'window');
  if (openIn === 'browser') { await vscode.env.openExternal(vscode.Uri.parse(link || `https://vscode.dev/tunnel/${tunnel}${workspace}`)); return; }
  if (!vscode.extensions.getExtension('ms-vscode.remote-server')) {
    const pick = await vscode.window.showInformationMessage('The "Remote - Tunnels" extension is needed to open tunnels.', 'Install', 'Open in browser instead');
    if (pick === 'Install') {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', 'ms-vscode.remote-server');
    } else if (pick === 'Open in browser instead') {
      await vscode.env.openExternal(vscode.Uri.parse(link || `https://vscode.dev/tunnel/${tunnel}${workspace}`)); return;
    } else { return; }
  }
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(tunnelUri(tunnel, workspace)), { forceNewWindow: true });
}

async function stop(item?: TunnelItem): Promise<void> {
  const t = await pickTunnel(item, false); if (!t) { return; }
  const ok = await vscode.window.showWarningMessage(`Stop tunnel ${t.tunnel || t.jobId} (job ${t.jobId})? The slurm job is cancelled; nothing in the workspace is lost.`, { modal: true }, 'Stop');
  if (ok !== 'Stop') { return; }
  output.appendLine(await cluster.stop(t.jobId));
  tree.refresh();
}

async function logs(item?: TunnelItem): Promise<void> {
  const t = await pickTunnel(item, false); if (!t) { return; }
  output.clear(); output.appendLine(`# vibe-tunnel logs ${t.jobId}`); output.appendLine(await cluster.logs(t.jobId)); output.show(true);
  const pick = await vscode.window.showInformationMessage(`Log of job ${t.jobId} shown in the output panel.`, 'Follow in terminal');
  if (pick) { openTerminal(`vibe-tunnel logs ${t.jobId}`, ['logs', t.jobId, '-f']); }
}

async function launchConfig(item?: ConfigItem): Promise<void> {
  let name = item?.config.name;
  if (!name) {
    const list = await cluster.configs();
    const pick = await vscode.window.showQuickPick(list.map(c => ({ label: c.name, description: c.workspace, name: c.name })), { placeHolder: 'Config to launch' });
    name = pick?.name; if (!name) { return; }
  }
  const detail = await cluster.configShow(name);
  if (detail.mode !== 'tunnel') {
    const pick = await vscode.window.showInformationMessage(`Config "${name}" is a ${detail.mode} config (no VS Code tunnel). Run it in a terminal?`, 'Open terminal');
    if (pick) { openTerminal(`vibe-tunnel ${detail.mode} ${name}`, [detail.mode, '--config', name]); }
    return;
  }
  if (!detail.profile) {
    const p = await pickProfile(''); if (!p) { return; }
    await submitAndWait(['--config', name, p]);
  } else {
    await submitAndWait(['--config', name]);
  }
}

async function submitAndWait(submitArgs: string[]): Promise<void> {
  const res = await cluster.submit(submitArgs);
  output.appendLine(`submitted job ${res.job_id} (${res.job_name})${res.resources ? ' — ' + res.resources : ''}`);
  tree.refresh();
  await waitAndOpen(res.job_id, res.tunnel_name || res.job_name);
}

/** Stream `vibe-tunnel wait`; show the device code when needed; open VS Code when the tunnel is up. */
async function waitAndOpen(jobId: string, title: string): Promise<void> {
  const parser = new WaitParser();
  let ready: { tunnel: string; workspace: string; link: string } | undefined;
  const code = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `vibe-tunnel: ${title}`, cancellable: true },
    async (progress, token) => {
      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());
      progress.report({ message: 'submitted, waiting for the job…' });
      return cluster.stream(['wait', jobId], (line) => {
        const ev = parser.feed(line); if (!ev) { return; }
        if (ev.kind === 'text') { progress.report({ message: ev.text }); output.appendLine(ev.text!); }
        if (ev.kind === 'device') {
          void vscode.env.clipboard.writeText(ev.code!);
          void vscode.window.showInformationMessage(`VS Code tunnel login (once per sandbox home): enter code ${ev.code} on GitHub. It is in your clipboard.`, 'Open GitHub')
            .then(pick => { if (pick) { void vscode.env.openExternal(vscode.Uri.parse(ev.url || 'https://github.com/login/device')); } });
          progress.report({ message: `waiting for the GitHub login (code ${ev.code})…` });
        }
        if (ev.kind === 'ready') { ready = { tunnel: ev.tunnel!, workspace: ev.workspace!, link: ev.link! }; }
      }, ac.signal);
    });
  if (ready) {
    tree.refresh();
    await openTunnel(ready.tunnel, ready.workspace, ready.link);
  } else if (code === 143 || code === -1) {
    void vscode.window.showInformationMessage(`Stopped waiting; job ${jobId} keeps running. Reconnect from the sidebar when it is up.`);
  } else {
    const pick = await vscode.window.showErrorMessage(`Job ${jobId} ended before the tunnel came up.`, 'Show log');
    if (pick) { output.appendLine(await cluster.logs(jobId)); output.show(true); }
  }
}

async function deleteConfig(item?: ConfigItem): Promise<void> {
  if (!item) { return; }
  const ok = await vscode.window.showWarningMessage(`Delete config "${item.config.name}"?`, { modal: true }, 'Delete');
  if (ok !== 'Delete') { return; }
  output.appendLine(await cluster.configDelete(item.config.name));
  tree.refresh();
}

async function editConfig(item?: ConfigItem): Promise<void> {
  if (!item) { return; }
  const detail = await cluster.configShow(item.config.name);
  await wizard(detail, item.config.name);
}

async function newTunnel(): Promise<void> {
  const configs = await cluster.configs();
  type P = vscode.QuickPickItem & { action: 'scratch' | 'launch' | 'adjust'; name?: string };
  const items: P[] = [{ label: '$(add) From scratch', description: 'choose workspace, resources, …', action: 'scratch' }];
  for (const c of configs) {
    items.push({ label: `$(play) ${c.name}`, description: `${shorten(c.workspace)}${c.profile ? ' · ' + c.profile : ''}`, detail: 'launch as saved', action: 'launch', name: c.name });
    items.push({ label: `$(edit) ${c.name}`, description: 'adjust first', action: 'adjust', name: c.name });
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Start a new tunnel from…', matchOnDescription: true });
  if (!pick) { return; }
  if (pick.action === 'launch') { await submitAndWait(['--config', pick.name!]); return; }
  const base: ConfigDetail = pick.action === 'adjust' ? await cluster.configShow(pick.name!) : {
    name: '', file: '', source: '', workspace: '', mode: 'tunnel', home: '', profile: '', label: '',
    time: '', cpus: '', mem: '', gpus: '', partition: '', account: '', rw: [], ro: [],
  };
  await wizard(base, pick.action === 'adjust' ? pick.name : undefined);
}

// --- the step-by-step setup ("wizard") ---------------------------------------------------
async function wizard(d: ConfigDetail, savedName?: string): Promise<void> {
  const state = { ...d, rw: [...d.rw], ro: [...d.ro] };
  const profiles = await cluster.profiles();
  if (!state.profile && profiles.length) { state.profile = profiles[0].name; }
  for (;;) {
    const resources = profiles.find(p => p.name === state.profile)?.summary ?? '';
    const overrides = ['time', 'cpus', 'mem', 'gpus', 'partition', 'account'].filter(k => (state as any)[k]).map(k => `${k} ${(state as any)[k]}*`).join(' · ');
    type S = vscode.QuickPickItem & { step: string };
    const items: S[] = [
      { label: '$(folder) Workspace', description: state.workspace || '(current directory on the cluster)', step: 'workspace' },
      { label: '$(home) Sandbox home', description: state.home || '(default: ~/.vibe-tunnel/home)', step: 'home' },
      { label: '$(list-tree) Extra directories', description: `${state.rw.length} read-write, ${state.ro.length} read-only`, step: 'binds' },
      { label: '$(symbol-event) Mode', description: state.mode, step: 'mode' },
    ];
    if (state.mode === 'tunnel') {
      items.push({ label: '$(server) Resources', description: `${state.profile || '(no profile)'}  ${resources}${overrides ? '  |  ' + overrides : ''}`, step: 'resources' });
      items.push({ label: '$(tag) Tunnel label', description: state.label || (savedName ? `(default: ${savedName})` : '(default: vibe-<jobid>)'), step: 'label' });
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, step: '' });
    if (state.mode === 'tunnel') { items.push({ label: '$(play) Launch now', step: 'launch' }); }
    else { items.push({ label: '$(terminal) Run in a terminal now', step: 'launch' }); }
    items.push({ label: '$(save) Save as config' + (savedName ? ` (${savedName})` : '…'), step: 'save' });
    if (state.mode === 'tunnel') { items.push({ label: '$(save-all) Save and launch', step: 'savelaunch' }); }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: savedName ? `Config ${savedName}` : 'New tunnel — pick what to change, then Launch', ignoreFocusOut: true });
    if (!pick) { return; }
    switch (pick.step) {
      case 'workspace': { const p = await browseDir(state.workspace || '~', 'Workspace: the project directory (VS Code opens here)'); if (p) { state.workspace = p; } break; }
      case 'home': {
        const v = await vscode.window.showInputBox({ prompt: 'Sandbox home on the cluster (Claude + VS Code logins live here). Empty = default.', value: state.home, ignoreFocusOut: true });
        if (v !== undefined) { state.home = v.trim(); } break;
      }
      case 'binds': await editBinds(state); break;
      case 'mode': {
        const m = await vscode.window.showQuickPick([
          { label: 'tunnel', description: 'slurm job with a VS Code tunnel into the container' },
          { label: 'claude', description: 'Claude Code in the container, in a terminal (no slurm job)' },
          { label: 'shell', description: 'a shell in the container, in a terminal' }], { placeHolder: 'Mode' });
        if (m) { state.mode = m.label; } break;
      }
      case 'resources': await editResources(state, profiles); break;
      case 'label': {
        const v = await vscode.window.showInputBox({ prompt: 'Tunnel label (a-z, 0-9, -; max 20). Empty = default.', value: state.label, ignoreFocusOut: true,
          validateInput: s => /^[A-Za-z0-9-]{0,20}$/.test(s) ? undefined : 'letters, digits and - only, max 20' });
        if (v !== undefined) { state.label = v.toLowerCase(); } break;
      }
      case 'save': case 'savelaunch': {
        const name = await vscode.window.showInputBox({ prompt: 'Config name', value: savedName ?? '', ignoreFocusOut: true,
          validateInput: s => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) ? undefined : 'letters, digits, . _ - ; must start with a letter or digit' });
        if (!name) { break; }
        output.appendLine(await cluster.configSave(name, state));
        savedName = name; tree.refresh();
        if (pick.step === 'save') { void vscode.window.showInformationMessage(`Saved config "${name}".`); break; }
        await submitAndWait(['--config', name]); return;
      }
      case 'launch': {
        if (state.mode !== 'tunnel') {
          openTerminal(`vibe-tunnel ${state.mode}`, [state.mode, ...configArgs(state, true).filter((_, i, a) => true)]); return;
        }
        if (!state.profile) { const p = await pickProfile(''); if (!p) { break; } state.profile = p; }
        await submitAndWait(configArgs(state, true)); return;
      }
    }
  }
}

async function editBinds(state: ConfigDetail): Promise<void> {
  for (;;) {
    type B = vscode.QuickPickItem & { act: string; idx?: number; which?: 'rw' | 'ro' };
    const items: B[] = [
      { label: '$(add) Add read-write directory', act: 'add-rw' },
      { label: '$(add) Add read-only directory', act: 'add-ro' },
    ];
    if (state.rw.length + state.ro.length) { items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, act: '' }); }
    state.rw.forEach((b, i) => items.push({ label: `$(trash) rw  ${b}`, description: 'remove', act: 'rm', idx: i, which: 'rw' }));
    state.ro.forEach((b, i) => items.push({ label: `$(trash) ro  ${b}`, description: 'remove', act: 'rm', idx: i, which: 'ro' }));
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, act: '' }, { label: '$(check) Done', act: 'done' });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Extra directories Claude may read (ro) or read & write (rw), besides the workspace', ignoreFocusOut: true });
    if (!pick || pick.act === 'done') { return; }
    if (pick.act === 'rm') { (pick.which === 'rw' ? state.rw : state.ro).splice(pick.idx!, 1); continue; }
    const src = await browseDir('~', pick.act === 'add-rw' ? 'Read-write directory' : 'Read-only directory'); if (!src) { continue; }
    const dest = await vscode.window.showInputBox({ prompt: `Mount inside the container as (empty = same path ${src})`, ignoreFocusOut: true });
    if (dest === undefined) { continue; }
    (pick.act === 'add-rw' ? state.rw : state.ro).push(dest.trim() ? `${src}:${dest.trim()}` : src);
  }
}

async function editResources(state: ConfigDetail, profiles: { name: string; summary: string }[]): Promise<void> {
  for (;;) {
    const fields: [keyof ConfigDetail, string, string][] = [
      ['time', 'Time limit', 'd-hh:mm:ss, e.g. 04:00:00 or 2-00:00:00'], ['cpus', 'CPUs', 'e.g. 16'], ['mem', 'Memory per CPU', 'e.g. 2G'],
      ['gpus', 'GPUs', 'e.g. a100:1 or rtx_4090:4'], ['partition', 'Partition', ''], ['account', 'Account', 'e.g. es_biol']];
    const summary = profiles.find(p => p.name === state.profile)?.summary ?? '';
    type R = vscode.QuickPickItem & { key: string };
    const items: R[] = [{ label: `$(server) Profile: ${state.profile || '(none)'}`, description: summary, key: 'profile' }];
    for (const [k, label] of fields) {
      const v = state[k] as string;
      items.push({ label: `${label}: ${v || '(profile default)'}`, description: v ? 'override' : '', key: k as string });
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, key: '' }, { label: '$(discard) Reset overrides', key: 'reset' }, { label: '$(check) Done', key: 'done' });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Resources: profile defaults, overridden per field (passed to sbatch as flags)', ignoreFocusOut: true });
    if (!pick || pick.key === 'done') { return; }
    if (pick.key === 'reset') { for (const [k] of fields) { (state as any)[k] = ''; } continue; }
    if (pick.key === 'profile') { const p = await pickProfile(state.profile); if (p) { state.profile = p; } continue; }
    const f = fields.find(x => x[0] === pick.key)!;
    const v = await vscode.window.showInputBox({ prompt: `${f[1]} (${f[2]}). Empty = the profile's value.`, value: state[f[0]] as string, ignoreFocusOut: true });
    if (v !== undefined) { (state as any)[f[0]] = v.trim(); }
  }
}

async function pickProfile(current: string): Promise<string | undefined> {
  const profiles = await cluster.profiles();
  if (!profiles.length) { void vscode.window.showErrorMessage('No sbatch profiles on the cluster.'); return undefined; }
  const pick = await vscode.window.showQuickPick(profiles.map(p => ({ label: p.name, description: p.summary, picked: p.name === current })), { placeHolder: 'Resource profile (preset)' });
  return pick?.label;
}

/** Remote directory browser on top of `vibe-tunnel ls`. */
async function browseDir(start: string, title: string): Promise<string | undefined> {
  let dir = start;
  for (;;) {
    let listing: { dir: string; entries: string[] };
    try { listing = await cluster.ls(dir); }
    catch (e) { void vscode.window.showErrorMessage(String(e instanceof Error ? e.message : e)); dir = '~'; continue; }
    dir = listing.dir;
    type D = vscode.QuickPickItem & { act: string };
    const items: D[] = [
      { label: `$(check) Use this directory`, description: dir, act: 'use' },
      { label: '$(arrow-up) ..', description: 'parent', act: 'up' },
      { label: '$(edit) Type a path…', act: 'type' },
      { label: '', kind: vscode.QuickPickItemKind.Separator, act: '' },
      ...listing.entries.map(e => ({ label: `$(folder) ${e}`, act: 'cd:' + e })),
    ];
    const pick = await vscode.window.showQuickPick(items, { title, placeHolder: dir, ignoreFocusOut: true, matchOnDescription: true });
    if (!pick) { return undefined; }
    if (pick.act === 'use') { return dir; }
    if (pick.act === 'up') { dir = dir.replace(/\/[^/]+\/?$/, '') || '/'; continue; }
    if (pick.act === 'type') {
      const v = await vscode.window.showInputBox({ prompt: 'Directory on the cluster', value: dir, ignoreFocusOut: true });
      if (v) { dir = v.trim(); } continue;
    }
    dir = `${dir.replace(/\/$/, '')}/${pick.act.slice(3)}`;
  }
}

// --- terminals ---------------------------------------------------------------------------
function openTerminal(name: string, args: string[] | null): vscode.Terminal {
  const term = vscode.window.createTerminal({ name, shellPath: cluster.sshPath, shellArgs: cluster.terminalArgs(args) });
  term.show();
  return term;
}
function runInTerminal(mode: 'claude' | 'shell', item?: ConfigItem): void {
  if (!item) { return; }
  openTerminal(`vibe-tunnel ${mode} · ${item.config.name}`, [mode, '--config', item.config.name]);
}
/** Interactive ssh in a terminal: type passphrase/OTP once; the multiplexed master then serves the extension. */
function loginTerminal(): void {
  const t = openTerminal(`ssh ${cluster.host}`, null);
  void vscode.window.showInformationMessage(cluster.mux
    ? `Log in to ${cluster.host} in the terminal, then refresh the sidebar. The connection stays open for 15 minutes.`
    : `Log in to ${cluster.host} in the terminal. On Windows the extension cannot reuse that connection: set up an ssh key and agent so ssh needs no prompt.`);
  void t;
}
