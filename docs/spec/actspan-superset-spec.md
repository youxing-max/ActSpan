# ActSpan 能力补全规格

对标项目：`alchaincyf/huashu-chrome`（MIT，master @ 2026-10-13，351★）
本文档日期：2026-10-19　　状态：**已实施**（2026-10-20 收口，逐条落地状态见 `actspan-gap-matrix.md`）
目标：使 huashu-chrome 的能力成为 ActSpan 的**子集**，同时保留 ActSpan 的更高上限（双脑 / Skill Registry / 扩展内 Agentic Loop）。

> **落地结果速览（2026-10-20）**：189 条需求 → 已实现 155、部分实现 30、未实现 3、不适用 1。
> §4.1 的 15 条当场可跑判据在真实 Chrome 上 **17/17 通过**（含 1 条 `tab.open` 前置步骤）。
> 未实现项与规格正文的过期表述集中在 **§8**。

---

## 0. 判定标准与证据分级

### 0.1 「子集」的三条可验证判定

| # | 判定 | 含义 |
|---|---|---|
| ① | **可达性** | huashu 的每个能力，在 ActSpan 的两个入口都能调到：外部 agent 的 MCP 直调 / 扩展内 Loop |
| ② | **同层保证** | 每条保证落在**工具层**，不落在 prompt 层。MCP 调用方的 prompt 我们控制不了，写进 system prompt 的保证在 MCP 模式下等于零 |
| ③ | **可当场验** | 每条都有一条能跑的检查，不靠叙述 |

### 0.2 证据分级（本文所有结论都带级别）

| 级别 | 含义 |
|---|---|
| **A 我方源码实证** | 读过 `e42f68d7/mole-extension` 源码，带 file:line |
| **B 对方源码/测试实证** | 读过 huashu 的 `src/`、`extension/`、`test/`，测试名即契约 |
| **C 对方自报实测** | 只出现在其 README/docs 里的数字，**我方无环境复现，不为其背书** |
| **D 未验证** | 只确认了代码存在性，未确认行为，需实测 |

C 级数字清单（引用时必须注明出处）：连接中位存活 106 秒 / 一夜 111 次断连（SW 30s 空闲回收）/ 98% 墙钟花在命令间的模型推理 / 单轮 ~20s 降到 2–4s / 后台 tab 递送 9 个 mouse 事件 isTrusted 全 true / B 站 19 次调用取回 186 个稿件 / base64 通道上限 12MB、拖放上限 48MB。

---

## 1. 现状基线与本轮订正

### 1.1 订正记录（推翻本文档之前几轮的三个结论）

| # | 早先结论 | 实测订正 | 级别 |
|---|---|---|---|
| R1 | 「`llm-client.ts` 的 fetch 无超时，是 20 分钟卡死的根因」 | **错。** `src/ai/deadline.ts:1-2` 有 `DEFAULT_LLM_IDLE_TIMEOUT_MS = 60_000`、`DEFAULT_LLM_TOTAL_TIMEOUT_MS = 5*60_000`；`llm-client.ts:120`（非流式）与 `:199`（流式总闸）+ `:227`（每次 `reader.read()` 单独套 idle 闸并 `Promise.race`）都已生效。**20 分钟不是单次挂死，是多轮累积** | A |
| R2 | 「SSE 不处理 `data: [DONE]`」 | **错。** `llm-client.ts:251-252` 已处理 `[DONE]`。但 `:253-258` 只认 `response.output_text.delta` / `response.output_item.done` / `response.completed\|done` 四种 `json.type`，**其它形状（含 Chat-Completions 的 `choices[0].delta.content`）静默丢弃**，表现为「请求成功、无输出、无报错」，然后进入下一轮 | A |
| R3 | 「ref 编号不稳定，H 组要从头做 11 项」 | **过度悲观。** `page-grounding.ts:317-332` 的 `getOrCreateElementHandle` 用 `elementToHandleMap`(WeakMap，`:110`) + 单调 `handleSeq`(`:323`)。**跨快照稳定、新元素不抢号这两条已实现**。H 组只剩 6 项 | A |

**R1 的意义**：病因从「一次无限等待」改判为「预算模型缺一层」。现有预算是**单次 LLM 调用**（5min）+ **轮数/工具调用数**（`core-loop.ts:391-401`、`:486-503`），**没有任务级墙钟**。20–40 轮 × 每轮 20–60s = 20 分钟，在现有预算下是「合法行为」，而且 `:486-503` 的收尾文案明确要求「不要提及轮数、工具限制等内部概念」——所以用户看不到任何异常。→ 需求 **V1**。

### 1.2 新发现的 P0（比 R1 更严重）

**P0-3　合成点击是「先报成功，后执行」，且对 SVG 静默跳过。** A

`src/content/page-grounding.ts` 的 `case 'click'`（约 `:679-692`）：

```ts
sendResponse?.({ success: true, data: { ...buildActionInfo(target), message: '已触发目标元素点击' } });
window.setTimeout(() => { try { htmlTarget.click?.(); } catch { /* ignore */ } }, 0);
```

三处叠加：
1. **回执在动作之前发出** —— `success:true` 与「已触发」在点击发生前就返回了，`try/catch` 吞掉一切异常。这是**结构性假成功**，不是边界情况。
2. **`click?.()` 可选链** —— `<svg>`/`<path>` 没有 `click()` 方法 → 静默什么都不做。而图标按钮的最内层几乎总是 `<svg>`。huashu 的场景测试把这条写成了断言：*「图标按钮点得动 —— SVG 元素没有 click() 方法」*（B）。其正解：派发合成 `click` 事件（规范上会在事件目标最近的可激活祖先上执行激活行为）。
3. **`page-skeleton` 已过滤 SVG 内部元素**（`page-grounding.ts:486-487` 只保留 `svg` 根），所以候选里必然出现 svg 根 → 命中 2。

**后果链**：图标按钮点了没反应 → 报成功 → agent 认为已完成 → 后续步骤建立在错误前提上 → 最终 review 说「无法证实」。**这正是用户反馈里那份「审查未通过」的成因之一。**

**P0-4　`elementHandleMap` 是强引用 Map。** A（`page-grounding.ts:64`）
`new Map<string, Element>()` 持有 Element → 页面卸载后 DOM 子树无法回收，长会话内存单调增长。`elementToHandleMap` 是 WeakMap（`:65`）没问题，反向表才是泄漏源。→ 需求 **H9**。

**P0-5　`HANDLE_PREFIX` 每次内容脚本实例化都变。** A（`page-grounding.ts:62`，`Date.now()+random`）
ref 在**同一次注入内**跨快照稳定，但页面 reload / 内容脚本重注入后全部失效，而**失效无法被检测**（旧 ref 仍可解析到已脱离文档的 Element）。huashu 用 `ref + snapshotId` 配对解决：*「结构变化之后 ref 作废，act 明确指路 find」*。→ 需求 **H2**。

### 1.3 我方已有、只是没接过去的能力（成本远低于新建）

| 能力 | 已有实现 | 缺口 | 级别 |
|---|---|---|---|
| 真实事件（绕过 isTrusted 检测） | `functions/cdp-input.ts`（`Input.dispatchMouseEvent` ×9 处） | 调用方仅 `page-repair.ts`/`registry.ts`/`resident-runtime.ts`；**MCP 路径 `mcp-bridge.ts:533-563` 仍是 `el.dispatchEvent` 合成事件** | A |
| 数据层 | `cdp-network.ts` `cdp-fetch.ts` `fetch-url.ts` `download-file.ts` `extract-data.ts` `data-pipeline.ts` | **`mcp-server/catalog.js:12` 的 17 个工具里一个都没暴露** | A |
| 弹窗接管 | `cdp-dialog.ts` | 未验是否覆盖「后台 tab 原生 confirm 被浏览器抑制」 | D |
| 跨框架 | `cdp-frame.ts`、`content/page-skeleton.ts`、`cdp-dom.ts` 均含 frame 处理 | 未验跨源 iframe 是否进快照、ref 是否带 `@fN` 归属 | D |
| 响应关联 | `mcp-server/bridge.js:145-147` 六元组校验（socket+clientId+requestId+taskId+sessionId+tabId） | **比对方严，整改中不得弱化**（对方曾踩「pending 只按消息 id 索引，各 agent 进程 id 都从 c1 开始 → 响应串号」的坑，B） | A |
| 诊断分层 | `mcp-server/index.js:72-92` `hub_listening` + 双分支 hint | 比对方细，保留 | A |
| 元素句柄 / CSS 兜底 | `getOrCreateElementHandle`、`buildSelectorCandidates`（`page-grounding.ts:246-`，含 `data-testid`/`data-test` 等） | 见 H 组 | A |
| 禁用态拦截 | `page-grounding.ts` `isElementDisabled` → 「目标元素处于禁用状态，无法点击」 | 已对齐对方断言，补「快照里标 disabled」 | A |
| React 受控输入 | `fill` 走 `setNativeInputValue` + `input` 事件 | 对齐 | A |
| 站点经验脚手架 | `functions/site-experience.ts` + `domainGuides` | 缺内容、两层存储、日期标注、反污染 | A |
| 工作流录制 | `background/workflow-recorder.ts` + `functions/save-workflow.ts` | 缺「从成功运行自动长草稿」「输入换占位符」「留底」 | A |

### 1.4 对方的工具面（B 级，`src/mcp-server.js:49` TOOLS，共 24 个）

```
snapshot navigate click type select fill key read_text screenshot tabs wait
network fetch scroll download upload query act ask status eval learnings reload
```

分层依据（`docs/能力模型.md`）：**「网页只有三种信息载体，没有第四种」**

| 层 | 载体 | 工具 | 什么时候用 |
|---|---|---|---|
| 操作层 | DOM | snapshot click type select fill key navigate scroll | 要**做事** |
| 数据层 | 网络 | network fetch query download upload | 要**拿数据** |
| 兜底层 | 像素 | screenshot eval | 前两层都失效 |
| 会话/元 | — | tabs wait ask status learnings reload | 归属、同步、交人、告知、记忆 |
| 复合 | — | act | 默认出牌方式 |

> **「最容易犯的错是拿操作层去干数据层的活。」** 对方实测代价（B）：小红书笔记页 DOM 里五个数字糊成 `123.68万214560420187309160`，按常识猜「观看/点赞/收藏/评论/分享」，接口真实顺序是「观看/**评论**/**点赞**/**收藏**/分享」——**按常识猜必错，且错得悄无声息，报告照样能写出来**。

---

## 2. 需求规格

图例：落点＝ActSpan 文件；依赖＝前置需求 ID；量级＝估算行数。

### G. 接地保真（DOM grounding）

