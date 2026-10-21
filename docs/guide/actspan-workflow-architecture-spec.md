# Actspan 工作流与 Skill 自动同步重构 Spec

- 状态：已确认架构基线
- 范围：扩展运行时 Skill Registry、工作流管理控制台、MCP Bridge、浏览器任务执行边界
- 目标：用户只安装一次扩展和 MCP Bridge；之后新增、修改、删除工作流无需重新上传扩展、重载扩展或重启 IDE，Actspan 控制台和 IDE 能看到同一份最新能力目录。
- 当前修复项与验证状态维护在 [Actspan 修复 Spec](./actspan-repair-spec.md)。

## 1. 问题与现状

当前系统存在两套工作流注册表：

- 迁移前的新 Skill Registry：`mole_skills`，支持 global/domain manifest、用户 Skill、远端同步和 `skill list/detail/run`。
- 迁移前的旧 site-workflow Registry：`mole_site_workflows_v1`，Options 工作流控制台仍只读写该存储。

因此当前行为不满足“保存即同步”：

- AI 保存同时写入新旧注册表：`src/functions/save-workflow.ts:50-79`。
- Options 控制台只写旧注册表：`src/options/pages/WorkflowsPage.tsx:30-63,86-270`。
- Options 的失效通知只重载旧注册表：`src/background/workflow-handlers.ts:144-154`。
- 历史记录（已解决）：Skill API 现在通过 `registryService.listAll()` 读取 canonical snapshot 和 revision。
- 历史记录（已解决）：MCP 已提供 Skill/workflow catalog 与异步执行能力；当前稳定工具清单另包含 `actspan_feishu_push`，共 34 个工具。
- 历史记录（已解决）：远端同步删除现在通过 Registry Service 原子提交 source removal 和 revision，见 `src/functions/skill-registry.ts` 与 `src/functions/registry-service.ts`。
- 历史记录（已解决）：Popup 现在通过 `registryService.listAll().skills` 读取 canonical snapshot，并监听 `actspan_skills` 变化；不再假设旧 registry 是数组。

现有 MCP 边界已经明确：IDE Agent 负责编排，扩展负责浏览器执行；扩展不应被重新上传来更新工作流：`MCP-BRIDGE.md:8-11`。
当前并发和安全边界也不足以直接承载目标架构：

- `session-manager.ts:1065-1110,1210+` 使用全局 active session；新运行会停止其他运行中的 session。
- `session-channel-handlers.ts:55-499` 主要按 sender tab 路由，不能形成独立的 client/task lease。
- `src/ai/tab-tracker.ts:12-72` 是进程级集合，`closeAll` 可能清理其他任务创建的 tab。
- `src/background/mcp-bridge.ts:101-140,203-280` 使用全局 agent-tab 集合；显式 `tabId` 可绕过 ownership，且没有 per-tab 排队。
- MCP 入口直接转发到 Bridge，未复用 AI 的权限确认：`mcp-server/index.js:27-139`、`src/ai/tool-executor.ts:134-209,267-274`。
- Bridge 默认允许任意 `chrome-extension://` origin 自动配对，且请求没有 caller/tab 绑定；debugger attach/detach 也没有 owner lease：`mcp-server/bridge.js:80-116`、`src/background/mcp-bridge.ts:168-180`。

这些问题必须作为重构验收项，不得仅通过新增 MCP 工具掩盖。

## 2. 目标与非目标

### 2.1 目标

1. 建立唯一的持久化 Skill/workflow 模型。
2. 统一 AI 保存、Options 控制台、远端同步和 MCP 查询的数据路径。
3. MCP 工具集合保持稳定，不为每个新 workflow 动态注册工具。
4. 保存成功后立即更新扩展缓存、控制台和已连接 MCP 的可见目录。
5. 明确 workflow、session、task、tab 的所有权和并发边界。
6. 普通浏览器任务遵循 DOM 优先、最小能力原则。
7. 长任务支持异步提交、进度、结果、取消和重连查询。
8. 保留一次安装体验：运行时数据更新不要求扩展重新加载。

