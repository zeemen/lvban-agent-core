# Location & Context Engine 技术规格 V1.0

> 上游依据：《AI旅伴 · 产品企划书 v1.2》第 05 节（首发双 Demo）、第 06 节（核心引擎）、第 07 节（位置记忆）、第 15 节
> 状态：V1.0 草案 · 2026-10-25 · 待评审
> 一句话范围：把 GPS、相机、时间、动线、对话压成一个 **Context State**，并决定**此刻该不该开口**。
> 不在本规格范围：记忆的写入与蒸馏（见 01）、开口之后讲什么（见 03）、具体围栏坐标与锚点（见 04）。

---

## 0. 这份规格要回答的五个问题

企划书第 06 节：行中是 agent 真正发生的地方，它要持续回答五个问题：

```
我在哪  →  我在看什么  →  我在做什么  →  我现在需要什么  →  此刻该怎么服务
 │           │              │               │                    │
Location   Vision      Activity        Context State        Proactivity
Engine     Anchor      Detection        （本规格输出）        Engine
                                                                 ↓
                                                        规格 03 Explanation Planner
```

本规格负责前四个；第五个的"该不该"在这里，"怎么讲"在规格 03。

### 0.1 两条设计红线

| 红线 | 出处 | 工程含义 |
|---|---|---|
| **不做全天候或后台持续追踪** | 企划书第 07 节 Usage Mode Collection | 没有 open 的 Journey，采集层一个点都不传 |
| **室内不伪造精确位置** | 企划书第 05 节室内能力边界 | 室内 Context State 的 `location` 字段只能来自用户确认或视觉识别，且必须带 `confidence` 与可纠正入口 |

---

## 1. Journey 状态机

Journey 是采集的最小授权单元，也是本引擎的生命周期容器。

```
          用户点"开始今天的旅程"
                  │
                  ▼
   [CONSENT] ──拒绝──> [DECLINED] （不可采集，仅支持手动问答）
       │ 同意
       ▼
   [ACTIVE] ──────────────┐
    │  ▲                  │ 静止 >30min 或 离开场景围栏 >500m
    │  │ 任意交互           ▼
    │  └───────────── [IDLE]
    │                      │ IDLE 持续 >60min
    │ 用户点"结束"            ▼
    ▼                  [AUTO_ENDED]
  [ENDED] <────────────────┘
       │ +2min
       ▼
  [DISTILLING] ──> [CLOSED]
       │
       └─ 用户一键删除 ──> [PURGED]
```

| 状态 | 采集行为 | 主动开口 |
|---|---|---|
| `CONSENT` | 无 | 无 |
| `ACTIVE` | 按授权档位采集 | 允许 |
| `IDLE` | 降频至 1 次 / 5min，仅用于判断是否恢复 | **禁止** |
| `AUTO_ENDED` / `ENDED` | 停止 | 仅一条"今天就到这"的收尾 |
| `CLOSED` | 停止 | 无 |

**自动结束必须通知用户**，并在下次打开时询问"上次的旅程我替你结束了，要看看记录吗"——悄悄结束等于悄悄停止服务，用户会以为产品坏了。

### 1.1 授权三档

企划书："实时定位权限与长期轨迹保存分别说明、分别选择。"

| 档位 | 采集 | 长期保留 | 用户看到的文案 |
|---|---|---|---|
| `none` | 仅前台围栏判定，内存态 | 什么都不留 | 本次不保存轨迹 |
| `visited_points_only` | 围栏事件 + 停留 | `location_event` + 语义足迹 | 仅保存访问点位 |
| `full_track` | 原始点 + 事件 | 原始点 7 天内销毁，语义足迹长期 | 保存完整轨迹 |

默认值：**`visited_points_only`**。默认不是 `full_track`，也不是 `none`——前者过度，后者会让第一次体验缺少记忆素材，拿不到 H5 的验证数据。

---

## 2. 位置采样（室外）

### 2.1 分档节流

小程序侧用 `wx.startLocationUpdate`（前台）配合 `wx.onLocationChange`，不申请后台持续定位（企划书：Phase 1 小程序不承担后台持续定位）。

