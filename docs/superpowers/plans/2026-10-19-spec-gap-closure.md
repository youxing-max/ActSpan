# Actspan spec gap closure — core behavior

## Scope

修复上次调查确认的高风险行为缺口，不重写既有架构，不触碰无关用户改动：

1. 统一 plan-only workflow 的 retry 语义：最多一次额外尝试，固定等待 250ms；保留 `PolicyError`、`TabLeaseError`、取消不可吞；fallback/continue 只记录跳过并继续。
2. 取消竞态：取消/断线后，队列中的步骤不得在租约失效或任务取消后启动新的浏览器副作用；tab 操作和等待支持 AbortSignal。
3. workflow run 接受显式 `independent|continue|replace`，接入现有 TaskManager 的 session/client 绑定；不改变跨 session 并发和跨 client 隔离。
4. 远端 registry 替换保护更高版本缓存，reload 完成后广播外部 revision；补高/同/低版本与外部 reload 行为测试。

## 文件与行为

- `src/background/mcp-bridge.ts`: 规范化 plan retry/onError；在执行每步及 tab 副作用前检查取消；将 signal 传到等待/浏览器操作；保留现有 lease/policy 路径。
- `src/background/policy-executor.ts`, `src/background/tab-lease-manager.ts`: 在串行队列真正执行前再次验证取消与 tab lease，避免排队期间 ownership 变化后执行旧请求。
- `mcp-server/index.js`: 暴露 workflow/agent task mode。
- `src/functions/registry-service.ts`: remote source replacement 按 source+scope+name 保留更高版本；外部 storage reload 等待并广播 revision 变化。
- `src/background/mcp-bridge.test.mjs`, `src/background/task-manager.test.mjs`, `src/functions/registry-service.test.mjs`: 只增加可观察行为回归测试。

## 非目标

不在本轮实现 AI TabTracker 与 session-resource 全面迁移、API 远端调用、npm tarball E2E、逐步审计模型、旧品牌文档清理或额外 Feishu 工具目录决策；这些是独立后续工作，避免混入核心行为修复。

## 验证

先运行每个新增/受影响测试的 focused Node test；再运行现有核心回归测试、扩展 build，并报告当前仓库已知的全量 lint/typecheck 基线问题，不声称其通过。
