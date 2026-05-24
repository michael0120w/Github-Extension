// Branch Explorer — local-only Cursor extension.
// Sidebar webview combining a Branches tab (local + GitHub branches with
// mirror status, per-branch push/pull/PR, multi-repo switching) and a
// GitHub Actions tab (live workflow runs with logs/re-run/cancel).
// Self-updates from GitHub Releases. No telemetry.

const vscode = require('vscode');
const { execFile, spawn } = require('child_process');
const fsSync = require('fs');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');

// ─── Self-update settings ──────────────────────────────────────────────────
// The extension lives in this dedicated GitHub repo. The update mechanism
// uses `gh api` (which inherits the user's GitHub SSO) to:
//   1) read the latest GitHub Release
//   2) compare the release's tag (e.g. "v0.5.1") against the installed version
//   3) download the .vsix asset attached to that release
//   4) install it via Cursor's CLI
// Releases are the source of truth; commits to main without a release are
// intentionally ignored so we never auto-install half-finished work.
const UPDATE_REPO = 'michael0120w/Github-Extension';
// How often the background timer re-checks for a new release.
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
// Floor between two version-check calls regardless of trigger source —
// prevents activation + visibility + timer from all firing at once.
const UPDATE_CHECK_MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Branch names we always protect from deletion. The actual default-branch
// detection (via `git symbolic-ref refs/remotes/origin/HEAD`) is layered on
// top of this — these are the belt-and-suspenders defaults for repos where
// the symbolic-ref isn't set.
const ALWAYS_PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'development']);

// Workspace-state key for the user's last picked repo in a multi-folder
// workspace. Persisted (rather than in-memory) so the selection survives
// extension host reloads, panel re-mounts, and Cursor restarts. Without
// persistence the dropdown silently reverts to workspaceFolders[0] on every
// reload, which is the root cause of the "I switched but the publish went
// to the wrong repo" class of bug.
const SELECTED_REPO_STATE_KEY = 'branchExplorer.selectedRepoPath';

// Lazy-initialised output channel used by every git/gh invocation. Visible
// via View → Output → "Branch Explorer". Logs the full args + cwd of every
// shelled command, plus stderr on failure — so when "src refspec ... does
// not match any" or any other git error fires, you can see exactly which
// folder it ran in. Single shared channel for the lifetime of the host.
let outputChannel = null;
function getOutputChannel() {
  if (!outputChannel) outputChannel = vscode.window.createOutputChannel('Branch Explorer');
  return outputChannel;
}
function logExec(label, args, cwd) {
  try {
    getOutputChannel().appendLine(`[${new Date().toISOString()}] ${label} ${(args || []).join(' ')}  (cwd: ${cwd || '<none>'})`);
  } catch { /* never throw out of logging */ }
}
function logExecError(label, args, cwd, err) {
  try {
    const ch = getOutputChannel();
    ch.appendLine(`[${new Date().toISOString()}] ✖ ${label} ${(args || []).join(' ')}  (cwd: ${cwd || '<none>'})`);
    if (err && err.stderr) ch.appendLine(`  stderr: ${String(err.stderr).trim()}`);
    if (err && err.message) ch.appendLine(`  message: ${err.message}`);
  } catch { /* never throw out of logging */ }
}

function compareSemver(a, b) {
  // Returns >0 if a > b, <0 if a < b, 0 if equal. Strips leading 'v'.
  // Pre-release suffixes (-rc.1 etc.) are treated as < the same numeric core,
  // matching semver convention. Anything we can't parse compares as 0.
  const norm = (s) => String(s || '').replace(/^v/i, '').trim();
  const splitCore = (s) => {
    const idx = s.search(/[-+]/);
    return idx === -1 ? [s, ''] : [s.slice(0, idx), s.slice(idx + 1)];
  };
  const [ac, apre] = splitCore(norm(a));
  const [bc, bpre] = splitCore(norm(b));
  const ap = ac.split('.').map((n) => parseInt(n, 10) || 0);
  const bp = bc.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const av = ap[i] || 0; const bv = bp[i] || 0;
    if (av !== bv) return av - bv;
  }
  // Numeric cores equal — anything with a pre-release is less than no pre-release.
  if (apre && !bpre) return -1;
  if (!apre && bpre) return 1;
  return 0;
}

function isProtectedBranch(name, defaultBranch) {
  if (!name) return false;
  if (ALWAYS_PROTECTED_BRANCHES.has(name)) return true;
  if (defaultBranch && name === defaultBranch) return true;
  return false;
}