| 用户状态 | 判定 | 采样间隔 | 上报 |
|---|---|---|---|
| 静止 | 60s 内位移 < 15m | 20s | 不上报，本地判定 |
| 步行 | 0.5–2.0 m/s | 8s | 变化 > 10m 才上报 |
| 快速移动 | > 3.0 m/s | 15s | 只上报，不触发讲解 |
| 接近围栏 | 距最近围栏中心 < 80m | 4s | 上报 |

节流的目的不只是省电，更是降低 GPS 漂移带来的误触发。

### 2.2 精度过滤

```
丢弃条件：accuracy_m > 50
降权条件：accuracy_m 在 25–50 之间 → 只能触发"软提示"，不能触发自动讲解
可信条件：accuracy_m ≤ 25
```

夫子庙是密集街巷 + 水体 + 夜间，GPS 漂移是常态。企划书把夫子庙"最难的一点"定义为"人多、信号漂移时的该不该开口"——**精度不够时的正确行为是闭嘴，不是猜**。

---

## 3. 电子围栏（Geofence）

### 3.1 围栏定义

```json
{
  "poi_id": "fzm_jiangnan_gongyuan",
  "name": "江南贡院",
  "center": {"lat": 32.0211, "lng": 118.7905},
  "radius_m": 25,
  "exit_radius_m": 40,
  "min_dwell_sec": 20,
  "cooldown_sec": 1800,
  "priority": 1,
  "scene_id": "fuzimiao",
  "active_hours": [["09:00","22:00"]]
}
```

企划书给的范围是"核心节点 15–30 米电子围栏"。本规格取 **默认 25m**，逐点在现场实测后单独调整（见 04 的现场校准清单）。

### 3.2 迟滞（Hysteresis）

进入半径 `radius_m`，离开半径 `exit_radius_m = radius_m + 15m`。没有迟滞，站在边界上的用户会被反复"进入/离开"，触发一连串重复讲解。

### 3.3 触发条件（全部满足才产生 `arrive` 事件）

```
1. 连续 2 次定位落在 radius_m 内（去抖）
2. accuracy_m ≤ 25
3. 停留 ≥ min_dwell_sec（20s）—— 路过不算到达
4. 距上次该点位触发 ≥ cooldown_sec
5. 当前 Journey 状态为 ACTIVE
6. 不在快速移动状态
```

**产生 `arrive` 事件 ≠ 开口。** 开口由第 7 节的主动性引擎单独决定。企划书原文：进入围栏 ≠ 必须开口。

### 3.4 围栏重叠

夫子庙核心区 12 个点位在 500m 内，围栏必然重叠。重叠时按 `priority` 升序取一个，相同优先级取距中心最近的；**同一时刻只有一个 active_poi**，不允许并发触发两段讲解。

---

## 4. 室内上下文（无可靠 GPS）

企划书第 05 节原文：普通手机 GPS 无法支持可靠的展厅级定位。MVP 采用**四件套组合**，不伪造精确位置。

### 4.1 四件套

| 手段 | 权重 | 置信度来源 |
|---|---|---|
| ① 用户主动选展区 | 最高 | `source=user_confirmed`，confidence=1.0 |
| ② 拍照辅助识别（结果允许纠正） | 中 | VLM 返回的 top-1 分数 |
| ③ 展品编号输入 | 高 | 精确匹配，confidence=0.95 |
| ④ 已访问点位推断 | 低 | 展厅序列模型，confidence ≤ 0.6，**仅用于排序候选，不单独成立** |

组合规则：

```
if 用户选了展区:          zone = 用户选择（锁定，直到用户改）
elif 视觉识别 ≥ τ_high:   exhibit = top1，并在 UI 上显示"识别为 X，不对？点这里改"
elif 视觉识别 ≥ τ_low:    给出 2–3 个候选让用户点选
else:                     降级为"问一句"：让用户描述或读展牌
```

默认 `τ_high = 0.75`，`τ_low = 0.45`，现场实测后调整。

### 4.2 视觉锚点识别链路

```
小程序拍照
  → 前端压缩（长边 ≤1280px，JPEG q=0.8，目标 <300KB）
  → 上传（HTTPS，直传对象存储，回传 key）
  → VLM 识别（候选集约束：当前展区的展品清单，不做开放域识别）
  → 匹配 exhibit_id + confidence
  → 写 location_event(source='vision_anchor', confidence=...)
```

