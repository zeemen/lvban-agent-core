# Personal Memory System 技术规格 V1.0

> 上游依据：《AI旅伴 · 产品企划书 v1.2》第 07 节（记忆系统）、第 09 节（核心实体）、第 15 节（下一步）
> 状态：V1.0 草案 · 2026-10-25 · 待评审
> 一句话范围：定义"记忆"这件事的数据模型、写入闸门、蒸馏规则、检索策略、个人↔家庭分权与用户权利接口。
> 不在本规格范围：位置采样与围栏（见 02）、讲解口吻与提问策略（见 03）、具体锚点内容（见 04）。

---

## 0. 为什么这份规格排第一

企划书 P10：**卖的不是景点知识，而是一个长期懂我的 agent**。讲解能力会被地图平台和通用大模型迅速商品化，长期记忆不会。因此这份规格的唯一成败标准是：

> 第二次旅行时，用户能明确感到"它记得我上次喜欢什么"，并且说得出具体是哪一条。

这一条对应企划书核心假设 **H5（记忆价值）**。本规格中所有设计选择，都要能回答"它如何让 H5 成立"。

### 0.1 三条不可妥协的工程红线

| 红线 | 工程含义 |
|---|---|
| **系统推断不偷偷写入长期身份**（No hidden profiling） | `system_inferred` 来源的数据永远不能自动进入偏好层与身份层，必须经过用户确认这一道闸 |
| **伴的前提是不被窥视** | 黑名单字段在写入网关硬拦截，不是靠调用方自觉 |
| **记忆随人走** | User 是主键；Family 是可选关联；孩子成年后解绑，记忆跟着他走，不留在家长账户 |

---

## 1. 四层记忆模型

稳定度递减、时效性递增。设计关键不在"存什么"，而在"**什么能往上升**"。

| 层 | 代号 | 存储 | 生命周期 | 典型内容 | 可否自动写入 |
|---|---|---|---|---|---|
| 瞬时层 | L0 Ephemeral | Redis | 旅程结束 + 24h 后失效 | 对话缓冲、当前 Context State、本次推断信号 | 是 |
| 旅程层 | L1 Journey | PostgreSQL | 长期（原始轨迹除外） | 这一趟去了哪、问了什么、停了多久、说了什么 | 仅限用户明确表达 |
| 偏好层 | L2 Preference | PostgreSQL | 长期，可衰减 | "对科举话题兴趣高""走路快不爱排队" | 否，须过蒸馏闸 |
| 身份层 | L3 Identity | PostgreSQL | 长期，稀疏 | "历史爱好者""独行为主" | 否，须跨旅程验证 |

**语义足迹**（Semantic Footprint）不是第五层，而是 L1 的长期压缩产物：原始 GPS 点在行程结束后 7 天内销毁，长期沉淀的是"人—地点—时间—行为—问题—兴趣—意义"。

### 1.1 层间流动

```
用户明确表达 ──即时──> L1 旅程层
系统推断     ──────> L0 瞬时层（本次参考，不写入 L1）

L1 ──行后蒸馏（D2 闸）──> L2 偏好层
L2 ──跨 ≥3 次旅程（D3 闸）──> L3 身份层
L1.raw_track ──7 天内压缩（D4）──> 语义足迹（L1 长期）
```

每一层的每一条记录都必须可被本人（未成年人由监护人）看到、解释来源、并一键删除。

---

## 2. 数据模型

### 2.1 核心实体关系

企划书第 09 节列出的核心实体，在本规格中的归属：