// Git refname rules — enough to catch the common foot-guns before shelling out.
function validateBranchName(name) {
  const n = String(name || '').trim();
  if (!n) return 'Branch name is required.';
  if (n.includes(' ')) return 'Branch names cannot contain spaces.';
  if (n.startsWith('.')) return 'Branch names cannot start with a dot.';
  if (n.endsWith('.')) return 'Branch names cannot end with a dot.';
  if (n.endsWith('.lock')) return 'Branch names cannot end with .lock.';
  if (n.includes('..')) return 'Branch names cannot contain ..';
  if (/[~^:?*[\\]/.test(n)) return 'Branch names cannot contain ~ ^ : ? * [ \\';
  if (n.includes('@{')) return 'Branch names cannot contain @{';
  if (n.startsWith('-')) return 'Branch names cannot start with -';
  return null;
}

function activate(context) {
  // Single provider, single combined webview. The provider owns an `activeTab`
  // ('branches' | 'actions') and refresh() dispatches to whichever tab is
  // currently selected by the user.
  const provider = new BranchExplorerProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('branchExplorer.view', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('branchExplorer.refresh',              () => provider.refresh(true)),
    vscode.commands.registerCommand('branchExplorer.fetch',                () => provider.fetchAll()),
    vscode.commands.registerCommand('branchExplorer.pruneGone',            () => provider.pruneGone()),
    vscode.commands.registerCommand('branchExplorer.refreshActions',       () => { provider.switchTab('actions'); }),
    vscode.commands.registerCommand('branchExplorer.openActionsOnGithub',  () => provider.openActionsOnGithub()),
    vscode.commands.registerCommand('branchExplorer.showBranchesTab',      () => provider.switchTab('branches')),
    vscode.commands.registerCommand('branchExplorer.showActionsTab',       () => provider.switchTab('actions')),
    vscode.commands.registerCommand('branchExplorer.checkForUpdates',      () => provider.checkForUpdates(true)),
    vscode.commands.registerCommand('branchExplorer.installUpdate',        () => provider.installUpdate()),
    vscode.commands.registerCommand('branchExplorer.showDownloadStats',    () => provider.showDownloadStats()),
    vscode.commands.registerCommand('branchExplorer.commitCurrentBranch',  () => provider.commitCurrentBranch()),
    vscode.commands.registerCommand('branchExplorer.createBranch',        () => provider.createBranch()),
  );

  // Refresh whenever the user runs ANY git command via the SCM panel or any
  // file changes. Only the active tab actually re-fetches.
  const watcher = vscode.workspace.createFileSystemWatcher('**/.git/HEAD');
  watcher.onDidChange(() => provider.refresh());
  context.subscriptions.push(watcher);

  // Working-tree freshness: refresh whenever .git/index changes (any git add
  // / commit / reset / checkout activity) or whenever the user saves a file.
  // The "uncommitted changes" badge + Commit-button count are derived from
  // `git status`, which is fast but only re-runs on refresh — without these
  // hooks the badge would lag until the 30s timer ticks or the user clicks
  // Fetch. Save-document is debounced implicitly because vscode batches the
  // event and provider.refresh() is a no-op while the panel is hidden.
  const indexWatcher = vscode.workspace.createFileSystemWatcher('**/.git/index');
  indexWatcher.onDidChange(() => provider.refresh());
  indexWatcher.onDidCreate(() => provider.refresh());
  context.subscriptions.push(
    indexWatcher,
    vscode.workspace.onDidSaveTextDocument(() => provider.refresh()),
  );

  // One periodic refresh; the provider decides what (if anything) to re-fetch
  // based on the active tab and view visibility. 30s is fine for git-local
  // (branches tab), and slow enough for gh API rate limits (actions tab).
  const timer = setInterval(() => provider.refresh(), 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // Background `git fetch` so the ahead/behind counters reflect the real
  // state of GitHub without the user having to manually click "Fetch from
  // GitHub". 90s strikes a balance: fresh enough that teammate pushes
  // appear quickly, slow enough to be ~invisible. The fetch itself is
  // a no-op when the panel isn't visible.
  setTimeout(() => { provider.backgroundFetch(); }, 3_000);
  const fetchTimer = setInterval(() => provider.backgroundFetch(), 90_000);
  context.subscriptions.push({ dispose: () => clearInterval(fetchTimer) });

  // Self-update: kick off an initial check a few seconds after activate (so
  // we don't compete with the first render for resources), then re-check
  // hourly. The provider throttles to a 5-minute floor regardless.
  setTimeout(() => { provider.checkForUpdates(); }, 5_000);
  const updateTimer = setInterval(() => provider.checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(updateTimer) });
}

function deactivate() {}

class BranchExplorerProvider {
  constructor(context) {
    this.context = context;
    this.view = undefined;
    // Path of the workspace folder we're currently viewing. Defaults to the
    // first git-repo folder in the workspace. Switched via pickRepo() and
    // persisted to workspaceState so the selection survives extension host
    // reloads and panel re-mounts (without persistence, the dropdown silently
    // reverts to folders[0] on every reload — the multi-repo "I switched but
    // the push went to the wrong repo" bug).
    this.selectedRepoPath = undefined;
    try {
      const saved = context && context.workspaceState && context.workspaceState.get(SELECTED_REPO_STATE_KEY);
      if (typeof saved === 'string' && saved) this.selectedRepoPath = saved;
    } catch { /* no-op — workspaceState shouldn't throw, but never let it break activation */ }
    // Combined panel state — which tab is showing.
    this.activeTab = 'branches';        // 'branches' | 'actions'
    // Cache the last good actions state so a transient gh failure shows stale
    // data with a "couldn't refresh" hint instead of blanking the panel.
    this.actionsLastState = null;
    // Cache last good branches state so footer-only refreshes (e.g. during
    // update checks) don't re-run a full git status scan on huge dirty trees.
    this.branchesLastState = null;

    // ─── Background fetch tracking ─────────────────────────────────────
    // Ahead/behind counts are computed locally from the last `git fetch`
    // result. If we never fetch in the background, those counts go stale
    // the moment teammates push to GitHub. We auto-fetch on first visible,
    // on visibility change (if stale), and on a 90s timer (while visible).
    this.lastFetchedAt = 0;
    this.backgroundFetching = false;

    // ─── Self-update state ───
    this.currentVersion = (context && context.extension && context.extension.packageJSON && context.extension.packageJSON.version) || '0.0.0';
    this.updateInfo = null;            // { tagName, version, body, htmlUrl, assetApiPath, assetName, publishedAt }
    this.updateCheckedAt = 0;          // last successful API call (epoch ms)
    this.updateChecking = false;       // a check is in-flight
    this.updateInstalling = false;     // an install is in-flight
    this.updateError = null;           // last update-check error message
    this.updateToastShownFor = null;   // version we've already toasted about
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };

    view.webview.onDidReceiveMessage(async (msg) => {
      try {
        // Tab control (shared)
        if (msg.type === 'switchTab')   return this.switchTab(msg.tab);
        if (msg.type === 'refresh')     return this.refresh(true);
        if (msg.type === 'pickRepo')    return this.pickRepo();

        // Branches tab
        if (msg.type === 'fetch')              return this.fetchAll();
        if (msg.type === 'checkout')           return this.checkout(msg.branch);
        if (msg.type === 'delete')             return this.deleteBranch(msg.branch, msg.force);
        if (msg.type === 'pruneGone')          return this.pruneGone();
        if (msg.type === 'pull')               return this.pull();
        if (msg.type === 'push')               return this.push();
        if (msg.type === 'pullBranch')         return this.pullBranch(msg.branch);
        if (msg.type === 'pushBranch')         return this.pushBranch(msg.branch);
        if (msg.type === 'publishBranch')      return this.publishBranch(msg.branch);
        if (msg.type === 'commitCurrent')      return this.commitCurrentBranch();
        if (msg.type === 'createBranch')       return this.createBranch();
        if (msg.type === 'openPr')             return this.openPr(msg.branch, { fromRemote: msg.fromRemote === true });
        if (msg.type === 'openBranchOnGithub') return this.openBranchOnGithub(msg.branch);

        // Actions tab
        if (msg.type === 'openUrl')            return vscode.env.openExternal(vscode.Uri.parse(msg.url));
        if (msg.type === 'openActionsOnGithub') return this.openActionsOnGithub();
        if (msg.type === 'viewLogs')           return this.viewLogs(msg.id, msg.displayTitle);
        if (msg.type === 'rerunRun')           return this.rerunRun(msg.id, msg.displayTitle);
        if (msg.type === 'cancelRun')          return this.cancelRun(msg.id, msg.displayTitle);
        if (msg.type === 'watchRun')           return this.watchRun(msg.id);
        if (msg.type === 'installGh')          return vscode.env.openExternal(vscode.Uri.parse('https://cli.github.com/'));

        // Self-update (footer)
        if (msg.type === 'checkForUpdates')    return this.checkForUpdates(true);
        if (msg.type === 'installUpdate')      return this.installUpdate();
        if (msg.type === 'openRepo')           return vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${UPDATE_REPO}`));
        if (msg.type === 'openRelease')        return this.openLatestRelease();
      } catch (err) {
        // Surface stderr + the cwd the command ran in, both as a toast and to
        // the Branch Explorer output channel. Without stderr in the toast,
        // git's most actionable failures (e.g. "src refspec X does not match
        // any" — which usually means "you're in the wrong repo for that
        // branch") never reach the user. The "Show Logs" button opens the
        // output channel so they can see the full sequence of git invocations.
        const usedCwd = (() => { try { return this.cwd(); } catch { return ''; } })();
        const stderr = (err && err.stderr) ? String(err.stderr).trim() : '';
        const baseMsg = (err && err.message) || String(err);
        const detailMsg = stderr ? `${baseMsg}\n${stderr}` : baseMsg;
        try {
          const ch = getOutputChannel();
          ch.appendLine(`[${new Date().toISOString()}] ✖ Handler error  (cwd: ${usedCwd || '<none>'})`);
          ch.appendLine(`  ${detailMsg}`);
        } catch { /* never throw out of error handling */ }
        const cwdHint = usedCwd ? `  ·  cwd: ${usedCwd}` : '';
        const action = await vscode.window.showErrorMessage(
          `Branch Explorer: ${baseMsg}${cwdHint}`,
          'Show Logs',
        );
        if (action === 'Show Logs') {
          try { getOutputChannel().show(true); } catch { /* no-op */ }
        }
      }
    });

    // When the user expands/collapses the view, re-render so the active tab
    // gets fresh data the moment it becomes visible. Also kick off a
    // background fetch if the last one was more than 60s ago, so the
    // ahead/behind counts are accurate the moment the panel comes back.
    if (view.onDidChangeVisibility) {
      view.onDidChangeVisibility(() => {
        if (!view.visible) return;
        this.refresh(true);
        if (Date.now() - this.lastFetchedAt > 60_000) this.backgroundFetch();
      });
    }

    this.refresh(true);

    // Trigger an initial background fetch as soon as the panel actually
    // mounts. The activate()-level setTimeout fires 3s after extension
    // startup, but `this.view` is undefined until the user opens the
    // panel — so that initial attempt silently skipped, leaving the
    // freshness pill stuck on "never fetched" for up to 90s until the
    // periodic timer caught up. Now opening the panel always primes a
    // fetch within a couple of seconds.
    setTimeout(() => { this.backgroundFetch(); }, 1_000);
  }

  switchTab(tab) {
    if (tab !== 'branches' && tab !== 'actions') return;
    if (this.activeTab === tab) return;
    this.activeTab = tab;
    this.refresh(true);
  }

  cwd() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    // If a specific repo was picked, honor it as long as it's still in the
    // workspace; otherwise clear the persisted selection and fall back to
    // the first folder. The persistence write here matches the pickRepo()
    // write so a stale selection (e.g. user removed the folder from the
    // workspace) doesn't keep being read back on every reload.
    if (this.selectedRepoPath) {
      const stillValid = folders.find((f) => f.uri.fsPath === this.selectedRepoPath);
      if (stillValid) return this.selectedRepoPath;
      this.selectedRepoPath = undefined;
      try { this.context.workspaceState.update(SELECTED_REPO_STATE_KEY, undefined); } catch { /* no-op */ }
    }
    return folders[0].uri.fsPath;
  }

  // True when the panel is showing a folder other than workspaceFolders[0].
  // Surfaced in the header so users can immediately tell they're operating
  // on a switched repo (and not the one the integrated terminal opens in
  // by default). This is the single most useful cue for the multi-repo
  // "wrong repo" class of mistake.
  isSwitchedRepo() {
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length < 2) return false;
    const active = this.cwd();
    return !!active && active !== folders[0].uri.fsPath;
  }

  // Folder name (NOT GitHub slug) for the currently active repo. Disambiguates
  // two clones of the same fork, two repos with similar slugs, or any case
  // where slug alone isn't enough to know which folder you're in.
  activeRepoFolderName() {
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 0) return '';
    const active = this.cwd();
    const match = folders.find((f) => f.uri.fsPath === active);
    return match ? match.name : (folders[0].name || '');
  }

  async listWorkspaceRepos() {
    const folders = vscode.workspace.workspaceFolders || [];
    const currentCwd = this.cwd();
    const results = await Promise.all(folders.map(async (folder) => {
      const path = folder.uri.fsPath;
      // Is this folder a git repo? If not, skip.
      const isRepo = await new Promise((resolve) => {
        execFile('git', ['rev-parse', '--git-dir'], { cwd: path }, (err) => resolve(!err));
      });
      if (!isRepo) return null;
      // Get origin URL → slug (may be empty if no remote configured).
      let slug = '';
      try {
        const out = await new Promise((resolve, reject) => {
          execFile('git', ['remote', 'get-url', 'origin'], { cwd: path }, (err, stdout) => err ? reject(err) : resolve(stdout));
        });
        slug = parseGithubSlug(out.trim());
      } catch { /* ignore — no origin remote */ }
      return { path, name: folder.name, slug, isActive: path === currentCwd };
    }));
    return results.filter(Boolean);
  }

  async pickRepo() {
    const repos = await this.listWorkspaceRepos();
    if (repos.length === 0) {
      vscode.window.showInformationMessage('No git repositories found in this workspace.');
      return;
    }
    if (repos.length === 1) {
      // Single repo — clicking the badge just opens it on GitHub.
      if (repos[0].slug) {
        vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${repos[0].slug}`));
      } else {
        vscode.window.showInformationMessage(`'${repos[0].name}' has no GitHub remote configured.`);
      }
      return;
    }
    // Multi-repo workspace: build a picker with three actions per repo —
    // switch the panel, open a terminal in that repo's folder, or open it
    // on GitHub. The terminal action is the killer one for multi-repo
    // workflows: it kills the "I switched the panel but my terminal is
    // still in the wrong folder" class of mistake.
    const switchItems = repos.map((r) => ({
      label: `${r.isActive ? '$(check) ' : '   '}${r.name}`,
      description: r.slug ? `github.com/${r.slug}` : '(no GitHub remote)',
      detail: r.isActive ? 'Currently viewing in the Branches panel' : 'Switch the Branches panel to view this repo',
      repo: r,
      kind: 'switch',
    }));
    const terminalItems = repos.map((r) => ({
      label: `$(terminal) Open terminal in ${r.name}`,
      description: r.path,
      detail: 'Spawns an integrated terminal cwd\u2019d to this repo\u2019s folder',
      repo: r,
      kind: 'terminal',
    }));
    const openItems = repos.filter((r) => r.slug).map((r) => ({
      label: `$(link-external) Open ${r.name} on GitHub`,
      description: `github.com/${r.slug}`,
      repo: r,
      kind: 'open',
    }));
    const items = [
      { label: 'Switch panel to…', kind: vscode.QuickPickItemKind.Separator },
      ...switchItems,
      { label: 'Open terminal in…', kind: vscode.QuickPickItemKind.Separator },
      ...terminalItems,
      { label: 'Open on GitHub', kind: vscode.QuickPickItemKind.Separator },
      ...openItems,
    ];
    const choice = await vscode.window.showQuickPick(items, {
      title: `Workspace repositories (${repos.length})`,
      placeHolder: 'Pick a repo to view in the panel, open a terminal in it, or open it on GitHub',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!choice || !choice.repo) return;
    if (choice.kind === 'open') {
      vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${choice.repo.slug}`));
      return;
    }
    if (choice.kind === 'terminal') {
      const term = vscode.window.createTerminal({
        name: `${choice.repo.name} (Branch Explorer)`,
        cwd: choice.repo.path,
      });
      term.show();
      return;
    }
    // Switch panel — persist the selection so it survives extension host
    // reloads and panel re-mounts. Without persistence, the selection
    // resets to workspaceFolders[0] silently, which is the root cause of
    // the "I switched but the publish went to the wrong repo" bug.
    this.selectedRepoPath = choice.repo.path;
    try { this.context.workspaceState.update(SELECTED_REPO_STATE_KEY, choice.repo.path); } catch { /* no-op */ }
    try { getOutputChannel().appendLine(`[${new Date().toISOString()}] panel switched to: ${choice.repo.name}  (${choice.repo.path})`); } catch { /* no-op */ }
    vscode.window.setStatusBarMessage(`Branch Explorer: viewing ${choice.repo.name}`, 4000);
    this.refresh(true);
  }

  git(args) {
    const cwd = this.cwd();
    if (!cwd) return Promise.reject(new Error('No workspace folder open.'));
    logExec('git', args, cwd);
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          err.cwd = cwd;
          logExecError('git', args, cwd, err);
          return reject(err);
        }
        resolve(stdout);
      });
    });
  }

  async collectState() {
    const cwd = this.cwd();
    if (!cwd) return { error: 'No workspace folder open.' };

    try {
      await this.git(['rev-parse', '--git-dir']);
    } catch {
      return { error: 'Current workspace is not a git repository.' };
    }

    const [currentBranch, branchListRaw, remoteListRaw, stashCountRaw, repoOriginRaw, defaultRefRaw, statusRaw] = await Promise.all([
      this.git(['rev-parse', '--abbrev-ref', 'HEAD']).then((s) => s.trim()).catch(() => 'HEAD'),
      this.git([
        'for-each-ref',
        // committerdate:relative ("3 weeks ago") is for display.
        // committerdate:unix is for sorting — relative strings can't be
        // ordered reliably, and we need most-recent-first on the panel.
        '--format=%(refname:short)%00%(upstream:short)%00%(upstream:track)%00%(objectname:short)%00%(committerdate:relative)%00%(authorname)%00%(subject)%00%(committerdate:unix)',
        'refs/heads/',
      ]),
      this.git([
        'for-each-ref',
        '--format=%(refname:short)%00%(objectname:short)%00%(committerdate:relative)%00%(authorname)%00%(subject)%00%(committerdate:unix)',
        'refs/remotes/origin/',
      ]).catch(() => ''),
      this.git(['stash', 'list']).catch(() => ''),
      this.git(['remote', 'get-url', 'origin']).then((s) => s.trim()).catch(() => ''),
      // refs/remotes/origin/HEAD → e.g. 'origin/main' → strip prefix to get the
      // remote's default branch name. May fail (no remote / HEAD not set), in
      // which case we fall through to the ALWAYS_PROTECTED_BRANCHES list.
      this.git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).then((s) => s.trim()).catch(() => ''),
      // Working-tree status drives the "uncommitted changes" badge + Commit
      // button on the current-branch row. `--porcelain=v1 -uall` gives a
      // stable two-column format that includes every untracked file
      // individually (not just folders), which is what we want for the count.
      this.git(['status', '--porcelain=v1', '--untracked-files=all']).catch(() => ''),
    ]);
    const workingTree = parseGitStatus(statusRaw);
    const defaultBranch = defaultRefRaw.startsWith('origin/') ? defaultRefRaw.substring('origin/'.length) : '';

    const stashCount = stashCountRaw ? stashCountRaw.trim().split('\n').filter(Boolean).length : 0;
    const repoSlug = parseGithubSlug(repoOriginRaw);

    const branches = branchListRaw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, upstream, track, sha, when, author, subject, whenTsRaw] = line.split('\u0000');
        return {
          name,
          upstream: upstream || null,
          ahead: parseAhead(track),
          behind: parseBehind(track),
          gone: track === '[gone]',
          noUpstream: !upstream,
          sha,
          when,
          whenTs: parseInt(whenTsRaw, 10) || 0,
          author,
          subject,
          current: name === currentBranch,
          protected: isProtectedBranch(name, defaultBranch),
          isDefault: defaultBranch ? name === defaultBranch : false,
        };
      });

    // Sort: current branch always pinned to the top, then by most-recent
    // committerdate descending so the work you actually touched lately is
    // right under your cursor. Fall back to name for branches with no
    // committerdate (shouldn't happen, but defensive).
    branches.sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      if (b.whenTs !== a.whenTs) return b.whenTs - a.whenTs;
      return a.name.localeCompare(b.name);
    });

    // For local-only branches (no upstream tracking branch on GitHub), there's
    // nothing to compare against on the push side — but the user almost always
    // wants to know "how much work is on this branch that isn't on main yet"
    // (i.e. what would end up in the PR if they published). Compute the
    // ahead/behind count vs the repo's default remote branch so we can render
    // it next to the "local only" pill. One git call per local-only branch;
    // there are usually just a handful, so the total cost is negligible.
    if (defaultRefRaw) {
      const localOnly = branches.filter((b) => b.noUpstream);
      const diffs = await Promise.all(
        localOnly.map((b) =>
          this.git(['rev-list', '--left-right', '--count', `${b.name}...${defaultRefRaw}`])
            .then((s) => {
              const [ahead, behind] = s.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
              return { ahead, behind };
            })
            // Don't blow up the whole panel if a single rev-list fails (e.g.
            // the default ref hasn't been fetched yet, or some other quirk).
            .catch(() => null),
        ),
      );
      localOnly.forEach((b, i) => {
        if (diffs[i]) {
          b.aheadVsDefault = diffs[i].ahead;
          b.behindVsDefault = diffs[i].behind;
        }
      });
    }

    const localNames = new Set(branches.map((b) => b.name));
    const remoteOnly = remoteListRaw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [refnameShort, sha, when, author, subject, whenTsRaw] = line.split('\u0000');
        // Only treat refs that strictly start with 'origin/' as branches.
        // Note: git renders 'refs/remotes/origin/HEAD' (the symbolic default-branch
        // pointer) with short name 'origin' (no slash) — so requiring 'origin/'
        // here filters it out cleanly along with any other oddly-named ref.
        const prefix = 'origin/';
        if (!refnameShort || !refnameShort.startsWith(prefix)) return null;
        const name = refnameShort.substring(prefix.length);
        return { name, refnameShort, sha, when, whenTs: parseInt(whenTsRaw, 10) || 0, author, subject };
      })
      .filter((b) => b && b.name && b.name !== 'HEAD' && !localNames.has(b.name))
      .sort((a, b) => {
        if (b.whenTs !== a.whenTs) return b.whenTs - a.whenTs;
        return a.name.localeCompare(b.name);
      });

    // For remote-only branches, show "how far ahead/behind of main" so users
    // can scan the list and immediately tell which branches are large open PRs
    // vs trivial ones. Same calculation as for local-only branches above —
    // compare against the default remote ref. Skip if defaultRef isn't known
    // (no origin/HEAD set).
    if (defaultRefRaw) {
      const remoteDiffs = await Promise.all(
        remoteOnly.map((b) =>
          this.git(['rev-list', '--left-right', '--count', `${b.refnameShort}...${defaultRefRaw}`])
            .then((s) => {
              const [ahead, behind] = s.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
              return { ahead, behind };
            })
            .catch(() => null),
        ),
      );
      remoteOnly.forEach((b, i) => {
        if (remoteDiffs[i]) {
          b.aheadVsDefault = remoteDiffs[i].ahead;
          b.behindVsDefault = remoteDiffs[i].behind;
        }
      });
    }

    const workspaceFolderCount = (vscode.workspace.workspaceFolders || []).length;
    const folderName = this.activeRepoFolderName();
    const switched = this.isSwitchedRepo();
    return {
      currentBranch, branches, remoteOnly, stashCount, repoSlug,
      workspaceFolderCount, defaultBranch, workingTree,
      folderName, switched,
      lastFetchedAt: this.lastFetchedAt,
      backgroundFetching: this.backgroundFetching,
    };
  }

  async refresh(force = false, opts = {}) {
    if (!this.view) return;
    // Skip refreshes when the panel isn't visible AND it's not user-initiated.
    // This avoids gratuitous git/gh calls when the user has the view hidden.
    if (!force && this.view.visible === false) return;

    const footerOnly = opts.footerOnly === true;
    const wsCount = (vscode.workspace.workspaceFolders || []).length;

    const update = {
      currentVersion: this.currentVersion,
      updateInfo: this.updateInfo,
      updateChecking: this.updateChecking,
      updateInstalling: this.updateInstalling,
      updateError: this.updateError,
      updateAvailable: !!(this.updateInfo && compareSemver(this.updateInfo.version, this.currentVersion) > 0),
      repoUrl: `https://github.com/${UPDATE_REPO}`,
    };

    // Computed once for both tabs so the header is consistent regardless
    // of which one is active. activeRepoFolderName / isSwitchedRepo read
    // straight off this.cwd() / workspaceFolders, so the values reflect the
    // *current* selection (not whatever the last collectState saw).
    const sharedFolderName = this.activeRepoFolderName();
    const sharedSwitched = this.isSwitchedRepo();

    if (this.activeTab === 'actions') {
      let actionsState;
      if (footerOnly && this.actionsLastState) {
        actionsState = this.actionsLastState;
      } else {
        const fresh = await this.collectActionsState();
        if (fresh && !fresh.error) this.actionsLastState = fresh;
        actionsState = (fresh && fresh.error && this.actionsLastState)
          ? { ...this.actionsLastState, warning: fresh.message || fresh.error }
          : fresh;
      }
      this.view.webview.html = renderCombinedHtml({
        activeTab: 'actions',
        shared: {
          repoSlug: (actionsState && actionsState.repoSlug) || '',
          workspaceFolderCount: wsCount,
          currentBranch: (actionsState && actionsState.currentBranch) || '',
          folderName: sharedFolderName,
          switched: sharedSwitched,
          update,
        },
        actionsState,
      }, this.view.webview, this.context);
      return;
    }

    let branchesState;
    if (footerOnly && this.branchesLastState) {
      branchesState = this.branchesLastState;
    } else {
      branchesState = await this.collectState();
      if (branchesState && !branchesState.error) this.branchesLastState = branchesState;
    }
    this.view.webview.html = renderCombinedHtml({
      activeTab: 'branches',
      shared: {
        repoSlug: (branchesState && branchesState.repoSlug) || '',
        workspaceFolderCount: (branchesState && branchesState.workspaceFolderCount) || wsCount,
        currentBranch: (branchesState && branchesState.currentBranch) || '',
        folderName: (branchesState && branchesState.folderName) || sharedFolderName,
        switched: (branchesState && branchesState.switched !== undefined) ? branchesState.switched : sharedSwitched,
        update,
      },
      branchesState,
    }, this.view.webview, this.context);
  }

  // ─── GitHub Actions tab — gh CLI helpers + state ───────────────────────

  ghBin() {
    const cfg = vscode.workspace.getConfiguration('branchExplorer');
    return cfg.get('ghBinary', 'gh');
  }

  exec(cmd, args, opts = {}) {
    const cwd = (opts && opts.cwd) || '';
    logExec(cmd, args, cwd);
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          err.cwd = cwd;
          logExecError(cmd, args, cwd, err);
          return reject(err);
        }
        resolve(stdout);
      });
    });
  }

  // Binary-safe download helper. Streams a command's stdout straight to disk
  // via spawn (no maxBuffer cap, no UTF-8 reinterpretation). Required for
  // .vsix downloads — `gh api` returns raw octet-stream bytes; capturing them
  // through execFile's stdout string would corrupt the zip and the install
  // would fail with "is not a valid zip file". stderr is buffered so we can
  // surface a useful message if the request itself fails.
  execToFile(cmd, args, filePath, opts = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, opts);
      const out = fsSync.createWriteStream(filePath);
      let stderr = '';
      child.stdout.pipe(out);
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (err) => {
        out.destroy();
        err.stderr = stderr;
        reject(err);
      });
      child.on('close', (code) => {
        out.end(() => {
          if (code === 0) return resolve();
          const err = new Error(`${cmd} exited with code ${code}`);
          err.stderr = stderr;
          reject(err);
        });
      });
    });
  }

  async hasGh() {
    try { await this.exec(this.ghBin(), ['--version']); return true; } catch { return false; }
  }

  async ghAuthOk(cwd) {
    try { await this.exec(this.ghBin(), ['auth', 'status'], { cwd }); return true; } catch { return false; }
  }

  async getCurrentBranchSafe(cwd) {
    try { const out = await this.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }); return out.trim(); }
    catch { return ''; }
  }

  async getRepoSlugSafe(cwd) {
    try { const out = await this.exec('git', ['remote', 'get-url', 'origin'], { cwd }); return parseGithubSlug(out.trim()); }
    catch { return ''; }
  }

  async collectActionsState() {
    const cwd = this.cwd();
    if (!cwd) return { error: 'No workspace folder open.' };
    if (!await this.hasGh()) {
      return {
        error: 'gh',
        errorKind: 'gh-missing',
        message: 'The GitHub CLI (gh) is required to load workflow runs.',
      };
    }
    const [authOk, currentBranch, repoSlug] = await Promise.all([
      this.ghAuthOk(cwd),
      this.getCurrentBranchSafe(cwd),
      this.getRepoSlugSafe(cwd),
    ]);
    if (!authOk) {
      return {
        error: 'gh-auth',
        errorKind: 'gh-auth',
        message: 'gh is installed but not authenticated. Run `gh auth login` in a terminal.',
      };
    }
    if (!repoSlug) {
      return { error: 'No GitHub remote configured on origin.' };
    }

    const args = [
      'run', 'list',
      '--limit', '30',
      '--json',
      'status,conclusion,name,headBranch,event,createdAt,updatedAt,databaseId,workflowName,displayTitle,url,headSha,attempt,startedAt',
    ];
    let runs = [];
    try {
      const stdout = await this.exec(this.ghBin(), args, { cwd });
      runs = JSON.parse(stdout || '[]');
    } catch (err) {
      return { error: `Failed to load workflow runs: ${(err.stderr || err.message || err).toString().trim()}` };
    }
    return { runs, currentBranch, repoSlug };
  }

  async openActionsOnGithub() {
    const cwd = this.cwd();
    const slug = await this.getRepoSlugSafe(cwd);
    if (!slug) { vscode.window.showWarningMessage('No GitHub remote configured.'); return; }
    vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${slug}/actions`));
  }

  viewLogs(id /*, displayTitle */) {
    const cwd = this.cwd();
    const term = vscode.window.createTerminal({ name: `gh logs ${id}`, cwd });
    term.sendText(`${this.ghBin()} run view ${id} --log`, true);
    term.show();
  }

  watchRun(id) {
    const cwd = this.cwd();
    const term = vscode.window.createTerminal({ name: `gh watch ${id}`, cwd });
    term.sendText(`${this.ghBin()} run watch ${id}`, true);
    term.show();
  }

  async rerunRun(id, displayTitle) {
    const choice = await vscode.window.showWarningMessage(
      `Re-run workflow run #${id}?`,
      { modal: true, detail: displayTitle ? `"${displayTitle}"` : undefined },
      'Re-run failed jobs', 'Re-run all jobs',
    );
    if (!choice) return;
    const args = ['run', 'rerun', String(id)];
    if (choice === 'Re-run failed jobs') args.push('--failed');
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `gh run rerun ${id}` },
      async () => { await this.exec(this.ghBin(), args, { cwd: this.cwd() }); },
    );
    this.refresh(true);
  }

  async cancelRun(id, displayTitle) {
    const choice = await vscode.window.showWarningMessage(
      `Cancel workflow run #${id}?`,
      { modal: true, detail: displayTitle ? `"${displayTitle}"` : undefined },
      'Cancel run',
    );
    if (choice !== 'Cancel run') return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `gh run cancel ${id}` },
      async () => { await this.exec(this.ghBin(), ['run', 'cancel', String(id)], { cwd: this.cwd() }); },
    );
    this.refresh(true);
  }

  // ─── Self-update — checking, downloading, installing ────────────────────

  async checkForUpdates(force = false) {
    // Throttle: don't hammer the API. The check is cheap but the gh process
    // spawn isn't, so respect a 5-minute floor between calls.
    const now = Date.now();
    if (!force && (now - this.updateCheckedAt) < UPDATE_CHECK_MIN_INTERVAL_MS) return;
    if (this.updateChecking) return;

    let toastForVersion = null;
    let manualOutcome = null; // feedback when the user clicked "check"

    const runCheck = async () => {
      this.updateChecking = true;
      this.updateError = null;
      this.refreshFooterOnly();

      try {
        if (!await this.hasGh()) {
          this.updateError = 'gh CLI not installed — cannot check for updates';
          if (force) manualOutcome = 'noGh';
          return;
        }
        const json = await this.exec(this.ghBin(), [
          'api',
          '-H', 'Accept: application/vnd.github+json',
          `repos/${UPDATE_REPO}/releases/latest`,
        ]);
        const release = JSON.parse(json || '{}');
        const tagName = release.tag_name || '';
        const version = tagName.replace(/^v/i, '');
        const asset = (release.assets || []).find((a) => a.name && a.name.endsWith('.vsix'));
        this.updateInfo = {
          tagName,
          version,
          body: release.body || '',
          htmlUrl: release.html_url || `https://github.com/${UPDATE_REPO}/releases`,
          assetApiPath: asset ? asset.url.replace('https://api.github.com/', '') : null,
          assetName: asset ? asset.name : null,
          publishedAt: release.published_at || null,
        };
        this.updateCheckedAt = Date.now();

        if (compareSemver(version, this.currentVersion) > 0) {
          if (this.updateToastShownFor !== version) toastForVersion = version;
          if (force) manualOutcome = 'updateAvailable';
        } else if (force) {
          manualOutcome = 'upToDate';
        }
      } catch (err) {
        const stderr = (err && err.stderr) ? err.stderr.toString().trim() : '';
        if (/HTTP 404|Not Found/i.test(stderr)) {
          this.updateInfo = null;
          this.updateError = null;
          this.updateCheckedAt = Date.now();
          if (force) manualOutcome = 'noReleases';
        } else {
          this.updateError = stderr || (err && err.message) || String(err);
          if (force) manualOutcome = 'error';
        }
      } finally {
        this.updateChecking = false;
        this.refreshFooterOnly();
      }
    };

    if (force) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Checking for Branch Explorer updates…' },
        runCheck,
      );
    } else {
      await runCheck();
    }

    if (toastForVersion) {
      this.updateToastShownFor = toastForVersion;
      const choice = await vscode.window.showInformationMessage(
        `Branch Explorer ${this.updateInfo.tagName} is available (you have v${this.currentVersion}).`,
        'Install', 'View release', 'Later',
      );
      if (choice === 'Install') return this.installUpdate();
      if (choice === 'View release') return this.openLatestRelease();
      return;
    }

    if (!force || !manualOutcome || manualOutcome === 'updateAvailable') return;

    if (manualOutcome === 'noGh') {
      const choice = await vscode.window.showErrorMessage(
        `Branch Explorer: ${this.updateError}`,
        'Install gh',
      );
      if (choice === 'Install gh') {
        vscode.env.openExternal(vscode.Uri.parse('https://cli.github.com/'));
      }
      return;
    }
    if (manualOutcome === 'noReleases') {
      const choice = await vscode.window.showInformationMessage(
        `No releases published yet on github.com/${UPDATE_REPO}. You're on v${this.currentVersion} — publish a release with a .vsix to enable self-updates.`,
        'Open repo',
      );
      if (choice === 'Open repo') {
        vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${UPDATE_REPO}`));
      }
      return;
    }
    if (manualOutcome === 'error') {
      const choice = await vscode.window.showErrorMessage(
        `Branch Explorer update check failed: ${this.updateError}`,
        'Show Logs',
      );
      if (choice === 'Show Logs') {
        try { getOutputChannel().show(true); } catch { /* no-op */ }
      }
      return;
    }
    if (manualOutcome === 'upToDate') {
      vscode.window.showInformationMessage(
        `Branch Explorer is up to date (v${this.currentVersion}${this.updateInfo && this.updateInfo.tagName ? ` — latest release is ${this.updateInfo.tagName}` : ''}).`,
      );
    }
  }

  async installUpdate() {
    if (this.updateInstalling) return;
    if (!this.updateInfo) {
      vscode.window.showInformationMessage('No update info yet — checking now…');
      await this.checkForUpdates(true);
      if (!this.updateInfo) return;
    }
    if (compareSemver(this.updateInfo.version, this.currentVersion) <= 0) {
      vscode.window.showInformationMessage(`Already on the latest version (v${this.currentVersion}).`);
      return;
    }
    if (!this.updateInfo.assetApiPath) {
      // Release exists but has no .vsix attached — point user at the release
      // page so they can grab whatever artifacts are there manually.
      const choice = await vscode.window.showWarningMessage(
        `${this.updateInfo.tagName} doesn't have a .vsix asset attached. Open the release page on GitHub to install manually?`,
        'Open release', 'Cancel',
      );
      if (choice === 'Open release') vscode.env.openExternal(vscode.Uri.parse(this.updateInfo.htmlUrl));
      return;
    }

    const notes = (this.updateInfo.body || '').trim();
    const trimmedNotes = notes.length > 600 ? notes.slice(0, 600) + '\n…' : notes;
    const choice = await vscode.window.showInformationMessage(
      `Install Branch Explorer ${this.updateInfo.tagName}? (you have v${this.currentVersion})`,
      { modal: true, detail: trimmedNotes || 'No release notes provided.' },
      'Install',
    );
    if (choice !== 'Install') return;

    this.updateInstalling = true;
    this.refreshFooterOnly();
    let success = false;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Installing Branch Explorer ${this.updateInfo.tagName}…` },
        async (progress) => {
          progress.report({ message: 'Downloading from GitHub…' });
          const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'branch-explorer-update-'));
          const vsixPath = path.join(tmpDir, this.updateInfo.assetName);
          // gh handles the Accept: octet-stream + auth + redirect to S3.
          // gh api has no --output flag and always streams the raw bytes to
          // stdout, so we pipe stdout directly to disk (binary-safe; capturing
          // a .vsix as a JS string via execFile would corrupt the zip).
          await this.execToFile(
            this.ghBin(),
            [
              'api',
              '-H', 'Accept: application/octet-stream',
              this.updateInfo.assetApiPath,
            ],
            vsixPath,
          );
          progress.report({ message: 'Installing in Cursor…' });
          await this.installVsix(vsixPath);
        },
      );
      success = true;
    } catch (err) {
      const detail = (err && err.stderr) ? err.stderr.toString().trim() : (err && err.message) || String(err);
      vscode.window.showErrorMessage(`Update failed: ${detail}`);
    } finally {
      this.updateInstalling = false;
      this.refreshFooterOnly();
    }

    if (success) {
      const reload = await vscode.window.showInformationMessage(
        `Branch Explorer updated to ${this.updateInfo.tagName}. Reload Cursor to activate.`,
        'Reload now', 'Later',
      );
      if (reload === 'Reload now') vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }

  async installVsix(vsixPath) {
    // Prefer the built-in command (cross-platform, no need to know binary
    // location). Fall back to the Cursor CLI if that command isn't available
    // in the current host (e.g. older builds).
    try {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsixPath));
      return;
    } catch { /* fall through to CLI */ }

    // CLI fallback — derive the cursor binary from vscode.env.appRoot.
    const isWin = process.platform === 'win32';
    const candidates = [
      path.join(vscode.env.appRoot, 'bin', isWin ? 'cursor.cmd' : 'cursor'),
      isWin ? 'cursor.cmd' : 'cursor', // assume PATH
    ];
    let lastErr;
    for (const bin of candidates) {
      try {
        await this.exec(bin, ['--install-extension', vsixPath, '--force']);
        return;
      } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error('Could not install VSIX via VS Code command or Cursor CLI');
  }

  async openLatestRelease() {
    if (!this.updateInfo) await this.checkForUpdates(true);
    const url = (this.updateInfo && this.updateInfo.htmlUrl) || `https://github.com/${UPDATE_REPO}/releases`;
    vscode.env.openExternal(vscode.Uri.parse(url));
  }

  // ─── Download stats ────────────────────────────────────────────────────
  // Fetches per-release .vsix download_count from the GitHub Releases API
  // and dumps a formatted report into an output channel. Same numbers as
  // ./scripts/downloads.sh and DOWNLOADS.md — single source of truth.
  async showDownloadStats() {
    if (!await this.hasGh()) {
      vscode.window.showErrorMessage('gh CLI not installed — cannot fetch download stats.');
      return;
    }
    if (!this.downloadStatsChannel) {
      this.downloadStatsChannel = vscode.window.createOutputChannel('Branch Explorer · Downloads');
    }
    const ch = this.downloadStatsChannel;
    ch.clear();
    ch.show(true);
    ch.appendLine(`Branch Explorer · download stats`);
    ch.appendLine(`  repo: ${UPDATE_REPO}`);
    ch.appendLine(`  fetching from gh api repos/${UPDATE_REPO}/releases …`);
    ch.appendLine('');

    let releases;
    try {
      const json = await this.exec(this.ghBin(), [
        'api', '--paginate',
        '-H', 'Accept: application/vnd.github+json',
        `repos/${UPDATE_REPO}/releases`,
      ]);
      // --paginate concatenates JSON arrays without a top-level join.
      // Wrap in [] and split on `][` defensively.
      const merged = json.trim().replace(/\]\s*\[/g, ',');
      releases = JSON.parse(merged || '[]');
    } catch (err) {
      const detail = (err && err.stderr) ? err.stderr.toString().trim() : (err && err.message) || String(err);
      ch.appendLine(`ERROR: ${detail}`);
      vscode.window.showErrorMessage(`Couldn't fetch download stats: ${detail}`);
      return;
    }

    if (!Array.isArray(releases) || releases.length === 0) {
      ch.appendLine('No releases found.');
      return;
    }

    let total = 0;
    const rows = releases.map((r) => {
      const tag = r.tag_name || '';
      const assets = (r.assets || []).filter((a) => a.name && a.name.endsWith('.vsix'));
      const downloads = assets.reduce((acc, a) => acc + (a.download_count || 0), 0);
      total += downloads;
      const published = r.published_at ? new Date(r.published_at).toISOString().slice(0, 10) : '';
      return { tag, published, downloads, assets };
    });

    const latest = rows[0] ? rows[0].tag : '—';
    ch.appendLine(`  total:    ${total} downloads`);
    ch.appendLine(`  releases: ${rows.length}`);
    ch.appendLine(`  latest:   ${latest}`);
    ch.appendLine('');
    ch.appendLine(`  ${'RELEASE'.padEnd(12)} ${'PUBLISHED'.padEnd(12)} DOWNLOADS`);
    ch.appendLine(`  ${'-------'.padEnd(12)} ${'---------'.padEnd(12)} ---------`);
    for (const r of rows) {
      ch.appendLine(`  ${r.tag.padEnd(12)} ${r.published.padEnd(12)} ${r.downloads}`);
    }
    ch.appendLine('');
    ch.appendLine(`(Counts come from GitHub's release asset download_count, which`);
    ch.appendLine(` increments on every direct download AND every self-update install.)`);

    // Also offer a one-click peek at the auto-generated markdown summary.
    const choice = await vscode.window.showInformationMessage(
      `Branch Explorer: ${total} total downloads across ${rows.length} release(s).`,
      'View DOWNLOADS.md', 'Open Releases',
    );
    if (choice === 'View DOWNLOADS.md') {
      vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${UPDATE_REPO}/blob/main/DOWNLOADS.md`));
    } else if (choice === 'Open Releases') {
      vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${UPDATE_REPO}/releases`));
    }
  }

  refreshFooterOnly() {
    // Footer state is rendered as part of the full HTML. Re-render without
    // re-collecting branch/action state so update-check clicks stay snappy
    // even on repos with huge dirty working trees.
    this.refresh(true, { footerOnly: true });
  }

  async fetchAll() {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'git fetch --all --prune' },
      async () => {
        await this.git(['fetch', '--all', '--prune']);
      },
    );
    this.lastFetchedAt = Date.now();
    this.refresh();
  }

  // Silent fetch — runs in the background so the panel's ahead/behind counts
  // stay fresh without the user having to click "Fetch from GitHub". No
  // toast, no progress notification. Safe to call repeatedly; we skip when
  // a fetch is already in flight, when there's no view yet, or when the
  // view is hidden (no point burning network for a panel nobody is looking
  // at). Updates `lastFetchedAt` on success so the UI can render freshness.
  async backgroundFetch() {
    if (this.backgroundFetching) return;
    if (!this.view) return;
    if (this.view.visible === false) return;
    if (!await this.isGitRepo()) return;
    this.backgroundFetching = true;
    try {
      await this.git(['fetch', '--all', '--prune']);
      this.lastFetchedAt = Date.now();
      this.refresh();
    } catch {
      // Network blip / offline / auth issue — silent on purpose. The user
      // can still click "Fetch from GitHub" to see the real error message.
    } finally {
      this.backgroundFetching = false;
    }
  }

  async pull() {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'git pull --ff-only' },
      async () => {
        await this.git(['pull', '--ff-only']);
      },
    );
    this.refresh();
  }

  async push() {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'git push' },
      async () => {
        await this.git(['push']);
      },
    );
    this.refresh();
  }

  async checkout(branch) {
    await this.git(['checkout', branch]);
    this.refresh();
  }

  // Prompt for a name, optionally pick a base branch, then create + switch.
  async createBranch() {
    const state = await this.collectState();
    if (state.error) {
      vscode.window.showErrorMessage(state.error);
      return;
    }

    const existingNames = new Set([
      ...(state.branches || []).map((b) => b.name),
      ...(state.remoteOnly || []).map((b) => b.name),
    ]);

    const branchName = await vscode.window.showInputBox({
      title: 'Create new branch',
      prompt: `Currently on '${state.currentBranch}'. You'll be switched to the new branch when it's created.`,
      placeHolder: 'e.g. feature/my-change',
      ignoreFocusOut: true,
      validateInput: (v) => {
        const name = (v || '').trim();
        const err = validateBranchName(name);
        if (err) return err;
        if (existingNames.has(name)) return `Branch '${name}' already exists locally or on GitHub.`;
        return null;
      },
    });
    if (!branchName) return;
    const name = branchName.trim();

    const current = state.currentBranch;
    const defaultBranch = state.defaultBranch || 'main';
    const baseItems = [
      {
        label: current,
        description: 'Current branch',
        detail: 'Create from where you are now',
        base: current,
      },
    ];
    if (defaultBranch && defaultBranch !== current) {
      baseItems.push({
        label: defaultBranch,
        description: 'Default branch',
        detail: 'Create from the repo default branch',
        base: defaultBranch,
      });
    }
    for (const b of (state.branches || [])) {
      if (b.name === current || b.name === defaultBranch) continue;
      baseItems.push({ label: b.name, description: 'Local branch', base: b.name });
    }

    let base = current;
    if (baseItems.length > 1) {
      const choice = await vscode.window.showQuickPick(baseItems, {
        title: `Create '${name}' from which branch?`,
        placeHolder: `Default: ${current}`,
      });
      if (!choice) return;
      base = choice.base;
    }

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Creating branch '${name}'…` },
        async () => {
          if (base === current) {
            await this.git(['checkout', '-b', name]);
          } else {
            await this.git(['checkout', '-b', name, base]);
          }
        },
      );
      vscode.window.showInformationMessage(`✓ Created and switched to '${name}' (from '${base}').`);
    } catch (err) {
      throw err;
    }
    this.refresh();
  }

  async deleteBranch(branch, force) {
    // Defense-in-depth: even though the delete button is hidden in the UI for
    // protected branches, refuse here too in case a stale webview tries it
    // (or someone wires up the command directly).
    const state = await this.collectState();
    if (state && !state.error && isProtectedBranch(branch, state.defaultBranch)) {
      vscode.window.showWarningMessage(
        `'${branch}' is a protected branch (default branch of the repo). Deletion is disabled.`,
      );
      return;
    }

    const flag = force ? '-D' : '-d';
    try {
      await this.git(['branch', flag, branch]);
    } catch (err) {
      if (!force && err.stderr && err.stderr.includes('not fully merged')) {
        const choice = await vscode.window.showWarningMessage(
          `Branch '${branch}' is not fully merged. Force delete?`,
          { modal: true },
          'Force delete',
        );
        if (choice === 'Force delete') {
          await this.git(['branch', '-D', branch]);
        } else {
          return;
        }
      } else {
        throw err;
      }
    }
    this.refresh();
  }

  async pullBranch(branch) {
    const state = await this.collectState();
    const b = state.branches && state.branches.find((x) => x.name === branch);
    if (!b) throw new Error(`Branch '${branch}' not found.`);
    if (b.gone) {
      vscode.window.showWarningMessage(`Cannot pull '${branch}' — its remote branch on GitHub no longer exists.`);
      return;
    }
    if (!b.upstream) {
      vscode.window.showWarningMessage(`Branch '${branch}' has no upstream to pull from. Use Publish first.`);
      return;
    }
    if (b.ahead > 0 && b.behind > 0) {
      const choice = await vscode.window.showWarningMessage(
        `'${branch}' has diverged from GitHub (${b.ahead} ahead, ${b.behind} behind). A pull cannot fast-forward.`,
        { modal: true, detail: 'Switch to this branch and manually rebase or merge to resolve.' },
        'Checkout it',
      );
      if (choice === 'Checkout it') {
        await this.checkout(branch);
      }
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `git pull (ff-only) ${branch}` },
      async () => {
        if (b.current) {
          await this.git(['pull', '--ff-only']);
        } else {
          // Fast-forward the local ref from its upstream without checkout.
          // Refspec: <upstream>:<local-branch>
          await this.git(['fetch', 'origin', `${b.upstream.replace(/^origin\//, '')}:${branch}`]);
        }
      },
    );
    this.refresh();
  }

  async pushBranch(branch) {
    const state = await this.collectState();
    const b = state.branches && state.branches.find((x) => x.name === branch);
    if (!b) throw new Error(`Branch '${branch}' not found.`);
    if (b.gone) {
      const choice = await vscode.window.showWarningMessage(
        `Branch '${branch}' is marked 'gone' — its remote was deleted. Recreate it on GitHub by pushing?`,
        { modal: true },
        'Push and recreate',
      );
      if (choice !== 'Push and recreate') return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `git push origin ${branch}` },
      async () => {
        await this.git(['push', 'origin', branch]);
      },
    );
    this.refresh();
  }

  async publishBranch(branch) {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `git push -u origin ${branch}` },
      async () => {
        await this.git(['push', '-u', 'origin', branch]);
      },
    );
    this.refresh();
  }

  // One-button "stage everything + commit" flow for the current branch. The
  // panel only shows the Commit button when the working tree is dirty, but
  // we re-check here so a keybinding invocation also behaves correctly when
  // the panel state is stale. Pre-commit hook stderr is surfaced verbatim so
  // the user can see exactly what blocked the commit (lint errors, secrets,
  // formatting, etc.).
  async commitCurrentBranch() {
    const state = await this.collectState();
    if (state.error) {
      vscode.window.showErrorMessage(state.error);
      return;
    }
    const wt = state.workingTree;
    if (!wt || wt.total === 0) {
      vscode.window.showInformationMessage(`Nothing to commit on '${state.currentBranch}' — working tree is clean.`);
      return;
    }
    if (wt.conflicts > 0) {
      vscode.window.showErrorMessage(
        `Cannot commit: ${wt.conflicts} unresolved conflict${wt.conflicts === 1 ? '' : 's'}. Resolve them first (VS Code Source Control panel handles merge UI).`,
      );
      return;
    }

    const parts = [];
    if (wt.staged > 0)    parts.push(`${wt.staged} staged`);
    if (wt.modified > 0)  parts.push(`${wt.modified} modified`);
    if (wt.untracked > 0) parts.push(`${wt.untracked} untracked`);
    const summary = parts.join(' · ');

    // Pre-fill a sensible default so hitting Enter immediately becomes a
    // valid one-keystroke commit. The whole default is selected so the user
    // can either accept it (Enter), edit it (arrow keys), or replace it
    // entirely just by typing. Single-file commits get a path-specific
    // message; multi-file commits get a count.
    const defaultMsg = wt.total === 1
      ? `wip: ${wt.files[0].path.split('/').pop() || wt.files[0].path}`
      : `wip: ${wt.total} changes`;

    const message = await vscode.window.showInputBox({
      title: `Commit ${wt.total} change${wt.total === 1 ? '' : 's'} on '${state.currentBranch}'`,
      prompt: `Will run: git add -A && git commit -m "<your message>"   (${summary}) — Enter to accept default, or type to replace`,
      placeHolder: defaultMsg,
      value: defaultMsg,
      valueSelection: [0, defaultMsg.length],
      ignoreFocusOut: true,
      validateInput: (v) => (v && v.trim().length > 0 ? null : 'Commit message is required.'),
    });
    if (!message) return; // User cancelled.

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Committing ${wt.total} change${wt.total === 1 ? '' : 's'} on '${state.currentBranch}'…`,
        },
        async () => {
          // Stage everything (tracked modifications, deletions, untracked
          // files). Mirrors the "git add -A" intent: the panel's count
          // includes untracked files, so staging just tracked changes would
          // surprise the user.
          await this.git(['add', '-A']);
          await this.git(['commit', '-m', message]);
        },
      );
      vscode.window.showInformationMessage(`✓ Committed ${wt.total} change${wt.total === 1 ? '' : 's'} on '${state.currentBranch}'.`);
    } catch (err) {
      // Pre-commit hooks (gitleaks, lint-staged, etc.) write the rejection
      // reason to stderr. Show enough of it to be actionable without
      // burying the user in a wall of text.
      const stderr = (err && err.stderr) ? String(err.stderr).trim() : '';
      const stdout = (err && err.stdout) ? String(err.stdout).trim() : '';
      const detail = (stderr || stdout || (err && err.message) || String(err)).split('\n').slice(0, 8).join('\n');
      const choice = await vscode.window.showErrorMessage(
        `Commit failed: ${detail}`,
        { modal: false },
        'Show in terminal',
        'Dismiss',
      );
      if (choice === 'Show in terminal') {
        const term = vscode.window.createTerminal({ name: 'Branch Explorer · git commit', cwd: this.cwd() });
        term.show(true);
        // Re-run via shell so the user sees the hook output live and can
        // iterate (e.g. amend after the hook auto-fixes formatting).
        const escaped = message.replace(/"/g, '\\"');
        term.sendText(`git status && echo '---' && git commit -m "${escaped}"`, true);
      }
    } finally {
      this.refresh(true);
    }
  }

  async pruneGone() {
    const state = await this.collectState();
    if (state.error) {
      vscode.window.showErrorMessage(state.error);
      return;
    }
    // Never include protected branches in a bulk prune — even if git somehow
    // reports them as 'gone', the user has to delete them deliberately.
    const gone = state.branches.filter((b) => b.gone && !isProtectedBranch(b.name, state.defaultBranch));
    if (gone.length === 0) {
      vscode.window.showInformationMessage('No gone branches to prune.');
      return;
    }
    const goneNames = gone.map((b) => b.name);
    const currentGone = gone.find((b) => b.current);
    const summary = `Delete ${gone.length} local branch${gone.length === 1 ? '' : 'es'} whose remote was deleted on GitHub?\n\n${goneNames.join('\n')}`;
    const choice = await vscode.window.showWarningMessage(
      summary,
      { modal: true, detail: 'Their content is already on origin/main (as squash-merge commits). This is the same operation GitHub did when it cleaned up the remote branches.' },
      'Delete all',
    );
    if (choice !== 'Delete all') return;

    // Can't delete the branch we're sitting on — switch to main first if needed.
    if (currentGone) {
      try {
        await this.git(['checkout', 'main']);
      } catch (err) {
        vscode.window.showErrorMessage(`Could not switch off '${currentGone.name}' before deletion: ${err.message || err}`);
        return;
      }
    }

    const failed = [];
    for (const name of goneNames) {
      try {
        await this.git(['branch', '-D', name]);
      } catch (err) {
        failed.push({ name, err: err.message || String(err) });
      }
    }
    if (failed.length === 0) {
      vscode.window.showInformationMessage(`Deleted ${goneNames.length} gone branch${goneNames.length === 1 ? '' : 'es'}.`);
    } else {
      vscode.window.showWarningMessage(`Deleted ${goneNames.length - failed.length} of ${goneNames.length}. Failures: ${failed.map((f) => f.name).join(', ')}`);
    }
    this.refresh();
  }

  async openBranchOnGithub(branch) {
    try {
      const out = await this.git(['config', '--get', 'remote.origin.url']);
      const slug = parseGithubSlug(out.trim());
      if (!slug) {
        vscode.window.showWarningMessage('Could not parse GitHub repo from origin.');
        return;
      }
      // GitHub URL-encodes a branch name in the path of /tree/...
      const url = `https://github.com/${slug}/tree/${encodeURIComponent(branch)}`;
      vscode.env.openExternal(vscode.Uri.parse(url));
    } catch (err) {
      vscode.window.showErrorMessage(`Could not open branch page: ${err.message || err}`);
    }
  }

  async openPr(branch, opts = {}) {
    // Opens GitHub's compare page pre-targeted at the repo's default branch
    // (main / master / whatever origin/HEAD points at). 'expand=1' jumps
    // straight into the PR create form instead of the compare diff view.
    const fromRemote = opts.fromRemote === true;
    try {
      const state = await this.collectState();
      if (state && state.error) {
        vscode.window.showErrorMessage(state.error);
        return;
      }
      const slug = state.repoSlug;
      if (!slug) {
        vscode.window.showWarningMessage('Could not parse GitHub repo from origin.');
        return;
      }
      const base = state.defaultBranch || 'main';
      if (branch === base) {
        vscode.window.showWarningMessage(`'${branch}' is the default branch — no PR needed.`);
        return;
      }

      // For local branches: if there are unpushed commits, GitHub's compare
      // page won't see them, so offer to push first. Skipped for remote-only
      // branches (nothing local to push) and 'gone' branches (no upstream).
      if (!fromRemote) {
        const b = (state.branches || []).find((x) => x.name === branch);
        if (b && !b.gone && b.ahead > 0) {
          const choice = await vscode.window.showWarningMessage(
            `'${branch}' has ${b.ahead} unpushed commit${b.ahead === 1 ? '' : 's'}. Push them first so they're included in the PR?`,
            { modal: true, detail: "GitHub can only include commits that are on origin. Anything not yet pushed won't appear in the PR diff." },
            'Push and open PR',
            'Open PR anyway',
          );
          if (!choice) return;
          if (choice === 'Push and open PR') {
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: `git push origin ${branch}` },
              async () => {
                if (b.noUpstream) {
                  await this.git(['push', '-u', 'origin', branch]);
                } else {
                  await this.git(['push', 'origin', branch]);
                }
              },
            );
            this.refresh();
          }
        }
      }

      const url = `https://github.com/${slug}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
      vscode.env.openExternal(vscode.Uri.parse(url));
    } catch (err) {
      vscode.window.showErrorMessage(`Could not open PR page: ${err.message || err}`);
    }
  }
}

// Parse `git status --porcelain=v1 -uall` output into a summary that the
// "uncommitted changes" badge on the current-branch row uses. Each line is
// `XY <path>` where X is the index status and Y is the working-tree status.
// Special cases: `??` = untracked, and `U` in either column (or AA / DD) =
// unmerged conflict. Renames show as `R  old -> new` — we leave the path
// string as-is, which renders fine in the tooltip.
function parseGitStatus(porcelain) {
  if (!porcelain || !porcelain.trim()) {
    return { staged: 0, modified: 0, untracked: 0, conflicts: 0, total: 0, files: [] };
  }
  const lines = porcelain.split('\n').filter(Boolean);
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicts = 0;
  const files = [];
  for (const line of lines) {
    const indexCh = line[0];
    const wtCh = line[1];
    const path = line.substring(3);
    const code = line.substring(0, 2);
    const isConflict =
      indexCh === 'U' || wtCh === 'U' ||
      (indexCh === 'A' && wtCh === 'A') ||
      (indexCh === 'D' && wtCh === 'D');
    if (isConflict) {
      conflicts++;
    } else if (indexCh === '?' && wtCh === '?') {
      untracked++;
    } else {
      if (indexCh !== ' ' && indexCh !== '?') staged++;
      if (wtCh !== ' ' && wtCh !== '?') modified++;
    }
    files.push({ code, path });
  }
  return { staged, modified, untracked, conflicts, total: lines.length, files };
}

function parseAhead(track) {
  if (!track) return 0;
  const m = track.match(/ahead\s+(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}
function parseBehind(track) {
  if (!track) return 0;
  const m = track.match(/behind\s+(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function parseGithubSlug(remoteUrl) {
  if (!remoteUrl) return '';
  // matches both https and git@ styles
  const m = remoteUrl.match(/github\.com[:/]+([^/]+\/[^/.]+)(?:\.git)?\/?$/);
  return m ? m[1] : '';
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function syncBadge(b, defaultBranch) {
  if (b.noUpstream) {
    const localOnlyPill = `<span class="badge badge-neutral" title="Local only — this branch exists on your machine but has never been pushed to GitHub.">local only</span>`;
    // For local-only branches we still want to show the user how much work
    // they have relative to the default branch (typically main). That's the
    // meaningful "what would be in my PR if I published" count.
    if (b.aheadVsDefault !== undefined && defaultBranch) {
      const aheadCls = b.aheadVsDefault > 0 ? 'badge-ahead' : 'badge-zero';
      const behindCls = b.behindVsDefault > 0 ? 'badge-behind' : 'badge-zero';
      const aheadTitle = b.aheadVsDefault > 0
        ? `This branch has ${b.aheadVsDefault} commit${b.aheadVsDefault === 1 ? '' : 's'} that aren't on origin/${defaultBranch} yet — that's what would end up in your PR.`
        : `This branch has no new commits compared to origin/${defaultBranch}.`;
      const behindTitle = b.behindVsDefault > 0
        ? `origin/${defaultBranch} has ${b.behindVsDefault} commit${b.behindVsDefault === 1 ? '' : 's'} that aren't on this branch — rebase or merge to catch up.`
        : `This branch is up to date with origin/${defaultBranch}.`;
      return `${localOnlyPill} <span class="badge ${aheadCls}" title="${aheadTitle}">↑${b.aheadVsDefault}</span> <span class="badge ${behindCls}" title="${behindTitle}">↓${b.behindVsDefault}</span>`;
    }
    return localOnlyPill;
  }
  if (b.gone) {
    return `<span class="badge badge-warn" title="GitHub deleted — the remote branch on GitHub no longer exists (usually because the PR was merged and GitHub auto-deleted it).">GitHub gone</span>`;
  }
  // Always show ↑N ↓N so the count is explicit even when it's 0 (consistent format across all branches).
  const aheadCls = b.ahead > 0 ? 'badge-ahead' : 'badge-zero';
  const behindCls = b.behind > 0 ? 'badge-behind' : 'badge-zero';
  const aheadTitle = b.ahead > 0
    ? `Local is ${b.ahead} commit${b.ahead === 1 ? '' : 's'} ahead of GitHub (${b.upstream}). Push to publish them.`
    : `Local is in sync with GitHub on push side — no unpushed commits.`;
  const behindTitle = b.behind > 0
    ? `GitHub (${b.upstream}) is ${b.behind} commit${b.behind === 1 ? '' : 's'} ahead of Local. Pull to catch up.`
    : `Local is in sync with GitHub on pull side — nothing to pull.`;
  return `<span class="badge ${aheadCls}" title="${aheadTitle}">↑${b.ahead}</span> <span class="badge ${behindCls}" title="${behindTitle}">↓${b.behind}</span>`;
}