**候选集约束是命中率的关键**：不问 VLM"这是什么文物"，而问"这是以下 18 件中的哪一件，或都不是"。开放域识别在玻璃反光下必然翻车。

### 4.3 命中率熔断（企划书硬要求）

> "开发第一件事是在玻璃反光与人流遮挡下实测识别命中率：低于八成，就把行中交互从'拍一下'改成'问一句'为主。"

形式化为一个运行时开关，不是一次性的开发期决策：

```yaml
vision_anchor:
  hit_rate_window: 200          # 滚动窗口：最近 200 次识别
  hit_rate_threshold: 0.80
  fallback_mode: ask_first      # 低于阈值时，首页主入口从"拍一下"切到"问一句"
  evaluation: user_correction_rate   # 命中率 = 1 - 用户纠正率
```

命中率定义为 **1 − 用户纠正率**（用户点"不对，是另一件"的比例），不是模型自评分。模型分数高而用户一直在改，才是真正要熔断的情况。

熔断生效时的产品形态变化由规格 04 定义（首页主按钮与引导文案两套）。

### 4.4 室内不写什么

- 不写 GPS 坐标
- 不写"推断的展厅"作为既成事实（`source='inferred'` 的事件不进语义足迹，只做候选排序）
- `semantic_footprint.place` 只记录**用户确认过的**展区与展品（企划书原文）

---

## 5. 停留检测与 POI 匹配

### 5.1 Stop Detection

```
滑动窗口法：
  窗口 = 最近 180s 的定位点
  若 窗口内所有点的最大两两距离 < 30m  → 判定为 stop
  stop 开始时间 = 窗口内第一个点
  stop 结束 = 连续 60s 超出 30m 范围
  丢弃 dwell < 60s 的 stop（噪声）
```

室内无 GPS 时，stop 由**交互活跃度**代替：同一 `exhibit_id` 上连续交互的时间跨度即为停留。

### 5.2 POI 匹配优先级

```
1. 用户确认                 → 直接采用
2. 围栏命中（室外）/ 视觉锚点（室内）
3. 最近 POI（距离 < 50m 且唯一）
4. 都不匹配 → stop 记为 unnamed_stop，只保留"在南京停了 20 分钟"这一层粒度
```

`unnamed_stop` 不进入语义足迹的点位序列，只进入时长统计。宁可缺，不可错。

---

## 6. Context State

本引擎的核心输出，每次需要决策前重算（或从 L0 缓存读取，TTL 30s）。

### 6.1 完整字段

> 字段取值与规格 01 的 `app_user` 枚举严格一致。企划书第 06 节示例中的 `"age_band": "18-24"` 在此规范化为 `19_24`。

```json
{
  "user": "u_2048",
  "mode": "companion",
  "party": "solo",
  "age_band": "19_24",

  "scene": "outdoor",
  "scene_id": "fuzimiao",
  "location": "江南贡院",
  "location_source": "geofence",
  "location_confidence": 0.92,

  "activity": "walking",
  "is_moving": true,
  "is_dining": false,
  "accuracy_m": 14,

  "current_topic": "科举",
  "interest": "high",
  "fatigue": "medium",
  "dwell_here_sec": 180,
  "elapsed_min": 98,
  "time_left": 62,
  "time_of_day": "evening",

  "next_goal": "文德桥",
  "route_remaining": ["文德桥", "乌衣巷"],
  "active_task": null,

  "memory_hooks": ["苏州·拙政园·借景", "南博·科举·连续提问"],
  "identity_traits": ["历史爱好者"],
  "preferences": {"pace": "fast", "depth": "deep", "explain_style": "question_first"},
  "visited_anchors": ["fzm_tianxia_wenshu", "fzm_dacheng_dian"],

  "last_spoke_sec_ago": 240,
  "consecutive_ignored": 0,
  "user_is_speaking": false,

  "journey_id": "j_...",
  "state_version": 1,
  "computed_at": "2026-10-25T13:42:11Z"
}
```

亲子模式下增加 `family` 字段，其余结构不变（企划书原文）：

```json
{
  "party": "parent_child",
  "family": {
    "family_id": "f_...",
    "child": {"user_id": "u_...", "grade": "初一", "explain_pref": {"depth": "standard"}},
    "parent": {"user_id": "u_..."},
    "foreground_user": "child"
  }
}
```

