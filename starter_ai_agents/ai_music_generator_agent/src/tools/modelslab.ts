/**
 * starter_ai_agents/ai_music_generator_agent/src/tools/modelslab.ts
 *
 * ModelsLab 音乐生成工具(aipack Tool),源应用 agno ModelsLabTools 的等价实现:
 *   - POST https://modelslab.com/api/v6/voice/music_gen(官方 v6 端点;源 agno 旧版
 *     v6/audio/music_generate 已被官方下线,实测返回 "POST method is not supported")
 *   - 同步成功:{ status: "success", output: ["https://...mp3"] }
 *   - 排队中:  { status: "processing", fetch_id, fetch_result } → 轮询 fetch 端点直到完成
 *   - 失败:    { status: "error", code, message }(如 invalid_api_key)
 *
 * 与源应用 wait_for_completion=True 行为对齐:工具内部轮询直到拿到 MP3 URL 才返回。
 *
 * 结果回传机制(前端内嵌播放器):
 *   - 按 toolCallId 登记 → runtime 在 tool_end 事件中取出,经 SSE `music` 事件下发前端
 *   - 按 URL 登记 → /api/audio 代理校验"仅代理本工具生成的 URL",防 SSRF
 */
import type { Tool } from '@aipack-ai/agent';

const MUSIC_GEN_URL = 'https://modelslab.com/api/v6/voice/music_gen';
const FETCH_URL = 'https://modelslab.com/api/v6/voice/fetch';

/** 轮询参数:每 3s 一次,最长 150s(音乐生成通常数秒~数十秒) */
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 150_000;
const HTTP_TIMEOUT_MS = 20_000;

// ─── 生成结果登记处(SSE 关联 + 代理白名单)───────────────────────

export interface MusicGeneration {
  /** MP3 直链(ModelsLab CDN) */
  url: string;
  /** 实际提交的详细音乐提示词 */
  prompt: string;
  /** 时长(秒) */
  durationSec: number;
  createdAt: number;
}

/** toolCallId → 生成结果(runtime 在 tool_end 时消费) */
const byToolCallId = new Map<string, MusicGeneration>();
/** url → 生成结果(/api/audio 代理白名单) */
const byUrl = new Map<string, MusicGeneration>();

/** 取出并移除某次工具调用的生成结果(tool_end 事件消费) */
export function takeGeneration(toolCallId: string): MusicGeneration | undefined {
  const g = byToolCallId.get(toolCallId);
  if (g) byToolCallId.delete(toolCallId);
  return g;
}

/** 查询某 URL 是否为本工具生成的音频(代理白名单校验) */
export function findGenerationByUrl(url: string): MusicGeneration | undefined {
  return byUrl.get(url);
}

// ─── ModelsLab API 客户端 ───────────────────────────────────────

interface ModelsLabResponse {
  status?: string;
  output?: string[];
  fetch_id?: string;
  fetch_result?: string;
  message?: string;
  code?: string;
}

async function postJson(url: string, body: unknown, timeoutMs = HTTP_TIMEOUT_MS): Promise<ModelsLabResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`ModelsLab HTTP ${res.status}`);
  return (await res.json()) as ModelsLabResponse;
}

