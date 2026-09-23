# Deep Research 通用研究与资料管理升级包

本目录用于把通用研究工作台应用到你已有的 Deep Research 源码副本，**不是原系统的完整源码复制或新的 Yuxi 后端**。外层仓库现有的独立资料库 0.2 保持原样；本升级包位于自己的目录。

官方参考基线：[wangc219/deep-research 的 9b67368c6baeb731f89e1076da8a1b68ff52178a](https://github.com/wangc219/deep-research/tree/9b67368c6baeb731f89e1076da8a1b68ff52178a)。开发时本地起点 `49edb184642009d1f1994d41b63853d20315233d` 是含前期 SSE 工作的派生提交，不是官方仓库上的同名提交。对其他版本，检查不通过就停止；不要强制覆盖。

## 内容

- `overlay/`：新增通用模块、通用前端入口、必要的通用 SSE 读取器和本轮说明；不包含原领域业务实现、数据、密钥、运行缓存或 node_modules。
- `navigation.patch`：仅本轮对 README、Git 忽略规则、前端入口和 Vite 配置的修改；不包含前期领域代码历史补丁。
- `manifest.sha256.json`：包内文件大小、SHA256、文件模式及导航补丁前后文件摘要。
- `apply_upgrade.py`：仅本机检查和应用。不会运行应用、安装依赖、迁移数据库、提交或推送 Git。

## 使用

先保留原仓库的源码和数据备份，并确认已有未提交工作已经安全保存。推荐在独立克隆中进行首次应用；不要把此包解压覆盖原工作目录。

在本目录执行，路径替换为你的 Deep Research 克隆：

```sh
python3 apply_upgrade.py /absolute/path/to/deep-research --check
python3 apply_upgrade.py /absolute/path/to/deep-research --apply
```

省略参数也只执行检查。检查会核对完整清单、拒绝目标相关路径的已跟踪未提交修改、拒绝不同内容的同名新文件，并执行 `git apply --check`。已有相同内容的新文件保持不动；已完整应用且工作树干净的导航补丁可以识别。第一次应用产生未提交改动，先审阅并保存这些改动，再重复检查；工具不会自行提交以绕过脏工作树保护。

应用后查看 `git diff` 和 `git status`，按新增的 `apps/general-research/README.md` 安装、配置和启动。单纯检查或应用成功不代表模型、搜索或浏览器验收成功。新增模块使用自己的账号、配置和数据目录，不连接原领域工作流。

## 功能与验收

- [与原项目的差异](overlay/docs/GENERAL_RESEARCH_CHANGES.md)
- [通过、失败、未验证及回滚](overlay/docs/GENERAL_RESEARCH_ACCEPTANCE.md)
- [工作日志](overlay/docs/GENERAL_RESEARCH_WORK_LOG.md)
- [通用模块启动说明](overlay/apps/general-research/README.md)

本包包含文本 PDF、DOCX、Markdown、TXT 资料管理，计划确认及通用多 Agent 研究实现。Yuxi 只作设计参考。实际外部服务与各平台验收以记录为准，不以存在代码代替实测。

## 回退

应用器不提交、不启动服务。应用后若尚未运行且需要撤销，先保留和审阅新增改动，再按文件清单撤销本次新增文件与导航补丁；不要清理用户原来已有的同名文件。进入正式使用后，先停止服务并备份完整通用数据目录，再按验收文档回退兼容版本。代码回退不恢复已删除文档，也不撤回已向外部服务发送的请求。