| 实体 | 层 | 说明 |
|---|---|---|
| `User` | L3 / 账户 | **主键实体**。身份层记忆挂在这里 |
| `Family` | 关联 | 可选扩展，不是主键 |
| `Trip`（行程） | L1 | 一次出行（可跨天、跨城市），包含多个 Journey |
| `Journey`（旅程会话） | L1 | 一次"开始今天的旅程"到"结束"的会话，是采集的最小授权单元 |
| `LocationEvent` | L1 | 到达 / 停留 / 离开事件（非原始坐标点） |
| `POI` / `Exhibit` | 知识侧 | 由内容库提供，记忆侧只存引用 |
| `Question` / `Interaction` | L1 | 用户问了什么、agent 答了什么 |
| `Preference` | L2 | 蒸馏产物 |
| `IdentityTrait` | L3 | 跨旅程稳定产物 |
| `SemanticFootprint` | L1（长期） | 轨迹的语义压缩 |
| `Memory`（统一检索视图） | 跨层 | 不是表，是 L1/L2/L3 的统一检索抽象 |
| `LearningTopic` / `KnowledgeNode` | 知识侧 | 见规格 03/04 |
| `Report` | L1 | 游记 / 研学记录 |
| `Ambassador` / `Merchant` / `Redemption` | 业务侧 | 不进入个人记忆体系（见 04） |

**核心数据链**（企划书原文）：
`User → Journey → LocationEvent → Interaction → Distillation → Preference`

### 2.2 存储选型

| 用途 | 选型 | 理由 |
|---|---|---|
| 主数据 | PostgreSQL 16 | 关系清晰、事务可靠、合规删除可审计 |
| 向量检索 | pgvector | 记忆检索量级小（单用户千条量级），不值得引入独立向量库 |
| 瞬时层 | Redis | TTL 原生、Context State 读写高频 |
| 媒体 | 对象存储 + CDN | 照片、游记长图、TTS 缓存 |

ID 统一用 **UUIDv7**（时间有序，便于分片与排序）。所有时间字段 `timestamptz`，统一 UTC 存储。

### 2.3 Schema（DDL）

#### User（主键实体）

```sql
CREATE TABLE app_user (
  id              uuid PRIMARY KEY,
  wx_openid       text UNIQUE NOT NULL,
  wx_unionid      text,
  nickname        text,
  -- 身份基础属性（用户填写或对话中明确给出，非推断）
  age_band        text CHECK (age_band IN
                    ('under_12','12_15','16_18','19_24','25_plus','unknown')),
  birth_year      int,                       -- 可选，仅用于年龄段校准
  default_mode    text NOT NULL DEFAULT 'companion'
                    CHECK (default_mode IN ('companion','family_study','light_guide')),
  explain_pref    jsonb NOT NULL DEFAULT '{}'::jsonb,  -- 讲解偏好：长度/深度/是否先提问
  -- 未成年人保护
  is_minor        boolean GENERATED ALWAYS AS
                    (age_band IN ('under_12','12_15','16_18')) STORED,
  guardian_user_id uuid REFERENCES app_user(id),  -- 仅 <14 岁必填
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
```

> `age_band` 的 `16_18` 必须被下游当作未成年人处理：位置提示、消费限额按未成年人标准（企划书第 02 节脚注）。

#### Family（可选扩展）

```sql
CREATE TABLE family (
  id          uuid PRIMARY KEY,
  created_by  uuid NOT NULL REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE family_member (
  family_id     uuid NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('parent','child','sibling','other')),
  -- 监护：14 岁以下成员的档案由监护人账户掌控
  guardianship  boolean NOT NULL DEFAULT false,
  unbound_at    timestamptz,     -- 孩子成年后解绑；解绑后记忆随人走
  PRIMARY KEY (family_id, user_id)
);
```

**Family 不拥有记忆。** 家庭旅程的记忆分别写入每个成员的个人档案，用 `co_travelers` 字段标记关系。

#### Journey（采集的授权单元）

