# awesome-llm-apps → llm-awesome-apps 迁移计划（v2 全量版）

> 目标：将 `awesome-llm-apps`（Python/Streamlit 为主，共 **93 个应用级项目**）以**功能等价重写**的方式迁移到本仓库（技术栈：aipack + React + TypeScript）。
> 本文是执行与进度跟踪文档，每完成一个应用勾选对应条目。
>
> v2 修订：补全此前遗漏的分类（advanced_ai_agents 全部 18 个、generative_ui_agents 7 个、chat_with_X 系列、cursor_ai_experiments、always_on/mcp/voice 各漏项、starter 漏项 7 个、rag 漏项 3 个），并给出**每个源应用的去向**（迁移 / 合并 / 跳过 + 理由）。

---

## 一、目标与原则

1. **功能等价重写，非逐行翻译**：保留源应用核心功能与产品价值，用 aipack 的 Runtime / MultiAgent / 工具体系重新实现。
2. **统一架构模板**：所有新 app 对齐 `advanced_ai_agents/multi_agent_apps/ai_teaching_agent_team`（React 前端 + 原生 http/SSE 后端 + aipack runtime）。
3. **零运行时框架依赖**：后端用原生 `node:http` + SSE，不引入 Express 等框架。
4. **中文 UI 与中文 README**，与现有 5 个 app 保持一致。
5. **provider 无关**：默认 DeepSeek，通过 aipack catalog 支持前端切换；API Key 双通道（服务器 `.env` / 前端输入）。
6. **README-only 源应用按规格实现**：源仓库中大量应用只有 README（教程规格：功能、agent 分工、数据流齐全），按 README 规格用 aipack 架构实现。
7. **同类合并**：provider 变体 / 架构重复的应用合并为一个目标 app，用模型下拉与配置覆盖差异，避免仓库膨胀。

## 二、源项目全量盘点与去向总表

> 状态说明：**迁移**=新建独立 app；**合并**=功能并入其他目标 app；**跳过**=不迁移（附理由）；**后置**=依赖预研或重依赖，放最后评估。
> 已迁基线：`ai_travel_agent`、`ai_blog_to_podcast_agent`（starter）、`ai_teaching_agent_team`（advanced）、`ai_rag_database_routing`（rag）、`ai_office_agent`（原创）。

### 2.1 starter_ai_agents（16 个，已迁 2，待处理 14）

| 源应用                             | 去向                               | 说明                                |
| ---------------------------------- | ---------------------------------- | ----------------------------------- |
| ai_travel_agent                    | ✅ 已迁                            | —                                   |
| ai_blog_to_podcast_agent           | ✅ 已迁                            | —                                   |
| ai_reasoning_agent                 | 迁移 → ai_reasoning_agent          | 推理链展示，reasoning 模型          |
| multimodal_ai_agent                | 迁移 → ai_multimodal_agent         | 视频分析 + 搜索                     |
| web_scraping_ai_agent              | 迁移 → ai_web_scraping_agent       | 自然语言 → 结构化抓取               |
| xai_finance_agent                  | 迁移 → ai_finance_agent            | 股票数据 + 搜索分析                 |
| ai_data_analysis_agent             | 迁移 → ai_data_analysis_agent      | CSV/Excel 自然语言问答              |
| ai_data_visualisation_agent        | 合并 → 并入 ai_data_analysis_agent | 分析 + 可视化一体（ECharts）        |
| ai_breakup_recovery_agent          | 迁移 → ai_breakup_recovery_agent   | 多 Agent 情感陪伴团队               |
| ai_life_insurance_advisor_agent    | 迁移 → ai_insurance_advisor_agent  | 保险方案建议                        |
| ai_medical_imaging_agent           | 迁移 → ai_medical_imaging_agent    | X 光/影像多模态诊断辅助             |
| ai_music_generator_agent           | 迁移 → ai_music_generator_agent    | prompt → MP3                        |
| ai_startup_trend_analysis_agent    | 迁移 → ai_startup_trends_agent     | 初创趋势分析                        |
| mixture_of_agents                  | 迁移 → ai_mixture_of_agents        | 多 LLM 作答 + 聚合器                |
| openai_research_agent              | 迁移 → ai_research_agent           | 多 Agent 主题研究                   |
| ai_meme_generator_agent_browseruse | 后置                               | 依赖 browser-use 浏览器驱动，重依赖 |

