// starter_ai_agents/ai_medical_imaging_agent/frontend/src/components/ImageUploader.tsx
// 医学影像上传区：单张图片（拖拽/点击选择 → 浏览器端压缩预览）。
// 压缩逻辑在 App（调用 image.ts），组件负责展示与交互。
import { useMemo, useState } from 'react';
import { formatBytes } from '../image';

interface ImageUploaderProps {
  /** 当前已选文件 */
  file: File | null;
  /** 处理后的图片（data URI，未就绪为 null） */
  image: string | null;
  /** 正在压缩 */
  processing: boolean;
  disabled: boolean;
  onPick: (file: File) => void;
  onClear: () => void;
}

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/bmp';

export function ImageUploader({ file, image, processing, disabled, onPick, onClear }: ImageUploaderProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputId = useMemo(() => `image-input-${Math.random().toString(36).slice(2, 8)}`, []);

  const handleFiles = (files: FileList | null) => {
    const f = files?.[0];
    if (f) onPick(f);
  };

  return (
    <section className="card uploader-card">
      <h2>1 · 上传医学影像</h2>

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
          <span className="dropzone__emoji">🩻</span>
          <span className="dropzone__title">点击选择，或拖拽影像文件到此处</span>
          <span className="dropzone__hint">
            支持 X 光 / CT / MRI / 超声等的 JPG / PNG / WebP / GIF / BMP 图片（DICOM 请先转换为 PNG/JPG）
          </span>
        </label>
      )}

      {file && (
        <div className="media-preview">
          <div className="media-preview__head">
            <span className="media-preview__name" title={file.name}>
              🩻 {file.name}（{formatBytes(file.size)}）
            </span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={onClear} disabled={disabled || processing}>
              移除
            </button>
          </div>

          {processing && (
            <div className="media-preview__status">
              <span className="spinner" /> 正在压缩图片…
            </div>
          )}

          {!processing && image && (
            <figure className="image-preview">
              <img src={image} alt="已上传的医学影像" />
              <figcaption>待分析影像（已压缩预处理）</figcaption>
            </figure>
          )}
        </div>
      )}
    </section>
  );
}
