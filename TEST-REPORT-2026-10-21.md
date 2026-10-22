# ActSpan 测试报告（2026-10-21）

- 测试时间：2026-10-21 21:53–2026-10-22 01:15（本地）
- 分支：`main`
- 运行环境：macOS (darwin 23.6.0)，Node `v22.20.0` / `v20.20.2`
- 说明：测试期间工作区有**另一个进程/会话在持续修改代码**（快照时 `git status` 有 110 项变更）。01:07 后 `mcp-server/install.js` 与 `test/install.mjs` 又有新修改（修复 2.19–2.22）。本报告结论基于 2026-10-22 01:15 左右的文件状态，合并前请复跑。

## 一、结论摘要

| 项目 | 结果 |
|---|---|
| 根目录单测/集成 `npm test` | 最终状态 **479 tests / 458 pass / 21 skip / 0 fail**，默认 **21.8s**；其中 16s 耗在 2.23 的失效 mock 上（修复后应回到 ~7s） |
| 离线模式（`ACTSPAN_BRIDGE_URL=ws://127.0.0.1:9`） | 此前快照 **479 / 458 / 21 / 0**，6.4s；连续 10 次全部通过（之后仅 install 文件变更） |
| 临时 `HOME` + `ACTSPAN_STATE_DIR` 运行 | **479 / 458 / 21 / 0**，21.8s；真实 `~/.actspan` 文件数 **101→101**，临时状态目录 0 残留 |
| 同上，Node 20.20.2 复跑 | **441 tests / 420 pass / 21 skip / 0 fail**（较早快照） |
| mcp-server `npm test` | **100 pass / 0 fail**，约 2.0s；干净 HOME 同样 100/100；但每轮遗留 1 个 daemon（见 2.15，01:08 又新增 1 个） |
| 同上，Node 20.20.2 复跑 | **100 pass / 0 fail** |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过；manifest 引用的 8 个产物全部存在，产物 3.0MB / 25 文件，无 sourcemap、TS 源码、`eval`、`new Function`、远程脚本；HTML 引用的 assets/chunks 齐全 |
| `npm run lint` | **已修复**：0 error + 296 warnings，退出码 0 |
| mcp-server `npm run check:docs` | 通过（34 tools，missing=0 extra=0） |
| 根目录 `npm run docs:build` | **已修复**：通过（3.46s）；并发修改已消除三处非法标签 |
| mcp-server `npm run test:install` | 默认 HOME：**27 pass / 0 fail**；干净 HOME：**25 pass / 2 fail**（见 2.14）；2.19–2.22 回归用例通过，但缺少 TOML 二次安装用例（2.24） |
| 安装器边界（手工） | 2.19–2.22 **已修复并复验**；但 TOML 二次安装误判、`--force` 写出重复 `.env` 表（2.24，P2 回归），JSON 路径正常 |
| mcp-server `npm run test:e2e` | 全部通过；当前版本退出前会停桥并删除临时状态目录，本轮未新增遗留进程 |
| `npm run test:omp-compat` | 通过 |
| CLI 冒烟（doctor/install/bridge） | `--help`、`bridge status/usage/stop`、未知命令均符合预期；`doctor --json` stdout 混入人类文案（2.13）；非法 `--port`/`--origins-json` 被静默接受（2.16）；`install --apply --yes` 未配对时空等 120s（2.17）；2.19–2.22 已修复 |
| 依赖审计（全部） | root：**13 high / 2 moderate / 0 critical**（较 25 high 已下降）；mcp-server：**0 vulnerabilities**（SDK 1.32.1、ws 8.22.0） |
| 依赖审计（root 仅生产依赖） | **2 high / 0 critical**：`@ant-design/pro-layout` → `path-to-regexp` |
| 测试可达性静态分析 | 180 个源码模块中 **155 个可从测试依赖图到达，25 个不可达**（见 2.8） |
| `npm pack --dry-run`（root） | **398 文件 / 1.59MB**，包含 `src`、`docs`、`.github/workflows`、`.superpowers`、`CLAUDE.md`、本测试报告；根包未设 `private`（见 2.11） |
| mcp-server 包可安装性 | `npm pack` + 临时目录 `npm install <tgz>` 通过；`actspan-doctor/install/bridge` 三个 bin 均可运行（39 文件 / 90KB） |
| npm 发布状态 | **`@actspan/mcp-server` 未发布（registry 404）**；`--from-npm` 生成的配置无法启动，release 无 `npm publish`（见 2.18） |
| LICENSE 检查 | 通过（AGPL-3.0 头存在） |
| gitleaks 密钥扫描 | 本地未安装，未执行（CI 使用 `gitleaks-action`） |

功能测试整体健康：lint、依赖审计、测试隔离、live 开关、文档构建都已收口。但安装器刚修复的 2.19–2.22 引入了 **2.24 TOML 回归**（Codex 二次安装失败，`--force` 会写坏配置），应优先处理；其余问题集中在覆盖率、打包/发布卫生、CLI 契约、测试假绿和可移植性。

## 二、问题清单

### 2.1【已修复，原 P0】lint 报 `no-control-regex`

> 复核状态：`npm run lint` 当前为 **0 error / 296 warnings，退出码 0**。并发修改已把正则改成 `/[\p{Cc}\s]/gu`（即下面的推荐方案），此项不再阻塞 CI。保留记录供追溯。

- 文件：`src/content/float-ball/markdown.ts:24`
- 代码：

  ```ts
  const compact = decoded.replace(/[\u0000-\u001f\u007f\s]/g, '');
  ```

- 修复前的现象：`npm run lint` 退出码 1，CI 流水线的 `Lint` 步骤会直接失败：

  ```
  24:35  error  Unexpected control character(s) in regular expression: \x00, \x1f  no-control-regex
  ```

- 根因：这里**有意**过滤 URL 中的控制字符，用于防御 `java\nscript:` 一类绕过；规则本身没有错，但需要显式处理。
- 修复建议（任选其一，推荐第 1 个）：
  1. 改用 Unicode 属性转义，已验证可通过该规则：

     ```ts
     const compact = decoded.replace(/[\p{Cc}\s]/gu, '');
     ```

  2. 保留原正则，加豁免并写明理由：

     ```ts
     // eslint-disable-next-line no-control-regex -- 有意剥离 URL 中的控制字符，防止协议变形绕过
     const compact = decoded.replace(/[\u0000-\u001f\u007f\s]/g, '');
     ```

  3. 改成非正则过滤：逐字符判断 `codePointAt(0) > 0x1f && !== 0x7f && !/\s/u.test(ch)`。
- 建议同时补一个用例，覆盖 NUL、换行、`java\tscript:` 等变形输入。

### 2.2【已修复，原 P1】mcp-server `stopBridge` 用例曾偶发失败

