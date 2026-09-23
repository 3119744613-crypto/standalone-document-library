# 当前版本相对 wangc219/deep-research 的改动

当前交付已从单独资料库转为**在原项目上应用通用研究升级**。完整说明见 [版本差异](deep-research-upgrade/overlay/docs/GENERAL_RESEARCH_CHANGES.md)。

| 改动 | 实际结果 |
|---|---|
| 原项目入口 | 同一 `apps/web` 新增通用研究页面，原入口新增导航链接，复用样式、组件和通用 SSE 读取器 |
| 资料管理 | PDF、DOCX、MD、TXT 的上传、解析、索引、预览、关键词检索与删除 |
| 研究流程 | 上传需求 → 生成可编辑计划 → 用户确认 → 五个角色分工执行 → 来源化 Markdown 报告 |
| 执行可靠性 | 事件补读、取消、迟到响应保护、进度与任务持久化、调用预算、明确失败状态 |
| 来源 | PDF 页码、DOCX 段落/表格单元、文本行号和公开网页来源；删除资料使关联报告失效 |
| 安装与数据 | 单独的依赖安装、模型/搜索配置、本机账号与 SQLite；保留原系统和原数据 |

官方比较基线为 [9b67368c](https://github.com/wangc219/deep-research/tree/9b67368c6baeb731f89e1076da8a1b68ff52178a)。开发起点 `49edb184` 是本机包含前期通用 SSE 工作的派生提交，不是 wangc219 仓库的官方提交；旧说明曾把这两者混淆，此处更正。

Yuxi 仅供资料模块设计参考，没有接入其后端、Agent 框架或数据库。原项目领域 Agent 的工具、上下文及报告流程不接入新资料检索。

**已通过**：98 项通用模块测试、164 项前端回归、原基础检查、前端构建，以及合成服务下的浏览器主要流程。

**失败与修复**：浏览器请求绑定、任务侧栏同步、退出后迟到写入、SSE长事件回放等均已修复；[完整记录](deep-research-upgrade/overlay/docs/GENERAL_RESEARCH_ACCEPTANCE.md)保留初次失败。

**未验证**：真实模型与搜索联调、选型报告事实质量、Windows/Linux实机、浏览器四格式文件选择器与强制断网；OCR和向量检索尚未实现。不能把合成验收当成真实模型效果。

[获取并应用升级](deep-research-upgrade/README.md) · [回滚方法](deep-research-upgrade/overlay/docs/GENERAL_RESEARCH_ACCEPTANCE.md#回滚方法)
