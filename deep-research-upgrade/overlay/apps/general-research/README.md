# Deep Research 通用研究与资料管理（0.3）

这是 `wangc219/deep-research` 原项目中的新增模块。前端位于同一 `apps/web`，复用原项目样式、界面组件及通用 SSE 读取器；原工作台新增入口。资料与通用研究使用自己的服务、账号、SQLite 和模型配置。

从上传需求文档开始：建立资料库 → 上传、解析、索引 → 创建研究草稿 → 生成并编辑计划 → 确认外发片段和公开检索词 → 五个 Agent 分工完成有来源编号的 Markdown 报告。

## 安装和启动

需要 Node.js 24+、npm、Python 3.11+；首次安装需要联网下载固定依赖。macOS/Linux 示例，在原项目根目录：

```bash
cd apps/general-research
npm run setup
cp .env.example .env.general
npm run doctor
npm start
```

打开 <http://127.0.0.1:4196/>，首次创建本机账号（密码至少 10 位）。Windows PowerShell 可用 `Copy-Item .env.example .env.general`；Windows 安装与进程终止尚未实机验证。

`setup` 为本模块创建 `.venv`，将前端依赖装入 `.build/web`，只构建通用入口到 `../web/dist-general`。它不替换原项目 `.venv`、`node_modules` 或 `.env`。若 Python 命令不同，运行前设置 `GENERAL_PYTHON`。更新前端后运行 `npm run build`。

资料整理不需要模型。研究需要在 `.env.general` 中填写自己的：

- `GENERAL_MODEL_BASE_URL`、`GENERAL_MODEL`、`GENERAL_MODEL_API_KEY`：支持 Chat Completions 的模型服务。
- `GENERAL_SEARCH_API_KEY`：Brave Search API 密钥。

配置修改后重启服务。密钥不要提交 Git，也不要发到聊天。程序只加载本模块 `.env.general`，不读取原业务配置。模型兼容性与账号额度需要实测；`doctor` 检查本机运行环境，不消耗模型额度，也不证明远程服务可用。

接口实现参考 [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) 与 [Brave Web Search](https://api-dashboard.search.brave.com/app/documentation/web-search)。模型响应为分角色完成后呈现；SSE 实时更新角色进度，不承诺逐 token 输出。

## 能力和边界

- 文本 PDF、DOCX、Markdown、TXT，每份 ≤10 MiB；PDF ≤200 页。扫描/图片、加密 PDF、OCR 不支持。
- DOCX 读取正文段落与表格，不提取页眉、页脚、批注和图片，不承诺 Word 页码。
- 本地关键词检索；研究最多选 6 份文档，每份最多 6 个片段，合计最多 16000 字符。不是整本文档穷尽阅读，也不是向量检索。
- 规划、资料研究、公开资料研究、核验、撰写分别调用模型；两名研究 Agent 并行，核验与撰写顺序执行。默认预算 6 次，正常流程使用 5 次模型调用；搜索、抓取有自己的数量和时间上限。
- 计划执行前可改步骤与公开检索词。仅已确认检索词发往 Brave；必要文档片段与任务目标会发往你配置的模型。网页正文按公开地址抓取，无浏览器脚本执行，搜索摘要不冒充已读取正文。
- 持久化任务/进度、断线后事件补读、取消、失败记录、来源卡片、报告导出。取消能阻止后续本机步骤，不能保证外部服务不计已提交请求的费用。
- 重启中断任务不自动发起付费重试。删除来源会使相关报告失效，并清除其资料片段与 Agent 输出；备份和外部模型已收到的数据不在此删除范围内。
- 引用检查只校验编号存在和资料/公开来源类型，不自动证明结论正确。请复核原文、优缺点和推荐理由。
- 本机单账号使用，监听 127.0.0.1；不是公网、多租户产品。

Yuxi 只作资料生命周期与来源预览的设计参考，无需其后端、Agent 或数据库。新模块不连接原项目军事研究、武器研发、作战推演的工具、上下文、报告或数据库。

## 验证和回滚

```bash
npm test
npm run doctor
```

参见 [验收记录](../../docs/GENERAL_RESEARCH_ACCEPTANCE.md)、[版本差异](../../docs/GENERAL_RESEARCH_CHANGES.md) 和 [追加日志](../../docs/GENERAL_RESEARCH_WORK_LOG.md)。合成模型测试和真实模型验收分开记录。

关闭终端中的服务（Ctrl+C），原项目原有入口与数据保持原样。回滚代码用升级提交的 `git revert`；保留本模块 `.runtime` 私有数据备份，勿用旧版本程序直接打开新版库。升级包的应用方法在交付包根目录 README 中。