### 2.2 非目标

- 不把 MCP server 变成 workflow 的永久存储。
- 不为每个 workflow 生成一个 MCP 工具。
- 不上传或复制用户 Cookie、登录态或页面凭证。
- 不重写现有 `src/ai` Agent Loop 的全部实现；只统一其能力、权限和任务边界。
- 不用截图替代可确定的 DOM 操作。
- 插件代码、manifest、权限或 Bridge 协议发生不兼容变化时，仍需要更新扩展版本。

### 2.3 Actspan 品牌命名与视觉重构

本次重构不是给现有 MoleClaw 界面换一层颜色，而是完成 Actspan 的品牌切换。现状章节中保留 `MoleClaw`、`Mole`、`鼹鼠` 及旧 `mole_*` 标识，仅用于准确描述迁移前状态；新产品、新 UI、新 API 和新文档不得继续暴露这些名称。

#### 命名切换

- 新产品名统一为 `Actspan`；扩展、Popup、Sidepanel、Options/Skill Console、文档、帮助文案、MCP server 的用户可见名称统一使用 Actspan。
- `MoleClaw`、`Mole`、`鼹鼠`、`Mole assistant` 及其变体不得出现在新 manifest 的 `name`/`description`、页面标题、导航、按钮、空状态、错误提示、`alt`/`title`、日志提示或新 API 名称中。
- 新运行时命名空间统一使用 `actspan_`：canonical store 为 `actspan_skills`，MCP 工具为 `actspan_*`，事件和新持久化 key 使用 `actspan_*` 前缀。
- 迁移器只读取旧 `mole_*` key 和旧 `mole_site_workflows_v1` 一次，转换并原子写入 Actspan 命名空间；禁止新旧双写。旧名称只保留在迁移诊断、兼容测试和变更记录中，不进入新目录或 UI。

#### 图标与视觉方向

- `public/actspan-logo.svg` 作为唯一矢量源；由同一源导出 Chrome manifest 所需的 16/48/128 PNG，不再把旧 `logo.png` 作为品牌源。
- 新标志采用“动作跨越实时浏览器边界”的抽象图形：开放框架、连续路径和连接节点；不得复用鼹鼠、爪子、地下隧道、宝藏或彩虹环形吉祥物。
- 视觉基线使用深海军蓝 `#14253A`、行动蓝 `#2563EB` 和白色留白；不得继续使用现有 MoleClaw 的蓝紫渐变、彩虹环和拟物鼹鼠形象。后续可增加单一高对比强调色，但必须保持图标在 16px 下可识别、单色下可用。

#### 控制台重构

- 控制台品牌标题统一为 `Actspan Console`，工作流页统一称为 `Skills & Workflows`/“技能与工作流”；删除 `Mole`、`MoleClaw`、`站点工作流管理` 等旧品牌或旧信息架构文案。
- 控制台必须采用新的信息架构和布局，不得只在现有 Ant Design 侧栏、卡片和蓝紫主题上换色。推荐使用顶部品牌/命令栏 + 工作区画布 + 能力列表/运行详情分栏，突出 registry revision、同步状态、来源和任务上下文。
- 控制台视觉验收必须同时满足：新图标已接入、旧名称零可见、旧彩虹/蓝紫视觉零复用、主导航和工作区层级与现状明显不同，并在浅色和深色背景下保持可读性与键盘可达性。

#### 品牌验收

- manifest、Options、Popup、Sidepanel、文档站和 MCP 状态中的用户可见品牌均为 Actspan。
- 新安装只产生 Actspan 命名空间；升级安装完成一次迁移后，旧 `mole_*` 数据不再作为运行时事实源。
- 搜索构建产物、页面文本、SVG 元数据和资源清单不得出现旧品牌，除迁移诊断与兼容测试明确允许的记录外。

#### 必须覆盖的品牌触点

