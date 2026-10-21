# ActSpan 三轴重审计（修复后）· 2026-10-21

审计类型：独立重跑（fresh auditor），不读编排者推导过程，只读产物 + 实测命令。
被审基线：`docs/ai-workflow/audits/2026-10-21-testability-and-doc-drift.md`（Blocker 0；Major 6：S1/SP1/SP2/SP3/ST1/ST2；Minor 1：S2）。
本次结论：**Blocker 0 / Major 2 / Minor 5**；基线 6 Major 中 **5 条收口、1 条部分收口（SP3 的 D11 未闭）**。

## 0. 实测命令与退出码（全部本轮亲自执行）

| # | 命令（cwd=仓库根） | 结果 | exit |
|---|---|---|---|
| 1 | `python C:/Users/z2222/.omp/agent/skills/ai-workflow-state/tools/validate_state.py .` | `PASS 状态校验通过 (tasks=14 milestones=4 decisions=5)` | 0 |
| 2 | `node mcp-server/check-tool-docs.mjs MCP-BRIDGE.md README.md` | `docs=2 tools=34 missing=0 extra=0` | 0 |
| 3 | `grep -rn "18 个工具\|18-tool\|18 个稳定工具\|共 18 个\|18 tools\|18 tool" README.md MCP-BRIDGE.md docs/guide docs/superpowers src mcp-server test` | 无任何命中（exit 1） | 1 |
| 4 | `npm test` | `tests 379 / pass 360 / fail 0 / skip 19`，54.6s | 0 |
| 5 | `node --test test/scenarios.test.mjs` | `tests 22 / pass 3 / fail 0 / skip 19`，28.6s | 0 |
| 6 | `node --test src/content/status-virtual-cursor.test.mjs` | `tests 13 / pass 13 / fail 0` | 0 |
| 7 | `node --test mcp-server/test/e2e.mjs` | `tests 1 / pass 1 / fail 0`（文件内 29 条 `check()` 全过，末尾打印 `all e2e checks passed`） | 0 |
| 8 | `node --test mcp-server/test/security.mjs` | `tests 10 / pass 10 / fail 0` | 0 |
| 9 | `grep -c '契约证据' docs/spec/actspan-gap-matrix.md` | `33` | 0 |
| 10 | `grep -c '^## D0' docs/ai-workflow/decisions.md` | `5` | 0 |

## 1. 基线 7 条逐条复核

| 基线项 | 判定 | 实测证据 |
|---|---|---|
| **S1** 文档漂移（18 vs 34） | **收口** | 命令 2 exit 0（34 工具、0 missing/0 extra）；命令 3 全仓用户文档零命中；`MCP-BRIDGE.md:59` 已为「工具清单（34 个）」并新分 act(8)/network(3)/data(3) 组，另补 `:151 执行语义边界`、`:168 network 工具可见性边界`；`README.md:126` 已写「稳定工具共 34 个」并列全表。 |
| **S2** 旧版悬浮球死代码 | **收口（核心）/ 残留见 Minor S-N1** | `src/content/float-ball.ts`、`src/content/float-ball-focus.test.mjs` 均已不存在；`src/content/float-ball/` 仍在且为活代码（`float-ball-react.tsx:7-9`、`sidepanel/SidePanelApp.tsx:7-19`、`options/components/FloatingChat.tsx:10-15`、`options/pages/BlocklistPage.tsx:12` 全部 import 该子目录）。但 6 处文档仍教人改已删文件（S-N1）。 |
| **SP1** `npm test` 不含靶场 | **收口** | `package.json` `scripts.test` = `node --test src/*.test.mjs src/**/*.test.mjs test/fixtures.test.mjs test/manifest-recorder.test.mjs test/scenarios.test.mjs`；命令 4 中 scenarios 的 22 条已计入 379。 |
| **SP2** S5 从未跑通（22 fail/0 pass） | **收口（按 D003 口径）** | 命令 5：`3 pass / 19 skip / 0 fail`，exit 0，无 `/json/version` 相关报错；19 条 skip 原因统一为 `live Chrome needs interactive approval ... E_TIMEOUT: 审批等待超时`，与 `decisions.md D003` 一致（skip ≠ pass 已在 gap-matrix 头部规则中写明）。 |
| **SP3** D10/D11/D12 安全三项 | **未完全收口：D10 ✅ / D12 ✅ / D11 ❌** | D10：`mcp-server/test/e2e.mjs:64-71` 断言 `actspan_tab_open.focus` 为 boolean、默认 false、描述含 "interrupt"，`:165-171` 断言 `focus:true` 转成 `active:true` 且不泄漏 MCP-only 参数 → 命令 7 exit 0。D12：`mcp-server/test/security.mjs:54-77` 用真实 `ExtensionHub`（`../bridge.js`）验证显式 `role:'agent'/'operator'` 被 4001 拒绝、无 role 的老客户端兼容 → 命令 8 exit 0。D11：见 **Major SP-B**（测试通过但生产链路未接线）。 |
| **ST1** 审计基础设施缺失 | **收口** | 命令 1 exit 0；`docs/ai-workflow/` 下 `state.json`、`decisions.md`、`risks.md`、`evidence/`、`milestones.json`、`tasks.json`、`roadmap.md` 全部存在。 |
| **ST2** 证据分级未外化 | **收口** | 命令 9 = 33 处「契约证据」标注（行级方括号标签）；`gap-matrix.md:5-17` 头部已重写为「3 pass / 19 skip / 0 fail，exit 0」并列出 3 条真跑用例的行号，不再出现「22 fail / 0 pass」；「skip ≠ pass（决策 D003）」已写死在标注约定里。 |

