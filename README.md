# Deep Research 通用研究与资料管理升级

本轮交付是对 [wangc219/deep-research](https://github.com/wangc219/deep-research) 原项目的升级：保留原系统，在同一源码仓库增加通用研究工作台、资料管理、计划确认、五角色执行、来源引用和报告导出。Yuxi 只作知识库设计参考，不需要部署它的后端。

**从这里开始：[升级包与应用步骤](deep-research-upgrade/README.md)**。将本仓库下载到单独目录，再将升级包检查、应用到你自己的原项目副本；不是直接覆盖原文件夹。应用器会拒绝未提交修改和同名冲突。

- [相对原项目的改动](CHANGES_FROM_DEEP_RESEARCH.md)
- [本版通过、失败修复、未验证及回滚](deep-research-upgrade/overlay/docs/GENERAL_RESEARCH_ACCEPTANCE.md)
- [应用后的安装与使用](deep-research-upgrade/overlay/apps/general-research/README.md)
- [追加工作日志](deep-research-upgrade/overlay/docs/GENERAL_RESEARCH_WORK_LOG.md)

本机已通过通用模块 98 项、前端新旧回归 164 项和基础检查；浏览器已使用明确标注的合成模型走通主要流程。**真实模型及公开搜索服务联调尚未执行**，需要各使用者在本机填写自己的配置。进度通过 SSE 实时更新，模型答案按角色完成后显示。

## 当前目录的区别

| 目录 | 用途 |
|---|---|
| `deep-research-upgrade/` | 当前 0.3 原项目升级包，优先使用 |
| 根目录原有 `server.mjs`、`public/` 等 | 保留的 0.2 单机资料库，只有 MD/TXT，不是新版通用研究工作台 |
| `docs/V0_2_README.md` | 0.2 历史使用说明 |

此仓库名称沿用前次发布名称。本次公开的是经过检查的升级增量，不是原项目完整源码的重复上传；原项目需另外取得。默认通用入口是应用并启动后的 http://127.0.0.1:4196/ 。

资料、账号、研究任务使用独立空间，不连接原领域军事研究、武器研发或作战推演流程。没有替换原 Agent 框架或迁移原数据库。
