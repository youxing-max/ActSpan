// 跨平台真机测试入口：cmd.exe 不支持 `VAR=1 node ...` 前缀写法，这里用 spawn 传环境变量。
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), 'test/scenarios.test.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, ACTSPAN_LIVE: '1' },
});
process.exit(result.status ?? 1);
