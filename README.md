# 口述史发布许可校验台

本地运行的口述史发布许可校验工具（Python + Flask + SQLite + 原生 JavaScript，无外部服务）。

录入访谈时长、说话人发言区间，以及每位说话人的授权区间（允许媒介 / 拒绝媒介 / 解禁日期），
再指定发布日期与版本媒介（音频或文字），系统即按发言与授权边界切分时间轴，逐段判定是否可发布，
并以时间码（HH:MM:SS）展示结果。

## 校验规则

1. **切分**：时间轴按访谈首尾、所有发言区间边界、所有授权区间边界切分为基本区间。
2. **覆盖**：每个基本区间必须被该区间内**所有发言人**的有效授权覆盖，缺任何一人即不可发布。
3. **拒绝优先**：任一授权拒绝目标媒介即不可发布；同一发言人允许与拒绝并存记为**授权冲突**，同样按拒绝处理。
4. **缺项**：无授权记录、或授权未涵盖目标媒介，均判为不可发布。
5. **未解禁**：解禁日期晚于发布日期时不可发布（解禁日当天可发布）。
6. **无发言**：无发言区间无需授权，视为可发布。
7. **合并**：相邻且结果（状态 + 原因）一致的区间自动合并为一个区间展示。

## 补件并复核

校验结果不理想时，可针对同一访谈、发布日期与媒介提交**一批待补授权**
（说话人 + 半开时间区间 + 允许/拒绝媒介 + 解禁日期）：

1. 系统在同一 SQLite 事务中先复制当前授权，按上述既有规则**试算**；
   再把整批补件合并进去**重算**。
2. 只有合并后**整条时间轴全部可发布**，整批补件才一次性写入；
   否则不落任何记录，并返回每个阻断区间及原因。
3. 补件批次本身先校验：同一说话人的补件区间不得**重叠**、同一补件不得
   既允许又拒绝同一媒介（**互相冲突**）、区间不得**越界**（超出访谈时长）——
   任一问题都令整批失败（HTTP 400），不写库。
4. `commit` 缺省为 `false`，即**试算**：完整返回前后两次校验结果与变更区间，
   但永不写入；`commit: true` 才尝试落库。
5. 成功响应中的 `changed_intervals` 列出变更后的区间（原状态 → 新状态）。

## 快速开始（单命令）

### Docker Compose（推荐）

```bash
docker compose up --build
```

### Docker

```bash
docker build -t oral-history-checker . && docker run --rm -p 8000:8000 -v oral_history_data:/data oral-history-checker
```

启动后打开 <http://localhost:8000>。

### 本地运行（无需 Docker）

```bash
pip install -r requirements.txt
python app.py          # 默认监听 8000 端口，可用 PORT 环境变量修改
```

## 使用流程

1. **访谈**：新建访谈（标题 + 时长 HH:MM:SS），可随时修改或删除。
2. **说话人**：添加访谈中出现的说话人。
3. **发言区间**：录入每位说话人的发言起止时间码（HH:MM:SS）。
4. **授权区间**：录入每位说话人的授权起止时间码、允许媒介、拒绝媒介、解禁日期（留空表示立即可用）。
5. **发布校验**：选择发布日期与媒介（音频 / 文字），点击「开始校验」，
   查看时间轴色带（绿=可发布，红=不可发布，灰=无发言）与逐段时间码结果及原因。
6. **补件并复核**：校验存在阻断时，在补件批次表中编辑待补授权（说话人、起止时间码、
   允许 / 拒绝媒介、解禁日期），先点「试算」查看合并后的时间轴与变更区间（不写入），
   再点「补件并复核」提交——仅当整条时间轴全部可发布时整批一次性写入，
   否则不落任何记录并列出每个阻断区间及原因。

所有记录均可在页面上直接修改、保存或删除。

## 数据持久化