- 扩展身份与图标：`public/manifest.json`、`public/actspan-logo.svg` 以及由构建生成的 manifest/icon 资源；`build_version` 只能由源码构建产物生成，不手工维护旧品牌副本。
- Popup/Sidepanel/Options：`src/App.tsx`、`src/options/OptionsApp.tsx`、`src/options/routes.tsx`、`src/options/pages/WorkflowsPage.tsx`；包括品牌标题、logo、`alt`/`title`、菜单、空状态、按钮和错误提示。
- 浏览器运行时：`src/content/float-ball-react.tsx`、`src/background/channel-handlers.ts`、`src/ai/system-prompt.ts`；包括悬浮助手名称、通知图标、徽章文本和 Agent 自我介绍。
- 文档与发布页：`README.md`、`README.en.md`、`docs/.vitepress/config.ts`、`docs/index.md`、`docs/en/index.md`、下载页和配置指南；名称、favicon、主题 logo、hero 文案和安装说明必须一致。
- 旧 `logo.png`、旧品牌 SVG 元数据和构建目录中的残留资源必须在切换后删除或由 Actspan 资源替换，不能继续作为运行时入口。

## 3. 总体架构

```text
                    ┌─────────────────────────┐
                    │ Options / Sidepanel      │
                    │ Actspan Console          │
                    └───────────┬─────────────┘
                                │ shared service
┌──────────────┐     ┌──────────▼─────────────┐     ┌─────────────────┐
│ IDE Agent    │────▶│ MCP Server / Bridge    │────▶│ Extension SW    │
│ 编排跨系统任务 │ MCP │ stable tools + events  │ WS  │ canonical registry│
└──────┬───────┘     └──────────┬─────────────┘     │ task/session/tab │
       │                        │                   └────────┬────────┘
       │                        └── catalog/run/status       │
       │                                                    ▼
       │                                           Chrome tabs / DOM / CDP
       ▼
  其他 MCP / 外部系统
```

### 3.1 权威数据源

`actspan_skills` 是唯一的运行时 Skill/workflow 持久化模型。其顶层结构至少包含：

```ts
interface SkillRegistryStore {
  schemaVersion: number;
  revision: number;
  skills: SkillSpec[];
  updatedAt: number;
}
```

每个 `SkillSpec` 和 `WorkflowEntry` 必须包含：

- 稳定名称和版本
- `source`: `user | remote | builtin`
- `scope`: `global | domain`
- URL/domain 匹配规则
- `updatedAt`
- 可选 `contentHash`
- workflow 的结构化步骤和输入契约

`mole_site_workflows_v1` 仅作为一次性迁移输入，迁移完成后禁止继续作为 UI 或执行路径的事实源。

### 3.2 来源和覆盖规则

同一 `scope + name` 冲突时按以下顺序覆盖：

```text
user > remote > builtin domain seed > builtin global
```

Global 和 domain 作用域不同，不得因为名称相同而互相静默覆盖。远端 manifest 删除条目时：

- 只删除该远端 source 拥有的缓存条目；
- 不删除 user 或 builtin 条目；
- 删除结果与版本更新一起原子持久化；
- 来源移除的策略必须明确为“删除该来源条目”，不能只删除 source metadata。

## 4. 注册表同步协议

### 4.1 本地写入

AI 保存、Options 控制台保存、编辑、删除、导入都必须调用同一个 Registry Service：

```text
validate → normalize → mutate canonical store → increment revision
→ persist atomically → refresh in-memory snapshot
→ broadcast registry_changed → return revision
```

任何写入成功后，以下读取必须观察到同一 revision：

- Skill API `list/detail/run`
- Options 控制台
- MCP `actspan_skills_list/detail`
- 已连接的任务上下文

### 4.2 跨上下文通知

扩展内部使用 `chrome.storage.onChanged` 作为最终一致性兜底，并使用显式 runtime/WS 事件降低延迟：

```ts
interface RegistryChangedEvent {
  type: 'registry_changed';
  revision: number;
  changedSkills: string[];
  reason: 'user_save' | 'user_delete' | 'remote_sync' | 'migration';
  timestamp: number;
}
```

规则：

