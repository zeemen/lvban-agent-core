# 旅伴 Agent Core

> 一个陪你走遍中国的 AI Agent · M2 引擎骨架

本仓库是《AI旅伴 · 产品企划书 v1.2》的工程实现。当前进度 **M2：Context Engine + Memory + Planner 端到端跑通**（无小程序界面）。

## 目录

| 路径 | 内容 |
|---|---|
| [`specs/`](specs/README.md) | 四份技术规格 V1.0 —— 代码的唯一依据 |
| `src/memory/` | 规格 01：四层记忆、写入网关、蒸馏、检索 |
| `src/context/` | 规格 02：Journey 状态机、围栏、Context State、主动性引擎 |
| `src/planner/` | 规格 03：Explanation Planner、口吻守卫 |
| `src/models/` | 规格 03 §7：Model Router（当前为 mock 适配器） |
| `src/vision/` | 规格 02 §4：视觉锚点与命中率熔断 |
| `src/content/` | 锚点八要素、围栏定义、内容静态检查 |
| `content/` | 锚点与围栏的内容文件（JSON） |
| `*.html` `*.md`（根目录） | 企划书与早期材料 |

## 快速开始

```bash
pnpm install
node --run db:up        # 起 Postgres 16 + pgvector + Redis（Docker）
node --run db:migrate
node --run seed
node --run cli demo     # 端到端验证：同一点位第一次 vs 第二次的讲法差异
```

交互式对话：

```bash
node --run cli chat
```

HTTP 服务（M3 小程序将接这一套接口）：

```bash
node --run start
```

## 验证

```bash
node --run typecheck
node --run lint:content   # 锚点内容的口吻与证据检查
node --run test
node --run coverage
```

当前：169 个测试，行覆盖 95.7%，分支覆盖 83.2%。

## M2 做到了什么

`node --run cli demo` 跑的是规格 04 §3.4「第二次使用时的分水岭」，也是假设 H5 的验证路径：

```
第 1 次到江南贡院   开场=question      记忆线索=（空）
                   ↓ 两次关于科举的提问 → 行后蒸馏
                   ↓ topic_interest=科举 升为 active 偏好
第 2 次到江南贡院   开场=memory_link   记忆线索=南京·江南贡院·科举
                   讲解不重复，改讲故事与当下连接
```

锚点命中的讲解**零模型调用**（走人工精调内容），只有自由提问才走 Model Router——这是规格 03 §7.2 的缓存策略，成本与首句延迟同时受控。

## 四条硬约束的执行点

规格里是红线，代码里是具体位置，不靠调用方自觉：

| 红线 | 执行点 |
|---|---|
| 系统推断不进长期记忆 | `src/memory/gateway.ts` 的 source 分流；`preference.source` 枚举在 schema 层就不含 `system_inferred` |
| 没有 open 的 Journey 就没有采集 | `gateway.ts` 的 journey 校验 + `context/journey.ts` 状态机 |
| 室内不伪造精确位置 | `location_event.source` 约束 + `src/vision/anchor.ts` 的候选集约束识别 |
| 商户不进讲解 | `planner/decide.ts` 的 `PlanInput` 里结构上没有商户字段 |

对应的测试在 `tests/integration/gateway.test.ts`，包括「绕过网关直接写库也会被数据库约束拦住」。

## 接真实模型

三家国内供应商（通义千问 / 豆包 / DeepSeek）都提供 OpenAI 兼容的 chat completions 接口，
所以这里是**一个适配器 + 一张供应商档案表**（`src/models/providers.ts`），不是三个适配器。

```bash
node --run models:probe                 # 不带 Key：列出三家的档案与接入要点
# 在 .env 里设 MODEL_PROVIDER 与对应的 Key，然后：
node --run models:probe                 # 带 Key：列出账号可用模型 + 逐任务连通性
node --run models:probe <图片路径>       # 单独测视觉链路的候选集约束识别
```

**模型 ID 刻意不写死。** 核实档案时发现 DeepSeek 官方文档已把 `deepseek-chat` 换成
`deepseek-flash` / `deepseek-v4-pro`，旧名虽被接受但模型已下线——模型 ID 的变动频率
远高于代码发布频率。所以档案里的只是「上次核实时的默认值」，一律可用
`MODEL_ID_<TASK>` 覆盖，并用 probe 去问供应商本人。火山引擎方舟必须逐项配置，
因为它的 `model` 字段填的是账号自己的推理接入点 ID（`ep-xxxx`）。

**视觉能力是模型的属性，不是供应商的属性。** 同一个 DeepSeek 账号，
`deepseek-flash` 接受图像输入，`deepseek-v4-pro` 不接受。所以判定按模型 ID 做
（`resolveVision`），而不是给供应商打一个布尔值。方舟的接入点 ID 不透明，
判定为「允许尝试但不确定」，由实际调用暴露问题。

