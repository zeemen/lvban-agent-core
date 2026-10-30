# K3 语料源文件

规格 03 §5 证据链第三级的长尾资料。自由问答走 BM25 检索这些内容，
命中的片段进 prompt 当证据（见 `src/knowledge/weknora.ts`）。

## 这些文件是什么

**它们是源，WeKnora 是副本。** 以前反过来：这 14 篇只存在于 WeKnora 的
Docker 卷里（`/data/files/10000/<knowledge_id>/<时间戳>.md`），没有 diff
可看，没有改动记录，改一个标题要先把文件从容器里挖出来。2026-10-30
按字节原样搬进仓库，逐篇用 md5 对过 `knowledges.file_hash`，14 篇全部一致。

**改内容请改这里，再回传。** 直接在 WeKnora 界面里改，仓库这边就会变成过期副本。

## 文件与库的对应

目录名用的是锚点的 `sceneId`（`content/anchors/*.json`），也是 `.env` 里
`WEKNORA_KB_IDS` 的键名——那是代码实际认的场景词表。

| 场景目录 | WeKnora 知识库 | 知识库 ID |
|---|---|---|
| `fuzimiao/` | AI旅伴·夫子庙·草稿 | `08ef3c0e-bdcc-4951-8485-83e9367bc990` |
| `nanjing_museum/` | AI旅伴·南京博物院·草稿 | `2755f648-f2a8-419b-8dc5-b27462997b63` |

各篇的 `knowledge_id`（回传时要用）：

| 文件 | knowledge_id |
|---|---|
| fuzimiao/kb-dacheng.md | `f8543cd0-ec46-4ca5-ad9f-fdb4929d23de` |
| fuzimiao/kb-gongyuan.md | `8cf5487a-1db2-4d0c-ae13-2c6ef8fc5193` |
| fuzimiao/kb-gongyuan-scale.md | `a12ea6d2-bbee-4b2c-a049-b7d1e17d9dfe` |
| fuzimiao/kb-haoshe.md | `84f2ce6a-4135-40e3-91de-a62e6778fb05` |
| fuzimiao/kb-mingyuan.md | `6d8aba91-806f-4218-8850-c896712a6408` |
| fuzimiao/kb-panchi.md | `15868f44-ad98-4c3c-aa81-e9485db0615d` |
| fuzimiao/kb-taoye.md | `5f408b44-6304-4125-96e9-5e54d0a9d1a5` |
| fuzimiao/kb-wende.md | `e18afe4f-7d06-4258-ba9f-8b2bbd813cf1` |
| fuzimiao/kb-wenshu.md | `3acc9297-3a44-427b-a564-155f259e422b` |
| fuzimiao/kb-wuyi.md | `5c61c654-4351-4b3d-a755-d6bbaf434f9b` |
| nanjing_museum/kb-bamboo.md | `00ddcf50-6f32-4f45-8c33-c1151eceb1bb` |
| nanjing_museum/kb-cuojinyin-hu.md | `228e8ee0-6ba3-4fbe-be59-63f55aefb01d` |
| nanjing_museum/kb-digital-hall.md | `7b0873b3-1bf5-43b4-8bad-b9d5aeb77d59` |
| nanjing_museum/kb-history-hall.md | `2603fdfc-4722-4fb1-afae-e1d42058ba5e` |
| nanjing_museum/kb-intangible-hall.md | `84581577-094e-4b5f-98ce-deffd374306b` |
| nanjing_museum/kb-jade-context.md | `f5c5642a-021f-4cd9-8813-a319dc3b56e1` |
| nanjing_museum/kb-republic-hall.md | `e5ff5c0a-415d-43f3-aad5-80ce6366b003` |

## 新增一篇时，必须关掉摘要生成

`summary_enabled` 在 WeKnora 里**省略即为 true**。走 API 上传而不带 process_config，
它会用 LLM 写一段摘要，并把这段摘要当成一个可检索的 chunk 存进库。

这会直接击穿证据链：规格 03 §5.1 要求 must_cite 字段不能自由生成，而那段摘要就是
模型写的，却会以「资料」的身份被检索出来喂进 prompt。2026-10-30 第一次传 kb-haoshe
时踩到了，生成的摘要还把事实写反了——原文是「夜晚取出**上层**并入下层作床」，
它写成「取**下层**木板作为床铺」，而且在「号舍里的木板怎么用」这一问上排第一。

