# Multimodal AI Agent · 多模态分析(图片 / 视频 + Web 搜索)

基于 [aipack](https://github.com/luoguoxiong/aipack) 的多模态分析 Web 应用：上传**图片**或**视频**并提出问题，AI 先理解画面内容，再结合 **web 搜索**给出实用、可操作的回答——SSE 流式输出，支持思考链与工具调用过程实时展示。

迁移自 [awesome-llm-apps/starter_ai_agents/multimodal_ai_agent](https://github.com/Shubhamsaboo/awesome-llm-apps/tree/main/starter_ai_agents/multimodal_ai_agent)(Python/Agno + Streamlit,Gemini 2.5 视频分析 + web search)。

## 功能

- **图片分析**:JPG / PNG / WebP / GIF / BMP,前端自动压缩(最长边 ≤1568px,EXIF 方向自动校正)
- **视频分析**:MP4 / MOV / AVI / WebM——浏览器端 `<video>` + canvas **均匀抽取关键帧**(3/6/9 帧可选,帧网格预览),以多帧图片序列实现视频内容理解(时间顺序保留)
- **web 搜索工具**:`search_web` 四层降级(SerpAPI → Bing → DuckDuckGo → 兜底提示),识别地标/品牌/人物后自动联网补充背景,工具调用以徽标实时展示
- **多模态模型目录**:模型下拉只列出 aipack 目录中 `input` 含 `image` 的模型(默认 Google Gemini 2.5 Flash,可选 GPT-4o / GPT-5 / o3 / Claude / Grok 等 15 个)
- **SSE 流式**:思考链(thinking)可折叠实时观看,正文逐字渲染,工具调用阶段徽标提示
- **API Key 双通道**:服务器 `.env` 优先;或前端输入(localStorage 持久化,服务器不存储)
- **可中止**:生成中随时取消(AbortController 贯穿前后端)

> 注:源应用将视频文件直接交给 Gemini;aipack 多模态通路(`Request.media`)仅支持图片,故视频在**浏览器端抽帧**后发送——无需服务端视频编解码依赖,隐私友好(视频不上传服务器,仅帧图片参与请求)。

## 快速开始

```bash
# 1. 配置环境变量(或启动后在页面输入 API Key)
cp .env.example .env
# 编辑 .env,填入 GOOGLE_API_KEY=xxx

# 2. 安装依赖(仓库根目录)
pnpm install

# 3. 启动开发模式(后端 3003 + Vite 5173)
pnpm --filter ai-multimodal-agent dev

# 4. 打开 http://localhost:5173
```

生产模式(单端口):

```bash
pnpm --filter ai-multimodal-agent build
pnpm --filter ai-multimodal-agent serve   # http://localhost:3003
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `LLM_PROVIDER` | 否 | 多模态模型 provider,默认 `google` |
| `LLM_MODEL` | 否 | 模型 id,默认按 provider 取( google → `gemini-2.5-flash`;必须是 input 含 image 的模型) |
| `GOOGLE_API_KEY` | 视情况 | Google API Key(默认 provider;也可在页面输入) |
| `OPENAI_API_KEY` 等 | 视情况 | 切换 provider 时提供对应的 `*_API_KEY` |
| `SERPAPI_KEY` | 否 | 配置后搜索走 SerpAPI;缺省用免费降级链(Bing → DuckDuckGo → 兜底) |
| `PORT` | 否 | 后端端口,默认 `3003` |

## 架构

```
starter_ai_agents/ai_multimodal_agent/
├── frontend/                  # React + Vite + TS
│   └── src/
│       ├── App.tsx            # 主状态机:媒体上传 → 模型选择 → SSE 流式渲染
│       ├── api.ts             # /api/config + /api/analyze(SSE) 封装
│       ├── frames.ts          # 浏览器端媒体预处理:图片压缩 + 视频关键帧抽取(canvas)
│       └── components/        # MediaUploader / ModelPicker / ResultPanel
└── src/                       # 后端:原生 http + aipack,零运行时框架依赖
    ├── server.ts              # http 服务 + SSE + 静态资源 + SPA fallback
    ├── runtime.ts             # 多模态分析 Runtime(media → ImageContent + search_web 工具)
    ├── config.ts              # 模型装配(目录过滤 input 含 image + 双通道 Key)
    ├── loadEnv.ts             # .env 加载
    └── tools/search.ts        # search_web 工具(SerpAPI → Bing → DuckDuckGo → 兜底)
```

### 数据流

```
图片文件 ──(压缩 ≤1568px)────────────┐
                                     ├→ data URI base64[] → POST /api/analyze
视频文件 ──(canvas 抽帧 3/6/9 张)────┘        │
                                              ▼
                        createRequest(question, { media })   ← aipack Request.media
                                              │
                        runtime.stream() ── ImageContent 内容块 → provider API
                              │                            ↑
                              │                    search_web 工具(四层降级)
                              ▼
                    SSE: stage / delta(text|thinking) / error
```

### SSE 事件协议(`/api/analyze`)

| 事件 | 数据 | 说明 |
|---|---|---|
| `stage` | `{ stage: 'start'\|'done' }` 或 `{ stage: 'tool_start'\|'tool_end', toolName }` | 分析开始/完成;工具调用开始/结束 |
| `delta` | `{ kind: 'text'\|'thinking', delta }` | 流式增量(正文/思考链) |
| `error` | `{ message }` | 分析出错(明确引导提示) |

请求体上限 25MB,单次最多 10 张图(视频抽帧上限);`media` 元素必须是 `data:image/*;base64,` 格式。

## 验证

```bash
pnpm --filter ai-multimodal-agent typecheck        # 后端类型检查
pnpm --filter ai-multimodal-agent typecheck:web    # 前端类型检查
```
