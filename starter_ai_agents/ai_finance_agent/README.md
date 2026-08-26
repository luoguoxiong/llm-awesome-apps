# AI Finance Agent · 金融分析助手(对话式行情 + 资讯分析)

基于 [aipack](https://github.com/luoguoxiong/aipack) 的多轮对话式金融分析 Web 应用:像聊天一样提问(如"AAPL 现在多少钱?""对比 AAPL 和 MSFT 近 30 天表现"),Agent 自动查询**实时行情**、**历史走势统计**并**搜索财经资讯**,给出表格化数据 + 要点式解读——SSE 流式输出,思考链与工具调用实时可见。

迁移自 [awesome-llm-apps/starter_ai_agents/xai_finance_agent](https://github.com/Shubhamsaboo/awesome-llm-apps/tree/main/starter_ai_agents/xai_finance_agent)(Python/Agno + xAI Grok + YFinance + DuckDuckGo + AgentOS playground;本实现以 aipack 工具调用循环等价替代,模型无关,指令沿用源应用"金融数据用表格、文字用要点"的约定)。

## 功能

- **多轮对话**:`sessionId` 维持上下文,可连续追问("那 MSFT 呢?""近 3 个月走势如何?");"新对话"按钮一键开启全新会话(对齐源 playground 的会话体验)
- **实时行情工具** `get_stock_quote`:最新价、涨跌幅、昨收、开盘、日内高低、52 周高低、成交量;支持美股(`AAPL`)与 A 股(`600519` / `600519.SS`)
- **历史统计工具** `get_stock_history`:近 N 天(默认 30,最长 730)日线统计——区间涨跌幅、最高/最低、均价、**年化波动率**、最近 5 日收盘
- **行情四层降级**(全免 Key):Yahoo Finance → 腾讯财经(中国网络友好,GBK 自动解码)→ Stooq → 兜底提示(引导 Agent 改用搜索),任何网络环境都有可用数据源
- **财经搜索工具** `search_web`:四层降级(SerpAPI → Bing → DuckDuckGo → 兜底),覆盖公司新闻、财报解读、分析师观点、宏观政策
- **格式约定**:金融/数值数据用 Markdown 表格,文字观点用要点列表(沿用源应用 instructions)
- **模型无关**:27 个内置模型可选(默认 DeepSeek Chat,可选 GPT-5 / Claude / Gemini / Grok 等)
- **SSE 流式**:思考链(thinking)可折叠实时观看,正文逐字渲染,工具调用以徽标展示
- **API Key 双通道**:服务器 `.env` 优先;或前端输入(localStorage 持久化,服务器不存储)
- **可中止**:生成中随时停止(AbortController 贯穿前后端)

## 快速开始

```bash
# 1. 配置环境变量(或启动后在页面输入 API Key)
cp .env.example .env
# 编辑 .env,填入 DEEPSEEK_API_KEY=xxx

# 2. 安装依赖(仓库根目录)
pnpm install

# 3. 启动开发模式(后端 3005 + Vite 5173)
pnpm --filter ai-finance-agent dev

# 4. 打开 http://localhost:5173
```

生产模式(单端口):

```bash
pnpm --filter ai-finance-agent build
pnpm --filter ai-finance-agent serve   # http://localhost:3005
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `LLM_PROVIDER` | 否 | 分析模型 provider,默认 `deepseek` |
| `LLM_MODEL` | 否 | 模型 id,默认 `deepseek-chat` |
| `DEEPSEEK_API_KEY` | 视情况 | DeepSeek API Key(默认 provider;也可在页面输入) |
| `OPENAI_API_KEY` 等 | 视情况 | 切换 provider 时提供对应的 `*_API_KEY` |
| `SERPAPI_API_KEY` | 否 | 配置后搜索优先走 SerpAPI(高质量);缺省用免费降级链(Bing → DuckDuckGo → 兜底) |
| `PORT` | 否 | 后端端口,默认 `3005` |

> 行情数据源(Yahoo / 腾讯财经 / Stooq)均免 Key,无需任何配置。

## 架构

```
starter_ai_agents/ai_finance_agent/
├── frontend/                  # React + Vite + TS
│   └── src/
│       ├── App.tsx            # 聊天主状态机:消息流 + 会话管理 + SSE 流式渲染
│       ├── api.ts             # /api/config + /api/session/new + /api/chat(SSE)
│       └── components/        # ModelPicker / ChatMessage(思考链折叠 + 工具徽标)
└── src/                       # 后端:原生 http + aipack,零运行时框架依赖
    ├── server.ts              # http 服务 + SSE + 静态资源 + SPA fallback
    ├── runtime.ts             # 金融分析 Runtime(三工具 + 多轮会话 + maxSessions)
    ├── config.ts              # 模型装配(全内置目录 + 双通道 Key)
    ├── loadEnv.ts             # .env 加载
    └── tools/
        ├── market.ts          # 行情工具:Yahoo → 腾讯 → Stooq → 兜底(四层降级)
        └── search.ts          # 搜索工具:SerpAPI → Bing → DuckDuckGo → 兜底
```

### 数据流

```
用户消息 ──POST /api/chat(sessionId)──→ aipack Runtime(按 sessionKey 维护会话)
                                              │
                          ① get_stock_quote   ─┤  实时数据 → 四层降级行情源
                          ② get_stock_history ─┤  历史统计 → Yahoo / 腾讯日 K
                          ③ search_web        ─┤  财经资讯 → 四层降级搜索
                                              │
                          ④ 综合数据 + 资讯 → 表格化回答(表格数据 / 要点观点)
                                              │
              SSE: stage(session|tool_start|tool_end|start|done) / delta(text|thinking) / error
                                              │
              前端:消息气泡 + 工具徽标 + 思考链折叠 + 逐字渲染
```

### SSE 事件协议(`/api/chat`)

| 事件 | 数据 | 说明 |
|---|---|---|
| `stage` | `{ stage: 'session', sessionId }` | 首个事件,下发会话 ID(前端持久化) |
| `stage` | `{ stage: 'start'\|'done' }` | 本轮回答开始/完成 |
| `stage` | `{ stage: 'tool_start'\|'tool_end', toolName }` | 工具调用开始/结束 |
| `delta` | `{ kind: 'text'\|'thinking', delta }` | 流式增量(正文/思考链) |
| `error` | `{ message }` | 出错(明确引导提示) |

## 验证

```bash
pnpm --filter ai-finance-agent typecheck        # 后端类型检查
pnpm --filter ai-finance-agent typecheck:web    # 前端类型检查
pnpm --filter ai-finance-agent build            # 生产构建(vite build + tsc)
```

> 数据仅供参考,不构成投资建议。
