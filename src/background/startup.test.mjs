import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const stateModule = `${process.cwd().replaceAll('\\', '/')}/src/background/session-state.ts`;
const bundle = await build({
  entryPoints: ['src/background.ts'],
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'startup-dependencies', setup(builder) {
    builder.onResolve({ filter: /^\.\// }, args => {
      if (!args.importer.endsWith('/src/background.ts') && !args.importer.endsWith('\\src\\background.ts')) return;
      return { path: args.path, namespace: 'startup-mock' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'startup-mock' }, ({ path }) => {
      const modules = {
        './config': 'export const VERSION = "test";',
        './ai/llm-client': 'export const STORAGE_KEY_AI_SETTINGS = "settings", LEGACY_STORAGE_KEY_AI_SETTINGS = "legacy";',
        './lib/legacy-storage': 'export const readMigratedStorage = async () => ({});',
        './lib/channel': `import { dispatchSessionOp } from ${JSON.stringify(stateModule)};
          export default { listen() {
            const h = globalThis.__startupTest;
            h.request = dispatchSessionOp('resume-after-wakeup', () => {
              h.reply = h.sessionsRestored && h.tasksRestored ? 'resumed' : 'missing-session';
            });
          }};`,
        './functions/registry': 'export const ensureToolRegistryReady = async () => {};',
        './background/timer-dispatch': `export const restoreSessionState = async () => {
            const h = globalThis.__startupTest;
            await h.sessionsGate; h.sessionsRestored = true;
          };
          export const restoreRuntimeTimers = async () => { globalThis.__startupTest.timersRestored = true; };`,
        './background/mcp-bridge': 'export const initMcpBridge = () => {};',
        './background/cloud-bridge': 'export const initCloudBridge = () => {};',
        './background/policy-executor': `export const getTaskManager = () => ({ setRunner() {} });
          export const getTaskExecutor = () => ({ recover: async () => {
            const h = globalThis.__startupTest;
            await h.tasksGate; h.tasksRestored = true;
          }});`,
        './background/session-manager': `export { dispatchSessionOp } from ${JSON.stringify(stateModule)};
          export const createSession = () => ({ context: [] });
          export const runSessionNow = async () => {};`,
      };
      return { contents: modules[path] || '', resolveDir: process.cwd(), loader: 'js' };
    });
  }}],
});

test('the first request after worker wakeup waits for session and task recovery', async () => {
  let releaseSessions;
  let releaseTasks;
  const h = globalThis.__startupTest = {
    sessionsGate: new Promise(resolve => { releaseSessions = resolve; }),
    tasksGate: new Promise(resolve => { releaseTasks = resolve; }),
  };
  globalThis.chrome = { runtime: { onInstalled: { addListener() {} } } };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
    await settle();
    assert.equal(h.reply, undefined, 'must not report a missing session during startup');
    releaseSessions();
    await settle();
    assert.equal(h.reply, undefined, 'task recovery must finish before a resumed task can run');
    releaseTasks();
    await h.request;
    await settle();
    assert.equal(h.reply, 'resumed');
    assert.equal(h.timersRestored, true);
  } finally {
    releaseSessions();
    releaseTasks();
    await settle();
    delete globalThis.__startupTest;
    delete globalThis.chrome;
  }
});
