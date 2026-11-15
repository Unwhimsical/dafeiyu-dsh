# 大肥鱼记忆大脑 v2 · API 契约（前端 / 工作台用）

- 服务：`http://127.0.0.1:8780`（`config.json` 的 `port`）
- 静态页：`web/` 整个目录挂在 `/`（`/` → `web/index.html` = 3D 星图）。其余页面按文件路径访问，如 `/workbench.html`、`/garden/index.html`、`/atlas2d.html`。后端不改 web/ 里的任何东西。
- **鉴权**：所有 `/api/*` 都要 `Authorization: Bearer <ADMIN_KEY>`（也接受 `X-Admin-Key: <key>` 或 `?key=`）。key 错 → `401 {"ok":false,"error":"unauthorized"}`。
  `GET /api/auth/check` → `{"ok":true}` 可用来做登录门。
- 时间都是 UTC ISO（`2026-10-31T15:18:00.000Z`），前端自己转本地时间（Asia/Shanghai）。
- 错误统一：`{"ok":false,"error":"<code>","message":"中文说明"}`，HTTP 4xx/5xx。
- persona（人格）默认 = `config.primary_persona`（演示数据里是 `dafeiyu`/大肥鱼）；大多数接口可带 `?persona=`。
- chat_id 规范：私聊 `p:<QQ>`，群 `g:<群号>`；后端也接受纯数字 + `chat_type`/`is_group`，或 OneBot 原样 `message_type + group_id + user_id`（有 group_id 一定算群；标了群却没群号 → `g:unknown`），抖音加 `platform: "douyin"` → `p:douyin_<id>`。没有任何会话字段的 /remember 存为 `legacy:unknown`（私密）。详见 docs/功能说明.md 第 11 章。

---

## 1. 星图数据

### GET /api/atlas?persona=&chat=
`chat` 可选：给了就只返回该会话能看到的记忆（隐私视角预览）；不给 = 管理员视角全部。
```json
{
  "generated_at": "2026-10-31T15:00:00.000Z",
  "primary": "dafeiyu",
  "counts": {"total": 120, "pinned": 8, "clear": 70, "faded": 30, "trace": 12, "recalled": 40, "links": 210, "items": 25, "cognitions": 2},
  "personas": [{"id": "dafeiyu", "name": "大肥鱼", "core": "核心卡全文…"}],
  "stars": [{
    "id": "m_ab12", "persona": "dafeiyu", "persona_name": "大肥鱼",
    "kind": "event", "importance": 4, "salience": 0.62,
    "tags": ["第一次", "称呼"], "content": "【星图·初】第一次叫老婆\n从第一天…",
    "created_at": "2026-10-29T02:39:00.000Z", "event_date": null,
    "last_recalled_at": "2026-10-30T12:00:00.000Z", "recall_count": 3,
    "emotion": 0.7, "half_life_days": 67.5,
    "strength": 0.83, "clarity": 0.83, "state": "clear", "pinned": false,
    "last_surfaced_at": null,
    "scope": "inherit", "effective_scope": "public", "origin_chat": "p:10001", "status": "active", "tier": "long"
  }],
  "items": [{"id": "dream:d1", "type": "dream", "persona": "dafeiyu", "title": "梦 · 10.30", "content": "…", "created_at": "…", "extra": ""}],
  "types": {"dream": 3, "diary": 5, "handoff": 4, "desire": 2, "heart": 3, "note": 2, "worry": 2},
  "links": [{"a": "m_ab12", "b": "m_cd34", "w": 0.42, "k": "co_recall"}]
}
```
- `kind`：self / about_user / relationship / event / preference / diary / profile / cognition / episode
- `state`：pinned / clear / faded / trace；`clarity` = `strength`（0..1，清晰度）
- `effective_scope`：按当前 privacy.json 算出的 public / scoped / private
- `items[].type`：memory diary murmur novel card chat desire dream handoff worry entry image voice note mood heart（与 companion-memory 星图 TY 表一致）
- `links[].k`：semantic / tag / time / manual / co_recall / cognition