> 复核状态：并发修改已实现隔离——`mcp-server/bridge-lock.js:22-23` 支持 `ACTSPAN_STATE_DIR`，`test/bridge-lock.mjs:15-16` 使用 `mkdtempSync` 并在进程退出时清理，端口选择显式排除 `30121`/`31921`。复核时单文件连续 **20 次 0 失败**，mcp-server 全量套件多次 **100/100**。保留记录供追溯。

- 文件：`mcp-server/test/bridge-lock.mjs:100`（断言在约 111 行）
- 修复前现象：在一次完整 `npm test` 中出现：

  ```
  not ok 35 - stopBridge only signals the pid recorded in bridge.json
  duration_ms: 150.5
  expected: true
  actual:   false
  ```

  失败用时仅 150ms，说明是 `stopBridgeDaemon` 提前返回（`not_running` / `pid_mismatch`），不是 5s 超时。
- 修复前的可能根因：
  1. 测试用 `30000 + Math.random() * 20000` 选端口，**包含 30121**，而开发者机器上 30121 正在运行真实桥守护进程；一旦撞端口，测试会覆盖真实 `bridge.json`，并在 finally 中删除它。
  2. 测试直接使用真实 `~/.actspan`（`bridgePaths` 基于 `os.homedir()`），与其他测试文件、另一个 checkout 共享状态。
  3. 全量套件并行运行时，`ps` 探测或子进程启动可能瞬时报错，导致 `isBridgeProcess` 返回 false。
- 仍可加强（非阻塞）：断言信息带上 `parsed.reason` 和 `parsed.pid`；涉及真实信号的用例可加 `{ concurrency: false }`。

### 2.3【性能问题已修复，仍有 CI 覆盖缺口】21 个真机场景默认跳过

> 复核状态：`test/scenarios.test.mjs:112` 已加入 `ACTSPAN_LIVE !== '1'` 的快速失败门禁，`package.json` 也提供了 `test:live`。不带任何环境变量运行 `npm test` 当前为 **479/458/21/0**；耗时从 7s 涨到 **21.8s**，原因不是真机等待，而是 2.23 的 mock 空等 16s。

- 文件：`test/scenarios.test.mjs`、`package.json`（`test:live`）
- 仍然存在的缺口：CI 和默认本地测试中，21 个 S5 真机用例固定跳过；真实浏览器链路（点击、iframe、shadow DOM、上传、凭证脱敏等）仍未被自动验证。
- 建议：
  1. 保留 `ACTSPAN_LIVE=1` 显式开关（已实现），默认快速跳过；
  2. 用 `npm run test:live` 做人工/本地真机验收（已实现）；
  3. 若要进 CI，需要一个可自动审批的测试扩展或 headless Chrome + 固定审批策略的 harness；
  4. 在 `before()` 里先探测「审批通道是否可用」，不可用立即跳过。

### 2.4【P2，安全】依赖 high 已大幅收敛，root 生产依赖仍有 2 个

> 复核状态：mcp-server 已升级 `@modelcontextprotocol/sdk` 1.32.1、`ws` 8.22.0，`npm audit` 为 **0 vulnerabilities**。

- root 全量（`npm audit`）：**13 high / 2 moderate / 0 critical**（此前 25 high）。high 主要是开发链路：`@typescript-eslint/*`、`braces`、`fast-glob`、`globby`、`micromatch`、`minimatch`、`vite`。
- root **仅生产依赖**（`npm audit --omit=dev`）：**2 high**，实际是同一条链：`@ant-design/pro-layout` → `path-to-regexp`（多个 wildcard 导致 ReDoS / 顺序可选组 DoS）。这部分会随扩展打包。
- 说明：CI 目前用 `--audit-level=critical`，所以不会失败；但生产依赖中的 ReDoS 仍值得处理。
- 修复建议：
  1. 升级 `@ant-design/pro-layout`（或锁定其 `path-to-regexp` 到已修复版本），复跑 `npm run build` 与 options 页冒烟；
  2. 升级 `vite`、`micromatch`、`minimatch`、`fast-glob` 等开发依赖；
  3. 清理到 0 high 后，把 CI 审计门槛从 `critical` 收到 `high`；
  4. 接入 Dependabot/Renovate，避免再次积压。

### 2.5【已修复，需清理历史遗留】测试隔离与守护进程

> 复核状态：当前代码已实现预期修复——`bridgePaths()` 支持 `ACTSPAN_STATE_DIR`；`test/e2e.mjs:185-188` 在退出前调用 `stopBridgeDaemon({ port })` 并 `rmSync(home)`；`test/bridge-lock.mjs` 使用临时状态目录并在 exit 清理。复核时用临时 `HOME` + `ACTSPAN_STATE_DIR` 跑完整套件 **479/458/21/0**，真实 `~/.actspan` 文件数保持 **101→101**、临时状态目录 0 残留；e2e 运行后 daemon 数量未新增（泄漏来自 mcp 套件，见 2.15）。**但 mcp 全量套件仍每轮遗留 1 个 daemon，见 2.15。**

- 历史遗留（仍在本机）：
  - 14 个本 checkout 的测试遗留 `bridge-daemon.js`（22:13–01:08 启动），端口：37190、61627、42848、37344、61719、34278、37345、61849、61954、62649、50664、50762、56072、56686；
  - 另有 20:35 遗留的 55681；30121 是当前真实桥，不应误杀；
  - `~/.actspan` 已有 **101 个文件**，包含大量测试遗留的 `bridge-<随机端口>.log/.lock`。
- 建议：
  1. 清理上述历史进程与日志（用项目自己的 `stopBridgeDaemon` 或按 PID 终止，避免影响 30121 上的真实桥）；
  2. 在 `npm test` 脚本里默认设置 `ACTSPAN_STATE_DIR`（或 `HOME`）到临时目录，形成双保险；
  3. 提供 `npm run clean:state` 清理历史遗留日志。

### 2.6【P2，可移植性】`npm test` 的 `find` 在 Windows cmd 下不可用

- 文件：`package.json:26`
- 当前脚本：

  ```json
  "test": "node --test $(find src -name '*.test.mjs') test/fixtures.test.mjs test/manifest-recorder.test.mjs test/scenarios.test.mjs"
  ```

- 说明：该写法修复了此前 sh 下 `src/**/*.test.mjs` 只展开一层、漏跑 4 个测试文件（12 个用例）的问题；CI 是 Ubuntu + sh，工作正常。
- 风险：Windows 开发者直接用 cmd/PowerShell 跑 `npm test` 时，命令替换和 `find` 都不可用。
- 修复建议：
  1. 增加 `scripts/list-tests.mjs`，用 Node 枚举测试文件后 `spawn(node --test ...)`；
  2. 或在文档中明确要求 Windows 使用 WSL/Git Bash；
  3. 不要在 Node 20 上依赖 `node --test` 的 glob 参数（Node 21+ 才支持）。

