# ActSpan 超集规格 · 需求逐条落地状态表

生成日期：2026-10-20　对标文档：docs/spec/actspan-superset-spec.md（656 行）
证据口径：落点与证据里的 file:line 均为本轮实读；测试名为仓库内实际 test() 名。

**file:line 重解析（2026-10-20 收口后）**：信封协议与调试器统一（规格 §8.5 缺陷 1/3）在 `mcp-bridge.ts` / `mcp-interaction.ts` / `site-experience.ts` 里插入了代码，使本表部分引用整体下移（`mcp-bridge.ts` 最大 +31 行，`mcp-interaction.ts` 的 `page.scroll` 从 `:166` 移到 `:182`）。已按当前代码逐条重解析并修正 30 处引用，语义未改；复验：19/19 抽查锚点命中、0 处越界。其余 71 个文件的引用核对后无需改动。

**证据可信度分级（2026-10-20 补）**：本表 35 行引用 `test/scenarios.test.mjs`（S5）。该套件在本机**从未跑通**（22 fail / 0 pass），因为它要求 Chrome 暴露 DevTools HTTP 端点（`/json/version`、`/json/list`），而本机 Chrome 只暴露 `/devtools/browser` WebSocket——属环境限制，非代码缺陷（详见规格 §8.4）。因此**这 35 行的引用是「契约证据」（用例名与断言如所写），不是「已跑通」的证明**。真正跑通的端到端证据是 `npm run test:acceptance`（17/17，真实 Chrome）与 `npm run test:simuser`（12/12，真实站点），两者都不依赖该 HTTP 端点。

**A4 一行的订正**：A4 原标「已实现」并只引 S5。2026-10-20 的模拟用户全量测试证明，A4 覆盖的 5 个动作（`select`/`upload`/`key`/`wait`/`scroll`）在**无 ref 路径上 100% 失败**——注入参数数组尾部塞了 `undefined`，Chrome 整条拒绝（`Error at index 2: Value is unserializable`）。代码存在但功能不成立，故原「已实现」在当时是错的。已修复并补回归测试，现为真。

## 1.2 新发现的 P0（5 条）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| P0-1 | 已实现 | src/ai/orchestrator.ts:142-148 | src/ai/orchestrator.ts:142-148（const allTools = [...tools]；hasSubtask 由 tools.some(t => t.name === agent) 推导） | 规格原文说 agent 被白名单过滤、hasSubtask 硬编码 true，两处都已改 |
| P0-2 | 已实现 | src/ai/core-loop.ts:160,606,756-772 | src/ai/core-loop.ts:756-772（注入守卫 if (allTools && loadedOnDemandTools) 已生效） | 递归调用已补传第 15/16 参 |
| P0-3 | 部分实现 | src/content/page-grounding.ts:826-830 | src/content/page-grounding.test.mjs:34（reports a click only after the synchronous click completes） | 回执后置与禁用拦截已修；SVG 走 :816-824 promoteSvgActionTarget 提升到可激活祖先再调祖先 click()，未直接派发合成 click 事件 |
| P0-4 | 已实现 | src/content/page-grounding.ts:109,305-332 | src/content/page-grounding.test.mjs:258（handle table drops elements that left the document instead of growing without bound） | 句柄表仍是强引用 Map（跨快照编号稳定 H1 需要它），改为在唯一咽喉 getOrCreateElementHandle 里摊还清理：pruneDetachedHandles 同时删 elementHandleMap 与 elementHandleSnapshotMap，仍在文档里的句柄一律保留。三条创建路径（快照/骨架/标注）都过这个咽喉，故一处覆盖 |
| P0-5 | 已实现 | src/content/page-grounding.ts:111,121-131 | src/content/page-grounding.test.mjs:244（element actions reject mixed locators and stale refs before touching the page） | ref+snapshotId 契约已落地 |

## 2. G 接地保真（G1-G15）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| G1 | 部分实现 | src/content/page-grounding.ts:827-830 | test/scenarios.test.mjs:98（S5/untrusted: click path emits a trusted browser event, not a synthetic fallback） | 合成路径仍只调原生 click()（只发 click 一个事件）；九事件序列与 isTrusted=true 实际由 CDP 真实事件路径（src/functions/cdp-input.ts）经 A2 无效果自动升级产生，mousedown-only 下拉用例因此通过 |
| G2 | 部分实现 | src/content/page-grounding.ts:816-824 | test/scenarios.test.mjs:83-90 | 已不静默跳过：SVG 提升到可激活祖先再点；契约要求的「派发合成 click 事件」未实现，svg/path 自身仍无 click() |
| G3 | 已实现 | src/content/page-grounding.ts:827-830 | test/scenarios.test.mjs（S5/G1/G3: mousedown-only menu opens and preventDefault preserves focus） | click 路径不调 focus()；focus 是独立动作（src/content/page-grounding.ts:1202-1205） |
| G4 | 已实现 | src/content/page-grounding.ts:92-108 | test/scenarios.test.mjs（S5/G4: open shadow DOM descendants are snapshotted and actionable through refs） | collectDeepElements 纳入开放 shadow root 后代 |
| G5 | 已实现 | src/background/frame-routing.ts + src/background/mcp-bridge.ts:985-990 | test/scenarios.test.mjs（S5/G5/H2: cross-origin iframe refs are frame-qualified and route to the exact frame） | ref 形如 e5@f2，子框架换用 tab 级 snapshotId，协议面无新增概念 |
| G6 | 已实现 | src/content/page-grounding.ts:628-632 | test/scenarios.test.mjs:204（S5/G6/G7/G8: file role, unlabeled controls, current values and accessibility hooks remain observable） | input[type=file] 归为 file 角色 |
| G7 | 部分实现 | src/content/page-grounding.ts:232-256 | test/scenarios.test.mjs:204 | 已覆盖 aria-label/aria-labelledby/.labels/closest(label)；契约点名的 .form-group 同级标签与 aria-describedby 两条路径未实现 |
| G8 | 已实现 | src/functions/extract-data.ts:60-62 | test/scenarios.test.mjs:211（受控 input 改值后页面 value 为 current@example.test） | attribute === value 时取 (el).value 当前值 |
| G9 | 已实现 | src/content/page-grounding.ts:403-417 | src/content/page-grounding.ts:284-295（CachedElementInfo.disabled）+ 描述符 disabled 字段 | 快照标注 disabled，点击时另有禁用态拦截文案 |
| G10 | 部分实现 | src/content/page-grounding.ts:541-542,414 | src/background/mcp-bridge.ts:1009（message 只报候选数与框架数） | only_viewport 参数与逐元素 in_viewport 已有；快照没有「视口外还有 N 个可交互元素」的说明 |
| G11 | 已实现 | src/content/page-grounding.ts:204-213,222,427,429,465,466 | src/content/page-grounding.test.mjs:428（snapshot descriptors expose aria-selected as a tri-state）、:442（snapshot descriptors expose the class attribute only when it is set）；真机 mcp-server/test/acceptance.mjs:192-206（4.1-13） | ariaSelectedOf 照 checkedOf 读 aria-selected，三态 boolean/undefined；classNameOf 用 getAttribute('class') 而非 el.className——SVG 元素的 className 是 SVGAnimatedString 对象，直接 clip 会得到 "[object SVGAnimatedString]"；CLASS_NAME_MAX=120，空 class 落 undefined |
| G12 | 部分实现 | src/content/page-grounding.ts:895-911 | test/scenarios.test.mjs（S5/G12/G13: late validation and scroll effects are reported from the live page） | validation_error 已进效果证据与 diagnostic；快照响应本身未把它顶到最前 |
| G13 | 已实现 | src/background/mcp-interaction.ts:182-207 | src/background/mcp-interaction.test.mjs:190（scroll re-dispatches a synthetic wheel and explains a zero delta with all three causes）；真机 mcp-server/test/acceptance.mjs:223-240（4.1-15，wheel 计数实测 1） | 滚动后向真正被滚动的元素补发合成 WheelEvent（bubbles+cancelable，deltaMode 0）；changed:false 时并列报三因（不可滚动余量 / 需焦点指向 focus:true / 懒加载需 IntersectionObserver 回调）。余量取「还能滚多少」（scrollHeight-clientHeight-|scrollTop|），不是总量——报总量会让已到边界的调用方误判成还能滚 |
| G14 | 部分实现 | src/functions/request-confirmation.ts:33-46 | src/background/mcp-bridge.test.mjs:464（page.read hands detected challenges to the G14 user channel and stops） | 确认通道（Channel.broadcast(__approval_request) 阻塞等待 __approval_response）存在；四类硬边界（系统文件/保存对话框、浏览器原生 UI、chrome:// 与商店页、系统授权窗口）的分类识别未实现 |
| G15 | 已实现 | src/content/page-grounding.ts:564,567,575,595-603,668-670 | src/content/page-grounding.test.mjs:456（snapshot folds nested decorations and labels but keeps weak candidates）；真机 mcp-server/test/acceptance.mjs:208-221（4.1-14） | dedupeNestedCandidates 接在排序之后、slice(0,limit) 之前——先折叠再取前 limit 个，否则被折叠的候选白占名额。label[for] 与包裹式 label 折叠进关联控件（控件不在候选里则保留 label）；祖先链上存在另一个且 isElementClickable 的候选时丢掉该候选（用 clickable 而非「是候选」，因 role=group 容器也在候选里）；onclick/tabindex 弱候选一律不参与折叠；祖先链跨 shadow 边界经 .host 继续 |

