// Minimal test runner (no mocha): each test is an async function; failures reject run().
const vscode = require('vscode');
const path = require('node:path');
const assert = require('node:assert/strict');

const roms = path.resolve(__dirname, '../../fixtures/roms');

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function api() {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'retroverse');
  assert.ok(ext, 'extension present');
  return ext.activate();
}

const playerTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === 'retroverse.player');

const tests = {
  async 'default: a game opened with Play runs in the RetroVerse view, not an editor tab'() {
    const { sessions } = await api();
    await vscode.workspace.getConfiguration('retroverse').update('player.location', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('retroverse.play', vscode.Uri.file(path.join(roms, 'rv-test.gba')));
    const s = await waitFor(() => sessions.all.find((x) => x.platform === 'gba'), 10000, 'gba session in view');
    await waitFor(() => s.status === 'running', 30000, `gba running in view (status=${s.status})`);
    assert.equal(playerTabs().length, 0, 'no editor tab was opened');
  },

  async 'default: clicking a game file in the Explorer hands it to the view and leaves the editor area free'() {
    const { sessions } = await api();
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(path.join(roms, 'rv-test.nds')), 'retroverse.player');
    const nds = await waitFor(() => sessions.all.find((x) => x.platform === 'nds'), 10000, 'nds session in view');
    await waitFor(() => nds.status === 'running', 40000, `nds running in view (status=${nds.status})`);
    await waitFor(() => playerTabs().length === 0, 3000, 'redirect tab closed');
    // loading a new game in the view stops the previous one
    assert.equal(sessions.all.filter((x) => x.platform === 'gba').length, 0, 'previous (gba) session stopped');
    await vscode.commands.executeCommand('retroverse.closeGame');
    await waitFor(() => sessions.all.length === 0, 10000, 'view session closed');
    await vscode.workspace.getConfiguration('retroverse').update('player.location', 'editor', vscode.ConfigurationTarget.Global);
  },

  async 'GBA ROM opens in the custom editor and reaches running'() {
    const { sessions } = await api();
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(path.join(roms, 'rv-test.gba')), 'retroverse.player');
    const s = await waitFor(() => sessions.all.find((x) => x.platform === 'gba'), 10000, 'gba session');
    await waitFor(() => s.status === 'running', 30000, `gba running (status=${s.status})`);
    assert.equal(s.capabilities.saveStates, true);
    const r = await sessions.run('quickSave');
    assert.equal(r.ok, true, `quickSave: ${r.message ?? r.error}`);
    const l = await sessions.run('quickLoad');
    assert.equal(l.ok, true, `quickLoad: ${l.message ?? l.error}`);
    const p = await sessions.run('pause');
    assert.equal(p.ok, true);
    await waitFor(() => s.status === 'paused', 5000, 'paused');
    await sessions.run('resume');
    await waitFor(() => s.status === 'running', 5000, 'resumed');
  },

  async 'NDS ROM opens and reaches running'() {
    const { sessions } = await api();
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(path.join(roms, 'rv-test.nds')), 'retroverse.player');
    const s = await waitFor(() => sessions.all.find((x) => x.platform === 'nds'), 10000, 'nds session');
    await waitFor(() => s.status === 'running', 40000, `nds running (status=${s.status})`);
    const r = await sessions.run('quickSave');
    assert.equal(r.ok, true, `quickSave: ${r.message ?? r.error}`);
  },

  async 'Switch: missing Eden shows setup and launches nothing'() {
    const { sessions } = await api();
    const cfg = vscode.workspace.getConfiguration('retroverse');
    await cfg.update('switch.edenPath', '/nonexistent/eden-cli', vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(path.join(roms, 'stub.nsp')), 'retroverse.player');
    const s = await waitFor(() => sessions.all.find((x) => x.platform === 'switch'), 10000, 'switch session');
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(s.status, 'idle', `switch status should stay idle without Eden, got ${s.status}`);
    assert.equal(s.capabilities.saveStates, false, 'no save states for Switch');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor(() => sessions.all.length === 0, 10000, 'switch session disposed');
  },

  async 'security: a workspace cannot choose the Eden executable'() {
    const fs = require('node:fs');
    const os = require('node:os');
    const { sessions } = await api();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-ws-eden-'));
    const marker = path.join(dir, 'ran.txt');
    const evil = path.join(dir, 'eden-cli');
    fs.writeFileSync(evil, `#!/bin/sh\necho ran > '${marker}'\nexec sleep 30\n`);
    fs.chmodSync(evil, 0o755);
    // The repository's .vscode/settings.json points edenPath at its own program...
    const wsDir = vscode.workspace.workspaceFolders[0].uri.fsPath;
    fs.mkdirSync(path.join(wsDir, '.vscode'), { recursive: true });
    const wsSettings = path.join(wsDir, '.vscode', 'settings.json');
    fs.writeFileSync(wsSettings, JSON.stringify({ 'retroverse.switch.edenPath': evil, 'retroverse.switch.environment': { DYLD_INSERT_LIBRARIES: '/tmp/x.dylib' } }));
    // ...while the user's own setting points at an Eden that does not exist (so nothing real launches).
    const cfg = vscode.workspace.getConfiguration('retroverse');
    await cfg.update('switch.edenPath', '/nonexistent/eden-cli', vscode.ConfigurationTarget.Global);
    await new Promise((r) => setTimeout(r, 500));
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(path.join(roms, 'stub.nsp')), 'retroverse.player');
    const s = await waitFor(() => sessions.all.find((x) => x.platform === 'switch'), 10000, 'switch session');
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(fs.existsSync(marker), false, 'the workspace-chosen executable must never run');
    assert.equal(s.status, 'idle', `expected the "Eden not found" setup (user setting is invalid), got ${s.status}`);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor(() => sessions.all.length === 0, 10000, 'session disposed');
    fs.rmSync(path.join(wsDir, '.vscode'), { recursive: true, force: true });
    await cfg.update('switch.edenPath', undefined, vscode.ConfigurationTarget.Global);
  },

  async 'Switch: fake Eden is launched with an argv array and killed on close'() {
    const fs = require('node:fs');
    const os = require('node:os');
    const { sessions } = await api();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-fake-eden-'));
    const exe = path.join(dir, 'eden-cli');
    const argsFile = path.join(dir, 'args.txt');
    const pidFile = path.join(dir, 'pid.txt');
    // --version probe exits immediately; a real launch records argv + pid and stays alive.
    fs.writeFileSync(exe, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-eden 1.0"; exit 0; fi\nprintf '%s\\n' "$@" > '${argsFile}'\necho $$ > '${pidFile}'\nexec sleep 60\n`);
    fs.chmodSync(exe, 0o755);
    const cfg = vscode.workspace.getConfiguration('retroverse');
    await cfg.update('switch.edenPath', exe, vscode.ConfigurationTarget.Global);
    await cfg.update('switch.streamMode', 'external', vscode.ConfigurationTarget.Global);
    const rom = path.join(roms, 'stub.nsp');
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(rom), 'retroverse.player');
    const s = await waitFor(() => sessions.all.find((x) => x.platform === 'switch'), 10000, 'switch session');
    await waitFor(() => s.status === 'running', 15000, `fake eden running (status=${s.status})`);
    const args = (await waitFor(() => fs.existsSync(argsFile) && fs.readFileSync(argsFile, 'utf8'), 5000, 'argv')).trim().split('\n');
    assert.deepEqual(args, ['--game', fs.realpathSync(rom)]);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal((await sessions.run('pause')).ok, true);
    await waitFor(() => s.status === 'paused', 3000, 'paused');
    assert.equal((await sessions.run('resume')).ok, true);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor(() => sessions.all.length === 0, 10000, 'switch session disposed');
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await waitFor(() => !alive(), 6000, 'fake eden process terminated');
    await cfg.update('switch.streamMode', undefined, vscode.ConfigurationTarget.Global);
    await cfg.update('switch.edenPath', undefined, vscode.ConfigurationTarget.Global);
  },

  async 'closing the editor stops the session'() {
    const { sessions } = await api();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor(() => sessions.all.length === 0, 10000, `sessions disposed (left: ${sessions.all.map((s) => s.platform + ':' + s.status)})`);
  },
};

exports.run = async function run() {
  const failures = [];
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.log(`  ✗ ${name}\n    ${e && e.stack ? e.stack : e}`);
      failures.push(name);
    }
  }
  if (failures.length) throw new Error(`${failures.length} integration test(s) failed`);
};
