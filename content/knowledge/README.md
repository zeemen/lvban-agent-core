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

卡在 `deleting` 的行有可能不会自己收尾——2026-10-30 第一次传 kb-haoshe 就留下一条，
软删了但没清掉，带着 4 条软删分块（其中一条正是上面那段生成的摘要）躺了一天。
它不参与检索，但对账时是个要专门解释的干扰源，所以别留着：确认它软删、分块全软删、
`embeddings` 为 0、检索命中的 `knowledge_id` 是活着那条之后，照下面第四条清掉它。

## 关键词那一行是给检索用的，不是摘抄

2026-10-30 用 60 个探针量过一轮（每个探针写明「该命中哪篇」，一半用语料自己的
说法、一半用游客的口语）：

| | hit@1 | hit@3 |
|---|---|---|
| 补词前 | 46/60 | 55/60 |
| 补词后 | **55/60** | **60/60** |

9 条变好、**0 条变差**、51 条没动。只给三篇补了词，每个词都对应一次实测失败：
`考试/考场/吃住/睡觉/带东西`（「古人考试住哪儿」「睡觉怎么睡」「能带东西进去吗」
都是 0 条）、`月亮/半个月亮`（语料写「半边月」，游客说「半个月亮」，字面零重合）、
`多大/废除/取消`（「科举制什么时候废除的」原本排第三，前两名是照壁和大成殿）。

**不要泛泛扩充。** 关键词会进索引参与打分，给 17 篇集体灌词等于往 BM25 里掺水，
很可能把本来好的那批弄坏。只补「实测打不中」的词，补完再量一遍确认没有退步。

BM25 是字面匹配，语料里没有的词就搜不到。2026-10-30 实测：问「科举制什么时候
**废除**的」，kb-gongyuan-scale 只排第三（0.943），前两名是照壁泮池和大成殿——
因为来源原文写的是「下诏**停止**科举」，全篇没有「废除」二字。

`关键词` 这一行是我们自己写的元数据，不是引文，可以也应该补上游客真会用的说法
（废除、停科举、关门、取消）。补词不需要来源背书，补事实才需要。

顺带一提，这个库只有十几篇，BM25 分数几乎不分高下（上例前三名 0.969／0.951／
0.943），别指望靠排序把不相关的挡在外面——`maxPassages=3` 的窗口里混进两条无关
片段是常态，真正兜住的是 prompt 的证据纪律和 must_cite 回查。

## 摘要太薄，模型会自己把成因补上

2026-10-30 实测，问「为什么说只能看到半个月亮？」，**连问三次三次都在编**：说月亮被
桥影切成两半、被桥身一劈两半、桥正好压在水上倒影的分界线上——而且三次都把编出来的
成因说成是「南京市地方志里写的」。回原页逐词核过：来源通篇没有「子午线」「月亮」
「桥身」「倒影」「文德分月」，只有一句「相传有『文德桥上半边月』奇景」。

两条教训：

1. **补关键词会把「检索不到」变成「检索得到于是编」。** 补词前这个问法根本捞不到
   kb-wende，答的是「不确定」；补词后捞到了，于是模型拿着一个点了名字却不解释的
   摘要去回答「为什么」，空缺就自己填上了。检索变强，真实性可能反而退步——**补完词
   必须按新问法再测一轮，不能只看命中率**。
2. **must_cite 回查拦不住这一类。** 规格 03 §5.1 的六类里，正则只框得住年代／尺寸／
   出土地点；「历史事件」「学术解释」框不住。这次编的是成因，一个数字都没有，
   校验器全程 `degraded=false`、零违规。

修法是内容不是代码，跟 kb-gongyuan-scale 那条「同一来源内部说法不一，本条不作判断」
一个路子——实测证明写进适用边界的话，模型会原样转述给用户：

- 把来源**真正说了什么**写足。原来只有一句「相传有此奇景」，现在两处史料引文
  （《南京古代道路史》的桥史、《金陵野史》的得名与方位）加三条相传之说全列上。
  模型手里有东西，就不必自己造。