### 2.7【P3】296 条 lint warning

- 绝大多数是 `@typescript-eslint/no-explicit-any`，集中在 `src/options/pages/*`、`src/types/index.ts`、`src/background/*`。
- 不影响 CI（只统计 error），但会淹没新告警。
- 建议：分批把 `any` 换成 `unknown` + 收窄，或在 ESLint 里先降级为 warning 并设置 warning 上限，防止继续增长。

### 2.8【P2，覆盖率】25 个源码模块不在任何测试的依赖图中

- 方法：以所有 `*.test.mjs` 中直接引用的源码为根，按相对 import 递归建图；180 个 `src/**/*.ts(x)` 中 **155 个可达，25 个不可达**。这是静态近似，不含动态 import / 字符串拼接路径，但足以定位明显盲区。
- 主要不可达模块（按风险排序）：
  - `src/background/session-channel-handlers.ts`（805 行）——会话 Channel 消息处理，仅由 `background.ts` 副作用导入；
  - `src/background/workflow-recorder.ts`（522 行）——录制编排，仅由 `background.ts` 导入（现有测试只覆盖 `workflow-recorder-prompt/save` 子模块）；
  - `src/content/page-parser.ts`（248 行）、`src/content/action-executor.ts`（71 行）——页面解析与动作执行，仅由 `content.ts` 导入；
  - `src/content/page-skeleton.ts`（462 行）——仅由 `content.ts` 导入；
  - `src/background/timer-dispatch.ts`（240 行）、`channel-handlers.ts`（245 行）、`bg-tasks-manager.ts` 等后台装配模块；
  - `src/options/**`、`src/App.tsx`、`src/main.tsx`、`src/sidepanel.tsx` 等 UI 入口；
  - `src/vite-env.d.ts` 为纯类型声明，可忽略。
- 覆盖率的度量限制：测试用 esbuild 把 `.ts` 打包成 `data:` 模块且未生成 sourcemap，Node `--experimental-test-coverage` 只能统计到测试 bundle 本身（报告显示 all files 92.49%，但不是源码覆盖率）。若要真实源码覆盖率，建议在测试的 `build({...})` 中加 `sourcemap: 'inline'`，再配合 `c8` / Node coverage。
- 建议：
  1. 优先给 `session-channel-handlers`、`workflow-recorder`、`page-parser`、`action-executor` 补单测；
  2. UI 层至少补一个 Playwright/Chrome 扩展冒烟；
  3. 在 CI 中启用源码覆盖率门槛（例如行覆盖 ≥80%），防止继续下滑。

### 2.9【P3，测试质量】部分用例直接替换全局对象，存在时序脆弱性

- 文件：`src/functions/data-tools.test.mjs:139`、`:291`
- 现象：这两个 fetch 用例会整体替换 `globalThis.setTimeout` 和 `chrome.tabs / chrome.scripting / chrome.runtime`，并在 `finally` 中恢复。在 22:10 的一次覆盖率运行中两者同时失败（`false !== true`），随后隔离运行 5/5、全量运行 1/1 均通过；当时 `src/functions/fetch-url.ts` 正被并发修改（22:10:43），因此无法确认是测试时序问题还是源码中间态。
- 补充（2026-10-22 00:20）：对 `data-tools.test.mjs` 做 20 次压力复跑，出现 1 次 `paginate rejects loopback...` 失败（`validate()` 对 `/password` 返回 `null`）；随后 50 次全部通过。失败窗口内 `src/functions/paginate.ts` 刚被并发修改（00:19:12）、测试文件也在 00:21:27 被改，判断仍是**源码中间态**，未能稳定复现。另对 `mcp-bridge.test.mjs`、`actspan-branding.test.mjs`、`tab-navigate-ssrf.test.mjs` 各做 20 次压力复跑，均 **0 失败**。
- 风险：覆盖 instrumentation 会让执行变慢，若实现依赖「定时器与 microtask 的先后顺序」，替换全局 `setTimeout` 的写法容易被放大成偶发失败；同时全局替换一旦遗漏恢复，会污染同文件后续用例。
- 建议：
  1. 用 `t.mock.timers` / 注入 clock，而不是替换 `globalThis.setTimeout`；
  2. `chrome.*` 通过依赖注入或 `t.mock` 替换，避免直接改全局；
  3. 在 `finally` 中逐项断言已恢复（或使用支持自动恢复的 mock 机制）；
  4. 该文件可显式设置 `concurrency: false`，降低与全局状态相关的复杂度。

### 2.10【已修复，原 P2】`docs:build` 曾因 Markdown 尖括号被当成 Vue 标签而失败

> 复核状态：`npm run docs:build` 现在 **通过（3.26s）**。并发修改已把三处非法尖括号改成 `Map（number → SessionTabRecord）`、`.bak-TIMESTAMP` 等写法。保留记录供追溯。

- 命令：`npm run docs:build`（复核时已加入 CI，见 `ci.yml:34`）
- 报错：

  ```text
  [vite:vue] docs/spec/actspan-gap-matrix.md (903:135): Element is missing end tag.
  ```

- 原因：VitePress 会把 Markdown 编译成 Vue 模板。以下三处尖括号**没有包在反引号里**，被 Vue 编译器当作未闭合的自定义标签：
  - `docs/spec/actspan-gap-matrix.md:181`：`Map<number, SessionTabRecord>`
  - `docs/spec/actspan-gap-matrix.md:188`：`actspan-virtual-cursor-<hook>`
  - `docs/spec/actspan-gap-matrix.md:240`：`.bak-<ts>`
- 已用脚本扫描全部 `docs/**/*.md`，排除代码块与行内代码后，仅这三处属于非法标签；其余 `<script setup>`、`<Badge>`、`<div>` 等是合法的 Vue 组件/HTML。
- 当时的修复建议：把三处内容改成行内代码（加反引号）或把 `<` 写成 `&lt;`。已在临时副本中验证仅这三处加反引号即可通过；最终并发修改采用了可读占位文本的写法。
- CI 现已加入 `npm run docs:build`，可防止同类问题再次进入主分支。

### 2.11【P3，发布卫生】根包未设 `private`，`npm pack` 会带上 CI 配置与内部文档

- 文件：`package.json`
- 现状：根包既没有 `"private": true`，也没有 `files` 白名单和 `.npmignore`。`npm pack --dry-run` 结果是 **398 个文件 / 1.59MB**，包括：
  - `src` 242、`docs` 52、`mcp-server` 40、`test` 13、`zh` 12、`public` 11；
  - `.github/workflows/*` 3 个 CI 文件、`.superpowers` 2 个；
  - `CLAUDE.md`、`AGENTS.md`、`TEST-REPORT-2026-10-21.md`、`audit-rounds.md`、`query.md` 等内部文档。
