# AI 外贸获客 Agent · ImportYeti → 客户分析 → 个性化开发信

基于 [aipack](https://github.com/luoguoxiong/aipack) 的**外贸获客** Web 应用(本仓库原创应用,非 awesome-llm-apps 迁移项)。
输入一个**产品关键词**,Agent 自动跑完整条获客链路,产出可直接发信的客户清单:

```
产品关键词
   ↓  ① search_importyeti(美国海关提单数据)
找到美国进口商
   ↓  ② lookup_importer_suppliers
查看进口商的供应商
   ↓  ③ save_verdict(证据化判定)
判断它是否真的在采购这个产品
   ↓  ④ search_web + fetch_url
Google / LinkedIn 找公司官网和联系人
   ↓  ⑤ 单模型流式生成
AI 分析客户
   ↓  ⑥ 单模型流式生成
AI 生成个性化开发信
```

## 功能

- **五阶段流水线**(每阶段独立 Runtime + 专属工具集):
  1. **找进口商**——`search_importyeti` 检索美国进口商 + `search_web` 交叉扩展,每家调用 `save_importer` 入库
  2. **核验采购真实性**——`lookup_importer_suppliers` 查供应商/产地 → `save_verdict` 给出 `yes / likely / unknown / no` 与依据
  3. **找官网与联系人**——Google/LinkedIn 检索 + 官网抓取,提取邮箱、关键人(采购/供应链)、地址 → `save_contact`
  4. **AI 客户分析**——客户画像 / 采购匹配度 / 切入策略 / 风险与注意事项(流式 Markdown)
  5. **AI 开发信**——邮件主题(多选)+ 英文正文 + 中文要点 + 跟进节奏(流式 Markdown)
- **结构化线索库**:`save_importer` / `save_verdict` / `save_contact` 三个写入工具,写入即推送前端卡片(按 id 增量更新)
- **三层降级检索**:ImportYeti 直连解析 → `site:importyeti.com` 搜索引擎兜底 → 通用进口商检索(SerpAPI → Bing → DuckDuckGo → 明确提示)
- **不编造**:拿不到证据时工具明确返回"未命中",提示词强制 Agent 判定 `unknown` 并说明缺口
- **双栏视图**:左栏流水线(五阶段步骤条 + 工具徽标 + 候选清单 + 过程日志),右栏客户卡片(核验/供应商/联系人/分析/开发信)
- **一键流转**:单封开发信复制、全部客户报告导出 `.md`
- **模型无关**:全内置模型可选(默认 DeepSeek Chat);**API Key 双通道**(服务器 `.env` 或前端输入,localStorage 持久化)
- **可中止**:随时停止(AbortController 贯穿前后端);单家客户失败不影响整条流水线

## 快速开始

```bash
# 1. 配置环境变量(或启动后在页面输入 API Key)
cp .env.example .env
# 编辑 .env,填入 DEEPSEEK_API_KEY=xxx(推荐同时配置 SERPAPI_KEY,搜索质量更好)

# 2. 安装依赖(仓库根目录)
pnpm install

# 3. 启动开发模式(后端 3013 + Vite 5173)
pnpm --filter ai-trade-lead-agent dev

# 4. 打开 http://localhost:5173,输入产品关键词(英文效果更佳)开始
```

生产模式(单端口):

```bash
pnpm --filter ai-trade-lead-agent build
pnpm --filter ai-trade-lead-agent serve   # http://localhost:3013
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `LLM_PROVIDER` | 否 | 分析/写作模型 provider,默认 `deepseek` |
| `LLM_MODEL` | 否 | 模型 id,默认 `deepseek-chat` |
| `DEEPSEEK_API_KEY` | 视情况 | DeepSeek API Key(默认 provider;也可在页面输入) |
| `OPENAI_API_KEY` 等 | 视情况 | 切换 provider 时提供对应的 `*_API_KEY` |
| `SERPAPI_KEY` | 否 | 配置后搜索走 SerpAPI(质量最好);否则免费降级链 Bing → DuckDuckGo → 兜底 |
| `DEFAULT_LEADS` | 否 | 默认候选进口商数量,默认 `5`(页面可改 3/5/8/10) |
| `PORT` | 否 | 后端端口,默认 `3013` |

## 架构

```
foreign_trade_apps/ai_trade_lead_agent/
├── frontend/                  # React + Vite + TS
│   └── src/
│       ├── App.tsx            # 主状态机:关键词 → SSE 流式流水线 → 双栏展示
│       ├── api.ts             # /api/config + /api/leads(SSE 消费)
│       └── components/        # ModelPicker / PipelinePanel / LeadCards / Markdown
└── src/                       # 后端:原生 http + aipack,零运行时框架依赖
    ├── server.ts              # http 服务 + SSE 流水线 + 静态资源 + SPA fallback
    ├── runtime.ts             # 五阶段编排(各阶段系统提示词 + 工具集 + maxTurns)
    ├── config.ts              # 模型装配(全内置目录 + 双通道 Key)
    ├── loadEnv.ts             # .env 加载
    └── tools/
        ├── importyeti.ts      # search_importyeti / lookup_importer_suppliers(三层降级)
        ├── search.ts          # search_web(SerpAPI → Bing → DDG → 兜底)
        ├── fetchUrl.ts        # fetch_url(网页正文抽取)
        └── leads.ts           # LeadStore:save_importer / save_verdict / save_contact
```

### 数据流

```
产品关键词 ──POST /api/leads──→ 解析模型 → 建 LeadStore(写入即 SSE 推送)
                                        │
        ① 找进口商    search_importyeti / search_web / fetch_url → save_importer
        ② 核验采购    lookup_importer_suppliers / search_web → save_verdict(yes/likely/unknown/no)
        ③ 找联系人    search_web / fetch_url → save_contact(官网/LinkedIn/邮箱/关键人)
        ④ AI 分析     无工具,流式 Markdown → delta(target=analysis)
        ⑤ AI 开发信   无工具,流式 Markdown → delta(target=email)
                                        │
        SSE: stage / log / delta / lead / tool / error
                                        │
        前端:左栏流水线(步骤条+工具徽标+候选+日志) | 右栏客户卡片(分析+开发信+复制/导出)
```

### SSE 事件协议(`/api/leads`)

| 事件 | 数据 | 说明 |
|---|---|---|
| `stage` | `{ stage: 'start'\|'importers'\|'verify'\|'contacts'\|'analysis'\|'email'\|'done', label, leadId? }` | 阶段开始/切换/结束 |
| `lead` | `Lead` 完整快照 | 线索新增或更新(按 `id` 增量覆盖) |
| `log` | `{ delta }` | 阶段过程说明(流式) |
| `delta` | `{ target: 'analysis'\|'email', leadId, delta }` | 客户分析 / 开发信流式增量 |
| `tool` | `{ phase: 'start'\|'end', toolName }` | 工具调用开始/结束 |
| `error` | `{ message }` | 单客户步骤失败或整体出错 |

## 已知限制

- **ImportYeti 可达性**:站点对未登录/自动化请求常返回登录墙或拦截页。工具会依次降级为
  `site:importyeti.com` 检索与通用进口商检索,并在返回文本中标注"非海关数据,可信度较低",
  Agent 会在结论中如实说明证据强度;配置 `SERPAPI_KEY` 可显著改善。
- **免费搜索质量**:国内网络下 DuckDuckGo/Brave 等常不可达,实际多走 Bing(可能忽略 `site:` 等高级语法)。
  建议配置 `SERPAPI_KEY`,或在关键词里把公司名/品牌名放在最前。
- **联系人合规**:仅使用公开渠道信息(官网、LinkedIn 公开页),请勿用于骚扰式群发。

## 验证

```bash
pnpm --filter ai-trade-lead-agent typecheck        # 后端类型检查
pnpm --filter ai-trade-lead-agent typecheck:web    # 前端类型检查
pnpm --filter ai-trade-lead-agent build            # 生产构建(vite build + tsc)
```

> 已验证:`search_importyeti` 与 `lookup_importer_suppliers` 在当前网络下走降级链正常返回(直连被拦 → Bing 检索),
> 无 API Key 时 `/api/leads` 返回明确引导错误而非崩溃。