`foreground_user` 决定这句话是说给孩子还是说给家长的——家长端静默提示（"已经连续参观 43 分钟，前方约 80 米有休息区"）走的是同一条管线，只是 `foreground_user = "parent"` 且 `channel = "silent_card"`。

### 6.2 派生字段的计算

#### `interest`

```
信号：本点位提问次数、停留时长 / 该点位中位停留、是否主动追问、是否跳过
interest = high    if 提问 ≥ 2 或 停留比 ≥ 1.5
           low     if 停留比 < 0.4 或 用户点了"跳过"
           medium  otherwise
```

#### `fatigue`

```
elapsed_min 加权 + 最近 20min 的交互密度下降 + 明确表达
fatigue = high    if elapsed_min > 150 或 用户说了"累/歇会儿/走不动"
          medium  if elapsed_min > 90 或 近 20min 交互量 < 前 20min 的 40%
          low     otherwise
```

`fatigue` 是**推断值**，按规格 01 的红线，它活在 L0，不写入长期记忆；只有用户亲口说的"走不动了"才作为 `explicit` 信号进 L1。

#### `is_dining`

```
停留 > 15min + POI 类型为餐饮 + 低位移  → true
```

吃饭时不开口，是主动性引擎的硬否决条件之一。

---

## 7. Proactivity Engine：决定什么时候开口

企划书原文列出的判断因素：是否刚讲过、用户是否正在说话、是否在吃饭、是否高速移动、之前是否连续被忽略、是否正在做任务、本次触发的内容价值够不够高。

### 7.1 两段式：硬否决 → 打分

```
if any(hard_veto):  return SILENT
score = Σ weights
if score ≥ θ_mode:  return SPEAK
elif score ≥ θ_soft: return SOFT_HINT   # 气泡/震动，不出声
else:               return SILENT
```

### 7.2 硬否决表

| 条件 | 理由 |
|---|---|
| `user_is_speaking = true` | 不打断用户 |
| `is_moving && speed > 3.0 m/s` | 骑车/乘车，不是在看 |
| `is_dining = true` | 吃饭是动线的一部分，不是讲解时机 |
| `last_spoke_sec_ago < 60` | 刚讲过 |
| `consecutive_ignored ≥ 2` | 连续两次被忽略，本点位静默 30 分钟 |
| `journey_state != ACTIVE` | |
| `安全场景`：道路、台阶、拥挤区域 | 企划书第 08 节：优先提示安全，而不是继续推送内容 |
| `active_task != null && task_stage = 'observing'` | 孩子正在找东西，别插嘴 |
| `location_confidence < 0.6` | 不确定在哪，就别装作知道 |

### 7.3 打分表

| 因子 | 权重 | 说明 |
|---|---|---|
| 锚点是否为 Top 30 精调锚点 | +0.30 | 内容价值 |
| 首次到访该点位 | +0.20 | |
| 命中 memory_hook（可做跨次连接） | +0.20 | H5 的主要产出口 |
| `interest = high` | +0.15 | |
| 与 `current_topic` 相关 | +0.10 | |
| `fatigue = high` | −0.25 | |
| 本次旅程已开口次数 > 时长/10min | −0.20 | 频次控制 |
| `mode = light_guide` | −0.20 | 轻导览不主动经营 |

### 7.4 模式阈值

| 模式 | θ_speak | θ_soft | 最大主动频次 |
|---|---|---|---|
| `companion`（同游） | 0.50 | 0.30 | ≤ 1 次 / 8 min |
| `family_study`（亲子） | 0.45 | 0.25 | ≤ 1 次 / 6 min（任务驱动，密度略高） |
| `light_guide`（轻导览） | 0.70 | 0.50 | ≤ 1 次 / 15 min |

轻导览阈值最高，对应企划书"不推任务、不设人设、不做引导式对话"。

### 7.5 被忽略的判定

```
主动开口后 90s 内无任何交互（无点击、无语音、无拍照） → was_ignored = true
连续 2 次 was_ignored → 该 scene 的主动开口静默 30 min，并在 UI 上给一个
                        "需要我安静一会儿吗"的显式开关
```

**给用户一个明确的闭嘴开关**，比系统自己猜更可靠，也更符合"该沉默时沉默"。

---

## 8. 接口

### 8.1 采集上报（小程序 → 服务端）

