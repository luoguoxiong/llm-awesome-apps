# Medical Imaging Agent · 医学影像分析（读片 + 结构化诊断报告 + 文献检索）

基于 [aipack](https://github.com/luoguoxiong/aipack) 的医学影像分析 Web 应用：上传 **X 光 / CT / MRI / 超声**等医学影像（可选补充临床背景），AI 以放射科专家视角输出 **5 段式结构化诊断报告**——影像类型与部位 · 关键发现 · 诊断评估 · 患者友好解释 · 研究背景（联网检索医学文献），SSE 流式渲染。

迁移自 [awesome-llm-apps/starter_ai_agents/ai_medical_imaging_agent](https://github.com/Shubhamsaboo/awesome-llm-apps/tree/main/starter_ai_agents/ai_medical_imaging_agent)（Python/Agno + Streamlit，Gemini 2.5 Pro + DuckDuckGo 搜索 + 固定 5 段分析提示词）。

> ⚠️ **免责声明**：本工具仅供教育与信息参考，所有分析结果应由执业医疗专业人员复核，请勿仅凭本分析做出任何医疗决策。

## 功能

- **医学影像分析**：JPG / PNG / WebP / GIF / BMP（前端自动压缩 ≤1568px，EXIF 方向自动校正）；DICOM 等专业格式请先转换为 PNG/JPG（浏览器无法原生解码）
- **5 段式结构化报告**（对齐源应用的固定分析提示词）：
  1. **影像类型与部位**：成像方式 / 解剖部位与体位 / 图像质量评估
  2. **关键发现**：系统化观察清单，异常的位置、大小、形态、密度描述 + 严重程度分级（正常/轻度/中度/重度）
  3. **诊断评估**：主要诊断 + 置信度，按可能性排序的鉴别诊断（附影像证据），危急发现标注
  4. **患者友好解释**：通俗语言 + 形象类比 + 常见疑虑解答
  5. **研究背景**：调用 `search_web` 检索类似病例文献、标准诊疗方案，附 2~3 条参考文献链接
- **临床背景输入**（可选）：补充年龄/性别/症状/关注点，提高分析针对性
- **文献搜索工具**：`search_web` 四层降级（SerpAPI → Bing → DuckDuckGo → 兜底提示），工具调用以徽标实时展示
- **多模态模型目录**：模型下拉只列出 `input` 含 `image` 的模型（默认 Google Gemini 2.5 Pro，对齐源应用；可选 GPT-4o / Claude / Grok 等 15 个）
- **SSE 流式**：思考链（thinking）可折叠实时观看，报告以 Markdown 逐字渲染（标题/列表/表格/链接）
- **API Key 双通道**：服务器 `.env` 优先；或前端输入（localStorage 持久化，服务器不存储）
- **可中止**：生成中随时取消（AbortController 贯穿前后端）

## 快速开始

```bash
# 1. 配置环境变量（或启动后在页面输入 API Key）
cp .env.example .env
# 编辑 .env，填入 GOOGLE_API_KEY=xxx

# 2. 安装依赖（仓库根目录）
pnpm install

# 3. 启动开发模式（后端 3012 + Vite 5173）
pnpm --filter ai-medical-imaging-agent dev

# 4. 打开 http://localhost:5173
```

生产模式（单端口）：

```bash
pnpm --filter ai-medical-imaging-agent build
pnpm --filter ai-medical-imaging-agent serve   # http://localhost:3012
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `LLM_PROVIDER` | 否 | 多模态模型 provider，默认 `google` |
| `LLM_MODEL` | 否 | 模型 id，默认按 provider 取（google → `gemini-2.5-pro`；必须是 input 含 image 的模型） |
| `GOOGLE_API_KEY` | 视情况 | Google API Key（默认 provider；也可在页面输入） |
| `OPENAI_API_KEY` 等 | 视情况 | 切换 provider 时提供对应的 `*_API_KEY` |
| `SERPAPI_KEY` | 否 | 配置后文献搜索走 SerpAPI；缺省用免费降级链（Bing → DuckDuckGo → 兜底） |
| `PORT` | 否 | 后端端口，默认 `3012` |

## 架构

```
starter_ai_agents/ai_medical_imaging_agent/
├── frontend/                  # React + Vite + TS
│   └── src/
│       ├── App.tsx            # 主状态机：影像上传 → 临床背景 → 模型选择 → SSE 流式渲染
│       ├── api.ts             # /api/config + /api/analyze（SSE） 封装
│       ├── image.ts           # 浏览器端图片压缩（canvas，EXIF 方向校正）
│       └── components/        # ImageUploader / ModelPicker / ResultPanel / Markdown
└── src/                       # 后端：原生 http + aipack，零运行时框架依赖
    ├── server.ts              # http 服务 + SSE + 静态资源 + SPA fallback
    ├── runtime.ts             # 医学影像 Runtime（固定 5 段报告系统提示 + media → ImageContent + search_web）
    ├── config.ts              # 模型装配（目录过滤 input 含 image + 双通道 Key）
    ├── loadEnv.ts             # .env 加载
    └── tools/search.ts        # search_web 工具（SerpAPI → Bing → DuckDuckGo → 兜底）
```

### 数据流

```
影像文件 ──(浏览器压缩 ≤1568px)──→ data URI base64 ──→ POST /api/analyze
                                                        │  { image, clinicalContext?, model? }
                                                        ▼
                      createRequest(分析指令+临床背景, { media })   ← aipack Request.media
                                                        │
                      runtime.stream() ── ImageContent 内容块 → provider API
                            │                            ↑
                            │                    search_web 工具（四层降级，检索医学文献）
                            ▼
                  SSE: stage / delta(text|thinking) / error
```

### SSE 事件协议（`/api/analyze`）

| 事件 | 数据 | 说明 |
|---|---|---|
| `stage` | `{ stage: 'start'\|'done' }` 或 `{ stage: 'tool_start'\|'tool_end', toolName }` | 分析开始/完成；工具调用开始/结束 |
| `delta` | `{ kind: 'text'\|'thinking', delta }` | 流式增量（正文/思考链） |
| `error` | `{ message }` | 分析出错（明确引导提示） |

请求体上限 25MB；`image` 必须是 `data:image/*;base64,` 格式的 data URI；`clinicalContext` 可选（≤2000 字）。

## 验证

```bash
pnpm --filter ai-medical-imaging-agent typecheck        # 后端类型检查
pnpm --filter ai-medical-imaging-agent typecheck:web    # 前端类型检查
```

> 注：源应用支持 DICOM 直传（Python/PIL 解码）；浏览器端无法原生解码 DICOM，本实现要求先转换为 PNG/JPG——功能上覆盖源应用的图片分析主流程，DICOM 支持待后续按需评估（如引入 cornerstone.js 等 DICOM 解码库）。