## 2. H 元素编号（ref）生命周期（H1-H9）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| H1 | 已实现 | src/content/page-grounding.ts:317-332 | src/content/page-grounding.test.mjs:73（rotates snapshot ids and rejects a handle from an older snapshot） | elementToHandleMap(WeakMap)+单调 handleSeq，跨快照稳定 |
| H2 | 已实现 | src/content/page-grounding.ts:111,121-131 | src/content/page-grounding.test.mjs:83（requires a snapshot id when a snapshot-backed handle is used） | 快照换代后旧 ref 报错并指路 find |
| H3 | 已实现 | src/content/page-grounding.ts:766-784 | src/content/page-grounding.ts:381-386（buildElementDescriptor 写 snapshotId+fingerprint） | 指纹不一致即拒绝 |
| H4 | 已实现 | src/content/page-grounding.ts:317-332 | src/content/page-grounding.test.mjs:73 | 单调 handleSeq，新元素不抢老编号 |
| H5 | 已实现 | mcp-server/index.js:203-209 | src/content/page-grounding.test.mjs:242（element actions reject mixed locators and stale refs before touching the page） | superRefine 报 selector/ref/find mutually exclusive 与 ref requires snapshotId |
| H6 | 已实现 | src/content/page-grounding.ts:751-757 | src/content/page-grounding.test.mjs:214（find prefers an exact accessible-name match over a substring match） | resolveFindTarget 不依赖快照 |
| H7 | 已实现 | src/content/page-grounding.ts:751-757 | src/content/page-grounding.test.mjs:222（find refuses to guess between exact matches and lists candidates plus nth bounds） | 多命中报错并列候选，支持 nth |
| H8 | 已实现 | src/content/page-grounding.ts:751-757 | src/content/page-grounding.test.mjs:234（find with no match reports the roles the page actually offers） | 空结果列出页面实际角色 |
| H9 | 已实现 | src/content/page-grounding.ts:109,305-332 | src/content/page-grounding.test.mjs:258（handle table drops elements that left the document instead of growing without bound） | 同 P0-4。未改 WeakRef：句柄以字符串为键且须跨快照存活，WeakRef 要求每个读取点 deref+存活判定，收益不如在脱离处清理；页面卸载时 content script 上下文整体销毁，故不加 pagehide。验收以「300 个已脱离句柄不得全部滞留」的确定性回归测试替代「导航 50 次堆不单调增长」的堆采样（后者需真实 Chrome 逐次采堆，易抖动） |

## 2. C 诚实度（效果证据）（C0-C3）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| C0 | 已实现（2026-10-20 修复后跨层为真） | src/content/page-grounding.ts:826-830、src/background/mcp-bridge.ts:586-590,753-761、src/background/mcp-interaction.ts:42-53,215-219 | src/content/page-grounding.test.mjs:34（reports a click only after the synchronous click completes）、src/background/mcp-bridge.test.mjs:397（a page-side throw reaches the caller instead of collapsing into result:null） | 先 click 后 report，禁用态抛错。**订正**：原先只在 content script 层不吞异常；跨层仍吞——`chrome.scripting.executeScript` 对页面内抛错**不回填 `error` 字段**，只返回 `{result:null}`，与「正常返回 null」字节相同，故 `if (r?.error)` 永不成立，调用方读到 `null.changed` 并报 `Cannot read properties of null`。已改为注入函数自报状态的信封协议（`__actspan_page_result` 标记 + `ok` + `value` 或 `error`），由 `execInTab` / `handleMcpInteraction` 解包还原真实原因 |
| C1 | 部分实现 | src/content/page-grounding.ts:856-932 | src/content/page-grounding.test.mjs:108,119,128,136（同步 DOM 变化/只发请求/密码不外泄/表单校验） | ①③④⑤⑦⑧⑨⑩⑪ 有实现（status changed/requested/validation_error、nearby_text 早停、密码值掩码）；②⑩ 部分；⑥ 动画/轮询去噪无独立实现 |
| C2 | 部分实现 | src/functions/diagnostics.ts:48-55 | src/functions/diagnostics.ts:53（buildToolDiagnostic 在失败且无 diagnostic 时补齐） | 有统一诊断补全与 buildEffectEvidence.diagnostic；「我做了什么+观测到什么+下一步建议」三段的覆盖未逐工具验证 |
| C3 | 部分实现 | src/content/page-grounding.ts:1056-1082 | src/content/page-grounding.ts:1076,1080,1082（readStateProbe 按 expect 判 matched） | expect 只挂在 read 动作的 attr 探针上；并非每个动作都可带预期结果。act 用独立 assert 步（mcp-server/act-script.js:84-87,207-221），失败即停，行为等价于 unmet=stop |

## 2. A 执行层（A1-A4）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| A1 | 已实现 | src/background/mcp-bridge.ts:1042-1058 | src/background/mcp-bridge.ts:1085-1089（真实事件不可用时合成降级为兜底） | realClickAt/realTypeInto/realPressKey 来自 src/functions/cdp-input.ts |
| A2 | 已实现 | src/background/mcp-bridge.ts:1064-1102 | src/background/mcp-bridge.ts:1102（receipt(syntheticResult, await replayReal(), no_effect)） | 无效果自动升级；显式 real:true 走 :1081-1089 并写入 escalation 回执 |
| A3 | 已实现 | src/background/mcp-bridge.ts:1101 | src/background/mcp-bridge.ts:1101（submit \|\| kind === payment \|\| kind === deletion \|\| tag === select 直接返回合成结果） | 原生 select 与敏感目标都不自动升级 |
| A4 | 已实现（2026-10-20 修复后为真） | mcp-server/interaction-tools.js:16-23、src/background/mcp-interaction.ts:243-245 | src/background/mcp-interaction.test.mjs:209（injected interaction args never contain undefined, so Chrome accepts every call）；真实站点：`npm run test:simuser` U7（Wikipedia 搜索框输入并回车，断言页面真跳转） | key 支持数组+repeat≤50、Tab 移焦点、Enter 激活；upload 走 DataTransfer（src/background/mcp-interaction.ts:84-97）；wait 支持 selector/text/idle。**订正**：原只引 S5（未跑通），且这 5 个动作当时在无 ref 路径 100% 失败（注入参数含 `undefined`，Chrome 拒绝整条调用）；已修复并补回归测试 |

## 2. B 数据层（B1-B9）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| B1 | 已实现 | mcp-server/network-tool.js（STRATEGY 常量） | mcp-server/network-tool.js STRATEGY 含 START HERE when you need DATA 与 Never guess an endpoint name from memory | 描述即策略 |
| B2 | 已实现 | mcp-server/network-tool.js（index 参数） | mcp-server/network-tool.js 描述 Index 0 is the newest matching completed response | 从最新往回数 |
| B3 | 已实现 | mcp-server/network-tool.js（reload 参数） | mcp-server/network-tool.js reload 参数描述 | 页面刚打开无记录时刷一次 |
| B4 | 已实现 | src/functions/paginate.ts + mcp-server/data-tools.js | test/scenarios.test.mjs:198-199（paginated.stop_reason === normal_end） | 四种停止原因 identical_response/non_2xx/max_pages/normal_end；savePath 落 NDJSON，回执只给摘要+第一页预览 |
| B5 | 已实现 | src/functions/paginate.ts（observedSize） | src/functions/paginate.ts 从 page.ps/page.pageSize/page.size/ps/page_size 读实际分页字段 | 核对响应而非自传值 |
| B6 | 已实现 | mcp-server/data-tools.js（actspan_data_fetch / actspan_data_download） | mcp-server/data-tools.js fetch 走 base64+savePath 分块；download 走 chrome.downloads 且 saveAs:false | 超限指向 download |
| B7 | 已实现 | mcp-server/data-tools.js（via 参数） | mcp-server/data-tools.js via: z.enum([extension,page]).default(extension) | 跨域二进制默认扩展侧 |
| B8 | 已实现 | src/functions/extract-data.ts:41-45 | src/functions/data-tools.test.mjs:258（lazy image extraction prefers data-src over transparent src） | 优先 data-src/data-original/data-lazy-src |
| B9 | 已实现 | mcp-server/network-tool.js + src/ai/system-prompt.ts:130 | src/ai/system-prompt.ts:127-133（Information-Layer Decision Tree 五支） | 三条取数路线写进描述与 system prompt |