| ID | 需求 | 契约与验收判据 | 落点 | 依赖 | 量级 |
|---|---|---|---|---|---|
| G1 | 合成点击发**完整事件序列** | `pointerover → mouseover → mousemove → pointerdown → mousedown → focus → pointerup → mouseup → click`。验收：只监听 `mousedown` 的自定义下拉能被打开（B 级靶场用例） | `content/page-grounding.ts` | — | 40 |
| G2 | **SVG 图标按钮可点** | 无 `click()` 方法时派发合成 `click` 事件（由规范在最近可激活祖先上执行激活行为），**不得静默跳过、不得吞异常**。验收：`<a><svg>` 内层触发跳转；返回体带实际命中的元素描述 | 同上 | P0-3 | 25 |
| G3 | **焦点礼仪** | 浏览器规则：`mousedown` 未被 `preventDefault` 才移动焦点。工具**不得无条件 `focus()`**，否则自管焦点的组件（react-select 等）菜单永远打不开 | 同上 | G1 | 15 |
| G4 | shadow DOM 控件进快照且可点 | 验收：`test/fixtures/playground.html` 内 shadow 按钮出现在快照并可点击 | `content/page-skeleton.ts`、`page-grounding.ts` | — | 40 |
| G5 | 跨源 iframe 注入 + ref 路由 | 注入 `allFrames:true`；子框架元素 ref 写成 `e5@f2`；桥接层按后缀路由、还原 ref、**换上该框架自己的 snapshotId**。契约：**agent 面对的协议不变**（content script 不知道框架存在）。验收：跨源 iframe 内元素进快照且可操作 | `cdp-frame.ts`、`content/page-skeleton.ts`、`mcp-bridge.ts` | H2 | 90 |
| G6 | `file` 角色不被归为 textbox | 静默陷阱：agent 见 textbox 就 type，往 file input 写字符串什么都不发生。验收：快照中 `input[type=file]` 标 `file` | `content/page-skeleton.ts` | — | 10 |
| G7 | **无 `for` 关联**也能给字段命名 | 覆盖两类：标签与输入框同处 `.form-group`；react-select 用 `aria-describedby` 指占位符 div。验收：demoqa 风格注册表每个字段都有正确名字 | 同上 | — | 35 |
| G8 | `query` 的 value 取**当前值**，非 HTML 初始值 | React 受控组件坑。验收：受控 input 改值后 `@value` 返回新值 | `functions/extract-data.ts` | — | 15 |
| G9 | disabled 元素进快照并标注 | 点它时**说清原因**（现有文案已具备，补快照标注） | `content/page-skeleton.ts` | — | 10 |
| G10 | **视口外**仍有可交互元素时快照要说明 | 否则 agent 以为页面就这么大 | 同上 | — | 15 |
| G11 | **已实现**（2026-10-20）`aria-selected` / class 表达的状态进快照 | 状态可读性。验收：真机快照里 `aria-selected` 呈 `true` / `false` / `undefined` 三态；class 必须用 `getAttribute('class')` 读——SVG 元素的 `className` 是 `SVGAnimatedString` 对象，直接截断会得到 `"[object SVGAnimatedString]"` | 同上 | — | 20 |
| G12 | **迟到的校验错误顶到快照最前** | 上下文排序：最重要的放最前 | 同上 | C1 | 20 |
| G13 | **已实现**（2026-10-20）**后台标签页不产帧**的兜底 | 实测根因：scroll 事件在帧生命周期派发，后台 tab 不产帧 → `scrollTop` 改了但事件计数 0（C）。解法：改完 `scrollTop` 后向真正被滚动的元素补发合成 `wheel`（`bubbles` + `cancelable`，`deltaMode: 0`）。**兜不住的要明说**：`changed:false` 时把三种可能并列报出——① 不可滚动（带**剩余**余量）② 需焦点并指向 `focus:true`（代价：打断用户）③ 懒加载需 `IntersectionObserver` 回调。余量必须是「还能滚多少」（`scrollHeight - clientHeight - |scrollTop|`）：报总量会让已到边界的调用方误判成还能滚 | `src/background/mcp-interaction.ts` | — | 45 |
| G14 | 硬边界识别并**交还用户** | 四类：系统文件/保存对话框、浏览器原生 UI（下载栏、地址栏下拉、权限弹窗）、`chrome://` 与商店页、系统授权窗口。契约：**识别出来，明确说「这一步需要你点一下」，不要反复重试**。产品缓解：引导用户在 Chrome 设置里关掉「下载前询问保存位置」 | `functions/request-confirmation.ts` + 新分类 | I1 | 40 |
| G15 | **已实现**（2026-10-20）快照去重：同一可点区域不算两次 | `<button>` 内的 `<i class="fa">` 靠 `cursor:pointer` 混成第二候选，`<label for>` 又是输入框代言人——它们给 agent 提供**点了不管用的选项**。但要区分「弱候选」：带 `onclick`/`tabindex` 的嵌套元素可能是独立操作（卡片上的「×」），丢了就没了。验收：登录页元素数下降且名字一个不少 | `content/page-skeleton.ts` | — | 45 |

### H. 元素编号（ref）生命周期

| ID | 需求 | 契约与验收判据 | 落点 | 依赖 | 量级 |
|---|---|---|---|---|---|
| H1 | 跨快照编号稳定 | **已实现**（`getOrCreateElementHandle`）。补回归测试锁住 | `test/` | — | 20 |
| H2 | **失效可检测**：ref 必须带 snapshotId | 参数契约 `ref` + `snapshotId`；快照换代后旧 ref 报错并**指路 find**。解决 P0-5（reload 后 `HANDLE_PREFIX` 变而旧 ref 仍可解析到脱离文档的 Element） | `page-grounding.ts`、`page-skeleton.ts` | — | 40 |
| H3 | 元素还在但**内容被换掉**时拦住旧编号 | 句柄登记时记录内容指纹（tag+role+文本哈希），不一致则拒绝并说明 | 同上 | H2 | 30 |
| H4 | 新元素不抢老编号 | **已实现**（单调 `handleSeq`）。补测试 | `test/` | — | 10 |
| H5 | `ref` 与 `selector` **同时传要报错** | 不得静默只用一个 | `page-grounding.ts` | — | 8 |
| H6 | `find`：按 role+name 定位，**不依赖快照** | 验收：无快照也能操作 | 同上 | — | 50 |
| H7 | `find` 多命中**报错并列候选，绝不猜**；精确匹配优先 | 反例锁定：「删除」不得误伤「删除全部」。支持 `nth`（0-based） | 同上 | H6 | 30 |
| H8 | `find` 空结果时**列出页面上有什么** | 空结果也要给信息 | 同上 | H6 | 20 |
| H9 | 修 `elementHandleMap` 强引用泄漏 | 改 `WeakRef` 或按文档卸载清理。验收：导航 50 次后堆不单调增长 | `page-grounding.ts:64` | — | 20 |

### C. 诚实度（效果证据）

| ID | 需求 | 契约与验收判据 | 落点 | 依赖 | 量级 |
|---|---|---|---|---|---|
| **C0** | **先执行，后回执**（修 P0-3） | 任何写操作不得在动作发生前返回 `success:true`；不得 `try{}catch{/*ignore*/}` 吞异常 | `content/page-grounding.ts` | — | 20 |
| C1 | 写操作返回**效果证据**，11 条子判据（对方场景测试逐条为契约，B） | ① 有反应时效果写在返回**最前面**；② 毫无反应时**明确报出来**，而不是回一份看着正常的快照；③ **只发请求不改页面的点击：报出请求，不判「没反应」，也不自动再点一次**；④ 焦点落到目标自己身上**不算**「页面有反应」；⑤ 表单校验错误进入效果证据，**不会被当成提交成功**；⑥ 页面自己在动时，不把别处变化算成本次战果（动画/轮询去噪）；⑦ 点击使隐藏区块显示出来**算**有效；⑧ `fill` 的证据落在**字段上**，不再谎报「没有反应」；⑨ 回执印出**实际命中的元素**，点错了下一轮自曝；⑩ **密码框的值不进效果证据**（那句话要写进上下文）；⑪ 只采信**目标附近**的证据，**拒绝用全局文本长度**（对方称其为「页面里最脏的信号」），命中即早停、不做定长等待 | `page-grounding.ts`、`page.ts`、`page-assert.ts` | C0 | 130 |
| C2 | 自带诊断信息（**规则级**） | 对方原文：*「能力必须自带诊断信息——这条比上面三条都重要。工具失败时只说「失败了」，agent 就会开始撞运气；说清「我滚了 div.content，高度没变」，它才能换策略。」* 契约：每个工具失败时必须返回「我做了什么 + 观测到什么 + 下一步建议」，禁止只返回「失败」 | 全部工具 | C1 | 60 |
| C3 | `expect` 参数 | 每个动作可带预期结果，在 settle 窗口内校验，未达成即报告（`act` 内 unmet = stop） | `page-grounding.ts`、`act` | C1 | 40 |

### A. 执行层

| ID | 需求 | 契约 | 落点 | 依赖 | 量级 |
|---|---|---|---|---|---|
| A1 | **MCP 路径复用 `cdp-input`** | `mcp-bridge.ts` 的 `page.click`/`page.type` 改为优先真实事件，合成事件降级为兜底 | `background/mcp-bridge.ts:533-563` | G1 | 50 |
| A2 | 无效果时**自动升级**为真实事件 | 契约：`Automatic on no-effect, except for submit/pay/delete`。**敏感文案的目标不自动升级**（避免重复执行）；显式传 `real:true` 时照做（逃生阀，但必须显式且**记入审计**） | `cdp-input.ts`、`policy-executor.ts` | C1 | 45 |
| A3 | 原生 `<select>` **强制走 L1**，不升级为真实事件 | 对方硬边界，需原样保留 | 同上 | A2 | 10 |
| A4 | 补齐 `select` / `upload` / `key` / `wait` / `scroll` 五个工具 | `key`：支持一次传数组按一串、`repeat` 上限 50、补默认行为（Tab 移焦点、Enter 触发点击）、可先 focus 指定 ref；`upload`：**`DataTransfer` 是唯一的路**（网页只认「用户选了文件」这个事件，系统对话框扩展够不着），造 `File` 塞进 `input.files` 再触发 change，属 L1 不需要 debugger；无 file input 时支持拖放 `dropSelector`；`wait`：`for` ∈ selector/text/idle | `functions/` 新增 5 个 + `catalog.js` | G1 | 180 |

### B. 数据层

| ID | 需求 | 契约 | 落点 | 依赖 | 量级 |
|---|---|---|---|---|---|
| B1 | `network` 上 MCP 面 | 描述必须含：**「START HERE when you need DATA rather than an action」**、**「Never guess an endpoint name from memory — list first, pick by response size」**（对方实测：X 的时间线接口叫 `UserOriginalsTimeline` 不叫 `UserTweets`，按记忆猜得到 0 字节和一串解析失败，真接口就在同一列表里躺着 243KB） | `catalog.js`、`mcp-bridge.ts` | — | 30 |
| B2 | `network` 的 `index` 回溯 | 分页接口只差一个 cursor，默认只给最后一条 = 只拿到最后一批。`index` 从最新往回数逐批取 | 同上 | B1 | 25 |
| B3 | `network` 的 `reload:true` | net-hook 走 `document_start`，页面刚打开没记录时刷一次才能抓到首屏 XHR | `cdp-network.ts` | B1 | 20 |
| B4 | **分页原语** | 两种模式：页码型（递增 param，空体即停）/ 游标型（从响应按路径取 cursor，空即停）。**四种停止原因各自说明**：和上一页一模一样 / 非 2xx / 跑满 max / 正常结束。`savePath` 时每页一行 JSON 落盘，**回执只有摘要 + 第一页预览**（省上下文，直击刷快照问题）。没给 param 也没给 cursorParam **直接报错，不瞎猜** | `functions/cdp-fetch.ts` 或新 `paginate.ts` | B1 | 90 |
| B5 | **核对响应里的分页字段，别信自己传的值** | 对方实测：传 `ps=100`，响应 `page:{"ps":10,"count":186}` ——服务端静默降级。写进工具描述 | 同上 | B4 | 5 |
| B6 | 二进制两条路按大小分 | `fetch binary` 走 base64 over WS（上限见 C 级自报 12MB），可精确指定落盘路径；`download` 走 `chrome.downloads`，无大小限制，且 `saveAs:false` **不弹系统保存对话框**（正好绕开 G14 那条硬边界）。超限明确报错并**指向 download** | `fetch-url.ts`、`download-file.ts` | — | 35 |
| B7 | **跨域二进制必须从扩展侧发** | 图片常在另一域（公众号正文 `mp.weixin.qq.com`、图在 `mmbiz.qpic.cn`），页面上下文 fetch 被 CORS 挡死；扩展有 `host_permissions`。`binary` 默认走扩展，少数认 Referer 的图床才 `via:"page"` | `fetch-url.ts` | — | 20 |
| B8 | 懒加载图片真地址在 `data-src` | `src` 是 1px 透明占位符；不取 `data-src`，导出的 markdown 每张图都是同一个像素 | `extract-data.ts` | — | 10 |
| B9 | 三条取数路线写进描述（决策树） | A `fetch` 改参数（最快，先试）→ B **UI 驱动 + network 读响应**（最普适：任何自造请求 406、签名是网关级、`x-s`/`x-t` 由页面 JS 生成时，**不跟签名斗**：点「第 2 页」让页面自己发带签名请求，agent 只管点和读，**这个模式对所有网站都成立**）→ C **换数据入口**（同一份数据站内常有多个入口，接口干净程度差很多；**在一个入口死磕之前，先花一次调用看看有没有更好的门**） | 工具描述 + `system-prompt` | B1 | 15 |

