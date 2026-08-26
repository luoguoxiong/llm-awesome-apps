// starter_ai_agents/ai_multimodal_agent/frontend/src/components/MediaUploader.tsx
// 媒体上传区:图片(压缩预览)或视频(预览 + 抽帧网格)。
// 抽帧/压缩逻辑在 App(调用 frames.ts),组件负责展示与交互。
import { useEffect, useMemo, useState } from 'react';
import { formatBytes } from '../frames';

export type MediaKind = 'image' | 'video';

interface MediaUploaderProps {
  /** 当前已选文件(图片或视频) */
  file: File | null;
  kind: MediaKind | null;
  /** 处理后的帧(图片 1 张;视频 N 帧,data URI) */
  frames: string[];
  /** 视频抽帧数(3/6/9) */
  frameCount: number;
  onFrameCountChange: (n: number) => void;
  /** 正在抽帧/压缩 */
  processing: boolean;
  disabled: boolean;
  onPick: (file: File) => void;
  onClear: () => void;
}

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/bmp,video/mp4,video/quicktime,video/x-msvideo,video/webm';

export function MediaUploader({
  file,
  kind,
  frames,
  frameCount,
  onFrameCountChange,
  processing,
  disabled,
  onPick,
  onClear,
}: MediaUploaderProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputId = useMemo(() => `media-input-${Math.random().toString(36).slice(2, 8)}`, []);

  // 视频预览 objectURL(仅预览用,随 file 变化重建/释放)
  const videoUrl = useMemo(() => (file && kind === 'video' ? URL.createObjectURL(file) : null), [file, kind]);
  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const handleFiles = (files: FileList | null) => {
    const f = files?.[0];
    if (f) onPick(f);
  };

  return (
    <section className="card uploader-card">
      <h2>1 · 上传图片或视频</h2>

      {!file && (
        <label
          className={`dropzone ${dragOver ? 'dropzone--over' : ''}`}
          htmlFor={inputId}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            handleFiles(e.dataTransfer.files);
          }}
        >
          <input
            id={inputId}
            type="file"
            accept={ACCEPT}
            hidden
            disabled={disabled}
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <span className="dropzone__emoji">📁</span>
          <span className="dropzone__title">点击选择,或拖拽文件到此处</span>
          <span className="dropzone__hint">
            图片:JPG / PNG / WebP / GIF / BMP · 视频:MP4 / MOV / AVI / WebM(浏览器抽帧分析)
          </span>
        </label>
      )}

      {file && (
        <div className="media-preview">
          <div className="media-preview__head">
            <span className="media-preview__name" title={file.name}>
              {kind === 'video' ? '🎬' : '🖼'} {file.name}({formatBytes(file.size)})
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={onClear}
              disabled={disabled || processing}
            >
              移除
            </button>
          </div>

          {kind === 'video' && videoUrl && <video className="media-preview__video" src={videoUrl} controls muted playsInline />}

          {kind === 'video' && (
            <div className="frame-controls">
              <span>抽帧数</span>
              {[3, 6, 9].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`chip ${frameCount === n ? 'chip--active' : ''}`}
                  onClick={() => onFrameCountChange(n)}
                  disabled={disabled || processing}
                >
                  {n} 帧
                </button>
              ))}
            </div>
          )}

          {processing && (
            <div className="media-preview__status">
              <span className="spinner" /> 正在{kind === 'video' ? `抽取 ${frameCount} 个关键帧` : '压缩图片'}…
            </div>
          )}

          {!processing && frames.length > 0 && (
            <div className="frames-grid">
              {frames.map((f, i) => (
                <figure key={i} className="frame-item">
                  <img src={f} alt={`帧 ${i + 1}`} loading="lazy" />
                  {kind === 'video' && <figcaption>帧 {i + 1}/{frames.length}</figcaption>}
                </figure>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