- 风险：`npm view actspan-extension` 返回 404，说明名称未被占用；一次误执行的 `npm publish` 就会把 CI 配置、内部工作流文档和测试报告公开发布。
- 修复建议：
  1. 根包加 `"private": true`（扩展本身不需要作为 npm 包发布，推荐）；
  2. 如确有发布需求，加 `files` 白名单，并显式排除 `.github`、`docs`、`test`、内部 md；
  3. 在 CI 或 `prepublishOnly` 中增加 `npm pack --dry-run` 内容检查。
- mcp-server 包：39 文件 / 90KB，未发现 `.env`、`node_modules` 等危险路径，可接受；可再加 `files` 减少测试夹具。

### 2.12【P3，CI/发布】CI 覆盖不全，发布工作流缺少测试门禁

- 相关文件：`.github/workflows/ci.yml`、`.github/workflows/node.js.yml`、`.github/workflows/release.yml`
- 现状：
  - `ci.yml` 在 Node 20 上跑 typecheck/build/docs/lint/单测/mcp 测试/文档漂移检查；
  - `node.js.yml` 在 Node 20 + 22 上又跑一遍 build + 单测 + mcp 测试，两个工作流在相同的 `push`/`pull_request` 上重复触发；
  - **三个已有脚本没有进入任何 CI**：`mcp-server` 的 `test:install`、`test:e2e`，以及根目录的 `test:omp-compat`；
  - `release.yml` 在 `v*` tag 上直接 `npm run build` 并打包上传 GitHub Release，**没有跑 lint/test/audit**，也不依赖 CI 成功。
- 影响：安装器、真实桥 e2e、OMP 兼容契约只在本地验证；tag 可以指向未通过测试的提交并直接产出发布包。
- 建议：
  1. 合并 `ci.yml` 与 `node.js.yml`，用 `matrix.node-version: [20.x, 22.x]` 一次跑完；
  2. 在 verify job 中加入 `test:install`、`test:e2e`、`test:omp-compat`；
  3. `release.yml` 增加 `needs` 或复用 CI workflow（`workflow_call`），测试/审计通过后再打包；
  4. 发布前执行 `npm audit --audit-level=high`（待 2.4 清理后）。

### 2.13【P2，CLI】`doctor --json` 的 stdout 被人类可读文案污染

> 复核（2026-10-22 01:10）：**仍未修复**。输出仍为「握手正常 · 扩展在线」+ JSON 两行，`JSON.parse(stdout)` 报 `Unexpected token '握'`；本次桥 30121 在线，说明不是「未运行」分支特有的问题。

- 文件：`mcp-server/doctor.js:87`、`:97`
- 复现（临时状态目录、未运行桥）：

  ```bash
  node doctor.js --json --port 39999 >out.txt 2>err.txt
  # stdout:
  # 桥未运行：bridge metadata not found
  # {"version":{...},"identity":{...},"status":{"state":"not_running",...}}
  ```

- 影响：`--json` 的契约是「stdout 只有 JSON」，现在任何 `JSON.parse(stdout)` 都会失败（`Unexpected token '桥'`）。脚本/CI/宿主集成无法稳定解析。
- 根因：`runDoctor()` 内部通过 `output()`（默认 `console.log`）输出人类提示，CLI 在 `--json` 时又往 stdout 写 JSON，两路混在一起。
- 修复建议：
  1. `--json` 模式下把人类提示改到 `stderr`（`console.error`），stdout 只保留一行 JSON；
  2. 或在 CLI 调用 `runDoctor({ output: options.json ? () => {} : console.log })`，JSON 里已包含 `status.message`；
  3. 增加一个断言 `JSON.parse(stdout)` 的 CLI 测试。
- 其余 CLI 冒烟均正常：`doctor --help`、`install --help`、`bridge status/usage/stop`（未运行端口）、未知命令退出码 1 且带 usage，均符合预期。

### 2.14【P2，测试隔离】`test:install` 依赖真实宿主配置，干净 HOME 下 2 个用例失败

- 文件：`mcp-server/test/install.mjs:76-88`
- 复现：

  ```bash
  cd mcp-server
  HOME=$(mktemp -d) ACTSPAN_API_URL='' ACTSPAN_API_KEY='' npm run test:install
  # 01:10 复核：tests 27 / pass 25 / fail 2
  ```

- 失败详情（01:10 复核仍相同）：
  - `installer CLI runs local-only without the control-plane environment`（`:76`）：期望退出码 0，实际 1（`未探测到受支持的 MCP 配置`）；
  - `installer refuses a caller-supplied extension id that drifts from the manifest key`（`:86`）：期望错误匹配 `/扩展 ID 不匹配/`，实际先报「未探测到受支持的 MCP 配置」。
- 根因：`test:install` 继承真实 `process.env`，用例依赖开发者机器上已存在的 MCP 宿主配置（如 `~/.claude.json`）才能发现 host；CI 的干净 runner 上没有这些文件，因此必失败。
- 已验证修复方向：在同一临时 HOME 中预置 `~/.claude.json`（内容 `{"mcpServers":{}}`）后，`test:install` **27/27 通过**，说明只要测试自建宿主配置即可完全隔离。
- 影响：这正是 `test:install` 至今没进 CI 的原因之一（见 2.12）；一旦按建议加入 CI，会立即红。
- 修复建议：
  1. 测试内创建临时宿主配置（通过 `HOME`/`XDG_CONFIG_HOME` 或显式配置路径）再跑 CLI，保证可发现 host；
  2. 明确 `--dry-run` 在「0 个 host」时的契约：建议退出 0 并输出「未发现可配置宿主」，而不是抛错；
  3. 给安装器提供 `--config PATH` 或 `ACTSPAN_INSTALL_CONFIG` 之类的测试入口，避免依赖 home 扫描。

### 2.15【P2，测试隔离】mcp 全量套件每轮遗留 1 个 `bridge-daemon`

- 受控复现：

  ```bash
  cd mcp-server
  ps ... > before.txt
  HOME=$(mktemp -d) npm test      # 100/100 通过
  ps ... > after.txt               # 新增 1 个 bridge-daemon
  ```

  本轮新增进程为孤儿：`--port 50762`，父进程退出后仍存活。01:08 再跑一次 `npm test` 后又新增 `--port 56686`；当前本机共有 **16 个** `bridge-daemon`（其中 2 个属于另一个 checkout `project/ActSpan`，30121 是真实桥）。
