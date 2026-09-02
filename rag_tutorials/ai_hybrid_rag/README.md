# 🔀 Hybrid Search RAG

基于 [aipack](https://github.com/luoguoxiong/aipack) 移植的 **混合检索 RAG** Web 应用，原版来自 [awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps) 的 [hybrid_search_rag](https://github.com/Shubhamsaboo/awesome-llm-apps/tree/main/rag_tutorials/hybrid_search_rag) + [local_hybrid_search_rag](https://github.com/Shubhamsaboo/awesome-llm-apps/tree/main/rag_tutorials/local_hybrid_search_rag)（云/本地两版合并），并并入 [ai_blog_search](https://github.com/Shubhamsaboo/awesome-llm-apps/tree/main/rag_tutorials/ai_blog_search) 的 LangGraph 博客检索作为示例数据集。TypeScript + React + 原生 http 重写，零运行时框架依赖。

## 特性

- **双通道混合检索**：
  - **BM25 关键词通道**（k1=1.5, b=0.75）—— 捕捉精确词面命中
  - **TF-IDF 向量通道** —— 稀疏向量余弦相似度，捕捉语义泛化
- **RRF 融合**：Reciprocal Rank Fusion，按两通道名次倒数之和重排，无需调分数权重
- **LLM 相关性重排**：Grader 逐片段评估 yes/no 过滤噪声（等价 Cohere Reranker），评估失败自动降级用融合名次
- **通用知识兜底**：无相关片段时不硬凑上下文，直接让模型用自身知识回答并明确提示
- **多来源摄取**：粘贴文本 / 上传 `.txt` / `.md` / URL 抓取（Firecrawl → 原生 fetch + HTML 正文提取两层降级）/ 一键加载示例文档（LangGraph 博客系列）
- **检索细节可视化**：每个候选片段展示 RRF 融合分、BM25/TF-IDF 双通道得分、LLM 评估结论
- **多轮对话**：服务端内存维护会话历史，每轮携带最近 3 轮
- **多 LLM 提供商**：默认 DeepSeek，可切换 OpenAI / Anthropic / Google / Groq 等；API Key 可在页面输入（localStorage 记忆），缺省回退服务器 `.env` 配置
- **极简依赖**：仅 `@aipack-ai/agent` + `react` / `react-dom`

## 架构

```
用户提问
    │
    ▼
┌──────────────────────────────┐
│ ① 混合检索                    │  BM25 关键词 top-K ─┐
│    （双通道各取 candidateK）   │  TF-IDF 向量 top-K ─┤→ RRF 融合
└──────────────────────────────┘                     │
    │                                                ▼
    │                                        候选片段（融合名次）
    ▼                                                │
┌──────────────────────────────┐                     │
│ ② LLM 相关性重排（Grader）    │ ◀───────────────────┘
│    逐片段 yes/no，过滤噪声     │   失败 → 降级用融合名次 top-k
└──────────────────────────────┘
    │
    ├─ 有相关片段 → RAG 上下文流式作答（SSE）
    └─ 无相关片段 → 通用知识兜底（明确提示无文档依据）
```

## 快速开始

### 1. 安装依赖

在仓库根目录（`llm-awesome-apps/`）执行：

```bash
pnpm install
```

### 2. 配置环境变量

```bash
cd rag_tutorials/ai_hybrid_rag
cp .env.example .env
# 编辑 .env，至少配置一个 LLM API Key
```

| 变量                | 说明                                             | 默认                          |
| ------------------- | ------------------------------------------------ | ----------------------------- |
| `LLM_PROVIDER`      | LLM 提供商                                       | `deepseek`                    |
| `LLM_MODEL`         | 模型 id（留空按 provider 取默认）                 | `deepseek-chat`               |
| `DEEPSEEK_API_KEY`  | DeepSeek Key                                     | —                             |
| `OPENAI_API_KEY`    | OpenAI Key                                       | —                             |
| `FIRECRAWL_API_KEY` | Firecrawl Key（可选，URL 摄取优先走它）            | —                             |
| `CANDIDATE_K`       | 混合检索候选数（融合后送入 LLM 重排）              | `10`                          |
| `CONTEXT_K`         | 最终注入上下文的片段数                            | `5`                           |
| `RRF_K`             | RRF 融合常数（越大名次差异影响越小）               | `60`                          |
| `GRADE_ENABLED`     | 是否启用 LLM 相关性重排                           | `true`                        |
| `VECTOR_DB_DIR`     | 索引持久化目录                                    | `.aipack/hybrid-rag-store`    |
| `PORT`              | Web 服务端口                                     | `3014`                        |

> 完整 provider 与 envVar 对照见 aipack 仓库 [`packages/agent/ai/catalog.ts`](https://github.com/luoguoxiong/aipack/blob/master/packages/agent/ai/catalog.ts) 的 `BUILTIN_PROVIDERS`。

### 3. 启动

```bash
# 开发（热重载；后端 3014 + Vite 5173）
pnpm --filter ai-hybrid-rag dev

# 生产构建（前端产物打进 dist/，单端口服务）
pnpm --filter ai-hybrid-rag build
pnpm --filter ai-hybrid-rag serve
```

开发态访问 Vite 地址（`http://localhost:5173`，代理到后端 3014）；生产态访问 `http://localhost:3014`。

### 4. 使用

1. **摄取文档**：点击「加载示例文档」一键导入 LangGraph 博客知识库，或粘贴文本 / 上传文件 / 输入 URL 抓取
2. **提问**：如「What is LangGraph?」「How does corrective RAG work?」——回答气泡下方可展开查看检索细节（双通道得分 + LLM 评估）
3. **测试兜底**：问一个知识库外的通用问题（如「什么是量子计算？」），观察系统明确提示无文档依据后用通用知识回答

## 与原版的差异

| 原版（Streamlit/Python）           | 本实现（aipack/TS）                              |
| ---------------------------------- | ------------------------------------------------ |
| RAGLite + PostgreSQL 全文/向量检索  | 零依赖 BM25 + TF-IDF 双通道（JSON 持久化）       |
| Cohere Reranker 重排                | aipack Grader Runtime 逐片段评估（失败降级）     |
| Claude 3 Opus 回答                  | aipack Answer Runtime（默认 DeepSeek，可切换）   |
| LangChain + Streamlit               | React + 原生 http + SSE                          |
| ai_blog_search 单独应用             | 并入为示例数据集（sample-docs.md 一键加载）      |
| local_hybrid_search_rag 本地模型    | 靠模型下拉 + OpenAI 兼容 provider 覆盖           |

## 工作原理

### 混合检索（[src/hybrid.ts](src/hybrid.ts)）

- **分块**：目标块 ≈1000 字符、重叠 200，优先在段落边界切断
- **分词**：英文小写词 + 数字（过滤停用词）、中文双字滑窗 + 独立单字
- **BM25**：标准 Okapi 公式（k1=1.5, b=0.75），语料级 IDF 与文档长度归一
- **TF-IDF**：每块构建稀疏向量并预计算 L2 范数，查询向量与各块算余弦相似度
- **RRF 融合**：`score = Σ 1/(rrfK + rank)`，两通道名次倒数求和，天然免疫不同打分体系
- 变更后持久化到 `VECTOR_DB_DIR/store.json`，启动时自动加载

### 问答编排（[src/pipeline.ts](src/pipeline.ts)）

1. **混合检索**：双通道各取 `candidateK`，RRF 融合得候选
2. **相关性重排**：Grader Runtime 单轮评估全部候选（每片段截断 400 字符），解析出相关片段编号；失败降级直接取融合名次 `contextK`
3. **回答**：有相关片段 → top 片段（每片段截断 1600 字符）+ 最近 3 轮历史编排为上下文，流式作答；无相关片段 → 通用知识兜底

### URL 抓取（[src/fetchUrl.ts](src/fetchUrl.ts)）

Firecrawl v2 `/scrape`（配置 Key 时优先，返回 markdown 正文）→ 原生 fetch + HTML 正文提取（去 script/style/nav，取 main/article）两层降级，均带超时与重试。

## API

| 方法     | 路径              | 说明                                                        |
| -------- | ----------------- | ----------------------------------------------------------- |
| `GET`    | `/api/config`     | 默认模型 + 模型目录 + 检索参数 + 索引统计                    |
| `POST`   | `/api/ingest`     | 摄取文档；body `{ name, content }` 或 `{ url }`             |
| `GET`    | `/api/documents`  | 索引统计（来源列表 + 块数）                                  |
| `DELETE` | `/api/documents`  | 删除来源（`?name=xxx`）或清空全部索引                        |
| `POST`   | `/api/chat`       | SSE 流式问答；body `{ question, sessionId, model?, apiKey? }`|

`/api/chat` 的 SSE 事件流：`search`（start/done，含双通道候选明细）→ `grade`（start/done）→ `answer_start`（rag/fallback）→ `delta`* → `done`。

## 开发

```bash
# 类型检查（后端 + 前端）
pnpm --filter ai-hybrid-rag typecheck
pnpm --filter ai-hybrid-rag typecheck:web

# 目录结构
# src/
#   config.ts      环境变量与模型装配
#   hybrid.ts      混合检索存储（分块/分词/BM25/TF-IDF/RRF/持久化）
#   pipeline.ts    问答编排（检索 → 重排 → 流式回答/兜底）
#   runtime.ts     Grader / Answer Runtime 构建与注册表
#   fetchUrl.ts    URL 抓取（Firecrawl → 原生 fetch 两层降级）
#   server.ts      原生 http + SSE + 静态资源
# frontend/        React + Vite 前端（模型选择/文档摄取/聊天/检索细节）
```

## License

MIT