```sql
CREATE TABLE journey (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES app_user(id),
  trip_id         uuid REFERENCES trip(id),
  mode            text NOT NULL CHECK (mode IN ('companion','family_study','light_guide')),
  party           text NOT NULL CHECK (party IN ('solo','parent_child','friends','group')),
  co_travelers    uuid[] NOT NULL DEFAULT '{}',   -- 同行的其他 User
  scene_id        text NOT NULL,                  -- 'nanjing_museum' | 'fuzimiao'
  -- Usage Mode Collection：用户显式开始/结束
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz,
  -- 轨迹保存授权：三档，用户每次旅程单独选择
  track_consent   text NOT NULL CHECK (track_consent IN
                    ('none','visited_points_only','full_track')),
  consent_snapshot jsonb NOT NULL,   -- 授权时的完整勾选状态，留证
  raw_track_purge_at timestamptz,    -- = ended_at + 7 days
  distilled_at    timestamptz,       -- 蒸馏完成时间，幂等用
  deleted_at      timestamptz
);
```

> **不做全天候或后台持续追踪。** 没有 open 的 Journey，就没有任何位置写入——这是硬约束，由采集端和写入网关双重保证。

#### LocationEvent（事件，不是坐标点）

```sql
CREATE TABLE location_event (
  id          uuid PRIMARY KEY,
  journey_id  uuid NOT NULL REFERENCES journey(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app_user(id),
  kind        text NOT NULL CHECK (kind IN ('arrive','dwell','leave','skip','confirm_zone')),
  poi_id      text,            -- 匹配到的 POI / 展区
  exhibit_id  text,            -- 匹配到的展品（室内）
  source      text NOT NULL CHECK (source IN
                ('geofence','user_confirmed','vision_anchor','inferred')),
  confidence  numeric(3,2),    -- vision_anchor 必填
  dwell_sec   int,
  occurred_at timestamptz NOT NULL
);
```

> **室内不伪造精确位置。** 室内 `location_event` 的 `source` 只能是 `user_confirmed` / `vision_anchor` / `inferred`，永不写 GPS 坐标。详见规格 02 第 4 节。

#### Interaction / Question

```sql
CREATE TABLE interaction (
  id            uuid PRIMARY KEY,
  journey_id    uuid NOT NULL REFERENCES journey(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES app_user(id),
  turn_index    int NOT NULL,
  role          text NOT NULL CHECK (role IN ('user','agent')),
  channel       text NOT NULL CHECK (channel IN ('text','voice','photo','tap')),
  content       text,
  anchor_id     text,          -- 关联的锚点
  topic_tags    text[],        -- 由主题抽取写入，如 {'科举','建筑'}
  -- agent 侧
  evidence_refs jsonb,         -- Evidence-first：本次回答引用了哪些知识节点
  was_ignored   boolean,       -- 主动开口但用户无反应，供主动性引擎降噪
  occurred_at   timestamptz NOT NULL
);
```

#### Preference（L2）

```sql
CREATE TABLE preference (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  dimension     text NOT NULL,   -- 见 2.4 偏好维度表
  value         text NOT NULL,   -- '科举' / 'fast' / 'avoid_queue'
  strength      numeric(3,2) NOT NULL DEFAULT 0.50,  -- 0..1
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('mentioned_once','active','decayed','user_removed')),
  -- 证据链：这条偏好凭什么成立，用户点"为什么这样推荐"时原样展示
  evidence_refs jsonb NOT NULL,   -- [{journey_id, interaction_ids[], signal_count}]
  journey_count int NOT NULL DEFAULT 1,
  source        text NOT NULL CHECK (source IN ('explicit','user_confirmed')),
  first_seen_at timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  UNIQUE (user_id, dimension, value)
);
```

> `source` 没有 `system_inferred` 这个取值——**这是故意的**。推断信号永远停留在 L0，要么被用户的明确表达坐实，要么在行后回顾里被用户确认，否则不进 L2。

#### IdentityTrait（L3）

```sql
CREATE TABLE identity_trait (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  trait           text NOT NULL,
  status          text NOT NULL DEFAULT 'candidate'
                    CHECK (status IN ('candidate','active','user_removed')),
  supporting_journeys uuid[] NOT NULL,   -- 必须 ≥3 且 party 结构不全相同
  party_invariant boolean NOT NULL,      -- D3 闸的硬条件
  promoted_at     timestamptz,
  explanation     text NOT NULL,         -- 人话解释，直接展示给用户
  UNIQUE (user_id, trait)
);
```

