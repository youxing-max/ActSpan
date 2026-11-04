<p align="center">
  <img src="public/actspan-logo.svg" width="128" height="128" alt="Actspan Logo">
</p>

<h1 align="center">Actspan</h1>

<p align="center">
  <strong>在真实浏览器里完成多步骤任务的开源 AI 助手。</strong>
</p>

<p align="center">
  用自然语言搜索网页、操作页面、提取信息、填写表单、定时执行任务，并把结果带回来。
</p>

<p align="center">
  中文 | <a href="./README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/youxing-max/ActSpan/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License">
  </a>
  <img src="https://img.shields.io/badge/Manifest-V3-green.svg" alt="Manifest V3">
  <img src="https://img.shields.io/badge/MCP-34%20tools-orange.svg" alt="MCP 34 tools">
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node >= 20">
</p>

---

## 目录

- [项目简介](#项目简介)
- [项目特色：与业界方案的本质区别](#项目特色与业界方案的本质区别)
- [适合什么场景](#适合什么场景)
- [核心能力](#核心能力)
- [整体架构](#整体架构)
- [云端 MCP 服务（多人共享）](#云端-mcp-服务多人共享)
- [MCP 工具全清单（34 个）](#mcp-工具全清单34-个)
- [Free Mode 安全模型](#free-mode-安全模型)
- [技能体系](#技能体系)
- [双向机器人与通知](#双向机器人与通知)
- [定时任务](#定时任务)
- [快速开始](#快速开始)
- [使用示例](#使用示例)
- [开发](#开发)
- [文档](#文档)
- [许可证](#许可证)

## 项目简介

Actspan 是一个运行在 Chrome 中的 AI 浏览器助手（Manifest V3 扩展 + 本地 MCP Server）。你只需要描述目标，它会在后台拆解任务、调用浏览器工具、访问多个网站、整理结果并把过程和结果留在当前浏览器里。

它不是只会回答问题的聊天窗口，而是让 AI 在你的浏览器环境中完成实际工作的**执行层**：使用你已经登录的页面，处理真实的 DOM 和网络请求，支持把成熟操作沉淀为可复用工作流，并能被任意支持 MCP 的客户端（Claude Code、Codex、IDE Agent 等）当作浏览器工具集直接调用。

与同类方案的区别：

| 维度 | Actspan | 云端浏览器 Agent | 传统 RPA |
|---|---|---|---|
| 登录态 | 直接复用你当前的浏览器会话 | 需要重新登录/迁移 Cookie | 通常需要独立环境 |
| 执行位置 | 本地 Chrome，数据不出机 | 云端浏览器 | 本地但需专门客户端 |
| 接入方式 | 悬浮球 / Side Panel / MCP 标准协议 | 自家 API | 专有脚本 |
| 模型 | 任何 OpenAI 兼容 Endpoint（含本地模型） | 绑定厂商模型 | 通常无模型 |
| 扩展性 | MCP 34 工具 + 动态 HTTP 工具 + 技能/工作流 | 封闭 | 录制脚本 |

## 项目特色：与业界方案的本质区别

**① Agent Loop 架构，而非"遥控浏览器"。** 业界主流做法是 IDE/Agent 通过 CDP、Playwright、Puppeteer 去**外接**一个浏览器（往往是无头或独立实例）：没有你的登录态、要迁移 Cookie、或干脆用云浏览器。Actspan 反过来——**扩展本身就是执行层**，Agentic Loop（Phase Orchestrator 多阶段编排 + 工具调用循环）跑在你的**日常 Chrome** 里：代码管权限/边界/任务隔离（保下限），模型管理解/选工具/决策（定上限）。AI 用的是你已登录的真实会话，数据不出你的浏览器。

**② 三个入口，同一条工具总线。** 悬浮球/Side Panel（人直接用）、本地 MCP 桥（IDE 直连本机浏览器）、**云端 MCP（多人共享一个云端、按 token 各自调自己的浏览器）**。三者调用的是同一套 35 个工具与同一套 Agent Loop，不是三套实现。

**③ 能力可沉淀、可复用。** 操作可录制（`recorder`）→ 存成工作流（`save_workflow`）→ 一句话复用（`skill`）；整段过程可录屏（`screen_record`，人手/无人值守双模）；开放任务可交给异步 Agent（`agent_task`）后台跑完再取结果。

## 适合什么场景

- **信息调查**：跨站搜索、阅读页面、提取表格和关键字段，整理成结构化结果。
- **重复操作**：打开网站、筛选内容、复制数据、截图、下载文件或填写表单。
- **站点自动化**：把常用任务保存为工作流，之后用一句话再次运行。
- **定时巡检**：创建延时 / 周期 / 每日 / 每周定时任务，到点自动起 AI 会话执行并通知。
- **团队通知**：调查完成后，将结果摘要推送到已配置的飞书 / Lark 或钉钉机器人 Webhook。
- **群聊机器人**：钉钉 Stream 模式 / 飞书长连接双向机器人，群里 @机器人 即执行浏览器任务并回复结果。
- **IDE Agent 的浏览器手脚**：通过 MCP 把 34 个浏览器工具暴露给 Claude Code / Codex 等客户端，让编程 Agent 直接操作真实网页。
- **本地与自定义能力**：连接你选择的模型服务（含 Ollama、LM Studio 等本地模型），或通过 MCP 和动态工具扩展能力。

## 核心能力

### 1. 在真实浏览器中执行

Actspan 直接运行在 Chrome 扩展环境中，复用当前浏览器已有的登录态。无需迁移 Cookie，也无需为每个站点重新登录；AI 可以在你授权的页面上读取内容、点击、输入、导航和截图。Content Script 以 `all_frames: true` 注入，语义快照覆盖 Shadow DOM 与子 iframe，跨框架元素通过 `ref@fN` 句柄精确定位。

### 2. 自然语言驱动的 Agentic Loop

输入目标后，后台 Agentic Loop 会根据上下文选择工具并进行多轮执行。代码负责权限、边界、任务隔离和消息传输，模型负责理解目标、选择下一步动作和整理结果。支持阶段化执行（phase）、执行状态实时推送到悬浮球 / Side Panel。

### 3. 双入口：悬浮球 + Side Panel

- **悬浮球**：任意页面将鼠标悬停在右侧悬浮球上，点击即可唤起，不打断当前浏览。
- **Side Panel**：Chrome 侧边栏常驻，适合长任务观察与多会话管理。
- **Options 页**：配置模型 Endpoint / API Key / Model、Webhook、机器人等。

### 4. 录制并复用工作流

演示一次浏览器操作即可录制任务。Actspan 会清理录制过程中的噪声，生成可复用的工作流；工作流使用声明式 JSON 描述（steps + saveAs + resultPath），不需要为每个站点编写完整扩展代码。成功的 `act` 草稿可以一键采纳（adopt）进工作流 registry。

### 5. 技能体系（Skills）

技能 = 场景化指引（guide）+ 结构化工作流契约，按 URL 模式自动匹配激活：

- **全局技能（2 个）**：`read-current-page`（页面阅读）、`extract-structured-data`（结构化提取）。
- **域名技能（5 个）**：`jd`（京东）、`baidu`（百度）、`taobao`（淘宝）、`tophub`（今日热榜）、`boss-zhipin`（BOSS 直聘）。
- 支持远程 Manifest 下发，可按团队需求分发自有技能包。

### 6. MCP 工具与协议扩展

- 本地 MCP Server（`actspan-mcp`）把浏览器能力以 **34 个 `actspan_` 前缀工具**暴露给任何 MCP 客户端。
- 支持动态 HTTP 工具和远程 Manifest，可按需接入已有服务。
- 完整清单见下文 [MCP 工具全清单](#mcp-工具全清单34-个)。

### 7. 模型由你选择

兼容 OpenAI API 格式的模型服务，包括云端服务和本地部署的 Ollama、LM Studio 等。API Endpoint、API Key 和模型名称由你配置，项目不要求绑定特定模型提供商。

## 整体架构

```text
你的目标（悬浮球 / Side Panel / MCP 客户端 / 定时器 / 群机器人）
   ↓
后台 Agentic Loop：理解任务 → 选择工具 → 执行与校验 → 整理结果
   ↓
浏览器页面 / 工作流 / 技能 / MCP 工具 / Webhook
   ↓
悬浮球、会话记录、系统通知、群消息回复
```

### 扩展侧（MV3 分层）

| 层 | 入口 | 职责 |
|---|---|---|
| Popup | `index.html` | 扩展图标弹窗，快速操作入口 |
| Side Panel | `sidepanel.html` | 常驻侧边栏，会话与任务观察 |
| Content Script | `content.js`（`all_frames`） | 悬浮球 UI、页面交互、语义快照、页面侧事件 |
| Background | `background.js`（Service Worker） | AI 编排、任务生命周期、工具调度、Tab 租约、通知、定时器 |
| Offscreen | `mcp.html` | MCP WebSocket 传输层（桥接帧转发） |
| Options | `options.html` | 模型 / Webhook / 机器人配置 |

### MCP 桥接链路

```text
MCP 客户端（Claude Code / Codex / IDE Agent）
   ↓ stdio
actspan-mcp（index.js：工具注册 / policy / catalog）
   ↓ WebSocket 127.0.0.1:30121（bridge-daemon 常驻，bridge-lock 防重复）
扩展 Offscreen 文档（mcp-transport：帧封装 actspan_mcp_socket_event / 取消帧）
   ↓
Background mcp-bridge：协议校验 → Tab 租约授权 → 工具执行 → 审计
```

关键机制：

- **Tab 租约隔离**：每个任务只看得见、动得了自己 lease 内的标签页；跨标签页操作必须持有效任务身份并显式授权。
- **请求级取消**：客户端可随时发 `actspan_mcp_cancel` 帧中止在途请求。
- **桥接守护进程**：`bridge-daemon` + `bridge-lock` 保证同一机器只有一条桥；`actspan-doctor` 一键诊断连接问题。
- **审计日志**：`bridge.js` 对敏感操作落审计记录（事后追溯）。

## 云端 MCP 服务（多人共享）

除本地 IDE 直连（上面那条 stdio 链路）外，Actspan 还提供一套**部署在一台机器上、多人共享**的云端 MCP 服务：每个用户持有一个 token，云端按 token 把「IDE 会话」和「该用户自己的浏览器」配对，实现"每个人的 IDE 调自己的 Chrome"，同时复用登录态与全部工具能力。

```text
 Alice 的 IDE ──https://host/mcp──┐  Authorization: Bearer <alice-token>
 Bob 的 IDE   ──https://host/mcp──┤  Authorization: Bearer <bob-token>
                                  ▼
                   ┌─────────────────────────────┐
                   │  cloud.js（单进程单端口）      │
                   │  /mcp   IDE（MCP HTTP）       │
                   │  /ws    浏览器扩展（WebSocket）│
                   └──────┬──────────────┬───────┘
            wss ?token=alice          wss ?token=bob
                           ▼           ▼
                  Alice 的 Chrome  Bob 的 Chrome（actspan 扩展）
```

- **IDE 侧**：认证方式选「请求头认证」，`Authorization: Bearer <token>`，服务地址 `https://host/mcp`
- **浏览器扩展侧**：Options →「云端连接器」填 `wss://host/ws` 与 token（浏览器 WebSocket 不允许自定义请求头，token 走 URL）
- **部署与发牌**：

```bash
cd mcp-server && npm install
cp tokens.example.json tokens.json
node cloud.js --port 8787            # 启动云端（nginx 反代挂 TLS 后对外）
node cloud-token.js add <user>       # 发 token（打印交接单；热加载，无需重启）
node cloud-token.js revoke <user>    # 吊销（离职/泄露时用）
```

云端工具由浏览器实时上报，除 34 个 `actspan_*` 包装工具对应的原生工具外，还额外暴露扩展工具总线上的三大特色能力：`agent_task`（异步 Agent 任务，submit/status/result/cancel/workflow_run）、`recorder`（操作录制→`save_workflow` 存→`skill` 复用的闭环）、`screen_record`（标签页视频录屏，**双模**：用户已点扩展授予 activeTab 时走 tabCapture 无提示条；无人值守/云端 agent 自动回退 `chrome.debugger` 截帧，录制期目标页切前台并显示调试提示条），以及 `skill`、云端本地工具 `cloud_status`。完整部署、鉴权、令牌管理与运行行为约定见 [docs/CLOUD-SERVICE.md](docs/CLOUD-SERVICE.md)。

## MCP 工具全清单（34 个）

统一 `actspan_` 前缀，按能力分为九组。单一事实源是 `mcp-server/catalog.js` 的 `TOOL_NAMES`（可用 `node mcp-server/check-tool-docs.mjs MCP-BRIDGE.md` 校验文档与代码一致性）。

### 状态与通知（3）

| 工具 | 说明 |
|---|---|
| `actspan_status` | 桥接连接状态，先调它排查连接 |
| `actspan_status_update` | 用一句 ≤80 字的话向用户播报「准备做什么」，多步任务开始前与计划变更时调用 |
| `actspan_feishu_push` | 向已启用的飞书/Lark 或钉钉 Webhook 推送通知；无需标签页或确认 |

### 标签页（5）

| 工具 | 说明 |
|---|---|
| `actspan_tabs_list` | 列出当前任务 lease 内的标签页 |
| `actspan_tabs_select` | 把任务持有的标签页设为活动标签页 |
| `actspan_tab_open` | 后台打开标签页，默认不抢焦点 |
| `actspan_tab_close` | 关闭当前任务打开的标签页 |
| `actspan_tab_navigate` | 让任务持有的标签页跳转 URL |

### 页面原子操作（5）

| 工具 | 说明 |
|---|---|
| `actspan_page_read` | 读 innerText/HTML（登录态可见内容直接可读），可按 selector / ref+snapshotId / find 只读单个元素 |
| `actspan_page_click` | 按 selector / ref / find 定位点击；合成事件无效时自动升级为真实 CDP 输入 |
| `actspan_page_type` | 输入文本；提交/支付类目标不自动升级真实输入 |
| `actspan_page_eval` | CDP `Runtime.evaluate`，页面主上下文执行 JS（支持 await），表达式必须可证明无副作用（V8 `throwOnSideEffect` 强制） |
| `actspan_screenshot` | CDP 截图，输出可视区 PNG |

### act 组（8）

一键跑完可预判的多步动作，并在结尾回一张快照，比逐步调用省掉大量模型往返。

| 工具 | 说明 |
|---|---|
| `actspan_act` | 声明式动作脚本：按序执行 click/type/select/scroll/wait/assert/read 等步骤，逐步做效果检查，首个失败即停，末尾返回最终快照 |
| `actspan_page_snapshot` | 确定性语义快照：可交互元素及其 ref（含 open shadow root 与子 frame），配合 `snapshotId` 原样回传即可在对应 frame 内动作或读取 |
| `actspan_page_select` | 在原生 select 上选择值或精确选项文本，不触发 debugger、不切换标签页 |
| `actspan_page_upload` | 用 base64 构造 File 经 DataTransfer 写入原生 file input，或向 dropSelector 派发拖放；不弹系统文件选择框 |
| `actspan_page_key` | 按序按下按键序列（可 repeat 至 50 次）；Tab 移焦、Enter 激活普通控件，永不激活支付类目标 |
| `actspan_page_wait` | 等待 selector、页面文本或 DOM 稳定（500ms 无变更）；只读，不改页面 |
| `actspan_page_scroll` | 按像素偏移滚动任务租约内的标签页，可限定在某 selector 内；不激活、不聚焦 |
| `actspan_adopt` | 把成功的 act 草稿采纳进已保存的 workflow registry |

### network 组（3）

从已捕获的真实请求里取数，先 list 再按响应体大小挑选，不靠记忆猜接口名。

| 工具 | 说明 |
|---|---|
| `actspan_network_list` | 列出最近**已完成**的请求及状态码、MIME、Content-Length；不含响应体与凭证 |
| `actspan_network_detail` | 按 requestId 或 urlFilter 查看单条请求，`includeBody` 最多读 50 KB 响应体 |
| `actspan_network_query` | 读取匹配 URL 的最新响应体，`index` 递增可回溯更早批次；取不到正文时明确报错而不编造 |

### data 组（3）

| 工具 | 说明 |
|---|---|
| `actspan_data_fetch` | 抓取页面或二进制数据；二进制默认走扩展侧（跨域资源），`savePath` 可在 MCP server 进程内流式落盘 |
| `actspan_data_paginate` | 有界翻页抓 JSON；停止原因明确：`identical_response` / `non_2xx` / `max_pages` / `normal_end` / `credential_page` |
| `actspan_data_download` | 经 `chrome.downloads` 下载 URL、文本或截图，`saveAs:false` 不弹保存框，无内联体积上限 |

### skill / workflow（3）

| 工具 | 说明 |
|---|---|
| `actspan_skills_list` | 列出 skill 摘要与 registry 版本 |
| `actspan_skill_detail` | 读取 skill 全文与结构化工作流契约 |
| `actspan_workflow_run` | 执行已安装的站点工作流，返回异步任务句柄 |

### 异步 agent（4）

| 工具 | 说明 |
|---|---|
| `actspan_agent_submit` | 提交开放式浏览器任务，返回异步任务句柄 |
| `actspan_agent_status` | 按 taskId 查询任务状态 |
| `actspan_agent_result` | 读取任务保留的结果 |
| `actspan_agent_cancel` | 按 taskId 取消任务 |

MCP 配置、鉴权、参数细节和端到端测试见 [MCP Bridge 文档](MCP-BRIDGE.md)。

## Free Mode 安全模型

> **重要：自 v1.1.0 起，Actspan 移除了全部人工审批门（设计决策，见 [free mode spec](docs/spec/actspan-free-mode-spec.md)）。**

### 这意味着什么

- 任何**已认证**的 MCP 客户端可对任意 tab 执行任意动作，含表单提交、支付点击、删除——**无确认弹窗、无审批凭证**。
- 设计动机：原审批门导致 IDE Agent 调用频繁超时（`E_TIMEOUT: 审批等待超时`）、自动化流程被阻断。
- 权限分级（read / interact / sensitive / dangerous）保留，但仅用于**审计日志分级**，不再触发确认。

### 仍然保留的安全边界（非审批机制，未动）

| 机制 | 位置 | 作用 |
|---|---|---|
| Captcha 挑战检测 | `mcp-bridge.ts` `assertNoChallenge` | 识别反自动化验证页并拒绝继续 |
| `page.eval` 副作用防护 | V8 `throwOnSideEffect` | 表达式必须可证明无副作用，V8 层强制 |
| Tab 租约隔离 | `tab-lease-manager.ts` | 跨任务/会话隔离，防越权读写其他任务的标签页 |
| SSRF 守卫 | `assertSafeNavigableTarget` | 拦截 localhost / 内网 / 凭据 URL 导航 |
| 审计日志 | `mcp-server/bridge.js` `appendAudit` | 敏感操作落盘记录，供事后追溯 |

### 风险与使用前提（请务必阅读）

1. **任意已认证 MCP 客户端可点击支付按钮、提交表单、删除数据，无人工闸。** 恶意或出错的 Agent 脚本可造成不可逆操作。
2. 请**仅在受信环境运行 MCP Server**；用 `ACTSPAN_EXTENSION_IDS` 白名单限制可连接的扩展来源。
3. 不要把你登录了敏感账号（网银、支付、后台管理）的浏览器会话暴露给不可信的模型或 Agent 流程。
4. 页面内容、登录态和工具权限应按任务最小化使用。

### 隐私边界

- 扩展和浏览器自动化逻辑在**本地 Chrome** 中运行；请求只发送到你在 Options 页配置的模型 Endpoint，Actspan 不代管你的模型服务。
- API 配置保存在 Chrome 本地存储，不需要额外的 Actspan 账号。
- network 工具不读取请求凭证；响应体读取有 50 KB 上限并在清单中明示。

## 技能体系

技能（Skill）把「在某类页面上该怎么干活」封装成可分发单元：**场景指引（Markdown guide）+ 结构化工作流契约（JSON plan）**。扩展按当前 URL 自动匹配激活对应技能，AI 在执行时遵循指引并可直接调用技能内置工作流。

| 类型 | 数量 | 清单 |
|---|---|---|
| 全局技能 | 2 | 页面阅读、结构化提取 |
| 域名技能 | 5 | 京东、百度、淘宝、今日热榜、BOSS 直聘 |

- 技能包支持**远程 Manifest** 下发：团队可维护自己的技能源，成员扩展自动同步。
- 技能详情与契约可通过 `actspan_skills_list` / `actspan_skill_detail` 在 MCP 侧查询。
- 录制的新工作流可沉淀回技能，形成「使用 → 录制 → 复用 → 分享」闭环。

## 双向机器人与通知

| 通道 | 模式 | 能力 |
|---|---|---|
| 钉钉机器人 | **Stream 模式**长连接（`actspan-dingtalk`） | 群里 @机器人 执行浏览器任务并回复结果，**无需公网回调地址** |
| 飞书 / Lark 机器人 | 长连接（`actspan-feishu`） | 接收私聊或群内 @消息 并回复执行结果 |
| 飞书 / Lark / 钉钉 Webhook | 出站推送 | 任务完成结果、定时任务通知推送到群 |

机器人进程与 MCP Server 同包分发，配置（AppKey/AppSecret 或 Webhook）在 Options 页完成，支持多 Webhook 按名称路由。

## 定时任务

扩展内部的 `timer` 工具支持定时执行浏览器任务，不属于公开 MCP 工具：

- **三种触发**：`set_timeout`（延时一次）、`set_interval`（周期）、`set_schedule`（每日/每周定点）。
- **鲁棒执行**：原标签页被关闭后任务仍会以无 tabId 方式执行，完成后弹系统通知；扩展重载后自动重建 alarm（过期任务立即补触发，周期任务保留原周期）。
- **典型用法**：每天早上 9 点抓热榜推送到钉钉群；每 30 分钟检查一次订单状态；延时 10 分钟后截图存档。

## 快速开始

### 第 0 步：获取扩展（真实来源，二选一）

**方式 A：源码构建（含云端 MCP 的最新版本，推荐）**

```bash
# 内网 GitLab（含云端 MCP 的分支 feat/cloud-mcp）
git clone git@git.in.chaitin.net:yijun.li/actspan.git && cd actspan && git checkout feat/cloud-mcp
# 或上游 GitHub
# git clone https://github.com/youxing-max/ActSpan.git && cd ActSpan
npm install
npm run build
```

构建产物在 `build_version/actspan-extension/`。打开 `chrome://extensions/` → 开启**开发者模式** → **加载已解压的扩展程序** → 选该文件夹。

**方式 B：公开 release zip（上游发布版）**

见[下载页面](docs/download.md)（拉取上游 `youxing-max/ActSpan` 的 GitHub Releases 压缩包）。**注意**：该 zip 为上游已发布版本；云端 MCP / 双模录屏等最新功能是否包含，以该 release 的 tag 是否已合并本仓库改动为准——**要用云端 MCP 请走方式 A 源码构建**。

加载后：右键扩展图标 → **选项** → 填模型 Endpoint / API Key / Model（Agent Loop 用）；任意网页悬停右侧悬浮球即可唤起。

### 使用方式一：云端 MCP（推荐，多人共享一个云端）

管理员部署云端并给每人发一个 token；用户拿 token 配两处即可，**各自调各自的浏览器**：

```bash
# 管理员（服务器上）
cd mcp-server && npm install
node cloud.js --port 8787              # 启动云端（/mcp + /ws + /health），建议反代挂 TLS
node cloud-token.js add <user>         # 发 token；批量：batch --count N --prefix p --csv 分发表.csv
```

| 谁 | 在哪 | 填什么 |
|---|---|---|
| 用户 | IDE「添加连接」 | 服务地址 `https://<host>/mcp`；认证=请求头认证；`Authorization: Bearer <自己的token>` |
| 用户 | 扩展 Options→云端连接器 | 服务器 `wss://<host>/ws`；个人 Token `<自己的token>`；启用 |

一个 token = 一个浏览器身份，互不串号。完整部署/鉴权/令牌管理见 [docs/CLOUD-SERVICE.md](docs/CLOUD-SERVICE.md)。

### 使用方式二：本地 MCP 桥（IDE 直连本机浏览器，单人）

```bash
cd mcp-server
npm install
node install.js        # 交互式写入客户端 MCP 配置
node doctor.js         # 诊断桥接连接
```

MCP Server 自动启动本地桥接守护进程（`127.0.0.1:30121`）并连接扩展。配置示例与排错见 [MCP-BRIDGE.md](MCP-BRIDGE.md)。

### 使用方式三：悬浮球 / Side Panel（人直接用，不经 MCP）

任意网页悬停右侧悬浮球唤起对话；或 Chrome 侧边栏打开 Side Panel 管理多会话。直接对 AI 说目标即可，Agent Loop 后台执行。

### 启动群机器人（可选）

```bash
cd mcp-server
npm run dingtalk       # 钉钉 Stream 双向机器人
npm run feishu         # 飞书 / Lark 长连接机器人
```

配置细节见[钉钉机器人指南](docs/guide/dingtalk-robot.md)与[飞书机器人指南](docs/guide/feishu-bot.md)。

## 使用示例

打开任意网页后，可以直接输入：

```text
这个页面讲了什么？请列出关键结论和证据。
在当前网站搜索符合条件的商品，整理前 5 个结果。
读取这份表格，提取姓名、邮箱和金额，导出成结构化列表。
调查完成后，把结果摘要推送到"调查结果群"。
每天早上 9 点抓一次今日热榜，推到钉钉群。
```

在 MCP 客户端（如 Claude Code）中，模型会自动组合 34 个工具完成同样的任务——例如先 `actspan_page_snapshot` 拿语义快照，再用 `actspan_act` 一次性跑完「搜索 → 翻页 → 提取」。

## 开发

### 技术栈

- **扩展**：TypeScript 5 + Vite 5（五入口构建）+ React 18 + Ant Design 5
- **MCP Server**：Node.js ≥ 20，ESM，零原生依赖
- **文档站**：VitePress（`docs/`）
- **测试**：Node 内置 test runner（`node --test`）

### 目录结构

```text
src/
  ai/            # Agentic Loop、LLM 客户端、工具执行器（21 个文件）
  background/    # 任务管理、MCP 桥、Tab 租约、定时器、网络捕获（52 个文件）
  content/       # Content Script、悬浮球、页面落地（15 个文件）
  functions/     # 83 个浏览器能力函数（DOM/CDP/输入/下载/截图/工作流…）
  lib/           # CDP 会话、Artifact 存储等基础设施
  mcp/           # MCP 协议层
  offscreen/     # Offscreen 文档（MCP WebSocket 传输）
  options/       # 配置页
  session-history/ # 会话历史
  sidepanel/     # Side Panel UI
mcp-server/      # 独立 npm 包 actspan-mcp（桥、工具、机器人、安装器）
public/skills/   # 内置技能（global/ + domains/）
docs/            # VitePress 文档站（指南、规范、审计记录）
```

### 常用命令

```bash
npm run dev          # 监听构建
npm run build        # 构建 Popup、Content、Sidepanel、Background、Offscreen 五入口
npm run typecheck    # TypeScript 类型检查（build 不含类型检查，需单独跑）
npm test             # 扩展侧测试（525 项；其中 21 项真机用例需 ACTSPAN_LIVE=1）
npm run test:live    # 真机端到端测试（需要本地 Chrome 环境）
npm run lint         # ESLint
npm run docs:dev     # 本地预览文档站

cd mcp-server && npm test   # MCP Server 侧测试（协议/锁/身份/安全/生命周期等 14 个套件）
```

## 文档

- [文档首页](docs/index.md)
- [快速开始](docs/guide/getting-started.md)
- [使用示例](docs/guide/examples.md)
- [工作流指南](docs/guide/workflows.md)
- [配置指南](docs/guide/configuration.md)
- [工具指南](docs/guide/tools.md)
- [钉钉机器人](docs/guide/dingtalk-robot.md) / [飞书机器人](docs/guide/feishu-bot.md)
- [MCP Bridge](MCP-BRIDGE.md)
- 设计规范：[Free Mode Spec](docs/spec/actspan-free-mode-spec.md) / [Superset Spec](docs/spec/actspan-superset-spec.md) / [工作流架构](docs/guide/actspan-workflow-architecture-spec.md)

## 许可证

[AGPL-3.0](LICENSE)
