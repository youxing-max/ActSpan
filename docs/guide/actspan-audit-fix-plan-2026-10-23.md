# ActSpan 代码审计修复方案（2026-10-23）

来源：ponytail-audit 多 agent 审计（4 个并行 reviewer + 主会话复核）。
验证基线：`npm run typecheck` ✅；`node --test` 515/521 通过；失败的 6 个全部集中在 `src/functions/remote-workflow-approval.test.mjs`（审批契约）。
范围约定：本文档只做修复方案，不改代码。每条给出最小修复与验收方式。

---

## Must fix（正确性 / 安全 / 数据）

### 1. plan 执行引擎缺逐步审批，审批测试长期红

> ⚠️ **2026-10-23 superseded**：审批机制已整体移除（用户决策，见 `docs/spec/actspan-free-mode-spec.md`）。本条"修复方案"不再适用——`remote-workflow.ts` 的步骤循环不补审批，相关测试已重写为自由化语义。

- **位置：** `src/functions/remote-workflow.ts` `runRemotePlan`（约 L520–660 的步骤循环）；测试 `src/functions/remote-workflow-approval.test.mjs`。
- **现状：** `runRemotePlan` 从循环头到尾没有调用 `requestConfirmationFunction`；`skill.ts` 只在入口对"含风险步骤的 plan"做一次粗审批，`mcp-bridge.ts`/`tool-executor.ts`/`cdp-input.ts` 各有兜底，但 `resident-runtime.ts:243` 和 `workflow-handlers.ts:213` 是裸调 `executeDebugRemotePlan`。
- **修复（最小）：** 在步骤 `runner.execute` 之前加一段：
  ```ts
  if (isRiskyPlanStep(step)) {
    const approval = await requestConfirmationFunction.execute(
      { message: `工作流「${workflow}」第 ${index + 1} 步请求执行 ${step.action}${step.params?.action ? `(${step.params.action})` : ''}：${step.note || ''}`.slice(0, 400) },
      { tabId: runtimeTabId, signal: context?.signal, sessionId: context?.sessionId, taskId: context?.taskId },
    );
    if (!approval.success || approval.data?.approved !== true) {
      return { success: false, error: approval.data?.userMessage || '用户未批准工作流步骤' };
    }
  }
  ```
  `isRiskyPlanStep` 已在 `skill.ts` 中存在，抽到 `remote-workflow.ts` 或新建 `plan-risk.ts` 共用。被拒不进入 `retry` 循环（直接 return）。
- **验收：** `node --test src/functions/remote-workflow-approval.test.mjs` 7/7 通过。

### 2. MCP bridge WebSocket 无帧大小上限
- **位置：** `mcp-server/bridge.js:112`。
- **修复：** `new WebSocketServer({ host: '127.0.0.1', port, maxPayload: 1024 * 1024 })`。
- **验收：** `mcp-server/test/security.mjs` 增加一条：发 >1MiB 帧后连接被关闭且 daemon 不崩。

### 3. `page.read` 未脱敏原始 HTML/text 给模型
- **位置：** `src/content/page-grounding.ts:1266-1275`。
- **修复：** read 分支在 `outerHTML` 返回前过一遍与 snapshot 相同的脱敏：剥 `value="…"` 属性、跳过 `input[type=password]`/`[type=hidden]` 子树。优先复用已有 `sanitizeElementValue`/redact 工具，不要新写一份。
- **验收：** `page-grounding.test.mjs` 加用例：含 `<input type=password value="hunter2">` 的节点 read 后输出不含 `hunter2`。

### 4. SSRF guard 漏保留网段
- **位置：** `src/lib/ssrf-guard.ts:5-12`。
- **修复：** 在 `isPrivateIPv4` 补 `100.64.0.0/10`、`192.0.0.0/24`、`198.18.0.0/15`、`240.0.0.0/4`；`isPrivateIPv6` 补 `fec0::/10`；IPv4-mapped IPv6 复用同一 `isPrivateIPv4`（现状已是，补完自动覆盖 `::ffff:100.64.x.x`）。
- **验收：** `ssrf-guard.test.mjs` 补边界用例 `100.64.0.1`、`100.127.255.254`、`198.18.0.1`、`240.0.0.1`、`[::ffff:6440:1]` 均被拦。

### 5. LLM 调用无重试，瞬时 429/5xx 整任务报废
- **位置：** `src/ai/llm-client.ts:290-296`（`chatComplete` 与 `chatStream` 各一份）。
- **修复：** 对 429 与 5xx 做最多 3 次指数退避（500ms → 1s → 2s），4xx（非 429）不重试；尊重 `Retry-After`。流式在拿到第一个 chunk 前失败才可重试，拿到后失败不重试（避免重复输出）。
- **验收：** `llm-client.test.mjs` 用 fake fetch 模拟 429→200，断言最终成功且调用次数为 2。

### 6. `performAutoCompact` 吞 abort
- **位置：** `src/ai/core-loop.ts:354-357`。
- **修复：** `catch (err) { if (signal?.aborted) throw err; return null; }`。
- **验收：** 现有 `core-loop.test.mjs` 补一条：compact 中途 abort，循环立即终止、不再发 LLM 请求。

