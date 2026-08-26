# AI Mixture-of-Agents · 混合专家（多模型并行 + 聚合综合）

基于 [aipack](https://github.com/luoguoxiong/aipack) 的混合专家（Mixture-of-Agents）Web 应用：同一个问题同时发给 **N 个参考模型并行回答**（各路流式输出），再由**聚合模型批判性综合**所有回答，产出单一高质量回答——集众家之长，减少单模型偏差与幻觉。

迁移自 [awesome-llm-apps/starter_ai_agents/mixture_of_agents](https://github.com/Shubhamsaboo/awesome-llm-apps/tree/main/starter_ai_agents/mixture_of_agents)（源应用：Together AI 单 Key + 4 个固定开源模型 `asyncio.gather` 并行 + Mixtral-8x22B 聚合流式）。本实现以 aipack 全内置模型目录等价替代：**27 个模型跨 provider 自由组合**（默认勾选 DeepSeek / GPT-4o mini / Gemini Flash / Llama-3.3-70B 四路，对齐源应用"4 模型组合"思路），API Key 双通道（服务器 `.env` 或前端按 provider 输入）。

## 功能

- **两阶段 MoA 流水线**：
  1. **并行参考**——N 个模型（1-6 个）各自独立回答，`Promise.allSettled` 并行执行，每路流式输出到独立结果面板
  2. **聚合综合**——聚合模型收到原始问题 + 各模型回答，按"批判性评估（可能存在偏见/错误/矛盾）→ 提炼更准确全面的回复"的指令产出最终回答（流式）
- **容错设计**：单个参考模型失败不中断整体（该路面板显示错误，聚合成功的回答并在提示中注明缺失）；全部失败才报错
- **参考模型多选**：按 provider 分组的复选框网格，推理模型带 ✨，服务器已配 Key 的 provider 标 ✅，超过上限自动锁定未选项
- **聚合模型单选**：任意内置模型（默认 `LLM_PROVIDER`/`LLM_MODEL`，默认 deepseek-chat）
- **API Keys 按_provider 管理**：只显示当前选中模型涉及的 provider，localStorage 持久化，服务器已配置的显示"✅ 已用服务器配置"
- **双栏结果视图**：参考模型回答网格（状态徽标 + 流式 + Markdown 渲染）+ 聚合回答高亮大卡（流式）
- **可中止**：执行中随时停止（AbortController 贯穿前后端）
- **改进**：聚合提示词附原始问题（源应用的聚合请求会丢失问题上下文）

## 快速开始

```bash
# 1. 配置环境变量（或启动后在页面按 provider 输入 API Key）
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY=xxx（及其他参考模型的 Key）

# 2. 安装依赖（仓库根目录）
pnpm install

# 3. 启动开发模式（后端 3008 + Vite 5173）
pnpm --filter ai-mixture-of-agents dev

# 4. 打开 http://localhost:5173，选好参考模型提问
```

生产模式（单端口）：

```bash
pnpm --filter ai-mixture-of-agents build
pnpm --filter ai-mixture-of-agents serve   # http://localhost:3008
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `LLM_PROVIDER` | 否 | 聚合模型 provider，默认 `deepseek` |
| `LLM_MODEL` | 否 | 聚合模型 id，默认 `deepseek-chat` |
| `DEEPSEEK_API_KEY` 等 | 视情况 | 各 provider 的 Key（参考模型 + 聚合模型；也可在页面输入） |
| `PORT` | 否 | 后端端口，默认 `3008` |

> 参考模型的默认勾选（DeepSeek / GPT-4o mini / Gemini Flash / Llama-3.3-70B）需要各自 provider 的 Key，可自由增删换。

## 架构

```
starter_ai_agents/ai_mixture_of_agents/
├── frontend/                  # React + Vite + TS
│   └── src/
│       ├── App.tsx            # 主状态机:问题 + 参考多选 + 聚合单选 + Keys → SSE 流式结果
│       ├── api.ts             # /api/config + /api/mixture(SSE 消费)
│       └── components/        # ModelMultiSelect / Markdown(零依赖渲染器)
└── src/                       # 后端:原生 http + aipack,零运行时框架依赖
    ├── server.ts              # http 服务 + SSE MoA 流(逐路校验:prompt/数量/重复/Key)
    ├── mixture.ts             # MoA 编排:allSettled 并行参考 + 聚合综合(容错)
    ├── config.ts              # 模型目录 + 单模型校验(resolveModelSpec)
    └── loadEnv.ts             # .env 加载
```

### 数据流

```
问题 + N 个参考模型 + 聚合模型 ──POST /api/mixture──→ 逐项校验(存在性/Key/重复/上限)
                                                              │
              ┌─────────────── 阶段 1:并行(每路独立 ephemeral Runtime)───────────────┐
              │  ref A(deepseek)   ref B(gpt-4o-mini)   ref C(gemini)   …  ref F     │
              │      └── ref_delta 流式 ──┘    (失败路记录错误,不中断其他)            │
              └──────────────────────────────────────────────────────────────────────┘
                                                              │
              阶段 2:聚合(原始问题 + 各回答 + 失败说明 → 聚合模型)
                                                              │
        SSE: stage(start/ref_start/ref_end/aggregate_start/done) / ref_delta{modelKey} / delta / error
                                                              │
        前端:参考结果网格(并行流式) → 聚合回答卡(流式 Markdown 渲染)
```

### SSE 事件协议（`/api/mixture`）

| 事件 | 数据 | 说明 |
|---|---|---|
| `stage` | `{ stage: 'start', references, aggregator }` | 首个事件，本次 MoA 的模型组合 |
| `stage` | `{ stage: 'ref_start', modelKey }` | 某参考模型开始 |
| `ref_delta` | `{ modelKey, delta }` | 某参考模型流式增量（多路交错） |
| `stage` | `{ stage: 'ref_end', modelKey, error? }` | 某参考模型结束（error 非空即失败） |
| `stage` | `{ stage: 'aggregate_start', failed }` | 聚合开始（failed 为失败的模型列表） |
| `delta` | `{ kind: 'text', delta }` | 聚合回答流式增量 |
| `stage` | `{ stage: 'done' }` | 完成 |
| `error` | `{ message }` | 整体失败（如所有参考模型均失败） |

## 验证

```bash
pnpm --filter ai-mixture-of-agents typecheck        # 后端类型检查
pnpm --filter ai-mixture-of-agents typecheck:web    # 前端类型检查
pnpm --filter ai-mixture-of-agents build            # 生产构建（vite build + tsc）
```

> 已验证：7 条参数校验路径（缺 prompt / 缺参考 / 无效模型 / 缺 Key / 超上限 / 重复模型 / 聚合缺 Key）均返回明确 400；SSE 全链路（并行 ref_start → 各路失败上报 → 汇总 error）用无效 Key 实测走通。