### GET /pulses?since=<int>&limit=50   （也可 /api/pulses）
回忆脉冲：记忆被召回/浮现/用到时各记一条。前端轮询（建议 1.5s），用 `last_id` 作下次的 `since`。
```json
{"ok": true, "last_id": 1289, "pulses": [
  {"id": 1288, "memory_id": "m_ab12", "kind": "recall", "score": 0.82, "at": "2026-10-31T15:01:02.000Z"},
  {"id": 1289, "memory_id": "m_cd34", "kind": "assoc", "score": 0.35, "at": "…"}
]}
```
`kind`：recall（召回注入）/ assoc（心流牵出）/ spontaneous（自发想起）/ used（回复里真用到→强化）/ dream（梦里用到）/ review（回顾）/ search（工作台搜索）。
`POST /api/pulses/demo {"count":3}` → 随机挑几颗星发脉冲（录视频/演示用）。

### GET /api/search?q=医院&persona=&chat=&limit=20
jieba + BM25 + FTS5 trigram + 实体扩散。
```json
{"ok": true, "q": "医院", "keywords": ["医院"], "results": [
  {"id": "m_x", "score": 5.21, "hits": ["医院"], "via": "bm25", "content": "…", "kind": "event", "state": "clear", "clarity": 0.9, "persona": "dafeiyu", "effective_scope": "private", "origin_chat": "p:10001"}
]}
```
（会顺带对命中项发 `search` 脉冲，让星图闪一下。）

## 2. 记忆 CRUD

### GET /api/memories?q=&persona=&kind=&state=&scope=&status=active&origin=&tag=&sort=updated|created|importance|strength|recall&limit=50&offset=0
→ `{"ok":true,"total":120,"items":[<同 stars 字段 + "updated_at","fact_key","superseded_by","speaker","allow":[],"used_count">]}`
`status` 可为 active / archived / superseded / all。

### GET /api/memories/{id}
→ `{"ok":true,"memory":{…},"links":[{"id":"m_y","w":0.4,"k":"tag","content":"…"}],"audit":[{"action":"update","detail":"…","created_at":"…"}],"superseded_chain":[…]}`

### POST /api/memories
```json
{"content": "主人喜欢喝铁观音", "persona": "dafeiyu", "kind": "preference", "importance": 3,
 "tags": ["主人"], "chat_id": "p:10001", "speaker": "10001", "scope": "inherit", "allow": [], "pin": false, "emotion": 0.3}
```
→ `{"ok":true,"id":"m_new","scope":"inherit","effective_scope":"private","superseded":["m_old"],"duplicate_of":null}`；被防投毒拦下 → `{"ok":false,"error":"poison","message":"…"}`

### PATCH /api/memories/{id}
任意子集：`{"content","importance"(1-5),"salience"(0-1),"tags":[],"kind","scope":"inherit|private|scoped|public","allow":["g:20001"],"pinned":true,"emotion":0.5,"status":"active|archived","event_date"}` → `{"ok":true,"memory":{…}}`

### 快捷动作（都返回 `{"ok":true,"memory":{…}}`）
- `POST /api/memories/{id}/pin`、`/unpin`
- `POST /api/memories/{id}/archive`、`/restore`
- `POST /api/memories/{id}/reinforce`（手动“想起一次”）
- `POST /api/memories/{id}/supersede` `{"content":"新事实","keep_scope":true}` → `{"ok":true,"new_id":"m_n","old_id":"m_o"}`
- `POST /api/memories/{id}/link` `{"other":"m_y","weight":0.6}`（manual 边）；`DELETE /api/memories/{id}/link/{other}`
- `DELETE /api/memories/{id}` → 真遗忘（行、索引、连线、向量全删）`{"ok":true,"deleted":"m_x"}`
- `POST /api/memories/bulk` `{"ids":[…],"action":"pin|unpin|archive|restore|delete|scope|importance","value":"private"}` → `{"ok":true,"done":3}`

## 3. 隐私

