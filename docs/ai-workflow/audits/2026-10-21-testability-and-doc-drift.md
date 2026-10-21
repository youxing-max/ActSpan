# AI Workflow Review · 2026-10-21 · testability-and-doc-drift（重审计）

审计对象：ActSpan 全仓，HEAD `54deda9`（`origin/main`，超集规格落地后）。
上一版报告基于过期本地态 `543b9ec`，已作废；本版为同步后重审计。

## 0. 同步

`git reset --hard origin/main` 完成，HEAD == `origin/main` == `54deda9`，工作区干净（仅未跟踪 `docs/ai-workflow/`）。之前分叉的本地 3 提交与远端同消息提交内容逐字节相同，无损失。

## 1. 被审者 4 项观点 · 最终结论

### V1 — closed shadow DOM 可测性 —— 成立，两处均未改

- 活动入口 `src/content.ts:48-49`：仅主框架渲染 `initFloatBallReact()`；旧版 `initFloatBall` 仍在 `:11` 注释（死代码）。
- **活动实现** `float-ball-react.tsx:43`：`attachShadow({ mode: 'closed' })`。
- **死代码** `float-ball.ts:135`：`attachShadow({ mode: 'closed' })`（被审者引用的正是这一行，行号在超集后刚好落到 135）。
- 结论：`mode:'closed'` 让确认卡片对 Playwright/CDP 不可达，自动化仍只能 mock。安全无虞，工程负债不变。旧版仍未删。

### V2 — 文档漂移（18 vs 34）—— 成立，且是**实打实的线上 bug**，比预想更广

代码已是 34 个 MCP 工具（`mcp-server/catalog.js:13-48` `TOOL_NAMES` = 34，新增 act/network/data 三组：`actspan_act`、`actspan_page_snapshot/select/upload/key/wait/scroll`、`actspan_network_list/detail/query`、`actspan_data_fetch/paginate/download`、`actspan_status_update`、`actspan_tabs_select`、`actspan_adopt`）。

但 **5 处文档仍写 18**：

| 位置 | 内容 |
|---|---|
| `MCP-BRIDGE.md:59` | `## 工具清单（18 个）` |
| `MCP-BRIDGE.md:110` | `验证 18 个工具注册` |
| `README.md:126` | 稳定工具「状态查询/标签页/页面读取操作/工作流/任务/feishu」——无 act/network/data 三组 |
| `docs/guide/actspan-repair-spec.md:148` | `当前基线为 18 个稳定工具` |
| `docs/guide/actspan-workflow-architecture-spec.md:21` | `共 18 个工具` |
| `docs/superpowers/plans/...rename-and-repair-spec.md:121` | `the 18-tool stable inventory` |

好消息：`test/e2e.mjs:60-61` 已改成动态断言 `tools.tools.length === TOOL_NAMES.length`，不硬编码 18；`docs/spec/actspan-gap-matrix.md` 也未再写 18。**漂移集中在用户文档与历史 spec，代码/测试已一致。**

### V3 — 网络捕获对“不消费响应体”的请求不可见 —— 成立，且超集未解决

`src/lib/cdp-session.ts` 逻辑未变：`:852` `requestWillBeSent` 只进 pending，`:889` `loadingFinished` / `:900` `loadingFailed` 才 `pushNetworkEvent` 入缓冲。无 finished/failed 的请求（流式/SSE/长轮询）永远不可见。

- 新增强：`:268` 清 tab、`:500` 停监听、`:540` clear、`:778` detach、`scheduleIdleDetach` —— 泄漏面比旧版小，但**单个监听会话内**永不完成的请求仍无 per-request 超时。
- 超集新增 `actspan_network_list/detail/query` 仍走同一 `cdp_network` 机制，故该「不可见」对 MCP 网络工具同样成立，且 `MCP-BRIDGE.md` 根本没有 network 工具小节说明此取舍。

### V4 — 两套语义 —— 部分缓解，未根治

