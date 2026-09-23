# 独立通用资料库

中文文档管理页面及轻量 Node.js 接口适配器，连接独立部署的 [Yuxi](https://github.com/xerrors/Yuxi)，用于软件说明、课程笔记等通用资料。

**当前是源码交付版：页面和适配器可运行，真实 Yuxi 后端尚未完成联调。** 本仓库不包含 Yuxi 后端、数据库、解析 worker、模型或其他 Agent 系统。没有后端时会明确显示“等待连接”，不会使用合成资料代替真实结果。

## 运行条件

- Node.js **24 或更高版本**。
- 没有第三方 Node 依赖，无需 `npm install`。
- 实际资料操作需要单独运行的 Yuxi、独立账号和相应存储/模型配置。已有远程 Yuxi 时，本入口不需要 Docker。

## 快速开始

下载或克隆本仓库，在仓库根目录打开终端：

```sh
node server.mjs
```

打开 <http://127.0.0.1:4184/>，按 Ctrl-C 停止。服务只监听本机，没有后台守护或自动启动配置。

也可以在 macOS/Linux 运行 `./start.sh`，在 Windows PowerShell 运行 `./start.ps1`。若脚本被系统策略阻止，直接使用 `node server.mjs`，无需修改系统策略。

所有文件按仓库自身位置定位，不依赖开发者电脑路径；首次运行不需要复制旧数据库或聊天记录。

## 连接真实 Yuxi

先确认独立 Yuxi 服务已经运行，再设置它的地址。以下端口只是示例，该地址必须实际运行 Yuxi。

macOS/Linux：

```sh
YUXI_LIBRARY_UPSTREAM=http://127.0.0.1:5050 node server.mjs
```

Windows PowerShell：

```powershell
$env:YUXI_LIBRARY_UPSTREAM = 'http://127.0.0.1:5050'
node server.mjs
```

地址不带 `/api`，不能包含用户名、密码、查询参数或路径；远程实例必须使用 HTTPS。本地入口端口可通过 `YUXI_LIBRARY_PORT` 修改。`.env.example` 只说明变量，程序**不会自动加载 `.env`**。

使用独立 Yuxi 账号或 API Key 登录。凭据只存当前页面内存，刷新或退出后重新输入，不写浏览器持久存储，也不转发 Cookie。最终权限由 Yuxi 按每次请求的身份决定。

适配源码固定为 `d633378c7ea55618ac659a547bfe90f74b29af4c`。其他部署版本需核对实际接口；显示此源码版本不证明运行服务的版本。详见 [接口说明](docs/UPSTREAM.md)。

## 功能和限制

- 查看资料库和文档；用明确的 embedding 配置创建 Milvus 资料库。
- 上传 Markdown/TXT，每份最多 10 MiB；登记、解析、索引分开操作。
- 查看解析后的纯文本、独立检索与来源、删除文档。
- 处理切账号、切库、请求取消、迟到响应和已确认的撤权；防止同一页面重复提交解析/索引。
- 查询结果只在本页面使用，没有其他 Agent 或业务系统的连接接口。

queued 不等于处理完成。登记失败可能留暂存对象；删除成功不证明全部物理副本已清除，上游存储和索引需分别验证。本页防重复也不保证跨页面/后端幂等。

PDF、扫描件、多模态、跨设备部署、真实权限和检索质量均未完成本版本验收。

## 检查与测试

```sh
node scripts/doctor.mjs
node scripts/test.mjs
node scripts/build.mjs
```

未配置上游时 doctor 退出 2，表示连接条件未完整配置。测试使用本地合成 HTTP 服务和轻量 UI 状态环境，不调用模型；通过不能替代真实 Yuxi 联调。构建仅检查页面 JavaScript、复制静态文件并生成 SHA256 清单。

本次独立目录的实际结果见 [验收记录](docs/ACCEPTANCE.md)。Windows/Linux 命令说明不代表已在这些系统执行验收。

## 数据、更新与许可

文档存储在所连接的 Yuxi 服务，本入口不创建文档数据库。更新前保存本机配置；停止入口或撤销代码版本不会删除或回滚上游资料。

发布内容为源码、测试与说明，排除真实配置、密钥、数据库、缓存及用户资料。第三方通知见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；尚未为本适配器的原创代码指定开源许可证。