### 2.2 advanced_ai_agents（18 个，此前整体遗漏）

**single_agent_apps（8 个）**

| 源应用                  | 去向                             | 说明                                     |
| ----------------------- | -------------------------------- | ---------------------------------------- |
| ai_consultant_agent     | 迁移 → ai_consultant_agent       | 有代码；市场分析 + 战略建议              |
| ai_meeting_agent        | 迁移 → ai_meeting_agent          | 有代码；会前情报简报                     |
| ai_deep_research_agent  | 迁移 → ai_deep_research_agent    | README 规格；Firecrawl 深度研究          |
| ai_health_fitness_agent | 迁移 → ai_health_fitness_agent   | README 规格；饮食/训练计划               |
| ai_investment_agent     | 迁移 → ai_investment_agent       | README 规格；股票对比报告                |
| ai_journalist_agent     | 迁移 → ai_journalist_agent       | README 规格；研究-写作-编辑流水线        |
| ai_agent_governance     | 迁移 → ai_agent_governance       | README 规格；agent 治理审计              |
| ai_system_architect_r1  | 迁移 → ai_system_architect_agent | README 规格；双模型（推理+写作）架构评审 |

**multi_agent_apps（10 个）**

| 源应用                    | 去向                             | 说明                                     |
| ------------------------- | -------------------------------- | ---------------------------------------- |
| ai_home_renovation_agent  | 迁移 → ai_home_renovation_agent  | 有代码；照片→装修方案+效果图（图像生成） |
| devpulse_ai               | 迁移 → devpulse_ai               | 有代码；HN/GitHub/arXiv/HF 多源信号聚合  |
| ai_aqi_analysis_agent     | 迁移 → ai_aqi_analysis_agent     | README 规格；AQI 数据 + 健康建议双 agent |
| ai_financial_coach_agent  | 迁移 → ai_financial_coach_agent  | README 规格；预算/债务/储蓄分析          |
| ai_mental_wellbeing_agent | 迁移 → ai_mental_wellbeing_agent | README 规格；心理健康支持团队            |
| ai_speech_trainer_agent   | 后置                             | 语音训练，依赖语音方案预研               |
| ai_self_evolving_agent    | 后置评估                         | 依赖 EvoAgentX 自进化框架                |
| multi_agent_researcher    | 合并 → 并入 ai_research_agent    | 与 openai_research_agent 同类            |
| multi_agent_trust_layer   | 迁移 → ai_trust_layer_agent      | hash 链审计 + 信任门控                   |
| trust_gated_agent_team    | 合并 → 并入 ai_trust_layer_agent | 与 trust_layer 同类（验证+审计）         |

### 2.3 advanced_llm_apps（约 14 个应用级项目）

| 源应用                                                                                             | 去向                          | 说明                                    |
| -------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------- |
| chat-with-tarots                                                                                   | 迁移 → ai_tarot_chat          | 78 张牌数据 + 图片 + 占卜对话           |
| chat_with_X_tutorials/chat_with_pdf                                                                | 迁移 → ai_chat_pdf            | 经典 PDF RAG 问答                       |
| chat_with_X_tutorials/chat_with_github                                                             | 迁移 → ai_chat_github         | 仓库 RAG 问答                           |
| chat_with_X_tutorials/chat_with_substack                                                           | 迁移 → ai_chat_substack       | 公众号/Newsletter 存档问答              |
| chat_with_X_tutorials/chat_with_gmail                                                              | 后置                          | Gmail OAuth 依赖重                      |
| chat_with_X_tutorials/streaming_ai_chatbot                                                         | 合并 → 并入统一模板           | 基础 SSE 聊天即模板能力                 |
| cursor_ai_experiments/llm_router_app                                                               | 迁移 → ai_llm_router          | LLM 路由（按任务选模型）                |
| cursor_ai_experiments/local_chatgpt_clone                                                          | 迁移 → ai_local_chatgpt       | Ollama 本地模型（验证 OpenAI 兼容接入） |
| cursor_ai_experiments/（ai_web_scrapper.py / chatgpt_clone_llama3.py / multi_agent_researcher.py） | 跳过                          | 单文件实验，功能已被上述 app 覆盖       |
| gpt_oss_critique_improvement_loop                                                                  | 迁移 → ai_critique_loop       | 批评-改进自循环（有代码）               |
| multimodal_video_moment_finder                                                                     | 迁移 → ai_video_moment_finder | 视频片段检索（前后端齐全）              |
| resume_job_matcher                                                                                 | 迁移 → ai_resume_matcher      | 简历 × JD 匹配打分                      |
| thinkpath_chatbot_app                                                                              | 迁移 → ai_thinkpath_chat      | 思维链聊天（源为 Node.js，重写 TS）     |
| llm_finetuning_tutorials/gemma3_finetuning                                                         | 跳过                          | GPU 训练教程，与 TS Web 生态无关        |
| llm_optimization_tools                                                                             | 跳过                          | README only，第三方商业工具介绍         |