- 把**来源没有什么**明写出来（「通篇不提月亮如何被分开，不提桥身或水中倒影，不提
  日期与方位，也没有光学或天文上的解释」），并写明被问到成因时只能说不确定、引向
  现场说明牌，不得挂到来源名下。

改完 reparse（3 → 4 块），同一问法连问四次全部答对、全部引向说明牌；原先就答对的
问法「文德桥半边月是怎么回事」复测两次仍对，没被弄坏。七次应答落库的
`evidence_refs` 全是 `degraded=false`、零违规、k3 三段全来自 kb-wende。

**通用规则：摘要里点了名字的现象，要么把来源的解释一起写上，要么明写来源没有解释。**
只留一个名字，等于邀请模型去补。

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

一次改多篇时，第 2–3 步照着 `file_hash` 批量对账最省事：它就是文件的 md5，
`md5 -q <文件>` 和库里一比就知道哪几篇还没传。全部传完后四条都要为真：

```sql
-- 一、17 篇的 file_hash 与仓库 md5 全一致
-- 二、活跃分块里没有旧内容
SELECT count(*) FROM chunks WHERE deleted_at IS NULL AND content ~ '旧的那串';
-- 三、summary 分块仍是 0
SELECT chunk_type, count(*) FROM chunks WHERE deleted_at IS NULL GROUP BY 1;
-- 四、没有软删的知识行，也没有孤儿分块
SELECT count(*) FROM knowledges WHERE deleted_at IS NOT NULL;
SELECT count(*) FROM chunks c
 WHERE NOT EXISTS (SELECT 1 FROM knowledges k WHERE k.id = c.knowledge_id);
```

**`deleted_at IS NULL` 这个条件别漏。** reparse 是软删旧分块再写新的，不加这个
条件会看到旧分块还在、`summary` 还有一条，像是回传失败了——2026-10-31 回传
14 篇时我就是这么误判了一轮。那条 summary 属于一条 `parse_status=deleting`
的 kb-haoshe 残留行，早就软删了，不是新生成的。

那行已于 2026-10-31 硬删（1 条知识行 + 4 条软删分块 + 7 条
`knowledge_processing_spans`，落地目录当时已空）。所以第四条从现在起应当恒为 0 ——
与其每次对账都要想起「那条不算」，不如让「有软删行」本身就是异常。

## 当前状态，别当成已审校的内容

- **17 篇的双签审校一篇都没过**（规格 04 M1 的门槛）：14 篇是迁移那批的
  「迁移待复核」，后补的 3 篇（kb-haoshe、kb-gongyuan-scale、kb-cuojinyin-hu）
  写的是「新建待审校」。两种措辞不同，状态一样——都没人签。
- **3 篇缺原文定位**：kb-bamboo、kb-gongyuan、kb-mingyuan 写的是
  「待补充原文定位」。它们是 10-25 那批；10-27 那批 11 篇都精确到段或印刷页码。
- **2 篇来源打不开、无法复核**：kb-wuyi（njqh.gov.cn 证书不被信任）、
  kb-history-hall / kb-republic-hall（南博 SPA，curl 只拿到空壳）。