**视觉不可用时降级，不抛错。** 规格 02 §4 的「拍一下 / 问一句」双入口里，
「拍一下」依赖 VLM。模型选错、没配 `MODEL_ID_VISION`、或者缺 Key 这三种
「配置根本不可能成功」的情况，都会让 `decideVisionAnchor` 返回
`fallback_ask` + `fallbackActive: true` + 可读的 `fallbackReason`，
走的是和 §4.3 命中率熔断同一条降级路径——而不是在用户按下快门之后才报错。

**按任务分供应商。** `MODEL_PROVIDER_VISION` 等变量可以让文本走一家、视觉走另一家
（例如文本 DeepSeek + 视觉 `qwen-vl-max`），这本来就是规格 03 §7「不绑定单一模型」的要求。

**价格没核实就不写。** 第三方来源互相矛盾的价格一律不入代码；没有 pricing 的档案，
账本只统计 token 数、`costCny` 返回 `null`，并在 `unpricedCalls` 里计数。
宁可没有数字，不要有错的数字。DeepSeek 还分高峰/空闲时段计价（空闲为高峰一半），
这恰好说明静态价格表必然有一半时间是错的。

Key 到位后的验收：

```bash
PROBE_PROVIDER=deepseek npx vitest run tests/integration/adapter-contract.test.ts
```

`tests/integration/adapter-contract.test.ts` 里那套契约断言会同时跑 mock 和真实供应商
（没配 `PROBE_PROVIDER` 时自动跳过真实那组）。测试进程默认把 `MODEL_PROVIDER` 钉成
`mock`，所以常规 `node --run test` **不会**去打收费接口，也不会因为谁改了 `.env` 而行为不同。

### DeepSeek 实测结论（2026-10-25）

账号可用模型就是 `deepseek-flash` 与 `deepseek-v4-pro` 两个，与文档一致。

**两个模型都是推理模型**，这件事对本产品有三层影响：

1. **思维链 token 算在 `max_tokens` 里，且计费。** 回一句「收到」用掉 31–47 个输出
   token，其中 94% 以上是思维链；JSON 规划调用约 104 推理 token。所以规格 03 §2 的
   分龄长度（低龄 90 token）不能直接当 `max_tokens` 发出去——否则预算被看不见的推理
   吃光，`content` 为空、`finish_reason=length`。适配器现在把「回答长度」和「推理余量」
   分开（`budgetWithReasoning`），并把空回答识别为 `truncated` 错误而不是静默返回空串。
2. **延迟曾远超预算，已解决**——见下一节。
3. **成本模型要把思维链算进去。** 账本的 `reasoningTokens` 单独记账，`unpricedCalls`
   统计因价格未核实而无法计价的调用数。

**输出形态必须在 prompt 里显式约束。** 不加约束时 `deepseek-flash` 会输出 3–4 段带
空行的聊天体；这是语音优先的产品（规格 03：语音流、锁屏可听），分段加空行既不像
「一个人在你旁边说话」，TTS 念出来也很怪。现在 system prompt 明确要求「只说一段话、
不分段、不空行、不用 Markdown」，实测输出降到 132–162 字的单段口语。

**没有 embedding 模型。** 规格 01 §5.3 的记忆检索最终要用向量相似度，目前用主题
重叠度代替，不阻塞；真要上 embedding 需另配一家。

## 延迟：从 3.7 秒到感知零延迟

最初实测首个正文 delta 要 3718ms（最差一次 10.7s），而规格 03 §7 给 qa 的预算是
1200ms。拆开测之后发现**流式输出并不是答案**：推理模型先流 252–432 字的思维链、
再流正文，所以开着思考做流式，用户仍要等 3.4–6.6 秒才听到第一个字。

真正的杠杆是三层叠加，按贡献排序：

| 手段 | 作用 | 实测 |
|---|---|---|
| **按任务关深度思考** | 对话类任务不需要思维链 | 首个正文 delta 3718ms → 1017ms |
| **流式 + 增量分句** | 第一句凑齐就送 TTS，不等整段 | 第一句 1412ms（整段 2023ms） |
| **预置垫音** | 本地预合成音频盖住剩下那一秒 | 用户听到声音 **6–7ms** |

```
改造前   [...........静默 3718ms...........] 第一个字
改造后   [垫音 7ms]→「等我想想怎么说。」→[1412ms] 第一句进 TTS
```

关思考用的是 `thinking: {type: 'disabled'}`（档案里的 `thinking` 字段，每家写法不同），
并用 `usage.reasoning_tokens` 核实过确实归零。策略按任务分：`intent/qa/copy` 关、
`planner` 保留（规格 03 §7 要求深度解释规划用强推理，且它不在用户等待的关键路径上），
可用 `MODEL_THINKING_<TASK>=on|off` 覆盖。