// Compact "fetched 12s ago" / "fetching…" indicator. Clickable — triggers a
// manual `git fetch --all --prune` (same as the toolbar button). Surfaces
// freshness so it's obvious why ↑/↓ counts haven't moved: they're tied to
// the last fetch, not to live GitHub state.
function renderFetchFreshness(state) {
  if (state.backgroundFetching) {
    return `<span class="freshness freshness-loading" title="Fetching from GitHub in the background — ahead/behind counts will update momentarily.">fetching…</span>`;
  }
  if (!state.lastFetchedAt) {
    return `<button type="button" class="freshness freshness-action" data-action="fetch" title="Run git fetch --all --prune so ahead/behind counts reflect what's actually on GitHub.">never fetched · refresh</button>`;
  }
  const ms = Date.now() - state.lastFetchedAt;
  let label;
  if (ms < 5_000)            label = 'just now';
  else if (ms < 60_000)      label = `${Math.round(ms / 1000)}s ago`;
  else if (ms < 60 * 60_000) label = `${Math.round(ms / 60_000)}m ago`;
  else                       label = `${Math.round(ms / 3_600_000)}h ago`;
  const stale = ms > 2 * 60_000;
  const cls = stale ? 'freshness freshness-stale' : 'freshness';
  const tip = stale
    ? `Last fetched from GitHub ${label}. Counts may be stale — click to refresh now.`
    : `Last fetched from GitHub ${label}. Auto-refreshes every 90s while this panel is visible.`;
  return `<button type="button" class="${cls}" data-action="fetch" title="${tip}">fetched ${label}</button>`;
}

