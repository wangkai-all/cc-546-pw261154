# 谱件发行工作台（本地演示）

用虚构数据演示一条完整的谱件流水线：**采集进程按内容留文件 → 组装进程判断一套是否齐全 → 展示站只切到齐全的一套**。只用 Node.js 内置模块，无第三方依赖。

```bash
node server.js          # 读取 PORT，绑定 127.0.0.1
PORT=8080 node server.js
node --test             # 单元 + 端到端用例
node scripts/demo.mjs   # 从空目录跑一遍并打印每步计算出的变化
```

页面：<http://127.0.0.1:3000>。页面业务结果区带 `data-evidence-result="business"`，每次操作后展示「操作前 / 操作后」的齐全度、缺失槽位、展示指针、版本数、凭证数、文件数与唯一内容数。数据写在 `.data/`（`journal.jsonl` 追加式台账 + `content/<sha256>.blob` 内容库），删掉即可重来，或点页面上的「清空台账重来」。

## 业务规则

| 环节 | 规则 |
| --- | --- |
| 采集 | 只按内容入库：文件名只是标签，SHA-256 才是身份。同一内容重复投递只占一个 blob，但每批采集都留在台账里。 |
| 组装 | 读最新的文件清单，逐槽位要求**清单固定的那个 SHA-256** 仍在库、未被撤回、且是可校验字节。不按文件名回退，不拼凑旧声部。缺任何一项 → 0 个版本发行。 |
| 展示 | 只有整套齐全且全部固定内容可校验的版本才会被切到展示位。组装失败时若展示位正指着将被作废的版本，展示指针立刻置空（冻结）。 |
| 修订 | 「整套冻结」：旧版本作废、展示站清空，重新采集齐全后才能上线。「按清单引用」：只换目标声部，其余槽位继续引用发行版本固定的 fileId + sha256；固定内容缺失则整次修订被拒。 |
| 作废版本 | 版本作废只追加 `retire` 事件，不删内容。发行时自动出具下载凭证；旧版本凭证仍可下载该版本固定下来的旧内容，并在台账里留下成功/失败的下载记录。 |

槽位共 7 个：总谱 `score`、五个声部 `vn1 vn2 va vc cb`、文件清单 `manifest`。文件清单 schema 为 `score-manifest/v1`，见 `src/domain.js`。

## 页面按钮与接口

| 按钮 | 接口 | 作用 |
| --- | --- | --- |
| 采集未齐谱件 | `POST /api/capture/parts` | 只送达五个声部（5/7），演示「采集不判齐全」 |
| 补发总谱并重试 | `POST /api/retry` | 按台账状态选路：无清单 → 采集总谱+清单；有清单缺总谱 → 只补总谱并沿用其余固定槽位；否则直接重跑组装 |
| 查看发行版本 | `GET /api/status` | 展开历史版本、作废原因、固定哈希与每张凭证的下载入口 |
| 撤回总谱 | `POST /api/withdraw` | 撤回后立即重跑组装；展示指针冻结，凭证保留 |
| 修订声部（整套冻结 / 按清单引用） | `POST /api/revise-part` | 题述两种修订策略 |
| 清空台账重来 | `POST /api/demo/reset` | 清空 `.data/` 并从空目录开始 |

其他只读接口：`GET /api/status`、`GET /api/events`、`GET /api/vouchers/:id/plan`、`GET /api/download/:voucherId/:slot`（凭证固定内容）、`GET /api/versions/:versionId/files/:slot`（版本固定内容）。`POST /api/capture/score`、`POST /api/capture/suite`、`POST /api/vouchers` 供脚本或测试调用。

错误统一返回 `{ ok:false, error:{ code, message, status } }`，并带上最新 `status` 便于核对：

- `set-incomplete` 422：一套不齐，未发行
- `reference-unavailable` 422：清单/版本固定的内容已撤回或缺失
- `manifest-stale` 409：只补总谱会混入旧声部，拒绝
- `content-missing` / `content-integrity` 409：下载时固定内容缺失或被篡改，拒绝回退

## 代码结构

```
server.js            路由 + 静态文件（仅内置 http/fs/path）
src/store.js         追加式 JSONL 台账 + SHA-256 内容库，可回放
src/domain.js        槽位定义、清单 schema 与解析
src/collector.js     采集进程：声部 / 总谱+清单 / 撤回（只记事实，不判齐全）
src/assembler.js     组装判定：清单固定的 sha256 是否仍在库且可校验
src/service.js       发行、重试、修订、凭证、展示指针与状态汇总
public/              页面（无构建步骤）
test/scenario.test.js node --test 用例（正常 + 异常）
scripts/demo.mjs     从空目录跑一遍并打印计算前后的数值
```
