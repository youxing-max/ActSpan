// 跨平台测试入口：`$(find ...)` 在 cmd 下不展开，`--test` 的 glob 要 Node 21+、目录参数在 Node 22 又不受支持，
// 这里自己收集文件再用 spawn 传给 node --test，Node 20（CI）与 Node 22（本机）行为一致。
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const collect = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : collect(path);
  return path.endsWith('.test.mjs') ? [path] : [];
});

const files = [
  ...collect('src'),
  'test/fixtures.test.mjs',
  'test/manifest-recorder.test.mjs',
  'test/scenarios.test.mjs',
];
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
