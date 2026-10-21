# Actspan 修复 Spec

- 状态：执行基线
- 日期：2026-10-18
- 范围：品牌命名迁移、MCP 契约、Bridge 安全、任务隔离、工作流执行、Feishu 通知、文档与发布
- 目标：新运行时只暴露 Actspan canonical 命名；MCP、扩展和文档对同一行为给出一致契约；每个高风险问题都有可重复的行为验收。

## 1. 约束与命名规则

### 1.1 Active 命名空间

以下内容必须统一使用 `actspan`/`actspan_*`：

- 扩展、Popup、Sidepanel、Options Console 的用户可见品牌
- React 组件、Hook、Context、文件名和 import
- DOM ID、CustomEvent、`data-*` 标记和 CSS selector
- 日志标题、下载文件名、Webhook `source`、MCP 工具名和文档示例
- 安装目录、发布 zip、GitHub 链接和 package metadata

### 1.2 Legacy 兼容边界

旧 storage key、旧环境变量、迁移输入和兼容测试 fixture 只允许作为只读迁移输入：

- 迁移器可以读取旧 key 一次并写入 Actspan canonical key。
- 新业务禁止继续写入旧 key。
- 旧 key 必须保留在迁移常量、兼容测试、迁移诊断和历史记录中。
- 旧的上下文压缩 tag 只用于读取兼容；新事件使用 Actspan tag。
- 旧品牌不得出现在新的 UI、manifest、运行时日志、API 名称或安装说明中。

## 2. 当前基线

### 2.1 已解决，不得重复实现

1. **调查完成结果的 Feishu fallback**
   - `src/background/workflow-recorder.ts` 已在完成事件中携带结果摘要。
   - `src/background/session-manager.ts` 在完成 payload 缺少摘要时回退读取最新 assistant context。
   - `src/background/session-manager.test.mjs` 已覆盖正常 payload 与 fallback。

2. **远端 source 删除持久化**
   - `src/functions/skill-registry.ts` 已调用 `removeSourceSkills`。
   - `src/functions/registry-service.ts` 已提交 canonical snapshot 和 revision。
   - 修复 spec 只要求保留删除回归测试，不再把它列为待修复问题。

3. **Popup canonical registry 读取**
   - `src/App.tsx` 已从 `registryService.listAll().skills` 读取，并观察 `actspan_skills` 变化。
   - 修复 spec 只要求验证 registry mutation 后计数更新，不再恢复旧 key 读取。

### 2.2 P0：必须先完成

#### P0-1 Active 品牌与发布路径清理

证据范围：`src/content/`、`src/options/`、`src/sidepanel/`、`src/lib/`、`README*`、`MCP-BRIDGE.md`、`docs/`、`.github/`、`package.json`。

要求：

- active source 中不再使用旧品牌符号、DOM selector、事件名或用户文案。
- `MoleRoot`/`MoleContext`/`useMole` 等 active 文件和 import 完成协调迁移。
- 构建产物由源码重新生成，不手工修补 `build_version/`。
- 旧 storage/env key 和兼容 fixture 保持可迁移。

验收：

- 递归检查 source、文档、manifest、发布脚本和构建产物；排除显式 migration/compatibility 区域后不得出现旧品牌。
- `npm run build` 通过，`build_version/actspan-extension/` 中 manifest、资源、脚本与源码一致。
- 新 DOM 只生成 `actspan-*` 标识；录制器、DOM 保护、页面提取器和 React 入口使用同一命名。

#### P0-2 MCP 生命周期参数契约

当前问题：`mcp-server/index.js` 的 status/result/cancel schema 没有把 `taskId` 声明为 required，但运行时随后才拒绝缺失值。

要求：

- `actspan_agent_status`、`actspan_agent_result`、`actspan_agent_cancel` 的输入 schema 必须声明 `taskId` 必填。
- 缺失参数在 MCP schema 边界失败，不得先建立 Bridge 请求。
- 合法 taskId 继续保留 client/session/task 所有权约束。

验收：

- `tools/list` 中三个工具的 `required` 含 `taskId`。
- 缺失 taskId 的调用被参数校验拒绝。
- 合法 taskId 的 status/result/cancel 行为和所有权测试通过。

#### P0-3 本地 MCP 启动配置

当前问题：`mcp-server/catalog.js` 要求 `ACTSPAN_API_URL`/`ACTSPAN_API_KEY`，但本地 Bridge 路径没有调用云端 API；这会阻塞纯本地功能。

决定：

- 本地模式只要求有效的 `ACTSPAN_BRIDGE_URL` 和非空 `ACTSPAN_EXTENSION_IDS`。
- `ACTSPAN_API_URL`/`ACTSPAN_API_KEY` 只有实际启用控制面 API 时才要求；当前本地 Bridge 不把它们作为启动前置条件。
- 若保留云端配置字段，错误必须明确区分 local bridge 与 control plane，不得静默降级。