- 当前请求完成后不得继续使用旧快照。
- 已运行的单个请求可以固定其开始时的 revision，结果必须标记该 revision。
- MCP server 不保存长期副本；最多保留按 revision 失效的短期请求缓存。
- Bridge 重连后必须重新拉取完整 snapshot 或 revision 差异。

### 4.3 远端 Manifest

保留启动同步和定时同步，但改为：

- 使用版本、ETag 或 content hash 避免无效下载。
- 更新和删除在一次事务内写入。
- 只发生删除时也必须持久化。
- 同步失败保留上一份可用 snapshot，并在 Console/MCP 状态中暴露错误。
- 首次查询不等待无限期远端网络；先返回本地 snapshot，并带 `syncStatus`。
- 本地用户修改立即可见，不等待远端同步。

## 5. Actspan Skill Console

Options 的 `workflows` 页面升级为统一 Actspan Skill Console，仍保留现有控制台入口：

- `src/options/OptionsApp.tsx`
- `src/options/routes.tsx`
- `src/options/pages/WorkflowsPage.tsx`

控制台必须展示：

- Skill/workflow 名称、版本、作用域和来源
- 当前 registry revision
- 最后更新时间
- 当前同步状态：`ready | syncing | stale | error`
- 远端 manifest 来源和错误
- 启用/禁用状态
- workflow 的步骤摘要和匹配域名
- MCP Bridge 连接状态
- 任务运行记录、状态和所属标签页

控制台保存、编辑、删除、导入必须直接更新 canonical store。成功后不需要用户刷新页面；失败必须显示可定位错误，不得只显示成功提示。

## 6. 稳定 MCP 能力面

MCP 工具名固定，workflow 数量变化不能改变工具目录：

### 6.1 必需工具

```text
actspan_status
actspan_tabs_list
actspan_tab_open
actspan_tab_close
actspan_tab_navigate
actspan_page_read
actspan_page_click
actspan_page_type
actspan_page_eval
actspan_screenshot

actspan_skills_list
actspan_skill_detail
actspan_workflow_run

actspan_agent_submit
actspan_agent_status
actspan_agent_result
actspan_agent_cancel

`actspan_feishu_push`
```

`actspan_skills_list` 至少返回：

```ts
{
  revision: number;
  skills: SkillSummary[];
  syncStatus: string;
  generatedAt: number;
}
```

`actspan_skill_detail` 返回完整 Skill、workflow 版本、步骤契约和适用域名。

`actspan_workflow_run` 必须携带或生成 `taskId`，返回任务句柄，不得把长任务强行阻塞为单次同步 MCP 调用。

工作流的保存、编辑、删除以 Console 和 AI 保存工具为主要入口；若未来开放 MCP CRUD，必须复用同一个 Registry Service，并单独声明写权限和用户确认，不得直接改存储。

### 6.2 一次安装保证

首次安装并完成 Bridge 配置后：

- 新增 workflow 不要求重新上传扩展。
- 不要求重启 MCP server。
- 不要求重启 IDE。
- IDE 下一次调用 `actspan_skills_list` 或 `actspan_skill_detail` 即可看到新 revision。
- Bridge 连接断开重连后自动重新同步 registry snapshot。

### 6.3 npm 本地 MCP 发布与客户端配置

MCP Server 以 `@actspan/mcp-server` 发布到 npm，提供 `actspan-mcp` 启动入口，使用 stdio 作为 IDE Agent 的 MCP 传输。用户不需要手动下载源码；客户端 MCP 配置通过 `npx` 将固定版本下载到本地缓存并启动。

客户端配置的最小形式：

```json
{
  "mcpServers": {
    "actspan": {
      "command": "npx",
      "args": ["--yes", "@actspan/mcp-server@1.0.0"],
      "env": {
        "ACTSPAN_API_URL": "https://api.example.com",
        "ACTSPAN_API_KEY": "replace-with-user-key",
        "ACTSPAN_BRIDGE_URL": "ws://127.0.0.1:30121"
      }
    }
  }
}
```

配置契约：

