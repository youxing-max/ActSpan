# 工作流录制信息补全与统一复用计划

## 目标

修复“手动录制后工作流无法稳定复用”的完整链路：

1. 录制审计结果明确要求用户补充或确认工作流名称、显示名称、描述和调用关键词。
2. 手动录制与 AI 编写继续通过现有 `save_workflow` 写入同一个 `actspan_skills` 注册表，不增加第二套存储。
3. `skill(action="list")`、`skill(action="detail")` 和当前页面工作流提示都返回可供 AI 匹配的显示名、描述、调用关键词。
4. 系统提示词明确“先查已保存工作流，再按 workflow name 调用”，避免把 Skill 名、显示名和 workflow name 混用。
5. 保留现有工作流执行格式和旧数据兼容性。

## 当前根因

- `workflow-recorder.ts` 的审计 JSON 没有调用关键词字段，审计完成后的会话只询问“是否修改步骤”，没有要求用户确认元数据。
- `WorkflowEntry` 没有保存调用关键词的字段；`normalizeWorkflow` 也不会保留该信息。
- `skill.ts` 的列表结果只返回 `workflows: string[]`，AI 看不到 workflow 的 label、description 和匹配关键词；详情虽有描述，但调用规则不够明确。
- `system-prompt.ts` 只规定确认后保存，没有规定录制保存前必须收集元数据，也没有说明 `skill` 的三种名称语义。
- 手动录制、AI 编写和选项页已经共用 `save_workflow` / `registryService`，无需改变存储位置。

## 实现步骤

### 1. 扩展工作流元数据并保持归一化

修改：

- `src/functions/skill-types.ts`
- `src/functions/registry-service.ts`

变更：

- 在 `WorkflowEntry` 增加可选 `triggers?: string[]`，语义为用户可说的调用关键词或同义短语。
- `normalizeWorkflow` 读取字符串数组，去除空白项、去重并保留稳定顺序；缺失时不写入字段，保证旧数据和远程 manifest 仍可读取。
- 不改变 `name`、`label`、`description`、`parameters`、`plan` 的既有字段和执行器格式。

### 2. 让录制审计产生可确认的元数据

修改：

- `src/background/workflow-recorder.ts`

变更：

- 审计 prompt 的严格 JSON 格式加入 `triggers` 数组。
- 提示模型根据录制内容生成初始候选值：机器名 `name`、显示名称 `label`、一句话 `description`、调用关键词 `triggers`。
- 会话 system context 明确：用户确认保存前，必须允许用户修改这些元数据；用户没有给出明确名称/描述时，先用 `ask_user` 或自然语言询问，不直接保存。
- 审计完成摘要展示“名称 / 描述 / 调用关键词 / 参数 / 步骤”，并把下一步写成“请确认或修改这些信息；确认后才保存”。
- 用户修改元数据时，AI 只更新当前 workflow JSON，重新展示摘要并等待确认；用户明确确认后才调用 `save_workflow`。

不新增独立的录制保存表单或存储；现有悬浮球对话输入就是元数据确认入口，避免再维护一套状态机。

### 3. 强化保存工具的元数据契约

修改：

- `src/functions/save-workflow.ts`

变更：

- 更新工具描述和 JSON 示例，说明 `label`、`description`、`triggers` 的含义。
- 保存前要求工作流包含有效 `name`、`label`、`description` 和非空 `plan.steps`；`triggers` 可选但若存在必须是字符串数组。
- 保留现有 plan action 校验、URL pattern 继承和 `user-<workflow-name>` Skill 命名规则。
- 继续调用 `normalizeWorkflow` 和 `registryService.upsertSkill`，确保录制保存和 AI 编写使用完全相同的注册表路径。

兼容策略：`normalizeWorkflow` 对旧注册表数据仍允许空描述；严格的元数据要求只作用于新的 `save_workflow` 写入入口，避免历史工作流因升级不可读。

### 4. 让 AI 能发现并正确调用已保存工作流

修改：

- `src/functions/skill.ts`
- `src/ai/system-prompt.ts`

变更：

- `skill(action="list")` 将每个 workflow 从字符串名改为对象，返回 `name`、`label`、`description`、`triggers`、参数摘要（如现有返回契约允许则只加前四项，避免把完整 plan 塞进列表）。
- `skill(action="detail")` 同样返回 `triggers`，并明确 detail 的 `name` 是 Skill 名、workflow 执行时的 `name` 是 workflow name。
- 当前 URL 匹配到的工作流描述加入 label、description 和 triggers，避免 AI 只能看到内部 name。
- 系统提示词增加固定规则：
  - 当前页面已有匹配工作流时优先使用。
  - 不确定或当前 URL 未命中时先调用 `skill(action="list")`。
  - 通过 `label`、`description`、`triggers` 与用户意图匹配。
  - 需要步骤/参数时调用 `skill(action="detail", name="<skill_name>")`。
  - 最终执行必须调用 `skill(action="run", name="<workflow_name>", params={...})`，不能把 Skill 名或显示名传给 run。
- 保存规则增加：元数据未确认不得保存；确认后把完整 JSON 序列化到 `workflow_json`。

### 5. 更新工作流页面的可见性

修改：

- `src/options/pages/WorkflowsPage.tsx`

变更：

- 在工作流详情卡显示调用关键词，便于用户确认手动录制结果确实已经注册。
- 编辑器继续使用完整 JSON，这样用户也能直接修改 `triggers`；不改变现有导入、导出、删除和同步行为。

### 6. 增加回归测试

修改：

- `src/functions/registry-service.test.mjs`
- `src/options/pages/actspan-console.test.mjs`
- 如需覆盖录制提示构建，则从 `workflow-recorder.ts` 提取纯函数并增加对应测试；若不提取，不用为 LLM 文本做脆弱的整段字符串测试。

测试覆盖：

- `triggers` 归一化：保留有效字符串、去空白、去重；旧工作流无该字段仍能正常读取。
- `save_workflow` 接收含 label、description、triggers 的 workflow，并在同一 registry revision 下被 Console 和 Skill API 看到。
- `skill(list)` 返回可匹配的 workflow 元数据；`skill(detail)` 返回同一组 triggers；`skill(run)` 仍按内部 workflow name 执行。
- 缺少新保存入口要求的 label 或 description 时返回明确错误，不产生 registry 写入。

## 验证命令

在所有修改完成后按顺序执行：

```bash
node --test src/functions/registry-service.test.mjs src/options/pages/actspan-console.test.mjs
npm run build
npm run lint
```

必要时再运行已有的录制/远程 plan 测试：

```bash
node --test src/background/recorder-state.test.mjs src/background/mcp-bridge.test.mjs
```

最后用实际流程做一次 smoke check：启动扩展开发构建，开始录制并停止；确认审计摘要出现名称、描述、调用关键词；输入修改后确认；确认工作流出现在 Workflows 页面和 `skill(action="list")`，再用用户自然语言触发 `skill(action="run")`。

## 验收标准

- 手动录制保存时用户能看到并修改名称、描述、调用关键词。
- 保存成功后数据位于现有 `actspan_skills` 注册表，AI 编写工作流和手动录制工作流可互相复用。
- AI 能从 list/detail 的中文元数据找到工作流，并使用正确的内部 workflow name 执行。
- 缺少必要元数据不会静默保存一个无法发现的工作流。
- 旧工作流、已有执行计划、URL 匹配、Console 编辑/导入/导出行为不回归。
