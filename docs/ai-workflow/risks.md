# 风险登记

## 审计发现（2026-10-21 重审计）

| ID | 风险 | 严重级 | 状态 | owner | 缓解/去向 | 日期 |
|---|---|---|---|---|---|---|
| S1 | 文档漂移为线上 bug（18 vs 34） | Major | resolved | agent | T002/T003/T004 已修正 18→34，check-tool-docs 门禁 exit 0 | 2026-10-21 |
| S2 | 旧版悬浮球死代码未删 | Minor | resolved | agent | T006 删除 float-ball.ts + float-ball-focus.test.mjs（float-ball/ 子目录为活代码保留，D002） | 2026-10-21 |
| SP1 | npm test 不含浏览器靶场 | Major | resolved | agent | T008 改造 scenarios 并纳入 npm test | 2026-10-21 |
| SP2 | S5 从未跑通（22 fail / 0 pass） | Major | 缓解中 | agent | T008 改为 3 pass / 19 skip / 0 fail（skip 因 requiresApproval 无人值守审批超时，D003） | 2026-10-21 |
| SP3 | 30+ 条「部分实现」，含 D10/D11/D12 安全三项 | Major | resolved | agent | D10/D11/D12 由 T011/T012/T013 补齐，其余 25 项 D005 归档 | 2026-10-21 |
| ST1 | 审计基础设施缺失 | Major | resolved | 编排者 | T009：validate_state.py + state.json/decisions.md/risks.md 就位，exit 0 | 2026-10-21 |
| ST2 | 证据可信度分级未外化 | Major | resolved | agent | T010 三档标签（已跑通/契约证据/真机）外化到 35 行 | 2026-10-21 |

## 执行期新发现

| ID | 风险 | 状态 | owner | 缓解/去向 | 日期 |
|---|---|---|---|---|---|
| R1 | 删除 legacy float-ball 可能连带遗漏 react 复用 | resolved | agent | T006 侦查确认 float-ball.ts 导出（initFloatBall/focusSearchInputWhenVisible）无 react 复用 | 2026-10-21 |
| R2 | check-tool-docs.mjs 误报/漏报 | resolved | agent | 以 TOOL_NAMES 为唯一事实源，实测漂移/一致/extra 三场景正确 | 2026-10-21 |
| R3 | 7 处文档仍引用已删 float-ball.ts | resolved | agent | S-N1 修复：CLAUDE.md:316 删、development.md:63,195 / en/development.md:63,195 / architecture-spec.md:92 改指 float-ball-react.tsx 与 icons.ts、gap-matrix:189 锚点改 ActspanRoot.tsx；历史计划/规格引用（superpowers/plans:80、superset-spec.md:586 历史 bug 记录）豁免 | 2026-10-21 |
| R4 | test/browser-fixtures.mjs 死代码（connectOverCDP/cdpJson） | resolved | agent | 删除死代码簇 connectOverCDP/cdpJson/evaluateTarget/connectSocket（无 test import，scenarios 只用 createMcpHarness）；Q5 落点改指 createMcpHarness | 2026-10-21 |
| R5 | 悬浮球 shadow open 后进入 page-grounding/page-skeleton 采集候选 | resolved | agent | page-grounding collectDeepElements 与 page-skeleton buildSkeletonTree 过滤 #actspan-root（ActSpan 自身 UI 不进页面语义快照/骨架） | 2026-10-21 |
| R6 | useGlobalEvents.ts:60 过期注释「closed Shadow DOM」 | resolved | agent | S-N2 修复：注释改 closed→open（float-ball-react.tsx:25 已 mode:open） | 2026-10-21 |
| R7 | actspan_tab_close 属 sensitive，无人值守收不掉靶场标签页 | open | agent | 下轮处理：tab_close 保持 sensitive（policy.js:7 / policy-executor.ts:10），待 D003 无人值守审批通道落地后靶场可自动收标签页 | 2026-10-21 |
| R8 | D11 声明值过滤未接线生产调用点 | resolved | agent | SP-B 接线：status-tool.js userInputs schema + status-bridge.ts 透传 → parseStatusUpdate 消费 | 2026-10-21 |