- `ACTSPAN_API_URL` 是用户自己的 Actspan 直达 API/控制面地址，必须使用 HTTPS；模型供应商的 LLM endpoint 不属于 MCP Server 配置范围。
- `ACTSPAN_API_KEY` 由 MCP Server 从 `process.env` 读取，只用于直达 API 鉴权；不写入 npm 包、不放在命令行参数、不传给网页或不需要它的扩展上下文。
- `ACTSPAN_BRIDGE_URL` 只指向本机扩展 Bridge，默认值为 `ws://127.0.0.1:30121`；Bridge 连接必须继续执行 extension ID allowlist 和 request/client/task 绑定。
- 客户端 MCP JSON 是首选配置入口；首期不要求 MCP Server 额外维护用户配置文件。环境变量优先级高于内置默认值，缺少必填值时必须在 stderr 返回可操作错误，不能在 stdio 通道中交互提问。
- `npx` 配置必须锁定具体版本，禁止默认拉取 `latest`；升级由用户显式修改版本完成。
- MCP stdout 只能输出 MCP JSON-RPC；启动日志、诊断信息和错误详情写入 stderr 或专用日志文件，Key 必须脱敏。
- MCP Server 启动时只能存在一个兼容的本地 Bridge owner；发现已有兼容 owner 时复用，发现不兼容 owner 或 `EADDRINUSE` 时退出并报告 PID/端口诊断，禁止静默启动第二个 Bridge。

运行边界固定为：IDE Agent → 本地 npm MCP（stdio）→ 本地 Bridge（WebSocket）→ Chrome 扩展；远程 API 只用于明确声明的 Actspan 服务调用。

## 7. 确定性 Workflow 能力层

workflow 必须是结构化、可版本化、可验证的步骤，而不是只保存一段不可检查的自然语言：

```ts
interface WorkflowStep {
  id: string;
  capability:
    | 'page_read'
    | 'page_click'
    | 'page_type'
    | 'page_eval'
    | 'screenshot'
    | 'agent_delegate';
  input: Record<string, unknown>;
  optional?: boolean;
  onError?: 'stop' | 'retry' | 'fallback';
}
```
- `stop`（默认）终止工作流并将任务标记为失败。
- `retry` 只允许一次额外尝试，等待 250ms；仍失败则终止，避免无限重试和重复副作用。
- `fallback` 跳过失败步骤并记录 `{ stepId, skipped, error }` 后继续；`optional` 保持相同的兼容语义。
- `PolicyError`、`TabLeaseError` 和已取消任务始终终止当前工作流，不能被 `retry` 或 `fallback` 吞掉。

执行器必须记录：

- workflow name/version
- registry revision
- task/session ID
- 每步开始、结束、结果和错误
- 实际使用的 capability
- 产生的 tab 和副作用

workflow 与自由 Agent 任务分开：

- `actspan_workflow_run`：按保存步骤确定性执行。
- `actspan_agent_submit`：处理 workflow 无法表达的开放任务。
- Agent 不得隐式修改或创建 workflow。

## 8. 最小能力路由与 DOM 优先

能力选择顺序：

1. 结构化页面读取和 DOM 定位。
2. 原子点击/输入/导航。
3. 页面上下文 `eval`，仅在必须访问框架状态或页面 API 时使用。
4. 截图/视觉分析，仅在 DOM 无法表达目标时使用。
5. debugger/CDP 高权限能力，仅在明确需要且经过权限检查时使用。

普通 workflow 不得默认截图或 `eval`。每次升级到更高能力必须记录原因；失败回退也必须有明确条件，不能无限尝试不同工具。

## 9. 任务、Session 和标签页所有权

### 9.1 任务模型

```ts
interface BrowserTask {
  taskId: string;
  sessionId: string;
  owner: 'ide-agent' | 'extension-agent' | 'user';
  state: 'queued' | 'running' | 'waiting_user' | 'succeeded' | 'failed' | 'cancelled';
  ownedTabIds: number[];
  activeTabId?: number;
  registryRevision: number;
  createdAt: number;
  updatedAt: number;
}
```

