// Runs the integration suite inside a real VS Code (the locally installed one if present,
// otherwise @vscode/test-electron downloads a build).
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const local = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const workspace = path.join(root, 'test', 'fixtures', 'roms');
// When launched from inside VS Code (e.g. an integrated terminal), this would make the test instance run as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;
try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'test', 'integration', 'suite', 'index.cjs'),
    ...(existsSync(local) && !process.env.VSCODE_DOWNLOAD ? { vscodeExecutablePath: local } : {}),
    launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', `--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), 'rv-vscode-'))}`],
  });
} catch (e) {
  console.error('integration tests failed', e);
  process.exit(1);
}
