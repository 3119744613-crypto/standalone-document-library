# Yuxi 设计参考

本项目参考 [Yuxi](https://github.com/xerrors/Yuxi) 源码提交 `d633378c7ea55618ac659a547bfe90f74b29af4c` 的知识库设计。参考文件清单及 SHA256 保留在 `upstream.lock.json`，MIT 通知保留在 `third-party/YUXI-LICENSE`。

借鉴的是：上传、解析、索引分开的生命周期；失败状态可见；检索结果保留来源；预览按行窗口读取。具体本地服务、账户、SQLite 存储、文本解析与关键词索引由本项目实现。

**从 0.2.0 起没有 Yuxi HTTP 适配器或运行依赖**。不部署其后端，不需要其账号、对象存储、向量库、worker 或模型。不复制其整套前端，不替换任何 Agent 框架，不迁移其他项目数据库。

Yuxi 的多用户权限、语义检索、图谱与模型能力并未因此成为本项目能力。当前本地服务是单账户，检索是关键词匹配，详见 README。

`node scripts/verify-upstream.mjs /absolute/path/to/Yuxi` 仅用于复核这份历史参考源码清单和许可，不是启动、构建或测试前提，也不连接服务。

旧的 HTTP 适配版本完整保留在 Git 提交 `dc9d23d50ba3c548f0b09b6f3c9f3d7a65e98f50`，仅用于追溯或回滚。