### 7. 审查 agent 解析失败默认"通过"
- **位置：** `src/ai/review-agent.ts:99-101` 与函数尾部 `return { passed: true }`。
- **修复：** 找不到 `审查结果：` 结论行时 `return { passed: false, feedback: '审查输出缺少结论行' }`；显式"通过"才返回 true。
- **验收：** `review-agent.test.mjs` 加"输出为空/无关文本 → passed:false"。

### 8. bridge pending 限流算错，全局 64 被多客户端稀释
- **位置：** `mcp-server/bridge.js:470` 与 `bridge-daemon.js:8`。
- **修复：** 把 64 预算改为按 `clientId` 维度限（如每客户端 `min(32, 64 / clients.size)`），或 daemon 侧固定每客户端 32 + 全局 64 双闸门同时生效（取先触发者）。保留离线 16 的队列上限，提为具名常量 `MAX_OFFLINE_QUEUE`。
- **验收：** `bridge.test.mjs`（或新增）模拟 3 客户端各发 30 条在途，断言第 91 条被拒且错误指向超限的客户端而非全员。

### 9. `__session_clear` / `__ai_cancel` 不回复 content script
- **位置：** `src/background/session-channel-handlers.ts:731-758`。
- **修复：** 两个 handler 把 `sendResponse` 透传进 op，在 `handleSessionClearOp`/`handleSessionCancelOp` 完成时 `respondSessionOp`，并 `return true`（异步响应）。
- **验收：** content 侧 `Channel.send('__session_clear', cb)` 在 1s 内收到响应。

### 10. alarm 模式定时任务在扩展重载后永久哑火
- **位置：** `src/background/timer-dispatch.ts:211-233`。
- **修复：** restore 时对 `scheduleMode !== 'runtime'` 且 `nextRunAt <= Date.now()` 的任务直接 `handleTimerTrigger` 补触发（或 `chrome.alarms.create(name, { when: Date.now() + 1 })`）；`nextRunAt` 在未来的重建 alarm。
- **验收：** `timer-dispatch` 测试补一条：存储中 `nextRunAt` 已过期的 alarm 任务在 restore 后触发一次。

---

## Should fix（高风险缺测试 / 真慢 / 重复）

11. **审批 Set 无清理无过期** — `policy-executor.ts:51,86-88`：改为 `Map<key, { capability, expiresAt }>`，execute 时校验一次性 + 过期（如 5 分钟），任务终态时清扫。
12. **bridge 日志脱敏漏 `pairingSecret`** — `bridge.js:36-41` 关键词加 `pairingSecret|pairSecret`。
13. **bot 连接失败无退避** — `feishu-bot.js` / `dingtalk-stream.js`：`lastConnectFailure` 时间戳，30s 内不重连并把错误回给用户。
14. **钉钉 `sessionWebhookExpiredTime` 类型** — `dingtalk-stream.js:331`：`Number(x)` 为 `NaN` 时回退 `Date.parse(String(x))`。
15. **`microCompact` 原地改 output，checkpoint 拿到空壳历史** — `context-manager.ts:213-227` + `core-loop.ts:279-286`：`emitCheckpoint` 时深拷贝 context。
16. **daemon 响应去重竞态** — `bridge-daemon.js:147`：`client.requests.delete(id)` 移到 `socket.write` 回调里。
17. **会话历史 quota 失败被静默吞** — `session-history.ts:455-468`：连续失败 N 次后向 UI 广播警告，日志带 sessionId。
18. **bot 公共代码去重** — `dingtalk-stream.js` 与 `feishu-bot.js` 的 ~120 行复制（`ActspanSession`/`splitReply`/`extractTaskText` 等）抽 `bot-common.js`，#13/#14 只需改一处。

## Nice to have

19. **`send_message` 假工具** — `tool-executor.ts:347`：要么实现，要么从 agent 工具 schema 移除（避免模型浪费轮次）。
20. **markdown favicon 泄露域名给 Google** — `float-ball/markdown.ts:~121`：去掉 favicon 或换 `chrome.runtime.getURL` 本地图标。

另约 15 条更小发现见各 agent 原始报告（`agent://AuditMcpServer`、`agent://AuditAiLoop`、`agent://AuditContentLib`、`agent://AuditBgPeriphery`）。

---

## 验收总口径

- 全部修完后：`npm run typecheck` ✅、`node --test` 全绿（含 `remote-workflow-approval` 7/7）、`npm run build` ✅、`node mcp-server/test/security.mjs` ✅。
- 每条 Must fix 必须带一个会"改坏就红"的回归测试；Should fix 至少补一条断言；Nice to have 不加测试。

## 执行顺序建议

1. **第一批（安全/数据）：** #1、#2、#3、#4。
2. **第二批（可靠性）：** #5、#6、#7、#9、#10。
3. **第三批（负载/卫生）：** #8、#11–#18。
4. **清扫：** #19、#20。

未检查项（修复时如需再读）：`session-manager.ts` / `mcp-bridge.ts` 仅读了高风险段；`src/functions/` 其余、`options/`、`sidepanel/` UI 未逐行审；`ACTSPAN_LIVE=1` 真浏览器套件未运行。