### 2.4 always_on_agents（2 个）

| 源应用                      | 去向                       | 说明                             |
| --------------------------- | -------------------------- | -------------------------------- |
| always_on_hn_briefing_agent | 迁移 → hn_briefing_agent   | 定时抓取 + 排序 + Slack/邮件投递 |
| release_radar_agent         | 迁移 → release_radar_agent | 依赖发布监控简报                 |

### 2.5 generative_ui_agents（8 个，此前仅见 1 个）

| 源应用                          | 去向                              | 说明                            |
| ------------------------------- | --------------------------------- | ------------------------------- |
| generative-ui-starter-project   | 迁移 → ai_generative_kanban       | chat 驱动看板（agent 与人协作） |
| ai-financial-coach-agent        | 迁移 → ai_financial_coach_ui      | 预算/储蓄/债务交互卡片          |
| ai-dashboard-canvas-agent       | 迁移 → ai_dashboard_canvas        | chat 描述 → 图表面板拼装        |
| ai-deep-research-agent          | 迁移 → ai_deep_research_workspace | 每次工具调用渲染为工作区卡片    |
| ai-shadcn-component-generator   | 迁移 → ai_shadcn_generator        | chat → shadcn 组件代码          |
| ai-knowledge-explorer           | 迁移 → ai_knowledge_explorer      | 上传文档 → 知识探索             |
| ai-mcp-app-builder              | 后置                              | 依赖 E2B 沙箱 + MCP，重依赖     |
| mcp-apps-generative-ui-showcase | 跳过                              | 纯 demo showcase                |

### 2.6 mcp_ai_agents（7 个）

> 前置：批次内先做 aipack `multi-agent` mcp-bridge 扩展的技术验证（spike）。

| 源应用                           | 去向                         | 说明                            |
| -------------------------------- | ---------------------------- | ------------------------------- |
| browser_mcp_agent                | 迁移 → ai_browser_mcp_agent  | 自然语言驱动浏览器              |
| github_mcp_agent                 | 迁移 → ai_github_mcp_agent   | 自然语言探索仓库                |
| notion_mcp_agent                 | 迁移 → ai_notion_mcp_agent   | 读写 Notion                     |
| multi_mcp_agent                  | 迁移 → ai_multi_mcp_agent    | 单 agent 多 MCP server          |
| multi_mcp_agent_router           | 迁移 → ai_mcp_router_agent   | 专家路由到各 MCP server         |
| openai_remote_mcp_bridge         | 迁移 → ai_remote_mcp_bridge  | function calling ↔ 远程 MCP     |
| ai_travel_planner_mcp_agent_team | 迁移 → ai_travel_planner_mcp | Airbnb/Google Maps MCP 数据行程 |

### 2.7 rag_tutorials（24 个，已迁 1，合并为 9 个目标 app）