### D. 安全

> ⚠️ **2026-10-23 superseded**：审批门已整体移除，见 `docs/spec/actspan-free-mode-spec.md`。下表 D1/D2 的「拦截/确认」契约不再适用；`page.eval` 仍受 V8 `throwOnSideEffect` 约束。

| ID | 需求 | 契约 | 落点 | 依赖 | 量级 |
|---|---|---|---|---|---|
| **D1** | **`page.eval` 纳入 policy**（当前结构性漏洞） | `mcp-bridge.ts:503` 的 `page.eval` 走 `Runtime.evaluate` + `userGesture:true`，只校验 tab 归属，**外部 agent 可在页面内执行任意 JS 触发提交，绕过所有 click 层确认门**。必须拦 capture-phase 的合成 `MouseEvent` 派发与支付类点击；**同时不得影响普通 eval**（对方断言：「这道防线不碰普通的 eval」） | `mcp-bridge.ts`、`policy-executor.ts` | — | 70 |
| D2 | 支付/敏感分类拦截 | 明确支付按钮 → 拦，无确认不执行；**通用文案 + 附近有金额 → 同样拦**；**金额带进拒绝理由**（agent 要知道自己拦在什么上）；普通「确认」→ **不弹窗照常点**（防弹窗疲劳）；删除类敏感动作 → **不弹支付确认**（分类不同，不乱升级）。闸门必须**活在扩展里，agent 侧没有 skip 参数**；批量 `act` 里通过 `allowSensitive` 显式开且**写入审计** | `policy-executor.ts`、`request-confirmation.ts` | D1 | 90 |
| D3 | 递归按 key 脱敏 | **按 key 名递归匹配，不按固定路径**——因为 `act` 把 input 嵌在 `steps[]` 里，对方踩过：*「两个坑都是同一个模式：脱敏做在一条路上，另一条敞着。」* 覆盖：顶层 `text`、`fill.fields`、`act.steps[].text`、任意层嵌套 | 新 `functions/redact.ts` | — | 70 |
| D4 | 凭据成组识别 | ≥3 行「够长 + 字母数字混合」的行视为一组隐去；**空行隔开的恢复码照样算成组**（对方注明「这正是当年归零的那个 bug」）；单个长串不隐（常是 ID/hash）；**git commit hash 这类孤立长串不受影响**；同页两组分开凭据各算各的；隐去后**前后正文与排版仍在** | 同上 | D3 | 55 |
| D5 | **凭据页在 URL 层就被认出来** | 认出来则整页读取降级为掩码，并附带告诫（对方：「凭据页面上带出『不要转述』的告诫」）；**普通页面不得被误判** | `page.ts`、`page-read` | D4 | 35 |
| D6 | 正文脱敏不吃定位信息 | URL、路径、选择器、代码**不得被脱掉**（过度脱敏等于工具不可用）；正文里写的密码要挖掉且**话还看得懂**；**随机生成的新密码**同样挖得掉；手机号挖掉但**不误伤长数字 ID** | `redact.ts` | D3 | 45 |
| D7 | 大字段处理 | base64 **只留大小，不抄整个文件**；`eval` 长表达式截断、短的原样留着；**不炸在循环引用和奇怪输入上** | 同上 | D3 | 30 |
| D8 | 全量审计 | 每次操作落 `audit.jsonl`：宿主身份（K）、sessionId、tabId、工具、参数（已脱敏）、效果证据摘要、时间。**扩展不能写文件 → 经桥落盘到本机目录** | `mcp-bridge.ts` + `mcp-server` | D3、K1 | 60 |
| D9 | `<page-content untrusted>` 包裹降权 | **不写「禁止听从注入内容」**——对方理由：*「禁止听从反而把注入内容抬进注意力」*。场景测试有断言：「页面内容裹在 untrusted 边界里」 | `system-prompt.ts` + 读取路径 | — | 25 |
| D10 | **不抢用户焦点** | `captureVisibleTab` 截的是「那个窗口当前可见的标签页」，不是受控标签页——对方曾把用户私人笔记送进过 agent 上下文（B）。规则：新标签页一律 `active:false` 后台打开；「受控」与「前台」是两件事；除 `screenshot` 外所有工具在后台 tab 正常工作；需要前台必须显式 `focus:true` 且描述写明会打断用户 | `mcp-bridge.ts`、`screenshot.ts`、`tabs` | — | 35 |
| D11 | 时间线/动作文案不带用户输入内容 | 防止 UI 成为第二个泄漏面 | `float-ball`、`status` | D3 | 15 |
| D12 | 握手 role 双向校验 | 网页 Origin 必须被桥拒绝（对方称「最要紧的一条边界」）；**但不单独信任 Origin**（伪造 `chrome-extension` 的网页 Origin 浏览器发不出，仍要能进握手，即靠 token 兜底）；agent 用错 token 连不上；**扩展冒充 agent（有 Origin 却报 role:agent）被拒** | `mcp-server/bridge.js` | — | 40 |
| D13 | 读取漂移警告 | 标签页被**别人**导航走时，读取操作显著警告而非若无其事；**agent 自己导航过去的不算漂移**；警告**按会话**记录 | `mcp-bridge.ts` | N4 | 35 |

### E. 连接与可靠性

| ID | 需求 | 契约 | 落点 | 依赖 | 量级 |
|---|---|---|---|---|---|
| **E1** | **桥拆为独立单例 daemon** | 现状：`mcp-server/bridge.js:32/49` 让**每个 MCP server 自己监听 30121**，多 agent 必 `EADDRINUSE`——这是现有 rebind 重试与 `hub_listening` 诊断的根因。改为：`actspan bridge` 子命令 + `fs.openSync(LOCK_FILE,'wx')` **O_EXCL 抢锁**，只有拿到锁的进程 spawn（`detached:true`、`stdio` 落日志、`unref()`），其余**轮询等它起来**；锁 mtime > 30s 判为上次崩溃残留并自愈；`bridge.json` 记 pid；**只有版本号不一致才重启** | `mcp-server/` 新 `bridge-cli` + `rpc.js` | — | 200 |
| E2 | 瞬断宽限 | 扩展在宽限期内带回执 → agent 拿到**真结果**而不是「扩展未连接」（对方断言名：「瞬断宽限」） | `mcp-server/bridge.js` | E1 | 40 |
| E3 | 离线排队 + 补发 | 现状 `bridge.js:175` 未连上直接抛、`:159` 断开立即 settle 全部 pending。改为：扩展离线时命令**先排队**，一连上就送达；**排队期间 agent 自己走了，不能在它已关闭的连接上回包**；扩展一直不来，排队命令**最终仍要失败且话要说对** | 同上 | E1 | 60 |
| E4 | 在途命令立即失败 | 扩展在命令执行**途中**掉线 → 在途命令立刻失败，不干等到超时 | 同上 | E3 | 20 |
| E5 | 优雅退 | `stopBridge` **只认 `bridge.json` 里那个 pid**、只发 SIGTERM；桥收到后**先把在途命令回成错误再退**（对方原文：「不会让 agent 干等到超时」）。**保留现有六元组响应关联，不得弱化** | 同上 | E1 | 30 |
| E6 | L2 按需 + 空闲自动断 | L1 = content script（默认，无调试黄条）；L2 = `chrome.debugger`，**只在需要真实事件、后台截图、或页面 CSP 拦下求值时接入**；首次 attach 后粘住，`L2_IDLE_MS = 5000` 内无新 L2 操作即 detach——「一串连续操作 = 一次黄条，几秒后消失」 | `cdp/*`、`session-manager.ts` | — | 60 |
| E7 | **L2 冲突可解释 + 自动降级** | 错误码 `NEEDS_L2`（要授权 → 提示点开扩展图标启用高保真）/ `L2_BUSY`（*「多半是你自己开着 DevTools——一个标签页只允许一个调试器。已自动降级」*）。这条**直接对治** ActSpan 现有的 "Another debugger is already attached" | `cdp-input.ts`、`policy-executor.ts` | E6 | 40 |
| E8 | 修 `GRACEFUL_ABORT_TIMEOUT_MS` 单位 | `background/session-types.ts:234` = **120 毫秒**，`session-manager.ts:1116` 拿它跟 `task.done` 赛跑后立刻 `markDone()` + `closeByRun()`，detach 没走完 → 调试器泄漏。改 5000，并把 `closeByRun` 排到 detach **之后** | 同上 | — | 8 |
| E9 | 探活礼仪 | 静默连接**先收 ping**；回 pong 的活着，**不回的才 terminate** | `mcp-server/bridge.js` | E1 | 25 |
| E10 | socket 搬进 offscreen document | 对方理由与数字见 C 级（SW 30s 回收 / 中位 106s / 一夜 111 次断连）。**属重构，与 E1 合并到一个窗口做**；完成后应能删掉 alarms keep-alive 与部分 rebind 逻辑 | `background/`、manifest、新 offscreen 页 | E1 | 220 |

### F/O. 记忆与经验回流

| ID | 需求 | 契约 | 落点 | 依赖 | 量级 |
|---|---|---|---|---|---|
| F1 | 经验两层：出厂内置 + 本机 | 本机目录**升级永不覆盖**；`get` 时两层**合并展示**；出厂段可被整段识别 | `site-experience.ts` | — | 50 |
| F2 | 域名归一 | 完整 URL 归到域名；子域**降级到已有键**；别名归并（`tmall→taobao`、`twitter→x`） | 同上 | F1 | 25 |
| F3 | 无记录时**明确说没有、不阻塞、引导回流** | 不得静默返回空 | 同上 | F1 | 10 |
| F4 | 剧本体检 | 好剧本零警告；坏 JSON 与坏形状**都点名**。**存坏剧本：照存（经验不阻塞），但当面说清** | `save-workflow.ts` | — | 40 |
| F5 | 「可能过时」免责 | `get` 时有剧本才提示可执行，并**保留免责**；「经验是提示不是规则」 | `site-experience.ts` | F1 | 10 |
| F6 | **回贴反污染** | 把 `get` 的全文原样存回去时，**出厂段、提示语、重复小节都要被剥掉**，只留本机内容 | 同上 | F1 | 35 |
| F7 | 覆盖前留底 | 保留最近 **10** 份 | 同上 | F1 | 20 |
| F8 | **成功运行自动长草稿** | 跑通的 `act` → 草稿：**ref 换 find、输入换占位符、原文不落盘**。**不沉淀**的条件：有无名元素 / 少于 3 步 / 全是读操作。同样步骤再跑通**只记次数**；`adopt` 后进经验并**列在最前** | `workflow-recorder.ts`、`save-workflow.ts` | P1、H6 | 110 |

### I. 挑战/风控识别（**识别并交人，不绕过**）

| ID | 需求 | 契约 | 落点 | 依赖 | 量级 |
|---|---|---|---|---|---|
| I1 | 挑战页识别 | Cloudflare / hCaptcha / reCAPTCHA **靠 iframe src 认出来，不必读里面**；**iframe 判定必须去掉 query**——里面常带一次性 token，**不该进日志也不该进记忆**；正文出现「验证」**不算**挑战（顶层浮层才采，且要**成句命中**）；普通 iframe 不算（广告/视频/地图天天有）；**frames 优先于 overlays（结构性证据比文案可靠）**；空证据/缺字段/undefined 不炸；`hostOf` 只取主机名、垃圾输入回空串不抛 | 新 `functions/risk-detect.ts` | — | 80 |
| I2 | 识别后的动作 | **停下交人**（G14 通道），不重试、不绕过。对外表述统一为「检测到站点验证，需要用户完成」 | `request-confirmation.ts` | I1、G14 | 20 |

> 说明：本项目**不做**验证码/2FA/风控绕过。I 组是**检测与让路**，与安全研究场景一致。

### J. 版本协商

