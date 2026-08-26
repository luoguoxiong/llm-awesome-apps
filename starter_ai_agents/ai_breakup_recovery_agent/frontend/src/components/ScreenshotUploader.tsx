// starter_ai_agents/ai_breakup_recovery_agent/frontend/src/components/ScreenshotUploader.tsx
// 聊天截图上传:多选图片 → 浏览器端压缩为 data URI → 缩略图预览 + 删除。
// 压缩逻辑复用 ai_multimodal_agent 的图片通路(images.ts)。
import { useRef } from 'react';
import { fileToCompressedDataUri } from '../images';

const MAX_COUNT = 8;

interface ScreenshotUploaderProps {
  /** 已就绪的截图 data URI 列表 */
  screenshots: string[];
  onAdd: (uris: string[]) => void;
  onRemoveAt: (index: number) => void;
  disabled: boolean;
  error: string | null;
  onPickError: (message: string | null) => void;
}

export function ScreenshotUploader({
  screenshots,
  onAdd,
  onRemoveAt,
  disabled,
  error,
  onPickError,
}: ScreenshotUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const processingRef = useRef(false);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (processingRef.current) return;
    if (screenshots.length + files.length > MAX_COUNT) {
      onPickError(`截图最多 ${MAX_COUNT} 张(已有 ${screenshots.length} 张)`);
      return;
    }

    processingRef.current = true;
    onPickError(null);
    try {
      const uris: string[] = [];
      for (const f of Array.from(files)) {
        if (!f.type.startsWith('image/')) {
          onPickError(`跳过 "${f.name}":不是图片文件`);
          continue;
        }
        uris.push(await fileToCompressedDataUri(f));
      }
      if (uris.length > 0) onAdd(uris);
    } catch (e) {
      onPickError(`截图处理失败:${(e as Error).message}`);
    } finally {
      processingRef.current = false;
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <section className="card">
      <h2>2 · 聊天截图(可选)</h2>
      <div
        className={`dropzone ${screenshots.length > 0 ? 'dropzone--filled' : ''}`}
        onClick={() => !disabled && inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (!disabled) void handleFiles(e.dataTransfer.files);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          disabled={disabled}
          onChange={(e) => void handleFiles(e.target.files)}
        />
        {screenshots.length === 0 ? (
          <div className="dropzone__hint">
            <span className="dropzone__icon">📷</span>
            <p>
              点击选择或拖入聊天截图(最多 {MAX_COUNT} 张)
              <br />
              团队会结合截图理解对话中的情绪语境
            </p>
            <p className="dropzone__note">上传截图后请选择带 🖼 标记的多模态模型</p>
          </div>
        ) : (
          <div className="thumbs">
            {screenshots.map((uri, i) => (
              <div key={i} className="thumb">
                <img src={uri} alt={`截图 ${i + 1}`} />
                <button
                  type="button"
                  className="thumb__remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveAt(i);
                  }}
                  disabled={disabled}
                  aria-label={`删除截图 ${i + 1}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {error && <p className="field-error">{error}</p>}
    </section>
  );
}