| 源应用                                                                                                                               | 去向                                 | 说明                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------- |
| rag_database_routing                                                                                                                 | ✅ 已迁                              | —                                                       |
| rag_chain                                                                                                                            | 迁移 → ai_rag_chain                  | 基础检索链（最小 RAG）                                  |
| hybrid_search_rag + local_hybrid_search_rag                                                                                          | 迁移 → ai_hybrid_rag                 | 关键词 + 向量混合（云/本地合并）                        |
| corrective_rag                                                                                                                       | 迁移 → ai_corrective_rag             | CRAG 自评纠错                                           |
| autonomous_rag                                                                                                                       | 迁移 → ai_autonomous_rag             | 自主 RAG + web 兜底                                     |
| agentic_rag_gpt5 + agentic_rag_with_reasoning + agentic_rag_math_agent                                                               | 迁移 → ai_agentic_rag                | Agentic RAG（含 typed 输出校验并入）                    |
| agentic_typed_rag_pydanticai                                                                                                         | 合并 → 并入 ai_agentic_rag           | TS interface + zod 等价实现                             |
| multimodal_agentic_rag + vision_rag                                                                                                  | 迁移 → ai_multimodal_rag             | 多模态检索（文本/图/PDF）                               |
| rag-as-a-service                                                                                                                     | 迁移 → ai_rag_service                | 纯 API RAG 服务                                         |
| knowledge_graph_rag_citations                                                                                                        | 迁移 → ai_knowledge_graph_rag        | 多跳 + 可验证引用                                       |
| rag_failure_diagnostics_clinic                                                                                                       | 迁移 → ai_rag_diagnostics            | RAG 失败系统化诊断                                      |
| ai_blog_search                                                                                                                       | 合并 → 并入 ai_hybrid_rag 示例数据集 | LangGraph 博客检索，模式相同                            |
| contextualai_rag_agent                                                                                                               | 跳过                                 | Contextual AI 托管商业服务                              |
| agentic_rag_embedding_gemma / deepseek_local_rag_agent / gemini_agentic_rag / llama3.1_local_rag / qwen_local_rag / rag_agent_cohere | 合并                                 | provider/本地模型变体，靠模型下拉 + OpenAI 兼容接入覆盖 |

### 2.8 voice_ai_agents（4 个）

> 前置：语音方案选型 spike（edge-tts 复用 vs Web Speech API vs realtime API）。

| 源应用                          | 去向                             | 说明                         |
| ------------------------------- | -------------------------------- | ---------------------------- |
| ai_audio_tour_agent             | 迁移 → ai_audio_tour_agent       | 位置+兴趣 → 语音导览         |
| voice_rag_openaisdk             | 迁移 → ai_voice_rag              | STT + RAG + TTS 全链路       |
| customer_support_voice_agent    | 迁移 → ai_customer_support_voice | 基于自有文档的语音客服       |
| insurance_claim_live_agent_team | 后置                             | Gemini Live 实时语音，依赖重 |

### 2.9 不迁移的目录级分类

| 分类                             | 数量 | 理由                                       |
| -------------------------------- | ---- | ------------------------------------------ |
| agent_skills/                    | 7    | Claude Code SKILL.md 体系，非 Web 应用形态 |
| ai_agent_framework_crash_course/ | 2    | ADK / OpenAI SDK 教程，README only         |

## 三、统一架构模板（以 ai_teaching_agent_team 为基准）

**目录结构对齐 awesome-llm-apps**：每个目标 app 放在与源应用相同的分类目录下（分类目录名与源项目一致），pnpm workspace 按分类目录扫描（见 `pnpm-workspace.yaml`）。

```
<分类>/<app_name>/               # 分类与源项目一致，如 starter_ai_agents/、advanced_ai_agents/multi_agent_apps/、rag_tutorials/…
├── frontend/                  # React + Vite + TS
│   ├── src/
│   │   ├── App.tsx            # 主界面（模型选择、SSE 流式渲染、导出）
│   │   ├── api.ts             # SSE/REST 客户端
│   │   └── main.tsx
│   ├── index.html
│   └── tsconfig.json
├── src/                       # 后端：原生 http，零框架依赖
│   ├── server.ts              # http 服务 + SSE + 静态资源 + SPA fallback
│   ├── runtime.ts             # aipack Runtime / MultiAgent 编排
│   ├── config.ts              # getBuiltinModel → adaptAiModel → createStreamFnFromAi
│   ├── loadEnv.ts             # .env 加载（最先加载的副作用导入）
│   └── tools/                 # 自定义工具（search / scrape / file…）
├── .env.example
├── README.md                  # 中文：功能说明、快速开始、环境变量表
├── package.json               # name: ai-xxx-agent（kebab-case）
└── tsconfig.json              # extends 指向仓库根（相对层级按目录深度）
```