所以上传时一定要带：

```
-F 'process_config={"summary_enabled":false}'
```

界面上传默认是关的，所以先前 14 篇都没有这个问题（`summary_status` 全是 `none`）。
核对办法：`SELECT count(*) FROM chunks WHERE chunk_type='summary' AND deleted_at IS NULL`
应当为 0。

另外，删除是异步的：DELETE 之后那行会停在 `parse_status='deleting'` 一小会儿，
这期间重传会按 file_hash 命中那条将死的记录，看起来「传成功了」其实没有。
等到 `deleted_at IS NULL` 的行数归零再传。

## 关键词那一行是给检索用的，不是摘抄

BM25 是字面匹配，语料里没有的词就搜不到。2026-10-30 实测：问「科举制什么时候
**废除**的」，kb-gongyuan-scale 只排第三（0.943），前两名是照壁泮池和大成殿——
因为来源原文写的是「下诏**停止**科举」，全篇没有「废除」二字。

`关键词` 这一行是我们自己写的元数据，不是引文，可以也应该补上游客真会用的说法
（废除、停科举、关门、取消）。补词不需要来源背书，补事实才需要。

顺带一提，这个库只有十几篇，BM25 分数几乎不分高下（上例前三名 0.969／0.951／
0.943），别指望靠排序把不相关的挡在外面——`maxPassages=3` 的窗口里混进两条无关
片段是常态，真正兜住的是 prompt 的证据纪律和 must_cite 回查。

## 怎么把改动回传到 WeKnora

两条路。**界面重传**最省事：删掉旧文档、把改完的传回去。代价是
`knowledge_id` 会变，历史记录和 `evidence_refs.k3` 里记的旧 ID 就断了。

**原地 reparse** 保留 ID，是 2026-10-30 改 kb-gongyuan 用的办法：

1. 临时给 API key 加 `ingest` 能力（写内容的路由都要它；
   `tenant_api_keys.capabilities`，改完务必改回 `["retrieve"]`）
2. `docker compose cp <文件> app:/data/files/10000/<knowledge_id>/<原文件名>`
   ——文件名是时间戳，别改，`ls` 一下容器里原来叫什么
3. 同步 `knowledges` 的 `file_hash`（md5）和 `file_size`
4. `POST /api/v1/knowledge/<knowledge_id>/reparse`，带 `X-API-Key`
5. 等 `parse_status=completed` 且 `enable_status=enabled`
6. 把 key 的能力改回 `["retrieve"]`，并确认 reparse 返回 403

reparse 需要 embedding 模型在线（当前配的是本机 Ollama 的
`qwen3-embedding:0.6b`）。它只重算向量和分块，不删源文件。

## 当前状态，别当成已审校的内容

- **14 篇全是「审核状态：迁移待复核」**，规格 04 M1 要的双签审校一篇没过。
- **3 篇缺原文定位**：kb-bamboo、kb-gongyuan、kb-mingyuan 写的是
  「待补充原文定位」。它们是 10-25 那批；10-27 那批 11 篇都精确到段或印刷页码。
- **2 篇来源打不开、无法复核**：kb-wuyi（njqh.gov.cn 证书不被信任）、
  kb-history-hall / kb-republic-hall（南博 SPA，curl 只拿到空壳）。
- **`关联锚点` 这一栏目前指不到任何东西。** 14 篇写的是 `fuzimiao-3`、`museum-1` 这类编号，
  而真实 anchorId 是 `fzm_jiangnan_gongyuan_haoshe`、`njm_cuojinyin_hu`。这套编号在
  specs/、src/、content/anchors/ 里都找不到，是一套只存在于语料里的占位。纠错队列要回答
  「这条知识背的是哪个锚点」，得先把它对上。kb-haoshe 用的是真实 anchorId，故意和另外
  14 篇不一致——跟一套指不到东西的编号保持一致没有意义。
- 文档里的 `场景：museum` 和锚点的 `sceneId: nanjing_museum` 对不上。
  目前没有代码读文档里这个字段（检索按锚点的 sceneId 选库），所以不影响运行，
  但两套词表迟早要统一。这次搬运按字节原样搬，没有顺手改它。

逐条核查的结论见 [../kb-source-audit-2026-10-29.md](../kb-source-audit-2026-10-29.md)。
