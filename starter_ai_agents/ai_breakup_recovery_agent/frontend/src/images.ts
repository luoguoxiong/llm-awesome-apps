// starter_ai_agents/ai_breakup_recovery_agent/frontend/src/images.ts
// 浏览器端聊天截图预处理:多图压缩为 JPEG data URI(canvas)。
// 复用 ai_multimodal_agent/frontend/src/frames.ts 的图片压缩逻辑
// (本应用不需要视频抽帧,只处理图片)。

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