## 2. D 安全（D1-D13）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| D1 | 已实现 | src/background/mcp-bridge.ts:868-880 | test/scenarios.test.mjs:285（S5/CSP and eval policy: permitted fixture handler runs, side-effect eval is rejected） | page.eval 在 mcp-server/policy.js:13 与 src/background/policy-executor.ts:11 均为 dangerous；拦截机制是 userGesture:false + throwOnSideEffect:true（规格书写的 userGesture:true 已过时），副作用表达式（含 dispatchEvent）被 V8 拒绝 |
| D2 | 已实现 | src/content/page-grounding.ts:1025-1050 | test/scenarios.test.mjs:277（S5/G14/C1: payment confirmation is blocked until approval, while ordinary confirmation works） | classifySensitiveTarget 出 kind=payment\|deletion\|ordinary + amount + label；闸门在扩展侧（mcp-bridge.ts:1073-1074），mcp-server/act-tool.js:18-21 的 allowSensitive 默认 false 且写审计 |
| D3 | 已实现 | src/functions/redact.ts:99-119 | src/functions/redact.test.mjs:8（递归按 key 脱敏并保留定位信息） | redactSensitive 按 key 名递归，覆盖顶层 text、fill.fields、steps[].text |
| D4 | 已实现 | src/functions/redact.ts:31-47 | src/functions/redact.test.mjs:27（凭据组跨空行掩码但孤立 commit hash 保留）、:45（同页两组凭据各自脱敏且中间正文保留） | ≥3 行成组、空行不断组、孤立长串（commit hash）保留、正文与排版保留 |
| D5 | 已实现 | src/functions/redact.ts:73-88 | src/functions/redact.test.mjs:53（凭据 URL 整页降级且普通页面不误判）、:67（数据工具出口对凭据 URL 整页掩码且普通页面原样保留） | isCredentialUrl 认 hostname 前缀与 path 段；MASKED_PAGE_WARNING=凭据页面内容不要转述；普通页面原样 |
| D6 | 已实现 | src/functions/redact.ts:2,69-70,107 | src/functions/redact.test.mjs:36（正文新密码和手机号脱敏但长数字 ID 保留） | LOCATION_KEYS（url\|path\|selector\|code\|expression）保留；password/token 赋值式挖掉；手机号 [REDACTED PHONE]；18 位订单号保留 |
| D7 | 已实现 | src/functions/redact.ts:7-12,100-116 | src/functions/redact.test.mjs:19（循环引用、base64 和长 eval 安全处理）、:62（data URI base64 只记录大小） | summarizeBase64 只留字节数；DEFAULT_EVAL_LIMIT=400 截断长表达式；WeakSet 见环返回 [循环引用] |
| D8 | 已实现 | mcp-server/bridge.js（appendAudit） | mcp-server/test/lifecycle.mjs:221-271 | audit.jsonl 记 host/sessionId/tabId/工具/脱敏参数/效果摘要/时间，2048 字节行上限，0o600；扩展经 src/background/mcp-bridge.ts:81-96 sendBridgeAudit 送桥落盘 |
| D9 | 已实现 | src/background/mcp-bridge.ts:310 | src/background/mcp-bridge.test.mjs:452-462（page content never escapes the single untrusted fence even when it forges delimiter pairs） | wrapUntrustedPageContent 转义内层收尾定界符，只包一层；system-prompt.ts:135 声明不可信 |
| D10 | 部分实现 | mcp-server/index.js（actspan_tab_open active 默认 false） | src/background/mcp-bridge.ts:803-804、:823-829；src/functions/tab-utils.ts:123（chrome.tabs.create({ url, active: false })） | 后台打开与「受控≠前台」已成立；但全仓无任何工具提供显式 focus:true 逃生口，规格要求的「需要前台必须显式 focus:true 且描述写明会打断用户」未实现 |
| D11 | 部分实现 | src/content/float-ball/text-utils.ts:11-30（replaceInternalToolTerms） | src/content/status-virtual-cursor.test.mjs:50（status text removes internal tool details instead of guessing from a tool name） | 内部工具术语/选择器/句柄/bbox 的清洗已实现并有测试；但「文案不带用户输入内容」这条无实现也无测试（无任何按用户输入过滤的路径） |
| D12 | 部分实现 | mcp-server/bridge.js:42,228-246,251-301 | mcp-server/test/e2e.mjs:145-149（web origin cannot pair / web rejection does not leak token / wrong token is rejected）、mcp-server/test/security.mjs:40-52 | Origin 白名单（/^chrome-extension://[a-p]{32}$/）与 token 校验均已实现；但 role 未在扩展 hub 握手路径校验（role 只出现在 bridge-daemon.js:153 与 src/offscreen/mcp-transport.ts:242-243），「扩展冒充 agent（有 Origin 却报 role:agent）被拒」未实现 |
| D13 | 已实现 | src/functions/risk-detect.ts（createReadDriftTracker/detectReadDrift） | src/functions/risk-detect.test.mjs:23（读取漂移按 session 去重且自导航不告警）、test/scenarios.test.mjs（S5/drift: direct navigation outside the Actspan task produces a warning） | mcp-bridge.ts:941 check + :951-952 警告文案；自导航不告警、按会话去重 |

## 2. E 连接与可靠性（E1-E10）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| E1 | 已实现 | mcp-server/bridge-cli.js（actspan bridge [start\|stop\|status\|usage]） | mcp-server/test/bridge-lock.mjs:77-81（owner.role === daemon）、:200-218（restarts an older daemon before reuse） | bridge-lock.js 用 O_EXCL wx 抢锁、30s mtime 判残留自愈、spawnBridgeDaemon detached+stdio 落日志+unref、bridge.json 记 pid；bridge-daemon.js main() 接管锁并发心跳。**升级自愈**：daemon 把 `appVersion` 写进 0600 凭据，`ensureBridgeDaemon` 连接前比对当前包版本，不一致则先用既有优雅退出流程退役旧 daemon 再拉起新版（`bridge.json` 缺失时按凭据自律）——修掉了「升级 MCP 包后旧 capability 表长期驻留」的缺陷 |
| E2 | 已实现 | mcp-server/bridge.js（call 内 reconnectGraceMs=250） | mcp-server/bridge.js:38（constructor 默认 reconnectGraceMs=250）、graceDeadline 结算文案 Bridge reconnect grace elapsed | 宽限期内带回执则 agent 拿到真结果 |
| E3 | 已实现 | mcp-server/bridge.js（initialQueueMs=250、队列上限 16） | mcp-server/bridge.js 队列满拒绝文案 Bridge reconnect queue is full、Bridge initial offline queue expired | 离线先排队、连上即送达；agent 走了不在已关闭连接上回包；一直不来最终失败且文案说清 |
| E4 | 已实现 | mcp-server/bridge-daemon.js（failInFlight） | mcp-server/bridge-daemon.js 文案 Bridge daemon is shutting down；bridge.js onConnection ws.on(close) 以 bridge disconnected 结算全部 pending | 在途命令立即失败，不干等到超时 |
| E5 | 已实现 | mcp-server/bridge-lock.js:202-204（operator 帧 + status.shutdown） | mcp-server/bridge-daemon.js（status.shutdown 只认主客户端或 client.operator）、bridge.js 六元组校验 | stopBridge 只认 bridge.json 里的 pid 并 SIGTERM；桥先回错误再退；六元组响应关联保留 |
| E6 | 已实现（2026-10-20 修复后为真） | src/lib/cdp-session.ts:123（L2_IDLE_MS = 5000）、src/background/mcp-bridge.ts:764-775 | src/background/mcp-bridge.test.mjs:394（a click escalated to real CDP input does not block a later debugger operation on the same tab） | L1 content script 默认、L2 chrome.debugger 按需、空闲 5000ms detach。**订正**：原先存在**两条互不知情的 attach 路径**——`page.click` 的真实事件升级走 `CDPSessionManager`（src/functions/cdp-input.ts），`page.screenshot`/`page.eval` 走 `tabLeaseManager.withDebugger` 的裸 `chrome.debugger.attach`。前者把调试器挂上并保持 5000ms，后者不知情又 attach 一次，导致「selector 点击后，该标签页上所有调试器操作在 5 秒内全部失败」。已把 `withDebugger` 改为经 `CDPSessionManager.attach/detach` 出入，两条路径共用同一份 attach 状态 |
| E7 | 已实现 | src/lib/cdp-session.ts:124,206,237-242 | src/lib/cdp-session.test.mjs:37-41（maps a DevTools collision to L2_BUSY）、src/functions/cdp-input.test.mjs:25-29（reports NEEDS_L2 when the debugger API is unavailable） | CDPLifecycleErrorCode = NEEDS_L2 \| L2_BUSY；Another debugger is already attached 映射为 L2_BUSY 并给出可读降级说明 |
| E8 | 已实现 | src/background/session-types.ts:236（GRACEFUL_ABORT_TIMEOUT_MS = 5000） | src/background/session-abort.ts:7,29（作为 timeoutMs 使用） | 规格书写的 120 毫秒已订正为 5000 |
| E9 | 已实现 | mcp-server/bridge.js（watchLiveness/clearLiveness） | mcp-server/bridge.js pingIdleMs=30000、pongTimeoutMs=10000、未回 pong 才 ws.terminate() | 静默连接先收 ping，回 pong 的活着 |
| E10 | 已实现 | src/background/mcp-bridge.ts:1153（ensureMcpOffscreenDocument → mcp.html） | src/offscreen/mcp-transport.test.mjs:72,104（offscreen 回 pong 且不转发 / 真实帧仍转发给 SW） | src/offscreen/mcp.html + mcp-transport.ts 持有 WebSocket；全仓无桥专用 alarms keep-alive（alarms 仅用于 timer/resident 任务） |