顺带复核的两条旧 V 项（非本轮编号）：`float-ball-react.tsx:25` 已是 `attachShadow({ mode: 'open' })`（V1 可测性）；`src/lib/cdp-session.ts:407,448-458` 有 `NETWORK_PENDING_TIMEOUT_MS = 60s` + `evictStalePendingRequests`，`src/lib/cdp-session.test.mjs:51-77` 有对应回归（V3 pending 不驱逐）。

---

## 2. Standards 轴

### Minor S-N1 · 6 处文档仍指向已删除的 `src/content/float-ball.ts`

死代码本身已删（S2 核心收口），但用户/开发文档仍教读者去一个不存在的文件里改代码：

| 位置 | 原文片段 |
|---|---|
| `CLAUDE.md:316` | 「旧版 `src/content/float-ball.ts` 保留但未使用，待迁移完成后删除」——事实已变，此句现在为假 |
| `docs/guide/development.md:63` | 目录树 `│   ├── float-ball.ts      # 悬浮球 UI`（该文件已不在该目录） |
| `docs/guide/development.md:195` | 「在 `src/content/float-ball.ts` 中添加：」 |
| `docs/en/guide/development.md:63` | 同上英文版目录树 |
| `docs/en/guide/development.md:195` | 「Add to `src/content/float-ball.ts`:」 |
| `docs/guide/actspan-workflow-architecture-spec.md:92` | 把 `src/content/float-ball.ts` 列为「浏览器运行时」文件 |
| `docs/superpowers/plans/2026-10-18-actspan-rename-and-repair-spec.md:80` | `Modify: ... src/content/float-ball.ts`（历史计划，可豁免） |

证据：`ls` 确认两文件不存在；上述 grep 六处命中。`risks.md:21`（R3）已自认此问题并留 open，缓解列写「→ T014 分诊」，但 T014 已 `ready_for_review` 而文档未改（见 State ST-N2）。
定性：文档漂移，无运行时影响 → Minor。

### Minor S-N2 · 已开 shadow DOM，但源码注释仍写 closed

`src/content/float-ball/hooks/useGlobalEvents.ts:60`：
`// 注意：这些事件分发在 reactRoot 上，但在 closed Shadow DOM 中`
而实际挂载点 `src/content/float-ball-react.tsx:25` 为 `attachShadow({ mode: 'open' })`。注释与实现相反，会误导后续排障。
证据：两行实测 grep。`risks.md:24`（R6）已自认 open。
定性：注释级不实陈述 → Minor。

Standards 轴小计：**Blocker 0 / Major 0 / Minor 2**。

---

## 3. Spec 轴

### Major SP-A · gap-matrix 未随 D005 分诊更新，状态表与代码/决策相反

T014 的交付物是「30 项 partial 分诊归档」，但分诊只落在 `decisions.md D005`，**`docs/spec/actspan-gap-matrix.md` 一字未动**：