- 来源：`test/lifecycle.mjs:184` 的 `closing MCP stdio preserves daemon-owned listener and metadata`。该用例故意启动 `index.js`（它会 spawn 一个 `detached` 的 daemon），断言关闭 MCP stdio 后 listener/metadata 仍在，然后 kill 掉 MCP 子进程、删除 lock/metadata，**但没有停止 daemon 本身**。
- 影响：
  - 每跑一次 mcp-server 全量测试就多一个常驻 node 进程；本机已累计 14 个本 checkout 的测试遗留 daemon（端口 37190、61627、42848、37344、61719、34278、37345、61849、61954、62649、50664、50762、56072、56686）；
  - 若 `HOME` 指向临时目录，metadata 已随目录删除，之后无法通过 `bridge-cli stop` 正常停止，只能按 PID 处理。
- 修复建议：
  1. 在该用例的 `t.after` 中、删除 metadata 之前调用 `stopBridgeDaemon({ port })`（或读取 metadata.pid 后 `SIGTERM`）；
  2. 给该用例单独设置 `ACTSPAN_STATE_DIR`，确保可定位并清理；
  3. 增加「套件结束后无新增 daemon」的守护断言（可用 `ps` 或 metadata 目录检查）。

### 2.16【P3，CLI 参数校验】非法端口、origins JSON 与默认 `start` 的静默行为

> 复核（2026-10-22 01:11）：**仍未修复**。`doctor --port 0/-1/1.5/70000/abc/缺值` 全部 exit 0；`start --port 39997 --origins-json '[bad'` 仍返回 `ok:true`、`origins:[]`、`rpcReady:true`；`bridge-cli.js --port 39998 --help` 仍拉起 daemon（已用临时状态目录并 stop 回收）。

- 实测 `doctor.js` 对以下输入全部 **退出码 0**，只输出「桥未运行」：
  `--port 0`、`--port -1`、`--port 1.5`、`--port 70000`、`--port abc`、`--port`（缺值，得到 `NaN`）。
  同期 `bridge-cli.js` 对非法端口会正确返回 `{"ok":false,"error":"Invalid bridge port: ..."}` + 退出码 1，两者行为不一致。
- `mcp-server/bridge-cli.js:10-11`：

  ```js
  let pairOrigins = [];
  try { pairOrigins = JSON.parse(valueOf('--origins-json') ?? '[]'); } catch { pairOrigins = []; }
  ```

  `--origins-json '[bad'` 或 `--origins-json '{"x":1}'` 不会报错，而是退化成空数组。实测 `start --port 39998 --origins-json '[bad'` 返回 `ok:true`、`state:"running"`、`origins:[]`、`rpcReady:true`；`bridge.js:459-460` 的 `allowPair()` 对空集合恒为 false，结果是桥启动了但**任何扩展都无法配对**，用户只能看到连接被拒。随后 `stop --port 39998` 可正常回收，无残留进程。
- 修复建议：
  1. 抽出共享的端口校验（`Number.isInteger(port) && 0 < port <= 65535`），`doctor` 非法时写 stderr 并退出 1；
  2. `--origins-json` 解析失败或不是 `string[]` 时直接报错退出，不要静默降级；
  3. 启动前按 `^chrome-extension://[a-p]{32}$` 校验每个 origin，并拒绝空 allowlist（或要求显式 `--allow-any`）。
- 同一文件的命令判定也有 footgun（`mcp-server/bridge-cli.js:5`）：

  ```js
  const command = (args[0] && !args[0].startsWith('--') ? args[0] : 'start').toLowerCase();
  ```

  - `bridge-cli.js --help` 没有帮助分支，会被当成 `start`；实测 `bridge-cli.js --port 39998 --help` 直接拉起 daemon（exit 0，输出 `command:"start"`）；
  - `bridge-cli.js --port 39999 status` 因为首参是 `--port`，同样会执行 `start`，**静默拉起一个 daemon**；
  - 建议：补 `--help/-h`；把默认命令改为 `status`（或仅在无参数时 `start`），并要求子命令必须位于首参。

### 2.17【P2，CLI/自动化】`install --apply --yes` 在扩展未配对时固定等待 120s 后失败，且不写配置

> 复核（2026-10-22 01:12）：**仍未修复**。用 `spawnSync(..., timeout: 3000)` 复跑，安装器在 3s 时仍停在「等待扩展配对」，被 SIGTERM 终止，配置保持 `{"mcpServers":{}}`。

- 复现（临时 HOME + 已存在的 Claude 配置）：

  ```bash
  HOME=$H ACTSPAN_API_URL='' ACTSPAN_API_KEY='' node install.js --apply --yes
  # stdout: 等待扩展配对（仅本机，端口 53723）。加载扩展后在引导页继续。
  # 约 120s 后 stderr: actspan install: pairing timed out
  # exit=1，claude_desktop_config.json 原样未动，也没有备份
  ```

- 代码路径：`mcp-server/install.js:154` 在 `apply` 且未传 `--extension-id` 时执行 `await pairExtension()`；`install.js:118` 的默认超时是 **120000ms**。`--extension-id` 是唯一跳过等待的入口，但 `--help` 没有说明这一点。
- 已验证可用的绕过方式：显式传规范 ID `--extension-id kcmnglipboiheaicckjcinkdmpgjcgog` 时立即完成（exit 0），生成的配置保留已有 `existing` server，并写出 `.bak-<ts>` 备份。
- 影响：
  - `--yes` 的语义是「确认覆盖」，实际却变成「等待扩展配对」，无 GUI/无人值守环境必然空等 2 分钟后失败；
  - 安装失败时配置完全不落盘，用户容易误判为「install 卡住」；
  - 还会调用 `openWelcome()` 尝试打开浏览器，在无桌面环境产生额外副作用。
- 修复建议：
  1. 增加 `--no-pair` 或 `--pair-timeout N`，让自动化安装可以显式跳过/缩短等待；
  2. 先写入配置并提示「稍后到扩展页完成配对」，把配对作为独立步骤；
  3. 在 `--help` 中明确 `--extension-id` 会跳过配对等待；
  4. 非 TTY 环境默认不阻塞，或至少打印「可用 Ctrl-C 取消，或用 --extension-id 跳过」。

### 2.18【P2，发布/安装】`--from-npm` 生成的 `npx -y @actspan/mcp-server` 在 npm 上不存在

> 复核（2026-10-22 01:09）：**仍未修复**。`npm view @actspan/mcp-server version` 仍是 404；`release.yml` 仍无 `npm publish`。

- 实测（临时 HOME + Claude 配置，`--apply --yes --from-npm --extension-id <规范 ID>`）生成：

  ```json
  {
    "command": "npx",
    "args": ["-y", "@actspan/mcp-server", "mcp", "--client", "actspan"]
  }
  ```

- 但 registry 返回 404（同一环境下 `@modelcontextprotocol/sdk`、`ws` 均可正常解析）：

  ```bash
  npm view @actspan/mcp-server version
  # npm error code E404 ... '@actspan/mcp-server@*' is not in this registry
  ```

