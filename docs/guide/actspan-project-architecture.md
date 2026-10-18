# Actspan 项目架构

> 本文描述仓库当前实现的运行时架构、模块边界、数据流和构建方式。它不是未来设计方案；未来能力以 `docs/guide/actspan-workflow-architecture-spec.md` 为准。

## 1. 项目定位

Actspan 是一个 Manifest V3 Chrome 扩展，运行在用户自己的 Chrome 中，复用浏览器已有登录态和 Cookie，提供三类能力：

1. **AI 对话与 Agent Loop**：由扩展内的 AI 模块执行多轮决策和工具调用。
2. **确定性 Skill/Workflow**：通过版本化的 Skill Registry 保存可复用的浏览器步骤。
3. **IDE MCP Bridge**：IDE Agent 通过本地 stdio MCP Server，经 WebSocket 调用扩展的原子浏览器能力和异步任务能力。

核心边界：IDE Agent 负责跨工具编排；MCP Server 负责协议适配；扩展 Background 负责权限、任务所有权、浏览器副作用和执行状态。

## 2. 总体运行时拓扑

```text
┌──────────────────────┐
│ IDE Agent             │  决策、跨 MCP 编排
└──────────┬───────────┘
           │ MCP / stdio
┌──────────▼───────────┐
│ mcp-server/index.js  │  工具注册、参数校验、任务句柄
│ mcp-server/bridge.js │  WebSocket Bridge、鉴权、请求关联
└──────────┬───────────┘
           │ ws://127.0.0.1:30121
┌──────────▼─────────────────────────────────────┐
│ Chrome Extension Background Service Worker      │
│ mcp-bridge → PolicyExecutor → TaskManager       │
│             → TabLeaseManager                   │
│             → browser capabilities / sessions   │
└───────┬───────────────────────┬─────────────────┘
        │                       │
        ▼                       ▼
 chrome.tabs / scripting /   chrome.storage.local
 debugger / alarms           registry、task、session、配置
```

扩展内部还有三类 UI 入口：

```text
Popup (src/App.tsx)       ─┐
Side Panel                 ├─> Chrome Extension APIs / Channel / Registry
Options Console            ┘
```

`MCP-BRIDGE.md` 是 Bridge 使用边界的操作文档；`src/background/mcp-bridge.ts` 是扩展侧实现，`mcp-server/` 是 IDE 侧本地 MCP 实现。

## 3. 代码分层

### 3.1 扩展入口与 UI

| 入口 | 作用 | 构建产物 |
| --- | --- | --- |
| `src/background.ts` | MV3 Service Worker；注册 Channel 处理器、MCP Bridge、任务执行器，并恢复状态 | `background.js` |
| `src/main.tsx` / `src/App.tsx` | Popup 状态面板；展示 LLM 配置和 Workflow 数量 | `index.html` |
| `src/sidepanel.tsx` / `src/sidepanel/SidePanelApp.tsx` | Chrome Side Panel 对话界面 | `sidepanel.html` |
| `src/options.tsx` / `src/options/OptionsApp.tsx` | Actspan Console 外壳和页面路由 | `options.html` |
| `src/content.ts` | Content Script 构建入口，承载旧的页面侧能力代码 | `content.js` |
| `public/manifest.json` | 扩展权限、入口、Web Accessible Resources 的源清单 | 复制到构建目录 |

Options 使用轻量 hash 路由，不引入独立路由服务。当前页面包括：模型与连接、技能与工作流、域名管理、Webhook、运行记录；路由定义在 `src/options/routes.tsx`，页面映射在 `src/options/OptionsApp.tsx`。

### 3.2 Background 编排层

`src/background.ts` 只做启动组装，具体职责拆在 `src/background/`：

- `session-manager.ts`：创建、运行、暂停、恢复和终止 Agent Session；调用 `runSessionNow` 进入 AI 执行路径。
- `session-channel-handlers.ts`：处理 UI/扩展内部的会话消息。
- `channel-handlers.ts`：基础扩展消息处理。
- `workflow-handlers.ts`：按当前 URL 匹配 Skill、响应 Workflow 查询和保存后的 Registry 刷新。
- `policy-executor.ts`：统一能力入口；按 capability 做权限判断、任务状态推进、取消检查和标签页串行化。
- `task-manager.ts`：维护异步 BrowserTask，持久化任务状态，并在 Service Worker 重启后恢复。
- `tab-lease-manager.ts`：维护 task/session/client 到 tab 的所有权；同一标签页操作排队。
- `mcp-bridge.ts`：扩展侧 WebSocket 客户端，处理 Bridge 请求并绑定请求上下文。
- `timer-dispatch.ts`、`bg-tasks-manager.ts`：定时任务和常驻任务调度。
- `workflow-recorder.ts`：录制浏览器操作并交给 AI 整理成可保存 Workflow。
- `session-persistence.ts`、`session-history.ts`、`session-resource.ts`：运行时会话、历史和资源生命周期。