- `grep -n "归档\|D005\|已知负债" docs/spec/actspan-gap-matrix.md` → **0 命中**（文档里不存在任何归档章节）。
- 表体仍写旧状态：`:110` D10「全仓无任何工具提供显式 focus:true 逃生口」、`:111` D11「无实现也无测试」、`:112` D12「role 未在扩展 hub 握手路径校验」——三条都与已通过的 `e2e.mjs:64-71/165-171`、`security.mjs:54-77` 直接矛盾。
- 汇总行同样陈旧：`:268` WP5 仍称 D10/D11/D12「三条部分实现」；`:255` S5、`:278` WP15 仍为「部分实现」。
- 计数与清单陈旧：`:334` 「部分实现：30」、`:350-352` 仍列 30 项（含已补齐的 S5/WP15）。

影响：gap-matrix 是本仓需求状态的单一事实源，读者按它判断「D10/D12 未实现」会得出与代码相反的结论；同一仓里 `decisions.md D005` 说补齐、矩阵说未实现，两者无法同时为真。
定性：规格状态表已失真（方向为「低估已修项」），无运行时影响 → Major（与基线 S1 同类：文档事实性错误）。
建议（不在本次改码范围）：把 D005 的「本轮补齐 / 归档为已知负债」两表落进 gap-matrix，并同步 `:334` 计数与 `:350` 清单。

### Major SP-B · D11「文案不带用户输入」只在纯函数层成立，生产链路不可达

需求（gap-matrix `:111`）：状态文案不得回显用户输入。

实测链路：

- 实现存在：`src/content/float-ball/text-utils.ts:46-52` `redactUserInputFromCopy(raw, userInputs?)`、`:317` `normalizeStatusText(..., userInputs)`、`:335-346` `parseStatusUpdate`（读 `data.userInputs` 并剥除该字段）。
- 测试存在且真过：`src/content/status-virtual-cursor.test.mjs:59-85` 断言 `hunter2`/`Alice-Chen`/`#checkout-form`/`张三` 被替换为 `[已隐藏用户输入]`，且 `assert.equal('userInputs' in payload, false)`（命令 6：13 pass）。
- **但生产调用点从不传 `userInputs`**：
  - `src/background/status-bridge.ts:49-54` `updateStatus()` 只把 `text` 与 `language` 发给页面：`sendStatusEvent(tabId, { text, ...(language ? { language } : {}), active: true })`，`input.userInputs` 被丢弃；
  - `mcp-server/status-tool.js:13-19` 的 `inputSchema` 只有 `tabId`/`text`/`language`，MCP 客户端连「声明用户输入」的入口都没有；
  - `grep -rn "userInputs" src mcp-server` 除 `text-utils.ts` 与该测试外**零调用点**。

结论：无 `userInputs` 时只剩凭据形态兜底掩码（`password=`/`token:`），用户随手输入的姓名/地址仍会原样出现在悬浮球文案里 → 需求在真实路径上未满足。
披露情况：`decisions.md D005` 括注「生产接线待办，见 R8」、`risks.md:26`（R8）如实记录 open → 不存在隐瞒，但「本轮补齐」清单把它列为已补齐项，且 T011 已 `ready_for_review`，验收口径（「D11 有回归测试」）被满足而产品行为未被满足。
定性：功能性需求未闭合（安全向文案）→ Major。
建议：`status-tool.js` schema 加 `userInputs`（或由后台按 task 记录自动收集），`status-bridge.updateStatus` 透传，补一条端到端断言。

### Minor SP-C · 已实现行的证据锚点指向已删文件

`docs/spec/actspan-gap-matrix.md:189`（N12，状态「已实现」）备注结尾：`胶囊状态机在 src/content/float-ball.ts:1097-1143`——该文件已删，行号永久失效。
同行的其它锚点仍有效：`src/content/float-ball/ActspanRoot.tsx:20-24`（StatusCurtain `role="status"` / `aria-live="polite"`）实测命中，`:92-94` 渲染位置命中，`src/content/float-ball/status-state.test.mjs:38` 用例名「curtain renders current status accessibly and disappears in idle state」命中。
定性：证据链局部断链，ST2 分级体系里属「锚点失效」→ Minor。

Spec 轴小计：**Blocker 0 / Major 2 / Minor 1**。