所有写操作都必须能追溯到 `taskId`。不能依赖全局“最近打开的标签页”执行写操作。
- 每个 task 必须拥有独立的 tab lease；lease 至少包含 `taskId`、`sessionId`、`clientId`、tabId、创建者和过期/释放状态。
- `tabId` 显式参数不能绕过 ownership。若目标 tab 不属于当前 task，必须经过显式用户授权并记录原因。
- 同一 tab 的操作必须串行化；不同 tab 可以并发。
- debugger attachment 必须记录 owner；只能由 owner detach，不能因为一次请求结束而无条件 detach 其他 owner 的 attachment。
- 当前全局 active session 的“新任务取代旧任务”行为必须改为显式策略：默认允许独立 task 并发；只有同一 session 的 continue/replace 请求才取消旧 run。

 现有防劫持约定 `MCP-BRIDGE.md:58-61` 保留并提升为强制协议。

### 9.2 标签页规则

- agent 创建的 tab 默认后台打开，不抢用户焦点。
- 任务只能默认操作自己创建的 tab。
- 操作用户已有 tab 必须显式传 `tabId`，并经过权限策略。
- 只读页面读取可以使用显式指定的活动 tab，但结果必须记录 tabId/url。
- 任务结束只关闭自己拥有的 tab。
- 用户手动关闭 tab 后，任务收到明确的 `tab_closed` 错误。
- 并发任务之间不能共享隐式 tab 状态。


## 10. 共享策略与 Agent Loop 边界

权限、确认、重试、超时、取消、审计和错误归一化由一个共享 Policy/Executor 层实现。

禁止嵌套规划：

```text
MCP → extension agent → MCP → extension agent
```

允许的边界：

```text
IDE Agent
  ├─ 调用 actspan_workflow_run
  ├─ 调用 actspan_agent_submit（浏览器本地任务）
  └─ 调用其他 MCP

Extension Agent
  └─ 只能调用扩展内部已注册浏览器能力
```

扩展 Agent 不得反向调用 MCP server，不得创建第二个浏览器 Agent Loop。

所有入口都必须经过同一权限级别：

```text
read < interact < sensitive < dangerous
```

`eval`、表单提交、账号设置、支付等能力必须保留显式确认或信任状态；MCP 入口不得绕过现有确认机制。
- MCP、AI、Console 以及内部 Agent 都必须调用同一个 Policy/Executor，不得由 MCP 直接调用原子 Bridge 绕过检查。
- MCP 请求必须携带受认证保护的 `clientId`、`requestId`、`taskId` 和目标 tab 上下文；响应只能回到发起该请求的连接。
- `eval`、click、type、navigate、close、表单提交等能力必须按工具元数据分级；当前 MCP 的“全部直接转发”不再允许。
- approval 必须绑定 `requestId + clientId + taskId + tabId`。全局 `trustAll` 不能授权其他客户端、其他任务或其他 tab。
- 默认配对必须限制为明确的 extension ID allowlist；不能把任意 `chrome-extension://` origin 视为可信调用者。
- Bridge 重连时必须隔离旧 socket 的 pending response，不能把迟到响应交给新连接。

## 11. 异步 MCP 任务协议

### 11.1 生命周期

```text
submit → queued → running →
  succeeded
  failed
  cancelled
  waiting_user
```

任务接口：

- `actspan_agent_submit`：返回 `taskId` 和初始状态。
- `actspan_agent_status`：返回状态、进度、当前步骤和错误摘要。
- 任务恢复必须校验 `clientId`/owner；仅持有 `taskId` 不足以获得其他客户端的敏感结果或控制权。
- task 事件必须包含 `taskId`、`runId` 和 `clientId`，避免旧 run 或旧 socket 的事件污染当前任务。
- `actspan_agent_result`：返回最终结果、审计摘要和 registry revision。
- `actspan_agent_cancel`：幂等取消；取消后禁止开始新的浏览器副作用。

### 11.2 重连

任务状态和最终结果必须保存在扩展后台可恢复的任务存储中。MCP server 重启、IDE 重连或 service worker 重启后，可以用 `taskId` 查询，而不是丢失任务。

