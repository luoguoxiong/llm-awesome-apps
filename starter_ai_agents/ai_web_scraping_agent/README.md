# Web Scraping AI Agent · 智能抓取(自然语言 → 网页结构化数据)

基于 [aipack](https://github.com/luoguoxiong/aipack) 的智能抓取 Web 应用:输入**目标网址**和一句**自然语言抽取指令**(如"提取所有产品的名称、价格和库存状态"),Agent 自动抓取页面正文并抽取**结构化 JSON 数据**——SSE 流式输出,前端自动提取 JSON 代码块、格式化展示并支持一键复制。

迁移自 [awesome-llm-apps/starter_ai_agents/web_scraping_ai_agent](https://github.com/Shubhamsaboo/awesome-llm-apps/tree/main/starter_ai_agents/web_scraping_ai_agent)(Python/ScrapeGraphAI + Streamlit,SmartScraperGraph 抓取 + LLM 抽取;Ollama 本地变体由模型下拉自然覆盖)。

## 功能

- **自然语言抽取**:无需写选择器,一句指令描述想要的数据(电商 / 内容 / 竞品 / 线索四大场景示例一键填入)
- **智能抓取工具** `scrape_web`:三层降级(Firecrawl → 原生 fetch + HTML 正文提取 → 兜底提示),自动去噪(导航/脚本/页脚),正文截断保护(20k 字符)
- **Agent 工作流**:收到 URL 后自主调用抓取工具 → 阅读正文 → 按指令输出结构化 JSON(```json 代码块约定),工具调用以徽标实时展示
- **结构化结果**:完成后前端自动提取 JSON 代码块,格式化高亮 + **一键复制**(对齐源应用 SmartScraperGraph 的结构化输出体验)
- **模型无关**:27 个内置模型可选(默认 DeepSeek Chat,可选 GPT-4o / Claude / Gemini / Grok 等)
- **SSE 流式**:思考链(thinking)可折叠实时观看,正文逐字渲染
- **API Key 双通道**:服务器 `.env` 优先;或前端输入(localStorage 持久化,服务器不存储)
- **可中止**:生成中随时取消(AbortController 贯穿前后端)

## 快速开始

```bash
# 1. 配置环境变量(或启动后在页面输入 API Key)
cp .env.example .env
# 编辑 .env,填入 DEEPSEEK_API_KEY=xxx

# 2. 安装依赖(仓库根目录)
pnpm install

# 3. 启动开发模式(后端 3004 + Vite 5173)
pnpm --filter ai-web-scraping-agent dev

# 4. 打开 http://localhost:5173
```

生产模式(单端口):

```bash
pnpm --filter ai-web-scraping-agent build
pnpm --filter ai-web-scraping-agent serve   # http://localhost:3004
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `LLM_PROVIDER` | 否 | 抽取模型 provider,默认 `deepseek` |
| `LLM_MODEL` | 否 | 模型 id,默认 `deepseek-chat` |
| `DEEPSEEK_API_KEY` | 视情况 | DeepSeek API Key(默认 provider;也可在页面输入) |
| `OPENAI_API_KEY` 等 | 视情况 | 切换 provider 时提供对应的 `*_API_KEY` |
| `FIRECRAWL_API_KEY` | 否 | 配置后抓取优先走 Firecrawl(高质量 markdown);缺省用免费降级链(原生 fetch → 兜底) |
| `PORT` | 否 | 后端端口,默认 `3004` |

## 架构

```
starter_ai_agents/ai_web_scraping_agent/
├── frontend/                  # React + Vite + TS
│   └── src/
│       ├── App.tsx            # 主状态机:URL + 指令 → 模型选择 → SSE 流式渲染
│       ├── api.ts             # /api/config + /api/scrape(SSE) + extractJsonBlock
│       └── components/        # ModelPicker / ResultPanel(JSON 块 + 复制)
└── src/                       # 后端:原生 http + aipack,零运行时框架依赖
    ├── server.ts              # http 服务 + SSE + 静态资源 + SPA fallback
    ├── runtime.ts             # 抽取 Runtime(scrape_web 工具 + JSON 输出约定)
    ├── config.ts              # 模型装配(全内置目录 + 双通道 Key)
    ├── loadEnv.ts             # .env 加载
    └── tools/scrape.ts        # scrape_web 工具(Firecrawl → fetch → 兜底)
```

### 数据流

```
URL + 抽取指令 ──POST /api/scrape──→ aipack Agent
                                        │
                          ① scrape_web 工具(三层降级抓取正文)
                                        │
                          ② 阅读正文,按指令抽取(思考链可见)
                                        │
                          ③ 输出:说明 + ```json 结构化数据
                                        │
              SSE: stage / delta(text|thinking) / error
                                        │
              前端自动提取 JSON → 格式化展示 + 一键复制
```

### SSE 事件协议(`/api/scrape`)

| 事件 | 数据 | 说明 |
|---|---|---|
| `stage` | `{ stage: 'start'\|'done' }` 或 `{ stage: 'tool_start'\|'tool_end', toolName }` | 抽取开始/完成;工具调用开始/结束 |
| `delta` | `{ kind: 'text'\|'thinking', delta }` | 流式增量(正文/思考链) |
| `error` | `{ message }` | 抽取出错(明确引导提示) |

## 验证

```bash
pnpm --filter ai-web-scraping-agent typecheck        # 后端类型检查
pnpm --filter ai-web-scraping-agent typecheck:web    # 前端类型检查
```
