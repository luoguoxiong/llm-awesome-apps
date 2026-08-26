# AI 保险保障顾问（ai_insurance_advisor_agent）

基于 [aipack](https://github.com/luoguoxiong/aipack) 的人寿保险保障顾问：填写客户资料，**本地即刻算出推荐保额**（收入替代折现模型，确定性公式、无需 API Key），Agent 再调用同一公式的计算工具与 web 搜索，流式生成包含计算明细与当地定期寿险产品参考的结构化报告。

迁移自 [awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps) 的 `starter_ai_agents/ai_life_insurance_advisor_agent`（Python/Streamlit + Agno + OpenAI GPT-5-mini + E2B 沙箱 + Firecrawl）。

## 功能特性

- **客户资料表单**：年龄、年收入、受抚养人、国家/地区、总债务（含房贷）、可用储蓄、已有人寿保险、货币（CNY/USD/EUR/GBP/CAD/AUD/INR）、收入替代年限（5/10/15 年），字段与源应用一致，默认值本地化（中国 / CNY）。
- **本地确定性保额计算**：提交即得结果，不依赖 LLM——
  - 年金系数 `annuity_factor = (1 − (1+r)^(−n)) / r`（默认实际折现率 r = 2%）
  - 推荐保额 `max(0, 年收入 × 年金系数 + 总债务 − 储蓄 − 已有保额)`
  - 逐步展示：年金系数 → 折现收入替代 → +债务 → −资产抵扣 → 推荐保额
- **Agent 流式报告**（SSE）：
  1. `compute_coverage` 工具——服务端同一公式的确定性计算（替代源应用的 E2B 沙箱 `run_python_code`），杜绝 LLM 心算/编造数字
  2. `search_web` 工具——检索客户所在地区的定期寿险产品（SerpAPI → Bing → DuckDuckGo → 兜底，四层降级，替代源应用的 Firecrawl）
  3. 输出 Markdown 报告：保障建议结论 / 计算明细表 / 产品参考（≤3 个，附链接来源）/ 假设与说明，支持一键下载 `.md`
- **provider 无关**：默认 `deepseek/deepseek-chat`，前端可切换全部内置模型（27 个目录条目），API Key 双通道（服务器 `.env` / 页面输入 + localStorage 持久化）。

## 快速开始

```bash
# 仓库根目录安装依赖
pnpm install

# 配置 API Key（可选，无 Key 时本地保额计算照常可用）
cd starter_ai_agents/ai_insurance_advisor_agent
cp .env.example .env   # 编辑 .env，配置 DEEPSEEK_API_KEY 等

# 开发模式（后端 3009 + Vite 5173）
pnpm --filter ai-insurance-advisor-agent dev

# 生产模式（单端口 3009）
pnpm --filter ai-insurance-advisor-agent build
pnpm --filter ai-insurance-advisor-agent serve
```

打开 http://localhost:5173 （开发）或 http://localhost:3009 （生产）。

## 使用流程

1. 在「模型与 Key」卡片选择顾问模型（缺 Key 时输入，按 provider 持久化）。
2. 填写客户资料表单（默认值为中国典型场景：35 岁 / 年收入 30 万 / 房贷 50 万 / 2 名受抚养人）。
3. 点击「生成保障建议与产品参考」：
   - **推荐保额卡片**立即出现（本地公式，即使无 Key）；
   - **Agent 报告**流式生成，工具徽标实时显示 `compute_coverage` / `search_web` 的执行状态。
4. 报告完成后可下载 Markdown 存档。

## 环境变量

| 变量 | 必填 | 说明 |
| ---- | ---- | ---- |
| `DEEPSEEK_API_KEY` | 推荐 | 默认 provider 的 API Key（也可换用其他 provider 的 Key） |
| `LLM_PROVIDER` | 否 | 顾问模型 provider，默认 `deepseek` |
| `LLM_MODEL` | 否 | 模型 id，默认 `deepseek-chat` |
| `SERPAPI_KEY` | 否 | 配置后搜索走 SerpAPI；缺省用免费降级链 Bing → DuckDuckGo → 兜底 |
| `PORT` | 否 | 后端端口，默认 `3009` |

其余 provider Key（`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` / `GROQ_API_KEY` / `XAI_API_KEY`）按所选模型配置。

## 架构

```
starter_ai_agents/ai_insurance_advisor_agent/
├── frontend/                  # React + Vite + TS
│   └── src/
│       ├── App.tsx            # 主状态机:表单 → 本地计算 + SSE 报告
│       ├── coverage.ts        # 本地保额计算(与后端工具同公式,即时展示)
│       ├── api.ts             # /api/config + /api/advise SSE 客户端
│       └── components/        # ModelPicker / ProfileForm / CoverageCard / ReportPanel / Markdown
└── src/                       # 后端:原生 node:http,零框架依赖
    ├── server.ts              # /api/config + /api/advise(SSE) + 静态托管
    ├── runtime.ts             # aipack Runtime:ephemeral 单轮 + 系统提示词
    ├── config.ts              # getBuiltinModel → adaptAiModel → createStreamFnFromAi
    ├── loadEnv.ts             # 零依赖 .env 加载
    └── tools/
        ├── coverage.ts        # compute_coverage:确定性保额计算(替代 E2B 沙箱)
        └── search.ts          # search_web:四层降级搜索(替代 Firecrawl)
```

**与源应用的技术映射**：

| 源应用（Python/Streamlit） | 本实现（TS/aipack） |
| ---- | ---- |
| Streamlit 表单 | React 表单（ProfileForm，同字段） |
| E2B 沙箱 `run_python_code` | `compute_coverage` 本地确定性工具（同一公式，免沙箱免 Key） |
| Firecrawl search/crawl | `search_web` 四层降级搜索链 |
| Agno Agent（GPT-5-mini） | aipack `createRuntime`（默认 DeepSeek，全目录可切换） |
| 前端本地 breakdown 复算 | `frontend/src/coverage.ts`（同公式浏览器副本） |
| 单次 JSON 结果渲染 | SSE 流式 Markdown 报告 + 下载 |

## 免责声明

本应用仅供教育与原型参考，不构成持牌保险或财务建议。保额模型为简化的收入替代折现法，未覆盖教育专项、通胀调整等复杂因素；产品信息来自实时 web 搜索，请与保险公司核实。请务必咨询合格的专业人士。

## License

MIT
