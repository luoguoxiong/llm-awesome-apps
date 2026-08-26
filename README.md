# llm-awesome-apps

基于 [aipack](https://github.com/luoguoxiong/aipack) 框架构建的 LLM 示例应用合集：Agent 编排、RAG、多 Agent 协作、TTS 语音合成、Office 文档操作，全部 TypeScript 实现、零运行时框架依赖（原生 http + SSE）。

目录结构对齐源项目 [awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps)（Python/Streamlit 版），按相同分类组织，迁移全景与进度见 [PLAN.md](./PLAN.md)。

## 应用一览

### starter_ai_agents — 入门单 Agent

| 应用 | 说明 | 亮点 |
| ---- | ---- | ---- |
| [ai_travel_agent](./starter_ai_agents/ai_travel_agent) | AI 旅行助手 | Researcher + Planner 双 Agent + 联网搜索 + ICS 日历导出 |
| [ai_blog_to_podcast_agent](./starter_ai_agents/ai_blog_to_podcast_agent) | AI 博客转播客 | 网页抓取 → 内容改写 → Edge TTS 免费语音合成 |
| [ai_reasoning_agent](./starter_ai_agents/ai_reasoning_agent) | 推理模型对比 | 普通模型 vs 推理模型双栏并行流式对比 + 思考链展示 |
| [ai_multimodal_agent](./starter_ai_agents/ai_multimodal_agent) | 多模态分析 | 图片/视频理解（浏览器抽帧）+ web 搜索 + 15 个多模态模型 |
| [ai_web_scraping_agent](./starter_ai_agents/ai_web_scraping_agent) | 智能抓取 | 自然语言抽取指令 → 网页结构化 JSON（三层降级抓取 + 一键复制） |

### advanced_ai_agents — 高级多 Agent

| 应用 | 说明 | 亮点 |
| ---- | ---- | ---- |
| [ai_teaching_agent_team](./advanced_ai_agents/multi_agent_apps/ai_teaching_agent_team) | 教学 Agent 团队 | 4-Agent 顺序接力协作 + React 前端 + Markdown 导出 |

### advanced_llm_apps — 高级 LLM 应用

| 应用 | 说明 | 亮点 |
| ---- | ---- | ---- |
| [ai_office_agent](./advanced_llm_apps/ai_office_agent) | AI 办公助手 | Tauri 桌面端 + Office 文档操作（Excel/Word/PPT）+ 文件工具 |

### rag_tutorials — RAG 教程

| 应用 | 说明 | 亮点 |
| ---- | ---- | ---- |
| [ai_rag_database_routing](./rag_tutorials/ai_rag_database_routing) | RAG 数据库路由 | 向量路由 → LLM 路由 → 网页搜索兜底，三级降级 |

## 快速开始

本仓库为 pnpm workspace（Node.js ≥ 18）：

```bash
# 1. 安装依赖（仓库根目录执行）
pnpm install

# 2. 配置 API Key（进入任意 app 目录）
cd starter_ai_agents/ai_travel_agent
cp .env.example .env
# 编辑 .env，至少配置一个 LLM API Key（默认 DeepSeek）

# 3. 启动开发模式（仓库根目录执行）
pnpm --filter ai-travel-agent dev
```

各应用的详细配置（环境变量、端口、专属依赖如 OfficeCLI）见对应 app 的 README。

## 通用说明

- **LLM 提供商**：默认 DeepSeek，支持 OpenAI / Anthropic / Google / Groq 等；API Key 可在服务器 `.env` 配置，也可由前端用户输入（localStorage 持久化）。完整 provider 与 envVar 对照见 aipack 仓库 [`packages/agent/ai/catalog.ts`](https://github.com/luoguoxiong/aipack/blob/master/packages/agent/ai/catalog.ts) 的 `BUILTIN_PROVIDERS`。
- **框架依赖**：各 app 通过 npm 包 `@aipack-ai/agent`（多 Agent 应用另有 `@aipack-ai/multi-agent`，旅行助手含 `@aipack-ai/observability`）使用 aipack 框架，框架源码与文档见 [aipack 仓库](https://github.com/luoguoxiong/aipack)。
- **常用命令**：

```bash
pnpm -r --if-present typecheck   # 全部 app 类型检查
pnpm -r --if-present build       # 全部 app 生产构建
```

## License

MIT
