<h1 align="center">dsh-session-manager</h1>

<p align="center">DSH 会话管理插件：设置页查看全部会话（按创建日期 / 最近更新排序、逐条删除、手动批量删除过期会话）；会话数量或日志总大小超过阈值时启动弹窗提醒。</p>

## 功能

| 能力 | 说明 |
|---|---|
| 设置页「会话管理」面板 | 侧栏设置 → 会话管理：列出 DSH 全部会话（含已结束的持久化会话） |
| 排序 | 按**创建日期**或**最近更新**排序，各自可切换升序 / 降序 |
| 会话信息 | 标题、状态（运行中 / 打开中 / 子代理 / 已结束）、创建时间、最近更新时间（含相对时间）、日志大小、工作目录、会话 ID |
| 手动删除 | 每行“删除”按钮，两步确认；删除该会话的持久化日志，Web 端会话列表即时移除该行 |
| 手动批量删除 | “批量删除（> N 天：M 个）”按钮，两步确认后一次性删除「最近更新」超过 `maxAgeDays` 天的所有会话，并显示删除/跳过统计 |
| 启动告警弹窗 | 总会话数量超过 `maxSessions` 或日志总大小超过 `maxTotalSizeMB` 时，页面加载后弹窗提醒（每次加载至多一次），引导去设置页处理 |
| 阈值总览 | 设置页实时展示当前会话数 / 日志总大小 与上限对比，超限标红 |
| 安全护栏 | 打开中 / 运行中的会话、子代理会话不参与批量删除，也不可手动删除；删除只作用于会话日志工件 |

## 原理

DSH 当前没有官方“删除会话”API（`session-controller` 只暴露 list/search/create/…/cancel）。本插件的宿主端直接作用于持久化层：

- **枚举**：`ctx.sessionPersistence.list()` 列出全部持久化会话头；`ctx.sessions.list()` 补充尚未落盘的 live 会话。冷会话的“最近更新时间”取 JSONL 日志工件（`~/.dsh/sessions/…/session.jsonl.zstd`）的 mtime，live 会话取最后一条事件时间。
- **删除**：经 `sessionPersistence.locate(header)` 拿到后端自有的工件路径，删除日志文件并尝试移除（已变为空的）会话目录。删除前校验：无 live 会话（无写入者）、无运行中 Agent；成功后 emits `api-session/removed`，Web 端列表即时移除该行。`session-query` 的搜索索引会在下一次 reconcile 时自动清除被删会话的行。
- **批量删除**：与逐条删除同一实现，遍历筛选「非子代理、非打开中/运行中、最近更新早于 `maxAgeDays` 天」的会话依次删除。
- **告警**：无任何定时/自动删除行为；`GET` 快照附带阈值统计（总数 / 总大小 / 已逾期货），由浏览器端在设置页展示、并在页面加载时检查一次是否弹窗。

客户端与 `dsh-global-font` 同一通道：包声明 `dsh.client`（boot 注入 `@deepseek-ai/dsh-client-ui-primitives`），浏览器端注册 `settings.section`（order 40，位于“插件”之后、“字体”之前）与 `shell.overlay`（启动告警弹窗），数据经宿主 `/api/dsh-session-manager` 读写。

## 安装

```sh
dsh plugin --profile web add github:ErrorLst/dsh-session-manager
```

本包声明了 `dsh.bundle.patch`：`dsh plugin add` 成功后 reconcile 会自动把它登记进 profile 的 bundle 层（`dsh.profile.bundles`），无需手动编辑配置；重启 dsh web 即生效。

本地开发安装（同一目录即本仓库 checkout）：`dsh plugin --profile web add <本仓库路径>`。

## 使用

1. 重启 dsh web 后刷新页面（新 client bundle 自动生效）。
2. 打开侧栏 **设置 → 会话管理**：
   - 排序（创建日期 / 最近更新 × 升序 / 降序）；
   - 每行“删除”按钮（点两次确认，打开中/运行中不可删）；
   - “批量删除（> N 天：M 个）”按钮（点两次确认）删除全部过期会话；
   - 顶部实时显示当前会话数、日志总大小、逾期货，与告警上限对比。
3. 启动告警弹窗：会话数或总大小超限时，页面加载后自动弹出（每次加载至多一次），点“知道了”关闭，或前往设置页清理。

## 配置

包内 `config.json`（改后重启生效）：

```json
{
  "maxAgeDays": 30,
  "maxSessions": 100,
  "maxTotalSizeMB": 1024
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxAgeDays` | `30` | 批量删除阈值：“最近更新”早于该天数即视为过期 |
| `maxSessions` | `100` | 总会话数量告警上限；`0` 表示不检查 |
| `maxTotalSizeMB` | `1024` | 总会话日志大小（MB）告警上限；`0` 表示不检查 |

## 还原 / 卸载

```sh
dsh plugin --profile web remove @dsh-external/dsh-session-manager
```

（仅旧版本 dsh 才需手动删除 profile 的 insert 行。）

## 已知边界

- DSH 无原生删除 API：删除直接作用于 `session-persistence-jsonl` 日志工件，不涉及工作区文件、附件、spill 等其它存储；会话目录若含其它工件则只删除日志文件、保留目录。
- 打开中（`SessionStore` 已挂载）或运行中的会话不可删除（批量删除会跳过并计数），避免与写入者竞争；当前正在使用的会话因此需要先关闭（冷态后才可删）。
- 批量删除不处理子代理会话（`origin: subagent`），它们的生命周期与父会话关联。
- 告警弹窗只在浏览器页面加载时检查一次并提示一次；阈值调整后需重启生效。
- 若部署了 `session-query-sqlite` 搜索索引：被删会话的行在下一次搜索/观察 reconcile 时清除，期间搜索不会命中已删会话（索引行只增删不改）。

## 插件管理

已装插件用 plugin-registry 的**薄控制台**管理（浏览器面板）：管理 profile 插件安装态（bundle 层栈 + insert 行 + 启停），无需手改配置。
