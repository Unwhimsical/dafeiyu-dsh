# 致谢 / 第三方代码

## companion-memory（MIT License）
本项目的以下部分移植自 companion-memory（TypeScript → Python 重写，按本项目需求做了改造）：

- 遗忘曲线与记忆状态（forgetting.ts → `brain/forgetting.py`：半衰期、clear/faded/trace/pinned、浮现权重、冷却）
- 延续性：交接便签 / 未了的事 / 便条 / 心痕 / session_start（→ `brain/continuity.py`，改为“按会话隔离”）
- 情绪双层模型（表面/心里、哄、承认）（→ `brain/emotion.py`）
- 身体 / 欲望 / 身体会话（18+，→ `brain/body.py`、`brain/desire.py`）
- 梦境与巩固（→ `brain/dream.py`）
- 自我认知沉淀（→ `brain/cognition.py`）
- 花园 / 卡片 / 状态 / 抽卡（deck）/ 便签等视图接口（→ `brain/views.py`、`/api/view/*`）
- MCP 工具名与语义（→ `brain/mcp.py`）

MIT License 原文要求保留版权声明：

```
MIT License

Copyright (c) 2026 The Authors (companion-memory)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 其他依赖
- FastAPI / Starlette / Uvicorn（MIT / BSD）
- jieba 中文分词（MIT）
- SQLite FTS5（公有领域）
