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

## 运行测试

```bash
python -m unittest test_evaluator.py -v   # 核心校验逻辑（纯 Python）
node test_frontend.js                     # 前端交互冒烟测试（可选，需 Node）
```

## 项目结构

```
app.py               Flask 应用与 REST API（SQLite 持久化）
evaluator.py         核心校验逻辑：切分时间轴、逐段判定、相邻合并
test_evaluator.py    核心逻辑单元测试
templates/index.html 单页界面
static/app.js        前端交互（原生 JavaScript）
static/style.css     样式
Dockerfile           一体化镜像（gunicorn 运行）
docker-compose.yml   单命令启动
```
