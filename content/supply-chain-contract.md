# 知识库供应链中台 · 交付契约

2026-10-31 定：中台的交付面包含**语料与锚点两类物料**（下文「方案 B」）。
这份文件是两个系统之间的接口说明，写在这里是因为被约束的东西就在这个目录下。

## 为什么需要它

今天**这个仓库就是语料的源头**：`content/knowledge/**/*.md` 是正本，入库靠人工
ingest 到 WeKnora，对账第一条是「17 篇的 `file_hash` 与仓库 md5 全一致」
（见 [`knowledge/README.md`](knowledge/README.md)）。

中台一旦成为产出方，这条不变式就不成立了。`content/` 退成下游副本，
整套对账、入库、`parse_status` 收尾流程都要换一个边界重新定义。

## 一、交付范围与交付方式

中台是 **[zeemen/weknora-data-factory](https://github.com/zeemen/weknora-data-factory)**
（「知识加工台」，Python `services/api` + `apps/web`）。它产出两类物料，
**走两条不同的路**，别当成一条：

| 物料 | 交付方式 | 落到哪 |
|---|---|---|
| 语料 | 中台的 WeKnora 适配层直接导入（`services/api/app/integrations/weknora.py`），可撤销 | WeKnora 知识库，不经过这个仓库 |
| 锚点 | **git PR 进这个仓库** | `content/anchors/*.json` |

语料那条路中台已经有了：按 `POST /api/v1/knowledge-bases/{kb}/knowledge/manual`
逐篇导入，记下 WeKnora 返回的 id，支持撤回那一次导入。
**这个仓库不再参与语料的流转**——`content/knowledge/` 退成历史副本。

锚点那条路还不存在。中台当前的里程碑清单里只有「知识单元 / 关系 / 问题 /
交付」，没有锚点、八要素、三口吻、双签这些概念——所以下面第二到第四节
就是这条路要新建的部分。

第二项是关键。M1 的瓶颈从来不是语料，是 **30 个锚点 × 八要素 × 三口吻**
加上规格 03 §9.2 的双签审校。现在的进度是 4 个，全是 `draft`，
`review.factCheckRequired` 里共 22 条待核。

## 二、锚点的数据契约

**契约就是 `src/content/loader.ts` 的 `anchorSchema`。**

中台是 Python，引不了这份 zod schema——所以**不要在那边手抄一份规格当真，
PR 门禁才是执行点**：中台产 JSON，PR 一跑 `loadAnchors` 就按 schema 校验，
形状不对直接红。漂移只会表现为 PR 失败，不会表现为线上少讲。
想要本地快一点的反馈，可以从 zod 导出一份 JSON Schema 当参考件，
但那是便利，不是依据。

读 schema 时容易踩的几点：

- **两套 id namespace。** `anchorId` 是锚点自己的 id；`poiId`（室外）／
  `exhibitId`（室内）是点位 id。应答路径的 `anchorForPlace` 比的是**后者**。
  例如号舍锚点 `fzm_jiangnan_gongyuan_haoshe` 的点位 id 是
  `fzm_jiangnan_gongyuan`，语料的「关联锚点」一栏写哪个都算对。
- **三口吻的键名不是模式名。** `companion` / `child` / `light` 分别对应
  同游 / 亲子 / 轻导览。`null` 是合法值——渲染器会退到别的要素，
  不会开不了口。
- **`elements.story`、`connection.*` 可空**，`memoryLink.template`
  必填（`{place}`、`{topic}` 两个占位会被填）。
- **`nextAction.suggest` 必须指得到东西**：锚点 id 或任意锚点的点位 id。
  指不到会报 `next_action/dangling`。

## 三、出厂标准 = 应用侧门禁的那几条

`src/content/lint.ts` 的规则不是应用侧的自检，而是**验收契约**。
中台应当在导出前跑同一套；应用侧保留同一份作为进料检查——
**同口径、两处执行**。

| 规则 | 严重度 | 依据 |
|---|---|---|
| `register/*` | error | 规格 03 §8.1 口吻守卫（禁用导游腔、连续事实句上限） |
| `evidence/missing_k1` | error | 规格 03 §5.1（年代／尺寸／出土地点必须有 K1） |
| `evidence/unmarked_interpretation` | warn | 规格 03 §5.2（学术解释须带 hedge） |
| `content/placeholder` | error | 占位词不得出现在 `elements` 里 |
| `review/not_approved` | warn | 规格 03 §9.2（Top30 上线前双签） |
| `next_action/dangling` | warn | 下一站得真的存在 |
| `scene/unknown`（语料） | error | 场景词必须是已知场景 |
| `anchor/placeholder`（语料） | error | 关联锚点不得写占位 |
| `anchor/not_built`（语料） | warn | 关联锚点还没建 |

为什么强调同口径：2026-10-31 修过一个 bug——门禁只拿 `anchorId` 当词表，
把 kb-gongyuan 里一个**正确的**写法判成「锚点还没建」。
让内容负责人去补一个已经存在的东西，比漏报更费时间。
两套规则各走一边，就会出现「面板说没建、lint 说没事」，没人知道信哪个。

## 四、`approved` 是唯一能把史实送进游记的开关

> 规格 04 §7.1：**游记里出现的每一条史实，都来自已审校的锚点要素或 K1**，
> 不由生成模型自由发挥。

执行点是 `src/agent/travelogue.ts`：`review.status !== 'approved'` 的锚点
不进游记（本地预览可以用 `allowDraftAnchors` 显式放开）。

注意边界：**现场讲解不挡**。`draft` 锚点可以讲——它的文案本来就只写了
有 K1 撑得住的部分——但不进那份写下来留着的游记。`src/agent/respond.ts`
会把 `reviewStatus` 记进 `evidenceRefs` 留痕。

### 原先的洞，以及 2026-10-31 的收紧

schema 原先只校验 `status` 是枚举之一。也就是说
`{ status: 'approved', reviewedBy: [], reviewedAt: null, factCheckRequired: [...] }`
照样算「已审校」。自己手写锚点文件时这无所谓；锚点改由中台产出之后，
**这就是上游一句自我声明就能打开的闸**。

现在 `approved` 必须同时满足：

- `reviewedBy` 里**两方各有一个中台账号**（规格 03 §9.2：内容负责人 + 外部历史顾问），
  且不是同一个账号兼任——格式见下
- `reviewedAt` 是 `YYYY-MM-DD`
- `factCheckRequired` 为空

不满足就让 `loadAnchors` 抛错、**整个内容加载失败**。两个刻意的选择：

- **不降级跳过那一个锚点。** 「静默地少讲」是这个项目认定的最坏结果。
- **不只报 warn。** 契约违反要响，不要悄悄过。

> 取严的一条：`factCheckRequired` 必须为空。这一栏的名字就是「required」，
> 里面挂的是未结的活，和 approved 自相矛盾。已签之后仍要带的常备提示写
> `review.note`。若中台流程确实需要「已签但保留备注」，改这一条，
> 不要去放宽 `reviewedBy`。

### 署名的身份口径（2026-11-01 定）

一个署名一条，两个字段：

```json
"reviewedBy": [
  { "role": "content_owner",   "account": "owner@example.com" },
  { "role": "history_advisor", "account": "advisor@example.com" }
]
```

**`role` 是这个项目里的治理身份，不是中台的工作区角色。** 只有
`content_owner`（内容负责人）和 `history_advisor`（外部历史顾问）两个值，
对应规格 03 §9.2 的两方。中台的角色是
`owner`／`editor`／`reviewer`／`viewer`（`services/api/app/permissions.py`），
那套会随人事变动改，而签名一旦签下就不该再变——把会变的那个抄进 git，
日后只会对不上。所以不抄，各记各的。

**`account` 是中台账号的邮箱，而且必须已经是中台自己的规范化形式。**
中台的 `normalize_email` 是 `strip().lower()`（`app/security.py`），`users.email`
全局唯一。要求规范化形式是为了能**直接按 `users.email` 等值查到人**：大小写
不一致的话，这条联查会**静默查不到**，而不是报错。schema 因此连大写都拦。

三件要说清的：

1. **schema 只校验形状。** 邮箱长得对，不等于中台真有这个账号、真有那个
   权限、真在那天签过。能核对账号的只有中台自己（它同时握着账号和审校记录），
   应用侧这道只是「查不到人的署名一定不对」。
2. **这两个字段必须由中台从自己的账号记录里填，不能是让人手打的输入框。**
   手打的邮箱和手打的名字是同一件事，只是更像真的。
3. **`reviewedBy` 应用侧没有任何读者。** 全仓库只有 schema 校验它；
   `src/agent/respond.ts` 往 `evidenceRefs` 里记的只有 `review.status`。
   所以邮箱不会随接口回给客户端，只留在这个私有仓库的 git 历史里。
   日后若要把署名展示给用户，先过一遍这件事。

账号本身中台已经够用了：成员邀请走一次性链接（7 天过期、可撤销、只存令牌
摘要），没有邮件通道也能用；移除成员用停用而非删除，所以**署名指向的账号
不会哪天查不到**。

## 五、会坏掉的现有流程

1. **md5 对账不是「不方便」，是结构上做不到了。** 中台走
   `/knowledge/manual` 导入——**那条路没有文件**，所以 WeKnora 的
   `file_hash` 无从产生，`knowledges.title` 存的也不再是文件名，
   而是中台给的标题。「仓库 md5 == `file_hash`」这条对账的两端同时消失。
2. **新的对账抓手是中台的交付记录 ↔ WeKnora 的 `knowledges.id`。**
   适配层每导入一篇就记下返回的 id（`external_ids`），撤回也按它来。
   对账要改成比这个，不要再比哈希。
3. **会出现混合知识库。** 今天那 17 篇是按**文件**传的（有 `file_hash`、
   `title` 是文件名），中台导的是 manual 行（没有 `file_hash`）。
   `knowledge/README.md` 那套对账查询假设的是文件行，迁移前要先想清楚
   这两类行怎么并存、或者旧的 17 篇要不要由中台重新交付一遍。
4. **「17 篇」这个数字**不再由仓库说了算。
5. **跨系统交叉校验。** 语料「关联锚点」那一栏的校验词表来自
   `content/anchors/`。语料走 WeKnora、锚点走 git PR 之后，这两样**本来
   就在两个系统里**——这不是中间态，是终态。所以这个校验必须在中台内部
   做（它同时握着两边），应用侧那份进料检查是最后一道，不能撤。
6. **reparse 触发权**在谁手上，要明确——中台的撤销只撤它自己那次导入。

## 六、中台该接、而仓库接不了的几件事

现在躺在 `review.factCheckRequired` 里的 22 条，按性质分四类——
每一类都是供应链活，不是应用活：

- **要线下或档案才能定的**：竹林七贤砖画尺寸（二手网站有数字，无官方目录或
  发掘简报）；明远楼始建年代（地方志说明永乐、馆方说「距今 470 多年」
  ≈ 嘉靖，差近一百五十年）；李渔楹联题写者归属；《同治上江两县志》原文。
- **原文定位**：kb-bamboo／kb-mingyuan／kb-gongyuan 三篇的 K1 至今
  「待补充」，引用没落到页码或段落。
- **本机网络取不到的**：`dfz.nanjing.gov.cn`、`yht.nanjing.gov.cn`
  都被加速乐 WAF 拦（2026-10-31 实测）。
- **来源自身有错的**：明远楼「明远」二字出处，馆方写「取自《大学》中
  『慎终追远，明德归厚矣』」，但该句出自《论语·学而》、原文是
  「民德归厚矣」，一句话两处不符。文案因此没写名字的出处。
  **中台必须能记录「采信／不采信 + 理由」，而不只是存一个 url。**
  这一类是双签存在的全部理由。

## 七、还没定的

- **外部顾问在中台里用哪个角色。** 身份口径已经定了（第四节），剩下的是
  开账号这一步：中台今天四个角色里，`reviewer`（审核）是唯一既能记录审校
  动作、又能被邀请的——但它同时带着 `deliver`（导入知识库）权限，
  等于让一个外部的人能往线上知识库推东西；`viewer`（只读）一个权限都没有，
  签不了。我倾向于**中台加一个只有 `review`、没有 `deliver` 的角色**，
  而不是把顾问放进 `reviewer` 将就。这是中台侧的改动，这个仓库管不着。
- **一个账号只属于一个工作区，邮箱还全局唯一。** 所以同一个顾问没法同时
  出现在两个工作区里；他若已有账号，邀请会撞 409。几个景区／展馆分不同
  工作区的话，这件事要先想清楚。
- **版本与回滚**：锚点引 K1，K1 来自语料。语料能撤回导入、锚点在 git 里，
  两边的版本怎么对齐？一个已合并的锚点引的 K1 被撤回了，谁发现？
- **谁有权改一个已经 `approved` 的锚点**，改了之后双签是否失效？
- **`sceneId` 与场景词表**由谁维护（今天在应用侧）。
