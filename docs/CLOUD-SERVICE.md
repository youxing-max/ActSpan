# Actspan Cloud 部署与管理员手册

多人共享一个云端 MCP 服务：IDE 通过 `Authorization: Bearer <token>` 连云，浏览器扩展通过 `?token=<token>` 连云，云端按 token 把两者配对，实现"每个用户的 IDE 调用自己的浏览器"。

## 架构

```
 Alice 的 IDE ──https://host/mcp──┐  Authorization: Bearer <alice-token>
 Bob 的 IDE   ──https://host/mcp──┤  Authorization: Bearer <bob-token>
                                  ▼
                    ┌──────────────────────────┐
                    │  cloud.js（单进程单端口）  │
                    │  /mcp   IDE（MCP HTTP）    │
                    │  /ws    浏览器（WebSocket）│
                    │  /health 运维探针          │
                    └───────┬──────────┬───────┘
             wss ?token=alice        wss ?token=bob
                            ▼          ▼
                    Alice 的 Chrome   Bob 的 Chrome（actspan 扩展）
```

## 一、部署云端

```bash
cd mcp-server
npm install

# 1) 初始化 token 文件（见下文"发 token"）
cp tokens.example.json tokens.json

# 2) 启动（默认 0.0.0.0:8787）
node cloud.js --port 8787 --tokens ./tokens.json
# 或后台：nohup node cloud.js >> cloud.log 2>&1 &
# 或 systemd / pm2 / docker，随意
```

环境变量等价项：`ACTSPAN_CLOUD_PORT`、`ACTSPAN_CLOUD_HOST`、`ACTSPAN_CLOUD_TOKENS_FILE`、`ACTSPAN_CLOUD_TOKENS`（内联 JSON，优先级高于文件）、`ACTSPAN_CLOUD_CALL_TIMEOUT_MS`（转发超时，默认 120000）。

**生产必须挂 TLS 反代**（浏览器扩展连非本机 `ws://` 会被 Chrome 拒绝）：

```nginx
server {
    listen 443 ssl;
    server_name mcp.example.com;
    ssl_certificate     /etc/ssl/xxx.crt;
    ssl_certificate_key /etc/ssl/xxx.key;

    location /mcp {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;            # SSE 流式响应不要缓冲
        proxy_read_timeout 3600s;
    }
    location /ws {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
    location /health { proxy_pass http://127.0.0.1:8787; }
}
```

对外地址即：`https://mcp.example.com/mcp` 与 `wss://mcp.example.com/ws`。

## 二、管理员发 token（核心流程）

token 由**管理员用 CLI 生成**，不是用户自己申请：

```bash
node cloud-token.js add alice          # 生成并写入 tokens.json
node cloud-token.js add alice --force  # 轮换（旧 token 立即失效）
node cloud-token.js list               # 列出用户（token 脱敏显示）
node cloud-token.js verify <token>     # 排障：这个 token 是谁的
node cloud-token.js revoke alice       # 吊销（离职/泄露时用）
# 全局安装后命令名为 actspan-cloud-token
```

`add` 会打印**一次性交接块**，直接复制发给用户（IM/邮件均可）：

```
【浏览器扩展】Options → 云端连接器
  服务器地址: wss://mcp.example.com/ws
  个人 Token: actspan_xxxxxxxx…

【IDE 添加连接】（认证方式选「请求头认证」）
  服务地址:   https://mcp.example.com/mcp
  请求头名:   Authorization
  请求头值:   Bearer actspan_xxxxxxxx…
```

要点：

- **tokens.json 变更 2 秒内被运行中的 cloud.js 热加载**，发牌/吊销都不用重启服务（已实测：运行中 add → 新 token 立即 200；revoke → 立即 401）
- token 格式 `actspan_<32 位随机 base64url>`，前缀便于日志检索与泄露扫描
- 写入采用临时文件 + rename 原子替换，热加载不会读到半截文件
- 吊销后：该用户浏览器收到 close 4001 停止重连；IDE 侧请求 401

## 三、用户侧配置

### 浏览器扩展（每人一次）

扩展 Options → **云端连接器**：
- 服务器地址：`wss://mcp.example.com/ws`
- 个人 Token：管理员发的 token
- 打开启用开关 → 状态变「已连接」

> 浏览器 WebSocket 按 W3C 规范不能带自定义请求头，所以扩展侧 token 走 URL query；IDE 侧走请求头。**同一个 token，两种携带方式。**

### IDE（你截图的「添加连接」对话框）

| 字段 | 填写 |
|---|---|
| 名称 | Actspan 云浏览器 |
| 服务地址 | `https://mcp.example.com/mcp` |
| 描述 | 通过云端调用我自己浏览器里的 Actspan 工具 |
| 认证方式 | **请求头认证** |
| 请求头 | `Authorization: Bearer <我的token>` |

保存后 IDE 的 agent 即可调用该用户浏览器里的全部 Actspan 工具（page / screenshot / tab_navigate / cdp_* 等 27+）。可先让 agent 调 `cloud_status` 自检浏览器是否在线。

## 四、运行时行为约定

| 场景 | 行为 |
|---|---|
| 浏览器 token 无效或运行中被吊销 | 无效握手或配置热加载后 close **4001**；扩展停止重连并提示「Token 无效」。吊销同时拒绝在途调用并关闭该 token 的旧 MCP 会话 |
| 同 token 第二个浏览器连入 | 顶替旧连接 close **4002**；旧扩展提示「连接已被替换」并停止重连。需要恢复时先停用再启用；多台设备同时使用需分别分配 token |
| IDE token 无效/缺失 | HTTP **401** |
| IDE 拿别人的 mcp-session-id | **403**（会话绑定建会话时的 token） |
| 浏览器不在线时 IDE 调工具 | 返回 isError 结果：「浏览器不在线（用户 xxx）…」 |
| 云端 ↔ 浏览器心跳 | 30s ping/pong |
| 工具执行权限 | 沿用扩展 permissionLevel：sensitive/dangerous 仍弹本地用户确认 |

## 五、运维

- `GET /health`：在线浏览器用户列表、MCP 会话数、已加载 token 数（不泄露 token 本体）
- 日志：连接/断开/会话建立均带 user 名，便于审计
- 被拒绝的 token 不写入日志；切换连接后，旧连接的迟到工具结果不会发送给新连接
- 扩容：单进程可支撑数百并发 WebSocket；更大规模按 token 哈希分片多实例即可

## 六、本地自测（无需真机）

```bash
node test/cloud-e2e.mjs     # 本机鉴权、路由、转发、顶替、离线、异常帧与运行中吊销
```

扩展侧单独联调见 [CLOUD-BRIDGE-TESTING.md](./CLOUD-BRIDGE-TESTING.md)（mock 云端脚本）。