## 2. F/O 记忆与经验回流（F1-F8）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| F1 | 部分实现 | src/functions/site-experience.ts:680-717 | src/functions/site-experience.ts:714（factoryHosts 由内置层 keys 得出，可整段识别） | 两层合并展示、出厂段可识别、本机层独立存储键（actspan_site_experience_layers_v1）已实现；但出厂内容为空——src/functions/builtin-experience.ts:42-45 BUILTIN_SITE_EXPERIENCE.domains = {}，「升级永不覆盖」无内容可验 |
| F2 | 已实现 | src/functions/site-experience.ts:451-465,509-512 | src/functions/site-experience.ts:463-464（twitter→x.com、tmall→taobao.com）、:509-512（hostCandidates 子域降级） | 完整 URL 归到 hostname、去 www、别名归并、RESERVED_HOSTS 防原型污染 |
| F3 | 已实现 | src/functions/site-experience.ts:697-701 | src/functions/site-experience.ts:699-701（无记录时返回 当前站点暂无经验记录；不阻塞操作，可在成功后回流沉淀经验。） | 不静默返回空 |
| F4 | 已实现 | src/functions/save-workflow.ts:58-109,135 | src/functions/save-workflow.ts:135（data: { name, revision, warnings, healthy: warnings.length === 0 }） | 好剧本零警告；坏形状照存但逐条点名；坏 JSON 与空 steps 才拒 |
| F5 | 已实现 | src/functions/site-experience.ts:697-701,790 | src/functions/site-experience.ts:700（经验是提示不是规则，执行前仍需重新读取页面。）、:790（保存回执带免责） | get 与 save 两处都保留免责 |
| F6 | 已实现 | src/functions/site-experience.ts:733-750,754-772 | src/functions/site-experience.ts:782（subtractSiteExperience 按条目减掉出厂段） | unwrapSiteExperience 认得 merged/local/裸 domains，认不出返回 null 而非静默清空；selector 按值、失败计数按差、草稿按 id 相减 |
| F7 | 已实现 | src/functions/site-experience.ts:788 | src/functions/site-experience.ts:788（revisions = [...priorSnapshots, ...previous].slice(0, 10)） | 保留最近 10 份 |
| F8 | 已实现 | src/background/act-drafts.ts:87-118,126-129 | src/background/act-drafts.test.mjs:48（repeat success with different typed text increments existing structural draft only） | 资格：audit.success && hasMutation && effectiveCount>=3 && stepCount>=3；placeholderFor 把输入换 ${slug}；read/wait 步不计入；同结构重复只 successCount++；adoptActDraft 显式晋升进本机层并排在最前 |

## 2. I 挑战/风控识别（I1-I2）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| I1 | 已实现 | src/functions/risk-detect.ts:1-56 | src/functions/risk-detect.test.mjs（挑战识别：frames 优先、去 query、正文验证不算、垃圾输入不炸） | CHALLENGE_HOSTS 认 Cloudflare/hCaptcha/reCAPTCHA；challengeFrame 只取 hostname+pathname（query 丢弃）；detectChallenge 先 frames 后 overlays；hostOf 垃圾输入回空串不抛 |
| I2 | 已实现 | src/background/mcp-bridge.ts:904 | src/background/mcp-bridge.test.mjs:464（page.read hands detected challenges to the G14 user channel and stops） | detectChallenge().detected → requestConfirmationFunction.execute（G14 通道）后 throw PolicyError(CHALLENGE_MESSAGE, E_CHALLENGE)；CHALLENGE_MESSAGE = 检测到站点验证，需要用户完成；不重试不绕过 |

## 2. J 版本协商（J1-J3）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| J1 | 已实现 | mcp-server/protocol-version.js:28-（compareProtocolVersions）、mcp-server/identity.js:87-107 | mcp-server/test/protocol-version.mjs:5,42 | 补丁号不同静默（warning=null）；次版本落后分清哪一边；协议号不同即 compatible:false；按数字比；缺任一边不报警 |
| J2 | 已实现 | mcp-server/install.js:129,132 | mcp-server/test/install.mjs:13（installer keeps package and extension versions consistent）、:17（public manifest and publishable package share version and stable identity） | versionReport() 出 consistent；不一致时 runInstall 抛 版本不一致；测试同时断言 manifest.version === pkg.version 与 manifest.key === pkg.actspan.extensionKey |
| J3 | 已实现 | mcp-server/protocol-version.js:27（doc comment：Compare local and peer bridge metadata without trusting a remote conclusion.） | mcp-server/bridge.js:67（compatibility 由本进程 LOCAL_VERSION + PROTOCOL_VERSION 算出） | 用本进程自己的版本算，不采信桥给的结论 |

## 2. K 宿主身份（K1-K3）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| K1 | 已实现 | mcp-server/identity.js:109-126（normalizeHostIdentity） | mcp-server/test/identity.mjs:37（prefers specific self-reported hosts, maps aliases, and preserves unknown names）、mcp-server/test/e2e.mjs:68（MCP host identity uses initialize clientInfo.name） | 自报压过 --client；别名归一到 agents.json slug；未知名原样保留；泛称才退回 fallback；slugOf 只剥「我是 MCP 客户端」类后缀 |
| K2 | 已实现 | mcp-server/daemon-rpc.js（createLazyBridgeDaemonClient 的 label/sessionId setter） | mcp-server/daemon-rpc.js 抛错文案 Bridge label is frozen once connected / Bridge sessionId is frozen once connected；mcp-server/test/e2e.mjs:113-115（bridge label carries the self-reported host, not the wrong --client fallback） | 连上后改口被拒 |
| K3 | 已实现 | mcp-server/usage.js:39-93 | mcp-server/test/usage.mjs:14,31,43、mcp-server/test/lifecycle.mjs:264-271、mcp-server/test/e2e.mjs:69-71 | createUsageLedger 按 host slug 归因；bridge.js appendAudit 时调 usage.record；actspan_status 暴露 usageForHost；actspan bridge usage 子命令可读 |

## 2. M ask 三态（M1-M3）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| M1 | 已实现 | src/functions/ask-user.ts:38-46,64-71,149-165 | src/functions/ask-user.ts:161-163（frame.result === true 即 cleanup 并广播 code: until） | until 支持 selectorExists/textContains/urlContains，250ms 轮询，命中自动收工，不用用户点；无受控 tabId 时报错 |
| M2 | 已实现 | src/functions/ask-user.ts:113-146 | src/functions/ask-user.ts:118（code: denied）、:143-146（code: timed_out \| cancelled） | 规格书称现状只折进 error 字符串——已订正：data.code 结构化区分 timed_out/denied/cancelled/unattended/until 五种 |
| M3 | 已实现 | src/functions/ask-user.ts:47,60-62 | src/functions/ask-user.ts:61（error: User is unavailable in unattended mode, data: { code: unattended }） | unattended 参数立即返回，不干等 |

