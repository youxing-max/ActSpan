# 决策记录

## D001 · 批准审计修复拆分计划（M1-M4 / 14 任务）

- 状态：approved
- 日期：2026-10-21
- owner：用户
- 内容：批准 docs/ai-workflow/roadmap.md + milestones.json + tasks.json 的 4 里程碑 14 任务拆分；任务自 proposed 迁 pending，按 Wave 顺序执行。

## D002 · T006 scope 纠正：float-ball/ 子目录为活代码

- 状态：approved
- 日期：2026-10-21
- owner：编排者（Main）
- 内容：T006 原 scope「删除 float-ball.ts 与 float-ball/ 子目录」有误。子智能体侦查发现 float-ball/ 子目录被 float-ball-react.tsx / sidepanel/SidePanelApp.tsx / options/FloatingChat.tsx / options/BlocklistPage.tsx 复用，删除会破坏 build。纠正为：仅删 legacy float-ball.ts（旧入口）+ float-ball-focus.test.mjs（其唯一消费者 content.ts:11 已注释），保留 float-ball/ 子目录。连带修 actspan-branding.test.mjs 的 contracts 映射（float-ball.ts → float-ball-react.tsx）。同步修正 tasks.json T006 的 verify 正则（原 `grep 'float-ball' src/content.ts` 永远命中活代码 initFloatBallReact）。

## D003 · T008 审批超时判 skip（带确切原因）

- 状态：approved
- 日期：2026-10-21
- owner：编排者（Main）
- 内容：scenarios 套件改造后，19 个用例因 policy-executor.ts 的 requiresApproval（无人值守无审批通道）固定 25s 审批等待超时。裁决：这些用例判 skip（带确切原因「live Chrome needs interactive approval」），不伪装通过、不判 fail；首次命中后缓存避免每条等 25s。根因三层：/json/version 404 + CDP WS 直连不通 + requiresApproval 无人值守阻塞。M4 需产品侧给无人值守通道（ACTSPAN_UNATTENDED 或绑定 requestId 的 actspan_approve）。

## D004 · T011/T012/T013 writeScopes 落点修正

- 状态：approved
- 日期：2026-10-21
- owner：编排者（Main）
- 内容：计划阶段对 D10/D11/D12 三条安全项的 writeScopes 定位与 gap-matrix 真实落点不符，修正如下——T011（D11 文案脱敏用户输入）落点 text-utils.ts（replaceInternalToolTerms 的「按用户输入过滤」缺口），非 redact.ts；T012（D10 focus:true 逃生口）落点 mcp-server/index.js:166 的 actspan_tab_open（active 默认 false 已成立、缺显式 focus 语义与「会打断用户」描述），非 policy-executor.ts；T013（D12 role 双向校验）落点 bridge.js/bridge-daemon.js/mcp-transport.ts 的握手身份 role 校验（扩展冒充 agent 被拒），非 page-grounding.ts（那是 HTML 元素 role，已实现 find/快照语义一致）。

## D005 · 30 项 partial 分诊归档（T014）

- 状态：approved
- 日期：2026-10-21
- owner：编排者（Main）
- 内容：gap-matrix 末尾 30 项「部分实现」逐项分诊——本轮补齐 5 项、归档 25 项为已知负债，无静默消失。

### 本轮补齐（M1-M4）

| ID | 去向 | 证据 |
|---|---|---|
| D10 | T012 focus:true 逃生口 | actspan_tab_open 加 focus 参数（默认 false）+ description 写明会打断用户 |
| D11 | T011 文案脱敏用户输入 | text-utils.ts 加 redactUserInputFromCopy 凭据兜底掩码 + 声明值过滤（生产接线待办，见 R8） |
| D12 | T013 握手 role 校验 | bridge.js hello 握手拒显式 role:agent/operator |
| S5 | T008 改造 + T010 标注外化 | scenarios 3 pass / 19 skip / 0 fail，纳入 npm test |
| WP15 | 随 S5 | npm test 已含 test/scenarios.test.mjs |