function renderBranchesBody(state) {
  if (state.error) {
    return `<div class="error">${escapeHtml(state.error)}</div>`;
  }

  const branchRows = state.branches.map((b) => {
    const classes = ['branch'];
    if (b.current) classes.push('is-current');
    if (b.gone) classes.push('is-gone');
    if (!b.gone && (b.ahead > 0 || b.behind > 0 || b.noUpstream)) classes.push('needs-attention');

    // Show "Open PR" on any branch that's on GitHub and isn't the default —
    // covers local branches with an upstream that aren't gone or protected.
    // GitHub's compare page handles the "nothing to compare" edge cleanly.
    const baseBranch = state.defaultBranch || 'main';
    const canOpenPr = state.repoSlug && !b.protected && !b.gone && !b.noUpstream && b.name !== baseBranch;
    const prLink = canOpenPr
      ? `<button class="link primary-link" data-action="openPr" data-branch="${escapeHtml(b.name)}" title="Open the GitHub PR-create page targeting ${escapeHtml(baseBranch)} ← ${escapeHtml(b.name)}. Pre-fills base, head, title from the latest commit, and any PR template.">Open PR →</button>`
      : '';

    // Per-branch pull/push. Hide for cases where the action makes no sense.
    let pullBtn = '';
    let pushBtn = '';
    let publishBtn = '';
    if (b.noUpstream) {
      publishBtn = `<button class="link primary-link" data-action="publishBranch" data-branch="${escapeHtml(b.name)}" title="git push -u origin ${escapeHtml(b.name)} — publish this local-only branch to GitHub">↑ Publish</button>`;
    } else if (!b.gone) {
      if (b.behind > 0) {
        const ffNote = b.current
          ? `git pull --ff-only`
          : `git fetch origin ${b.upstream ? b.upstream.replace(/^origin\//, '') : b.name}:${b.name} (fast-forward without checkout)`;
        pullBtn = `<button class="link" data-action="pullBranch" data-branch="${escapeHtml(b.name)}" title="Pull ${b.behind} commit${b.behind === 1 ? '' : 's'} from GitHub → ${escapeHtml(b.name)} (${escapeHtml(ffNote)})">↓ Pull (${b.behind})</button>`;
      }
      if (b.ahead > 0) {
        pushBtn = `<button class="link" data-action="pushBranch" data-branch="${escapeHtml(b.name)}" title="Push ${b.ahead} commit${b.ahead === 1 ? '' : 's'} from ${escapeHtml(b.name)} → GitHub (git push origin ${escapeHtml(b.name)})">↑ Push (${b.ahead})</button>`;
      }
    }

    // Delete is suppressed for (a) the branch you're sitting on (git itself
    // refuses) and (b) protected branches like the repo's default (main /
    // master / develop). The server-side deleteBranch() also enforces (b).
    const deleteBtn = (b.current || b.protected)
      ? ''
      : `<button class="link danger" data-action="delete" data-branch="${escapeHtml(b.name)}" title="git branch -D ${escapeHtml(b.name)}">delete</button>`;

    // 'gone' on a protected branch is almost certainly a tracking-config quirk
    // (e.g. someone deleted origin/main on purpose), so don't tell the user
    // it's "safe to delete".
    const safeHint = (b.gone && !b.protected)
      ? `<div class="safe-hint" title="The remote branch on GitHub is gone (usually because the PR was merged and GitHub auto-deleted it). Safe to delete locally — content is on origin/main.">✓ Safe to delete — remote no longer exists on GitHub</div>`
      : '';

    const currentBadge = b.current
      ? `<span class="current-pill" title="This is the branch you are checked out on. Any changes you make in the editor will become part of this branch.">YOU ARE HERE</span>`
      : '';

    const protectedBadge = b.protected
      ? `<span class="protected-pill" title="Protected: this is the repo's default branch (or a conventional default like main / master / develop). Deletion is disabled.">DEFAULT</span>`
      : '';

    // Uncommitted-changes badge + Commit button (current branch only). The
    // working-tree status is computed once for the whole panel; only the
    // current-branch row needs it because that's the only branch your edits
    // can possibly land on.
    let dirtyBadge = '';
    let commitBtn = '';
    if (b.current && state.workingTree && state.workingTree.total > 0) {
      const wt = state.workingTree;
      const parts = [];
      if (wt.staged > 0)    parts.push(`${wt.staged} staged`);
      if (wt.modified > 0)  parts.push(`${wt.modified} modified`);
      if (wt.untracked > 0) parts.push(`${wt.untracked} untracked`);
      if (wt.conflicts > 0) parts.push(`${wt.conflicts} conflict${wt.conflicts === 1 ? '' : 's'}`);
      const breakdown = parts.join(' · ');
      // First ~12 files in the tooltip so the user can see what's actually
      // dirty without leaving the panel. Truncate with a "+N more" suffix to
      // keep the tooltip from overflowing on big change sets.
      const previewFiles = wt.files.slice(0, 12).map((f) => `${f.code} ${f.path}`).join('\n');
      const moreSuffix = wt.files.length > 12 ? `\n+${wt.files.length - 12} more` : '';
      const dirtyTitle = `${wt.total} uncommitted change${wt.total === 1 ? '' : 's'} (${breakdown}).\n\n${previewFiles}${moreSuffix}\n\nClick the Commit button to git add -A + commit with one message.`;
      dirtyBadge = `<span class="badge badge-dirty" title="${escapeHtml(dirtyTitle)}">${wt.total} uncommitted</span>`;
      const commitDisabled = wt.conflicts > 0;
      const commitTitle = commitDisabled
        ? `Cannot commit — ${wt.conflicts} unresolved conflict${wt.conflicts === 1 ? '' : 's'}. Resolve them first (e.g. via VS Code's Source Control panel).`
        : `Commit all ${wt.total} change${wt.total === 1 ? '' : 's'} on '${b.name}' (git add -A && git commit -m <your message>). Opens a prompt for the commit message.`;
      commitBtn = commitDisabled
        ? `<button class="link" disabled title="${escapeHtml(commitTitle)}">✎ Commit (${wt.total})</button>`
        : `<button class="link primary-link" data-action="commitCurrent" title="${escapeHtml(commitTitle)}">✎ Commit (${wt.total})</button>`;
    }

    // The whole row is clickable to switch branches, except when the click lands on a button.
    const rowAttrs = b.current
      ? `class="${classes.join(' ')}" title="You are already on this branch"`
      : `class="${classes.join(' ')} clickable" data-action="checkout" data-branch="${escapeHtml(b.name)}" title="Click anywhere on this row to switch to '${escapeHtml(b.name)}' (git checkout ${escapeHtml(b.name)})"`;

    return `
      <div ${rowAttrs}>
        <div class="branch-main">
          <span class="dot" aria-hidden="true">${b.current ? '●' : '○'}</span>
          <span class="name" title="${escapeHtml(b.sha)} — ${escapeHtml(b.subject)}">${escapeHtml(b.name)}</span>
          ${currentBadge}
          ${protectedBadge}
          <span class="badges">${dirtyBadge}${syncBadge(b, state.defaultBranch)}</span>
        </div>
        <div class="branch-meta">
          <span class="meta-when">${escapeHtml(b.when)}</span>
          <span class="meta-sep">·</span>
          <span class="meta-author">${escapeHtml(b.author)}</span>
          ${b.current ? '' : '<span class="click-hint">→ click to switch</span>'}
        </div>
        ${safeHint}
        <div class="branch-actions">${commitBtn}${publishBtn}${pullBtn}${pushBtn}${prLink}${deleteBtn}</div>
      </div>
    `;
  }).join('');

  const goneCount = state.branches.filter((b) => b.gone).length;
  const prunableCount = state.branches.filter((b) => b.gone && !b.protected).length;
  const pruneBtn = prunableCount > 0
    ? `<button data-action="pruneGone" class="danger-soft" title="Delete every local branch whose remote was deleted on GitHub (protected default branches are skipped)">Prune gone (${prunableCount})</button>`
    : '';

  const remoteBaseBranch = state.defaultBranch || 'main';
  const remoteRows = (state.remoteOnly || []).map((b) => {
    const remoteCanPr = state.repoSlug && b.name !== remoteBaseBranch && !ALWAYS_PROTECTED_BRANCHES.has(b.name);
    const remotePrBtn = remoteCanPr
      ? `<button class="link primary-link" data-action="openPr" data-branch="${escapeHtml(b.name)}" data-from-remote="1" title="Open the GitHub PR-create page targeting ${escapeHtml(remoteBaseBranch)} ← ${escapeHtml(b.name)} (no local checkout needed).">Open PR →</button>`
      : '';
    // Show ahead/behind vs default branch — same meaning as for local-only
    // branches: "how big is the diff that would land in a PR from this
    // branch?" Skip for the default branch itself (it'd be 0/0 of itself).
    const showDiff = b.aheadVsDefault !== undefined && b.name !== remoteBaseBranch;
    const aheadCls = showDiff && b.aheadVsDefault > 0 ? 'badge-ahead' : 'badge-zero';
    const behindCls = showDiff && b.behindVsDefault > 0 ? 'badge-behind' : 'badge-zero';
    const aheadTitle = !showDiff
      ? ''
      : b.aheadVsDefault > 0
        ? `This branch has ${b.aheadVsDefault} commit${b.aheadVsDefault === 1 ? '' : 's'} that aren't on origin/${remoteBaseBranch} yet — that's what would end up in the PR.`
        : `No new commits compared to origin/${remoteBaseBranch}.`;
    const behindTitle = !showDiff
      ? ''
      : b.behindVsDefault > 0
        ? `origin/${remoteBaseBranch} has ${b.behindVsDefault} commit${b.behindVsDefault === 1 ? '' : 's'} that aren't on this branch — it needs a rebase before merge.`
        : `Up to date with origin/${remoteBaseBranch}.`;
    const diffBadges = showDiff
      ? `<span class="badge ${aheadCls}" title="${aheadTitle}">↑${b.aheadVsDefault}</span> <span class="badge ${behindCls}" title="${behindTitle}">↓${b.behindVsDefault}</span> `
      : '';
    return `
      <div class="branch is-remote clickable" data-action="checkout" data-branch="${escapeHtml(b.name)}" title="Click anywhere on this row to check out '${escapeHtml(b.name)}' from GitHub. Git will create a local branch that tracks origin/${escapeHtml(b.name)}.">
        <div class="branch-main">
          <span class="dot" aria-hidden="true">☁</span>
          <span class="name" title="${escapeHtml(b.sha)} — ${escapeHtml(b.subject)}">${escapeHtml(b.name)}</span>
          <span class="badges">${diffBadges}<span class="badge badge-remote-only" title="This branch exists on GitHub but not yet on your machine. Checkout to start working on it locally.">on GitHub only</span></span>
        </div>
        <div class="branch-meta">
          <span class="meta-when">${escapeHtml(b.when)}</span>
          <span class="meta-sep">·</span>
          <span class="meta-author">${escapeHtml(b.author)}</span>
          <span class="click-hint">→ checkout to start working</span>
        </div>
        <div class="branch-actions">
          <button class="link" data-action="checkout" data-branch="${escapeHtml(b.name)}" title="git checkout ${escapeHtml(b.name)} — creates a local branch tracking origin/${escapeHtml(b.name)}">↓ Checkout</button>
          ${remotePrBtn}
          ${state.repoSlug ? `<button class="link" data-action="openBranchOnGithub" data-branch="${escapeHtml(b.name)}" title="View this branch on GitHub">View on GitHub</button>` : ''}
        </div>
      </div>
    `;
  }).join('');

  const remoteSection = (state.remoteOnly && state.remoteOnly.length > 0)
    ? `
      <section class="section remote-section">
        <div class="section-header" title="Branches that exist on GitHub but you don't have a local copy of yet. Click a row (or the Checkout button) to pull one down — git will create a local branch tracking origin/<name>.">
          <span class="section-title">On GitHub but not local</span>
          <span class="section-count">${state.remoteOnly.length}</span>
        </div>
        ${remoteRows}
      </section>
    `
    : '';

  return `
    <div class="tab-toolbar">
      <button data-action="createBranch" class="primary" title="Create a new local branch and switch to it (git checkout -b). Pick which branch to start from.">+ New branch</button>
      <button data-action="fetch" title="git fetch --all --prune — refresh local view of GitHub. Per-branch pull/push live on the row that needs them.">Fetch from GitHub</button>
      ${pruneBtn}
    </div>
    <div class="row summary">
      <span>${state.branches.length} local</span>
      <span class="meta-sep">·</span>
      <span>${(state.remoteOnly || []).length} on GitHub only</span>
      <span class="meta-sep">·</span>
      <span>${state.stashCount} stash${state.stashCount === 1 ? '' : 'es'}</span>
      ${goneCount > 0 ? `<span class="meta-sep">·</span><span class="summary-gone">${goneCount} gone</span>` : ''}
      <span class="meta-sep">·</span>
      ${renderFetchFreshness(state)}
    </div>
    <div class="legend" title="↑N = your Local is N commits ahead of GitHub (you have unpushed work). ↓N = GitHub is N commits ahead of your Local (something to pull). 'N uncommitted' = files changed since the last commit on the current branch — click ✎ Commit to stage them all and commit in one step. For 'local only' branches with no remote, ↑N ↓N is measured against origin/${state.defaultBranch || 'main'} so you can see what would be in your PR. For 'on GitHub only' branches (not yet on your machine), ↑N ↓N is also measured against origin/${state.defaultBranch || 'main'} so you can scan PR sizes at a glance. 'GitHub gone' = remote branch was deleted. Branches are sorted by most-recent commit first.">
      ↑ = unpushed commits &nbsp;·&nbsp; ↓ = commits to pull &nbsp;·&nbsp; ✎ = uncommitted edits on your current branch
    </div>
    <main>
      <section class="section">
        <div class="section-header">
          <span class="section-title">Local branches</span>
          <span class="section-count">${state.branches.length}</span>
        </div>
        ${branchRows || '<div class="empty">No local branches.</div>'}
      </section>
      ${remoteSection}
    </main>
  `;
}

