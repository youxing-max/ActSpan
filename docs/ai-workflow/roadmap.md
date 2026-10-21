# 路线图 · ActSpan 审计修复

依据：`docs/spec/actspan-audit-fix-spec.md`（FR-1~FR-7）
方法论：`ai-workflow-plan`（垂直切片 + blocking edges + Given/When/Then 验收 + prefactoring）

## 里程碑

| ID | 里程碑 | 演示验收（demo） | 状态 |
|---|---|---|---|
| M1 | 文档一致性闭环 | check-tool-docs.mjs 对 MCP-BRIDGE/README 退出码 0；全仓无 stale「18 个工具」 | planned |
| M2 | 可测性 | 悬浮球确认卡片 Playwright 可达；npm test 覆盖 scenarios；pending 超时驱逐有测试 | planned |
| M3 | 状态基础设施 | validate_state.py 全绿；gap-matrix 契约证据行有对应 evidence | planned |
| M4 | 部分实现清尾 | D10/D11/D12 各有回归测试；其余 partial 已补齐或归档 | planned |

## 切片地图

- **M1（文档）**
  - Wave 1：T001 工具清单一致性校验脚本（prefactoring，单一事实源）
  - Wave 2：T002 MCP-BRIDGE · T003 README · T004 guide/plan 两份 spec（均 blockedBy T001，用脚本验收）
- **M2（可测性）**
  - Wave 1：T005 shadow open · T006 删 legacy · T007 pending 超时 · T008 CI（writeScopes 互不相交）
- **M3（状态基础设施）**
  - Wave 1：T009 state 套件 · T010 evidence 外化
- **M4（部分实现清尾）**
  - Wave 1：T011 D11 · T012 D10 · T013 D12 · T014 其余分诊（T014 blockedBy T009）

依赖边：T002/T003/T004 ← T001；T014 ← T009。

## Out of Scope（本项目不做）

见 `docs/spec/actspan-audit-fix-spec.md`「Out of Scope」：
不新增产品功能；不改 34 工具行为语义（FR-3 超时驱逐除外）；不碰 AGPL/控制面/配对 UI；不把契约证据伪装成跑通。

## 遗留问题登记

（每个里程碑收口时追加：未做完的事显式留档，不许悄悄消失）

## 数据复盘

（每个里程碑上线后追加：跟踪指标、回看时间、结论）
