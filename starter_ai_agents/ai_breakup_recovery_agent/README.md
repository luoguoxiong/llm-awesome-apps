# 💔 Breakup Recovery Squad · 分手恢复陪伴团队

你的 AI 分手恢复团队：**共情陪伴师、告别仪式师、恢复计划师和毒舌真相官**四位置身定制的小伙伴,陪你聊感受、读懂聊天截图、写完没寄出的信,然后好好向前走。

迁移自 [awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps) 的 `starter_ai_agents/ai_breakup_recovery_agent`(Streamlit + Agno + Gemini 2.0 Flash),以 aipack Runtime + React + TypeScript 功能等价重写。

## 功能亮点

- **🤗 四 Agent 顺序接力,各司其职**:
  - **共情陪伴师**:接住情绪,验证感受,温柔幽默,鼓励打气
  - **告别仪式师**:代写 2-3 封"永远不会寄出的信" + 情感释放练习 + 告别仪式建议
  - **恢复计划师**:7 天恢复挑战(每日主题 + 小挑战 + 自我关怀)+ 社交媒体戒断策略 + 赋能歌单
  - **毒舌真相官**:直白复盘关系问题与盲区,给出成长机会与行动步骤(带 `search_web` 工具搜索心理学依据)
- **📷 聊天截图多模态分析**:上传多张聊天截图(浏览器端自动压缩),四位置身小伙伴都会结合截图理解对话中的情绪语境
- **⚡ SSE 流式输出**:每段回复逐字流式渲染,卡片实时显示各 Agent 状态(排队中 / 陪伴中… / 已完成)与工具调用
- **🎨 治愈系界面**:温暖粉紫渐变 + 四色 Agent 卡片,支持导出完整 Markdown 陪伴报告
- **🔌 provider 无关 + 双通道 Key**:默认 DeepSeek,前端可切换 27 个内置模型;API Key 服务器 `.env` 或页面输入二选一(localStorage 持久化)

## 使用方式

1. **写下感受**:说说发生了什么、现在感觉怎么样(与截图至少填一项)
2. **(可选)上传聊天截图**:最多 8 张,选择带 🖼 标记的多模态模型(如 `google/gemini-2.0-flash`)
3. **点击「💝 开始陪伴」**:四张卡片依次流式输出,完成后可导出 Markdown 报告

## 快速开始

```bash
# 1. 安装依赖(仓库根目录)
pnpm install

# 2. 配置 Key(本 app 目录)
cd starter_ai_agents/ai_breakup_recovery_agent
cp .env.example .env        # 编辑 .env,配置至少一个 LLM API Key

# 3. 开发模式(仓库根目录;后端 3008 + Vite 5173)
pnpm --filter ai-breakup-recovery-agent dev

# 4. 生产模式(单端口 3008)
pnpm --filter ai-breakup-recovery-agent build
pnpm --filter ai-breakup-recovery-agent serve
```

## 环境变量

| 变量 | 必填 | 说明 |
| ---- | ---- | ---- |
| `LLM_PROVIDER` | 否 | 陪伴模型 provider,默认 `deepseek` |
| `LLM_MODEL` | 否 | 模型 id,默认按 provider 取(`deepseek-chat`) |
| `DEEPSEEK_API_KEY` 等 | 否 | 所选 provider 的 API Key;留空时由前端用户输入 |
| `SERPAPI_KEY` | 否 | 毒舌真相官的搜索后端;不配则免费降级链 Bing → DuckDuckGo → 兜底 |
| `PORT` | 否 | 后端端口,默认 `3008` |

## API

| 接口 | 说明 |
| ---- | ---- |
| `GET /api/config` | 默认模型 / 模型目录(含 🖼 多模态标记)/ 搜索后端 |
| `POST /api/recovery` | SSE 流式陪伴;body `{ story, media, model }`,story 与 media 至少一项 |

SSE 事件:`stage`(`start` / `agent_start` / `agent_end` / `tool_start` / `tool_end` / `done`,携带 `agent` 归属)与 `delta`(`{ agent, kind: text|thinking, delta }`)、`error`。

## 架构

```
starter_ai_agents/ai_breakup_recovery_agent/
├── frontend/src/            # React + Vite:截图上传(压缩)/ 模型选择 / 四卡片流式渲染
│   └── components/          # ScreenshotUploader / ModelPicker / AgentCard / Markdown
└── src/                     # 原生 http + SSE(零框架依赖)
    ├── runtime.ts           # 四 Agent 定义与顺序接力执行(截图经 Request.media 传给每位)
    ├── server.ts            # /api/config + /api/recovery(SSE)+ 静态托管
    ├── config.ts            # getBuiltinModel → adaptAiModel → createStreamFnFromAi
    └── tools/search.ts      # search_web 四层降级(SerpAPI → Bing → DuckDuckGo → 兜底)
```

## 与源应用的差异

- 源应用固定 Gemini 2.0 Flash;本实现 provider 无关,默认 DeepSeek,上传截图时切换多模态模型(前端会校验并提示)
- 源应用 4 个 Agno Agent 依次同步执行;本实现四 Agent 顺序接力,但全部流式(SSE 逐字输出 + 状态实时推送)
- 聊天截图由浏览器端压缩为 JPEG data URI(最长边 1568px)后提交,经 `Request.media` 传给多模态模型