| ID | 需求 | 契约 | 落点 | 依赖 | 量级 |
|---|---|---|---|---|---|
| J1 | 三段语义 | **补丁号不同 = 兼容，静默**；次版本落后要**分清是哪一边**；**协议号不同才是真不兼容，哪怕版本号一样**；版本号**按数字比不按字符串比**；缺任一边版本时**不报警** | `mcp-server/`、`mcp-bridge.ts` | — | 45 |
| J2 | 扩展与桥版本号必须同步（CI 断言） | 对方有同名测试 | `test/` | J1 | 15 |
| J3 | **用本进程自己的版本算，不信桥给的结论** | 对方原文理由：「桥可能是别的版本拉起来的」 | `mcp-server` | J1 | 10 |

### K. 宿主身份

| ID | 需求 | 契约 | 落点 | 依赖 | 量级 |
|---|---|---|---|---|---|
| K1 | 宿主自报身份 | **自报压过抄错的 `--client`**；各家自报名归一到 `agents.json` 的 slug，显示名从表里取；**没听说过的宿主原样保留它自报的名字，不冒充别家**；宿主没报或报了泛称才退回 `--client`；`slugOf` 只剥「我是 MCP 客户端」这类后缀，不动名字本身 | `mcp-server`、新 `agents.json` | — | 55 |
| K2 | 连桥之前可改口，连上之后不行 | `BridgeClient` 契约 | 同上 | K1 | 15 |
| K3 | 身份用于审计与**配额归因** | 比对方多一步：把宿主身份带进调用配额/积分归因链路（接百智云），而不只用于日志显示 | `mcp-server`、D8 | K1、D8 | 40 |

### M. `ask` 三态

| ID | 需求 | 契约 | 落点 | 依赖 | 量级 |
|---|---|---|---|---|---|
| M1 | `until` 判据命中自动收工 | 不用用户点 | `ask-user.ts` | — | 30 |
| M2 | **超时与拒绝必须结构化区分** | 现状 `ask-user.ts:112` 只把 `timedOut` 折进 `error` 字符串（`deadline.timeoutError.message` vs `'Task cancelled'`），调用方需靠文案判断。改为返回 `code: 'timed_out' \| 'denied' \| 'cancelled'` | 同上 | — | 20 |
| M3 | 无人值守模式立即返回，**不干等** | 配置项 + 立即返回 `unattended` | 同上 | M2 | 15 |

### N. 可视化与多会话归属

| ID | 需求 | 契约 | 落点 | 依赖 | 量级 |
|---|---|---|---|---|---|
| **N1** | `status` 工具替代自动推断文案 | 对方定义：*「One short sentence telling the user what you are about to do… Call before a multi-step task and whenever the plan changes. **Instant, never blocks.** Use the user's language. ≤80 chars」*。**取代**现有 `float-ball/text-utils.ts:156` 的「按工具名猜文案」（把 `page\|page_viewer\|page_snapshot\|fetch_url` 一律映射成「我正在查看页面内容」）与 `float-ball.ts:1090` 的**文案粘住**问题 | 新工具 + `float-ball` | — | 50 |
| N2 | 会话外观是 sid 的纯函数 | 同一 sid 永远算出同一套外观；**只由 sid 决定，不受 client 参数影响**；并发会话**撞色要够罕见**；每个身份 emoji 互不相同；每个身份带一个 **Chrome 认识的标签组颜色** | 新 `session-identity.ts` | — | 45 |
| N3 | sid 派生自 agent 进程 | 短码取 sid 冒号后那截（= agent 进程的父 pid）；宿主自定义 sessionId **没有冒号结构也不能崩**；client 缺省时从 sid 前缀推 | 同上 | K1 | 25 |
| N4 | **户口簿** `ownTabs:<sid>` | 会话对某页发过命令就登记。标记、冲突检测、继承拦截都从「槽 + 户口簿」反推——**显式 tabId 驱动的页面不再裸奔**（对方事故：多线自救会让页面标记消失，别的会话能把它「继承」走） | `session-manager.ts`、`TabLeaseManager` | — | 70 |
| N5 | **出生证 + 找回** | `tabs(action:"new", label:"哪条线")` 回执带 `[tabId]「label」`；`tabs(action:"list")` 标 `*` 缺省槽、`+` 本会话其他工作线、`×` 别的会话在用，**加 label**——「上下文被压缩后从这里重建工作记忆」 | `tabs` 工具 | N4 | 40 |
| N6 | 新标签页自动跟随 | 点 `target=_blank` 链接、`window.open` 开的新页**都跟得上**，**没开新页时不误报**；返回**两个 tabId** | `TabLeaseManager` | N4 | 55 |
| N7 | 归属拦截在**副作用之前** | 新会话**不许继承**一个还有主的标签页，且**要说清下一步**；主人已断开的标签页**可以**被继承；`select` 别的会话正在操控的 tab：**警告但不阻止**（读可以警告，写才阻止） | 同上 | N4 | 45 |
| N8 | **桥换进程，受控标签页还在原地** | 会话身份跨桥重启稳定 | `mcp-bridge.ts`、E1 | E1 | 30 |
| N9 | 当面提醒 + **冷却** | 户口簿里 ≥2 页还走缺省槽 → 回执尾部提醒切显式 tabId，**10 分钟冷却**（对方理由：「多线是持续状态，每条都唠叨会变背景噪音」） | 同上 | N4 | 20 |
| N10 | **不碰页面门牌** | 标题和 favicon 都不改（对方断言原文：「页面的门牌我们都不碰」）。归属可视化只走 tab group / label / 页内面板 | `float-ball`、`mark` | N2 | 15 |
| N11 | 虚拟光标 | 页内可见的执行指示；**光标钩子必须在遮挡检测之前调用**；钩子名两侧一致（协议测试锁定） | 新 `content/virtual-cursor.ts` | — | 70 |
| N12 | 页内驾驶舱 / 幕帘 / 空闲胶囊 | 「你看得见它在干活」的三件套；协议两侧一致 | `float-ball` | N11 | 90 |

### P. `act` 复合工具（DSL）

| ID | 需求 | 契约 | 落点 | 依赖 | 量级 |
|---|---|---|---|---|---|
| P1 | `act` 是**默认出牌方式** | 描述第一句：*「Your DEFAULT way to act — batch every step you can predict」*。≤20 步顺序执行；**每步效果校验**；**ONE snapshot returns at the end**；「every call you merge saves a full model turn」 | 新工具 | C1 | 150 |
| P2 | 提前停 | 无效果 / 失败 / **提交-支付-删除控件** → 停。`allowSensitive` 默认关，显式开且**写入审计** | 同上 | D2、C1 | 30 |
| P3 | `read` 中途观察 | `{ref\|find\|selector, attr?}` 或 `{contains}`，把观测带回批量中途 | 同上 | H6 | 25 |
| P4 | 控制块只嵌一层 | `repeat {steps,until,max}`（max 默认 10、上限 25）用于翻页/加载更多；`if {cond,then,else}` 用于可选横幅；`assert {cond}` 不匹配即停。`cond = {urlContains\|selectorExists\|textContains, not}`（OR 关系）或 `{ref\|selector, checked\|value\|text}`。**`repeat` 里嵌控制块要拦下，且错误信息说清怎么改** | 同上 | P1 | 90 |
| P5 | **`repeat` 子步禁 ref** | 理由（对方原文）：「第二轮页面重渲染后 ref 必然作废」。`repeat` 内用 find/selector；其它地方：页面重渲染前用 ref，之后用 find | 同上 | H2、H6 | 20 |
| P6 | **预算按展开后的原子步数算** | `flatCount` 把 `repeat`/`if` 展开成实际会执行的步数；**schema 允许的合法剧本不能被执行预算掐死** | `loop-config.ts`、`core-loop.ts` | P4 | 40 |
| P7 | `condText` 人话可读 | 支持 `not` 取反、超长截短 | 同上 | P4 | 20 |

### Q/R. 握手与协议

| ID | 需求 | 契约 | 落点 | 依赖 | 量级 |
|---|---|---|---|---|---|
| R1 | 每条命令盖 sid | **每会话稳定、会话间互异，且不回泄给 agent** | `mcp-server/bridge.js` | K1 | 30 |
| R2 | 每条命令带**当前在线会话名单** | agent 能知道还有谁在跑 | 同上 | R1 | 20 |
| R3 | `hello` 里的 label 随每条命令盖给扩展；不带就不盖 | | 同上 | N5 | 20 |
| R4 | **agent 断开时不发删槽指令** | 理由（对方原文）：「它可能只是要重连」 | 同上 | N4 | 15 |
| R5 | 扩展发的事件**广播给所有 agent** | 对方回归测试名：`tab_closed 回归` | 同上 | — | 20 |
| R6 | 老客户端不带 sessionId 仍拿到互异身份 | 向后兼容 | 同上 | R1 | 15 |
| R7 | 响应串号防护 | 对方踩过的坑：pending 只按消息 id 索引，而每个 agent 进程 id 都从 `c1` 开始 → 并发时后者覆盖前者、**响应串到别人请求上**；解法是按「连接序号:id」索引 + 回归测试。**ActSpan 现有六元组校验已更强，保留并加测试锁住** | 同上 | — | 15 |

### T. 分层与工具描述（**ActSpan 的 tiering 改造**）

| ID | 需求 | 契约 | 落点 | 依赖 | 量级 |
|---|---|---|---|---|---|
| **T1** | **修 P0-1：`agent` 工具被 tier 过滤掉** | `ai/orchestrator.ts:113-126` 的白名单数组里没有 `'agent'`（工具在 `tool-executor.ts:24` 注入），而 `:128` 的 `hasSubtask` 硬编码为 `true` → prompt 教并行分发、工具却不存在 → 退化成串行 `page_snapshot` 反复刷 | `orchestrator.ts:124`、`:128` | — | 6 |
| **T2** | **修 P0-2：子 agent 里 `load_tools` 谎报成功** | `ai/core-loop.ts:571-575` 递归调用少传第 15/16 参（`allTools`、`loadedOnDemandTools`），使 `:696` 的注入守卫 `if (allTools && loadedOnDemandTools)` 被跳过，而 `functions/load-tools.ts:42` 仍返回硬编码成功文案「已加载 N 个工具」 | `core-loop.ts:571` | — | 4 |
| **T3** | catalog **必须列工具名** | `functions/tool-tiers.ts:66` 只渲染 `cat.label` + `cat.description`，从不输出 `cat.tools` → **webhook 事故的直接原因**（模型不知道有 `webhook`，退化成肉眼读 Options 页） | `tool-tiers.ts:63-70` | — | 3 |
| **T4** | 分类描述写进「能做什么 + 关键词」 | `tool-tiers.ts:37` 现为 `'Clipboard, notifications, bookmark management, history search, file download'`——**无 webhook/飞书/推送字样**。改为含 `Webhook push to Feishu/Lark/Bark/Slack/Discord/WeCom…` | `tool-tiers.ts:37` | — | 1 |
| **T5** | **分类维度改为「信息载体」** | 现状按实现模块分（`browser_utils` 等）；改为 操作层(DOM) / 数据层(网络) / 像素兜底 / 会话与元。每类描述写成「什么时候用 + **该用哪个、别用这个**」 | `tool-tiers.ts` | T3 | 50 |
| **T6** | **描述即策略** | 高频工具的 description 必须承载：默认路径（`act` = "Your DEFAULT way"）、退让顺序（`download` = "LAST RESORT… Try first: …"）、入口引导（`network` = "START HERE when you need DATA"）、反必错先验（"Never guess an endpoint name from memory"）、自带诊断承诺 | 各 `functions/*.ts` 的 schema | T5 | 70 |
| **T7** | **`load_tools` 改为可选，工具默认全量常驻** | 决策依据：`load_tools` 的隐含前提是「模型会去加载它不知道存在的东西」，而 webhook 事故证明它不会。对方 24 个工具全量常驻，把省 token 花在别处（回执摘要、`fill` 一次填完、`act` 一次跑完、分页落盘只回预览）。**账**：对方最重的描述（`act`）约 900 字符，24 个估 2.5–3.5k token 常驻；一次误派发的代价是 5–10 轮 × 每轮一份快照 + 一次模型往返。**结论：改常驻。** | `orchestrator.ts`、`tool-tiers.ts` | T3–T6 | 45 |
| T8 | 决策树进 system prompt | 照对方 `docs/能力模型.md` 第八节那棵树的形状：要操作 / 要数据 / 要文件 / 滚不动点不动截不到，四支各带退让顺序与「读诊断信息，别撞运气」 | `system-prompt.ts` | T5 | 40 |
| **V1** | **任务级墙钟预算**（R1 订正后暴露的真缺口） | 现有预算只有「单次 LLM 调用 5min + idle 60s」（`ai/deadline.ts:1-2`）与「轮数 / 工具调用数」（`core-loop.ts:391-401`、`:486-503`）。**没有任务级墙钟**，于是 20–40 轮 × 20–60s = 20 分钟属「合法」；而 `:486-503` 的收尾文案明确要求「不要提及轮数、工具限制等内部概念」，用户看不到任何异常。需求：任务级 deadline + 到期时**向用户说明真实原因**（可换措辞，但不得静默） | `loop-config.ts`、`core-loop.ts` | — | 40 |
| V2 | SSE 形状兼容 | `llm-client.ts:253-258` 只认 4 种 `json.type`，Chat-Completions 形状（`choices[0].delta.content`）**静默丢弃** → 「请求成功、无输出、无报错」再进下一轮。需求：识别不了的事件**必须计数并在轮末报告**，不得静默 | `llm-client.ts` | — | 30 |