// ─── Combined-panel renderer ────────────────────────────────────────────────
//
// Single entry point for the webview. Builds the CSP, the shared repo header,
// the tabs bar, and then defers to the active tab's body renderer.

function renderCombinedHtml(input, webview, _context) {
  const { activeTab, shared, branchesState, actionsState } = input;
  const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} https: data:`,
  ].join('; ');

  // Shared header — repo badge with multi-repo caret (if applicable).
  // In a multi-folder workspace we show BOTH the folder name and the GitHub
  // slug, because slug alone is ambiguous when you have two clones of the
  // same fork or two repos with similar names. The "switched" pill lights up
  // when the panel is showing a folder other than workspaceFolders[0] —
  // that's the cue that the integrated terminal opens in a different repo
  // than the one the panel is operating on, the most common multi-repo
  // failure mode.
  const multiRepo = (shared.workspaceFolderCount || 0) > 1;
  const folderName = shared.folderName || '';
  const repoSlug = shared.repoSlug || '';
  // Primary label: folder name in multi-repo workspaces (so you always know
  // which folder you're hitting), GitHub slug in single-repo workspaces (so
  // you see something meaningful even when slug == folder name).
  const repoLabel = multiRepo
    ? (folderName || repoSlug || '(no GitHub remote)')
    : (repoSlug || folderName || '(no GitHub remote)');
  // Secondary label: only shown when we have both a folder name AND a slug,
  // in a multi-repo workspace, and they're not redundant.
  const secondary = (multiRepo && folderName && repoSlug && folderName !== repoSlug)
    ? `<span class="repo-secondary" aria-hidden="true">${escapeHtml(repoSlug)}</span>`
    : '';
  const repoTitle = multiRepo
    ? `${shared.workspaceFolderCount} folders in this workspace — currently viewing ${folderName || 'unknown'}${repoSlug ? ` (github.com/${repoSlug})` : ''}. Click to switch which repo the panel operates on, open a terminal in a repo, or open one on GitHub.`
    : (repoSlug ? `Open ${repoSlug} on GitHub` : 'No GitHub remote configured');
  const multiCaret = multiRepo
    ? `<span class="repo-caret" aria-hidden="true">▼ ${shared.workspaceFolderCount}</span>`
    : '';
  // Switched pill: only when the user has picked a non-default folder. We
  // intentionally make this visually loud — it's the single most useful
  // signal in this whole UI for catching wrong-repo mistakes before a push.
  const switchedPill = (multiRepo && shared.switched)
    ? `<span class="repo-switched" title="The panel is operating on this folder, NOT the default workspace folder. New terminals open in the default folder unless you use Open terminal in this repo from the picker.">switched</span>`
    : '';
  const repoBadge = `<button class="repo" data-action="pickRepo" title="${escapeHtml(repoTitle)}">${escapeHtml(repoLabel)}${secondary}${switchedPill}${multiCaret}</button>`;

  // Tabs bar — Branches | Actions, with the active tab highlighted.
  // The "Actions" tab gets a small activity dot if any in-progress runs are
  // cached, so the user can see something is in flight even while looking at
  // the Branches tab.
  const inFlightCount = (actionsState && Array.isArray(actionsState.runs))
    ? actionsState.runs.filter((r) => r.status === 'in_progress' || r.status === 'queued').length
    : 0;
  const branchAheadCount = (branchesState && Array.isArray(branchesState.branches))
    ? branchesState.branches.filter((b) => b.ahead > 0 && !b.gone).length
    : 0;

  const tabs = `
    <div class="tabs-bar" role="tablist">
      <button role="tab" aria-selected="${activeTab === 'branches'}"
        class="tab-btn ${activeTab === 'branches' ? 'active' : ''}"
        data-action="switchTab" data-tab="branches"
        title="Local + remote git branches with mirror status">
        Branches${branchAheadCount > 0 ? `<span class="tab-badge tab-badge-info" title="${branchAheadCount} branch${branchAheadCount === 1 ? '' : 'es'} with unpushed commits">${branchAheadCount}</span>` : ''}
      </button>
      <button role="tab" aria-selected="${activeTab === 'actions'}"
        class="tab-btn ${activeTab === 'actions' ? 'active' : ''}"
        data-action="switchTab" data-tab="actions"
        title="GitHub Actions workflow runs (CI/CD)">
        Actions${inFlightCount > 0 ? `<span class="tab-badge tab-badge-running" title="${inFlightCount} workflow run${inFlightCount === 1 ? '' : 's'} in progress">${inFlightCount} <span class="tab-badge-dot"></span></span>` : ''}
      </button>
    </div>
  `;

  let tabBody;
  if (activeTab === 'actions') {
    tabBody = renderActionsBody(actionsState);
  } else {
    tabBody = renderBranchesBody(branchesState || { branches: [], remoteOnly: [], stashCount: 0, error: 'No data yet.' });
  }

  const body = `
    <header class="panel-header">
      <div class="row repo-row">${repoBadge}</div>
      ${tabs}
    </header>
    <section class="tab-content tab-${escapeHtml(activeTab)}">${tabBody}</section>
  `;

  return baseHtml(csp, nonce, body, renderFooter(shared.update));
}

function renderFooter(update) {
  // Footer is the only place the user sees self-update status. Three states:
  //   1. up-to-date            → "v0.4.2 · check"     (clickable to force check)
  //   2. update available      → "v0.4.2 → Update to v0.4.3"  (primary orange)
  //   3. checking / installing → "v0.4.2 · checking…" / "installing…"
  // The whole footer is always pinned at the bottom of the panel.
  const u = update || {};
  const cur = u.currentVersion || '0.0.0';
  const repoLink = `<button type="button" class="footer-link" data-action="openRepo" title="Open the Branch Explorer repository on GitHub">repo</button>`;

  let updateBlock;
  if (u.updateInstalling) {
    updateBlock = `<span class="version-badge" title="Downloading and installing the latest release…">installing…</span>`;
  } else if (u.updateChecking) {
    updateBlock = `<span class="version-badge" title="Checking GitHub for the latest release…">v${escapeHtml(cur)} · checking…</span>`;
  } else if (u.updateAvailable && u.updateInfo) {
    updateBlock = `
      <span class="version-badge dim" title="Currently installed">v${escapeHtml(cur)}</span>
      <button class="update-btn" data-action="installUpdate" title="A newer release is available on GitHub. Click to download &amp; install ${escapeHtml(u.updateInfo.tagName)}. After install you'll be prompted to reload Cursor.">Update to ${escapeHtml(u.updateInfo.tagName)} →</button>
    `;
  } else if (u.updateError) {
    updateBlock = `
      <button class="version-badge" data-action="checkForUpdates" title="Last check failed: ${escapeHtml(u.updateError)} — click to retry">v${escapeHtml(cur)} · check failed</button>
    `;
  } else {
    updateBlock = `
      <button class="version-badge" data-action="checkForUpdates" title="${u.updateInfo ? `Up to date with ${escapeHtml(u.updateInfo.tagName)} (latest release on GitHub). Click to re-check.` : 'Click to check GitHub for a newer release.'}">v${escapeHtml(cur)}${u.updateInfo ? ' · up to date' : ' · check'}</button>
    `;
  }

  return `
    <div class="footer-inner">
      <span class="brand-mark">btrad</span>
      <span class="footer-sep">·</span>
      <span class="footer-label">Branch Explorer</span>
      <span class="footer-sep">·</span>
      <span class="footer-by">made by Michael Walding</span>
      <span class="footer-sep">·</span>
      ${updateBlock}
      <span class="footer-sep">·</span>
      ${repoLink}
    </div>
  `;
}

function baseHtml(csp, nonce, body, footerInner) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root {
    color-scheme: light;
    --gap: 6px;
    --radius: 6px;
    /* btrad brand palette — pulled directly from frontend/app/globals.css.
       To keep the panel consistent with the site UI, we always render in
       light mode regardless of the Cursor color theme. */
    --brand-50:  #fdf8f0;
    --brand-100: #f9eddb;
    --brand-200: #f2d7b0;
    --brand-300: #e9b97c;
    --brand-400: #dc9239;
    --brand-500: #d4792b;
    --brand-600: #c45f20;
    --brand-700: #a3481d;
    --brand-800: #833a1f;
    --brand-900: #6b311d;
    --brand-soft:   rgba(196, 95, 32, 0.10);
    --brand-strong: rgba(196, 95, 32, 0.18);
    --brand-shadow: rgba(196, 95, 32, 0.30);
    /* Site semantic tokens */
    --bg:          #ffffff;
    --bg-surface:  #fdf8f0;   /* brand-50 — page tint */
    --bg-surface2: #f8fafc;
    --card:        #ffffff;
    --fg:          #0f172a;
    --fg-muted:    #5b6770;
    --border:      #e6e6e6;
    --warning:     #f59e0b;
    --warning-soft: rgba(245, 158, 11, 0.16);
    --success:     #16a34a;
    --success-soft: rgba(22, 163, 74, 0.14);
    --danger:      #ef4444;
    --danger-soft: rgba(239, 68, 68, 0.12);
    --info:        #0284c7;
    --info-soft:   rgba(2, 132, 199, 0.12);
    /* Typography — Geist on the site; system-stack fallback that visually matches. */
    --font-body: "Geist", system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    --font-mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  body {
    font-family: var(--font-body);
    font-size: 12px;
    color: var(--fg);
    background: var(--bg-surface);
    margin: 0;
    padding: 8px 8px 80px;
  }
  /* Unified header: repo badge on top, tab bar directly under. The two are
     visually attached (rounded top, flush bottom on the badge; flush top,
     rounded bottom on the tab bar) so they read as a single panel cap. */
  header.panel-header {
    display: flex; flex-direction: column;
    margin-bottom: 12px;
    background: var(--card);
    border: 1px solid var(--border);
    border-top: 3px solid var(--brand-600);
    border-radius: var(--radius);
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    overflow: hidden;
  }
  .repo-row {
    padding: 9px 12px 5px;
    border-bottom: 1px solid var(--border);
    background: var(--card);
  }
  .row { display: flex; align-items: center; gap: var(--gap); flex-wrap: wrap; }
  .toolbar button { flex: 1 1 auto; min-width: 56px; }

  /* Tab bar — segmented Branches / Actions switcher. */
  .tabs-bar {
    display: flex;
    background: var(--bg-surface);
  }
  .tab-btn {
    flex: 1 1 50%;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 9px 10px 8px;
    font-size: 12px;
    font-weight: 600;
    color: var(--fg-muted);
    cursor: pointer;
    text-align: center;
    border-radius: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    transition: background 0.08s, color 0.08s, border-color 0.08s;
  }
  .tab-btn:hover {
    background: var(--card);
    color: var(--fg);
  }
  .tab-btn.active {
    color: var(--brand-700);
    background: var(--card);
    border-bottom-color: var(--brand-600);
  }
  .tab-btn + .tab-btn { border-left: 1px solid var(--border); }
  .tab-badge {
    font-size: 9px;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: 9999px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .tab-badge-info     { background: var(--brand-soft); color: var(--brand-700); }
  .tab-badge-running  { background: var(--info-soft);  color: var(--info); }
  .tab-badge-dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: var(--info);
    animation: be-pulse 1.4s ease-in-out infinite;
  }

  /* The active tab's content. Padding here so each body doesn't have to
     manage its own outer spacing; both tabs feel consistent. */
  .tab-content { padding: 0 2px; }
  .tab-toolbar {
    display: flex; gap: var(--gap); flex-wrap: wrap;
    margin: 10px 0 8px;
  }
  .tab-toolbar button { flex: 1 1 auto; min-width: 80px; }
  button.repo {
    font-size: 12px;
    font-weight: 600;
    color: var(--fg);
    background: transparent;
    border: none;
    padding: 2px 4px;
    border-bottom: 1px dotted transparent;
    border-radius: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  button.repo:hover {
    border-bottom-color: var(--brand-600);
    color: var(--brand-700);
    background: transparent;
  }
  .repo-caret {
    font-size: 9px;
    font-weight: 700;
    background: var(--brand-soft);
    color: var(--brand-700);
    border-radius: 9999px;
    padding: 1px 7px;
    letter-spacing: 0.4px;
  }
  /* Secondary label (GitHub slug shown next to folder name in multi-repo
     workspaces). Muted so it sits behind the primary folder-name label. */
  .repo-secondary {
    font-size: 10px;
    font-weight: 500;
    color: var(--fg-muted);
    opacity: 0.85;
  }
  /* "switched" pill — appears in the header when the panel is operating on
     a non-default workspace folder. Loud on purpose — this is the single
     most useful cue for "your terminal is in a different repo than the
     panel". Uses the brand orange so it's impossible to miss. */
  .repo-switched {
    font-size: 9px;
    font-weight: 800;
    background: var(--brand-600);
    color: #fff;
    border-radius: 9999px;
    padding: 1px 7px;
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }
  .summary { font-size: 11px; color: var(--fg-muted); }
  .legend {
    font-size: 10px;
    color: var(--fg-muted);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 8px;
    cursor: help;
    text-align: center;
  }
  .meta-sep { color: var(--fg-muted); opacity: 0.5; padding: 0 2px; }

  button {
    background: var(--card);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 5px 10px;
    cursor: pointer;
    font: inherit;
    transition: background 0.08s, border-color 0.08s;
  }
  button:hover { background: var(--bg-surface); border-color: var(--brand-300); }
  button.primary {
    background: var(--brand-600);
    color: #ffffff;
    border-color: var(--brand-600);
    font-weight: 600;
  }
  button.primary:hover { background: var(--brand-700); border-color: var(--brand-700); }
  button.link { background: transparent; border: none; color: var(--brand-700); padding: 2px 4px; font-weight: 500; }
  button.link:hover { text-decoration: underline; background: transparent; }
  button.link.danger { color: var(--danger); }
  button.danger-soft {
    background: var(--danger-soft);
    color: var(--danger);
    border-color: rgba(239, 68, 68, 0.35);
  }
  button.danger-soft:hover { background: rgba(239, 68, 68, 0.20); border-color: rgba(239, 68, 68, 0.55); }
  .toolbar-secondary button { width: 100%; }
  .summary-gone { color: var(--danger); font-weight: 600; }

  /* Freshness indicator — tied to the auto-fetch loop. Renders as a tiny
     button so the user can click to force-refresh. Stale = brand orange. */
  .freshness {
    font: inherit; font-size: 11px;
    background: transparent;
    color: var(--fg-muted);
    border: 1px solid transparent;
    border-radius: 999px;
    padding: 1px 7px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .freshness:hover { background: var(--brand-soft); border-color: var(--brand-shadow); color: var(--fg); }
  .freshness-loading { color: var(--brand-700); cursor: default; }
  .freshness-loading:hover { background: transparent; border-color: transparent; color: var(--brand-700); }
  .freshness-stale { color: var(--brand-700); border-color: var(--brand-shadow); }
  .freshness-action { color: var(--brand-700); border-color: var(--brand-shadow); font-weight: 600; }

  .branch {
    padding: 9px 8px 9px 12px;
    background: var(--card);
    border-radius: var(--radius);
    border: 1px solid var(--border);
    border-left: 3px solid var(--border);
    position: relative;
    transition: background 0.08s, border-color 0.08s, box-shadow 0.08s;
  }
  .branch + .branch { margin-top: 4px; }
  .branch.clickable { cursor: pointer; }
  .branch.clickable:hover {
    background: var(--bg-surface);
    border-left-color: var(--brand-600);
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
  }
  .branch.is-current {
    border: 1px solid var(--brand-600);
    border-left: 3px solid var(--brand-600);
    background: var(--brand-soft);
    box-shadow: 0 0 0 1px var(--brand-shadow), 0 1px 4px rgba(196, 95, 32, 0.18);
    cursor: default;
  }
  .branch.is-current .name {
    color: var(--brand-900);
    font-weight: 700;
  }
  .branch.is-current .dot {
    color: var(--brand-600);
    opacity: 1;
  }
  .current-pill {
    font-size: 9px;
    padding: 2px 7px;
    border-radius: 9999px;
    font-weight: 700;
    letter-spacing: 0.5px;
    background: var(--brand-600);
    color: #ffffff;
    margin-left: 6px;
  }
  .protected-pill {
    font-size: 9px;
    padding: 2px 7px;
    border-radius: 9999px;
    font-weight: 700;
    letter-spacing: 0.5px;
    background: var(--info-soft);
    color: var(--info);
    margin-left: 6px;
    border: 1px solid rgba(2, 132, 199, 0.30);
    cursor: help;
  }
  .branch.is-gone {
    border-color: var(--border);
    background: var(--bg-surface2);
  }
  .branch.is-gone .name {
    opacity: 0.7;
    text-decoration: line-through;
    text-decoration-color: rgba(15, 23, 42, 0.4);
  }
  .safe-hint {
    margin-left: 18px;
    margin-top: 6px;
    padding: 3px 10px;
    display: inline-block;
    font-size: 10px;
    color: var(--success);
    background: var(--success-soft);
    border-radius: 9999px;
    font-weight: 600;
  }

  .branch-main { display: flex; align-items: center; gap: var(--gap); }
  .dot { font-size: 10px; opacity: 0.55; width: 12px; flex: 0 0 12px; color: var(--fg-muted); }
  .name {
    flex: 1 1 auto;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--fg);
  }
  .badges { flex: 0 0 auto; display: flex; gap: 4px; }

  .badge {
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 9999px;
    font-weight: 600;
  }
  .badge-ok      { background: var(--success-soft); color: var(--success); }
  .badge-ahead   { background: var(--brand-soft);   color: var(--brand-700); }
  .badge-behind  { background: var(--warning-soft); color: #b45309; }
  .badge-warn    { background: var(--danger-soft);  color: var(--danger); }
  .badge-neutral { background: rgba(15, 23, 42, 0.08); color: var(--fg-muted); }
  .badge-zero    { background: rgba(15, 23, 42, 0.05); color: var(--fg-muted); opacity: 0.7; }
  .badge-remote-only { background: var(--info-soft); color: var(--info); }
  .badge-dirty       { background: #fef3c7; color: #92400e; }

  .section { margin-top: 4px; }
  .section + .section { margin-top: 20px; }
  .section-header {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 2px 6px;
    margin-bottom: 6px;
    border-bottom: 1px solid var(--border);
    cursor: help;
  }
  .section-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--fg);
  }
  .section-count {
    background: var(--brand-soft);
    color: var(--brand-700);
    border-radius: 9999px;
    padding: 1px 8px;
    font-size: 10px;
    font-weight: 700;
  }
  .branch.is-remote { border-left-color: rgba(2, 132, 199, 0.4); }
  .branch.is-remote.clickable:hover { border-left-color: var(--info); }
  .branch.is-remote .dot { color: var(--info); opacity: 1; }
  .branch.is-remote .name { font-style: italic; color: var(--fg); }
  .branch.is-remote .click-hint { color: var(--info); }

  .branch-meta {
    margin-left: 18px;
    margin-top: 2px;
    font-size: 11px;
    color: var(--fg-muted);
    display: flex;
    align-items: center;
  }
  .click-hint {
    margin-left: auto;
    font-size: 10px;
    color: var(--brand-700);
    opacity: 0;
    transition: opacity 0.12s;
    white-space: nowrap;
    padding-left: 8px;
    font-weight: 600;
  }
  .branch.clickable:hover .click-hint { opacity: 0.95; }
  .branch-actions {
    margin-left: 14px;
    margin-top: 4px;
    display: flex; gap: 4px;
    font-size: 11px;
    opacity: 0;
    transition: opacity 0.1s;
  }
  .branch:hover .branch-actions,
  .branch.is-current .branch-actions,
  .branch.is-gone .branch-actions,
  .branch.needs-attention .branch-actions { opacity: 1; }
  .branch.is-gone .branch-actions .danger {
    background: var(--danger-soft);
    border-radius: var(--radius);
    padding: 2px 10px;
  }
  button.link.primary-link {
    color: #ffffff;
    background: var(--brand-600);
    border-radius: var(--radius);
    padding: 3px 10px;
    font-weight: 600;
  }
  button.link.primary-link:hover {
    background: var(--brand-700);
    color: #ffffff;
    text-decoration: none;
  }

  .empty { padding: 16px; color: var(--fg-muted); text-align: center; }
  .empty code { font-family: var(--font-mono); background: var(--bg-surface); padding: 1px 5px; border-radius: 4px; }
  .error { padding: 16px; color: var(--danger); }

  /* ─── GitHub Actions panel ───────────────────────────────────────────── */
  .actions-header { padding: 10px; gap: 8px; }
  .repo-mini { font-family: var(--font-mono); font-size: 10px; opacity: 0.75; }
  .stale {
    margin-top: 4px;
    padding: 5px 9px;
    border-radius: var(--radius);
    background: var(--warning-soft);
    color: #b45309;
    font-size: 10px;
    font-weight: 600;
  }
  .setup { padding: 22px 16px; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
  .setup-title { font-size: 13px; font-weight: 700; color: var(--fg); }
  .setup-body { font-size: 11px; color: var(--fg-muted); line-height: 1.5; }
  .setup-actions { display: flex; gap: 6px; }
  .setup-hint { font-size: 10px; color: var(--fg-muted); }
  .setup code { font-family: var(--font-mono); background: var(--bg-surface); padding: 1px 5px; border-radius: 4px; }

  .run-group { margin-bottom: 4px; }
  .run-group + .run-group { margin-top: 10px; }
  .run-group-header {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 4px 6px;
    font-size: 10px;
    color: var(--fg-muted);
    border-bottom: 1px dashed var(--border);
    margin-bottom: 4px;
  }
  .commit-mark {
    background: var(--brand-soft);
    color: var(--brand-700);
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 9999px;
    font-size: 9px;
  }
  .commit-title {
    flex: 1 1 auto;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--fg);
    font-weight: 600;
  }
  .commit-branch { font-family: var(--font-mono); color: var(--fg-muted); }

  .run {
    padding: 9px 8px 9px 12px;
    background: var(--card);
    border-radius: var(--radius);
    border: 1px solid var(--border);
    border-left: 3px solid var(--border);
    cursor: pointer;
    transition: background 0.08s, border-color 0.08s, box-shadow 0.08s;
  }
  .run + .run { margin-top: 4px; }
  .run:hover {
    background: var(--bg-surface);
    border-left-color: var(--brand-600);
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
  }
  .run-main { display: flex; align-items: center; gap: var(--gap); }
  .run-name {
    flex: 1 1 auto;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 600;
    color: var(--fg);
  }
  .status-dot {
    width: 18px; height: 18px;
    flex: 0 0 18px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 700;
    color: #ffffff;
  }
  .status-pill {
    font-size: 9px;
    padding: 2px 7px;
    border-radius: 9999px;
    font-weight: 700;
    letter-spacing: 0.3px;
    text-transform: uppercase;
  }
  .st-success   { background: var(--success); }
  .st-failure   { background: var(--danger); }
  .st-running   { background: var(--brand-600); }
  .st-queued    { background: var(--info); }
  .st-cancelled { background: rgba(15, 23, 42, 0.45); }
  .st-warning   { background: var(--warning); }

  .status-pill.st-success   { background: var(--success-soft); color: var(--success); }
  .status-pill.st-failure   { background: var(--danger-soft);  color: var(--danger);  }
  .status-pill.st-running   { background: var(--brand-soft);   color: var(--brand-700); }
  .status-pill.st-queued    { background: var(--info-soft);    color: var(--info); }
  .status-pill.st-cancelled { background: rgba(15, 23, 42, 0.08); color: var(--fg-muted); }
  .status-pill.st-warning   { background: var(--warning-soft); color: #b45309; }

  /* Animated spinner ring around in-progress dots so they read as "live". */
  .status-dot.st-running {
    box-shadow: 0 0 0 2px var(--brand-soft);
    animation: be-pulse 1.6s ease-in-out infinite;
  }
  .status-dot.st-queued {
    animation: be-pulse 2.2s ease-in-out infinite;
  }
  @keyframes be-pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.55; }
  }

  .run-meta {
    margin-left: 24px;
    margin-top: 3px;
    font-size: 10px;
    color: var(--fg-muted);
    display: flex; flex-wrap: wrap; align-items: center; gap: 2px;
  }
  .run-branch  { font-family: var(--font-mono); color: var(--fg); font-weight: 600; }
  .run-event   { padding: 0 2px; }
  .run-attempt { color: var(--warning); font-weight: 600; }
  .run-dur     { font-family: var(--font-mono); }

  .run-actions {
    margin-left: 20px;
    margin-top: 5px;
    display: flex; gap: 4px;
    font-size: 11px;
    opacity: 0;
    transition: opacity 0.1s;
  }
  .run:hover .run-actions { opacity: 1; }

  .footer {
    position: fixed;
    left: 0; right: 0; bottom: 0;
    padding: 7px 10px;
    font-family: var(--font-body);
    font-size: 10px;
    color: var(--fg-muted);
    background: linear-gradient(to top, var(--bg-surface) 75%, transparent);
    z-index: 1;
    letter-spacing: 0.2px;
    border-top: 1px solid var(--border);
  }
  .footer .footer-inner {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
    gap: 4px 6px;
    pointer-events: auto;
  }
  .footer .brand-mark { color: var(--brand-700); font-weight: 700; letter-spacing: 0.5px; }
  .footer-sep         { opacity: 0.4; }
  .footer-label       { font-weight: 600; color: var(--fg); }
  .footer-by          { opacity: 0.85; }
  .footer-link {
    font-size: 10px;
    font-family: inherit;
    color: var(--fg-muted);
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    text-decoration: none;
    border-bottom: 1px dotted transparent;
  }
  .footer-link:hover { color: var(--brand-700); border-bottom-color: var(--brand-600); }
  .version-badge {
    font-family: var(--font-mono);
    font-size: 10px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 9999px;
    padding: 1px 8px;
    color: var(--fg-muted);
    cursor: pointer;
    line-height: 1.4;
  }
  .version-badge:hover { color: var(--brand-700); border-color: var(--brand-400); background: var(--card); }
  .version-badge.dim   { opacity: 0.7; cursor: default; }
  .update-btn {
    font-family: var(--font-body);
    font-size: 10px;
    font-weight: 700;
    background: var(--brand-600);
    color: #ffffff;
    border: 1px solid var(--brand-600);
    border-radius: 9999px;
    padding: 2px 10px;
    cursor: pointer;
    letter-spacing: 0.3px;
    transition: background 0.08s, border-color 0.08s, transform 0.06s;
    animation: be-update-pulse 2.4s ease-in-out infinite;
  }
  .update-btn:hover { background: var(--brand-700); border-color: var(--brand-700); transform: translateY(-1px); }
  @keyframes be-update-pulse {
    0%, 100% { box-shadow: 0 0 0 0 var(--brand-soft); }
    50%      { box-shadow: 0 0 0 4px var(--brand-soft); }
  }
</style>
</head>
<body>
${body}
<div class="footer">${footerInner || `<div class="footer-inner"><span class="brand-mark">btrad</span><span class="footer-sep">·</span><span class="footer-label">Branch Explorer</span><span class="footer-sep">·</span><span class="footer-by">made by Michael Walding</span></div>`}</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (e) => {
    // .closest() walks up from the click target and returns the nearest matching
    // element. Buttons inside a clickable row are themselves [data-action], so
    // a click on a button resolves to the BUTTON's action (e.g. 'delete'),
    // not the row's 'checkout'. This is exactly the behavior we want.
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action  = target.getAttribute('data-action');
    const branch  = target.getAttribute('data-branch') || undefined;
    const id      = target.getAttribute('data-id') || undefined;
    const url     = target.getAttribute('data-url') || undefined;
    const filter  = target.getAttribute('data-filter') || undefined;
    const display = target.getAttribute('data-display') || undefined;
    const tab     = target.getAttribute('data-tab') || undefined;

    // Shared / tab control
    if (action === 'switchTab') return vscode.postMessage({ type: 'switchTab', tab });
    if (action === 'refresh')   return vscode.postMessage({ type: 'refresh' });
    if (action === 'pickRepo')  return vscode.postMessage({ type: 'pickRepo' });

    // Branches tab
    if (action === 'fetch')               return vscode.postMessage({ type: 'fetch' });
    if (action === 'checkout')            return vscode.postMessage({ type: 'checkout', branch });
    if (action === 'delete')              return vscode.postMessage({ type: 'delete', branch });
    if (action === 'openPr')              return vscode.postMessage({ type: 'openPr', branch, fromRemote: target.getAttribute('data-from-remote') === '1' });
    if (action === 'pruneGone')           return vscode.postMessage({ type: 'pruneGone' });
    if (action === 'pullBranch')          return vscode.postMessage({ type: 'pullBranch', branch });
    if (action === 'pushBranch')          return vscode.postMessage({ type: 'pushBranch', branch });
    if (action === 'publishBranch')       return vscode.postMessage({ type: 'publishBranch', branch });
    if (action === 'commitCurrent')       return vscode.postMessage({ type: 'commitCurrent' });
    if (action === 'createBranch')        return vscode.postMessage({ type: 'createBranch' });
    if (action === 'openBranchOnGithub')  return vscode.postMessage({ type: 'openBranchOnGithub', branch });

    // Actions tab
    if (action === 'openUrl')             return vscode.postMessage({ type: 'openUrl', url });
    if (action === 'openActionsOnGithub') return vscode.postMessage({ type: 'openActionsOnGithub' });
    if (action === 'viewLogs')            return vscode.postMessage({ type: 'viewLogs', id, displayTitle: display });
    if (action === 'rerunRun')            return vscode.postMessage({ type: 'rerunRun', id, displayTitle: display });
    if (action === 'cancelRun')           return vscode.postMessage({ type: 'cancelRun', id, displayTitle: display });
    if (action === 'watchRun')            return vscode.postMessage({ type: 'watchRun', id });
    if (action === 'installGh')           return vscode.postMessage({ type: 'installGh' });

    // Footer (self-update)
    if (action === 'checkForUpdates')     return vscode.postMessage({ type: 'checkForUpdates' });
    if (action === 'installUpdate')       return vscode.postMessage({ type: 'installUpdate' });
    if (action === 'openRepo')            return vscode.postMessage({ type: 'openRepo' });
    if (action === 'openRelease')         return vscode.postMessage({ type: 'openRelease' });
  });
</script>
</body>
</html>`;
}

