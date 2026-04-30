# DeepSeek OpencodeGo Proxy

解决 CC-switch + OpenCode Zen Go + DeepSeek V4 链路中 `reasoning_content` 必须回传的问题。

## 问题

DeepSeek V4 推理模式要求每次请求中，历史 assistant 消息必须携带 `reasoning_content` 字段（原文）。OpenCode Zen Go 在返回响应时保留了该字段，但下一轮请求时未正确注入，导致 DeepSeek 返回 400 错误。

## 原理

```
Claude Code → CC-switch → Local Proxy (:3456) → OpenCode Zen Go → DeepSeek V4
                              │
                              ├─ 请求路径：为缺失 reasoning_content 的 assistant 消息注入之前捕获的原文
                              └─ 响应路径：从 SSE 流中捕获 reasoning_content 存入内存
```

每次请求自动完成：**注入 → 转发 → 捕获 → 下一轮再注入**。

## 使用

```bash
# 启动代理
node proxy.js

# 或双击 start.bat
```

默认监听 `localhost:3456`，转发到 `https://opencode.ai/zen/go`。

### CC-switch 配置修改

```json
{
  "ANTHROPIC_BASE_URL": "http://localhost:3456",
  "ANTHROPIC_MODEL": "deepseek-v4-pro",
  ...其余配置不变
}
```

## 文件

| 文件 | 说明 |
|------|------|
| `proxy.js` | 代理服务主程序 |
| `start.bat` | Windows 启动脚本 |

## 注意

- 首次使用必须启动**新会话**，让代理从第一轮开始捕获 reasoning_content
- 不支持多会话并发（`lastReasoningContent` 为单变量），如需多开需加 session ID 支持
- 这是个vibe coding出来的临时工具，等待opencode官方修复api接口后就失去作用了，因此不会进行更新维护