## 2. N 可视化与多会话归属（N1-N12）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| N1 | 已实现 | mcp-server/status-tool.js:3,10-12 | src/content/float-ball/status-state.test.mjs:27（active false and empty text return the cockpit to idle, not to a sticky last status）、src/content/status-virtual-cursor.test.mjs:44,50 | actspan_status_update 描述逐字照搬对方定义（Instant, never blocks. Use the user language. ≤80 chars）；status-state.ts nextStatusState 在 active:false/text: 时清空，粘住问题已修 |
| N2 | 已实现 | mcp-server/identity.js:128-138（deriveSessionIdentity） | mcp-server/test/identity.mjs:55-63 | sid 纯函数；EMOJIS[16] 保证互异、GROUP_COLORS[9] 带 Chrome 标签组颜色、hashString 派生 |
| N3 | 已实现 | mcp-server/identity.js:128-143 | mcp-server/test/identity.mjs:65 | 短码取最后一个冒号后的那截；无冒号结构时退化为整串不崩；createStableSessionId 从 host/process 派生 |
| N4 | 已实现 | src/background/tab-lease-manager.ts:43,59-68,70-86 | src/background/session-manager.test.mjs | ownTabs: Map<number, SessionTabRecord>；conflict() 排除本会话与已断开的主人；ownershipError() 给出下一步；snapshotOwnTabs/restoreOwnTabs 跨桥重启保留 |
| N5 | 已实现 | src/background/tab-lease-manager.ts:104-109 | mcp-server/index.js（actspan_tab_open label 参数）、src/background/mcp-bridge.ts:776-782 | listTabs 出 marker */+/× 与 label；tab_open 收 label（trim 1-80） |
| N6 | 已实现 | src/background/mcp-bridge.ts:1105-1107,872 | test/scenarios.test.mjs:312（S5/new-tabs: local child opened by the fixture is observable and follows its opener） | withNewTabs 回执带 parentTabId/tabId/newTabIds；未开新页时 tabId/newTabIds 不出现（不误报）；attachNewTab 拒绝非新标签页 |
| N7 | 已实现 | src/background/policy-executor.ts:109-111 | src/background/tab-lease-manager.ts:94-95（selectTab 冲突只回 warning 不阻止）、:88-89（authorizeWrite 抛 TabLeaseError） | 写路径在副作用前 authorizeWrite 拦截；select 别的会话在用只警告；主人已断开可继承（conflict 排除 disconnected） |
| N8 | 已实现 | mcp-server/bridge.js:378-383 | mcp-server/bridge-daemon.js:87-91（removeClient 调 hub.sessionDisconnected） | sessionDisconnected 通知按 clientId+sessionId 暂存，扩展重连时 :277 重放；受控标签页在扩展侧原地保留 |
| N9 | 已实现 | src/background/tab-lease-manager.ts:111-119 | src/background/tab-lease-manager.ts:116（10 * 60_000 冷却） | 户口簿 ≥2 页且走缺省槽才提醒；10 分钟冷却 |
| N10 | 部分实现 | src/content/float-ball/components/Trigger.tsx:191-193、src/content/page-parser.ts:62-66 | 全仓无 chrome.tabs.group / tabGroups / document.title 赋值 | 门牌不碰已成立（title/favicon 只读）；但归属可视化只做到 label + 悬浮球，无 tab group 成员关系（无 tabs.group 调用），规格列的 tab group 一路缺失 |
| N11 | 已实现 | src/content/virtual-cursor.ts:5-8,28,77-91 | src/content/status-virtual-cursor.test.mjs:112（virtual cursor hook is emitted before obstruction detection）、src/content/page-grounding.test.mjs:149 | VIRTUAL_CURSOR_HOOKS.beforeObstruction/afterObstruction；withVirtualCursorBeforeObstruction 同步先发钩子再检测遮挡；钩子名 actspan-virtual-cursor-<hook> 两侧一致 |
| N12 | 已实现 | src/content/float-ball/ActspanRoot.tsx:20-24,92-94 | src/content/float-ball/status-state.test.mjs:38（curtain renders current status accessibly and disappears in idle state） | StatusCurtain role=status + aria-live=polite；空闲时返回 null 消失；胶囊状态机在 src/content/float-ball.ts:1097-1143 |

## 2. P act 复合工具 DSL（P1-P7）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| P1 | 已实现 | mcp-server/act-tool.js:66 | mcp-server/act-tool.js:66（Your DEFAULT way to act — batch every step you can predict. Every call you merge saves a full model turn.） | 描述第一句逐字；顺序执行 + 每步效果校验 + 末尾一次快照 |
| P2 | 已实现 | mcp-server/act-tool.js:5,20,61,73,98 | mcp-server/test/act-tool.mjs:49-54（sensitive step detection）、test/scenarios.test.mjs:106（S5/sensitive/effect: act stops before a payment side effect and reports the reason） | SENSITIVE 正则覆盖提交/支付/删除中英文；allowSensitive 默认 false，未开时抛 SENSITIVE_BLOCKED；开了仍走扩展审批且写审计 |
| P3 | 已实现 | mcp-server/act-tool.js（read handler 的 contains → attr: textContains） | mcp-server/act-script.js:4（READ_ATTRS 含 textContains） | read 支持 {ref\|find\|selector, attr?} 或 {contains}，观测带回批量中途 |
| P4 | 已实现 | mcp-server/act-script.js:6,61,114-117 | mcp-server/test/act-script.mjs:116（repeat max 越界报 REPEAT_BUDGET）、act-script.js:61（INVALID_NESTING 文案含怎么改） | DEFAULTS maxDepth=1 控制块只嵌一层；maxRepeat 默认 10 上限 25；cond 支持 urlContains\|selectorExists\|textContains\|checked\|value\|text + not |
| P5 | 已实现 | mcp-server/act-script.js:75-77,119-121 | mcp-server/act-script.js:76（Repeat cannot use ref/element_id because page rerenders invalidate it; use a stable selector or find） | repeat 子步与 repeat.until 都禁 ref/element_id，错误信息给出替代 |
| P6 | 已实现 | mcp-server/act-script.js:146,154 | mcp-server/act-tool.js:57-60（schema 不设原始步数上限，预算按 flatCount 展开后算） | flatCount 把 repeat/if 展开成实际执行步数；超限抛 BUDGET_EXCEEDED 且文案说明怎么改 |
| P7 | 已实现 | mcp-server/act-script.js:25-33,86,106,125 | mcp-server/test/act-script.mjs:112-113 | describeCondition 支持 not 取反并截短，写入 condText 供回执展示 |

## 2. Q/R 握手与协议（R1-R7）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| R1 | 已实现 | mcp-server/bridge.js:412-415 | mcp-server/bridge-daemon.js（request() 写 context.sessionId、client.prefix = randomUUID + 冒号） | 每会话稳定、会话间互异；sid 只在桥与扩展间流转，不回泄给 agent |
| R2 | 已实现 | mcp-server/bridge.js:418 | mcp-server/test/e2e.mjs:113-115 | onlineSessions 由 daemon 的 onlineSessions() 注入，缺省为空数组 |
| R3 | 已实现 | mcp-server/bridge-daemon.js:155（client.label 取自 auth 帧） | mcp-server/index.js（hub.label = host.slug） | hello 里的 label 随每条命令盖给扩展；不带就不盖 |
| R4 | 已实现 | mcp-server/bridge-daemon.js:87-91 | mcp-server/bridge-daemon.js:90（removeClient 只调 hub.sessionDisconnected，无删槽指令） | agent 断开不发删槽指令，理由：它可能只是要重连 |
| R5 | 已实现 | mcp-server/bridge.js:314-317 | mcp-server/bridge.js:316（tab_closed → this.emit(event)） | 扩展事件广播给所有 agent；tab_closed 回归 |
| R6 | 已实现 | mcp-server/catalog.js:109-119 | mcp-server/catalog.js:114-117（clientId/requestId/taskId/sessionId 缺省 randomUUID） | 老客户端不带 sessionId 仍拿到互异身份 |
| R7 | 已实现 | mcp-server/bridge.js（onConnection 六元组校验） | mcp-server/test/lifecycle.mjs:274-287（validated host slug travels in request context without changing clientId binding） | 按 clientId+requestId+taskId+sessionId+tabId 全量比对，弱化即回归（规格 §6.4 明列不得弱化） |

## 2. T 分层与工具描述（T1-T8）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| T1 | 已实现 | src/ai/orchestrator.ts:144-148 | src/ai/orchestrator.ts:148（buildSystemPrompt(tools, tools.some(tool => tool.name === agent), ...)） | P0-1 已修：allTools = [...tools] 全量常驻，hasSubtask 由实际工具表推导，不再硬编码 true |
| T2 | 已实现 | src/ai/core-loop.ts:606,757 | src/ai/core-loop.ts:606（buildAgentToolSet(tools, allTools, config.toolFilter)）、:757（if (allTools && loadedOnDemandTools)） | P0-2 已修：子 agent 递归调用补齐 allTools/loadedOnDemandTools，load_tools 注入守卫不再被跳过 |
| T3 | 已实现 | src/functions/tool-tiers.ts:63 | src/functions/tool-tiers.ts:63（\| label \| listed.join(, ) \| description \|） | catalog 现在逐项列出工具名，webhook 事故的直接原因已消除 |
| T4 | 已实现 | src/functions/tool-tiers.ts:19,38 | src/functions/tool-tiers.ts:19,38（Webhook push to Feishu/Lark/Bark/Slack/Discord/WeCom） | 分类描述已含 webhook/飞书/推送字样 |
| T5 | 已实现 | src/functions/tool-tiers.ts:1-22 | src/functions/tool-tiers.ts:1-22（TOOL_LAYERS = dom_actions/network_data/pixel_fallback/sessions_meta） | 分类维度改为信息载体；每类描述写成「什么时候用 / 别用这个」；测试 src/functions/tool-tiers.test.mjs |
| T6 | 已实现 | mcp-server/act-tool.js:66、mcp-server/network-tool.js（STRATEGY）、mcp-server/data-tools.js | mcp-server/act-tool.js:66（Your DEFAULT way to act）、mcp-server/network-tool.js（START HERE when you need DATA / Never guess an endpoint name from memory） | 默认路径、退让顺序、入口引导、反必错先验、自带诊断承诺均写进 description |
| T7 | 已实现 | src/functions/load-tools.ts:39-43、src/functions/tool-tiers.ts:65 | src/functions/load-tools.ts:40（already_available: true）、:43（tools are already available in the ... category） | 工具默认全量常驻；load_tools 保留为兼容命令，不再谎报「已加载 N 个工具」 |
| T8 | 已实现 | src/ai/system-prompt.ts:127-133 | src/ai/system-prompt.test.mjs:46-47（Information-Layer Decision Tree） | 五支决策树（DOM 操作 / 网络数据 / 文件 / 像素兜底 / 会话与元）写进 system prompt |

