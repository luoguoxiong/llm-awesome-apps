# AI Music Generator Agent（ModelsLab 音乐生成助手）

对话式 AI 音乐创作应用：LLM 把你的一句想法扩写成详尽的音乐提示词（流派 / 乐器 / 节奏 / 情绪 / 曲式结构），调用 ModelsLab 生成 MP3，页面内嵌播放器即时试听、一键下载，并支持多轮迭代（换风格、换乐器、调情绪再生成）。

迁移自 [awesome-llm-apps/starter_ai_agents/ai_music_generator_agent](https://github.com/Shubhamsaboo/awesome-llm-apps/tree/main/starter_ai_agents/ai_music_generator_agent)（Python/Streamlit + agno ModelsLabTools + OpenAI gpt-4o），本实现以 aipack Runtime 工具调用循环 + ModelsLab v6 官方端点等价替代，并升级为多轮对话体验。

## 功能

- **对话式生成**：自然语言描述需求（如"深夜编程的 lo-fi 电子乐"）→ Agent 润色为详细英文提示词 → 调用 `generate_music` 工具生成 MP3
- **内嵌播放器**：音乐生成完成经 SSE `music` 事件实时推送，前端渲染播放器卡片（时长 / 提示词 / 下载按钮）
- **音频代理**：`/api/audio` 仅代理本服务生成的 URL（白名单校验，防 SSRF），支持 Range 拖动进度与 `?download=1` 下载
- **多轮迭代**：sessionKey 维持会话上下文，"换一种更慵懒的风格"即可基于反馈再生成
- **双 Key 双通道**：编排 LLM Key（27 个内置模型可切换）与 ModelsLab Key 均支持服务器 .env 或前端输入
- **提示词工程**：系统提示词沿用源应用约定——提示词必须涵盖流派、乐器音色、速度 BPM、情绪氛围、曲式结构（intro/verse/chorus/bridge/outro）

## 架构

```
frontend/                    React + Vite(SSE 流式渲染)
  src/App.tsx                聊天状态机(多轮 + 播放器列表)
  src/components/
    ModelPicker.tsx          编排模型 + LLM Key + ModelsLab Key
    ChatMessage.tsx          气泡 + 工具徽标 + 思考链 + 音频卡片
src/                         后端:原生 http,零框架依赖
  server.ts                  http 服务 + SSE + 音频代理 + 静态资源 + SPA fallback
  runtime.ts                 aipack Runtime(音乐系统提示词 + 工具;toolCallId 关联生成结果)
  config.ts                  getBuiltinModel → adaptAiModel → createStreamFnFromAi
  loadEnv.ts                 .env 加载(最先加载的副作用导入)
  tools/modelslab.ts         generate_music 工具(v6/voice/music_gen + 排队轮询 + 白名单登记)
```

**生成结果回传链路**：工具按 `toolCallId` 登记生成结果 → Runtime 在 `tool_end` 事件中取出 → server 经 SSE `music` 事件下发 → 前端渲染 `<audio>` 播放器（经 `/api/audio` 白名单代理）。

**ModelsLab 端点说明**：源 agno 工具使用的 `v6/audio/music_generate` 已被官方下线（实测返回 method not supported），本实现使用官方现行端点 `v6/voice/music_gen`，排队任务自动按 `fetch_id` 轮询直到完成（对齐源应用 `wait_for_completion=True`）。

## 快速开始

```bash
# 1. 配置环境变量
cp .env.example .env
# 编辑 .env:
#   LLM_PROVIDER/LLM_MODEL   编排模型(默认 deepseek/deepseek-chat;源应用为 openai/gpt-4o)
#   DEEPSEEK_API_KEY 等      LLM Key(或启动后在页面输入)
#   MODELSLAB_API_KEY        ModelsLab Key(必填;获取: https://modelslab.com/dashboard/api-keys)

# 2. 安装依赖(仓库根目录)
pnpm install

# 3. 开发模式(后端 3011 + Vite 5173)
pnpm --filter ai-music-generator-agent dev

# 4. 生产模式(单端口 3011)
pnpm --filter ai-music-generator-agent build
pnpm --filter ai-music-generator-agent serve
```

打开 http://localhost:5173（开发）或 http://localhost:3011（生产）。

## API

| 接口 | 方法 | 说明 |
| ---- | ---- | ---- |
| `/api/config` | GET | 默认模型 / 模型目录（27 个）/ LLM 与 ModelsLab 就绪状态 |
| `/api/session/new` | POST | 开启新会话，返回 sessionId |
| `/api/chat` | POST | SSE 流式对话；事件:`stage`(start/done/tool_start/tool_end/session)、`delta`(text/thinking)、`music`(url/prompt/durationSec)、`error` |
| `/api/audio?url=` | GET | 音频代理（仅本服务生成的 URL；支持 Range;`&download=1` 触发下载） |

## 环境变量

| 变量 | 必填 | 说明 |
| ---- | ---- | ---- |
| `LLM_PROVIDER` | 否 | 编排模型 provider,默认 `deepseek` |
| `LLM_MODEL` | 否 | 编排模型 id,默认 `deepseek-chat` |
| `DEEPSEEK_API_KEY` 等 | 否 | 所选 provider 的 Key;留空由前端用户输入 |
| `MODELSLAB_API_KEY` | 建议 | ModelsLab 音乐生成 Key;留空由前端用户输入 |
| `PORT` | 否 | 后端端口,默认 `3011` |

## 与源应用的差异

| 源应用（Python/Streamlit） | 本实现（TypeScript/aipack） |
| ---- | ---- |
| Streamlit 单轮页面 + 侧栏双 Key | React 聊天界面,多轮会话迭代生成 |
| OpenAI gpt-4o 固定模型 | 27 个内置模型可切换,Key 双通道 |
| agno ModelsLabTools(旧 v6/audio 端点) | 官方现行 `v6/voice/music_gen` + 排队轮询 |
| 下载 MP3 到本地 `audio_generations/` 再播放 | `/api/audio` 白名单代理流式播放 + 下载 |
| 双 Key 缺一即整页不可用 | LLM 缺 Key 才拦截;ModelsLab 缺 Key 时可正常对话,生成时给出可读指引 |
