# Yuxi 接口适配说明

以官方源码提交 `d633378c7ea55618ac659a547bfe90f74b29af4c` 为适配基准，源文件及 SHA256 见根目录 `upstream.lock.json`。没有把部署实例或其他 tag 视为等价版本。

| 页面操作 | 上游 API |
|---|---|
| 连接检查 | `GET /api/auth/check-first-run` |
| 登录、当前身份 | `POST /api/auth/token`（OAuth 表单）、`GET /api/auth/me` |
| 可访问资料库 | `GET /api/knowledge/databases/external` |
| 管理权限、创建资料库 | `GET/POST /api/knowledge/databases` |
| 文档列表、解析文本、检索 | `/api/knowledge/databases/external/{kb_id}/files`、`files/{file_id}/open`、`retrieve` |
| 上传文件 | `POST /api/knowledge/files/upload?kb_id=…` |
| 登记、解析、索引 | `/api/knowledge/databases/{kb_id}/documents/add`、`parse`、`index` |
| 状态、删除 | `/api/knowledge/databases/{kb_id}/documents/{file_id}/basic`、`DELETE …/documents/{file_id}` |

普通用户沿用 external 只读路由；管理操作由上游角色及资料库权限共同约束。适配器逐请求传递用户自己的 Bearer token，没有共享管理员凭据或通用代理入口。上游 401/403、超时、断连和不识别的响应作为明确错误处理。

上传成功与登记成功为两个步骤。登记返回 HTTP 200 仍可能是业务失败；适配器核对逐项结果。解析/索引返回 queued 只能证明排队，需刷新观察实际状态。本页按钮锁不是后端幂等机制。

上游删除对象失败可能仅记录警告并继续删除文档记录。适配器的删除结果明确 `physicalDeletionVerified: false`，不承诺跨存储原子删除。

真实 Yuxi 的数据库、worker、对象存储、向量库和模型需单独部署，本仓库不启动这些依赖。真实联调须用无敏感资料检查上传、登记、parsed、indexed、查询来源、两账号权限、撤权和删除后各读取端点；这些目前均未验收。

如另有固定版本的 Yuxi 源码，可运行 `node scripts/verify-upstream.mjs /path/to/Yuxi` 检查参考文件及许可。此检查不等于运行中 HTTP 服务的版本验证。