- 容器内数据库为 `/data/oral_history.db`，Compose / 运行命令已挂载卷 `oral_history_data`，重启不丢数据。
- 本地运行时数据库为 `./oral_history.db`，可用环境变量 `DB_PATH` 指定其他路径。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/interviews` | 访谈列表 |
| POST | `/api/interviews` | 新建访谈 `{title, duration_seconds}` |
| GET | `/api/interviews/<id>` | 访谈详情（含说话人 / 发言 / 授权） |
| PUT / DELETE | `/api/interviews/<id>` | 修改 / 删除访谈 |
| POST | `/api/interviews/<id>/speakers` | 添加说话人 `{name}` |
| PUT / DELETE | `/api/speakers/<id>` | 修改 / 删除说话人 |
| POST | `/api/interviews/<id>/segments` | 添加发言区间 `{speaker_id, start_seconds, end_seconds}` |
| PUT / DELETE | `/api/segments/<id>` | 修改 / 删除发言区间 |
| POST | `/api/speakers/<id>/licenses` | 添加授权 `{start_seconds, end_seconds, allow_media, deny_media, embargo_until, note}` |
| PUT / DELETE | `/api/licenses/<id>` | 修改 / 删除授权 |
| POST | `/api/interviews/<id>/evaluate` | 校验 `{publication_date, medium}`，返回合并后的时间码区间与原因 |
| POST | `/api/interviews/<id>/supplement` | 补件并复核 `{publication_date, medium, supplements, commit}`，见下文示例 |

### 补件并复核调用示例

`supplements` 中每条补件：`{speaker_id, start_seconds, end_seconds, allow_media, deny_media, embargo_until, note}`，
时间区间为半开区间 `[start_seconds, end_seconds)`。

```bash
# 1) 试算（commit 缺省为 false，永不写入）
curl -X POST http://localhost:8000/api/interviews/1/supplement \
  -H 'Content-Type: application/json' \
  -d '{
    "publication_date": "2026-10-04",
    "medium": "audio",
    "supplements": [
      {"speaker_id": 2, "start_seconds": 300, "end_seconds": 600,
       "allow_media": ["audio"], "deny_media": [],
       "embargo_until": null, "note": "补授权"}
    ]
  }'
```

响应（200）：`publishable` 表示合并补件后整条时间轴是否全部可发布；
`changed_intervals` 列出变更后的区间；`blocked_intervals` 给出每个阻断区间及原因；
`before` / `after` 为合并补件前后的两次完整校验结果。

```json
{
  "publishable": true,
  "committed": false,
  "created_licenses": [],
  "changed_intervals": [
    {"start_seconds": 300, "end_seconds": 600,
     "start_timecode": "00:05:00", "end_timecode": "00:10:00",
     "before_status": "blocked", "after_status": "ok",
     "before_status_label": "不可发布", "after_status_label": "可发布"}
  ],
  "blocked_intervals": []
}
```

```bash
# 2) 提交（commit=true）：全部可发布才整批写入，否则不落任何记录
curl -X POST http://localhost:8000/api/interviews/1/supplement \
  -H 'Content-Type: application/json' \
  -d '{
    "publication_date": "2026-10-04",
    "medium": "audio",
    "commit": true,
    "supplements": [
      {"speaker_id": 2, "start_seconds": 300, "end_seconds": 450,
       "allow_media": ["audio"], "deny_media": [], "embargo_until": null, "note": ""},
      {"speaker_id": 2, "start_seconds": 450, "end_seconds": 600,
       "allow_media": ["audio", "text"], "deny_media": [],
       "embargo_until": "2026-10-01", "note": "已解禁"}
    ]
  }'
```

- 成功（200）：`"committed": true`，`created_licenses` 为写入的授权记录（含新 id）。
- 仍有阻断（200）：`"committed": false`，`blocked_intervals` 含每个阻断区间的时间码与原因，未落任何记录。
- 批次非法（400）：补件重叠 / 互相冲突 / 越界等，`problems` 逐条列出原因，未落任何记录。

## 运行测试

```bash
python -m unittest test_evaluator.py -v   # 核心校验逻辑（纯 Python）
python -m unittest test_supplement.py -v  # 补件并复核 API（Flask 测试客户端 + 临时 SQLite）
node test_frontend.js                     # 前端交互冒烟测试（可选，需 Node）
```

## 项目结构

```
app.py               Flask 应用与 REST API（SQLite 持久化）
evaluator.py         核心校验逻辑：切分时间轴、逐段判定、相邻合并
supplement.py        补件并复核：批次校验、授权合并、前后结果对比
test_evaluator.py    核心逻辑单元测试
test_supplement.py   补件并复核端到端测试
templates/index.html 单页界面
static/app.js        前端交互（原生 JavaScript）
static/style.css     样式
Dockerfile           一体化镜像（gunicorn 运行）
docker-compose.yml   单命令启动
```