**一个必须说明的取舍：流式路径做不了「口吻守卫命中就重写」**——第一个字送出去就收不回来。
所以流式下守卫只作遥测，预防完全交给 system prompt（两条路径共用
`src/agent/prompt.ts` 的同一份，避免漂移）。需要强校验的行后生成（游记、研学报告）
继续走非流式的 `onQuestion`，那条路径保留重写。

**垫音不是「假装在思考」的话术**：台词短（≤20 字）、不承诺内容、说完直接接正文，
按口吻和场景分组存在 `content/fillers/`，同一条不会连着出现两次。
音频是预合成的固定 MP3（与规格 03 §7.2 的锚点开场缓存同源），接 TTS 之前
前端可以只显示文字。

## 语音链路

```bash
node --run tts:presynth     # 预合成垫音与 Top 30 锚点开场段
```

TTS 不走 Model Router，是**独立的 `TtsAdapter` 契约**——各家协议差异太大，
硬塞进 OpenAI 兼容的那套只会让两边都变形。首选**腾讯云**：首发是微信小程序，
同生态下延迟、计费、备案以及后续的 ASR / COS 都走同一套账号体系。
火山引擎的适配器保留，便于后续 A/B 音质。

### 腾讯云（默认）

鉴权是 **TC3-HMAC-SHA256 签名**，不是简单 token。签名器在 `src/tencent/sign.ts`，
后续 ASR、COS 复用同一份。签名算错时服务端只回一句 `AuthFailure.SignatureFailure`，
所以官方文档里那两个**可离线验证的中间值**（规范请求哈希、载荷哈希）被锁成了测试向量——
这保证了 Key 到位时要么直接通，要么问题一定不在签名上。

三个会静默失败的细节（都有测试覆盖）：

1. 签名里的 `x-tc-action` **必须小写**，发出去的 `X-TC-Action` 保持原样。
2. 日期必须按 **UTC** 取，用本地时区在东八区会跨天签错；时间戳要在服务端 5 分钟内。
3. **业务错误也是 HTTP 200**，塞在 `Response.Error` 里。音色没授权会返回
   200 + `InvalidParameterValue.VoiceType`，只判 `response.ok` 会把它当成功。

两个与火山不同、影响上游设计的约束：

- **文本上限 150 汉字**（火山是 300）。分句器按适配器的 `maxChars` 兜底切分，
  超长且迟迟没有句末标点时在逗号处强制断开，否则整句会被拒绝、用户什么都听不到。
- **语速是档位 `[-2, 6]` 而不是倍率**。契约里统一用倍率（1.0 = 正常），
  适配器按文档的三个锚点（-2≈0.6x、0=1.0x、6≈2.5x）线性插值换算——
  官方没公布完整曲线，这是近似，调音色时以实听为准。

### 缓存

缓存是成本与延迟的主要手段（规格 03 §7.2）。固定台词——垫音、Top 30 锚点的开场段
——每个用户听到的都一样，一次合成永久复用：现场零延迟、零成本、不受网络抖动影响。
动态句子按内容寻址缓存（文本 + 音色 + 语速 + 编码的哈希），改了音色自然产生新 key。
`audio-cache/` 不入库，随时可由 `tts:presynth` 重建。

固定台词的路径是稳定的（`fillers/peer_q_01.mp3`），路径里**不含**供应商和音色，
所以单看「文件在不在」会掉进一个静默的坑：用 mock 预合成过一轮再换上真供应商，
presynth 会全部跳过，线上播的是假音频且不报错。`audio-cache/manifest.json`
记下每条音频是用谁、什么音色、什么语速、什么文案合成的，任何一项对不上就重新合成
并说明原因（`↻ 重合成 …：供应商变了（mock → tencent）`）。

### 音频投递

音频不内联在 SSE 里：`filler` 和 `audio` 事件只带 `audioKey`，客户端去
`GET /v1/audio/<key>` 取（带 `immutable` 长缓存头，生产由 CDN 接管）。
这条路由对 key 做了路径穿越校验——key 来自客户端。

TTS 未配置时降级为只显示文字，不发 `audio` 事件、不报错，与视觉链路同一思路。

## 还没做

- **TTS 真实音色实测**：链路已通（见下节），但还没用真实 Key 跑过——
  音色代号、合成延迟、成本都待实测。
- **ASR**：语音输入尚未接入。
- **锚点内容**：只录了 2 个样例锚点（江南贡院号舍、错金银重络铜壶），且审校状态为 `draft`。南博 18 件 / 夫子庙 12 处的最终名单待内容负责人核定，选点标准见规格 04 §4.3。
- **围栏坐标**：`content/geofences/fuzimiao.json` 里是占位值，`calibrated: false`。必须按规格 02 §9.3 现场实测后替换。
- **小程序前端**：M3。
- **兑换码、大使后台、运营后台**：按规格 04 排期。

## 环境

Node 22+、pnpm、Docker。数据库端口有意避开默认值（Postgres `55432`、Redis `56379`），避免与本机已有实例冲突；见 `.env.example`。