- 一致性问题：
  - `docs/guide/actspan-workflow-architecture-spec.md:288` 声称「MCP Server 以 `@actspan/mcp-server` 发布到 npm」，示例还用 `npx -y @actspan/mcp-server@1.0.0`（当前包版本是 1.1.0）；
  - `.github/workflows/release.yml` 只构建并上传扩展 zip，**没有任何 `npm publish` 步骤**，全仓库也没有 `NPM_TOKEN`/publish 配置。
- 影响：选择 `--from-npm` 的用户会得到一个首次启动即 404 的 MCP 配置；本地 `node` 模式不受影响。另已用 `npm pack` 产物在临时目录安装验证：`actspan-mcp/install/doctor/bridge` 的打包与 bin 解析本身可用，问题只在「未发布」。
- 修复建议：
  1. 真正发布 `@actspan/mcp-server`（含 `files` 白名单、`--access public`、provenance），并在 release 中加发布步骤与 `npm view` 冒烟；当前 `npm pack` 为 **39 文件 / 90KB**，把 `test/*` 也带上了，建议先加白名单；
  2. 或在发布前隐藏/禁用 `--from-npm`，检测到包不存在时明确报错并回退到本地路径；
  3. 同步修正文档中「已发布」的表述。

### 2.19【已修复，原 P3，安装器】`--apply --yes` 在 0 个目标被写入时仍返回 exit 0

> 复核（2026-10-22 01:10）：**已修复**。损坏 Cursor 配置下 exit **1**，stderr 为「没有写入任何配置；1 个目标需要人工处理或使用 --force」，文件仍为 `{bad`。

- 复现（临时 HOME，仅有一个损坏的 Cursor 配置）：

  ```bash
  printf '{bad' > "$HOME/Library/Application Support/Cursor/User/mcp.json"
  node install.js --apply --yes --extension-id <规范 ID>
  # 输出：· .../mcp.json — 手动配置说明（不表示 install 已支持自动安装）：JSON 无法解析...
  # exit=0，文件保持 {bad
  ```

- 影响：自动化脚本会把「完全没写成」当成成功；与 `--apply` 的语义不符。全部目标都是 `manual`/`unsupported` 时尤其危险。
- 建议：根据 `results` 决定退出码——至少一个 `applied` 或全部 `skip` 才返回 0；存在 `manual/unsupported` 且无 `applied` 时返回非 0，并输出明确摘要。
- **状态：已修复。** CLI 在 `--apply` 且 0 个 `applied`、0 个 `skip`、存在 `manual` 时输出摘要并以 `exit 1` 退出（`mcp-server/install.js` 主入口）；新增临时 HOME 的损坏配置 CLI 用例。

### 2.20【已修复，原 P2，安装器】`mcpServers` 不是对象时会被静默展开，破坏原配置

> 复核（2026-10-22 01:10）：**已修复**。数组、字符串、`null` 三种形态均 exit **1**，原文件字节不变。

- `jsonTarget()` 只把「对象且非数组」的 `mcpServers` 视为已配置；其它类型会落到 `supported: true, configured: false`，随后 `jsonWithServer()` 用对象展开合并：

  ```js
  { ...parsed, mcpServers: { ...(parsed.mcpServers || {}), actspan: definition } }
  ```

- 实测（临时 Cursor 配置）：

  ```json
  // 输入
  {"mcpServers":[{"command":"node"}]}
  // 输出（原数组被转换成索引对象）
  {"mcpServers":{"0":{"command":"node"},"actspan":{...}}}

  // 输入
  {"mcpServers":"oops"}
  // 输出（字符串被拆成字符键）
  {"mcpServers":{"0":"o","1":"o","2":"p","3":"s","actspan":{...}}}
  ```

  两次都 **exit 0**，用户原配置已被破坏。
- 影响：虽然 `mcpServers` 按 MCP 规范应为对象，但现实中损坏/半写/旧格式配置并不罕见；安装器应拒绝而不是猜测并改坏。
- 修复建议：
  1. `jsonTarget()` 对任何非「普通对象」的 `mcpServers` 返回 `supported: false`，走 manual；
  2. `jsonWithServer()` 合并前再次断言 `mcpServers` 是对象，否则抛错；
  3. 增加数组/字符串/`null` 三种形态的单测，断言原文件内容不变。
- **状态：已修复。** `jsonTarget()` 对自有 `mcpServers` 但非普通对象返回 `unsupported`，走 manual；`jsonWithServer()` 在写入边界再次断言并抛错；新增数组/字符串/`null` 单测，断言文件字节不变。

### 2.21【已修复，原 P3，安装器】原子写入会把符号链接配置替换成普通文件

> 复核（2026-10-22 01:11）：**已修复**。安装后 `config.toml` 仍是 symlink，`dotfiles/codex.toml` 中已写入 ActSpan 段。

- 复现（临时 HOME，`~/.codex/config.toml` 指向 dotfiles）：

  ```bash
  ln -s "$H/dotfiles/codex.toml" "$H/.codex/config.toml"
  node install.js --apply --yes --extension-id <规范 ID>
  ```

  结果：`~/.codex/config.toml` **不再是 symlink**，变成新的 0600 普通文件；`dotfiles/codex.toml` 未被更新。
- 根因：`writeFileAtomic()` 先写 `${file}.tmp-*`，再 `renameSync(temp, file)`；rename 会替换掉符号链接本身。
- 影响：用 stow/chezmoi 等管理 dotfiles 的用户会丢失链接，且后续修改不再同步到版本库。
- 建议：写入前 `fs.realpathSync(file)` 取真实目标（或检测 `lstat` 是 symlink 时改用直接写入），备份也写到真实目标旁边；增加 symlink 用例。
- **状态：已修复。** `writeFileAtomic()` 检测 symlink 后写真实目标并保留目标原权限；新增符号链接用例，断言链接仍在且 dotfile 被更新。

### 2.22【已修复，原 P3，安装器】已有 `actspan` 配置永不更新，旧路径/旧参数会一直保留

> 复核（2026-10-22 01:11）：**已修复**。旧配置在未传 `--force` 时 exit **1** 并要求确认；加 `--force` 后立即更新为当前 `process.execPath`，生成 1 个 `.bak-*`。

- 复现（临时 Claude 配置）：

  ```json
  {"mcpServers":{"actspan":{"command":"old-node","args":["old.js"]}}}
  ```

  执行 `node install.js --apply --yes --extension-id <规范 ID>`：

  ```
  · .../claude_desktop_config.json — 已配置，跳过
  exit=0
  ```

  文件仍是 `{"command":"old-node","args":["old.js"]}`，没有备份，也没有任何提示说明「已存在但不同」。