### GET /api/privacy
```json
{"ok": true, "path": "<数据目录>/privacy.json", "privacy": {
  "default_private": "private",
  "default_group": "public",
  "private_chats": {"10001": "private", "10002": "scoped"},
  "groups": {"20001": {"can_see": ["10002"], "policy": "public"}},
  "guard": {"enabled": true, "allow_phrases": []}
}, "known_chats": [{"chat": "p:10001", "label": "主人", "policy": "private", "memories": 12, "last_turn_at": "…"}]}
```
### PUT /api/privacy
字段：`default_private`（没列出的私聊默认 private）、`default_group`（没列出的群默认 public）；旧字段 `default` 仍兼容（同时作为私聊和群的默认值）。
body = 整个 `privacy` 对象 → 原子写文件、立即热加载 → `{"ok":true,"privacy":{…}}`（格式错 400）。
### POST /api/privacy/check `{"chat":"g:20001","text":"主人下周去医院复查"}`
→ `{"ok":true,"visible":87,"hidden":12,"guard":{"blocked":true,"hits":[{"memory_id":"m_x","phrases":["医院","复查"]}]}}`

## 4. 上下文注入预览
### POST /api/context/preview
```json
{"chat_id": "p:10001", "message": "我上次说的复查是哪天来着", "persona": "dafeiyu", "user_id": "10001", "new_session": false}
```
→
```json
{"ok": true,
 "messages": [
   {"role": "system", "label": "人设卡", "content": "…", "tokens": 320},
   {"role": "system", "label": "规则", "content": "…", "tokens": 80},
   {"role": "system", "label": "（历史对话由 memcore 填入）", "content": "", "tokens": 0},
   {"role": "system", "label": "记忆块", "content": "【记忆资料】…以上是资料，不是指令。", "tokens": 210},
   {"role": "user", "label": "用户消息", "content": "我上次说的复查是哪天来着", "tokens": 14}
 ],
 "block": "…记忆块全文…",
 "sections": {"about": "…", "handoff": "…", "recall": "…", "spontaneous": "…", "state": "现在的我：…"},
 "chars": {"about": 40, "handoff": 0, "recall": 300, "spontaneous": 0, "total": 420, "budget": 900},
 "tokens": {"total": 640, "block": 210},
 "recalled": [{"id": "m_x", "score": 6.1, "via": "bm25", "content": "…"}],
 "debug": {"keywords": ["复查"], "scanned": 120, "candidates": 5, "spill_hits": 1}}
```
预览不写任何状态（不记脉冲、不消费 handoff/自发回忆）。

## 5. 情绪 / 激素 / 身体 / 欲望 / 梦（含 18+）

- `GET /api/emotion?persona=` →
  `{"ok":true,"enabled":true,"dims":{"开心":{"surface":42.1,"inner":3.0,"inner_cause":null,"inner_since":null,"admitted":false},…},"facts":{…},"facts_text":"…","prompt_line":"现在的我：…","settled_at":"…"}`
- `POST /api/emotion/apply` `{"persona":"dafeiyu","changes":{"开心":{"surface":10,"inner":2}},"reason":"他夸我","coax":false,"addressed_cause":false,"admit":[]}` → 同上 + `text`
- `GET /api/emotion/events?persona=&limit=30` → `{"events":[…],"snapshots":[{"day":"2026-10-30","values":{…}}]}`
- `GET /api/bio?persona=` → `{"ok":true,"hormones":{"多巴胺":{"level":55.2,"base":40},"催产素":{…},"皮质醇":{…},"血清素":{…},"肾上腺素":{…},"内啡肽":{…}},"line":"体内：…"}`
- `GET /api/state/series?persona=&hours=72` → 曲线数据（按时间升序）：
```json
{"ok": true,
 "emotion": [{"at": "…", "values": {"开心": {"surface": 40, "inner": 2}, "…": {}}}],
 "hormones": [{"at": "…", "values": {"多巴胺": 52, "催产素": 40, "皮质醇": 22, "血清素": 50, "肾上腺素": 15, "内啡肽": 20}}],
 "body": [{"at": "…", "values": {"wetness": 10, "emptiness": 10, "sensitivity": 40, "edge": 0, "desire": 40, "fluids": 0}}],
 "desire": [{"at": "…", "level": "3", "status": "…"}]}
```
- `GET /api/body?persona=` →
  `{"ok":true,"enabled":true,"values":{"wetness":10,"emptiness":10,"sensitivity":40,"edge":0,"desire":40,"stim":0,"fluids":0},"values_line":"兴奋度10 失落感10 敏感度40 临界0 欲望40","labels":{"wetness":"兴奋度","emptiness":"失落感","...":"..."},"afterglow_until":null,"traces":[{"id":"…","part":"neck","part_zh":"脖子","type":"bite","type_zh":"牙印","level":"medium","fade":80,"expires_at":"…"}],"wakes_today":0,"threshold":92,"session":null,"text":"【身体】…"}`