### U. 安装与零配置

| ID | 需求 | 契约 | 落点 | 依赖 | 量级 |
|---|---|---|---|---|---|
| **U1** | **MCP-only 模式零 env 启动** | `mcp-server/index.js:14` 一上来 `validateConfig()`，失败 `:38 process.exitCode = 1`；`catalog.js:37-73` 强制 `ACTSPAN_API_URL`（https）、`ACTSPAN_API_KEY`、`ACTSPAN_EXTENSION_IDS`（32 位 a-p）。**这正是「用户不输模型就走单工具调用」跑不起来的原因。** 改为分档：默认档只校验 `BRIDGE_URL` 本地性；缺模型配置**不报错**，`actspan_status` 回报 `loop_mode: disabled`；`EXTENSION_IDS` 改由配对自举（U4）learn | `catalog.js`、`index.js` | — | 25 |
| U2 | `install` 子命令 | 八条纪律：agent 表是数据不是代码（`agents.json`，含 `_comment` 字段说明）；每 agent 一条候选路径链，按序取**第一个存在**的；平台差异不猜（Win `%APPDATA%` / mac `~/Library/Application Support` / Linux `$XDG_CONFIG_HOME` 或 `~/.config`）；表追不上新产品 → **扫 home 点目录自动发现**含 `mcpServers` 的配置（Codex TOML 另行适配）；**发现要去重**（对方踩过的坑：排除范围要用表里**所有候选路径**算，不能只用命中的那个，否则 Claude Code 第二个位置被当成新 agent，**用户看到同一产品列两遍还被写两份配置**）；写之前先给人看（`--dry-run`，每行 `·`/`+` 标「已配置，跳过」/「将写入 MCP 配置」）；**备份是文件名的一部分**（`.bak-<ts>`，已配过的只报状态不动文件）；**TOML 不做完整解析，只追加 `[mcp_servers.x]` 块**（理由：用户 config.toml 里可能有注释和自定义格式） | `mcp-server/` 新 `install.js` + `agents.json` | U1 | 320 |
| U3 | `doctor` | **桥没跑就自己先拉一个再探**（对方原文：「桥本来就是谁先用谁拉起的，doctor 自己拉一个再探，才探得到真相」）；`bridge.json` 里记的 pid 已经没了要明说；成功输出「握手正常 · 扩展在线」。保留现有 `hub_listening` 双分支 hint | 同上 | E1 | 60 |
| U4 | **配对自举：消灭手填 token 与扩展 ID** | `install` 起一次性 `127.0.0.1` 随机端口 HTTP 监听 → 打开引导页（`chrome-extension://<id>/welcome.html`）→ 页面 POST 回 `chrome.runtime.id` 与生成的配对密钥（同时写 `chrome.storage.local`）→ installer **自己填进它写给用户的那份 MCP 配置**。用户全程只做浏览器强制他做的那一下：加载扩展。**注：对方没有这条（其白名单要求 ID 预先已知），这是 ActSpan 自有设计** | `install.js`、`welcome` 页、`mcp-bridge.ts:6` | U2 | 110 |
| U5 | 双运行模式 + Windows | `FROM_NPM ? { command: WIN ? 'npx.cmd' : 'npx', args:['-y','actspan-mcp','mcp','--client',c] } : { command: nodeBin(), args:[cli,'mcp','--client',c] }`。**`npx.cmd` 是 Windows 上 `npx` 解析失败的唯一解** | 同上 | U2 | 15 |
| U6 | 引导页 | 写临时 html，按平台 `cmd /c start` / `open` / `xdg-open`，`detached + unref`。页面须明写：**装扩展这一下必须你自己点，浏览器不允许脚本代劳** | 同上 | U2 | 40 |
| U7 | 异构配置**只打印不写** | 认不出的格式（如顶层 `mcp` + 命令数组）→ 打印该填的 JSON + 手动步骤 + 核对日期，并声明「这是手动配置说明，不表示 install 已支持自动安装」。**探测不到就说清楚，绝不猜** | 同上 | U2 | 20 |

### S. 测试与靶场（**制度级，优先于任何新功能**）

| ID | 需求 | 契约 | 落点 | 依赖 | 量级 |
|---|---|---|---|---|---|
| **S1** | **每个工具必须有一个能在本地靶场跑通的最小用例，否则不许进工具表** | 对方方法论（B）：先建 `test/fixtures/playground.html`（**无 CSP、带事件记录仪**）把典型交互摆出来撞，*「效果比等任务好得多——下面五条里有四条，真实任务半年也未必碰得到，但一碰就是静默失效」*。其 CSP 一节的公开订正更值得抄成制度：*「一个连本地空白页都跑不通的工具，等于不存在，却在工具表里占了一年的位置」*，教训是*「报错信息要读完——前半句符合预期的时候，人不会去看后半句」* | `test/fixtures/` | — | 制度 |
| S2 | 六类 fixture | `playground.html`（无 CSP + 事件记录仪）、`creds.html`（凭据页）、`csp.html`（CSP 受限）、`frame-inner.html`（跨源 iframe）、`newtab.html` + `newtab-child.html`（新标签跟随）、`flow.html`（多步流程） | `test/fixtures/` | — | 120 |
| S3 | `audit-redact` 类测试 | 对应 D3–D7 每条判据（含循环引用不炸、base64 只留大小、定位信息不被脱掉） | `test/` | D3 | 140 |
| S4 | `liveness` / `multi-instance` 类测试 | 对应 E1–E5、E9、R1–R7 | `test/` | E1 | 200 |
| S5 | 场景测试（对方 96 条 `test()` 为模板） | 至少覆盖：完整事件序列 / mousedown-only 下拉 / preventDefault 焦点 / SVG 图标按钮 / 跨源 iframe / shadow DOM / `@fN` 后缀 / 一次 fill 填完整表 / file 角色 / 无 for 命名 / 按键默认行为 / 后台滚动唤醒懒加载 / 迟到校验错误置顶 / 后台 confirm 不卡死 / upload 无系统对话框 / 拖放上传 / `@value` 当前值 / untrusted 边界 / 效果证据 11 条 / select 强制 L1 / 敏感不自动升级 / isTrusted-only 按钮自动升级 / 支付拦截 4 正 4 反 / eval 内支付拦截 / ask 三态 / 漂移警告 / ref-selector 互斥 / find 四态 / act 八条 / 编号稳定性四条 / 凭据隐去五条 / 会话隔离八条 / 新 tab 跟随两条 / 快照可访问性三条 | `test/scenarios.test.mjs` | G、H、C | 900 |

---

## 3. 工作包与依赖

```
WP0  存量 P0（T1 T2 T3 T4 + webhook name trim + feishu.push 错误信息 + webhook 上 MCP 面 + C0 P0-3 + E8）
        └ 无依赖，~60 行，立刻可做，直接对治已发生的三起故障
WP0.5 未验证项自查（G5 跨源 iframe / G14 cdp-dialog 后台 confirm / M2 ask 三态 / H2 ref 失效检测）
        └ 侦察包，不产出功能，决定 G/H 的实际工作量
──────────────── 地基 ────────────────
WP1  接地保真     G1–G15           依赖 S2（靶场先建）
WP2  ref 生命周期  H1–H9            依赖 WP1 部分
WP3  效果证据     C0–C3            依赖 WP1、WP2
──────────────── 建在地基上 ────────────────
WP4  MCP 面补齐   A1 A4 B1–B9      依赖 WP3（效果证据要先可信）
WP5  安全         D1–D13           D1 可提前（结构性漏洞）
WP6  分层与描述   T5–T8 V1 V2      与 WP0 的 T1–T4 同一处代码，建议合并一次改
WP7  可靠性       E1–E9 R1–R7      独立
WP8  记忆         F1–F8            独立，可并行
WP9  安装零配置   U1–U7            U1 可独立先做（25 行，收益最大）
──────────────── 有强依赖或需单独窗口 ────────────────
WP10 act DSL      P1–P7            硬依赖 WP2 + WP3
WP11 挑战识别     I1 I2            独立
WP12 可视化归属   N1–N12           N1 可独立先做（替代 float-ball 猜文案）
WP13 offscreen    E10              **与 WP7 合并到同一窗口**，别拆两次动桥
WP14 版本/宿主    J1–J3 K1–K3      独立，小
WP15 测试         S1–S5            S1/S2 最先做，其余随包推进
```

### 本轮建议承诺的范围（其余明确排后）

**WP0 + WP0.5 + WP6(T5–T8,V1,V2) + WP9(U1) + WP15(S1,S2)**
理由：WP0 修已发生故障（60 行）；WP6 修「分层与预算」这一类结构性问题且与 WP0 同处代码；U1 让「不配模型也能用」当场成立（25 行）；S1/S2 建立靶场制度，之后每个包都靠它验收。**合计约 300 行 + 6 个 fixture**，不动桥、不动 offscreen、不引入 act DSL。

---

## 4. 总验收清单

### 4.1 「子集达成」判据（10 条，当场可跑）

```
1  不配任何模型（无 API_URL/KEY/EXT_IDS），只用 MCP：进程能起，actspan_status 返回
   loop_mode:disabled 且 ping 通                                     → U1
2  同上模式：能列网络请求、能带 cookie fetch、能下载文件                 → B1/B6
3  同上模式：能推飞书；配错时错误信息列出每个 entry 的
   [name|type|enabled|host] 与匹配条件                                → WP0
4  同上模式：page.eval 无法在敏感表单上触发提交；普通 eval 不受影响        → D1
5  page.read 读凭据页：返回无凭据明文，只有 <N 位>，且带「不要转述」告诫；
   普通页面不被误判                                                    → D4/D5
6  任意 page.click 的返回值含 changed:true|false，且**不需要第二次快照**；
   回执里印出实际命中的元素                                             → C1
7  SVG 图标按钮：点击真的发生（返回体不得在动作前报 success）              → C0/G2
8  只监听 mousedown 的自定义下拉能被打开；react-select 类焦点不被抢         → G1/G3
9  跨源 iframe 内元素进快照（ref 形如 e5@f2）且可操作，协议面无新增概念      → G5
10 同时起两个 agent：桥只有一个进程，第二个 MCP server 连同一 hub，
   无 EADDRINUSE；kill 桥 pid 后在途命令立刻拿到明确错误而非超时           → E1/E4/E5
```

### 4.2 靶场用例最小集（S2 建好后即可跑）