- 触发场景：移动仓库目录、换 Node 版本、从本地模式切到 `--from-npm`、或旧配置缺少 `ACTSPAN_EXTENSION_IDS`。
- 影响：用户按提示重跑安装器，看到「成功/跳过」，实际仍启动旧配置；排障成本高。
- 建议：对 `mcpServers.actspan` 已存在的情况比较 definition，不同则提示差异并要求 `--force`/`--update`；或默认只更新 `actspan` 这一项（保留其它 server），并生成备份。
- **状态：已修复。** JSON/TOML 均比较现有 actspan 定义：一致才 `skip`，不一致默认 `manual` 并提示 `--force`，传 `--force`/`--update` 后只替换 actspan 条目并生成备份；新增旧配置与 TOML 符号链接用例。

### 2.23【P3，测试质量/性能】`page.snapshot` 用例的 `sendMessage` mock 签名错误，每轮空等 16s 且不校验失败

- 文件：`src/background/mcp-bridge.test.mjs:461`
- 现象：该用例单次耗时 **16.0s**，是默认 `npm test` 从 ~7s 涨到 **21.8s** 的唯一原因（其余最慢用例 1.2s）。
- 根因：
  - `Channel.sendToTab()` 在指定 frameId 时按 Chrome 4 参签名调用：`chrome.tabs.sendMessage(tabId, msg, { frameId }, callback)`（`src/lib/channel.ts:69-83`）；
  - 用例的 mock 只声明了 3 个参数：`(_tabId, message, optionsOrCallback) => { ... optionsOrCallback?.callback?.(...) }`，第 4 个 `callback` 被丢弃，回调永远不会触发；
  - `sendToTabWithRetry()` 的 `deadlineMs: 8000` 因此每次都要等到超时；用例调用两次 snapshot（默认 + `include_frames`），正好 **2 × 8s ≈ 16s**；
  - 用例只断言 `framesSeen`（mock 被调用时的 frameId），**没有断言 `dispatch()` 的返回结果**，所以两次快照实际都超时失败，用例仍然通过。
- 影响：默认测试变慢 3 倍；更重要的是这个用例无法发现「主框架/子框架快照失败」类回归，属于假绿。
- 修复建议：
  1. mock 改为 `(tabId, message, options, callback) => { ...; callback?.({ success: true, data: { elements: [] } }); }`，兼容无 frameId 的 3 参调用；
  2. 断言 `result.success === true` 且 `result.error` 为空；分别断言默认只返回主框架、`include_frames` 返回两框架；
  3. 需要测超时分支时用 `t.mock.timers` 或把 `deadlineMs` 注入为 50ms，不要真实等 8s。

### 2.24【P2，安装器回归】Codex TOML 二次安装被判为「旧配置」，`--force` 会写出重复的 `.env` 表（无效 TOML）

- 文件：`mcp-server/install.js` 的 `extractTomlSection()`、`replaceTomlSection()`
- 复现（临时 HOME，先预置一个非空 `~/.codex/config.toml`）：

  ```bash
  printf 'model = "o3"\n' > "$H/.codex/config.toml"
  node install.js --apply --yes --extension-id <规范 ID>   # 第一次 exit 0，写入完整块
  node install.js --apply --yes --extension-id <规范 ID>   # 第二次 exit 1
  # 输出：手动配置说明（...已有 actspan 配置与当前安装不一致...使用 --force）
  ```

- 第二次安装**对刚刚由自己写入的配置**报告不一致并要求 `--force`；传 `--force` 后：

  ```
  force exit=0
  [mcp_servers.actspan]           ×1
  [mcp_servers.actspan.env]       ×2   ← TOML 重复定义表，整个文件非法
  ```

- 根因：
  - `extractTomlSection()` 从 `[mcp_servers.actspan]` 开始，遇到**任意**下一个 `[` 表头就结束；安装器自己写入的 `[mcp_servers.actspan.env]` 正好被截断，所以比较结果永远不等于包含 env 的 `tomlBlock()`；
  - `replaceTomlSection()` 用同一套边界，只替换父表，随后又追加一个含 `.env` 的完整块，旧 `.env` 表原样保留 → 重复表。
- 影响：Codex 用户每次重跑安装器都会看到「失败/需人工处理」；按提示加 `--force` 会把配置写坏，Codex 可能拒绝加载整个 MCP 配置。现有 TOML 用例只覆盖「旧块没有 env」的情况，因此 27/27 未发现。
- 修复建议：
  1. 边界改为「下一个不以 `[mcp_servers.actspan` 开头的表头」，让 `.env` 子表属于同一段；
  2. 或引入真正的 TOML 解析/序列化，写回前重新解析校验；
  3. 增加回归用例：首次写入后再次 plan 必须 `skip`；`--force` 后 `.env` 表恰好 1 个且可被 TOML 解析。

## 三、本轮已修复（在「不要改代码」指令之前完成）

| 问题 | 修复 |
|---|---|
| `npm test` 的 glob 在 sh 下漏跑 4 个文件（12 用例） | `package.json:26` 改为 `find` 递归收集 |
| 场景测试在「桥在监听但扩展未连接」时泄漏 MCP 子进程，`node --test` 永久挂起（曾跑 8 分钟） | `test/browser-fixtures.mjs` 初始化失败路径补 `client.close()` |
| `src/ai/context-manager.test.mjs` 未导入 `compactContext`，导致 1 个失败 | 补齐 esbuild re-export 与解构导入 |
| `src/lib/cdp-session.test.mjs` 真实等待 21.1s | 改用 `node:test` mock timers（setTimeout + Date），降至 0.12s，4/4 通过 |

## 四、未执行项

- `mcp-server/test/acceptance.mjs`、`test/simulated-user.mjs`：需要用户正在运行的 Chrome、已配对扩展，以及交互式审批；无人值守会卡在审批超时，本次未执行。
- 依赖升级、测试隔离改造、覆盖率补测：按「不改代码」要求仅记录，未实施。

## 五、修复进展（2026-10-22 01:15 追加）