```
POST /v1/journey/{journey_id}/signals
{
  "points": [{"lat":..., "lng":..., "accuracy_m":..., "ts":...}],   // 仅 full_track
  "events": [{"kind":"arrive","poi_id":"...","ts":...}],
  "activity": {"is_moving": true, "speed_mps": 1.2}
}
→ 202 {"accepted": 3, "dropped": 1, "drop_reason": ["accuracy_too_low"]}
```

批量上报，默认 15s 一批或事件立即发。`track_consent != 'full_track'` 时 `points` 字段被服务端直接丢弃（不信任客户端）。

### 8.2 Context State 查询

```
GET /v1/journey/{journey_id}/context
→ 200 { ...Context State... }
```

### 8.3 主动性决策（内部）

```
POST /internal/proactivity/decide
{ "context": {...}, "trigger": {"kind":"geofence_arrive","poi_id":"..."} }
→ { "decision": "SPEAK" | "SOFT_HINT" | "SILENT",
    "score": 0.62,
    "vetoed_by": null,
    "reason": "top30_anchor + first_visit + memory_hook_match" }
```

`reason` 必须返回，用于调试与运营后台的"为什么这里没说话"排查——这是现场路测时最常被问到的问题。

### 8.4 视觉识别

```
POST /v1/vision/anchor
{ "journey_id": "...", "image_key": "...", "zone_hint": "njm_history_hall" }
→ { "candidates": [
      {"exhibit_id":"njm_cuojinyin_hu","name":"错金银重络铜壶","confidence":0.81}
    ],
    "decision": "auto_accept" | "ask_user_pick" | "fallback_ask",
    "correction_token": "..." }   // 用户纠正时带回，用于命中率统计
```

---

## 9. 指标与验收

### 9.1 工程指标

| 指标 | 目标 | 说明 |
|---|---|---|
| 围栏触发准确率 | ≥ 90% | 人在点位且应触发时触发了 |
| 围栏误触发率 | ≤ 5% | 人不在点位却触发 |
| 视觉识别命中率 | ≥ 80% | 1 − 用户纠正率；**低于则熔断** |
| Context State 计算延迟 | P95 ≤ 120ms | 在讲解生成的关键路径上 |
| 定位上报丢弃率 | ≤ 10% | 过高说明精度过滤阈值需要调 |
| 主动开口被忽略率 | ≤ 25% | 对应 H3 |

### 9.2 对应企划书假设

| 假设 | 本规格的验证口径 |
|---|---|
| **H3 场景感知**：Context-aware 触发是否明显优于传统导览 | A/B：围栏自动触发组 vs 手动列表选择组，比较有效提问率与完成率 |
| 南博"最难的一点"：识别命中率 | 第 9.1 行 3，现场实测 ≥ 200 次 |
| 夫子庙"最难的一点"：该不该开口 | 被忽略率 ≤ 25% 且主动开口密度在阈值内 |

### 9.3 现场校准清单（必须在南京现场完成，不能在办公室定）

- [ ] 12 个夫子庙点位的围栏圆心与半径逐一实测（白天 + 夜间各一次）
- [ ] 文德桥、乌衣巷等水体/窄巷点位的 GPS 漂移幅度记录
- [ ] 南博 18 件展品在玻璃反光 + 人流遮挡下的识别命中率（每件 ≥ 10 张实拍）
- [ ] 弱网环境下的上传超时率与降级表现
- [ ] 夜游时段的定位精度与白天的差异

---

## 10. 开放问题

| # | 问题 | 建议 |
|---|---|---|
| Q1 | 小程序前台定位在息屏/切后台时中断，长时间街区行走会断采 | V1 接受，用"回到前台时补一次事件"兜底；这是企划书把后台持续定位列为 Phase 2 App 理由的直接体现 |
| Q2 | 微信定位接口返回的是 gcj02，围栏坐标需统一坐标系 | 全链路统一 gcj02，入库不转换，避免二次偏移 |
| Q3 | 室内展区切换如何低成本确认 | V1 用展厅入口的一次点选 + 展品识别反推；现场测后决定是否加二维码兜底（注意：企划书明确不依赖官方二维码） |
| Q4 | `consecutive_ignored` 是否跨旅程累计 | V1 不跨，每次旅程重置；跨次累计容易把一次坏体验固化 |