| fixture | 锁定的需求 |
|---|---|
| `playground.html`（无 CSP + 事件记录仪） | G1 G2 G3 G13 C1 A2 |
| `creds.html` | D4 D5 D6 D11 |
| `csp.html` | `page.eval` 的 MAIN world 边界（现有注释声称已解决，**需靶场证明**） |
| `frame-inner.html`（含 `Frame action` 契约与 `inner-button` 钩子） | G5 H2 |
| `newtab.html` + `newtab-child.html` | N6 |
| `flow.html` | P1–P7 F8 |
| `acceptance.html`（§4.1 判据 4–9 的靶场，跨源 iframe 用换主机名同端口制造） | C0 C1 D1 G1 G2 G3 G5 |

---

## 5. 明确不做（照对方的诚实做法，写进对外材料）

| 项 | 判定 | 理由 |
|---|---|---|
| **扩展内不做决策** | 🚫 不做 | 这是对方的定位（单脑）。ActSpan 的扩展内 Agentic Loop + Skill Registry + workflow 重放是**唯一比它高的那一格**，抄过来等于自删差异点 |
| **站点白名单** | 🚫 不做 | 对方判定不做的理由成立：只约束导航、管不到当前页面发生什么；且每域一次批准与「带全部登录态」的卖点自相矛盾 |
| **非支付类敏感动作弹窗** | ❌ 未实现，且不假装实现 | 对方也标 ❌ 并直说「会花钱的动作有人把关，会删东西的没有」。我们如实标注 |
| **验证码 / 2FA / 风控绕过** | 🚫 不做 | 只做 I 组的**识别 + 交人** |
| **反检测 / 指纹伪装**（Chromix 那 216 处 Chromium patch、加密 cookie 迁移） | 🚫 不做 | 与安全定位冲突，且引入不可维护的构建链 |
| **异构 MCP 配置格式自动写入** | 🚫 不做 | 认不出就打印 JSON（U7）。「探测不到就说清楚，绝不猜」 |
| **上传/复制用户 Cookie、登录态、页面凭证** | 🚫 不做 | 项目既有非目标，D 组全部围绕它设计 |

---

## 6. 风险与免责

1. **C 级数字未复现**：§0.2 列出的所有对方自报实测值（106s / 111 次 / 98% / 20s→2–4s / 12MB / 48MB）**我方无环境复现**。对外引用必须注明出处为 huashu-chrome 的 README/docs，不得表述为我方实测。
2. **D 级未验证项（2026-10-20 已关闭）**：G5（跨源 iframe 已进快照，ref 形如 `e5@fN`）、G14（确认通道已落地，四类硬边界分类未实现，见 §8.2）、M2（`ask` 三态已实现结构化 `data.code`）、H2（ref 失效可检测，`validateElementHandle` 报「已过期」并指路 `find`）。四条均在真实 Chrome 上跑通。
3. **AGPL 传染**：本项目 AGPL-3.0。huashu-chrome 为 MIT，**MIT → AGPL 单向可用**（保留版权声明与许可证副本即可）；其 `docs/经验/` 23 份站点笔记可直接取用为 F1 的出厂内容，须保留署名。反向不可。
4. **不得弱化的既有优势**：`mcp-server/bridge.js:145-147` 的六元组响应关联、`index.js:72-92` 的 `hub_listening` 双分支诊断、`PolicyExecutor` + `TabLeaseManager` + registry revision 快照这套**机制型**权限模型（对方是约定型）。整改中任何一条被简化都算回归。
5. **本文所有 file:line 基于 `e42f68d7/mole-extension` 当前工作副本**，未提交改动（`mcp-server/`、`src/background/mcp-bridge.ts`）已计入。

---

## 7. 待明确事项与建议

下面 16 条**不能由实现者单方决定**：要么涉及安全边界，要么涉及对外承诺，要么会改变工作量数量级。每条给出「为什么必须人拍板 / 我的建议（单一结论）/ 不拍板时的默认行为」。

### 7.1 安全边界（必须拍板，默认值偏保守）

| ID | 待明确 | 为什么必须人拍板 | 建议 | 不拍板时的默认 |
|---|---|---|---|---|
| **Q1** | 零 env 模式下 `ACTSPAN_EXTENSION_IDS` 白名单怎么办（U1/U4） | 现状必填 32 位扩展 ID。改成"首次连接即 learn"意味着**本地任意扩展都能配对**——这是信任边界的实质放宽，不是实现细节 | **保留白名单，但由 `install` 自举写入**（U4：引导页回传自己的 `chrome.runtime.id`）。用户零手工，边界不放宽 | 保持必填，`install` 负责填 |
| **Q2** | MCP 面的 `page.eval` 保留还是默认关闭（D1） | 它现在能绕过所有 click 层确认门（`mcp-bridge.ts:503`，`Runtime.evaluate` + `userGesture:true`）。关掉会损失兜底能力，不关就是敞口 | **保留但纳入 policy**：敏感页/表单提交路径拦截 + capture-phase 合成事件拦截；同时**默认关闭**，需在配置里显式开启（`allow_eval: true`） | 纳入 policy，不默认关闭 |
| **Q3** | 审计日志 `audit.jsonl` 记什么、记多久（D8） | 记 URL 就有隐私面，不记 URL 就没法定位问题；留存期涉及合规 | 记 URL 的 **host + path**（去 query，理由同 I1：query 常带一次性 token）；默认留存 **30 天**或 50MB 轮转，二者先到为准；提供一键清空 | host+path、30 天轮转 |
| **Q4** | 挑战/风控识别结果是否上报（I1/I2） | 识别数据对安全产品有价值，但上报站点访问行为是隐私决策，且与"不上传用户浏览数据"的既有非目标可能冲突 | **默认纯本地，不上报**。若要做成产品能力，单独走一次评审 | 纯本地 |

### 7.2 对外承诺与范围（决定工作量数量级）

| ID | 待明确 | 为什么必须人拍板 | 建议 | 不拍板时的默认 |
|---|---|---|---|---|
| **Q5** | **场景测试要不要真浏览器** | S5 那 96 条契约里，事件序列（G1）、SVG（G2）、焦点礼仪（G3）、shadow DOM（G4）、跨源 iframe（G5）、后台 tab 不产帧（G13）**在 jsdom 里全都测不出来**。要真测就得引入 Playwright/puppeteer 起带扩展的 Chrome，CI 成本和时间窗都变 | **要。** 引入 Playwright 只用于 `test/scenarios`，`node --test` 靶场（S2）仍跑纯逻辑。理由：本项目所有已知 P0 都属于"静默假成功"，只有真浏览器能证明 | 只做纯逻辑靶场，G 组验收降级为人工点检 |
| **Q6** | `act` DSL 是否进本轮（WP10） | 它硬依赖 H2 + C1，且是对方"98% 墙钟在命令间推理"那个论点的落地物。做则本轮工作量翻倍，不做则"省轮数"只有间接手段 | **不进本轮。** 先把 C1（效果证据）做完并稳定一轮，`act` 的价值才可验证；否则批量执行建立在不可信的单步结果上 | 不进本轮 |
| **Q7** | offscreen 迁移（E10）与桥拆分（E1）是否合并到一个窗口 | 两者都动连接层，分两次做等于把桥重构两遍 | **合并**，且排在 WP0/WP6 之后单独一个窗口。E1 单独先做也可以（它解决多 agent 撞端口），但 E10 必须等 E1 稳定 | E1 先做，E10 排后 |
| **Q8** | 时间窗与人力 | 16 个工作包全做约 3500+ 行。范围必须匹配窗口，否则承诺会失信 | 需要你给**截止日期 + 可投入人力**，我据此裁包。当前建议的本轮范围（WP0 + WP0.5 + WP6 + U1 + S1/S2，约 300 行）是按"一人 2–3 天"估的 | 按本轮建议范围执行 |
| **Q9** | 是否发布到 npm | `npx -y actspan-mcp` 要求包已发布；AGPL 发布无碍，但**包名占用**和版本策略是对外动作 | 先本地 `node` 模式跑通（U5 已支持双模式），发布留到安装体验验收后再定 | 只支持本地模式 |

### 7.3 产品语义（会影响用户可见行为）

| ID | 待明确 | 为什么必须人拍板 | 建议 | 不拍板时的默认 |
|---|---|---|---|---|
| **Q10** | **任务级墙钟（V1）默认多久，到期怎么跟用户说** | 现有 `core-loop.ts:486-503` 的收尾文案明确要求"不要提及轮数、工具限制等内部概念"——这与"必须说明真实原因"直接冲突。取舍是产品口吻问题 | 默认 **10 分钟**任务级墙钟；到期文案不提"轮数"，但**必须说明卡在哪一步**（例："在 X 页面上连续 N 次未能确认操作生效，已停止"）。**静默停止是不可接受的**，那正是这次 20 分钟的观感来源 | 10 分钟 + 说明卡点 |
| **Q11** | 工具是否改为**全量常驻**（T7） | 会涨常驻 token（估 2.5–3.5k），但 `load_tools` 的前提已被 webhook 事故证伪 | **改常驻**，`load_tools` 保留为可选（不删，避免破坏现有 skill 引用）。同时 T3/T4 必须做，否则常驻也发现不了 | 改常驻 |
| **Q12** | `float-ball` 自动推断文案是否保留（N1） | `status` 工具由 agent 主动报，但 MCP 模式下**外部 agent 可能根本不调 `status`**，此时悬浮球会没有文案 | **保留推断作为兜底**，但修掉粘住问题（`float-ball.ts:1090`）：无新事件超过 3s 显示"仍在处理…"而非冻结旧文案；`status` 到达时优先 | 保留兜底 + 修粘住 |
| **Q13** | MCP 工具命名 | 现有 17 个是 `actspan_page_click` 风格，补齐后约 26 个。改名会破坏已配置的用户 | **只增不改**：新工具沿用 `actspan_` 前缀；`page_read` 保留但描述里指向新的 `snapshot`（B9 式退让顺序） | 只增不改 |
| **Q14** | Loop 模式的模型路由 | 本机 omp 只允许 `gpt-6.1-sol` / `feature/gpt-5.6-sol` / `gpt-6-sol` 三条路由且**禁用 coding**；而 `llm-client.ts` 现在伪装 `User-Agent: claude-code/1.0.0`，`max_output_tokens: 16384` 写死 | 需要明确：默认走百智云网关哪条路由、UA 伪装是否保留（可能触发网关侧策略）、`max_output_tokens` 是否随路由可调。另 `strictResultMode`（`types.ts:178`）**声明了但无人读取**，要么接上要么删掉 | 不改，列为待办 |

### 7.4 内容与方法（低风险，但需要授权）

| ID | 待明确 | 建议 |
|---|---|---|
| **Q15** | 是否取用 huashu `docs/经验/` 的 23 份站点笔记作为 F1 出厂内容 | **取用**（MIT → AGPL 单向可用），每份保留出处与署名，且**逐条按我方靶场复测后再入库**——对方标注的是它的实测日期，不代表在我们的实现上成立 |
| **Q16** | 是否把「每个工具必须有靶场用例才能进工具表」写成硬性制度（S1） | **写成硬性制度**，并在 CI 里加一条检查：`catalog.js` 的 `TOOL_NAMES` 每一项都必须在 `test/scenarios` 里出现至少一次。理由见附录 C 那句「一个连本地空白页都跑不通的工具，等于不存在，却在工具表里占了一年的位置」 |

### 7.5 我这边需要你确认的三件事（阻塞项）

1. **Q8 的时间窗与人力** —— 不给这个，包只能按"最小可信范围"裁，无法对齐你的比赛/交付节点。
2. **Q5 是否引入 Playwright** —— 决定 G 组（接地保真）能不能被证明，而不只是被实现。
3. **Q1/Q2 的安全边界** —— 这两条一旦按默认值实现，事后再收紧是破坏性变更。

---

## 8. 落地状态（2026-10-20 收口）

逐条状态表见 [`actspan-gap-matrix.md`](./actspan-gap-matrix.md)（189 行，列为「需求ID / 状态 / 落点 file:line / 证据 / 备注」）。

### 8.1 计数