| 报告项 | 处理结果 |
|---|---|
| 2.1 lint `no-control-regex` | 已改用 `/[\p{Cc}\s]/gu`，并新增 NUL/换行/制表符变形链接用例；`npm run lint` **0 error**（296 warning） |
| 2.2 `stopBridge` 偶发失败 | `bridgePaths()` 支持 `ACTSPAN_STATE_DIR`；`bridge-lock` 测试使用独立临时目录、排除 30121/31921；daemon 的 credential/log/lock 路径也统一走 `bridgePaths()` |
| 2.3 21 个真机场景固定跳过 | 新增 `ACTSPAN_LIVE=1` 显式开关，默认立即跳过；`npm run test:live` 运行真机验收 |
| 2.4 依赖 high | mcp-server 升级 `@modelcontextprotocol/sdk@1.32.1`、`ws@8.22.0`（audit **0**）；root 全量 **13 high / 2 moderate / 0 critical**，其中仅生产依赖仍 **2 high**（`@ant-design/pro-layout` → `path-to-regexp`），其余为构建/开发链路 |
| 2.5 e2e 遗留守护进程 | e2e 子进程使用临时状态目录，退出前 `stopBridgeDaemon` 并删除临时目录；01:15 临时 `HOME` + `ACTSPAN_STATE_DIR` 复跑 479/458 通过，真实 `~/.actspan` 保持 101→101、临时目录 0 残留；历史遗留的 14 个本 checkout daemon 仍需手动清理（另见 2.15 的新增泄漏） |
| 2.6 Windows `find` | 未处理，仍在建议列表 |
| 2.7 warning | 当前 **0 error / 296 warnings**，未批量清理 |
| 2.8 覆盖率盲区 | 未处理；25 个源码模块仍不可达 |
| 2.9 全局 mock 时序脆弱性 | 未处理；后续未再复现 |
| 2.10 `docs:build` 失败 | 已修复：三处尖括号改为可读占位文本（`Map（number → SessionTabRecord）`、`HOOK`、`TIMESTAMP`）；`docs:build` 通过并已加入 CI |
| 2.11 根包打包卫生 | **仍未修复**；398 文件包含 CI 与内部文档 |
| 2.12 CI/发布覆盖 | **仍未处理**；install/e2e/omp-compat 不在 CI，release 无测试门禁 |
| 2.13 `doctor --json` 输出污染 | **仍未修复**；stdout 混入人类文案，JSON 解析失败 |
| 2.14 `test:install` 非隔离 | **仍未修复**；干净 HOME 下 **25/27**，2 个失败（依赖至少一个已存在的宿主配置） |
| 2.15 mcp 套件遗留 daemon | **仍未修复**；`lifecycle.mjs:184` 每轮留下 1 个 detached daemon |
| 2.16 CLI 参数校验 | **仍未修复**；doctor 接受非法端口，bridge-cli 静默吞掉非法 origins JSON，且首参为 `--` 时默认 `start` |
| 2.17 安装器配对等待 | **仍未修复**；`--apply --yes` 未配对时固定等 120s 后失败，配置不落盘 |
| 2.18 npm 发布缺失 | **仍未修复**；`@actspan/mcp-server` registry 404，`--from-npm` 配置不可用 |
| 2.19 安装器退出码 | **已修复**；0 个目标写入时 exit 1，并输出「没有写入任何配置」 |
| 2.20 安装器改坏配置 | **已修复**；非对象 `mcpServers` 判为 unsupported，原文件不变 |
| 2.21 安装器替换 symlink | **已修复**；写入真实目标并保留链接与权限 |
| 2.22 安装器不更新旧配置 | **已修复**；旧配置需 `--force`，更新前生成 `.bak-*` |
| 2.23 `page.snapshot` mock 假绿 | **新增，未修复**；mock 少一个 callback 参数，每轮空等 16s 且不断言失败 |
| 2.24 TOML 二次安装回归 | **新增，未修复**；正常二次安装 exit 1；`--force` 生成重复 `.env` 表，TOML 非法 |

**第二轮修复（23:10）**：动态工具 endpoint 增加 SSRF 与重定向防护（`registry.ts`，新增 `registry-dynamic.test.mjs` 4 例）；`screenshot(url)` 限制为公开 http/https 并需要任务租约；`runRemotePlan` 拒绝已被其他任务租用的标签页；`executeSingleTool` 对同标签页的他人租约也会校验。

**复跑结果（01:15）**：`npm test` 479 tests / 458 pass / 21 skip / 0 fail，默认 **21.8s**（2.23 占 16s；修复后应回到 ~7s）；临时 `HOME` + `ACTSPAN_STATE_DIR` 同样 479/458，真实状态目录 101→101；`npm run typecheck`、`npm run build`、`npm run lint`（0 error / 296 warning）、`docs:build`（3.46s）通过；mcp-server `npm test` 100/100、`test:e2e`、`check:docs`、`test:omp-compat` 通过，`test:install` 默认 27/27、干净 HOME 25/27；但 27/27 未覆盖 TOML 二次安装，2.24 仍可复现。

## 六、后续建议处理顺序

1. ~~升级 `@modelcontextprotocol/sdk` / `ws` 并复跑 mcp-server 全量测试~~（已完成）；
2. ~~隔离测试状态目录 + 修 e2e 遗留守护进程~~（已完成）；
3. ~~给真机场景加显式开关，恢复 `npm test` 的确定性~~（已完成，`npm run test:live` 拆分）；
4. ~~修复文档三处尖括号，并把 `docs:build` 加入 CI~~（已完成）；
5. 根包加 `"private": true`（或 `files` 白名单），防止误发布 CI 与内部文档；
6. 修 `test:install` 的宿主配置隔离（2.14）与 `doctor --json` 的 stdout（2.13），否则不能安全加入 CI；
7. 补 CLI 参数校验（2.16）：doctor 端口范围、`--origins-json` 解析失败、空 allowlist；
8. 给安装器加非交互入口（2.17）：`--no-pair`/`--pair-timeout`，或先写配置后单独配对；
9. 发布 `@actspan/mcp-server` 或先禁用 `--from-npm`（2.18），并在 release 中加发布与 `npm view` 冒烟；
10. ~~修安装器边界（2.19/2.20/2.21/2.22）：退出码、`mcpServers` 形状、symlink、旧配置 `--force`~~（已完成，01:10 复验；但引入了 2.24 TOML 回归，见第 18 项）；
11. 给 `session-channel-handlers`、`workflow-recorder`、`page-parser`、`action-executor` 补单测，并启用源码覆盖率统计与门槛；
12. 处理 Windows 下测试脚本可移植性（`find` → Node 脚本）；
13. 升级 `@ant-design/pro-layout`（或锁定 `path-to-regexp`）及开发链路依赖，随后把审计门槛收到 `high`；
14. 合并重复 CI、把 `test:install`/`test:e2e`/`test:omp-compat` 纳入，并给 release 加测试门禁；
15. 分批清理 296 条 warning；
16. 修 `lifecycle.mjs` 的 daemon 清理（2.15），并清理历史遗留的 14 个本 checkout daemon 与 `~/.actspan` 日志（避免影响真实桥）；
17. 修 `page.snapshot` 用例的 mock 签名并断言返回值（2.23），把默认 `npm test` 从 21.8s 降回 ~7s，避免假绿；
18. 修 2.24：TOML 段边界必须包含 `[mcp_servers.actspan.env]` 子表；二次安装应 `skip`，`--force` 后该表恰好 1 个，并加回归用例。
