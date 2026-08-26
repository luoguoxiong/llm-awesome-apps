# AI Reasoning Agent · 普通模型 vs 推理模型

基于 [aipack](https://github.com/luoguoxiong/aipack) 的推理对比 Web 应用：同一个问题，**普通模型**与**推理模型**（reasoning model）并行流式作答，直观呈现"快思考"与"慢思考"的差异——推理侧完整展示原生**思考链**（thinking），再给出最终答案。

迁移自 [awesome-llm-apps/starter_ai_agents/ai_reasoning_agent](https://github.com/Shubhamsaboo/awesome-llm-apps/tree/main/starter_ai_agents/ai_reasoning_agent)（Python/Agno 的 Regular Agent vs Reasoning Agent CLI 对比）。

## 功能

- **双栏并行对比**：普通模型（默认 DeepSeek Chat）与推理模型（默认 DeepSeek Reasoner）同时作答，SSE 流式逐字渲染
- **思考链展示**：推理模型的 thinking 内容单独流式推送，可折叠面板实时观看推理过程
- **内置示例问题**：字符计数经典题（"supercalifragilisticexpialidocious 里有几个 r？"）、小数比较（9.11 vs 9.9）、买西瓜逻辑题——均为普通模型易错的场景
- **模型自由切换**：前端下拉切换两侧模型（目录中推理模型带 ✨ 标记，如 GPT-5 / o3 / Gemini 2.5 Pro / DeepSeek Reasoner）
- **API Key 双通道**：服务器 `.env` 优先；或前端输入（localStorage 持久化，服务器不存储）；普通/推理两侧可使用不同 provider 的 Key
- **可中止**：生成中随时取消（AbortController 贯穿前后端）

## 快速开始

```bash
# 1. 配置环境变量(或启动后在页面输入 API Key)
cp .env.example .env
# 编辑 .env,填入 DEEPSEEK_API_KEY=sk-xxx

# 2. 安装依赖(仓库根目录)
pnpm install

# 3. 启动开发模式(后端 3002 + Vite 5173)
pnpm --filter ai-reasoning-agent dev

# 4. 打开 http://localhost:5173
```

生产模式（单端口）：

```bash
pnpm --filter ai-reasoning-agent build
pnpm --filter ai-reasoning-agent serve   # http://localhost:3002
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `LLM_PROVIDER` | 否 | 普通模型 provider,默认 `deepseek` |
| `LLM_MODEL` | 否 | 普通模型 id,默认按 provider 取(DeepSeek → `deepseek-chat`) |
| `REASONING_PROVIDER` | 否 | 推理模型 provider,默认跟随 `LLM_PROVIDER` |
| `REASONING_MODEL` | 否 | 推理模型 id,默认取该 provider 的推理模型(DeepSeek → `deepseek-reasoner`;无推理模型时回退 deepseek) |
| `DEEPSEEK_API_KEY` | 视情况 | DeepSeek API Key(默认两侧 provider;也可在页面输入) |
| `OPENAI_API_KEY` 等 | 视情况 | 切换 provider 时提供对应的 `*_API_KEY` |
| `PORT` | 否 | 后端端口,默认 `3002` |

## 架构

```
starter_ai_agents/ai_reasoning_agent/
├── frontend/                  # React + Vite + TS
│   └── src/
│       ├── App.tsx            # 主状态机:双模型选择 → 并行对比 → 双栏渲染
│       ├── api.ts             # /api/config + /api/compare(SSE) 封装
│       └── components/        # ModelPicker(模型+Key 选择器 ×2)、ComparePanel(对比栏 ×2)
└── src/                       # 后端:原生 http + aipack,零运行时框架依赖
    ├── server.ts              # http 服务 + SSE + 静态资源 + SPA fallback
    ├── runtime.ts             # 普通/推理双 Runtime 并行流式执行(thinking/text 分流)
    ├── config.ts              # 模型装配(getBuiltinModel → adaptAiModel → createStreamFnFromAi)
    └── loadEnv.ts             # .env 加载
```

### SSE 事件协议(`/api/compare`)

| 事件 | 数据 | 说明 |
|---|---|---|
| `stage` | `{ agent: 'regular'\|'reasoning', stage: 'start'\|'done' }` | 单侧开始/完成 |
| `delta` | `{ agent, kind: 'text'\|'thinking', delta }` | 流式增量(正文/思考链) |
| `error` | `{ message }` | 任一侧或双侧出错(不中断另一侧) |

## 验证

```bash
pnpm --filter ai-reasoning-agent typecheck        # 后端类型检查
pnpm --filter ai-reasoning-agent typecheck:web    # 前端类型检查
```
