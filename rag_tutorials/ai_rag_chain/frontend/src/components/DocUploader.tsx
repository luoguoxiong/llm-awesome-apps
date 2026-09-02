// rag_tutorials/ai_rag_chain/frontend/src/components/DocUploader.tsx
// 知识库管理卡片:上传文档(PDF/TXT/MD)→ 提取分块入库;统计展示;清空。
import { useRef, useState } from 'react';
import { uploadFiles, clearDb, type DbStats, type UploadResult } from '../api';

interface DocUploaderProps {
  db: DbStats;
  onDbChange: (db: DbStats) => void;
  disabled?: boolean;
}

const MAX_FILE_MB = 10;

export function DocUploader({ db, onDbChange, disabled }: DocUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [results, setResults] = useState<UploadResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    setResults(null);
    setUploading(true);
    try {
      const oversized = [...files].filter((f) => f.size > MAX_FILE_MB * 1024 * 1024);
      if (oversized.length > 0) {
        throw new Error(`文件过大(单个上限 ${MAX_FILE_MB}MB):${oversized.map((f) => f.name).join('、')}`);
      }
      const res = await uploadFiles([...files]);
      onDbChange(res.db);
      setResults(res.results);
    } catch (e) {
      setError((e as Error).message || '上传失败');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleClear = async () => {
    setError(null);
    setResults(null);
    setClearing(true);
    try {
      const res = await clearDb();
      onDbChange(res.db);
    } catch (e) {
      setError((e as Error).message || '清空失败');
    } finally {
      setClearing(false);
    }
  };

  return (
    <section className="card">
      <h2>知识库</h2>
      <div className="upload-row">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.txt,.md,.markdown,.csv,.json"
          onChange={(e) => void handleFiles(e.target.files)}
          disabled={uploading || disabled}
          className="upload-input"
          id="doc-upload"
        />
        <label htmlFor="doc-upload" className={`btn btn--primary upload-btn ${uploading || disabled ? 'is-disabled' : ''}`}>
          {uploading ? '⏳ 处理中…' : '📎 上传文档'}
        </label>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void handleClear()}
          disabled={clearing || uploading || disabled || db.chunkCount === 0}
        >
          {clearing ? '清空中…' : '🗑 清空'}
        </button>
        <span className="db-stats">
          {db.chunkCount} 块 · {db.sourceCount} 个来源
        </span>
      </div>
      <p className="upload-hint">
        支持 PDF(零依赖文本提取,扫描件/CID 字体可能失败)与 TXT / MD / CSV / JSON;
        上传后自动分块索引并持久化(重启不丢)。
      </p>

      {db.sources.length > 0 && (
        <div className="source-list">
          {db.sources.map((s) => (
            <span key={s} className="source-tag" title={s}>
              📄 {s}
            </span>
          ))}
        </div>
      )}

      {results && results.length > 0 && (
        <ul className="upload-results">
          {results.map((r, i) => (
            <li key={`${r.name}-${i}`} className={`upload-result upload-result--${r.status}`}>
              {r.status === 'ok' ? '✅' : r.status === 'skipped' ? '⏭' : '❌'} <strong>{r.name}</strong>
              {r.message ? ` — ${r.message}` : ''}
            </li>
          ))}
        </ul>
      )}

      {error && <div className="upload-error">⚠️ {error}</div>}
    </section>
  );
}
