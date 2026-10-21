# 项目定义

## 目标

把 2026-10-21 三轴审计发现的 6 Major + 1 Minor（文档漂移、可测性、状态基础设施、部分实现）逐条收敛到可验证完成，收口后重跑 `/ai-workflow-review` 至 0 Major。

## 非目标（Out of Scope）

- 不新增产品功能；不改 34 个工具的既有行为语义（网络 pending 超时驱逐除外）。
- 不碰 AGPL 合规、云端控制面 API、options 页配对 UI。
- 不把 S5「契约证据」伪装成跑通——保持诚实分级。

## 成功指标

- `mcp-server/check-tool-docs.mjs` 对 MCP-BRIDGE.md/README.md 退出码 0（文档与 `catalog.js TOOL_NAMES` 一致）。
- `validate_state.py` 全绿。
- 重审计 Blocker=0 且 Major=0。

## 利益相关者与决策 owner

| 决策类别 | owner | 备注 |
|---|---|---|
| 产品取舍/优先级 | 人 | 不可由 AI 代拍 |
| 法务/合规/隐私 | 人 | 不可由 AI 代拍 |
| 资损相关逻辑 | 人 | 不可由 AI 代拍 |
| 发布/灰度/风险接受 | 人 | 不可由 AI 代拍 |
| 技术方案 | 可推荐，人确认 | 如 shadow open vs 数据属性 |

## 参考

- docs/ai-workflow/audits/2026-10-21-testability-and-doc-drift.md
- docs/spec/actspan-audit-fix-spec.md
- docs/ai-workflow/roadmap.md
