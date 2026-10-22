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

## Wave 1 修复残留（2026-10-21）

| ID | 风险 | 严重级 | 状态 | owner | 缓解/去向 | 日期 |
|---|---|---|---|---|---|---|
| W1-R1 | task.status/result 带 tabId 终态仍不可读 | Minor | open | agent | 下轮处理（mcp-server 链不触发） | 2026-10-21 |
| W1-R2 | tab-lease disconnected 集合残留可抢占原主存活标签页 | Major | open | agent | 下轮处理：认证帧时 setSessionConnected(true) | 2026-10-21 |
| W1-R3 | gap-matrix.md:180 createStableSessionId 签名文档漂移 | Minor | open | agent | 文档同步任务 | 2026-10-21 |
| W1-R4 | data.fetch_chunk/paginate_page 未自建任务 | Minor | open | agent | 下轮评估 | 2026-10-21 |
| W1-R5 | save_workflow 缺 subAction 不告警 | Minor | open | agent | 另开单 | 2026-10-21 |

## Wave 2 修复残留（2026-10-21）

| ID | 风险 | 严重级 | 状态 | owner | 缓解/去向 | 日期 |
|---|---|---|---|---|---|---|
| W2-R1 | screenshot snapshot_id 未进工具文档（tools.md:14），模型不知需传 | Minor | open | agent | 文档同步任务 | 2026-10-21 |
| W2-R2 | page.skeleton / cdp_dom 等其他出口未过 redactSensitive，仍可能回传明文 value | Minor | open | agent | 另开单（全出口脱敏收口） | 2026-10-21 |
| W2-R3 | 租约续租后长任务持续 authorize 永久持租约；放弃但仍轮询的任务持租约不 lapse | Minor | open | agent | 依赖 release-on-cancel/finish 回收；观察 | 2026-10-21 |

## Wave 3 修复残留（2026-10-21）

| ID | 风险 | 严重级 | 状态 | owner | 缓解/去向 | 日期 |
|---|---|---|---|---|---|---|
| W3-R1 | chat_completions 模式丢弃 input_image（截图退化为文本摘要），多模态 image_url 映射未做 | Minor | open | agent | 后续补齐多模态映射 | 2026-10-21 |
| W3-R2 | 未对真实 Ollama/LM Studio 端点验证（mock fetch 只断言 wire 形状） | Minor | open | agent | 真实端点冒烟 | 2026-10-21 |
| W3-R3 | LLMSettingsPage 描述/endpoint hint 仍写「Responses API」，未随双模式更新 | Minor | open | agent | 文档/文案同步 | 2026-10-21 |

## W4-R1 · T025 tab_navigate keep_alive 租约语义（residual）
- 来源：T025
- 级别：P2
- 内容：open 动作现在 acquire 新 tab 租约，keep_alive 标签页也归任务租约；若未来 agent 路径出现 taskManager.cancel / 扩展重启恢复中断任务，会连带关闭 keep_alive tab。当前 agent 路径无 taskManager.cancel 调用点（取消走 signal + TabTracker.closeAll），故暂不触发。

## W4-R2 · T018 方案 A 落地残留（residuals）
- 来源：T018
- 级别：P2
- 内容：
  1. skill.run 路径（skill.ts:304→runRemotePlan:544）不经 PolicyExecutor，不做逐 step 审批（改动前即如此，与直接调 cdp_input 同语义）。统一需另开单让 skill.run 走 workflow.plan.*。
  2. public/workflows/manifest.json 仍是旧 plan（徽标/press_key/click+selector），但 src 无引用，属遗留数据。
  3. jd/baidu plan 用 cdp_dom.query（白名单只有 query_selector/_all），仍会 E_POLICY_DENIED——「已合规」判断不成立，本次非目标。
  4. cdp_frame 主 frame 返回 result、子 frame 返回 value 不一致，plan 侧显式穿过 .result 规避。