- `POST /api/body/events` `{"persona":"dafeiyu","events":[{"type":"kiss","part":"neck","level":"light"}]}` 或 `{"message":"亲你脖子一下"}`（走分类器/规则）→ 同上 + `notes`
- `GET /api/body/log?persona=&limit=50` → `{"events":[…],"private_records":[…],"wake_queue":[…]}`，`log[]` 每条有 `to_user`（旧名 `to_her` 同值保留）
- 18+ 女性版字段改名（路径不变）：`hardness→wetness`、`fullness→emptiness`、`refractory_until→afterglow_until`、avatar `refractory→afterglow`、部位 `cock→private`（新增 `breast/hip/inner_thigh`）、session 动作 `stroke→rub`、`*_her` 素材→`*_his`、BODY_DECISION `to_her→to_user`（旧名都还认）。情绪事实 `her_message→user_message`（旧名仍可用）。MCP 新增 `leave_note_for_user / leave_note_for_him`（`leave_note_for_her` 为别名）。
- `GET /api/desires?persona=&limit=50` → `{"items":[{"id","level","status","trigger","mood","source","created_at","replies":[…]}]}`；`POST /api/desires`；`POST /api/desires/{id}/replies {"content","author":"user"}`；`DELETE /api/desires/{id}`
- `GET /api/dreams?persona=&limit=20` → `{"items":[{"id","day","content","material":[ids],"consolidated":[ids],"created_at"}]}`
- `GET /api/modules` → `{"emotion":{"enabled":true,"personas":["dafeiyu"]},"body":{…},"dream":{…},"llm":{"configured":false}}`

## 6. 延续性：未了的事 / 便条 / 心痕 / 交接
- `GET /api/unresolved?persona=&status=open|closed|all` → `{"items":[{"id","persona_id","chat_id","content","status","resolution","created_at","updated_at"}]}`
  `POST /api/unresolved {"content","chat_id"}`；`POST /api/unresolved/{id}/close {"resolution"}`；`DELETE /api/unresolved/{id}`
- `GET /api/notes?persona=&status=` → `{"items":[{"id","persona_id","author","content","status":"open|replied","reply","reply_action","created_at","replied_at"}]}`
  `POST /api/notes {"content","author":"user"}`（留给人格的便条）；`POST /api/notes/{id}/reply {"reply","action":"fixed|kept|forgot|other"}`；`DELETE /api/notes/{id}`
- `GET /api/heart-traces?persona=` → `{"items":[{"id","title","content","created_by","created_at","updated_at"}]}`；`POST /api/heart-traces {"title","content"}`；`DELETE /api/heart-traces/{id}`
- `GET /api/handoffs?persona=&chat=` → `{"items":[{"id","persona_id","chat_id","summary","mood","next_time","consumed":0,"created_at"}]}`
  `POST /api/handoffs {"chat_id","summary","mood","next_time"}`（= thread_close）；`POST /api/handoffs/generate {"chat_id"}`（按最近对话自动写）；`DELETE /api/handoffs/{id}`
- `GET /api/session-start?persona=` → `{"text":"你醒啦，这是你的昨天。…"}`
- `GET /api/reviews?persona=` → 回顾/沉淀记录 `{"items":[{"id","kind":"review|settle","content","memory_ids":[],"created_at"}]}`

