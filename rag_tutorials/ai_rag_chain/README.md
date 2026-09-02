# AI RAG Chain

基础 RAG 检索链(最小 RAG):上传文档建立知识库,提问时本地相似检索 top-K 片段,LLM 仅基于检索上下文流式作答,引用片段可展开溯源。

迁移自 [awesome-llm-apps/rag_tutorials/rag_chain](https://github.com/Shubhamsaboo/awesome-llm-apps/tree/main/rag_tutorials/rag_chain)(PharmaQuery:LangChain RAG Chain + Chroma + Gemini)。

## 功能

- **知识库管理**:上传 PDF / TXT / MD / CSV / JSON 文档,自动分块(chunk≈800 字符,overlap 200)索引,JSON 文件持久化(重启不丢),可一键清空。
- **本地相似检索**:TF-IDF 稀疏向量(英文词 + 中文双字)+ 余弦相似度,取 top-K 片段(K 默认 5,对齐源应用 `as_retriever(k=5)`),零外部嵌入服务、离线可用。
- **接地问答**:LLM 仅基于检索片段作答(严格提示词:不编造、不臆测、上下文不足时明确说明),SSE 流式输出。
- **引用溯源**:回答下方可展开查看检索到的片段,含来源文件名与相似度分数。
- **模型无关**:默认 DeepSeek,前端下拉可切换全部内置模型;API Key 双通道(服务器 `.env` / 前端输入,localStorage 持久化)。

## 与源应用对照

| 源应用(Python)                              | 本实现(TypeScript)                                    |
| --------------------------------------------- | ------------------------------------------------------- |
| Streamlit UI                                  | React + Vite,SSE 流式渲染                              |
| Chroma + GoogleGenerativeAIEmbeddings         | 内存 TF-IDF 向量索引(`src/vectordb.ts`)+ JSON 持久化 |
| PyMuPDF / PyPDFLoader                         | 零依赖 PDF 文本提取(`src/pdf.ts`,zlib + 文本算子)     |
| SentenceTransformersTokenTextSplitter         | 段落优先分块(chunk 800 / overlap 200)                 |
| ChatGoogleGenerativeAI(gemini-1.5-pro)        | aipack catalog 任意模型(默认 deepseek-chat)           |
| retriever \| prompt \| model \| parser 链     | 服务端检索 → 上下文 prompt → `runtime.stream()`          |

## 快速开始

```bash
# 1. 安装依赖(仓库根目录执行)
pnpm install

# 2. 配置 API Key
cd rag_tutorials/ai_rag_chain
cp .env.example .env
# 编辑 .env,至少配置一个 LLM API Key(默认 DeepSeek)

# 3. 启动开发模式(仓库根目录执行)
pnpm --filter ai-rag-chain dev
# 后端 http://localhost:3013,前端 http://localhost:5173
```

打开前端页面后:

1. 在"知识库"卡片上传文档(PDF/TXT/MD 等,单文件 ≤ 10MB);
2. 在"模型与 Key"卡片选择生成模型(缺 Key 时输入);
3. 在下方输入问题,Enter 提交,回答流式生成,可展开查看引用片段。

无 API Key 时服务仍可启动,提问接口会返回明确引导提示;知识库上传与检索不依赖任何 Key。

## 环境变量

| 变量             | 默认值                                | 说明                                        |
| ---------------- | ------------------------------------- | ------------------------------------------- |
| `LLM_PROVIDER`   | `deepseek`                            | 生成模型 provider                           |
| `LLM_MODEL`      | `deepseek-chat`                       | 生成模型 id                                 |
| `DEEPSEEK_API_KEY` 等 | 空                               | 按 provider 提供,留空时由前端用户输入     |
| `RAG_TOP_K`      | `5`                                   | 检索片段数(1-10,对齐源应用 k=5)         |
| `VECTOR_DB_DIR`  | `<app>/.rag-store`                    | 知识库 JSON 持久化目录                     |
| `PORT`           | `3013`                                | 后端端口(开发态 Vite 在 5173)           |

## 已知限制

- PDF 提取为 best-effort:扫描件(纯图像)与使用 CID/Identity-H 编码字体的部分现代 PDF 无法提取文本,请转为 `.txt` / `.md` 上传(上传结果会明确提示)。
- TF-IDF 检索为词面匹配,无语义泛化;语义检索变体见同目录其他 RAG 应用(混合检索 / 纠错 / Agentic 等)。

## 常用命令

```bash
pnpm --filter ai-rag-chain typecheck        # 类型检查(后端)
pnpm --filter ai-rag-chain typecheck:web    # 类型检查(前端)
pnpm --filter ai-rag-chain build            # 生产构建(vite build + tsc)
pnpm --filter ai-rag-chain serve            # 生产模式单端口运行
```
