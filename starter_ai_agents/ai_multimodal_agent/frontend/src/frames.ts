// starter_ai_agents/ai_multimodal_agent/frontend/src/frames.ts
// 浏览器端媒体预处理:图片压缩 + 视频关键帧抽取(canvas)。
//
// 源应用(Gemini 视频分析)直接把视频文件交给模型;aipack 的多模态通路
// (Request.media → ImageContent)只支持图片。功能等价方案:
// 视频在前端用 <video> + canvas 均匀抽取 N 个关键帧 → JPEG data URI 序列,
// 模型按时间顺序分析帧序列,实现"视频内容理解"。

/** 等待单个媒体事件(成功/失败二选一) */
function once(el: HTMLElement, success: string, fail: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error(`媒体解码失败(${fail})`));
    };
    const cleanup = () => {
      el.removeEventListener(success, onOk);
      el.removeEventListener(fail, onErr);
    };
    el.addEventListener(success, onOk, { once: true });
    el.addEventListener(fail, onErr, { once: true });
  });
}

/** canvas 尺寸缩放:最长边不超过 maxEdge */
function scaledSize(w: number, h: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * 图片文件 → 压缩后的 JPEG data URI。
 * createImageBitmap 自动处理 EXIF 方向;GIF 取首帧。
 */
export async function fileToCompressedDataUri(file: File, maxEdge = 1568, quality = 0.9): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`无法解码图片文件 ${file.name}(格式:${file.type || '未知'})`);
  }
  try {
    const { width, height } = scaledSize(bitmap.width, bitmap.height, maxEdge);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 canvas 2D 上下文');
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    bitmap.close();
  }
}

/**
 * 视频文件 → 均匀抽取 count 帧的 JPEG data URI 序列(时间先后排列)。
 * 帧采样点取每等分区间的中点,避开首尾可能的黑帧。
 */
export async function extractVideoFrames(
  file: File,
  count = 6,
  maxEdge = 1280,
  quality = 0.82,
): Promise<string[]> {
  if (count < 1 || count > 10) throw new Error('抽帧数必须在 1~10 之间');

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';

  try {
    video.load();
    await once(video, 'loadedmetadata', 'error');
    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) {
      throw new Error(`无法读取视频时长 ${file.name}(编码可能不受浏览器支持)`);
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 canvas 2D 上下文');

    const frames: string[] = [];
    for (let i = 0; i < count; i++) {
      // 每等分区间的中点, clamp 到 [0, duration-0.05]
      const t = Math.min((duration * (i + 0.5)) / count, Math.max(duration - 0.05, 0));
      video.currentTime = t;
      await once(video, 'seeked', 'error');

      const { width, height } = scaledSize(video.videoWidth, video.videoHeight, maxEdge);
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(video, 0, 0, width, height);
      frames.push(canvas.toDataURL('image/jpeg', quality));
    }
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 粗估 data URI 的字节大小(base64 部分 × 3/4) */
export function estimateDataUriBytes(uris: string[]): number {
  let total = 0;
  for (const u of uris) {
    const idx = u.indexOf(',');
    if (idx !== -1) total += Math.floor(((u.length - idx - 1) * 3) / 4);
  }
  return total;
}

/** 字节数人性化显示 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