#### SemanticFootprint（语义足迹）

```sql
CREATE TABLE semantic_footprint (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  journey_id    uuid NOT NULL REFERENCES journey(id) ON DELETE CASCADE,
  city          text NOT NULL,
  place         text NOT NULL,          -- '南京博物院' / '江南贡院'
  parent_place  text,                   -- 层级：历史馆 ∈ 南京博物院
  dwell_sec     int NOT NULL,
  question_count int NOT NULL DEFAULT 0,
  interest_signal text CHECK (interest_signal IN ('low','medium','high')),
  topics        text[] NOT NULL DEFAULT '{}',
  moment        text,                   -- "记下了'文德分月'的日期"
  occurred_on   date NOT NULL
);
```

对应企划书中的足迹示例结构：

```
2026-10 南京 · 独行 · 同游模式
├ 南京博物院   停留 2h36m
│  ├ 历史馆   停留 48min
│  │  └ 竹林七贤砖印壁画   停留 11min · 提问 4 次 · 兴趣信号：高
│  └ 青铜器展区   停留 7min · 跳过多数展品
└ 夫子庙（夜游）   停留 2h18m
   ├ 江南贡院   停留 31min · 提问 8 次 · 兴趣 ★★★★★
   └ 文德桥   停留 14min · 记下了"文德分月"的日期
```

#### 原始轨迹（短期）

```sql
CREATE TABLE raw_track_point (
  journey_id  uuid NOT NULL REFERENCES journey(id) ON DELETE CASCADE,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  accuracy_m  real,
  recorded_at timestamptz NOT NULL
) PARTITION BY RANGE (recorded_at);
```

**只有 `track_consent = 'full_track'` 时才写这张表**，且无条件在 `journey.ended_at + 7 天` 由定时任务物理删除。分区按天，到期直接 `DROP PARTITION`——删除要可证明，不是 `UPDATE deleted_at`。

### 2.4 偏好维度表（V1 封闭集合）

偏好不是自由文本，是**受控维度**。开放维度会让检索退化成模糊搜索，也让"用户看得懂自己被记住了什么"变得不可能。

| dimension | 取值示例 | 来源信号 |
|---|---|---|
| `topic_interest` | 科举、建筑、青铜器、诗词、民俗 | 提问主题、停留时长、明确表达 |
| `pace` | fast / moderate / slow | 明确表达（"走不动了"）、跳过率 |
| `depth` | brief / standard / deep | 明确表达、连续追问次数 |
| `queue_tolerance` | avoid_queue / tolerant | 明确表达 |
| `time_of_day` | day / night | 旅程开始时间 |
| `party_default` | solo / friends / parent_child | 多次旅程的 party |
| `explain_style` | question_first / answer_first | 明确表达、行后回顾确认 |
| `voice_pref` | voice_on / text_only | 明确设置 |

新增维度需要同时更新：本表、检索打分表（第 5 节）、用户可见文案表。**不允许运行时动态造维度。**

---

## 3. 写入策略：Memory Write Gateway

所有记忆写入**只能**经过一个网关函数，不允许业务代码直接 `INSERT`。网关是红线的执行点，不是建议。

```
writeMemory(candidate: MemoryCandidate) -> WriteResult
```

### 3.1 写入判定流程

```
1. 黑名单检查      → 命中则 REJECT 并记审计
2. Journey 有效性  → 无 open journey 的位置/交互写入 → REJECT
3. 授权检查        → track_consent 与写入类型是否匹配
4. 来源分流:
     explicit        → 写 L1
     user_confirmed  → 写 L1（可直接参与 D2）
     system_inferred → 只写 L0，设 TTL，不落库
5. 未成年人检查    → <14 岁：校验监护人授权状态
6. 写入 + 审计日志
```

### 3.2 黑名单（硬拦截）