启动顺序的关键约束：先加载 Registry，再初始化任务相关模块，避免 `bg-tasks-manager → resident-runtime → remote-workflow → registry` 形成 TDZ 循环；启动后按“会话 → 任务 → 定时器”恢复。

### 3.3 AI 与工具层

`src/ai/` 是扩展内的 Agent Loop：

- `llm-client.ts`：OpenAI-compatible Endpoint、模型和 API Key 配置。
- `core-loop.ts`、`orchestrator.ts`、`phase-orchestrator.ts`：多轮决策、阶段推进和工具调用。
- `tool-executor.ts`、`agent-registry.ts`：工具执行和 Agent 注册。
- `system-prompt.ts`：系统提示词，包括 Skill/Workflow 上下文。
- `tab-tracker.ts`、`todo-manager.ts`、`review-agent.ts`：标签页跟踪、任务清单和审查辅助。

浏览器能力通过 `src/functions/` 和 `src/lib/` 提供。`remote-workflow.ts` 不负责模型决策，而是执行已保存的结构化 Plan：解析模板变量、条件、步骤级错误策略和标签页生命周期。

### 3.4 Skill Registry

Skill 的类型契约位于 `src/functions/skill-types.ts`：

```ts
SkillSpec {
  name, label, description,
  scope: 'global' | 'domain',
  url_patterns, guide, workflows,
  enabled,
  source: 'builtin' | 'remote' | 'user',
  version, contentHash, createdAt, updatedAt
}
```

每个 `WorkflowEntry` 保存参数 Schema、兼容用的 `plan`、可选规范化 `steps`、版本和更新时间。规范化步骤支持：`page_read`、`page_click`、`page_type`、`page_eval`、`screenshot`、`agent_delegate`；步骤错误策略为 `stop`、`retry` 或 `fallback`。

Registry 的职责由两层组成：

- `registry-service.ts`：规范化、校验、冲突合并、Canonical Snapshot 持久化、revision 递增和变更事件。
- `skill-registry.ts`：装载内置 manifest、管理远端 manifest 源、周期同步、迁移旧 Workflow、提供业务查询函数。

来源优先级为 `user > remote > builtin`；相同 Skill Key 再按版本和更新时间选择胜者。Registry Snapshot 保存为 `chrome.storage.local['actspan_skills']`，其模型包括 `schemaVersion`、`revision`、`skills` 和 `updatedAt`。

Registry 数据流：

```text
内置 skills/global|domains manifest
              │
远端 manifest ─┼─> normalizeSkill/normalizeWorkflow
              │                     │
用户 Console/AI 保存 ───────────────┘
                                      ▼
                           Registry Service
                                      ▼
                         actspan_skills snapshot
                                      │
             ┌────────────────────────┼──────────────────────┐
             ▼                        ▼                      ▼
      AI Skill 注入             Options Console          MCP catalog
```

远端源保存于 `actspan_skill_sources`，默认通过 `chrome.alarms` 每 6 小时同步；同步失败保留已有 Canonical Snapshot，并在 source 元数据记录错误。旧的 `mole_site_workflows_v1` 由 Registry Service 迁移，避免旧数据直接绕过新服务。

### 3.5 MCP Bridge

#### IDE 侧

`mcp-server/index.js` 使用：

- `@modelcontextprotocol/sdk` 注册固定工具名。
- `zod` 校验输入。
- `StdioServerTransport` 与 IDE Agent 通信。
- `ExtensionHub` 连接本地扩展并关联 `clientId`、`requestId`、`taskId`、`sessionId`。
- `RegistryCatalog` 读取 Skill/Workflow 目录。

工具分为四组：

1. **状态与标签页**：`actspan_status`、`actspan_tabs_list`、`actspan_tab_open`、`actspan_tab_close`、`actspan_tab_navigate`。
2. **页面原子能力**：`actspan_page_read`、`actspan_page_click`、`actspan_page_type`、`actspan_page_eval`、`actspan_screenshot`。
3. **目录与确定性执行**：`actspan_skills_list`、`actspan_skill_detail`、`actspan_workflow_run`。
4. **开放任务生命周期**：`actspan_agent_submit`、`actspan_agent_status`、`actspan_agent_result`、`actspan_agent_cancel`。

`workflow_run` 和 `agent_submit` 返回异步任务句柄，不把长任务强行阻塞在单次 MCP 调用中。