## 2. V 预算与 SSE（V1-V2）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| V1 | 已实现 | src/ai/loop-config.ts:21,129、src/ai/core-loop.ts:420,443,503,861 | src/ai/core-loop.test.mjs:68-72（task deadline E_TIMEOUT） | taskDeadlineMs 默认 10 * 60 * 1000；到期 emit E_TIMEOUT 且文案说明「任务级墙钟预算已到期，已停止当前任务」，不静默 |
| V2 | 已实现 | src/ai/llm-client.ts:226-230,284-294、src/ai/core-loop.ts:107-112 | src/ai/core-loop.test.mjs:120-132（E_SSE_UNRECOGNIZED） | 识别不了的 SSE 事件计数，轮末 emit {code: E_SSE_UNRECOGNIZED, count}，不再静默丢弃 |

## 2. U 安装与零配置（U1-U7）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| U1 | 已实现 | mcp-server/catalog.js:52-100、mcp-server/index.js:23,133 | mcp-server/test/catalog.mjs:68,89 | controlPlane = Boolean(apiUrl \|\| apiKey) 为可选；只强校验 BRIDGE_URL 本地性；EXTENSION_IDS 缺失时 pairingRequired:true 而非报错；actspan_status 未连扩展时回 loop_mode: disabled |
| U2 | 已实现 | mcp-server/install.js:36-51,65-92 | mcp-server/test/install.mjs:121-123 | discoverConfigs 用 allKnownPaths 去重（排除范围算全部候选路径）；planConfig/applyPlan 备份为 .bak-<ts>；printPlan 用 ·/+ 标已配置/将写入；tomlBlock 只追加 [mcp_servers.x] 块；jsonTarget 认不出的走 manual |
| U3 | 已实现 | mcp-server/doctor.js:20-23,38-58,60-91 | mcp-server/test/doctor.mjs | ownerStatus 对 bridge.json 里已消失的 pid 明说「已经没了」；--start --yes 时 startBridge 自己先拉一个再探；probeBridge 走 owner.info 握手 |
| U4 | 已实现 | mcp-server/install.js:107-124,94-106,125-128 | mcp-server/test/install.mjs:28（loopback onboarding hands the extension URL to the address bar and accepts only the manifest-derived id） | pairExtension 起 127.0.0.1 随机端口 + nonce，POST /pair 回传；extensionIdFromKey 从 manifest key 推导规范 ID；用户只需加载扩展 |
| U5 | 已实现 | mcp-server/install.js:63 | mcp-server/install.js:63（process.platform === win32 ? npx.cmd : npx） | 双运行模式：fromNpm 走 npx/npx.cmd，本地走 process.execPath + index.js |
| U6 | 已实现 | mcp-server/install.js:125-128,94-106 | mcp-server/install.js:127（spawn(command, args, { detached: true, stdio: ignore, windowsHide: true }) + child.unref()） | 按平台 cmd /c start / open / xdg-open；引导页 pairingGuide 明写「浏览器不允许脚本代替你完成加载扩展这一下」 |
| U7 | 已实现 | mcp-server/install.js:68,92 | mcp-server/install.js:68（识别到顶层 mcp + 命令数组格式；不会猜测其语义）、:92（手动配置说明（不表示 install 已支持自动安装）） | 异构格式只打印 JSON + 手动步骤，不写文件 |

## 2. S 测试与靶场（S1-S5）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| S1 | 已实现 | test/scenarios.test.mjs:13,62-66 | test/scenarios.test.mjs:62（S5: MCP advertises all externally registered Actspan tools, without aliases） | 断言 [...mcp.tools.keys()] 与 catalog.js TOOL_NAMES 完全一致且每个工具可 requireTool，等于「每个工具必须有靶场用例」的制度落点 |
| S2 | 已实现 | test/fixtures/ | test/scenarios.test.mjs:52（S1/S2: local fixture host serves every required fixture class） | 六个 fixture 类共 7 个文件：playground.html / creds.html / csp.html / frame-inner.html / newtab.html + newtab-child.html / flow.html |
| S3 | 已实现 | src/functions/redact.test.mjs | src/functions/redact.test.mjs:8,19,27,36,45,53,62,67,75,86,97 | 覆盖 D3-D7 每条判据：循环引用不炸、base64 只留大小、定位信息不被脱掉、凭据 URL 整页掩码、JSON 字符串脱敏 |
| S4 | 已实现 | mcp-server/test/lifecycle.mjs、bridge-lock.mjs、e2e.mjs、security.mjs | mcp-server/test/lifecycle.mjs:221-271,274-287、bridge-lock.mjs:77-81、e2e.mjs:145-149、security.mjs:40-52 | 覆盖 E1-E5/E9 与 R1-R7 |
| S5 | 部分实现 | test/scenarios.test.mjs（22 个 test()）+ src/content/page-grounding.test.mjs | test/scenarios.test.mjs:83,98,106,114,124,142,174,204,217,227,249,264,277,285,294,303,312,326 | 已覆盖：完整事件序列 / mousedown-only 下拉 / preventDefault 焦点 / SVG / 跨源 iframe @fN / shadow DOM / 一次填完整表 / file 角色 / 无 for 命名 / 按键默认行为 / 迟到校验置顶 / upload 无系统对话框 / 拖放 / @value / untrusted 边界 / select 与敏感不自动升级 / isTrusted 自动升级 / 漂移警告 / ref-selector 互斥 / find 四态 / act 八条 / 编号稳定性 / 凭据隐去 / 会话隔离 / 新 tab 跟随 / 快照可访问性。**未覆盖**：后台 confirm 不卡死、select 强制 L1、eval 内支付拦截、ask 三态场景测试、支付拦截 4 正 4 反完整矩阵。「后台滚动唤醒懒加载」已由真机 4.1-15 覆盖（补发 wheel + 三因诊断） |