**标准依赖**：`@aipack-ai/agent` ^0.0.2、`@aipack-ai/multi-agent` ^0.0.1（多 Agent 应用）、`react`/`react-dom` ^18.3.1；devDeps：`@types/node`、`@types/react*`、`@vitejs/plugin-react`、`concurrently`、`tsx`、`typescript` ^5.5、`vite` ^6。

**标准脚本**：`dev`（concurrently server+vite）/ `dev:server` / `dev:web` / `build`（vite build && tsc）/ `serve` / `typecheck` / `typecheck:web`。

### 技术映射表

| Python 源                          | TS 目标                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| Streamlit UI                       | React + Vite，SSE 流式渲染                                                         |
| Agno / CrewAI / OpenAI SDK agent   | `createRuntime`（systemPrompt + tools + sessionStorage）                           |
| 多 Agent Team                      | `createAgentGraph` + `SharedContext` blackboard + 分层并行执行                     |
| provider/model 切换                | aipack catalog（`getBuiltinModel` / `BUILTIN_PROVIDERS`），前端模型下拉 + 用户 Key |
| python-dotenv                      | `loadEnv.ts`                                                                       |
| requests / httpx 抓取              | 原生 `fetch` + scrape 工具（复用 blog_to_podcast 模式）                            |
| Firecrawl 网页抓取                 | `fetch` + HTML 解析工具（免费兜底），可选 Firecrawl Key                            |
| FAISS / Qdrant 向量检索            | 内存向量索引（复用 `ai_rag_database_routing/vectordb.ts` 模式）                    |
| PyMuPDF 解析                       | `pdf-parse` 或前端提取纯文本                                                       |
| YFinance 股票数据                  | 免费行情 API（stooq / yahoo chart 接口）+ fetch                                    |
| DuckDuckGo 搜索                    | 复用 search 工具链（SerpAPI + 免费兜底）                                           |
| Edge TTS                           | 复用 `ai_blog_to_podcast_agent` 的 tts.ts                                          |
| Streamlit 图表                     | ECharts（React）                                                                   |
| OpenAI Realtime / Gemini Live 语音 | 预研后定（Web Speech API / edge-tts）                                              |
| Ollama 本地模型                    | aipack OpenAI 兼容接入（baseURL 指向 localhost:11434）                             |

## 四、迁移批次与执行清单

> 推荐顺序：批次 1 → 2 → 3 → 4 → 5 → 6 → 7。总计新增约 **63 个目标 app + 2 个 spike**，覆盖 93 个源应用。

### 批次 0 — 已完成 ✅（5 个）

- [x] ai_travel_agent / ai_teaching_agent_team / ai_rag_database_routing / ai_blog_to_podcast_agent / ai_office_agent

### 批次 1 — Starter 单 Agent（12 个新 app）

- [x] 1.1 ai_reasoning_agent（源 ai_reasoning_agent）
- [x] 1.2 ai_multimodal_agent（源 multimodal_ai_agent）
- [x] 1.3 ai_web_scraping_agent（源 web_scraping_ai_agent）
- [x] 1.4 ai_finance_agent（源 xai_finance_agent）
- [x] 1.5 ai_data_analysis_agent（源 ai_data_analysis_agent + ai_data_visualisation_agent 合并，ECharts）
- [x] 1.6 ai_research_agent（源 openai_research_agent + multi_agent_researcher 合并）
- [ ] 1.7 ai_mixture_of_agents（源 mixture_of_agents）
- [ ] 1.8 ai_breakup_recovery_agent（源同名，多 Agent 团队）
- [x] 1.9 ai_insurance_advisor_agent（源 ai_life_insurance_advisor_agent）
- [ ] 1.10 ai_medical_imaging_agent（源同名）
- [ ] 1.11 ai_music_generator_agent（源同名）
- [ ] 1.12 ai_startup_trends_agent（源 ai_startup_trend_analysis_agent）
- [ ] 后置评估：ai_meme_generator_agent_browseruse（browser-use 重依赖）

### 批次 2 — RAG 精选（9 个新 app，覆盖 23 个源）