| 状态 | 条数 |
|---|---|
| 已实现 | 155 |
| 部分实现 | 30 |
| 未实现 | 3 |
| 不适用 | 1 |
| **合计** | **189** |

### 8.2 未实现（3 条，均为已知缺口，不假装实现）

| 需求ID | 缺口 | 落点 |
|---|---|---|
| Q14 | `strictResultMode` 已设但无读取方；`max_output_tokens` 与 User-Agent 硬编码，可配置模型路由面未实现 | `src/ai/llm-client.ts:20,106,127,185,207` |
| Q15 | `BUILTIN_SITE_EXPERIENCE.domains` 为空对象，huashu 的 23 份站点笔记未入库（Q15 已批准取用，但 huashu 仓库本地不存在，故出厂层刻意留空） | `src/functions/builtin-experience.ts:42-45` |
| Q16 | 无「每个 `TOOL_NAMES` 项必须在 `test/scenarios` 用例体内出现」的 CI 检查；`test/scenarios.test.mjs` 因需真实浏览器 + 扩展仍不进 `npm test`（本轮已把 `test/fixtures.test.mjs`、`test/manifest-recorder.test.mjs` 两个纯 Node 测试补进 `npm test`，此前它们从不运行，其中 `manifest-recorder` 已因 `all_frames` 变更而失效） | `test/scenarios.test.mjs:62-66`、`package.json:25` |

### 8.3 规格正文的过期表述（代码已先行，以下为实读订正）

规格正文写于 2026-10-19，本轮实施后有 8 处描述已与代码不符。以代码为准。

| # | 规格原文 | 实读订正 | 级别 |
|---|---|---|---|
| D1 | `page.eval` 用 `userGesture:true` | 实际是 `userGesture:false` + `throwOnSideEffect:true`（`src/background/mcp-bridge.ts:844-857`）。语义更强：敏感表单上的提交被 CDP 直接拦下，普通读取不受影响 | A |
| E8 | 断线宽限 120ms | 实际 `GRACEFUL_ABORT_TIMEOUT_MS = 5000`（`src/background/session-types.ts:236`） | A |
| M2 | `ask` 的三态行为未验证 | 已实现结构化 `data.code`（`src/functions/ask-user.ts:113-146`） | A |
| J2 | 版本兼容报告缺失 | `versionReport()` 已存在（`mcp-server/install.js:129,132`） | A |
| WP0 | 「注册了 `feishu.push` handler 但不在 `TOOL_NAMES`」 | `feishu.push` 已在 `TOOL_NAMES`（`mcp-server/catalog.js:16`） | A |
| Q6 | 本轮不做 `act` DSL | 已完整实现（`mcp-server/act-script.js`、`mcp-server/act-tool.js`） | A |
| Q7 | E10 与 E1 二选一 | 两条都已落地 | A |
| Q11 | `load_tools` 按需加载 | 工具已改常驻（`src/ai/orchestrator.ts:144-145`），`load_tools` 保留为兼容命令 | A |

### 8.4 验收证据

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型 | `npm run typecheck`（= `tsc -b --noEmit`） | **exit 0，0 个错误**（原 137 个存量已清零，可作 CI 门禁） |
| 扩展单测 | `npm test`（`mole-extension`） | 348 pass / 0 fail |
| MCP 单测 | `npm test`（`mcp-server`） | 94 pass / 0 fail |
| 安装测试 | `npm run test:install`（`mcp-server`） | 21 pass / 0 fail |
| 端到端 | `node test/e2e.mjs`（`mcp-server`） | all checks passed |
| 工具目录 | `node --test test/catalog.mjs`（`mcp-server`） | 9 pass / 0 fail |
| 工具 schema | `node --test test/tool-schema.mjs`（`mcp-server`） | 1 pass / 0 fail |
| 真实 Chrome 验收 | `npm run test:acceptance`（`mcp-server`） | 17/17 通过（§4.1 十五条判据 + 零配置 `4.1-1b` + `tab.open` 前置）。新增 `4.1-12` status.update 走扩展能力、`4.1-13` G11 三态与 class、`4.1-14` G15 折叠与弱候选、`4.1-15` G13 补发 wheel 与三因诊断 |
| 模拟用户全量 | `npm run test:simuser`（`mcp-server`） | 12/12 场景通过（见 §8.5） |

**类型检查此前是假绿**：`npx tsc --noEmit -p tsconfig.json` 一个文件都不检查——根 `tsconfig.json` 是 solution-style（`files: []` + `references`），`--listFiles` 返回 0 行。真实检查是 `tsc -b --noEmit`，已固化为 `package.json` 的 `typecheck` 脚本。本轮顺带修掉 23 个错误（含把 `@types/node` 从 app 侧 `types` 中移除——它让 `setTimeout` 返回 `Timeout` 而非 `number`）。**余下 137 个历史存量已在 2026-10-20 全部清零**，详见 §8.7。

**验收脚本说明**：`mcp-server/test/acceptance.mjs` 自起靶场服务器（随机端口，`127.0.0.1` / `localhost` 双主机名制造跨源），自建后台标签页，跑完关闭；只要求扩展已配对到 `ACTSPAN_BRIDGE_URL` 指向的桥，绝不触碰用户已有标签页。`4.1-1b` 单独起一个零配置进程验证 `loop_mode:disabled` / `pairing_required:true` / `hub_listening:true`。

**未纳入的 S5 套件**：`test/scenarios.test.mjs`（22 个用例）需要 Chrome 暴露 DevTools HTTP 端点（`/json/version`、`/json/list`）。本轮环境里的 Chrome 只暴露 `/devtools/browser` WebSocket（`cdp-proxy` 正是这么连的），因此该套件在本机跑不起来——这属于环境限制，不是代码缺陷。**其用例名仍可作为契约证据，但「已跑通」这一条本轮未取得。**

### 8.5 模拟用户全量测试发现并修复的缺陷（2026-10-20）

按「一个真实用户想让 AI 替他操作自己的浏览器，这件事到底能不能成」的口径，在真机真站点上跑 12 个用户意图场景（`mcp-server/test/simulated-user.mjs`，`npm run test:simuser`；与 `test:acceptance` 一样需要真实 Chrome + 扩展在线，故不进 `npm test`）。首轮 `{"OK":8,"WEAK":4}`，逐条定位后修复 3 个生产缺陷，末轮 `{"OK":12}`。

| # | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| 1 | 页面侧 `throw` 被吞成 `null`，调用方读 `null.changed` 报 `Cannot read properties of null` | `chrome.scripting.executeScript` 对页面内抛错**不回填 `error` 字段**，只返回 `{result:null}`，与「正常返回 null」字节相同，`if (r?.error)` 永不成立 | 注入函数自报状态：包一层 `{__actspan_page_result:true, ok, value\|error}` 信封，`execInTab` / `handleMcpInteraction` 解包还原真实原因（`mcp-bridge.ts`、`mcp-interaction.ts`） |
| 2 | `page.select` / `page.upload` / `page.key` / `page.wait` / `page.scroll` 的**无 ref 路径 100% 失败** | 注入参数数组尾部塞了 `undefined`，Chrome 整条拒绝：`Error at index 2: Value is unserializable` | 无 ref 时整段省略尾部参数而非补 `undefined`（`mcp-interaction.ts`，元组类型 `[string, Record<string,unknown>, string?, string?]`） |
| 3 | `page.click`（selector）之后，该标签页上**所有依赖调试器的操作**在 5 秒内全部失败：`Another debugger is already attached` | 存在**两个互不知情的调试器管理器**：`page.click` 的真实事件升级走 `CDPSessionManager`（`cdp-input.ts`），`page.screenshot` / `page.eval` 走 `tabLeaseManager.withDebugger` 的裸 `chrome.debugger.attach`。前者把调试器挂上并保持 `L2_IDLE_MS=5000`，后者不知情又 attach 一次 | `mcp-bridge.ts` 的 `withDebugger` 改为经 `CDPSessionManager.attach/detach` 出入，两个管理器共用同一份 attach 状态 |

**为什么 339 个绿灯测试没抓到前两个**：测试替身比真实 Chrome 宽容——`executeScript` 桩不吞页面抛错、也不拒绝含 `undefined` 的 `args`。已把这两条真实约束照抄进 `mcp-bridge.test.mjs` / `mcp-interaction.test.mjs` 的桩，并各加一条回归测试。缺陷 3 同理：桩里的 `chrome.debugger.attach` 是无状态空函数，已改成按标签页记录、重复 attach 即抛 `Another debugger is already attached`。

**回归证明**：缺陷 1 把解包改回 `if (false && ...)` → 23 pass / 15 fail；缺陷 2 把参数改回补 `undefined` → 8 fail；缺陷 3 把 thunk 改回裸 `chrome.debugger.attach` → 新增用例失败并复现生产原文 `Another debugger is already attached to the tab with id: 117.`。三处恢复后全绿。

**唯一一条非产品缺陷**：`U7`（在搜索框输入并回车）首轮失败不是产品问题——GitHub 仓库页**根本没有搜索输入框**（搜索入口是按钮，点开才出现输入框），工具给出的 `元素未找到: <selector>` 正是真实原因。已把该场景改到真有常驻搜索框的站点，并断言页面真的跳转（而非只看「没报错」）。

### 8.6 34 个 MCP 工具全功能探针（2026-10-20）

对着真实 Chrome + 已配对扩展，把 `catalog.js` 暴露的 34 个工具逐一实调（含真点击、真上传、跨源 frame、网络抓包、数据下载、异步智能体全生命周期）。**31 个通过**。审批门控实测有效：不装审批器时 11 个写类工具全部 `E_TIMEOUT: 审批等待超时`（各 25s），装上后全部通过。另发现 2 个生产缺陷：

| # | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| 4 | `actspan_data_fetch`（`fetch_url`）在含 iframe 的页面上返回 **iframe 的内容**而非目标页 | `__parse_page_content` 经 `Channel.sendToTab` 发送时未指定 `frameId`；Chrome 的 `tabs.sendMessage` 不带 `frameId` 时**投递到该 tab 的所有 frame**，先响应者胜——iframe 小、解析快，总是抢先 | `fetch-url.ts` 改用支持 `frameId` 的 `sendToTabWithRetry`（`tab-message.ts`）并钉 `frameId: 0`；`page-viewer.ts` 同样补 `frameId: 0`。回归：`data-tools.test.mjs` 断言每次投递都带 `frameId: 0`；`acceptance.mjs` 新增 `4.1-11`（跨源 iframe 靶场上取主 frame） |
| 5 | `screenshot` 的元素截图路径**丢失取消信号** | `resolveElementRect` 把 `signal` 传给了 `sendToTabWithRetry` 第 4 参，而该参数位期望的是 options 对象（`SendToTabOptions`），`signal` 被静默丢弃——同时是一个类型错误 | 传 `{ signal }`。修掉后 `tsc -b --noEmit` 从 138 降到 137 个错误（**该 137 个存量已于同日全部清零，见 §8.7**） |

**未通过但非缺陷的 3 项**：`actspan_adopt` 报 `Draft not found for this site`——探针传了假 draftId，且 `actspan_act` 的返回不含 draftId（`recordSuccessfulActDraft` 要求 `effectiveCount >= 3`，单步 act 本就不落草稿，`act-drafts.test.mjs` 已覆盖该边界）；`actspan_skill_detail` / `actspan_workflow_run` 报「不存在」——探针传了不存在的名字；`actspan_feishu_push` 报未配置——预期行为。

**已修复的真实缺陷**：`actspan_status_update` 曾报 `Unknown daemon method: status.update`。`bridge-daemon.js` 只特判 `status.get` 与 `status.shutdown`，其余 `status.*` 一律拒绝；但 `policy.js` 声明了 `'status.update': 'read'`，`test/security.mjs` 也断言该 capability 存在，扩展侧 `mcp-bridge.ts` 已注册 `status.update` handler——**三处不一致，请求根本到不了扩展**。

