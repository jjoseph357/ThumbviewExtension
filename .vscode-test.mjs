// Integration tests (npm test) run inside a downloaded VS Code against a freshly generated demo
// workspace, with a clean user profile that opens no Welcome tab. Only src/test/integration runs
// here; the other src/test files are plain node scripts run by `npm run test:unit`.
import { defineConfig } from '@vscode/test-cli';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'thumbview-it-'));
const workspaceFolder = join(scratch, 'demo');
execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['scripts/generate-demo-workspace.py', workspaceFolder]);

const userDataDir = join(scratch, 'user-data');
mkdirSync(join(userDataDir, 'User'), { recursive: true });
writeFileSync(join(userDataDir, 'User', 'settings.json'), JSON.stringify({
	'workbench.startupEditor': 'none',
	'workbench.tips.enabled': false,
	'extensions.ignoreRecommendations': true
}));

export default defineConfig({
	files: 'out/test/integration/**/*.test.js',
	workspaceFolder,
	launchArgs: ['--user-data-dir', userDataDir, '--disable-extensions', '--disable-workspace-trust'],
	mocha: { timeout: 60000 }
});
