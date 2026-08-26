// starter_ai_agents/ai_medical_imaging_agent/frontend/src/image.ts
// 浏览器端图片预处理：压缩为 JPEG data URI（对齐 ai_multimodal_agent/frames.ts 的图片部分）。
//
// 源应用（Python/PIL）接受 JPG/PNG/DICOM；浏览器端无法原生解码 DICOM，
// 故仅接受常见图片格式（DICOM 需先转换为 PNG/JPG），见 README 说明。

/** canvas 尺寸缩放：最长边不超过 maxEdge */
function scaledSize(w: number, h: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * 图片文件 → 压缩后的 JPEG data URI。
 * createImageBitmap 自动处理 EXIF 方向；GIF 取首帧。
 */
export async function fileToCompressedDataUri(file: File, maxEdge = 1568, quality = 0.92): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`无法解码图片文件 ${file.name}（格式：${file.type || '未知'}）。DICOM 等专业格式请先转换为 PNG/JPG`);
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

/** 粗估 data URI 的字节大小（base64 部分 × 3/4） */
export function estimateDataUriBytes(uri: string): number {
  const idx = uri.indexOf(',');
  if (idx === -1) return 0;
  return Math.floor(((uri.length - idx - 1) * 3) / 4);
}

/** 字节数人性化显示 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
