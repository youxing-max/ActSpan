# Actspan MCP Bridge（本地版）

让 IDE（Trae / Qoder / Cursor 等）里的 agent 通过 MCP **直接操作用户自己的 Chrome**——复用全部登录态与 cookie，凭证不出浏览器，MCP 链路只传指令和结果。

## 架构

```
IDE agent ──stdio MCP──> mcp-server/index.js ──ws://127.0.0.1:30121(token 鉴权)──> 扩展 background(mcp-bridge.ts) ──> chrome.tabs/scripting/debugger
```

编排大脑就是 IDE 里的 agent 本身；扩展只做原子执行。`src/ai` 原有 agent 循环不受影响。

## 使用步骤

1. **构建扩展**：`npm install && npm run build`，在 `chrome://extensions` 开发者模式加载 `build_version/actspan-extension/`。
2. **IDE 里注册 MCP**（Trae/Qoder/Cursor 等 MCP 客户端通用写法；密钥放 `env`，不要写入命令行参数）：

```json
{
  "mcpServers": {
    "actspan-browser": {
      "command": "node",
      "args": ["<仓库根目录>/mcp-server/index.js"],
      "env": {
        "ACTSPAN_API_URL": "https://api.example.com",
        "ACTSPAN_API_KEY": "<your-key>",
        "ACTSPAN_BRIDGE_URL": "ws://127.0.0.1:30121",
        "ACTSPAN_EXTENSION_IDS": "<扩展在 chrome://extensions 中显示的 32 位 ID>"
      }
    }
  }
}
```

也可以在安装 `@actspan/mcp-server` 后，将 `command` 改为 `actspan-mcp` 并省略 `args`，其余环境变量保持不变。

3. **必须配置扩展 allowlist**：`ACTSPAN_EXTENSION_IDS` 是必填项，支持逗号分隔的多个精确扩展 ID。缺失、格式错误或不在名单中的扩展会被 MCP server 拒绝，server 不会启动无 allowlist 的自动配对。

4. 保持 Chrome 打开即可。agent 调 `actspan_status` 显示 connected 就能干活；用户 Chrome 不用在前台。


> **一个端口只能有一个主人**：30121 同时只允许一个 MCP server 进程绑定。多个 IDE/CLI 同时启动本连接器时，后启动的一方会退出并在 stderr/日志报告端口 owner；不要并行启动多个实例。

### 在 Codex 里怎么用

重启 Codex 后，直接对 agent 说自然语言即可，例如：

- `先检查浏览器桥接状态，然后打开 https://example.com，读取页面标题和正文。`
- `用我的 Chrome 打开这个后台页面，不要切换前台，读取登录后的订单信息。`
- `列出当前标签页；只关闭本次任务由你打开的标签页。`

agent 会按需调用 `actspan_status`、`actspan_tab_open`、`actspan_page_read` 等工具。推荐流程：

1. 先调用 `actspan_status`，确认 `connected: true`。
2. 用 `actspan_tab_open` 打开目标网址；默认后台打开，不抢焦点。
3. 用 `actspan_page_read` 读取内容，必要时用 `actspan_page_click`、`actspan_page_type` 或 `actspan_page_eval` 操作。
4. 任务结束调用 `actspan_tab_close` 清理自己打开的标签页。

MCP 服务日志不输出到终端，默认写入：`~/.actspan/mcp-server.log`。可通过环境变量 `ACTSPAN_MCP_LOG` 指定其他日志文件。

## 工具清单（18 个）

| 工具 | 说明 |
|---|---|
| `actspan_status` | 桥接状态（先调它排查连接） |
| `actspan_feishu_push` | 向已启用的飞书/Lark Webhook 推送通知 |
| `actspan_tabs_list` / `actspan_tab_open` / `actspan_tab_close` / `actspan_tab_navigate` | 标签页管理，列表只显示当前任务 lease |
| `actspan_page_read` | 读 innerText/HTML（登录态可见内容直接可读） |
| `actspan_page_click` / `actspan_page_type` | CSS 选择器点击/输入 |
| `actspan_page_eval` | CDP `Runtime.evaluate`，页面主上下文执行 JS（支持 await） |
| `actspan_screenshot` | CDP 截图 |
| `actspan_skills_list` / `actspan_skill_detail` | 查询已安装 skill 及详情 |
| `actspan_workflow_run` | 执行已安装的站点工作流 |
| `actspan_agent_submit` / `actspan_agent_status` / `actspan_agent_result` / `actspan_agent_cancel` | 提交、查询、读取和取消异步 agent 任务 |

### `actspan_feishu_push`

- `title`：必填，通知标题。
- `message`：必填，通知正文。
- `webhookName`：可选，必须与 Options 中已启用的飞书/Lark Webhook 名称**完全匹配**；省略时发送到全部已启用的飞书 Webhook。
- 该工具不需要浏览器标签页、页面权限或用户确认（no tab / no confirmation），可在没有活动标签页时调用。

## 工具语义（防劫持约定）

- **默认后台静默**：`actspan_tab_open` 默认 `active:false`，不抢占用户正在看的页面；只有需要用户亲眼确认（扫码、二次验证）才传 `active:true`。
- **标签页列表按任务隔离**：`actspan_tabs_list` 只返回当前 `clientId/sessionId/taskId` 持有 lease 的标签页，不枚举用户其他标签页。
- **写操作只碰任务拥有的标签页**：`navigate/eval/click/type/close` 必须使用当前任务持有的 lease；未指定 `tabId` 时只路由到当前任务的活动标签页。
- **只读操作可回落**：`page_read/screenshot` 省略 `tabId` 时作用于用户当前活动标签页（无副作用）。
- 任务结束 agent 应调用 `actspan_tab_close` 清理自己打开的标签页。

`tabId` 可省略，但写操作不能省略当前任务的 tab lease。

## 已知边界 / 下一步

- MV3 SW 靠原有 20s 心跳 + `alarms` 重连保活；极端休眠后首条指令可能慢一秒。
- 截图要求标签页不是 `chrome://` 等受限页。
- 二期：`actspan_agent_submit`/`actspan_agent_result` 长任务工具直调 `src/ai/orchestrator.handleChat`（用扩展自带 agent 循环）；云端 streamable-HTTP 版（扩展反向长连接 gateway）；options 页配对 UI。
- 合规：本项目 AGPL-3.0，内部用没问题，合入对外产品前评估传染风险。

## skill 套件调度（多 MCP 时的用法）

MCP 只提供原子能力，跨 MCP 的编排 SOP 写进 IDE 的 skill。**已安装的正式 skill：`actspan-browser-ops`**（用户级，所有项目可用），内含防劫持规则、取数/表单/登录态失效三类 SOP、失败处理手册。AI 在你说“用我的浏览器打开 XX”时会自动加载它。

跨 MCP 组合示例（“登录态巡检”）：`actspan_status` 确认在线 → 批量后台 `actspan_tab_open` + `actspan_page_read` → 结果交其他 MCP（知识库 add_source / 邮件发送）→ `actspan_tab_close` 收尾。

原则：浏览器能力收口在本 server（后续 `actspan_agent_submit` 等也加在这里），skill 层按 `actspan_` 前缀点名工具，与其他 MCP 零冲突。

> 注：悬浮球 UI（content script）已按需求从 manifest 与构建链剥离，扩展只保留 background 执行端 + popup/sidepanel/options 配置页。

## 测试

`cd mcp-server && node test/e2e.mjs` —— 模拟 IDE(stdio) + 模拟扩展(WS)，验证 18 个工具注册、token 鉴权、端到端调用、Feishu 推送、错误 token 拒绝。
