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
        "ACTSPAN_BRIDGE_URL": "ws://127.0.0.1:30121",
        "ACTSPAN_EXTENSION_IDS": "<扩展在 chrome://extensions 中显示的 32 位 ID>"
      }
    }
  }
}
```

也可以在安装 `@actspan/mcp-server` 后，将 `command` 改为 `actspan-mcp` 并省略 `args`，其余环境变量保持不变。

3. **扩展 allowlist**：本地 Bridge 只要求 `ACTSPAN_BRIDGE_URL` 与 `ACTSPAN_EXTENSION_IDS`。缺失或格式错误时 server 仍会启动，但 `actspan_status` 会报告 `loop_mode: "disabled"`、`pairing_required: true`，且不接受任何扩展配对；此时请运行 `actspan-install`，由配对页写入从 manifest key 推导出的规范 ID。`ACTSPAN_API_URL`（HTTPS）与 `ACTSPAN_API_KEY` 仅在启用控制面 API 时需要，二者要么同时提供、要么同时省略。

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

## 工具清单（35 个）

按能力分为九组：状态与通知、标签页、页面原子操作、act 组、network 组、data 组、skill/workflow、异步 agent、定时任务。单一事实源是 `mcp-server/catalog.js` 的 `TOOL_NAMES`，本文与之不一致时以代码为准（`node mcp-server/check-tool-docs.mjs MCP-BRIDGE.md` 可校验）。

### 状态与通知（3）

| 工具 | 说明 |
|---|---|
| `actspan_status` | 桥接状态（先调它排查连接） |
| `actspan_status_update` | 用一句 ≤80 字的话告诉用户「准备做什么」，多步任务开始前与计划变更时调用；需要任务已持有 tab lease |
| `actspan_feishu_push` | 向已启用的飞书/Lark 或钉钉 Webhook 推送通知 |

### 标签页（5）

| 工具 | 说明 |
|---|---|
| `actspan_tabs_list` / `actspan_tabs_select` / `actspan_tab_open` / `actspan_tab_close` / `actspan_tab_navigate` | 标签页管理，列表只显示当前任务 lease；`tabs_select` 把任务名下的标签页设为活动页 |

### 页面原子操作（5）

| 工具 | 说明 |
|---|---|
| `actspan_page_read` | 读 innerText/HTML（登录态可见内容直接可读），也可按 selector / ref+snapshotId / find 只读一个元素 |
| `actspan_page_click` / `actspan_page_type` | 按 selector / ref+snapshotId / find 定位的点击与输入；合成事件无效时自动升级为真实 CDP 输入（提交/支付/删除类目标不自动升级） |
| `actspan_page_eval` | CDP `Runtime.evaluate`，页面主上下文执行 JS（支持 await），表达式必须可证明无副作用 |
| `actspan_screenshot` | CDP 截图 |

### act 组（8）

一键跑完可预判的多步动作，并在结尾回一张快照；比逐步调用省掉大量模型往返。

| 工具 | 说明 |
|---|---|
| `actspan_act` | 声明式动作脚本：按序执行 click/type/select/scroll/wait/assert/read 等步骤，逐步做效果检查，首个失败即停，末尾返回最终快照 |
| `actspan_page_snapshot` | 确定性语义快照：可交互元素及其 ref（含 open shadow root 与子 frame），配合 `snapshotId` 原样回传即可在对应 frame 内动作或读取 |
| `actspan_page_select` | 在原生 select 上选择值或精确选项文本，不触发 debugger、不切换标签页 |
| `actspan_page_upload` | 用 base64 构造 File 经 DataTransfer 写入原生 file input，或向 dropSelector 派发拖放；不弹系统文件选择框 |
| `actspan_page_key` | 按序按下按键序列（可 repeat 至 50 次）；Tab 移焦、Enter 激活普通控件，永不激活支付类目标 |
| `actspan_page_wait` | 等待 selector、页面文本或 DOM 稳定（500ms 无变更）；只读，不改页面 |
| `actspan_page_scroll` | 按像素偏移滚动任务租约内的标签页，可限定在某 selector 内；不激活、不聚焦标签页 |
| `actspan_adopt` | 把成功的 act 草稿采纳进已保存的 workflow registry |

### network 组（3）

从已捕获的真实请求里取数，先 list 再按响应体大小挑选，不靠记忆猜接口名。

| 工具 | 说明 |
|---|---|
| `actspan_network_list` | 列出最近**已完成**的请求及状态码、MIME、服务端上报的 Content-Length；不含响应体与凭证 |
| `actspan_network_detail` | 按 requestId 或 urlFilter 查看单条已观测请求，`includeBody` 最多读 50 KB 响应体 |
| `actspan_network_query` | 读取匹配 URL 的最新响应体，`index` 递增可回溯更早批次；响应文本上限 50 KB，取不到正文时明确报错而不编造 |

### data 组（3）

经扩展直接取数/落盘，绕开页面上层封装。

| 工具 | 说明 |
|---|---|
| `actspan_data_fetch` | 取页面或二进制数据；二进制默认走扩展侧（跨域资源），`via:"page"` 仅用于依赖 Referer 的资源，`savePath` 可在 MCP server 进程内流式落盘 |
| `actspan_data_paginate` | 用 bounded 扩展调用翻页取 JSON，无需猜分页规则；停止原因有 `identical_response` / `non_2xx` / `max_pages` / `normal_end` / `credential_page` |
| `actspan_data_download` | 经 `chrome.downloads` 下载 URL、文本或截图，`saveAs:false` 不弹保存框，无内联体积上限 |

### skill / workflow（3）

| 工具 | 说明 |
|---|---|
| `actspan_skills_list` / `actspan_skill_detail` | 查询 registry 版本、已安装 skill 摘要及详情与结构化 workflow 契约 |
| `actspan_workflow_run` | 执行已安装的站点工作流，返回异步任务句柄 |

### 异步 agent（4）

| 工具 | 说明 |
|---|---|
| `actspan_agent_submit` / `actspan_agent_status` / `actspan_agent_result` / `actspan_agent_cancel` | 提交开放式浏览器任务、按 taskId 查状态、读留存结果、取消任务 |

### 定时任务（1）

| 工具 | 说明 |
|---|---|
| `actspan_timer` | 创建/列出/取消浏览器定时任务：`set_timeout`（延时一次）、`set_interval`（周期）、`set_schedule`（daily/weekly）；到点以 `task_action` 为输入自动起一个 AI 会话执行，原标签页已关闭也会照跑（完成后发系统通知）。alarm 最小粒度 1 分钟，更短的延时走内存调度、浏览器关闭即丢失 |

### `actspan_feishu_push`

- `title`：必填，通知标题。
- `message`：必填，通知正文。
- `webhookName`：可选，必须与 Options 中已启用的飞书/Lark 或钉钉 Webhook 名称**完全匹配**；省略时发送到全部已启用的飞书与钉钉 Webhook。
- 该工具不需要浏览器标签页、页面权限或用户确认（no tab / no confirmation），可在没有活动标签页时调用。

## 工具语义（防劫持约定）

- **默认后台静默**：`actspan_tab_open` 默认 `focus:false`，不抢占用户正在看的页面；只有需要用户亲眼确认（扫码、二次验证）才传 `focus:true`（会把标签页带到前台并打断用户）。
- **标签页列表按任务隔离**：`actspan_tabs_list` 只返回当前 `clientId/sessionId/taskId` 持有 lease 的标签页，不枚举用户其他标签页。
- **写操作只碰任务拥有的标签页**：`navigate/eval/click/type/close` 必须使用当前任务持有的 lease；未指定 `tabId` 时只路由到当前任务的活动标签页。
- **只读操作可回落**：`page_read/screenshot` 省略 `tabId` 时作用于用户当前活动标签页（无副作用）。
- 任务结束 agent 应调用 `actspan_tab_close` 清理自己打开的标签页。

`tabId` 可省略，但写操作不能省略当前任务的 tab lease。

## 执行语义边界

同一个动作有三条执行路径，按「步骤是否可预判」选，不要混用：

| 路径 | 代表工具 | 执行方式 | 适用场景 |
|---|---|---|---|
| ① 原子工具 | `actspan_page_read` / `actspan_page_click` / `actspan_page_type` / `actspan_page_eval` / `actspan_page_snapshot` | 单步直接执行，一次调用只做一件事 | 步骤依赖上一步结果、需要中途观察人类判断、或只想探一下页面 |
| ② 声明式动作脚本 | `actspan_act` | 一次调用内按序跑多步（原子动作 click/type/select/scroll/wait/assert/read，外加 if/repeat/parallel/try 控制块，展开后最多 20 个原子步），逐步效果检查 + 断言，首个失败即停，末尾回一张快照 | 步骤可预判的批量操作（填表、连续点击、翻页），省掉每步一次模型往返 |
| ③ 异步委派 | `actspan_agent_submit` | 提交后立即返回任务句柄，内置循环在后台自己规划并执行，再用 `actspan_agent_status` / `actspan_agent_result` / `actspan_agent_cancel` 收口 | 开放式多步任务：目标明确但步数不可预判，或不想让主 agent 逐轮陪跑 |

边界说明：

- ② 的步骤是**预先写死**的：中途需要根据页面新信息改路线时，用它只会白跑；改用 ① 或 ③。
- ② 只在 `find {role, name}` 定位的步骤上支持草稿捕获，纯 selector 步骤照常执行但不会升格为可复用 draft（`actspan_adopt` 只采纳成功草稿）。
- ③ 返回的是异步句柄而非结果；不轮询就永远拿不到答案，且取消要走 `actspan_agent_cancel`。
- 三条路径共用同一套任务 lease 与防劫持约定，授权范围不因换路径而扩大。

### network 工具可见性边界

`actspan_network_list` / `actspan_network_detail` / `actspan_network_query` 依赖 CDP 网络事件（`Network.requestWillBeSent` / `responseReceived` / `loadingFinished` / `loadingFailed`），可见性由事件流本身决定：

- **只有「已完成」的请求进缓冲**：`requestWillBeSent` 先落在 pending 表，必须等到 `loadingFinished` 或 `loadingFailed` 才转入可查询缓冲。所以 `network_list` 里的请求一律是已结束的。
- **永不结束的请求不可见**：SSE、WebSocket 帧流、长轮询、以及被页面挂住的 chunked 响应不会触发这两个终止事件，会一直留在 pending 里——`network_list` / `network_detail` / `network_query` 都看不到，别把「查不到」误判成「没发出」。
- **只能回溯 start 之后的流量**：捕获在首次调用时启动（`network.start` 会清空该标签页的缓冲与 pending 表），此前发生的请求无法补捞；需要首屏流量时用 `reload:true` 显式重载标签页再捕获，这会导航页面、需要写 lease。
- **容量有限**：缓冲有 `maxEvents` 上限（默认数百条，最大 5000），超出后丢弃最旧的；长会话应分段 list 而不是等最后一次性取。
- **内容边界**：list 不返回响应体与凭证；detail 的 `includeBody` 与 query 的响应正文都截断在 50 KB，取不到正文时返回诊断信息而非编造内容。

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

`cd mcp-server && node test/e2e.mjs` —— 模拟 IDE(stdio) + 模拟扩展(WS)，验证 35 个工具注册、token 鉴权、端到端调用、Feishu 推送、错误 token 拒绝。