## 12. 迁移阶段

### Phase 1：Canonical Registry

- 为新旧结构建立一次性迁移器。
- 将 `mole_site_workflows_v1` 转换为 `actspan_skills`。
- AI、Console、Skill API 改为调用同一个 Registry Service。
- 增加 revision、source、hash 和原子持久化。
- 旧 key 进入只读迁移兼容期，禁止继续写入。

### Phase 2：缓存和同步一致性

- 实现 `storage.onChanged` 和 `registry_changed`。
- 修复 startup sync race、删除不持久化和 source removal 残留。
- Console 订阅更新事件。
- 修复 Popup 对存储对象形状的错误假设。

### Phase 3：MCP Catalog

- 增加 `actspan_skills_list/detail/actspan_workflow_run`。
- MCP 请求读取当前 registry snapshot，不复制 workflow 文件。
- 增加 revision 和 syncStatus。
- 增加 MCP next-lookup 自动可见性。

- 发布 `@actspan/mcp-server`，声明 `actspan-mcp` bin、支持的 Node 版本和 stdio transport。
- 通过客户端 MCP JSON 的 `env` 注入直达 URL、Key 和 Bridge URL；不新增服务端用户配置文件依赖。
- 对 npx 首次下载、固定版本启动、配置缺失和 API 鉴权失败提供可定位错误。

### Phase 4：Task/Tab Isolation

- 为现有 session manager、tab tracker 和 MCP dispatch 引入 `taskId/sessionId`。
- 移除写操作的隐式最近 tab 路由。
- 统一任务取消、清理和重连恢复。
- 将全局 active session 改为 `sessionId → runId/taskId` 的显式关系；同一 session 的 continue/replace 才执行取消，跨 session 默认隔离。
- 将 `tab-tracker` 和 MCP agent-tab registry 改为 task/session/client keyed lease，禁止全局 `closeAll` 清理其他 owner 的资源。
- 为每个 tab 建立串行操作队列，为 debugger attachment 建立 owner-aware attach/detach。
- 统一 MCP 与 AI 的 caller context、权限级别、确认和审计字段。
- 收紧 pairing origin allowlist，并为 socket response 增加 request/client affinity。

### Phase 5：统一 Executor 和 Agent Loop

- 将权限确认、工具执行、错误归一化收口到共享执行层。
- 明确 IDE Agent 与 Extension Agent 的单层边界。
- 将 DOM-first 和最小能力路由写入 Skill/Policy。

### Phase 6：删除旧路径

- 删除旧 registry 的运行时读写和失效通知。
- 删除仅服务旧 workflow 的兼容分支。
- 保留迁移诊断信息，不保留双写。

## 13. 验收标准

### 注册表与控制台

- Console 新增、编辑、删除、导入后，`skill list`、Console 和 MCP catalog 在同一 revision 可见。
- AI 保存 workflow 后，Console 无刷新显示新内容。
- Console 不再只显示旧 `mole_site_workflows_v1` 数据。
- global、domain seed、remote、user 来源可区分且按规则覆盖。
- 远端高版本、同版本、低版本、删除和 source removal 行为有确定结果。
- service worker 重启后 registry 从 canonical store 恢复。

### 一次安装和自动同步

- 扩展和 MCP Bridge 安装一次后，workflow 数据更新不需要重新上传、重载扩展、重启 MCP 或重启 IDE。
- 保存后下一次 MCP catalog 查询返回新 revision。
- Bridge 重连后自动恢复 catalog。
- 同步错误可在 Console 和 MCP 状态中看到，且不会破坏上一份可用 snapshot。

### 能力和安全

- 普通读取/点击/输入不调用截图或 `eval`。
- DOM 失败时才按策略升级能力。
- MCP、Console、AI 三个入口使用同一权限检查。
- 任意写操作都有 task/session/tab 审计记录。
- 并发任务不能操作彼此拥有的标签页。
- 任务取消后不再启动新的浏览器副作用。
- 不产生嵌套 Agent Loop。
- 两个不同 client 的 explicit `tabId` 越权操作被拒绝；显式授权路径可审计。
- 同一 tab 的并发操作按提交顺序执行，不同 tab 不互相阻塞。
- debugger attachment 不会被非 owner 请求 detach。
- MCP eval/click/type/close/navigate 会进入统一权限和确认路径；旧的直接转发路径不存在。
- 默认配对拒绝未列入 allowlist 的 extension origin。
- 旧 socket 的迟到响应不会交付给新 socket。