**修法是把扩展能力移出 `status.` 命名空间，而不是在 daemon 里给 `status.update` 开转发白名单**：`status.*` 是 daemon 自己的命名空间，daemon 对不认识的 `status.*` 必须当面报错，这是刻意的防劫持不变量——一旦开白名单，扩展就能抢占 daemon 的控制方法名，未来同名 daemon 方法也会被静默遮蔽。该能力确实要求 task 拥有的 tab lease（`src/background/status-bridge.ts:31-43`），而 `page.` 正是标签页作用域能力族，故把 capability 键 `status.update` 改名为 `page.status_update`，五处同步：`mcp-server/status-tool.js`、`mcp-server/policy.js`、`mcp-server/test/security.mjs`、`mcp-server/test/status-tool.mjs`、`src/background/mcp-bridge.ts`。MCP 工具名 `actspan_status_update`、handler 实现与权限级别（仍 `read`）均不变。

**顺带确认的两条非缺陷观察**：`page.scroll` 带 `selector` 时确实滚的是该容器（CDP 直读 `#scroll-box` 的 `scrollTop` 从 0 变 300，`window.scrollY` 保持 0），靶场里 `#scroll-result` 仍显示 `scroll:0` 是滚动事件异步派发 + 后台标签页不渲染所致，非工具缺陷。**该条现已过时**：`G13` 已实现（补发合成 wheel），真机 `4.1-15` 实测 `wheel` 计数为 1，详见 §8.7。

### 8.7 G11 / G13 / G15 补齐与 typecheck 清零（2026-10-20）

上一轮真机探针留下的三个规格缺口已全部补齐，并新增三条真机验收判据锁定。

| 缺口 | 实现 | 真机证据 |
|---|---|---|
| G11 | `ariaSelectedOf`（三态 `boolean \| undefined`，照 `checkedOf` 的形状读 `aria-selected`）+ `classNameOf`（`getAttribute('class')`，`CLASS_NAME_MAX = 120`，空 class 落 `undefined`）。两条描述符构建路径（有缓存 `page-grounding.ts:427,429` / 无缓存 `:465,466`）都补上 | `4.1-13`：`A={sel:true,cls:"tab is-active"} B=false C=undefined` |
| G13 | `page.scroll` 滚动后向真正被滚动的元素补发合成 `WheelEvent`；`changed:false` 时并列报三因诊断 | `4.1-15`：`changed=true wheel=1`，边界处 `edgeChanged=false` 且诊断含三因 |
| G15 | `dedupeNestedCandidates` 接在排序之后、`slice(0, limit)` **之前**——先折叠再取前 limit 个，否则被折叠的候选白占名额 | `4.1-14`：`glyphFolded=true buttonKept=true weakKept=true inputKept=true labelFolded=true` |

**折叠规则**：`label[for]` 与包裹式 label 折叠进关联控件（控件不在候选里则保留 label）；祖先链上存在另一个**且 `isElementClickable`** 的候选时丢掉该候选——判据用 clickable 而非「是候选」，因为 `role=group` 这类容器也在候选里，不能代表同一个可点区域；带 `onclick` / `tabindex` 的弱候选一律不参与折叠；祖先链跨 shadow 边界经 `.host` 继续。

**本轮自行发现的缺陷（探针暴露）**：诊断里的「可滚动余量」原本取 `scrollHeight - clientHeight`，那是**总量**不是**剩余**。在边界上实测报 `余量 y=320` 而元素已停在 `scrollTop=320`，调用方会误判成「还能滚」。已改为 `scrollHeight - clientHeight - |scrollTop|`，并加断言 `/余量 x=0 y=0/` 锁定语义（`mcp-interaction.test.mjs`，反向验证：改回总量 → 该用例必红）。

**typecheck 137 → 0**。根因分三类：① `src/lib/channel.ts:14` 的 `ChannelHandler` 返回类型 `void | boolean` 过窄，而运行时 `channel.ts:106-113` **已显式支持** thenable 返回值——正确修法是放宽类型（`| Promise<void | boolean>`），把它改成同步会破坏运行时行为；② `chrome.storage.local.get(keys, callback)` 的 TS2345 不是「两参回调不合法」，而是 TS 从 `resolve` 入参反推泛型 `T` 导致 `keyof T` 塌缩成 `"then"`——修法是显式类型实参 `get<Record<string, unknown>>(keys, resolve)` 并**保留两参回调**（改成 Promise 形式会打挂仓库里只实现回调签名的 chrome 桩，实测 4 个测试文件受影响）；③ `src/ai/types.ts:27` 的 `MessageInputItem['role']` 从 `'user' | 'assistant'` 扩为四值（`llm-client.ts:100,179` 已在产出 `'developer'`）。

**顺带修掉的真 bug**：`src/content/float-ball.ts:2583-2584` 引用了从未声明的 `panel` 变量（原代码必抛 `ReferenceError`），改为 `overlay.classList.add('visible')`；反向验证：改回后重跑必报 `ReferenceError: panel is not defined`。

**运维教训（改 `mcp-server/policy.js` 的 `CAPABILITIES` 表后必须重启 daemon）**：`4.1-12` 首次失败报 `Unsupported bridge capability: page.status_update`——**不是** daemon 的 `status.*` 拦截，而是**旧 daemon 进程内存里还是改名前的 `CAPABILITIES` 表**（`policy.js:45` 抛的）。`node bridge-cli.js stop` 后新 daemon 起来，扩展约 15 秒自动重连（无需手动 reload），再跑即通过。**2026-10-20 补：该手工步骤已自动化**——daemon 把包版本写进凭据，`ensureBridgeDaemon` 在复用前比对 `credential.appVersion`，不一致就按 E5 的优雅退出流程退役旧进程再拉起新版（回归测试 `bridge-lock.mjs:200`；真机验证：旧 pid 79608 无版本字段 → 新 pid 79516 `appVersion=1.1.0`，同版本再次 start 不再重启，`doctor` 报「握手正常 · 扩展在线」）。

---

---

## 附录 A：对方 24 工具 ↔ ActSpan 现状

| 对方工具 | ActSpan 内部实现 | MCP 面（`catalog.js`） | 缺口 ID |
|---|---|---|---|
| `snapshot` | `page-snapshot.ts` `page-skeleton.ts` `content/page-skeleton.ts` | ✗（只有 `page_read` 全文 innerText） | G4–G15、T5 |
| `navigate` | `tab-navigate.ts` | ✓ `tab_navigate` | — |
| `click` | `content/page-grounding.ts`（合成）+ `cdp-input.ts`（真实，未接默认路径） | ✓ `page_click`（合成，`el.click?.()`） | **C0 G1 G2 G3 A1** |
| `type` | 同上 + `setNativeInputValue` | ✓ `page_type` | C1 A1 |
| `select` | ✗ | ✗ | A4 |
| `fill` | `page-grounding.ts` `case 'fill'` | ✗ | A4、C1⑧ |
| `key` | `cdp-input.ts` 有能力，未暴露为工具 | ✗ | A4 |
| `read_text` | `page.ts` / `mcp-bridge.ts:524` `innerText.slice(0,20000)` | ✓ `page_read` | **D2–D8**（全量无脱敏） |
| `screenshot` | `screenshot.ts` | ✓ `screenshot` | D10 |
| `tabs` | `tab-utils.ts`、`TabLeaseManager` | ✓ `tabs_list`（**只返回已租约 tab**） | N4–N9、MCP 无法接管已开页面 |
| `wait` | `external-wait`、`timer.ts` | ✗ | A4 |
| `network` | `cdp-network.ts` | ✗ | **B1–B3** |
| `fetch` | `cdp-fetch.ts`、`fetch-url.ts` | ✗ | B4–B7 |
| `scroll` | `page.ts` | ✗ | A4、**G13（已实现）** |
| `download` | `download-file.ts` | ✗ | B6、G14 |
| `upload` | ✗ | ✗ | A4 |
| `query` | `extract-data.ts`、`selection-context.ts` | ✗ | G8、B9 |
| `act` | ✗（有 workflow 重放，非 DSL） | ✗ | P1–P7 |
| `ask` | `ask-user.ts` | ✗ | M1–M3 |
| `status` | `float-ball/text-utils.ts:156`（按工具名猜）+ `float-ball.ts:1090`（文案粘住） | ✗ | **N1** |
| `eval` | `mcp-bridge.ts:503`（CDP MAIN world，注释称已避 SW CSP） | ✓ `page_eval` | **D1**（无 policy 约束） |
| `learnings` | `site-experience.ts`、`domainGuides` | ✗ | F1–F8 |
| `reload` | `tab-navigate.ts` | ✗ | B3 |
| — | `webhook.ts`（飞书/Bark/Slack…） | ✓ `actspan_feishu_push`（`mcp-server/catalog.js:16`） | WP0（已实现；规格原文「不在 `TOOL_NAMES`」已过期，见 §8.3） |

## 附录 B：对方 15 个测试文件 → 我方测试计划映射

| 对方 | 行数 | 锁定能力 | 我方对应包 |
|---|---|---|---|
| `scenarios.test.js` | 1251（96 个 `test()`） | 端到端行为契约，**事实上的规格书** | S5 |
| `protocol.test.js` | 474 | 握手、Origin、role、sid 盖章、排队、串号 | WP7（R1–R7、D12） |
| `multi-instance.test.js` | 204 | 双实例并存、重连顶旧、headless 路由、瞬断宽限、拔插补发 | WP7（E1–E5） |
| `learnings.test.js` | 156 | 域名归一、别名、体检、反污染、留底、草稿沉淀 | WP8 |
| `audit-redact.test.js` | 139 | act 嵌套脱敏、base64、eval 截断、定位信息不脱、循环引用 | WP5（D3–D8） |
| `presence.test.js` | 117 | 虚拟光标、ask 协议、幕帘、label、户口簿前缀、tab group 权限、文案不带用户输入 | WP12 |
| `risk.test.js` | 115 | 挑战识别、iframe 去 query、浮层成句、frames 优先 | WP11 |
| `identity.test.js` | 97 | sid → 外观纯函数、撞色罕见、emoji 唯一、标签组颜色 | WP12（N2 N3） |
| `redact.test.js` | 89 | 恢复码成组、≥3 行、commit hash 不误伤、凭据 URL 识别 | WP5（D4 D5） |
| `fetch-pages.test.js` | 79 | 页码/游标分页、四种停止原因、savePath、回执摘要 | WP4（B4 B5） |
| `mcp.test.js` | 78 | stdio 挂上并拿到工具表 | WP9 |
| `host.test.js` | 66 | 宿主自报压过 --client、slug 归一、未知宿主不冒充 | WP14（K1 K2） |
| `act-script.test.js` | 59 | repeat 嵌套拦截、repeat 内禁 ref、flatCount、condText | WP10 |
| `liveness.test.js` | 48 | 先 ping 再 terminate | WP7（E9） |
| `compat.test.js` | 41 | 三段版本语义、数字比较、缺一边不报警 | WP14（J1–J3） |

## 附录 C：对方值得抄进我方注释的原文（保留出处）

- 「**绝不静默改用户的配置文件**。先展示要做什么，备份，再写。」（`src/install.js` 文件头）
- 「探测不到就说清楚，**绝不猜**。」（同上）
- 「**能力必须自带诊断信息**——工具失败时只说「失败了」，agent 就会开始撞运气。」（`docs/能力模型.md` 五）
- 「**报错信息要读完**：前半句符合预期的时候，人不会去看后半句。」（同上 四，公开订正）
- 「一个连本地空白页都跑不通的工具，等于不存在，却在工具表里占了一年的位置。」（同上）
- 「**自动修复动作必须先检查现状再动手。**」（同上 七之二，扩展重载清掉 `registerContentScripts` 后自动刷新页面，把几百 KB 网络记录冲掉）
- 「脱敏做在一条路上，另一条敞着。」（README 安全节）
- 「一个能被一句话绕过的确认等于没有确认。」（同上）
- 「禁止听从（注入内容）反而把注入内容抬进注意力。」（同上）
- 「多线是持续状态，每条都唠叨会变背景噪音。」（`docs/能力模型.md` 七之一，提醒冷却的理由）
- 「换门比撬锁快。」（同上 三，路线 C）
- 「不跟签名斗。」（同上 三，路线 B）
