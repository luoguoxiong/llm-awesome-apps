# AI Startup Trends Agent · 创业趋势分析助手（新闻收集 + 文章摘要 + 趋势与机会报告）

基于 [aipack](https://github.com/luoguoxiong/aipack) 的创业趋势分析 Web 应用：输入感兴趣的**创业领域**，Agent 自动**收集最新动态**（领域新闻 / 融资事件 / 市场分析多角度搜索）→ **深读高价值文章并整理摘要**（实时推送展示）→ 产出**新兴趋势与潜在创业机会分析报告**——全程 SSE 流式，三阶段进度与报告双栏实时展示，报告可一键下载 `.md`。

迁移自 [awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps) 的 **ai_startup_trend_analysis_agent**（Agno 三 Agent：News Collector → Summary Writer → Trend Analyzer）→ 以单一 Runtime 的三阶段系统提示词 + 文章摘要收集工具等价编排，免多 Agent 框架依赖：
- **DuckDuckGoTools（新闻收集）** → `search_web`（四层降级搜索：SerpAPI → Bing → DuckDuckGo → 兜底）
- **Newspaper4kTools（摘要）** → `fetch_url`（网页正文抽取）+ `save_article_summary`（摘要收集，实时 SSE 推送）
- **Trend Analyzer（趋势分析）** → 三阶段系统提示词的最终报告环节

## 功能

- **三阶段分析循环**（单 Runtime 系统提示词编排，等价源应用三 Agent 接力）：
  1. **新闻收集**——设计 3-5 个互补搜索查询（最新动态 / 融资事件 / 市场分析），逐个搜索并汇总发现
  2. **摘要整理**——挑选 4-6 篇最有价值的文章深读全文，每篇保存摘要（标题 / 来源 / 核心内容），实时推送前端
  3. **趋势分析**——结构化 Markdown 报告：市场概览 → 新兴趋势（现象/证据/驱动因素）→ 潜在创业机会（定位/目标用户/差异化/风险）→ 风险与不确定性 → 参考来源
- **三大分析工具**：
  - `search_web`：四层降级搜索（SerpAPI → Bing → DuckDuckGo → 兜底提示，不返回伪知识）
  - `fetch_url`：网页正文抽取（剥离脚本/样式/导航，启发式取文本密度最高区块，截断保护）
  - `save_article_summary`：文章摘要收集（标题/来源/摘要），实时推送前端展示，供报告引用
- **双栏分析视图**：左栏分析过程（三阶段进度条 + 工具调用时间线 + 文章摘要列表 + 可折叠思考链），右栏报告（完整 Markdown 渲染：标题/列表/表格/链接/代码块，流式逐字输出）
- **报告下载**：一键导出 `.md` 文件（文件名取报告标题）
- **模型无关**：27 个内置模型可选（默认 DeepSeek Chat；源应用用 Gemini，可切换 google/gemini-2.5-flash 等价体验）
- **API Key 双通道**：服务器 `.env` 优先；或前端输入（localStorage 持久化，服务器不存储）
- **可中止**：分析中随时停止（AbortController 贯穿前后端）

## 快速开始

```bash
# 1. 配置环境变量（或启动后在页面输入 API Key）
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY=xxx

# 2. 安装依赖（仓库根目录）
pnpm install

# 3. 启动开发模式（后端 3010 + Vite 5173）
pnpm --filter ai-startup-trends-agent dev

# 4. 打开 http://localhost:5173，输入创业领域开始分析
```

生产模式（单端口）：

```bash
pnpm --filter ai-startup-trends-agent build
pnpm --filter ai-startup-trends-agent serve   # http://localhost:3010
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `LLM_PROVIDER` | 否 | 分析模型 provider，默认 `deepseek` |
| `LLM_MODEL` | 否 | 模型 id，默认 `deepseek-chat` |
| `DEEPSEEK_API_KEY` | 视情况 | DeepSeek API Key（默认 provider；也可在页面输入） |
| `OPENAI_API_KEY` 等 | 视情况 | 切换 provider 时提供对应的 `*_API_KEY` |
| `SERPAPI_KEY` | 否 | 配置后搜索走 SerpAPI；否则免费降级链 Bing → DuckDuckGo → 兜底 |
| `PORT` | 否 | 后端端口，默认 `3010` |

## 架构

```
starter_ai_agents/ai_startup_trends_agent/
├── frontend/                  # React + Vite + TS
│   └── src/
│       ├── App.tsx            # 主状态机:领域输入 → SSE 流式分析 → 双栏展示
│       ├── api.ts             # /api/config + /api/analyze(SSE 消费)
│       └── components/        # ModelPicker / Markdown(零依赖渲染器) / AnalysisProcess
└── src/                       # 后端:原生 http + aipack,零运行时框架依赖
    ├── server.ts              # http 服务 + SSE 分析流(每次分析独立 SummariesStore/Runtime)
    ├── runtime.ts             # 分析 Runtime(三阶段系统提示词 + 阶段推断 + maxTurns=24 工具循环)
    ├── config.ts              # 模型装配(全内置目录 + 双通道 Key)
    ├── loadEnv.ts             # .env 加载
    └── tools/
        ├── search.ts          # search_web(四层降级搜索)
        ├── fetchUrl.ts        # fetch_url(网页正文抽取)
        └── summaries.ts       # save_article_summary(摘要收集 + SSE 回调)
```

### 数据流

```
创业领域 ──POST /api/analyze──→ 解析模型选择 → 构建本次分析 Runtime
                                        │
              系统提示词驱动三阶段循环(maxTurns=24)
                                        │
        ① search_web ──────────┤  四层降级搜索(动态/融资/市场)
        ② fetch_url ───────────┤  深读文章正文
        ③ save_article_summary ┤  摘要收集(实时 SSE 推送)
                                        │
              最终输出:趋势分析报告(市场概览/新兴趋势/创业机会/参考来源)
                                        │
        SSE: stage(start/tool_start/tool_end/done) / phase(collect→summarize→analyze)
             / delta(text|thinking) / summary / error
                                        │
        前端:左栏过程(三阶段进度+工具徽标+摘要列表) | 右栏报告(Markdown 流式渲染 + 下载 .md)
```

### SSE 事件协议（`/api/analyze`）

| 事件 | 数据 | 说明 |
|---|---|---|
| `stage` | `{ stage: 'start', topic }` | 首个事件，分析开始 |
| `stage` | `{ stage: 'tool_start'\|'tool_end', toolName }` | 工具调用开始/结束 |
| `phase` | `{ phase: 'collect'\|'summarize'\|'analyze' }` | 阶段切换（由工具调用启发式推断） |
| `summary` | `{ title, source, summary }` | 新文章摘要（save_article_summary 触发） |
| `delta` | `{ kind: 'text'\|'thinking', delta }` | 流式增量（报告正文/思考链） |
| `stage` | `{ stage: 'done' }` | 分析完成 |
| `error` | `{ message }` | 出错（明确引导提示） |

## 验证

```bash
pnpm --filter ai-startup-trends-agent typecheck        # 后端类型检查
pnpm --filter ai-startup-trends-agent typecheck:web    # 前端类型检查
pnpm --filter ai-startup-trends-agent build            # 生产构建（vite build + tsc）
```

> 已验证：双端 typecheck 通过、/api/config 返回 27 个模型、错误路径返回明确 400 提示、SSE 事件协议正常（含无效 Key 的 401 透传）、生产构建单端口静态服务正常。端到端对话流因无 LLM API Key 未实测，但 SSE/Runtime 链路与已验证的 research/finance agent 完全同构。
