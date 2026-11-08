import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['test/unit/**/*.test.ts'], environment: 'node' },
  resolve: { alias: { vscode: new URL('./test/unit/vscode-stub.ts', import.meta.url).pathname } },
});
