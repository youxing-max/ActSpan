# ActSpan 审计修复 Spec

生成日期：2026-10-21
依据：`docs/ai-workflow/audits/2026-10-21-testability-and-doc-drift.md`（重审计，HEAD `54deda9`）
配套计划：`docs/ai-workflow/roadmap.md` + `milestones.json` + `tasks.json`

## 背景

同步 `origin/main`（超集规格落地后）重审计，结论：Blocker 0；Major 6（S1/SP1/SP2/SP3/ST1/ST2）；Minor 1（S2）。

## 修复目标

把审计发现的 Major/Minor 逐条收敛到可验证完成，收口后重跑 `/ai-workflow-review` 至 0 Major。

## 修复需求（FR）

### FR-1 文档漂移归零（S1，Major）

现状：`mcp-server/catalog.js:13-48` `TOOL_NAMES` = 34，但 5 处文档仍写 18：

| 位置 | 旧文案 |
|---|---|
| `MCP-BRIDGE.md:59` / `:110` | 工具清单（18 个）/ 验证 18 个工具注册 |
| `README.md:126` | 无 act/network/data 三组 |
| `docs/guide/actspan-repair-spec.md:148` | 当前基线为 18 个稳定工具 |
| `docs/guide/actspan-workflow-architecture-spec.md:21` | 共 18 个工具 |
| `docs/superpowers/plans/2026-10-18-actspan-rename-and-repair-spec.md:121` | 18-tool stable inventory |

要求：全部改为 34 或动态引用 `TOOL_NAMES`；`MCP-BRIDGE.md` 工具清单补 act/network/data 三组 16 个新工具（`actspan_act`、`actspan_page_snapshot/select/upload/key/wait/scroll`、`actspan_network_list/detail/query`、`actspan_data_fetch/paginate/download`、`actspan_status_update`、`actspan_tabs_select`、`actspan_adopt`）。

验收：`mcp-server/check-tool-docs.mjs`（单一事实源校验，从 `TOOL_NAMES` 生成校验清单）对 `MCP-BRIDGE.md` 与 `README.md` 退出码 0；grep 用户文档无 stale「18 个工具/18-tool」。

### FR-2 三路径执行语义边界（V4，文档）

现状：原子工具 / `actspan_act` 声明式脚本 / `agent_submit` 内置循环三条路径，`MCP-BRIDGE.md` 无边界说明。

要求：`MCP-BRIDGE.md` 新增「执行语义边界」节，说明三者适用场景与委托关系。

### FR-3 网络捕获可见性（V3，文档+代码）

现状：`src/lib/cdp-session.ts:852/889/900` 仅 `loadingFinished`/`loadingFailed` 入缓冲；`networkPendingRequests` 无 per-request 超时。

要求：① `cdp-session.ts` 加 per-request 超时驱逐；② `MCP-BRIDGE.md` 补 network 工具可见性边界说明。

### FR-4 closed shadow 可测性（V1/S2）

现状：`float-ball-react.tsx:43`（活动）与 `float-ball.ts:135`（死代码）均为 `attachShadow({ mode: 'closed' })`。

要求：活动版改 `mode:'open'` 或加数据属性使确认卡片对 Playwright/CDP 可达；删除 legacy `float-ball.ts` + `float-ball/` 子目录及 `content.ts:11` 注释。

### FR-5 浏览器靶场进 CI（SP1/SP2，Major）

现状：`npm test` 只跑 `src/**/*.test.mjs`；`test/scenarios.test.mjs`（22 用例）本机 22 fail/0 pass（依赖 Chrome DevTools `/json/version` HTTP 端点，本机只暴露 `/devtools/browser` WS）。

要求：`scenarios.test.mjs` 改造成不依赖该 HTTP 端点，纳入可跑脚本并进 CI；真正跑通的 `test:acceptance`/`test:simuser` 保持独立。

### FR-6 状态基础设施（ST1/ST2，Major）

现状：`validate_state.py`/`state.json`/`decisions.md`/`risks.md`/`evidence/` 缺失；gap-matrix 35 行「契约证据」未外化。

要求：接入 `ai-workflow-state` 套件；gap-matrix「契约证据」标注外化到行级或指向 `evidence/` 实跑日志。

### FR-7 部分实现清尾（SP3，Major）

现状：30+ 条 partial（G1/G2/G7/G10/G12/G14、C1/C2/C3、D10/D11/D12、F1、N10、S5、WP0/WP1/WP2/WP3/WP5/WP8/WP12/WP15、4.1-3、4.1-7、Q2/Q3/Q9/Q12）。

要求：安全优先补齐 D10（eval 无 focus 逃生口）/D11（错误文案未脱敏用户输入）/D12（role 未双向校验）；其余分诊归档或补齐，决定记入 `decisions.md`。

## Out of Scope

- 不新增产品功能；不改 34 个工具的既有行为语义（FR-3 超时驱逐除外）。
- 不触碰 AGPL 合规、云端控制面 API、options 页配对 UI。
- 不把 S5「契约证据」伪装成跑通——保持诚实分级。

## 验证

每项 FR 的 `verify` 命令见 `tasks.json`；收口后重跑审计。