// ─── GitHub Actions tab — pure helpers (consumed by renderActionsBody) ─────

function statusIconFor(run) {
  if (run.status === 'in_progress') return { glyph: '⟳', cls: 'st-running',  label: 'running'   };
  if (run.status === 'queued')      return { glyph: '⏳', cls: 'st-queued',   label: 'queued'    };
  if (run.status === 'waiting')     return { glyph: '⏳', cls: 'st-queued',   label: 'waiting'   };
  if (run.status === 'requested')   return { glyph: '⏳', cls: 'st-queued',   label: 'requested' };
  if (run.status === 'completed') {
    switch (run.conclusion) {
      case 'success':         return { glyph: '✓', cls: 'st-success',   label: 'success'   };
      case 'failure':         return { glyph: '✗', cls: 'st-failure',   label: 'failure'   };
      case 'cancelled':       return { glyph: '⊘', cls: 'st-cancelled', label: 'cancelled' };
      case 'skipped':         return { glyph: '→', cls: 'st-cancelled', label: 'skipped'   };
      case 'timed_out':       return { glyph: '⏱', cls: 'st-failure',   label: 'timed out' };
      case 'action_required': return { glyph: '⚠', cls: 'st-warning',   label: 'action req' };
      case 'neutral':         return { glyph: '◌', cls: 'st-cancelled', label: 'neutral'   };
      default:                return { glyph: '?', cls: 'st-cancelled', label: run.conclusion || 'unknown' };
    }
  }
  return { glyph: '?', cls: 'st-cancelled', label: run.status || 'unknown' };
}