#### 扩展侧

`src/background/mcp-bridge.ts` 将 WebSocket method 路由到：

```text
ping / tabs.list / tab.* / page.*
        └─> dispatch 原子浏览器操作
registry.list / registry.detail
        └─> ensureSkillRegistryReady → Registry Service
workflow.run
        └─> Workflow 执行器 / taskManager
agent_delegate / task.submit
        └─> Background Session → AI Agent Loop
 task.status / task.result / task.cancel
        └─> TaskManager
```

扩展侧还把 capability handler 注册到 `PolicyExecutor`，因此 MCP、内部 Workflow 和其他调用方共享同一套权限和任务边界，而不是分别实现一套浏览器写入逻辑。

## 4. 任务、Session 与标签页所有权

### 4.1 BrowserTask

`src/background/task-types.ts` 定义的任务状态：

```text
queued → running → succeeded
       ├→ waiting_user
       ├→ failed
       └→ cancelled
```

`BrowserTask` 至少关联 `taskId`、`sessionId`、owner、clientId、ownedTabIds、activeTabId、registryRevision、时间戳和结果/错误。owner 可为 `ide-agent`、`extension-agent` 或 `user`。

`taskManager.ts` 将 `{ version: 1, tasks, leases, updatedAt }` 写入 `actspan_task_state`。Service Worker 恢复时，运行中但没有继续执行上下文的任务标记为 `failed`，错误码为 `E_TASK_RUNTIME_INTERRUPTED`，避免把旧任务误报为仍在执行。

### 4.2 Tab Lease

`TabLease` 以 `taskId + sessionId + clientId + tabId` 标识所有权，并记录创建者、创建时间、过期时间和释放时间。关键不变量：

- `tabs.list` 只暴露当前任务和 client 持有的标签页。
- 导航、点击、输入、执行脚本和关闭等写操作必须通过当前 task 的 lease。
- 同一 tab 的能力调用按 FIFO 串行；不同 tab 可以并行。
- debugger attachment 记录 owner，不能由其他任务无条件 detach。
- 父任务取消时，子 Agent 任务和相关 AbortController 一起中止。

### 4.3 PolicyExecutor

权限等级：`read`、`interact`、`sensitive`、`dangerous`。典型映射：

| 等级 | 示例 |
| --- | --- |
| `read` | `ping`、`tabs.list`、`registry.list`、`page.read`、任务查询 |
| `interact` | 打开/导航标签页、点击、输入、提交任务、运行 Workflow |
| `sensitive` | 关闭标签页、截图 |
| `dangerous` | `page.eval` |

执行器在真正产生浏览器副作用前检查任务状态、Tab Lease、审批和取消信号；拒绝的请求不会继续执行底层 Chrome 操作。

## 5. 关键数据与存储

| 存储位置 | 关键数据 | 读写边界 |
| --- | --- | --- |
| `chrome.storage.local['actspan_ai_settings']` | LLM Endpoint、模型、API Key | `src/ai/llm-client.ts`；旧 key 只用于迁移 |
| `chrome.storage.local['actspan_skills']` | Canonical Skill Registry Snapshot | `registry-service.ts` |
| `chrome.storage.local['actspan_skill_sources']` | 远端 manifest 源及同步状态 | `skill-registry.ts` |
| `chrome.storage.local['actspan_task_state']` | BrowserTask 和 Tab Lease 快照 | `task-manager.ts` |
| `chrome.storage.local['actspan_mcp_bridge_settings']` | Bridge 开关、端口、手动 token | `mcp-bridge.ts` |
| `chrome.storage.local` 会话 key | Session 运行时状态、历史、定时器、常驻任务 | `session-persistence.ts`、`session-history.ts`、`timer-store.ts` |

旧 `mole_*` key 通过 `legacy-storage.ts` 或各模块的迁移逻辑兼容读取；新的业务写入应使用 `actspan_*` canonical key。

## 6. 安全与信任边界

1. **本地 Bridge 只监听回环地址**：`mcp-server/bridge.js` 默认监听 `127.0.0.1:30121`。
2. **扩展 ID allowlist**：MCP Server 通过 `ACTSPAN_EXTENSION_IDS` 配置允许配对的 `chrome-extension://<id>` Origin；没有 allowlist 时拒绝自动配对。
3. **Token 握手**：WebSocket 首先校验 Origin，再用 `hello + token` 建立认证连接。
4. **单 owner**：同一 Bridge 只保留一个已认证扩展连接；重复连接被拒绝。端口被占用时先探测 owner 并报告诊断，不静默启动第二个服务。
5. **请求绑定**：Bridge 对返回消息同时校验 socket、requestId、clientId、taskId、sessionId 和 tabId，防止跨任务串线。
6. **密钥脱敏**：MCP stdout 只承载 MCP JSON-RPC；运行日志写入 `~/.actspan/mcp-server.log`（可由 `ACTSPAN_MCP_LOG` 覆盖），API Key、token 和 Authorization 会被脱敏。
7. **浏览器副作用收口**：IDE 不直接接触 Chrome API；所有副作用经过扩展侧 Policy、Task 和 Lease 检查。