- [ ] 2.1 ai_rag_chain（源 rag_chain）
- [ ] 2.2 ai_hybrid_rag（源 hybrid_search_rag + local_hybrid_search_rag + ai_blog_search）
- [ ] 2.3 ai_corrective_rag（源 corrective_rag）
- [ ] 2.4 ai_autonomous_rag（源 autonomous_rag）
- [ ] 2.5 ai_agentic_rag（源 agentic_rag_gpt5 + agentic_rag_with_reasoning + agentic_rag_math_agent + agentic_typed_rag_pydanticai）
- [ ] 2.6 ai_multimodal_rag（源 multimodal_agentic_rag + vision_rag）
- [ ] 2.7 ai_rag_service（源 rag-as-a-service）
- [ ] 2.8 ai_knowledge_graph_rag（源 knowledge_graph_rag_citations）
- [ ] 2.9 ai_rag_diagnostics（源 rag_failure_diagnostics_clinic）

### 批次 3 — 高级单/多 Agent（13 个新 app）

- [ ] 3.1 ai_consultant_agent（源有代码）
- [ ] 3.2 ai_meeting_agent（源有代码）
- [ ] 3.3 ai_deep_research_agent（README 规格）
- [ ] 3.4 ai_health_fitness_agent（README 规格）
- [ ] 3.5 ai_investment_agent（README 规格）
- [ ] 3.6 ai_journalist_agent（README 规格）
- [ ] 3.7 ai_agent_governance（README 规格）
- [ ] 3.8 ai_system_architect_agent（README 规格，双模型推理+写作）
- [ ] 3.9 ai_home_renovation_agent（源有代码，图像生成）
- [ ] 3.10 devpulse_ai（源有代码，多源适配器）
- [ ] 3.11 ai_aqi_analysis_agent（README 规格，AQI 数据工具）
- [ ] 3.12 ai_financial_coach_agent（README 规格）
- [ ] 3.13 ai_mental_wellbeing_agent（README 规格）
- [ ] 3.14 ai_trust_layer_agent（源 multi_agent_trust_layer + trust_gated_agent_team 合并）
- [ ] 后置评估：ai_speech_trainer_agent（语音）、ai_self_evolving_agent（EvoAgentX）

### 批次 4 — Chat with X & 工具型（11 个新 app）

- [ ] 4.1 ai_chat_pdf（源 chat_with_pdf）
- [ ] 4.2 ai_chat_github（源 chat_with_github）
- [ ] 4.3 ai_chat_substack（源 chat_with_substack）
- [ ] 4.4 ai_resume_matcher（源 resume_job_matcher，PDF 上传）
- [ ] 4.5 ai_tarot_chat（源 chat-with-tarots，牌库数据迁移）
- [ ] 4.6 ai_thinkpath_chat（源 thinkpath_chatbot_app）
- [ ] 4.7 ai_llm_router（源 llm_router_app）
- [ ] 4.8 ai_local_chatgpt（源 local_chatgpt_clone，Ollama）
- [ ] 4.9 ai_critique_loop（源 gpt_oss_critique_improvement_loop）
- [ ] 4.10 ai_video_moment_finder（源 multimodal_video_moment_finder）
- [ ] 4.11 流式聊天基础组件并入统一模板（源 streaming_ai_chatbot）
- [ ] 后置：ai_chat_gmail（OAuth 重）

### 批次 5 — Generative UI（6 个新 app）

- [ ] 5.1 ai_generative_kanban（源 generative-ui-starter-project）
- [ ] 5.2 ai_financial_coach_ui（源 ai-financial-coach-agent）
- [ ] 5.3 ai_dashboard_canvas（源 ai-dashboard-canvas-agent）
- [ ] 5.4 ai_deep_research_workspace（源 ai-deep-research-agent）
- [ ] 5.5 ai_shadcn_generator（源 ai-shadcn-component-generator）
- [ ] 5.6 ai_knowledge_explorer（源 ai-knowledge-explorer）
- [ ] 后置：ai_mcp_app_builder（E2B 沙箱）

### 批次 6 — MCP（前置 spike + 7 个新 app）

- [ ] 6.0 spike：验证 aipack `multi-agent` mcp-bridge 连接 MCP server 的可行方案
- [ ] 6.1 ai_browser_mcp_agent
- [ ] 6.2 ai_github_mcp_agent
- [ ] 6.3 ai_notion_mcp_agent
- [ ] 6.4 ai_multi_mcp_agent
- [ ] 6.5 ai_mcp_router_agent
- [ ] 6.6 ai_remote_mcp_bridge
- [ ] 6.7 ai_travel_planner_mcp