### 必须覆盖的测试场景

1. Console save/edit/delete/import → Skill API list/detail/run。
2. AI save → Console 和 MCP catalog。
3. 远端高版本、同版本、低版本和仅删除同步。
4. global/domain/user/remote 优先级。
5. service worker 重启后恢复。
6. MCP 连接保持期间 workflow 更新后的 next lookup。
7. MCP 断线重连后的 catalog 恢复。
8. 两个并发 task 的 tab 隔离和清理。
9. DOM 操作成功路径与截图/eval 受控回退。
10. 长任务查询、取消、失败和 IDE 重连恢复。
11. 两个不同 client 对同一 explicit `tabId` 的越权操作被拒绝，显式授权可追溯。
12. 同一 tab 的并发操作按顺序执行，非 owner 不能 detach debugger。
13. MCP eval/click/type/close/navigate 经过统一权限确认，旧 socket 迟到响应被丢弃。
14. 未列入 allowlist 的 extension origin 无法自动配对。
15. 同一 session 的 replace 会取消旧 run，不同 session 的独立 task 可以并发。
16. 新客户端仅配置 `@actspan/mcp-server@固定版本` 即可完成 npx 下载、stdio 握手和 `actspan_status` 查询。
17. `ACTSPAN_API_URL`、`ACTSPAN_API_KEY` 和 `ACTSPAN_BRIDGE_URL` 能从客户端 MCP JSON 正确注入并被服务端读取。
18. 缺少 URL、Key、Bridge 或使用无效 URL 时，MCP Server 在 stderr 返回明确错误，不发送未认证请求。
19. Key 不出现在 stdout、日志、工具响应、命令行参数和 npm 包内容中。
20. 同时启动两个本地 MCP 实例时只能复用兼容 Bridge 或明确拒绝第二个 owner，不产生静默的 `EADDRINUSE` 竞争。

## 14. 运行与兼容性约束

- MCP server 继续使用固定本地 Bridge；同一端口只能有一个有效 server owner，避免重复启动导致 `EADDRINUSE`。
- Bridge pairing 使用明确的 extension ID allowlist；默认拒绝未知 origin。
- Bridge 必须保证 request/response 的 socket、client 和 requestId 亲和性。
- MCP server 的单 client 限制若保留，必须在 `actspan_status` 中显式报告 owner 和替换原因；不能静默替换正在运行的任务连接。
- 日志写入专用日志文件或受管进程日志，不输出到当前 MCP stdio 协议流。
- 运行时数据同步不能改变扩展权限声明。
- 只有扩展代码、权限、manifest 或 Bridge 协议变化才触发扩展升级。
- npm 包必须声明支持的 Node 版本并固定生产依赖版本；客户端配置必须锁定 MCP 包版本。
- MCP 客户端配置文件不得进入仓库、发布包或构建产物；示例只能使用占位 Key。
- 直达 API 的 URL、Key 和 Bridge URL 必须分别校验，错误不能被转换为成功的空结果。

## 15. 完成定义

重构完成必须同时满足：

1. canonical registry 已成为唯一运行时事实源。
2. Console、AI、Skill API、MCP catalog 读取同一 revision。
3. workflow 数据更新无需重新安装或重载扩展。
4. 八项能力与安全原则已由执行器和任务协议落实，而不只是文档约定。
5. 上述验收场景全部有行为测试或端到端验证证据。
6. 旧 registry 双写、旧缓存失效和隐式 tab 写操作路径已删除。
7. npm 本地 MCP 可由客户端 MCP JSON 独立下载并启动，配置、鉴权、Bridge owner 和敏感信息边界均有行为验证。