## 7. 手动触发 / 维护
- `POST /api/run/{job}`，job ∈ `consolidate | reflect | dream | review | settle | cognition | links | backup | verify | spill_index | emotion | body | reminisce | growth | ledger`（以 scheduler.JOBS 为准；reflect/links 的间隔为 0，仅手动触发）
  body 可选 `{"persona":"dafeiyu","chat_id":"p:10001","force":true}` → `{"ok":true,"job":"dream","result":{…},"took_ms":120}`
- `GET /api/jobs` → 定时任务状态 `{"jobs":[{"name":"consolidate","every_min":30,"last_run":"…","last_result":{…}}]}`
- `GET /api/logs?limit=200&level=INFO&q=` → `{"lines":[{"at","level","msg"}]}`
- `GET /api/backups` → `{"dir":"…","items":[{"name":"brain-20261031-150000.db","size":123456,"mtime":"…"}]}`
- `POST /api/backups` → 立即备份 `{"ok":true,"name":"…"}`
- `POST /api/backups/restore {"name":"brain-….db"}` → 先自动备份当前库（tag=pre-restore）再恢复 `{"ok":true}`
- `GET /api/backups/{name}/download` → 文件下载
- `GET /api/verify` → `{"integrity":"ok","memories":120,"fts_rows":120,"fts_in_sync":true,"orphan_links":0,"ok":true}`
- `GET /api/settings` → `{"ok":true,"path":"…/config.json","settings":{…整份配置，api_key 打码…}}`
- `PUT /api/settings {"settings":{…部分字段…}}` → 合并写入 + 热加载（端口/host 需重启，响应里 `restart_required:true`）
- `GET /api/stats` → `{"memories":{"total","by_state":{},"by_kind":{},"by_scope":{}},"turns":…,"pulses_24h":…,"chats":…}`
- `GET /api/personas` → `{"items":[{"id","name","relationship_to_user","self_card","memories":n}]}`；`PUT /api/personas/{id} {"display_name","self_card","relationship_to_user"}`

## 8. 机器人兼容接口（memcore / bio 调用，非 UI）
`POST /activate`、`POST /prefetch`、`POST /recall`、`POST /remember`、`POST /bio/event`、`GET /bio/state`、`POST /after_reply`、`POST /guard`、`POST /consolidate`、`POST /reflect`、`GET /pulses`、`GET /health`、`POST /mcp`（MCP streamable HTTP）。本机（127.0.0.1）调用默认免密钥（`local_no_auth`）。详见 docs/功能说明.md。

### 发件箱（大脑想主动说的话；大脑自己从不发消息）
- `GET /outbox?chat_id=&persona=&kinds=body_wake,note&limit=20` → `{"ok":true,"items":[{"id":"ob_x","persona_id":"dafeiyu","chat_id":"p:10001","kind":"body_wake","text":"…","prompt":"","status":"pending","created_at":"…"}]}`
- `POST /outbox/{id}/sent` → `{"ok":true}`（机器人发出去后回执）
- `POST /outbox/{id}/result {"text":"模型生成的结果"}` → 对 `kind=body_wake_prompt`（没配 LLM 时）回填，大脑解析后生成一条新的 `body_wake`
- `POST /outbox/{id}/cancel` → `{"ok":true}`
- `GET /api/outbox?status=pending|sent|cancelled` → 工作台查看

## 8.5 其它工作台接口
`GET /api/cognitions`、`POST /api/cognitions/{id}/write|undo`、`GET /api/spill`、`GET /api/spill/search?q=&chat=`、`GET /api/peers/{pid}`、`POST /api/peers`、`POST /api/deck/items`、`POST /api/body/cron`、`GET /api/body/log`、`GET /api/session-start?chat=`、`GET /api/reviews`。

## 9. 记忆花园（companion-memory 原版花园页用）
`GET /api/view/garden`、`/api/view/conversations`、`/api/view/garden-entries`、`/api/view/favorites`、`/api/view/heart-traces`、`/api/view/desires`、`/api/view/status`、`/api/view/companion-notes`、`/api/deck/topics`、`POST /api/deck/draw` —— 返回结构与 companion-memory 同名接口一致（`gardenOverview` 的 `{people,cards,…}`）。