## 7. 构建与发布

根目录 `package.json` 的构建链为：

```text
npm run build
  ├─ npm run build:popup       → index.html / options.html
  ├─ npm run build:content     → content.js
  ├─ npm run build:sidepanel   → sidepanel.html
  └─ npm run build:background  → background.js
```

所有 Vite 配置默认输出到 `build_version/actspan-extension/`（由 package name 决定）。Chrome 加载时使用该目录中的构建产物和 manifest。

MCP Server 是独立的 Node ESM 包，位于 `mcp-server/`：

- Node `>=20`。
- 启动入口 `actspan-mcp` → `index.js`。
- 依赖 MCP SDK、`ws`、`zod`。
- `npm test` 覆盖 catalog；`npm run test:e2e` 覆盖模拟 IDE 与模拟扩展的 WebSocket 链路。

源码 `public/manifest.json` 是当前扩展清单的规范来源；若 `build_version/` 中出现旧品牌、旧图标或旧入口，先重新执行完整构建，不要把构建目录中的陈旧文件当作源代码契约。

## 8. 典型调用链

### 8.1 IDE 执行确定性 Workflow

```text
IDE Agent
  → actspan_workflow_run(name, input, taskId?)
  → mcp-server 校验参数并生成 taskId/sessionId
  → ExtensionHub.call('workflow.run', context)
  → WebSocket 传入扩展 mcp-bridge
  → PolicyExecutor 校验 capability / task / lease
  → Registry Service 读取 Workflow 与 revision
  → remote-workflow 按步骤执行 page_read/click/type/... 
  → TaskManager 更新状态、结果和副作用
  → 返回 queued/running/succeeded/failed 任务句柄
  → IDE Agent 轮询 actspan_agent_status/result
```

### 8.2 IDE 执行开放浏览器任务

```text
actspan_agent_submit
  → task.submit
  → TaskManager 创建 BrowserTask
  → background.ts 注册的 TaskRunner 创建 Session
  → runSessionNow(..., allowConcurrent: true)
  → AI Agent Loop 决定工具调用
  → PolicyExecutor / TabLeaseManager 执行并隔离标签页
  → Session 与 Task 持久化结果
```

## 9. 维护边界

- 新增浏览器副作用：优先增加 capability handler，并接入 `PolicyExecutor`、TaskContext 和 Tab Lease；不要从 MCP Server 直接操作 Chrome。
- 新增 Skill/Workflow 存取：必须经过 `RegistryService`；不要直接写 `chrome.storage.local['actspan_skills']`。
- 新增 IDE 能力：先在 `mcp-server/index.js` 注册稳定工具，再在 `mcp-bridge.ts` 注册 capability 和策略映射。
- 修改任务生命周期：同步更新 `task-types.ts`、`task-manager.ts`、`policy-executor.ts` 和 MCP 状态/结果接口。
- 修改扩展入口或权限：同时检查 `public/manifest.json`、对应 Vite 配置和完整构建产物。

## 10. 代码导航索引

| 关注点 | 首选文件 |
| --- | --- |
| MV3 启动 | `src/background.ts`, `public/manifest.json` |
| AI Loop | `src/ai/core-loop.ts`, `src/ai/orchestrator.ts`, `src/ai/tool-executor.ts` |
| Skill 数据模型 | `src/functions/skill-types.ts`, `src/functions/registry-model.ts` |
| Registry 持久化和同步 | `src/functions/registry-service.ts`, `src/functions/skill-registry.ts` |
| Workflow 执行 | `src/functions/remote-workflow.ts` |
| MCP 扩展端 | `src/background/mcp-bridge.ts` |
| MCP IDE 端 | `mcp-server/index.js`, `mcp-server/bridge.js`, `mcp-server/catalog.js` |
| 任务和取消 | `src/background/task-manager.ts`, `src/background/task-types.ts` |
| 标签页所有权 | `src/background/tab-lease-manager.ts` |
| 权限执行 | `src/background/policy-executor.ts` |
| Console | `src/options/OptionsApp.tsx`, `src/options/routes.tsx`, `src/options/pages/WorkflowsPage.tsx` |
| Bridge 使用和安全约定 | `MCP-BRIDGE.md` |