验收：

- 仅配置 Bridge URL、extension allowlist 时，MCP server 能启动、配对并完成 `actspan_status`。
- 无效 Bridge URL、缺失 allowlist 仍在 stderr 给出明确错误。
- API Key 不出 stdout、工具响应、命令行参数或 npm 包。

## 3. P1：安全与执行边界

### P1-1 Bridge 配对真实性

不能把客户端提交的 `Origin` 单独当作扩展身份。allowlist 仍是必要条件，但必须增加扩展不可伪造的配对证明（例如扩展保存的 pairing secret/一次性 challenge），并使 token handshake 绑定该证明。

验收：伪造 allowlisted Origin 但没有 pairing proof 的 socket 无法获得 token；合法扩展可以配对；拒绝原因不泄露 token。

### P1-2 统一 capability ownership

- `tab.open` 必须进入 policy allowlist，并创建当前 task 的 tab lease。
- 新 MCP task 的 screenshot 必须遵循明确策略：自动创建 task，或使用文档声明的 active-tab read-only fallback；实现与文档只能保留一种行为。
- click/type/navigate/close/eval/screenshot 必须使用统一 `PolicyExecutor`、task/session/client/tab 约束。
- 同一 tab 操作 FIFO；不同 tab 不互相阻塞；非 owner 不能 detach debugger。

验收：两个 client 不能互操作对方 tab；取消后不产生新副作用；fresh task 的截图行为与 MCP 文档一致。

## 4. P1：Workflow 与异步任务契约

### P1-1 Workflow schema

内置 manifest、Options、Registry Service 和 runner 必须使用同一规范化结构。`action/params/saveAs` 仅作为明确声明的 legacy 输入；canonical workflow 使用 `id/capability/input` 或 spec 规定的统一结构，不能出现“文档可写但 runner 拒绝”的路径。

验收：每个内置 workflow 可被 `normalizeWorkflow` 接受并实际运行；非法步骤在保存前失败；workflow run 返回 task handle。

### P1-2 收尾和审计

- `closeOpenedTabs: on_success` 必须只在成功时关闭；always 策略必须明确配置。
- 每个步骤记录 start/end、capability、结果摘要和错误；不记录敏感页面内容或凭证。
- task status/result/cancel 的 owner 校验和重连恢复必须可测试。

验收：成功/失败/取消三种收尾路径都有行为测试；旧 socket 的迟到响应不会交付到新 socket。

## 5. P1：Feishu 稳定能力契约

`actspan_feishu_push` 是稳定 MCP 工具，必须在以下位置保持一致：

- `mcp-server/index.js`
- `mcp-server/catalog.js`
- `mcp-server/test/e2e.mjs`
- `MCP-BRIDGE.md`
- 本 spec 和架构 spec

契约：

- 参数：`title`、`message`，可选 `webhookName`。
- 不需要 tab、浏览器确认或页面权限。
- 指定 `webhookName` 时只发送到对应启用 webhook；省略时按默认 all 行为。
- 无启用 webhook、网络失败、非 2xx、非预期响应体都必须返回失败，不得把 HTTP 200 非 JSON 或 `sent: 0` 报告为成功。
- 工具清单、测试断言和文档中的数量一致，当前基线为 34 个稳定工具。

验收：成功、指定 webhook、无 webhook、HTTP 错误、HTTP 200 非 JSON 均有测试。

## 6. P2：传输和文档一致性

- `wss://` 配置不得被静默降级为 `ws://`；不支持时启动即报错，支持时端到端使用 TLS。
- `MCP-BRIDGE.md` 必须包含 Feishu 工具和真实测试命令，不得继续写旧工具数量。
- 配置文档只描述 `actspan_ai_settings`；legacy key 仅在迁移说明中出现。
- release workflow、下载页、GitHub 链接、目录名和 package metadata 全部指向 Actspan。

## 7. 实施顺序

1. Active Actspan 命名迁移、文件/import/CSS/DOM 协调替换，重新构建。
2. MCP schema required 参数和本地启动配置。
3. Feishu 稳定契约、文档和错误语义。
4. Bridge pairing proof、Policy/Task/Tab ownership。
5. Workflow schema、收尾策略和审计字段。
6. TLS、发布和最终文档清理。

每一步都必须先写可失败的行为测试，再写最小实现；不得用放宽校验、吞错或保留双写掩盖问题。

## 8. 完成定义

- 新安装只产生 Actspan canonical namespace。
- 升级安装只读取 legacy 输入一次，之后运行时不依赖旧事实源。
- active source、用户文案、manifest、文档和构建产物无旧品牌残留。
- MCP tools/list、catalog、docs、e2e 和架构 spec 的稳定工具契约一致。
- P0/P1 验收测试全部通过；已解决问题没有重复修复分支。
