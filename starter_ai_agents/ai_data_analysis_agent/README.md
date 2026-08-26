# AI Data Analysis Agent · 数据分析助手（CSV/Excel 问答 + 可视化）

基于 [aipack](https://github.com/luoguoxiong/aipack) 的对话式数据分析 Web 应用：上传 **CSV / Excel**，用自然语言提问（如"各分类的销售额对比？""按月份汇总数量趋势，画条折线图"），Agent 自动执行**结构化查询**（过滤 / 分组 / 聚合 / 排序）并生成 **Markdown 表格 + ECharts 图表**——SSE 流式输出，思考链与工具调用实时可见。

迁移自 [awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps/tree/main/starter_ai_agents) 的两个应用并合并：
- **ai_data_analysis_agent**（Python/Agno + gpt-4o + DuckDB SQL 问答）→ 免 SQL 的结构化查询工具 `get_data_summary` / `query_data`（JSON 参数无注入风险，覆盖聚合对比 / 过滤明细 / 分组统计 / Top-N）
- **ai_data_visualisation_agent**（Together AI + E2B 沙箱 matplotlib 图表）→ ` ```echarts ` 代码块约定 + 前端 ECharts 渲染（免沙箱、免额外 Key）

## 功能

- **数据集上传**：点击或拖拽上传 `.csv / .tsv / .xlsx / .xls`（最大 15MB、5 万行）；自动类型推断（number / date / string）+ 缺失值 / 唯一值 / 数值范围统计 + 前 8 行预览
- **结构概览工具** `get_data_summary`：总行数、每列类型、缺失数、唯一值数、数值列 min/max/mean、样例行——Agent 分析前的"摸底"
- **结构化查询工具** `query_data`：`filters`（eq/ne/gt/gte/lt/lte/contains）+ `groupBy`（多列分组）+ `aggregations`（count/sum/avg/min/max）+ `sort` + `limit`，返回 Markdown 表格
- **ECharts 可视化**：用户要图表时，Agent 在回答末尾输出合法 ECharts option JSON，前端直接渲染（柱状 / 折线 / 饼图 / 散点），流式完成后自动出图
- **多轮对话**：`sessionId` 维持上下文，可连续追问；上传新数据集自动开新会话
- **模型无关**：27 个内置模型可选（默认 DeepSeek Chat，可选 GPT-5 / Claude / Gemini / Grok 等）
- **SSE 流式**：思考链（thinking）可折叠实时观看，正文逐字渲染，工具调用以徽标展示
- **API Key 双通道**：服务器 `.env` 优先；或前端输入（localStorage 持久化，服务器不存储）
- **可中止**：生成中随时停止（AbortController 贯穿前后端）

## 快速开始

```bash
# 1. 配置环境变量（或启动后在页面输入 API Key）
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY=xxx

# 2. 安装依赖（仓库根目录）
pnpm install

# 3. 启动开发模式（后端 3006 + Vite 5173）
pnpm --filter ai-data-analysis-agent dev

# 4. 打开 http://localhost:5173，上传任意 CSV 开始提问
```

生产模式（单端口）：

```bash
pnpm --filter ai-data-analysis-agent build
pnpm --filter ai-data-analysis-agent serve   # http://localhost:3006
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `LLM_PROVIDER` | 否 | 分析模型 provider，默认 `deepseek` |
| `LLM_MODEL` | 否 | 模型 id，默认 `deepseek-chat` |
| `DEEPSEEK_API_KEY` | 视情况 | DeepSeek API Key（默认 provider；也可在页面输入） |
| `OPENAI_API_KEY` 等 | 视情况 | 切换 provider 时提供对应的 `*_API_KEY` |
| `PORT` | 否 | 后端端口，默认 `3006` |

> 查询引擎与图表渲染均在应用内完成，除 LLM Key 外无需任何外部服务。

## 架构

```
starter_ai_agents/ai_data_analysis_agent/
├── frontend/                  # React + Vite + TS + ECharts
│   └── src/
│       ├── App.tsx            # 主状态机：上传 → 预览 → 对话（SSE 流式渲染）
│       ├── api.ts             # /api/config + /api/dataset(上传) + /api/chat(SSE)
│       └── components/        # ModelPicker / ChatMessage / EChartBlock
└── src/                       # 后端：原生 http + aipack，零运行时框架依赖
    ├── server.ts              # http 服务 + 上传解析 + SSE + 静态资源
    ├── runtime.ts             # 数据分析 Runtime（两工具 + 多轮会话 + echarts 约定提示词）
    ├── dataset.ts             # CSV/Excel 解析 + 类型推断 + LRU 缓存（xlsx）
    ├── config.ts              # 模型装配（全内置目录 + 双通道 Key）
    ├── loadEnv.ts             # .env 加载
    └── tools/
        └── query.ts           # get_data_summary + query_data（查询引擎）
```

### 数据流

```
上传 CSV/Excel ──POST /api/dataset──→ 解析 + 类型推断 + 内存缓存（LRU）
                                             │
用户提问 ──POST /api/chat(datasetId+sessionId)──→ aipack Runtime（按 (模型,数据集) 缓存）
                                             │
                 ① get_data_summary ─┤  结构概览 → 列/类型/缺失/范围/样例
                 ② query_data       ─┤  精确查询 → 过滤/分组聚合/排序/Top-N
                                             │
                 ③ 回答 = Markdown 表格 + 要点解读 + ```echarts 图表 JSON
                                             │
             SSE: stage(session|tool_start|tool_end|start|done) / delta(text|thinking) / error
                                             │
             前端：消息气泡 + 工具徽标 + 思考链折叠 + 逐字渲染 + ECharts 出图
```

### SSE 事件协议（`/api/chat`）

| 事件 | 数据 | 说明 |
|---|---|---|
| `stage` | `{ stage: 'session', sessionId }` | 首个事件，下发会话 ID（前端持久化） |
| `stage` | `{ stage: 'start'\|'done' }` | 本轮回答开始/完成 |
| `stage` | `{ stage: 'tool_start'\|'tool_end', toolName }` | 工具调用开始/结束 |
| `delta` | `{ kind: 'text'\|'thinking', delta }` | 流式增量（正文/思考链） |
| `error` | `{ message }` | 出错（明确引导提示） |

## 验证

```bash
pnpm --filter ai-data-analysis-agent typecheck        # 后端类型检查
pnpm --filter ai-data-analysis-agent typecheck:web    # 前端类型检查
pnpm --filter ai-data-analysis-agent build            # 生产构建（vite build + tsc）
```

> 数据在服务端内存中分析（刷新页面或重启服务后需重新上传）；数据集不会持久化到磁盘。