```yaml
blocked_categories:
  - health            # 健康状况、病史、残障、用药
  - finance           # 收入、资产、消费能力
  - sensitive_identity  # 种族、宗教、政治观点、性取向、生物识别特征
  - precise_home      # 家庭住址、学校具体地址、常驻位置推断
  - inferred_portrait # 任何用户没说、系统猜的画像标签
```

实现要点：黑名单在**语义层**也要生效，不只是字段名匹配。L0 的推断信号在写入前过一次分类器；分类器判定命中黑名单类别的，连 L0 都不写。分类器误判宁可偏严——漏记一条偏好的代价，远小于记错一条敏感信息。

### 3.3 来源标记（provenance）

每条 L1/L2/L3 记录都带 `source`：

| source | 含义 | 可否进 L2 |
|---|---|---|
| `explicit` | 用户主动说出口 / 主动设置 | 可 |
| `user_confirmed` | 系统提议、用户在行后回顾中点了确认 | 可 |
| `system_inferred` | 系统从行为推断 | **否**，只活在 L0 |

### 3.4 审计

```sql
CREATE TABLE memory_audit (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL,
  action      text NOT NULL,  -- write | reject | promote | decay | delete | export
  layer       text,
  target_id   uuid,
  reason      text,           -- 拒绝原因 / 晋升依据
  actor       text NOT NULL,  -- 'system:distiller' | 'user' | 'guardian'
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

审计表在合规检查与"为什么这样推荐"的解释链里都要用，保留期 ≥ 2 年，且**用户删除记忆时审计条目保留但脱敏**（保留"发生过一次删除"，不保留被删内容）。

---

## 4. 蒸馏管线（Distillation）

行后触发，**不是实时**。企划书原文：旅程 → 偏好是"行后一次性蒸馏"。

### 4.1 触发时机

| 事件 | 动作 |
|---|---|
| 用户点"结束今天的旅程" | 入队蒸馏任务（延迟 2 分钟，等待尾部数据落库） |
| 旅程超时自动结束（见 02） | 同上 |
| 用户在行后回顾中确认/否认条目 | 增量重跑 D2、D3 |

蒸馏任务以 `journey_id` 幂等（`journey.distilled_at` 非空则跳过，除非显式 `force`），可重放。

### 4.2 规则表

| 规则 | 输入 | 条件 | 输出 |
|---|---|---|---|
| **D1** 瞬时→旅程 | L0 信号 | `source = explicit` | 即时写 L1；`system_inferred` 仅作本次参考，随 L0 过期 |
| **D2** 旅程→偏好 | L1 本次旅程 | 同类信号本次出现 **≥ 2 次**，**或** 用户在行后回顾中确认 | 新建/强化 `preference`。首次出现只记 `status='mentioned_once'` |
| **D3** 偏好→身份 | L2 | 跨 **≥ 3 次**旅程稳定成立 **且** `party_invariant = true` | `identity_trait`，先 `candidate`，经用户可见确认后 `active` |
| **D4** 轨迹→足迹 | `raw_track_point` | 行程结束 | 生成 `semantic_footprint`；原始点 **7 天内物理删除** |
| **D5** 个人↔家庭 | 家庭旅程 | — | 分别写入每个成员个人档案并标记关系；**孩子的偏好不自动合并进家长档案，反之亦然** |

### 4.3 阈值参数表（可调，待真实数据校准）

企划书明确"阈值待真实数据调优"，因此全部外置为配置，不写死在代码里。

```yaml
distillation:
  d2_signal_count_min: 2          # 同类信号本次最少出现次数
  d2_dwell_sec_as_signal: 300     # 停留 ≥5min 计 1 次兴趣信号
  d2_question_as_signal: 1        # 每次围绕同一主题提问计 1 次
  d3_journey_count_min: 3
  d3_require_party_invariant: true
  d4_raw_track_ttl_days: 7
  preference_decay_half_life_days: 180   # 超过半年未再出现，strength 减半
  preference_decay_floor: 0.20           # 低于此值转 status='decayed'，不再参与检索