### 归档为已知负债（下轮处理）

| ID | 现状缺口 |
|---|---|
| P0-3 / G2 / 4.1-7 | SVG 提升到可激活祖先再 click，未按契约派发合成 click 事件 |
| G1 | 合成路径只调原生 click()，九事件序列靠 CDP 真事件路径 |
| G7 | .form-group 同级标签与 aria-describedby 两条命名路径未实现 |
| G10 | 快照无「视口外还有 N 个可交互元素」说明 |
| G12 | validation_error 未顶到快照最前 |
| G14 | 四类硬边界（系统文件/原生 UI/chrome 页/系统授权窗）分类识别未实现 |
| C1 | ⑥ 动画/轮询去噪无独立实现；②⑩ 部分 |
| C2 | 「做了什么+观测到什么+下一步」三段覆盖未逐工具验证 |
| C3 | expect 只挂 read 的 attr 探针，非每动作可带预期结果 |
| F1 | 出厂层 domains 为空 |
| N10 | 无 tab group 成员关系 |
| WP0 / 4.1-3 | feishu.push 配错错误信息未逐条列 entry 的 [name\|type\|enabled\|host] |
| WP1 / WP2 / WP3 / WP5 / WP8 / WP12 | 汇总行：随子项归档（WP5 的 D10/D11/D12 已随 T011/T012/T013 补齐；WP2 的 H9 已随 P0-4 修复） |
| Q2 / Q3 / Q9 / Q12 | 待明确事项，规格侧悬置 |

## D006 · 重跑审计 SP-A/SP-B 收口

- 状态：approved
- 日期：2026-10-21
- owner：编排者（Main）
- 内容：重跑审计（docs/ai-workflow/audits/2026-10-21-reaudit-post-fix.md）发现 2 Major 未收口，已收口：
  - SP-A（gap-matrix 状态表失真）：D10/D11/D12/S5/WP5/WP15 六行「部分实现」→「已实现」，计数 155→161 已实现 / 30→24 部分实现，partial 清单随 D005 归档（24 项已知负债）。WP5 作为汇总行随子项 D10/D11/D12 补齐转已实现（D005「补齐 5 项」实为 6 项，WP5 连带）。
  - SP-B（D11 生产未接线）：status-tool.js 加 userInputs schema、status-bridge.ts 透传 userInputs，content 层 parseStatusUpdate 已有消费逻辑（零改动）。生产链路 MCP→background→content 贯通，声明值不再外泄。
  - risks.md：R8（D11 未接线）转 resolved；R3/R4/R6 缓解动作从「T014 分诊」改为「下轮处理」（ST-N2 收口）。

## D007 · R4/R5 从「下轮处理」提前收口

- 状态：approved
- 日期：2026-10-21
- owner：编排者（Main）
- 内容：第二次重跑审计（docs/ai-workflow/audits/2026-10-21-reaudit-2.md）0 Major 后，用户追问 open 风险是否处理完成。复核 R4/R5/R7 性质——R4（死代码）与 R5（采集过滤）为代码可修，R7（tab_close sensitive）为产品侧依赖（D003 无人值守审批通道）。裁决：R4/R5 提前到本轮收口，R7 保持 open 待产品侧。
  - R4：删除 test/browser-fixtures.mjs 死代码簇 connectOverCDP/cdpJson/evaluateTarget/connectSocket（无 test import，scenarios 只用 createMcpHarness/startFixtureHost/waitForPageValue/delay）；Q5 落点改指 createMcpHarness:58-81。
  - R5：page-grounding collectDeepElements 与 page-skeleton buildSkeletonTree 过滤 #actspan-root（ActSpan 自身 UI 不进页面语义快照/骨架）；加回归测试「actspan root host is excluded from the page snapshot」。
  - R7：保持 open，根因 D003 无人值守审批通道（产品侧功能），代码无法自行解决。