### 批次 7 — Voice & Always-on（前置 spike + 5 个新 app）

- [ ] 7.0 spike：语音方案选型（edge-tts / Web Speech API / realtime）
- [ ] 7.1 ai_audio_tour_agent
- [ ] 7.2 ai_voice_rag
- [ ] 7.3 ai_customer_support_voice
- [ ] 7.4 hn_briefing_agent（定时任务 + 投递，CLI 形态架构单独设计）
- [ ] 7.5 release_radar_agent（同上）
- [ ] 后置：insurance_claim_live_agent_team（Gemini Live）

### 明确跳过汇总

agent_skills ×7（SKILL.md 体系）、crash_course ×2（教程）、finetuning/optimization ×2（README-only 教程）、contextualai_rag（商业托管）、mcp-apps-showcase（demo）、cursor 单文件实验 ×3、RAG provider 变体 ×6（靠模型下拉覆盖）。

## 五、单应用迁移 SOP（每 app 一个 commit）

1. **读源**：源码（如有）+ README，提炼功能点、agent 分工、数据流、外部依赖。
2. **脚手架**：以 ai_teaching_agent_team 为底复制模板，放入对应**分类目录**（与源应用分类一致），改 package.json（name/description），并按目录深度修正 tsconfig `extends` 相对路径。
3. **后端四件套**（顺序）：`config.ts` → `src/tools/` → `runtime.ts` → `server.ts`。
4. **前端**：`App.tsx`（SSE 消费 + 模型选择下拉 + 加载/错误态 + 导出/下载如适用）。
5. **验证**：`pnpm --filter <name> typecheck` 零错误；`pnpm --filter <name> dev` 跑通主流程。
6. **文档**：app README（中文，含环境变量表）+ 根 README 应用一览表加一行。
7. **提交**：`feat(apps): add <name>`。

## 六、工程规范

- **命名**：目录 kebab-case；包名 `ai-xxx-agent`（个别如 release_radar 除外）。
- **端口**：3001 已占用，新 app 从 3002 起按迁移顺序递增，写入各自 `.env.example`。
- **API Key 双通道**：服务器 `.env` 优先；前端可输入（localStorage 持久化，sha256 摘要做 runtime 缓存键）。缺 Key 可启动，接口返回明确错误引导。
- **SSE 约定**：`text/event-stream` + `X-Accel-Buffering: no`；事件 `delta` / `stage` / `done` / `error`；客户端断开触发 AbortController。
- **会话**：`createFileSessionStorage`，baseDir `.aipack/<app>-sessions`，sessionKey 编入 topic slug + modelKey。
- **数据资产**：源应用静态数据（如塔罗牌库 CSV/图片）迁移到目标 app 的 `data/` 或 `public/`。
- **批量验证**：每批次完成跑根目录 `pnpm -r --if-present typecheck` 全绿。

## 七、验收标准（每个 app）

- [ ] typecheck 零错误；`dev` 模式前后端可启动
- [ ] 主流程端到端跑通（无 Key 时有明确引导提示，不崩溃）
- [ ] SSE 流式输出正常，客户端断开可中止
- [ ] README 含功能说明、快速开始、环境变量表（中文）
- [ ] 根 README 应用一览表已更新

## 八、进度跟踪

| 批次                 | 覆盖源应用数 | 新增目标 app  | 已完成 | 状态   |
| -------------------- | ------------ | ------------- | ------ | ------ |
| 0 已迁基线           | 4 + 原创 1   | —             | 5      | ✅     |
| 1 Starter            | 14           | 12            | 7      | 进行中 |
| 2 RAG                | 23           | 9             | 0      | 待启动 |
| 3 高级 Agent         | 17           | 14            | 0      | 待启动 |
| 4 Chat with X & 工具 | 13           | 11            | 0      | 待启动 |
| 5 Generative UI      | 6            | 6             | 0      | 待启动 |
| 6 MCP                | 7            | 7 + spike     | 0      | 待预研 |
| 7 Voice & Always-on  | 5            | 5 + spike     | 0      | 待预研 |
| 合计                 | ~89 待处理   | ~64 + 2 spike | 5      | —      |

> 后置评估项（5 个）：meme_generator、speech_trainer、self_evolving、chat_gmail、mcp_app_builder、insurance_claim_live（见各批次）。