```

### 4.4 strength 计算

```
strength = clamp(
  base(0.5)
  + 0.15 * min(journey_count - 1, 3)        # 跨旅程重复出现
  + 0.10 * min(signal_count_total / 5, 1)   # 信号密度
  + 0.15 * (source == 'user_confirmed')     # 用户亲口确认加权
  - decay(days_since_last_seen),
  0, 1)
```

衰减用半衰期而非线性，避免一次长假后把半年前的兴趣全部清零。

### 4.5 D5 分权示例

一次南博亲子旅程，孩子对青铜器连续提问 3 次，家长明确说"走不动了"：

```
写入孩子档案：  preference(topic_interest=青铜器, source=explicit, evidence=本次 3 次提问)
                journey(party=parent_child, co_travelers=[家长id])
写入家长档案：  preference(pace=slow, source=explicit)
                journey(party=parent_child, co_travelers=[孩子id])
不写：          家长档案里不出现"青铜器兴趣"；孩子档案里不出现"走得慢"
```

---

## 5. 检索（Retrieval）

### 5.1 三种检索场景

| 场景 | 调用时机 | 预算 | 输出形态 |
|---|---|---|---|
| **行前规划** | 打开小程序、选场景 | ≤ 10 条，≤ 1000 token | 结构化，供规划器排路线 |
| **行中触发** | 每次讲解规划前 | ≤ **6 条**，≤ **600 token** | `memory_hooks` 字符串数组 |
| **行后生成** | 生成游记 / 研学记录 | ≤ 30 条，≤ 3000 token | 全量旅程层 + 相关偏好 |

行中预算卡得死，是因为它在用户等待的关键路径上（见规格 03 的延迟预算）。

### 5.2 memory_hooks 格式

企划书 Context State 示例里的 `memory_hooks: ["苏州·拙政园·借景", "南博·科举·连续提问"]`，形式化为：

```
<city>·<place>·<topic>[·<signal>]
```

生成规则：从 `semantic_footprint` 与 `preference` 联合取，每条 ≤ 20 字，**人可读**——它既要喂给模型，也要能原样展示给用户看"它凭什么这么说"。

### 5.3 打分

```
score =  0.30 * semantic_similarity(query_topic, memory.topics)
       + 0.20 * place_affinity(current_poi, memory.place)      # 同城/同类场景加权
       + 0.20 * layer_weight                                   # L3=1.0, L2=0.8, L1=0.6
       + 0.15 * recency_decay(last_seen_at)
       + 0.15 * strength
       - 0.25 * recently_surfaced_penalty                      # 同一条 24h 内已用过
```

`recently_surfaced_penalty` 很关键：同一条记忆反复被念出来，"它记得我"会迅速退化成"它只记得这一件事"。

### 5.4 跨城市延续

`place_affinity` 支持三级匹配，这是企划书"下次去北京会主动接上"的实现点：

| 匹配级别 | 权重 | 例 |
|---|---|---|
| 同一地点 | 1.0 | 第二次来江南贡院 |
| 同类场景（跨城市） | 0.7 | 苏州园林 → 秦淮河沿岸建筑 |
| 同主题（跨场景） | 0.5 | 南博科举展 → 江南贡院 |

### 5.5 检索接口

```
GET /internal/memory/hooks
  ?user_id=...&journey_id=...&poi_id=...&topic=...&limit=6