## 3. 工作包与依赖（WP0-WP15）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| WP0 | 部分实现 | src/functions/webhook.ts:112-121、mcp-server/catalog.js:15-16 | mcp-server/catalog.js:16（actspan_feishu_push 已在 TOOL_NAMES） | 已达成：T1 T2 T3 T4、webhook name trim（:113 name?.trim()）、webhook 上 MCP 面、E8。未达成：feishu.push 配错时的错误信息仍只有一句 未配置启用的飞书 Webhook（:244-248），不列每个 entry 的 [name\|type\|enabled\|host] 与匹配条件；C0/P0-3 只做到部分（见 C0 行） |
| WP0.5 | 已实现 | docs/spec/actspan-superset-spec.md:421 | 本表 G5 / G14 / M2 / H2 四行（均由实读代码定级） | 侦察结论：G5 已实现、H2 已实现、M2 已实现（规格书称只折进 error 字符串已过时）、G14 部分实现（确认通道有，四类硬边界分类缺） |
| WP1 | 部分实现 | src/content/page-grounding.ts | 汇总自本表 G1-G15 行 | G1 G2 G7 G10 G12 G14 部分实现；其余 9 条已实现（G11 G13 G15 已由本轮补齐） |
| WP2 | 部分实现 | src/content/page-grounding.ts | 汇总自本表 H1-H9 行 | 仅 H9（elementHandleMap 强引用泄漏）未实现，其余 8 条已实现 |
| WP3 | 部分实现 | src/content/page-grounding.ts:856-932 | 汇总自本表 C0-C3 行 | C0 已实现；C1 C2 C3 部分实现 |
| WP4 | 已实现 | mcp-server/interaction-tools.js、mcp-server/network-tool.js、mcp-server/data-tools.js | 汇总自本表 A1 A4 B1-B9 行 | A1 A4 B1-B9 全部已实现 |
| WP5 | 部分实现 | src/functions/redact.ts、mcp-server/bridge.js | 汇总自本表 D1-D13 行 | D10（无 focus:true 逃生口）D11（文案不带用户输入未实现）D12（role 未双向校验）三条部分实现，其余 10 条已实现 |
| WP6 | 已实现 | src/functions/tool-tiers.ts、src/ai/loop-config.ts、src/ai/llm-client.ts | 汇总自本表 T5-T8 V1 V2 行 | 五条全部已实现 |
| WP7 | 已实现 | mcp-server/bridge.js、mcp-server/bridge-daemon.js、mcp-server/bridge-lock.js | 汇总自本表 E1-E9 R1-R7 行 | E1-E9 与 R1-R7 全部已实现 |
| WP8 | 部分实现 | src/functions/site-experience.ts、src/background/act-drafts.ts | 汇总自本表 F1-F8 行 | 仅 F1 部分实现（出厂层 domains 为空），其余 7 条已实现 |
| WP9 | 已实现 | mcp-server/install.js、mcp-server/doctor.js、mcp-server/catalog.js | 汇总自本表 U1-U7 行 | 七条全部已实现 |
| WP10 | 已实现 | mcp-server/act-tool.js、mcp-server/act-script.js | 汇总自本表 P1-P7 行 | 规格建议不进本轮，实际七条已全部落地 |
| WP11 | 已实现 | src/functions/risk-detect.ts | 汇总自本表 I1 I2 行 | 两条已实现，且不做绕过 |
| WP12 | 部分实现 | mcp-server/status-tool.js、src/background/tab-lease-manager.ts、src/content/float-ball | 汇总自本表 N1-N12 行 | 仅 N10 部分实现（无 tab group 成员关系），其余 11 条已实现 |
| WP13 | 已实现 | src/offscreen/mcp.html、src/offscreen/mcp-transport.ts | src/offscreen/mcp-transport.test.mjs:72,104 | socket 已搬进 offscreen document；全仓无桥专用 alarms keep-alive |
| WP14 | 已实现 | mcp-server/identity.js、mcp-server/protocol-version.js、mcp-server/agents.json | 汇总自本表 J1-J3 K1-K3 行 | 六条全部已实现 |
| WP15 | 部分实现 | test/fixtures/、test/scenarios.test.mjs、src/functions/redact.test.mjs、mcp-server/test/ | 汇总自本表 S1-S5 行 | S1-S4 已实现；S5 部分实现（缺后台 confirm 不卡死 / select 强制 L1 / eval 内支付拦截 / ask 三态场景 / 支付拦截 4 正 4 反矩阵）。另注：package.json:25 的 npm test 只跑 src/*.test.mjs 与 src/**/*.test.mjs，test/scenarios.test.mjs 不在 CI 覆盖内 |
## 4.1 「子集达成」判据（15 条）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| 4.1-1 | 已实现 | mcp-server/catalog.js:52-100、mcp-server/index.js:133,146 | mcp-server/test/catalog.mjs:68,89 | 判据：未配 controlPlane 也能起。validateConfig 只强校验 BRIDGE_URL 本地性；actspan_status 未连扩展回 loop_mode: disabled，连上回 enabled |
| 4.1-2 | 已实现 | mcp-server/network-tool.js（STRATEGY）、mcp-server/data-tools.js | test/scenarios.test.mjs:198-199（paginated.stop_reason === normal_end） | 判据：取数三条路线（network / fetch / download）都有入口且描述即策略 |
| 4.1-3 | 部分实现 | src/functions/webhook.ts:112-121,244-248、mcp-server/index.js:148-157 | mcp-server/catalog.js:16（actspan_feishu_push 在 TOOL_NAMES） | 判据：WP0 存量 P0 全清。T1-T4、name trim、webhook 上 MCP 面、E8 均已达成；feishu.push 配错时的错误信息仍未逐条列出 entry 的 [name\|type\|enabled\|host] 与匹配条件 |
| 4.1-4 | 已实现 | src/background/mcp-bridge.ts:868-880、mcp-server/policy.js:13、src/background/policy-executor.ts:11 | test/scenarios.test.mjs:285（S5/CSP and eval policy: permitted fixture handler runs, side-effect eval is rejected） | 判据：page.eval 默认危险且副作用被拦。拦截靠 userGesture:false + throwOnSideEffect:true（规格书写的 userGesture:true 已过时） |
| 4.1-5 | 已实现 | src/functions/redact.ts:31-119 | test/scenarios.test.mjs:294（S5/credentials: credential fields are masked in snapshots and effect evidence） | 判据：凭据不外泄。redact.ts 覆盖 D3-D7 全部判据，另有 src/functions/redact.test.mjs 11 条 |
| 4.1-6 | 已实现 | src/content/page-grounding.ts:856-932（buildEffectEvidence） | test/scenarios.test.mjs:277（S5/G14/C1: payment confirmation is blocked until approval, while ordinary confirmation works） | 判据：效果证据可信。status ∈ changed/requested/unchanged/validation_error，含 changed_fields 与 diagnostic |
| 4.1-7 | 部分实现 | src/content/page-grounding.ts:827-830、:793-800 | src/content/page-grounding.test.mjs:34（reports a click only after the synchronous click completes）、:51（SVG promote） | 判据：点击回执后置且 SVG 不静默跳过。回执后置与禁用拦截已达成；SVG 走提升到可激活祖先再 click，未按契约派发合成 click 事件（同 G2） |
| 4.1-8 | 已实现 | src/content/page-grounding.ts:827-830、:1178-1181 | test/scenarios.test.mjs:114（S5/G1/G3: mousedown-only menu opens and preventDefault preserves focus） | 判据：焦点礼仪。click 路径不调 focus()；focus 是独立动作 |
| 4.1-9 | 已实现 | src/background/frame-routing.ts（qualifyRef/routeFrameRef/frameSnapshotId） | test/scenarios.test.mjs:142（S5/G5/H2: cross-origin iframe refs are frame-qualified and route to the exact frame） | 判据：跨源 iframe 可定位。ref 形如 e5@f2，子框架换用 tab 级 snapshotId |
| 4.1-10 | 已实现 | mcp-server/bridge-lock.js、mcp-server/bridge-daemon.js | mcp-server/test/lifecycle.mjs:221-271,274-287 | 判据：桥可单实例、可重启、在途命令不干等。O_EXCL 抢锁 + 30s mtime 自愈 + failInFlight |
| 4.1-11 | 已实现 | src/functions/fetch-url.ts:114-117、src/functions/page-viewer.ts:74-82 | mcp-server/test/acceptance.mjs:176-182（4.1-11: data.fetch takes the main frame on a page with a cross-origin iframe） | 判据：取数取主 frame。`__parse_page_content` 必须钉 `frameId: 0`，否则 Chrome 广播到该 tab 的所有 frame，iframe 抢先响应（详见规格 §8.6 缺陷 4） |
| 4.1-12 | 已实现 | mcp-server/status-tool.js:19、mcp-server/policy.js:31、src/background/mcp-bridge.ts:1261 | mcp-server/test/acceptance.mjs:184-190（4.1-12，真机 acknowledged=true tabId=1072285652） | 判据：status 更新走扩展能力，不被 daemon 的 `status.*` 命名空间拦下。原 `status.update` 与 daemon 自有命名空间冲突，改名 `page.status_update`（`page.` 是标签页作用域能力族，且该能力确实要求 task 拥有的 tab lease）。**注意**：改 `policy.js` 的 CAPABILITIES 表后必须重启 daemon，旧表在内存里继续生效 |
| 4.1-13 | 已实现 | src/content/page-grounding.ts:204-213,222 | mcp-server/test/acceptance.mjs:192-206（4.1-13，真机 A={sel:true,cls:"tab is-active"} B=false C=undefined） | 判据：G11 的 aria-selected 三态与 class 状态在真机快照里可读 |
| 4.1-14 | 已实现 | src/content/page-grounding.ts:595-603,668-670 | mcp-server/test/acceptance.mjs:208-221（4.1-14，真机 glyphFolded=true buttonKept=true weakKept=true inputKept=true labelFolded=true） | 判据：G15 的嵌套装饰折叠与弱候选保留在真机快照里成立 |
| 4.1-15 | 已实现 | src/background/mcp-interaction.ts:182-207 | mcp-server/test/acceptance.mjs:223-240（4.1-15，真机 wheel=1，边界余量 x=0 y=0） | 判据：G13 的滚动补发 wheel 与三因诊断在真机成立。靶场 `#scroll-box` 的 wheel 计数器由合成事件驱动，故后台标签页也能计数 |

## 4.2 靶场用例最小集（6 类 fixture）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| 4.2-1 | 已实现 | test/fixtures/playground.html | test/scenarios.test.mjs:52（S1/S2: local fixture host serves every required fixture class） | 主靶场：九事件序列 / SVG / shadow DOM / 敏感目标 / 迟到校验 / 漂移 |
| 4.2-2 | 已实现 | test/fixtures/creds.html | test/scenarios.test.mjs:294（S5/credentials） | 凭据页：快照与效果证据掩码 |
| 4.2-3 | 已实现 | test/fixtures/csp.html | test/scenarios.test.mjs:285（S5/CSP and eval policy） | CSP 页：受限页内 eval 策略 |
| 4.2-4 | 已实现 | test/fixtures/frame-inner.html | test/scenarios.test.mjs:142（S5/G5/H2 cross-origin iframe） | 跨源 iframe 内页 |
| 4.2-5 | 已实现 | test/fixtures/newtab.html、test/fixtures/newtab-child.html | test/scenarios.test.mjs:312（S5/new-tabs: local child opened by the fixture is observable and follows its opener） | 新标签页与子页：新 tab 跟随与归属 |
| 4.2-6 | 已实现 | test/fixtures/flow.html | test/scenarios.test.mjs:174（S5 per-tool round trip） | 流程页：逐工具往返 |
## 7.1-7.4 待明确事项（Q1-Q16）