---

## 4. State 轴

### Minor ST-N1 · T009 无 evidence 日志，且 14/14 任务的 `evidence` 字段全为 null

- `docs/ai-workflow/evidence/` 实存 13 个日志：T001、T002、T003-readme、T004、T005、T006、T007、T008、T010、T011、T012、T013、T014（`.gitkeep` 除外）。**缺 T009**（T009 = 「接入 ai-workflow-state 套件」，14 个任务中唯一没有日志的）。
- `tasks.json` 14 条任务全部 `status: ready_for_review`，但 `evidence` 字段 **14/14 为 `null`**——状态账本没有任何一条记录指向自己的证据文件，查证只能靠文件名约定猜（且 T003 命名为 `T003-readme-...`，不遵循 `T00X-2026-10-21.log` 约定）。
- T009 的 `verify`（`validate_state.py` 退出码 0）本轮实测通过，故缺日志不等于未完成，但「ready_for_review 必有 evidence」这条记账纪律在账本层不存在。
定性：可追溯性缺口（不影响产品）→ Minor。

### Minor ST-N2 · R3/R6 的缓解动作挂在 T014，但 T014 已交付且未执行该动作

- `risks.md:21`（R3）缓解列：7 处文档引用已删 `float-ball.ts` → 「T014 分诊」；`risks.md:24`（R6）缓解列：「T014 分诊修正」。
- `tasks.json` T014 = `ready_for_review`；`docs/ai-workflow/evidence/T014-2026-10-21.log` 全文 19 行，只有 decisions 追加 + 两条 grep/校验，**没有任何文档编辑**，也不含 `float-ball` 字样。
- 实测：R3 列出的 `CLAUDE.md:316`、`docs/guide/development.md:63,195`、`docs/en/guide/development.md:63,195`、`docs/guide/actspan-workflow-architecture-spec.md:92`、`gap-matrix.md:189`、`superset-spec.md` 多处**全部仍在**；R6 的 `useGlobalEvents.ts:60` 未改。
定性：风险缓解承诺落空（风险仍 open，记录诚实，但指向的处置已关闭）→ Minor。
建议：把 R3/R6 的缓解列改挂到新任务，或在 T014 关闭前补做。

### 已核对通过的 State 项（不计入发现）

- `validate_state.py` exit 0，`state.json`/`decisions.md`/`risks.md`/`evidence/`/`milestones.json`/`tasks.json`/`roadmap.md` 齐备。
- `decisions.md` 5 条（D001-D005）全部具备「状态 / 日期 / owner」三要素（D001 owner=用户，D002-D005 owner=编排者（Main），日期均 2026-10-21）。
- `risks.md` 所有 open 项（R3-R8）均有 owner、日期与缓解动作列，无空行；SP2 行为「缓解中」并写明去向（T008）。

State 轴小计：**Blocker 0 / Major 0 / Minor 2**。

---

## 5. 三轴合计

| 轴 | Blocker | Major | Minor |
|---|---|---|---|
| Standards | 0 | 0 | 2（S-N1 文档指向已删文件、S-N2 closed/open 注释与实现相反） |
| Spec | 0 | 2（SP-A gap-matrix 未随分诊更新、SP-B D11 生产链路未接线） | 1（SP-C N12 证据锚点指向已删文件） |
| State | 0 | 0 | 2（ST-N1 T009 无日志 + evidence 字段全 null、ST-N2 R3/R6 缓解挂空） |
| **合计** | **0** | **2** | **5** |

与基线对比：基线 6 Major → 现 2 Major，且这 2 条均为**新口径**（SP-A 是修复动作本身产生的状态表失真，SP-B 是 SP3 三选一中未闭的一条）；基线 S1/SP1/SP2/ST1/ST2 已实测收口，S2 核心收口仅剩文档残留。

## 6. 本轮不做的事

- 未改任何业务代码 / 文档（审计只读）。
- 未开 fix 任务；SP-A/SP-B/SP-C/S-N1/S-N2/ST-N1/ST-N2 仅为待分诊清单，误报由人过滤。
- 19 条 S5 skip 属 D003 已裁决口径，本轮不重复计为发现；但其「契约证据」性质仍意味着 22 条靶场里 19 条未被无人值守证明，任何把 S5 当「全绿」的表述仍不成立。