200 {
  "hooks": [
    {"text": "苏州·拙政园·借景", "layer": "L1",
     "evidence": {"journey_id": "...", "occurred_on": "2026-09-14"}},
    {"text": "南博·科举·连续提问", "layer": "L2", "strength": 0.78,
     "evidence": {"journey_ids": ["...","..."], "signal_count": 7}}
  ],
  "identity": [
    {"trait": "历史爱好者", "explanation": "你在 3 次旅行里都围着历史展区问得最多"}
  ],
  "token_estimate": 180
}
```

每条都带 `evidence`——**Memory-visible 原则要求"为什么这样推荐"随时可答**，所以证据必须跟着检索结果一起返回，而不是另外再查一次。

---

## 6. 个人 ↔ 家庭分权矩阵

| 操作 | 本人（≥18） | 本人（16–18） | 本人（<14） | 监护人 |
|---|---|---|---|---|
| 查看自己的记忆 | 可 | 可 | 可（简化视图） | 可（被监护人的） |
| 修改 / 删除自己的记忆 | 可 | 可 | 可 | 可 |
| 导出 | 可 | 可 | 否 | 可 |
| 修改授权设置 | 可 | 可（消费与位置按未成年人标准） | 否 | 可 |
| 查看对方的记忆 | 否 | 否 | 否 | 仅 `guardianship=true` 的成员 |
| 解绑监护关系 | 成年后可单方发起 | 否 | 否 | 可 |

**解绑语义**：`family_member.unbound_at` 置位后，监护人立即失去对该档案的全部读写权，已生成的家庭旅程记录在双方档案中各自保留（因为每个人本来就参与了那次旅行），但 `co_travelers` 关系标记对解绑方隐藏。记忆随人走。

---

## 7. 用户权利接口

对应数据原则：Memory-visible · Editable · Deletable · Exportable。

| 接口 | 说明 | SLA |
|---|---|---|
| `GET /me/memory` | 分层展示：身份层逐条、偏好层逐条带证据、旅程层按时间线 | 实时 |
| `GET /me/memory/{id}/why` | 返回这条记忆的证据链与晋升路径 | 实时 |
| `PATCH /me/memory/{id}` | 修改 value / strength，或标记"这不对" | 实时 |
| `DELETE /me/memory/{id}` | 单条删除，级联清理依赖它的上层记忆 | 实时 |
| `DELETE /me/journey/{id}` | 删除整次旅程（含足迹与原始轨迹） | ≤ 5 min |
| `POST /me/memory/export` | 导出 JSON + 人类可读 PDF | ≤ 24 h |
| `DELETE /me/memory/all` | 清空全部记忆，账户保留 | ≤ 24 h，二次确认 |
| `POST /me/family/unbind` | 解绑监护关系 | 实时 |

### 7.1 级联删除规则

删除一条 L1 记录时，重算而非直接删除依赖它的 L2/L3：

```
删除 interaction → 重跑该 journey 的 D2 → 若 signal_count 跌破阈值，
  preference 降级为 mentioned_once 或移除 → 若 preference 移除导致
  identity_trait 的 supporting_journeys < 3 → trait 降级为 candidate
