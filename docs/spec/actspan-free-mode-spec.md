# ActSpan 自由化模式 Spec

日期：2026-10-23　　状态：**已实施**
决策者：用户明确选择「FULL 移除所有审批门」（含支付/删除目标）。

## 背景

ActSpan 原设计在多层设置人工确认门（approval gate），防止 MCP 客户端误触发敏感动作。实际使用中这些门导致 IDE agent 调用频繁超时（`E_TIMEOUT: 审批等待超时`）、自动化流程被阻断。用户决定全部移除，换取无阻断的自动化体验。

## 决策

**所有审批门无条件移除。** 任何已认证 MCP 客户端可对任意 tab 执行任意动作，含支付提交、删除、表单提交。无确认弹窗、无审批凭证、无支付签名、无信任域。

## 已移除的审批层

| 层 | 位置 | 原机制 | 现状 |
|---|---|---|---|
| 扩展 policy | `src/background/policy-executor.ts` | `requiresApproval` 按敏感/dangerous/interact+tab 判 true → `E_APPROVAL_REQUIRED` | `requiresApproval` 恒 false；approvals Map / `approvalKey` / `sweepExpiredApprovals` / `APPROVAL_TTL_MS` 已删；`approve()` 留 no-op 兼容 mcp-bridge 调用 |
| MCP policy | `mcp-server/policy.js` | `requiresApproval` 同步判 true | `requiresApproval` 恒 false；permission level 保留仅供审计分级 |
| 桥接执行 | `src/background/mcp-bridge.ts` | `executeBridgeRequest` 对需审批能力先 `executor.approve()` | 死代码已删 |
| AI 工具执行 | `src/ai/tool-executor.ts` | `resolveSensitiveApproval` 弹确认 | 返回 null（无审批）；`resetSensitiveAccessTrust` 留 no-op 供 orchestrator/core-loop 调用 |
| CDP 输入 | `src/functions/cdp-input.ts` | `requireSensitiveTargetApproval` 拦敏感目标 | 返回 null 立即放行 |
| 远程工作流 | `src/functions/remote-workflow.ts` | `executeDebugRemotePlan` 逐步审批 | 审批块已删 |
| 技能写步 | `src/functions/skill.ts` | 写步骤审批 | 审批块已删 |
| 页面落地 | `src/content/page-grounding.ts` | `approvalError` 签名复核 | 已删 |
| MCP 交互 | `src/background/mcp-interaction.ts` | `denyPayment` 拦支付提交 | 函数及 4 处调用已删 |
| act 脚本 | `mcp-server/act-tool.js` | `SENSITIVE_BLOCKED`：敏感动作需 `allowSensitive:true` | 门已删；`allowSensitive` schema 保留但标 deprecated no-op（向后兼容） |

## 保留的安全边界（非审批，不动）

| 机制 | 位置 | 理由 |
|---|---|---|
| Captcha 挑战检测 | `mcp-bridge.ts` `assertNoChallenge` | 反自动化检测，非审批 |
| `page.eval` V8 `throwOnSideEffect` | `mcp-bridge.ts:944` | 防任意 JS 副作用，V8 层强制 |
| Tab 租约隔离 | `tab-lease-manager.ts` | 跨任务/会话隔离，防越权写 |
| SSRF 守卫 | `mcp-bridge.ts` `assertSafeNavigableTarget` | 拦 localhost/内网/凭据 URL |
| 审计日志 | `mcp-server/bridge.js` `appendAudit` | 敏感操作仍记录（含 `allowSensitive` 参数透传字段） |

## 风险（用户已知悉并接受）

1. **任意 MCP 客户端可点击支付按钮/提交表单/删除数据，无人工闸。**
2. 恶意或出错的 agent 脚本可造成不可逆操作。
3. 审计日志仍在，但仅为事后追溯，不阻断。

缓解：仅在受信环境运行 MCP server；`ACTSPAN_EXTENSION_IDS` 白名单限制可连接的扩展来源。

## 测试语义变更

原审批契约测试全部重写为自由化语义：

| 测试文件 | 变更 |
|---|---|
| `src/ai/tool-executor-approval.test.mjs` | 已删除（整个文件只测审批） |
| `src/background/mcp-bridge.test.mjs` | 11 条审批断言改为直通断言；workflow 白名单测试 `requiresApproval` 断言全改 false |
| `src/background/task-manager.test.mjs` | 「page writes need approval」→「execute without approval」；「approval is single-use and expires」→「write capabilities repeat freely」 |
| `src/functions/remote-workflow-approval.test.mjs` | 4 条重写为无审批语义 |
| `src/background/mcp-interaction.test.mjs` | 支付 Enter 测试更新 |

**当前状态：459/459 通过。**

## 同步影响的文档

以下旧文档中的审批相关表述已被本 spec 取代（superseded）：

| 文档 | 位置 | 旧表述 | 状态 |
|---|---|---|---|
| `docs/spec/actspan-superset-spec.md` | §1.2 D1/D2、§7 Q2 | 审批门为核心安全契约 | superseded by 本文档 |
| `docs/guide/actspan-workflow-architecture-spec.md` | :439, :443, :553, :571 | 「必须保留显式确认」「MCP 不得绕过确认」 | superseded by 本文档 |
| `docs/guide/actspan-audit-fix-plan-2026-10-23.md` | Must fix #1 | 「plan 执行引擎缺逐步审批」为待修缺陷 | superseded：审批已整体移除，该缺陷不再适用 |

## 验证

- `npx tsc -b --noEmit` 干净
- `node --test src/ai/*.test.mjs src/background/*.test.mjs src/content/*.test.mjs src/functions/*.test.mjs` → 459/459
- 实测（2026-10-23）：34 个 MCP 工具真实连接扩展，无一审批挂起；`tab.open` 秒开（原 `E_TIMEOUT`）；敏感 `act` type 无 `allowSensitive` 直接成功；`tab.close`（sensitive）秒关
