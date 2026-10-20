# 录制工作流 AI 元数据实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让录制审计 AI 稳定生成并修正工作流 `name`、`label`、`description`、`triggers`，在用户明确确认前只展示草稿、不保存。

**Architecture:** 保留现有 `workflow-recorder.ts -> chatComplete -> createSession -> save_workflow` 链路。把录制审计 prompt 提取为可测试的纯函数，系统提示词负责后续对话中的元数据自动修正与确认门禁；不新增存储、表单或第二套工作流模型。

**Tech Stack:** TypeScript、esbuild、Node `node:test`、现有 OpenAI Responses API 客户端。

**Spec:** `docs/superpowers/plans/2026-10-18-workflow-recording-reuse.md` 第 36-50、113-136 行及本轮已确认设计。

## Global Constraints

- 所有 AI 对话、用户可见文案和代码注释使用中文。
- `name` 必须是稳定的英文 snake_case 机器名；`label`、`description`、`triggers` 面向中文用户。
- `triggers` 必须是 2-5 个自然语言调用短语，不得用工具名代替用户意图。
- 缺失或低质量元数据优先根据录制步骤、起始 URL 和参数自动推断；只有无法可靠推断时才询问用户。
- 用户未明确确认完整工作流前，禁止调用 `save_workflow`。
- 不改变 `workflow_json`、注册表、工作流 plan action 或既有会话状态协议。
- 只触碰本计划列出的文件；保留当前工作树中的其他未提交改动。
- Agent 只运行本任务聚焦测试；不运行 formatter、lint 或项目级全量测试。

## 文件与职责

- `src/background/workflow-recorder-prompt.ts`：纯函数 `buildRecorderAuditPrompt`，负责录制步骤到 AI 审计契约的 prompt。
- `src/background/workflow-recorder.ts`：调用纯函数，并把审计草稿注入会话；调整缺失字段提示，避免与自动推断规则冲突。
- `src/background/workflow-recorder-prompt.test.mjs`：验证 prompt 明确元数据生成、修正、触发词数量和严格 JSON 契约。
- `src/ai/system-prompt.ts`：补强录制工作流的自动生成、修改、确认规则。
- `src/ai/system-prompt.test.mjs`：验证全局提示词包含自动推断和确认门禁。

## 并行任务

### Task 1：提取并强化录制审计元数据契约

**Files:**
- Create: `src/background/workflow-recorder-prompt.ts`
- Modify: `src/background/workflow-recorder.ts:308-364,407-457`
- Test: `src/background/workflow-recorder-prompt.test.mjs`

**Interfaces:**
- Produces `buildRecorderAuditPrompt(cleanSteps: Array<Record<string, unknown>>, startUrl: string): string`。
- `workflow-recorder.ts` 继续传入去除截图内部字段的 clean steps，审计返回 JSON 结构不变。

- [ ] **Step 1: 写失败测试**

测试通过 esbuild 直接导入纯函数，传入一个包含导航、点击和输入的步骤数组，断言返回 prompt 同时包含：`name`、`label`、`description`、`triggers`；英文 snake_case 规则；2-5 个中文调用短语规则；缺失字段先依据步骤自动推断、无法推断才询问；修改后重新展示完整 JSON；严格 JSON 输出；以及 `workflow_json` 不在审计阶段保存。

- [ ] **Step 2: 运行聚焦测试确认失败**

运行：`node --test src/background/workflow-recorder-prompt.test.mjs`

预期：因纯函数文件不存在或导出不存在而失败。

- [ ] **Step 3: 实现最小纯函数并接入录制器**

`buildRecorderAuditPrompt` 复用当前审计 prompt 的步骤/action 约束，并追加以下明确规则：

```text
- 必须根据录制步骤、起始 URL、页面语义和参数，先生成可用的 name、label、description、triggers。
- name 使用稳定、简短、英文 snake_case，体现目标动作和对象，不得使用 workflow、未命名等泛化占位词。
- label 是简洁中文显示名；description 是说明用户最终收益的一句话中文描述。
- triggers 生成 2-5 个用户可能说的中文调用短语，覆盖同义表达，不要填工具名、action 名或选择器。
- 如果任一元数据缺失、空白或不符合规则，先根据已有步骤自动修正，再输出 JSON；只有录制内容确实无法判断目标时才要求用户补充。
- 输出前自检 name、label、description、triggers、parameters、plan.steps 均存在且彼此一致。
```

保持现有 action 映射、变量占位符、参数 schema、readable_steps 和严格 JSON 输出。把 `__recorder_submit` 中的内联 prompt 替换为纯函数调用。会话上下文改为“缺失字段先自动推断修正，确实无法推断才询问”；审计摘要把“未命名/未填写”改为“待 AI 根据步骤补全”，不把占位文本写回 workflow JSON。

- [ ] **Step 4: 运行聚焦测试确认通过**

运行：`node --test src/background/workflow-recorder-prompt.test.mjs`

预期：全部通过。

### Task 2：强化全局工作流确认门禁

**Files:**
- Modify: `src/ai/system-prompt.ts:240-245`
- Test: `src/ai/system-prompt.test.mjs:14-25`

**Interfaces:**
- 保持 `buildSystemPrompt(tools, hasSubtask, domainGuides?, globalCatalog?)` 签名不变。
- 继续使用现有 `save_workflow` 与 `workflow_json` 协议。

- [ ] **Step 1: 写失败测试**

在现有系统提示词测试中追加断言：提示词要求根据录制步骤自动生成/修正 `name`、`label`、`description`、`triggers`；要求触发词为用户自然语言；要求修改后重新展示完整 JSON；仅在无法推断时询问；明确禁止未经确认保存。

- [ ] **Step 2: 运行聚焦测试确认失败**

运行：`node --test src/ai/system-prompt.test.mjs`

预期：新增断言至少有一项失败，因为当前提示词只覆盖确认和保存，不完整覆盖自动修正策略。

- [ ] **Step 3: 最小修改全局规则**

把 `## Saving Workflows` 规则改成以下语义：收到录制审计草稿后，先检查并根据步骤、URL、参数自动补全或修正四项元数据；仅在目标无法可靠推断时用 `ask_user`；用户提出修改后更新同一份完整 workflow JSON 并重新展示摘要；用户明确确认完整内容后才 `save_workflow`，并传入 `JSON.stringify()` 后的完整对象。禁止把“未命名”“未填写”等展示占位文本作为保存值。

- [ ] **Step 4: 运行聚焦测试确认通过**

运行：`node --test src/ai/system-prompt.test.mjs`

预期：全部通过。

## 集成验证

- [ ] 运行 `node --test src/background/workflow-recorder-prompt.test.mjs src/ai/system-prompt.test.mjs`。
- [ ] 运行 `npm run build`，确认 popup、content、sidepanel、background 均构建成功。
- [ ] 检查变更只覆盖本计划文件及计划文件本身，不覆盖当前工作树其他功能改动。
- [ ] 通过代码审查确认：审计阶段只生成草稿；后续保存仍受明确确认门禁保护；没有新增存储或自动保存旁路。

## 验收标准

1. 一次录制审计输出可直接看到机器名、显示名、描述和调用关键词。
2. 元数据不完整或不合规时，AI 优先从录制步骤自动修正；确实无法判断才询问用户。
3. 用户修改任一字段后，AI 使用最新完整 JSON 重新展示摘要。
4. 未明确确认时不会调用 `save_workflow`；确认后仍传递完整 `workflow_json`。
5. 既有录制步骤转换、工作流执行和注册表路径不变。