超集把 act/network/data **直进 MCP**，IDE agent 现在可不经 `agent_submit` 直接做网络捕获/数据抽取——这一块的「两套语义」矛盾被实质缩小。

但仍存：
- `agent_submit` / `workflow_run` 仍委派内置循环；owner 三值 `ide-agent`(`mcp-bridge.ts:146`) / `extension-agent`(`agent_delegate`) / `user`。
- **新增第三层语义**：`actspan_act`（`act-script.js` 声明式动作 DSL，P1-P7 预算/断言/条件）既不是内置循环也不是原子工具，是新的编排范式。三条路径（原子工具 / act 脚本 / agent_submit 内置循环）何时该用哪条，`MCP-BRIDGE.md` 无边界说明。

## 2. 新增发现（超集后新问题）

### Standards 轴

- **S1（Major）文档漂移为线上 bug**：见 V2，5 处写 18、代码 34；README/MCP-BRIDGE 未覆盖 act/network/data 三组——超集核心能力对用户不可见。
- **S2（Minor）旧版悬浮球死代码未删**：`float-ball.ts`（含 `float-ball/` 子目录）仍随仓，与 React 版双 closed shadow 并存。

### Spec 轴

- **SP1（Major）`npm test` 不含浏览器靶场**：`gap-matrix` WP15 自述 `package.json:25` 的 `npm test` 只跑 `src/**/*.test.mjs`，`test/scenarios.test.mjs`（22 用例）不在 CI。
- **SP2（Major）S5 从未跑通**：`gap-matrix` 头部自述 `test/scenarios.test.mjs` 本机 `22 fail / 0 pass`（依赖 Chrome DevTools HTTP 端点，本机只暴露 `/devtools/browser` WS）。35 行「已实现」证据降级为「契约证据」（用例名+断言如所写），非跑通证明。
- **SP3（Major）30+ 条需求「部分实现」仍在**：G1/G2/G7/G10/G12/G14、C1/C2/C3、D10/D11/D12、F1、N10、S5、WP0/WP1/WP2/WP3/WP5/WP8/WP12/WP15、4.1-3、4.1-7、Q2/Q3/Q9/Q12。安全相关三条：D10（eval 无 focus:true 逃生口）、D11（错误文案未脱敏用户输入）、D12（role 未双向校验）。

### State 轴

- **ST1（Major）审计基础设施缺失**：`validate_state.py` 在 skill 目录与仓库均不存在；无 `state.json`/`decisions.md`/`risks.md`/`evidence/`。State 轴步骤 1-2 无法执行。
- **ST2（Major）证据可信度分级未外化**：gap-matrix 内部已诚实标注 S5「契约证据」，但 35 行引用仍混在「已实现」列，读者不细看头部声明会误以为全部跑通。

## 3. Blocker 汇总

- **Blocker：0**（无产品破坏/安全问题）。
- 主要风险集中在：文档漂移（S1）、CI 靶场缺口（SP1/SP2）、审计 State 基础设施缺失（ST1）。

## 4. 修复建议（开 fix 任务，本次不改码）

1. 单一事实源：由 `TOOL_NAMES.length` 生成 `MCP-BRIDGE.md`/`README` 工具清单，重写 act/network/data 三组说明（关 S1/V2）。
2. 旧版 `float-ball.ts` 删除或改 React 版 shadow 为 `mode:'open'` + 数据属性（关 V1/S2）。
3. `networkPendingRequests` 加 per-request 超时驱逐；`MCP-BRIDGE.md` 补 network 工具可见性边界（关 V3）。
4. `MCP-BRIDGE.md` 补「原子工具 / act 脚本 / agent_submit 内置循环」三路径边界（关 V4）。
5. 把 `test/scenarios.test.mjs` 纳入 CI，或改造成不依赖 DevTools HTTP 端点（关 SP1/SP2）。
6. 补齐 `validate_state.py`/`state.json`，gap-matrix 的「契约证据」标注外化到各「已实现」行（关 ST1/ST2）。