/** 从响应中提取第一个音频 URL */
function firstOutputUrl(resp: ModelsLabResponse): string | null {
  const url = resp.output?.find((u) => typeof u === 'string' && /^https?:\/\//.test(u));
  return url ?? null;
}

/**
 * 生成音乐:提交 → (必要时)轮询 fetch → 返回 MP3 URL。
 * 失败抛错(由工具层转为对 LLM 的错误说明文本)。
 */
async function generateMusic(
  apiKey: string,
  prompt: string,
  durationSec: number,
): Promise<string> {
  // 提交生成请求
  let resp: ModelsLabResponse;
  try {
    resp = await postJson(MUSIC_GEN_URL, {
      key: apiKey,
      prompt,
      duration: durationSec,
      output_format: 'mp3',
    });
  } catch (err) {
    throw new Error(`无法连接 ModelsLab(${(err as Error).message});请检查网络后重试`);
  }

  // 同步失败(无效 Key / 余额不足等)
  if (resp.status === 'error' || resp.status === 'failed') {
    throw new Error(resp.message || resp.code || 'ModelsLab 返回未知错误');
  }

  // 同步成功 → 直接返回
  const immediate = firstOutputUrl(resp);
  if (resp.status === 'success' && immediate) return immediate;

  // 排队中 → 轮询 fetch(优先用响应里的 fetch_result URL,回退标准 fetch 端点)
  const fetchId = resp.fetch_id;
  if (!fetchId) {
    throw new Error(`ModelsLab 返回异常状态 "${resp.status}" 且缺少 fetch_id:${resp.message ?? '(无说明)'}`);
  }
  const pollUrl = /^https?:\/\//.test(resp.fetch_result ?? '') ? resp.fetch_result! : `${FETCH_URL}/${fetchId}`;

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let polled: ModelsLabResponse;
    try {
      polled = await postJson(pollUrl, { key: apiKey, fetch_id: fetchId });
    } catch (err) {
      throw new Error(`轮询生成状态失败(${(err as Error).message});请稍后重试`);
    }
    if (polled.status === 'success') {
      const url = firstOutputUrl(polled);
      if (url) return url;
      throw new Error('ModelsLab 返回 success 但缺少音频 URL');
    }
    if (polled.status === 'error' || polled.status === 'failed') {
      throw new Error(polled.message || polled.code || '音乐生成失败');
    }
    // processing / queued → 继续轮询
  }
  throw new Error(`音乐生成超时(>${Math.round(POLL_TIMEOUT_MS / 1000)} 秒);fetch_id=${fetchId},可稍后重试`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── aipack Tool 导出 ──────────────────────────────────────────

/**
 * 音乐生成工具:generate_music(prompt, duration)。
 * 缺 ModelsLab Key 时不抛错,返回可读错误文本(由 LLM 转告用户,保持对话可用)。
 */
export function createMusicTool(modelslabKey?: string): Tool {
  return {
    name: 'generate_music',
    description:
      '调用 ModelsLab 生成一段 MP3 音乐(纯器乐作品)。' +
      'prompt 必须是润色后的详细英文音乐提示词(风格流派、乐器与音色、节奏速度 BPM、情绪氛围、曲式结构);' +
      'duration 为时长(秒,默认 30,范围 5~300)。' +
      '用户想"生成/创作一段音乐"时调用;仅聊音乐知识时不调用。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '详细音乐提示词(英文),如 "upbeat electronic track, 120 BPM, synthesizers and drums, energetic and positive mood"',
        },
        duration: { type: 'number', description: '时长(秒),默认 30,范围 5~300' },
      },
      required: ['prompt'],
    },
    async execute(toolCallId, args) {
      const { prompt, duration } = (args ?? {}) as { prompt?: string; duration?: number };
      if (!prompt || !String(prompt).trim()) {
        return { content: [{ type: 'text', text: '错误:缺少 prompt 参数' }], details: { error: 'missing_prompt' } };
      }
      if (!modelslabKey) {
        return {
          content: [
            {
              type: 'text',
              text:
                '错误:ModelsLab API Key 未配置,无法生成音乐。' +
                '请让用户在页面"模型与 Key"卡片输入 ModelsLab API Key(获取地址 https://modelslab.com/dashboard/api-keys),' +
                '或在服务器 .env 设置 MODELSLAB_API_KEY 后重启。',
            },
          ],
          details: { error: 'missing_modelslab_key' },
        };
      }

      const detailedPrompt = String(prompt).trim().slice(0, 2000);
      const durationSec = Math.max(5, Math.min(300, Math.round(Number(duration) || 30)));

      try {
        const url = await generateMusic(modelslabKey, detailedPrompt, durationSec);
        const generation: MusicGeneration = {
          url,
          prompt: detailedPrompt,
          durationSec,
          createdAt: Date.now(),
        };
        byToolCallId.set(toolCallId, generation);
        byUrl.set(url, generation);
        // 登记表防膨胀:只保留最近 100 条
        if (byUrl.size > 100) {
          const oldest = byUrl.keys().next().value;
          if (oldest) byUrl.delete(oldest);
        }
        return {
          content: [
            {
              type: 'text',
              text:
                `音乐生成成功。\n- 提示词: ${detailedPrompt}\n- 时长: ${durationSec} 秒\n- 音频 URL: ${url}\n` +
                '前端会自动展示播放器;回复中简要介绍这首曲子即可,无需重复粘贴完整 URL。',
            },
          ],
          details: { url, durationSec },
        };
      } catch (err) {
        const msg = (err as Error).message || '音乐生成失败';
        console.warn(`[generate_music] 失败: ${msg}`);
        return {
          content: [{ type: 'text', text: `音乐生成失败:${msg}` }],
          details: { error: msg },
        };
      }
    },
  };
}
