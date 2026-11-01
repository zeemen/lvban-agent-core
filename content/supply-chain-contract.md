# 知识库供应链中台 · 交付契约

2026-10-31 定：中台的交付面包含**语料与锚点两类物料**（下文「方案 B」）。
这份文件是两个系统之间的接口说明，写在这里是因为被约束的东西就在这个目录下。

## 为什么需要它

今天**这个仓库就是语料的源头**：`content/knowledge/**/*.md` 是正本，入库靠人工
ingest 到 WeKnora，对账第一条是「17 篇的 `file_hash` 与仓库 md5 全一致」
（见 [`knowledge/README.md`](knowledge/README.md)）。

中台一旦成为产出方，这条不变式就不成立了。`content/` 退成下游副本，
整套对账、入库、`parse_status` 收尾流程都要换一个边界重新定义。

## 一、交付范围

中台产出两类物料，都是本仓库的**下游输入**：

| 物料 | 今天的位置 | 产出方 |
|---|---|---|
| 语料 | `content/knowledge/<sceneId>/kb-*.md` → WeKnora | 中台 |
| 锚点 | `content/anchors/*.json` | 中台 |

第二项是关键。M1 的瓶颈从来不是语料，是 **30 个锚点 × 八要素 × 三口吻**
加上规格 03 §9.2 的双签审校。现在的进度是 4 个，全是 `draft`，
`review.factCheckRequired` 里共 22 条待核。

## 二、锚点的数据契约

**契约就是 `src/content/loader.ts` 的 `anchorSchema`，不另写一份。**
两份一定会漂移，漂移之后没人知道该信哪个。中台应当直接引这个 schema，
或者由它生成。

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

- `reviewedBy` 至少两个**不同的**非空署名（规格 03 §9.2：内容负责人 + 外部历史顾问）
- `reviewedAt` 是 `YYYY-MM-DD`
- `factCheckRequired` 为空

不满足就让 `loadAnchors` 抛错、**整个内容加载失败**。两个刻意的选择：

- **不降级跳过那一个锚点。** 「静默地少讲」是这个项目认定的最坏结果。
- **不只报 warn。** 契约违反要响，不要悄悄过。

> 取严的一条：`factCheckRequired` 必须为空。这一栏的名字就是「required」，
> 里面挂的是未结的活，和 approved 自相矛盾。已签之后仍要带的常备提示写
> `review.note`。若中台流程确实需要「已签但保留备注」，改这一条，
> 不要去放宽 `reviewedBy`。

## 五、会坏掉的现有流程

1. **md5 对账。** 「仓库 md5 == WeKnora `file_hash`」不再成立。
   中台必须给出可比对的版本标识，否则对账无从下手。
2. **「17 篇」这个数字**不再由仓库说了算。
3. **`knowledges.title` 存的是文件名**，这是对账的唯一抓手——
   命名规则必须由中台定死。
4. **跨系统交叉校验。** 语料「关联锚点」那一栏的校验词表来自
   `content/anchors/`。两类物料都归中台之后，这个校验回到中台内部——
   但应用侧那份进料检查要保留，它是最后一道。
   最危险的中间态是「语料走中台、锚点留仓库」：校验跨了两个系统，
   会悄悄失效。
5. **reparse 触发权**在谁手上，要明确。

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

- **交付方式**：git PR／导出包／API？
- **版本与回滚**：锚点引 K1，K1 来自语料——两者的版本要不要对齐？
- **谁有权改一个已经 `approved` 的锚点**，改了之后双签是否失效？
- **`sceneId` 与场景词表**由谁维护（今天在应用侧）。
