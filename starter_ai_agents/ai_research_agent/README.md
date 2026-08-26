# AI Research Agent · 深度研究助手（多源搜索 + 事实收集 + 研究报告）

基于 [aipack](https://github.com/luoguoxiong/aipack) 的深度研究 Web 应用：输入任意**研究主题**，Agent 自动**制定研究计划**（搜索查询 + 重点方向）→ **多源收集信息**（Web 搜索 + HackerNews 社区 + 网页深读）→ **实时收集重要事实**（附来源）→ 产出**带参考来源的 Markdown 研究报告**——全程 SSE 流式，研究过程与报告双栏实时展示，报告可一键下载 `.md`。

迁移自 [awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps) 的两个应用并合并：
- **openai_research_agent**（OpenAI Agents SDK：Triage → Research → Editor 三 Agent 接力 + `save_important_fact` 事实收集 + Research Process/Report 双标签页）→ 以单一 Runtime 的三阶段系统提示词 + 事实收集工具等价编排，免多 Agent 框架依赖
- **multi_agent_researcher**（Agno Team：HackerNewsTools + DuckDuckGoTools + Newspaper4kTools 团队研究）→ `search_hackernews`（HN Algolia API，免 Key）+ `search_web`（四层降级搜索）+ `fetch_url`（网页正文抽取）

## 功能

- **三阶段研究循环**（单 Runtime 系统提示词编排）：
  1. **制定计划**——明确主题、3-5 个搜索查询、3-5 个重点方向（开篇输出）
  2. **收集信息**——多轮工具调用覆盖各重点方向：搜索 Web / HackerNews、深读最有价值的文章、保存重要事实
  3. **撰写报告**——结构化 Markdown：标题 → 大纲 → 执行摘要 → 分章节正文 → 结论 → 参考来源（编号 + 链接）
- **四大研究工具**：
  - `search_web`：四层降级搜索（SerpAPI → Bing → DuckDuckGo → 兜底提示，不返回伪知识）
  - `search_hackernews`：HN Algolia API（免费免 Key），技术/创业/产品主题的一手社区讨论
  - `fetch_url`：网页正文抽取（剥离脚本/样式/导航，启发式取文本密度最高区块，截断保护）
  - `save_important_fact`：事实收集（附来源），实时推送前端展示，供报告引用
- **双栏研究视图**：左栏研究过程（工具调用时间线徽标 + 事实列表 + 可折叠思考链），右栏报告（完整 Markdown 渲染：标题/列表/表格/链接/代码块，流式逐字输出）
- **报告下载**：一键导出 `.md` 文件（文件名取报告标题）
- **模型无关**：27 个内置模型可选（默认 DeepSeek Chat，可选 GPT-4o / Claude / Gemini / Grok 等）
- **API Key 双通道**：服务器 `.env` 优先；或前端输入（localStorage 持久化，服务器不存储）
- **可中止**：研究中随时停止（AbortController 贯穿前后端）

## 快速开始

```bash
# 1. 配置环境变量（或启动后在页面输入 API Key）
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY=xxx

# 2. 安装依赖（仓库根目录）
pnpm install

# 3. 启动开发模式（后端 3007 + Vite 5173）
pnpm --filter ai-research-agent dev

# 4. 打开 http://localhost:5173，输入研究主题开始
```

生产模式（单端口）：

```bash
pnpm --filter ai-research-agent build
pnpm --filter ai-research-agent serve   # http://localhost:3007
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `LLM_PROVIDER` | 否 | 研究模型 provider，默认 `deepseek` |
| `LLM_MODEL` | 否 | 模型 id，默认 `deepseek-chat` |
| `DEEPSEEK_API_KEY` | 视情况 | DeepSeek API Key（默认 provider；也可在页面输入） |
| `OPENAI_API_KEY` 等 | 视情况 | 切换 provider 时提供对应的 `*_API_KEY` |
| `SERPAPI_KEY` | 否 | 配置后搜索走 SerpAPI；否则免费降级链 Bing → DuckDuckGo → 兜底 |
| `PORT` | 否 | 后端端口，默认 `3007` |

> HackerNews 走 Algolia 公共 API，无需任何 Key。

## 架构

```
starter_ai_agents/ai_research_agent/
├── frontend/                  # React + Vite + TS
│   └── src/
│       ├── App.tsx            # 主状态机:主题输入 → SSE 流式研究 → 双栏展示
│       ├── api.ts             # /api/config + /api/research(SSE 消费)
│       └── components/        # ModelPicker / Markdown(零依赖渲染器) / ResearchProcess
└── src/                       # 后端:原生 http + aipack,零运行时框架依赖
    ├── server.ts              # http 服务 + SSE 研究流(每次研究独立 FactsStore/Runtime)
    ├── runtime.ts             # 研究 Runtime(三阶段系统提示词 + maxTurns=30 工具循环)
    ├── config.ts              # 模型装配(全内置目录 + 双通道 Key)
    ├── loadEnv.ts             # .env 加载
    └── tools/
        ├── search.ts          # search_web(四层降级搜索)
        ├── hackernews.ts      # search_hackernews(HN Algolia)
        ├── fetchUrl.ts        # fetch_url(网页正文抽取)
        └── facts.ts           # save_important_fact(事实收集 + SSE 回调)
```

### 数据流

```
研究主题 ──POST /api/research──→ 解析模型选择 → 构建本次研究 Runtime
                                        │
              系统提示词驱动三阶段循环(maxTurns=30)
                                        │
        ① search_web ────────┤  四层降级搜索
        ② search_hackernews ─┤  HN Algolia 社区讨论
        ③ fetch_url ─────────┤  深读文章正文
        ④ save_important_fact┤  事实收集(实时 SSE 推送)
                                        │
              最终输出:Markdown 研究报告(标题/大纲/正文/参考来源)
                                        │
        SSE: stage(start/tool_start/tool_end/done) / delta(text|thinking) / fact / error
                                        │
        前端:左栏过程(工具徽标+事实列表) | 右栏报告(Markdown 流式渲染 + 下载 .md)
```

### SSE 事件协议（`/api/research`）

| 事件 | 数据 | 说明 |
|---|---|---|
| `stage` | `{ stage: 'start', topic }` | 首个事件，研究开始 |
| `stage` | `{ stage: 'tool_start'\|'tool_end', toolName }` | 工具调用开始/结束 |
| `fact` | `{ fact, source }` | 新事实收集（save_important_fact 触发） |
| `delta` | `{ kind: 'text'\|'thinking', delta }` | 流式增量（报告正文/思考链） |
| `stage` | `{ stage: 'done' }` | 研究完成 |
| `error` | `{ message }` | 出错（明确引导提示） |

## 验证

```bash
pnpm --filter ai-research-agent typecheck        # 后端类型检查
pnpm --filter ai-research-agent typecheck:web    # 前端类型检查
pnpm --filter ai-research-agent build            # 生产构建（vite build + tsc）
```

> 已验证：HN Algolia 可达（"rust" 检索 5.9 万命中）、Bing 可解析（10 条/页）、网页抓取正常；DuckDuckGo 在当前网络超时——降级链自动回退 Bing，不影响可用性。