function eventLabel(event) {
  switch (event) {
    case 'push':                return 'push';
    case 'pull_request':        return 'PR';
    case 'pull_request_target': return 'PR target';
    case 'workflow_dispatch':   return 'manual';
    case 'workflow_run':        return 'chained';
    case 'schedule':            return 'scheduled';
    case 'release':             return 'release';
    case 'repository_dispatch': return 'dispatch';
    default:                    return event || '';
  }
}

function formatRelative(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const min = Math.floor(diff / 60_000);
  if (min < 1)   return 'just now';
  if (min < 60)  return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)   return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7)   return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5)    return `${wk}w ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12)   return `${mo}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

function formatDuration(startedAt, updatedAt) {
  if (!startedAt) return '';
  const start = Date.parse(startedAt);
  const end = updatedAt ? Date.parse(updatedAt) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return '';
  const sec = Math.floor((end - start) / 1000);
  if (sec < 60)  return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rs = sec % 60;
  if (min < 60) return rs ? `${min}m ${rs}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const rm = min % 60;
  return rm ? `${hr}h ${rm}m` : `${hr}h`;
}

function renderActionsBody(state) {
  // Hard-error states (no cached prior state to fall back on).
  if (state && state.errorKind === 'gh-missing') {
    return `
      <div class="setup">
        <div class="setup-title">GitHub CLI not found</div>
        <div class="setup-body">This panel needs the <code>gh</code> CLI to read workflow runs.</div>
        <div class="setup-actions">
          <button data-action="installGh" class="primary">Install instructions</button>
        </div>
        <div class="setup-hint">After install, run <code>gh auth login</code> in a terminal, then hit Refresh.</div>
      </div>
    `;
  }
  if (state && state.errorKind === 'gh-auth') {
    return `
      <div class="setup">
        <div class="setup-title">GitHub CLI not authenticated</div>
        <div class="setup-body">${escapeHtml(state.message)}</div>
        <div class="setup-actions">
          <button data-action="refresh">Refresh after login</button>
        </div>
      </div>
    `;
  }
  if (state && state.error && !state.runs) {
    return `<div class="error">${escapeHtml(state.error)}</div>`;
  }
  if (!state) {
    return `<div class="empty">No state.</div>`;
  }

  const runs = state.runs || [];
  const summary = `${runs.length} recent run${runs.length === 1 ? '' : 's'}`;
  const warning = state.warning
    ? `<div class="stale" title="Last refresh failed — showing cached data.">⚠ ${escapeHtml(state.warning)}</div>`
    : '';

  const groups = groupRuns(runs);

  const runRows = (groups.length === 0)
    ? `<div class="empty">No recent workflow runs.</div>`
    : groups.map((group) => {
        const groupRows = group.runs.map((r) => {
          const st = statusIconFor(r);
          const dur = formatDuration(r.startedAt || r.createdAt, r.status === 'completed' ? r.updatedAt : null);
          const when = formatRelative(r.updatedAt || r.createdAt);
          const cancelable = r.status === 'in_progress' || r.status === 'queued';
          const rerunnable = r.status === 'completed';

          const cancelBtn = cancelable
            ? `<button class="link danger" data-action="cancelRun" data-id="${r.databaseId}" data-display="${escapeHtml(r.displayTitle || '')}" title="Cancel this run (gh run cancel ${r.databaseId})">Cancel</button>`
            : '';
          const rerunBtn = rerunnable
            ? `<button class="link" data-action="rerunRun" data-id="${r.databaseId}" data-display="${escapeHtml(r.displayTitle || '')}" title="Re-run this workflow (gh run rerun ${r.databaseId})">Re-run</button>`
            : '';
          const watchBtn = (r.status === 'in_progress' || r.status === 'queued')
            ? `<button class="link" data-action="watchRun" data-id="${r.databaseId}" title="Stream live status in a terminal (gh run watch ${r.databaseId})">Watch</button>`
            : '';

          return `
            <div class="run" data-action="openUrl" data-url="${escapeHtml(r.url)}" title="Click to open run #${r.databaseId} on GitHub">
              <div class="run-main">
                <span class="status-dot ${st.cls}" title="${escapeHtml(st.label)}">${st.glyph}</span>
                <span class="run-name" title="${escapeHtml(r.workflowName)} · run #${r.databaseId}${r.attempt > 1 ? ` (attempt ${r.attempt})` : ''}">${escapeHtml(r.workflowName)}</span>
                <span class="status-pill ${st.cls}">${escapeHtml(st.label)}</span>
              </div>
              <div class="run-meta">
                <span class="run-branch" title="Branch this run was triggered on">${escapeHtml(r.headBranch)}</span>
                <span class="meta-sep">·</span>
                <span class="run-event" title="What triggered this workflow">${escapeHtml(eventLabel(r.event))}</span>
                <span class="meta-sep">·</span>
                <span class="run-when" title="${escapeHtml(r.updatedAt || r.createdAt)}">${escapeHtml(when)}</span>
                ${dur ? `<span class="meta-sep">·</span><span class="run-dur" title="How long the run took (started → finished)">${escapeHtml(dur)}</span>` : ''}
                ${r.attempt > 1 ? `<span class="meta-sep">·</span><span class="run-attempt">attempt ${r.attempt}</span>` : ''}
              </div>
              <div class="run-actions">
                <button class="link" data-action="viewLogs" data-id="${r.databaseId}" title="Stream the run log in a terminal (gh run view ${r.databaseId} --log)">Logs</button>
                ${watchBtn}
                ${rerunBtn}
                ${cancelBtn}
              </div>
            </div>
          `;
        }).join('');

        // Group runs by commit so the same push (which usually fires several
        // workflows) collapses into a single visual unit. Only render the
        // header when there's more than one run to group.
        const groupHeader = (group.runs.length > 1)
          ? `<div class="run-group-header" title="${escapeHtml(group.headSha)} on ${escapeHtml(group.headBranch)}">
              <span class="commit-mark">${group.runs.length}×</span>
              <span class="commit-title">${escapeHtml(group.displayTitle || group.headSha.slice(0, 7))}</span>
              <span class="meta-sep">·</span>
              <span class="commit-branch">${escapeHtml(group.headBranch)}</span>
            </div>`
          : '';
        return `<div class="run-group">${groupHeader}${groupRows}</div>`;
      }).join('');

  return `
    <div class="tab-toolbar">
      <button data-action="refresh" title="Re-fetch the latest workflow runs from GitHub">Refresh</button>
      <button data-action="openActionsOnGithub" title="Open the Actions page on GitHub for this repo">Open on GitHub</button>
    </div>
    <div class="row summary">
      <span>${summary}</span>
    </div>
    ${warning}
    <main>${runRows}</main>
  `;
}

function groupRuns(runs) {
  // Group runs by headSha so a single commit's workflows cluster together.
  // Order preserves the first occurrence of each sha (which matches gh's
  // newest-first ordering).
  const order = [];
  const map = new Map();
  for (const r of runs) {
    const key = r.headSha || `${r.headBranch}-${r.createdAt}`;
    if (!map.has(key)) {
      order.push(key);
      map.set(key, { headSha: r.headSha, headBranch: r.headBranch, displayTitle: r.displayTitle, runs: [] });
    }
    map.get(key).runs.push(r);
  }
  return order.map((k) => map.get(k));
}

module.exports = { activate, deactivate };