- **`关联锚点` 已按规格 04 §4 对上正式 id**（2026-10-31）。原先 14 篇写的
  `fuzimiao-3`、`museum-1` 不是随手编的，是**规格 04 §4.2／§4.4 锚点表的行号**——
  但行号只存在于语料里，应答路径按它取不到锚点，面板上这一篇却看着是填好了的。
  现在改成规格点名的 id，还没点名的写「未记录」：

  | 语料 | 原编号 | 现在 |
  |---|---|---|
  | kb-wenshu | fuzimiao-1 | `fzm_tianxia_wenshu`（关键词与摘要都是「天下文枢」坊） |
  | kb-dacheng | fuzimiao-2 | `fzm_dacheng_dian` |
  | kb-gongyuan | fuzimiao-3、4 | `fzm_jiangnan_gongyuan`、`fzm_mingyuan_lou` |
  | kb-mingyuan | fuzimiao-4 | `fzm_mingyuan_lou` |
  | kb-wende | fuzimiao-5 | `fzm_wende_qiao` |
  | kb-wuyi | fuzimiao-6 | `fzm_wuyi_xiang` |
  | kb-bamboo | museum-1 | `njm_zhulin_qixian` |
  | kb-jade-context | museum-3 | `njm_yuyi`（该锚点规格里标**待核定**，金缕／银缕须查藏品库） |
  | kb-panchi | fuzimiao-7、8、9 | 未记录 —— 夫子庙第 7–12 号规格里是「待定」 |
  | kb-taoye | fuzimiao-11 | 未记录 —— 同上 |
  | kb-history-hall | museum-4 | 未记录 —— 南博第 4–18 号规格里是「待定」 |
  | kb-republic-hall | museum-15 | 未记录 —— 同上 |
  | kb-intangible-hall | museum-16 | 未记录 —— 同上 |
  | kb-digital-hall | museum-17 | 未记录 —— 同上 |

  四篇展馆概述（历史馆／民国馆／非遗／数字馆）严格说不该挂 Top30 锚点，它们讲的是
  展馆而不是展品；规格 02 §4.2 的 `zone_hint` 用的是 `njm_history_hall` 这种展区 id，
  那是另一套。等展区 id 有正式清单了再挂，现在写展区 id 只是把一个指不到的引用
  换成另一个。

- **占位从此拦得住。** `lint:content` 现在也查语料：关联锚点不是 `njm_`/`fzm_` 格式
  报**错误**（写错了，改语料），格式对但锚点文件还没建报**警告**（M1 进度，补锚点）。
  后者现在正好是「有语料在等锚点」的清单，5 条：`fzm_tianxia_wenshu`、
  `fzm_dacheng_dian`、`fzm_wende_qiao`、`fzm_wuyi_xiang`、`njm_yuyi`。
  `njm_zhulin_qixian` 与 `fzm_mingyuan_lou` 已于 2026-10-31 建起草稿锚点
  （kb-bamboo、kb-mingyuan 两篇因此不再报警告），但都是 `draft`、分别待核 8 条
  与 9 条，双签审校都没做。

  **`fzm_jiangnan_gongyuan` 本来就不该在这张清单上。** 它是号舍锚点
  （`fzm_jiangnan_gongyuan_haoshe`）的 `poiId`，应答路径的 `anchorForPlace`
  比的就是 `poiId`／`exhibitId`，所以 kb-gongyuan 写它一直取得到锚点。
  是门禁只拿 `anchorId` 当词表，把一个好的写法判成了「锚点还没建」。
  2026-10-31 改成两套 id 都认（`src/content/lint.ts` 的 `knownAnchorIds`），
  维护面板同口径。让内容负责人去补一个已经有的东西，比漏报更费时间。
  面板上对应「关联锚点是占位编号」和「锚点还没建」两个标签。

  只把这一栏搬进门禁，是因为它会**静默**地少讲：取不到锚点，K1 和八要素就到不了
  用户，而面板和文件本身都看不出异常。缺原文定位、待双签这些是待办清单，面板上看
  就够了，搬进门禁只会让十几条警告盖住真正该拦的那一条。
- **场景词已统一成 `nanjing_museum`**（2026-10-31）。原先 6 篇写 `场景：museum`，
  和锚点的 `sceneId` 以及它们自己所在的目录名都对不上。

  这个字段**不进应答路径**：检索的 sceneId 来自锚点（`retrievePassages` 收的是
  `anchor?.sceneId`），拍照识别的候选过滤比的也是锚点的 sceneId
  （`routes.ts` 里 `a.sceneId === zoneHint`）。所以漂移期间没有谁少听过一句话——
  它只是个指向不存在场景的标签。但等到哪天真有代码按它选库，错就从「标签不准」
  变成「这一篇整个检索不到」，而那时候没人会想到来查一个六个月前就写错的词。

  `lint:content` 现在把它当**错误**拦：场景词必须在锚点用的词表里。
  锚点一个都没加载出来时这条检查会跳过——拿空词表比会把每一篇都判成错，
  17 条里没有一条是真的，只会盖住别的问题。

逐条核查的结论见 [../kb-source-audit-2026-10-29.md](../kb-source-audit-2026-10-29.md)。