```

这一步必须做，否则"删了却还记得"会直接击穿信任。

### 7.2 行程结束提醒

企划书："行程结束明确提醒并提供一键删除。"

旅程结束时的回顾页必须包含：本次记录了哪些点位 / 问了几个问题 / 保存了什么轨迹 / **一键删除本次全部记录**。这个入口不允许折叠在二级菜单里。

---

## 8. 合规映射

| 要求 | 来源 | 本规格落点 |
|---|---|---|
| 单独同意处理儿童个人信息 | PIPL 第 31 条、《儿童个人信息网络保护规定》 | `guardian_user_id`、`consent_snapshot`、分权矩阵 |
| 未满 18 周岁的内容、消费与防沉迷 | 《未成年人网络保护条例》 | `is_minor`；16–18 按未成年人标准处理位置提示与消费限额 |
| 告知—同意、目的限定 | PIPL | `track_consent` 三档分项授权 + `consent_snapshot` 留证 |
| 可查阅、可更正、可删除、可携带 | PIPL 第 44–45 条 | 第 7 节接口 |
| 最小必要 | PIPL 第 6 条 | 黑名单 + 原始轨迹 7 天销毁 + 语义化压缩 |

> 本规格不替代专项法律意见。上线前须单独完成法律法规与平台规则的合规评估（企划书第 07 节原文要求）。

---

## 9. 验收标准

### 9.1 功能验收

- [ ] 无 open journey 时，任何位置/交互写入被网关拒绝并记审计
- [ ] `system_inferred` 来源的数据在任何路径下都无法进入 `preference` 表（含并发、重放、手工重跑蒸馏）
- [ ] 黑名单五类内容在语义层被拦截（用对抗样例集测试，≥ 50 条）
- [ ] 旅程结束 7 天后，`raw_track_point` 对应分区物理不存在
- [ ] 删除单条 interaction 后，依赖它的 preference / identity_trait 在 1 分钟内完成重算
- [ ] 解绑后监护人立即无法读取被监护人任何记忆
- [ ] 每条展示给用户的记忆都能点出"为什么"，并给出具体旅程与时间

### 9.2 H5 验证口径

企划书 H5：长期记忆是否让第二次旅行体验明显提高。

| 指标 | 定义 | 首发目标 |
|---|---|---|
| 跨次记忆调用率 | 第二次旅程中，讲解里实际引用了 memory_hook 的点位占比 | ≥ 40% |
| 记忆命中认可率 | 行后回顾中用户对"它记得我上次…"打勾的比例 | ≥ 60% |
| 记忆纠错率 | 用户主动修改或删除 AI 记忆的比例 | ≤ 15%（过高说明蒸馏太激进） |
| 偏好新增量 | 每次旅程平均新增 active 偏好条数 | 2–5 条（过多即噪声） |
| 足迹完整度 | 有语义足迹的点位 / 实际到访点位 | ≥ 85% |

> `记忆纠错率 ≤ 15%` 与`跨次记忆调用率 ≥ 40%` 是一对拉扯指标：调得太猛，纠错率上升。调参时两个一起看。

---

## 10. 开放问题

| # | 问题 | 影响 | 建议决策时点 |
|---|---|---|---|
| Q1 | `d2_signal_count_min = 2` 是否过松？一次旅程里同一主题问两次就升偏好，可能把"随口一问"误当兴趣 | 偏好噪声 | 首批 50 次真实旅程后校准 |
| Q2 | 轻导览模式是否参与蒸馏？企划书说"保留记忆入口但不主动经营" | 轻导览用户的记忆资产 | 本规格暂定：写 L1，**不自动跑 D2**，用户主动开启才蒸馏 |
| Q3 | 同行者的记忆是否互相可见（朋友同游）？ | 社交边界 | V1 不做，`co_travelers` 只存关系不开放读取 |
| Q4 | 偏好维度封闭集合会不会限制表达力 | 长期扩展性 | V1 先封闭，每月评审新增维度 |
| Q5 | 16–18 岁用户的记忆导出是否需要监护人介入 | 合规 | 待法律意见 |

---

## 附录 A：Context State 中的记忆字段

与规格 02 的接口契约。记忆系统向 Context Engine 输出的部分：

```json
{
  "memory_hooks": ["苏州·拙政园·借景", "南博·科举·连续提问"],
  "identity_traits": ["历史爱好者"],
  "preferences": {
    "pace": "fast",
    "depth": "deep",
    "queue_tolerance": "avoid_queue",
    "explain_style": "question_first"
  },
  "visited_anchors": ["njm_zhulin_qixian", "njm_cuojinyin_hu"],
  "memory_budget_used_tokens": 180
}
```

## 附录 B：与其余三份规格的接口

| 对接方 | 本规格提供 | 本规格需要 |
|---|---|---|
| 02 Location & Context Engine | `memory_hooks`、`visited_anchors`、`preferences` | `location_event` 写入、journey 状态变更通知 |
| 03 Agent Policy | 检索结果 + 证据链 | `interaction` 写入（含 `was_ignored`、`topic_tags`） |
| 04 Dual-Demo PRD | 用户权利页面数据、游记/研学记录的记忆素材 | 锚点 ID 体系、场景 ID 体系 |