| 需求ID | 状态 | 落点(file:line) | 证据 | 备注 |
|---|---|---|---|---|
| Q1 | 已实现 | mcp-server/catalog.js:76-82,95-96、mcp-server/install.js:107-124 | mcp-server/test/install.mjs:28（loopback onboarding hands the extension URL to the address bar and accepts only the manifest-derived id） | 拍板：默认保留白名单 + install 自举。extensionIds 取自 ACTSPAN_EXTENSION_IDS，缺失时 pairingRequired:true 而非报错；pairExtension 起 127.0.0.1 随机端口 + nonce 回传 ID |
| Q2 | 部分实现 | mcp-server/policy.js:13、src/background/policy-executor.ts:11、src/background/mcp-bridge.ts:868-880 | test/scenarios.test.mjs:285（S5/CSP and eval policy） | 拍板：纳入 policy 且默认关闭。纳入 policy 已达成（page.eval 三处均为 dangerous）；但全仓无 allow_eval 之类配置键，默认关闭没有可配置的开关面 |
| Q3 | 部分实现 | mcp-server/bridge.js:45,456-500 | mcp-server/test/lifecycle.mjs:221-271 | 拍板：审计保留期与轮转。已达成：audit.jsonl 记 host/sessionId/tabId/工具/脱敏参数/效果摘要/时间，2048 字节行上限，0o600，路径 ~/.actspan/audit.jsonl。未达成：不记 URL host+path，无 30 天 / 50MB 轮转，无 clear 命令 |
| Q4 | 已实现 | src/functions/risk-detect.ts:1-56 | src/functions/risk-detect.test.mjs:23（读取漂移按 session 去重且自导航不告警） | 拍板：挑战信息默认纯本地。risk-detect 是纯本地纯函数，无任何上传路径 |
| Q5 | 已实现 | test/browser-fixtures.mjs:88-118 | test/browser-fixtures.mjs:110（Attach to an already-running Chrome only. This helper never launches Chrome.） | 拍板：引入 Playwright 只用于 test/scenarios。已引入，且按仓库规则改为复用用户已开 Chrome 的 CDP（connectOverCDP），不自行起浏览器 |
| Q6 | 已实现 | mcp-server/act-tool.js、mcp-server/act-script.js、mcp-server/catalog.js:29 | mcp-server/test/act-tool.mjs:49-54、mcp-server/test/act-script.mjs:112-116、test/scenarios.test.mjs:249 | 拍板：act DSL 不进本轮。实际已全部落地（actspan_act / actspan_adopt 已注册并有测试），规格的「不进本轮」已过时 |
| Q7 | 已实现 | mcp-server/bridge-daemon.js、mcp-server/bridge-lock.js、src/offscreen/mcp.html、src/offscreen/mcp-transport.ts | src/offscreen/mcp-transport.test.mjs:72,104、mcp-server/test/bridge-lock.mjs:77-81 | 拍板：E1 先做，E10 排后。两者都已落地，E1 的锁与守护进程先于 E10 的 offscreen socket |
| Q8 | 不适用 | docs/spec/actspan-superset-spec.md:447 | 无（人力与时间窗是人的决策，不产生代码落点） | 拍板：按本轮建议范围执行。属流程决策，本表不评代码状态 |
| Q9 | 部分实现 | mcp-server/install.js:63 | mcp-server/test/install.mjs:121-123（discoverConfigs 去重与备份） | 拍板：npm 发布。双运行模式已实现（win32 走 npx.cmd，其余走 npx；本地走 process.execPath + index.js）；但仓库内无发布状态证据（package.json 无 publish 记录），发布与否无法从代码判定 |
| Q10 | 已实现 | src/ai/loop-config.ts:21,129、src/ai/core-loop.ts:420,443,503,861 | src/ai/core-loop.test.mjs:68-72（task deadline E_TIMEOUT） | 拍板：任务级墙钟预算。taskDeadlineMs 默认 10 * 60 * 1000，到期 emit E_TIMEOUT 且文案说明已停止当前任务 |
| Q11 | 已实现 | src/ai/orchestrator.ts:144-145、src/functions/tool-tiers.ts:65、src/functions/load-tools.ts:40 | src/functions/tool-tiers.ts:65（Tool schemas are already available; load_tools is a legacy compatibility command） | 拍板：工具改常驻。allTools = [...tools] 全量常驻，load_tools 保留为兼容命令并回 already_available: true |
| Q12 | 部分实现 | src/content/float-ball/ActspanRoot.tsx:55-80、src/content/float-ball/status-state.ts | src/content/float-ball/status-state.test.mjs:27（active false and empty text return the cockpit to idle, not to a sticky last status） | 拍板：保留推断文案并修粘住。已达成：推断文案保留（ActspanRoot.tsx:78-79 回落到 liveStatusText，否则 仍在处理…），粘住已修（nextStatusState 在 active:false/text: 清空）。未达成：无 3 秒「仍在处理…」超时计时器之外的降级策略说明，ActspanRoot.tsx:69 的 3000ms 只用于 fallbackStale 标记，未与状态机合流 |
| Q13 | 已实现 | mcp-server/catalog.js:13-49 | mcp-server/test/catalog.mjs:68（MCP advertises all externally registered Actspan tools, without aliases） | 拍板：工具命名只增不改。TOOL_NAMES 全部 actspan_ 前缀，actspan_page_read 等旧名保留 |
| Q14 | 未实现 | src/ai/llm-client.ts:20,106,185 | src/ai/llm-client.ts:20（strictResultMode: true，全仓仅 types.ts:178 声明，无读取方） | 拍板：模型路由。strictResultMode 已设但无人读；max_output_tokens 在 :106,185 硬编码 16384；User-Agent 在 :127,207 硬编码 claude-code/1.0.0。可配置路由面未实现 |
| Q15 | 未实现 | src/functions/builtin-experience.ts:18-20,42-45 | src/functions/builtin-experience.ts:42-45（BUILTIN_SITE_EXPERIENCE = { version: 1, domains: {} }） | 拍板：取用 huashu 23 份站点笔记作出厂内容。出厂层 domains 为空对象；:18-20 BUILTIN_EXPERIENCE_SOURCE 已记录 upstream/license/requirement 出处字段，但无任何站点条目入库 |
| Q16 | 未实现 | test/scenarios.test.mjs:13,62-66 | test/scenarios.test.mjs:62（S5: MCP advertises all externally registered Actspan tools, without aliases） | 拍板：每个工具必须有靶场用例才进工具表，并在 CI 加检查。已达成一半：:62-66 断言 [...mcp.tools.keys()] 与 TOOL_NAMES 完全一致且每个可 requireTool。未达成：无任何断言检查每个工具名在 test/scenarios 的用例体内出现至少一次；且 package.json:25 的 npm test 不含 test/scenarios.test.mjs |

## 汇总

- 总行数：189
- 已实现：155
- 部分实现：30
- 未实现：3
- 不适用：1

> 2026-10-20 订正 3 行（A4、E6、C0）：三者的代码存在、原判「已实现」，但模拟用户全量测试证明其在真机上不成立（注入参数含 `undefined` 致 5 个交互动作 100% 失败；双调试器管理器互踩致点击后 5 秒内调试器操作全失败；页面侧抛错被跨层吞成 `null`）。三处均已修复并补回归测试，状态计数不变。详见本表开头「证据可信度分级」与规格 §8.5。
>
> 2026-10-20 再订正 2 行（P0-4、H9）：`elementHandleMap` 强引用泄漏已修——清理点从「ref 被再次访问时惰性删」改为在 `getOrCreateElementHandle` 里摊还清理已脱离文档的句柄（同时删 `elementHandleSnapshotMap`）。计数 146→148 已实现、8→6 未实现。证据：`src/content/page-grounding.test.mjs:258`，并已用「关掉剪枝则该测试必红」做反向验证。

### 未实现（3 条）

| 需求ID | 缺口 |
|---|---|
| Q14 | strictResultMode 无人读；max_output_tokens 与 User-Agent 硬编码，无模型路由面 |
| Q15 | BUILTIN_SITE_EXPERIENCE.domains 为空，23 份站点笔记未入库 |
| Q16 | 无「每个 TOOL_NAMES 项必须在 test/scenarios 用例体内出现」的 CI 检查 |

### 部分实现（30 条）

P0-3、G1、G2、G7、G10、G12、G14、C1、C2、C3、D10、D11、D12、F1、N10、S5、WP0、WP1、WP2、WP3、WP5、WP8、WP12、WP15、4.1-3、4.1-7、Q2、Q3、Q9、Q12
