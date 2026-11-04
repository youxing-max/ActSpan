# Cloud Bridge 测试指南（token 隔离模式）

本文档说明如何本地端到端验证云端 MCP 桥接：**多用户共享一个云端、按 token 隔离调用**。

## 模型

```
                     wss://your-cloud.com/ws
                              ▲
        ┌─────────────────────┼─────────────────────┐
        │ ?token=alice-xxx    │ ?token=bob-yyy      │ ?token=carol-zzz
        │                     │                     │
   Alice 的浏览器        Bob 的浏览器          Carol 的浏览器
```

云端校验 `?token=` 决定这条 WebSocket 属于谁。Agent 想调谁，就往谁的连接发 `tools/call`。

## 准备工作

```bash
npm install
cd mcp-server && npm install && cd ..
npm run build
```

构建产物在 `build_version/actspan-extension/`。

## 步骤 1：加载扩展

1. 打开 Chrome → `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点击「加载已解压的扩展程序」→ 选择 `build_version/actspan-extension/`

## 步骤 2：启动 mock 云端

```bash
node scripts/mock-cloud-server.mjs
```

输出：

```
[mock-cloud] 监听 ws://127.0.0.1:18080/ws
[mock-cloud] 内置测试 token:
  - alice-token-001 → alice
  - bob-token-002 → bob
  - carol-token-003 → carol
```

保持运行。

## 步骤 3：在扩展里配置（用户 alice）

1. 右键扩展图标 → 「选项」
2. 左侧菜单点 **云端连接器**
3. 「服务器地址」粘贴：`ws://127.0.0.1:18080/ws`
4. 「个人 Token」粘贴：`alice-token-001`
5. 点「保存配置」
6. 打开「已停用」开关 → 变成「已启用」

## 步骤 4：观察 alice 的连接

**Options 页**应显示：
- 连接状态：`已连接`（绿色）
- Token：`已配置`
- 最近连接：当前时间

**mock-cloud 终端**应输出：

```
[mock-cloud] 用户 alice(u_alice) 已连接，当前该用户共 1 条连接
[mock-cloud] alice 的扩展就绪 version=1.1.0 toolCount=27

[demo:alice] tools/list 拿到 27 个工具，前 8 个：
  - page
  - timer
  ...

[demo:alice] tab_navigate.list 结果（截断）:
{ ... }

[demo:alice] 调用不存在工具的错误响应:
{ ... }

[demo:alice] 演示完成，连接保持打开。
```

## 步骤 5：验证 token 隔离（多用户）

**新开一个 Chrome profile**（或使用 Chrome 的「访客模式」/Edge/Brave），重复步骤 1 加载同一个扩展目录，然后用**不同的 token** 配置：

- 服务器地址：`ws://127.0.0.1:18080/ws`
- Token：`bob-token-002`

mock-cloud 终端会输出：

```
[mock-cloud] 用户 bob(u_bob) 已连接，当前该用户共 1 条连接
[mock-cloud] bob 的扩展就绪 ...
[demo:bob] tools/list 拿到 27 个工具 ...
```

现在云端能看到 **alice 和 bob 是两条独立的连接**，想调谁就发给谁。这就是 token 隔离的本质。

## 步骤 6：验证错误 token

把 token 改成 `wrong-token`，保存。预期：

1. **mock-cloud 终端**：`[mock-cloud] 拒绝连接：token 无效 (token="wrong-token")`
2. **Options 页**：连接状态变 **`Token 无效`**（红色 Tag），顶部弹出 Alert 提示「云端拒绝了当前 token（关闭码 4001），已停止重连」
3. **Service Worker 日志**：`[cloud-bridge] 鉴权失败 (4001): invalid token，停止重连。请检查 token`
4. **不会重连**：等多久都不会自动重试，直到你改 token

把 token 改回 `alice-token-001` 保存，扩展会立刻重新连接成功。

## 步骤 7：验证同一 token 多设备

把两个 Chrome profile 都用 `alice-token-001` 配置。mock-cloud 会输出：

```
[mock-cloud] 用户 alice(u_alice) 已连接，当前该用户共 2 条连接
```

云端实现时有三种策略，由云端决定：
- **拒绝后连的**：保留第一条，新连接直接 close
- **踢掉旧的**：保留最新一条
- **广播**：调用时给所有 session 都发，第一个响应胜出

mock 脚本默认全部接受。

## 步骤 8：手动调用工具（可选）

修改 `scripts/mock-cloud-server.mjs` 的 `demo()` 函数：

```js
// 截图
await sendRequest(ws, 'tools/call', {
    name: 'screenshot',
    arguments: { annotate: false },
});

// 打开新标签页
await sendRequest(ws, 'tools/call', {
    name: 'tab_navigate',
    arguments: { action: 'open', url: 'https://example.com' },
});
```

完整工具列表见项目根目录 CLAUDE.md 的「工具函数系统」章节。

## 生产云端实现要点

如果你要写正式的云端服务，关键点：

### 1. 鉴权

```js
wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'wss://your-cloud.com');
    const token = url.searchParams.get('token');
    const user = await db.findUserByToken(token); // 查数据库
    if (!user) {
        ws.close(4001, 'invalid token');  // ← 关键：用 4001
        return;
    }
    ws.userId = user.id;
    // ...
});
```

### 2. 按用户路由

```js
const sessionsByUserId = new Map(); // userId → Set<WebSocket>

// Agent 想调用用户 U 的浏览器：
async function callUserBrowser(userId, toolName, args) {
    const sessions = sessionsByUserId.get(userId);
    if (!sessions || sessions.size === 0) {
        throw new Error(`用户 ${userId} 当前不在线`);
    }
    const ws = sessions.values().next().value; // 取第一条
    return sendRequest(ws, 'tools/call', { name: toolName, arguments: args });
}
```

### 3. 必须 wss

Chrome MV3 不允许扩展连接非本机的 `ws://`（CSP 限制）。生产必须：
- TLS 证书有效（自签名 Chrome 会拒）
- 域名 `wss://your-cloud.com/ws`

### 4. token 管理建议

- 在用户 dashboard 显示 token，可一键复制
- 提供"撤销"按钮（重置 token，旧 token 立即失效）
- token 加前缀便于日志追踪，如 `actspan_user_xxx`（参考 GitHub `ghp_`）
- 存储时哈希（`bcrypt` 或 `sha256` + salt），不要明文入库

## 故障排查

| 现象 | 排查 |
|---|---|
| Options 显示「Token 无效」 | 云端 close code 是 4001；检查 token 是否拼写正确，云端日志看拒绝原因 |
| Options 一直「连接中」 | 网络不通；检查服务器地址是否写错；云端防火墙 |
| Options 显示「未连接」+「连接已关闭 (code=1006)」 | 网络层断开；云端进程崩溃 |
| mock-cloud 显示连接但 demo 不输出 | 检查 background SW 日志，看 `mcpClient.listTools()` 是否报错 |
| 工具调用长时间无响应 | 工具可能弹了本地用户确认框；让用户去活动标签页点掉 |
