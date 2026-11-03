# 旅伴 Agent Core

> 一个陪你走遍中国的 AI Agent · M2 引擎骨架

本仓库是《AI旅伴 · 产品企划书 v1.2》的工程实现。当前进度 **M2：Context Engine + Memory + Planner 端到端跑通**（无小程序界面）。

## 目录

| 路径 | 内容 |
|---|---|
| [`specs/`](specs/README.md) | 四份技术规格 V1.0 —— 代码的唯一依据 |
| [`docs/技术框架-V1.0.md`](docs/技术框架-V1.0.md) | 分层与边界、四种契约、降级矩阵、已知架构缺口 —— 规格之下已经立起来的那套结构 |
| `src/memory/` | 规格 01：四层记忆、写入网关、蒸馏、检索 |
| `src/context/` | 规格 02：Journey 状态机、围栏、Context State、主动性引擎 |
| `src/planner/` | 规格 03：Explanation Planner、口吻守卫 |
| `src/models/` | 规格 03 §7：Model Router（当前为 mock 适配器） |
| `src/vision/` | 规格 02 §4：视觉锚点与命中率熔断 |
| `src/content/` | 锚点八要素、围栏定义、内容静态检查 |
| `content/` | 锚点与围栏的内容文件（JSON） |
| [`content/supply-chain-contract.md`](content/supply-chain-contract.md) | 知识库供应链中台的交付契约：产什么、按什么验收、`approved` 怎么才算真的签了 |
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

当前：783 个测试通过、5 个跳过，行覆盖 92.9%，分支覆盖 86.7%。
覆盖率阈值写在 `vitest.config.ts`（行 80 / 函数 80 / 分支 75 / 语句 80），
`node --run coverage` 会卡住它。

> **新克隆的仓库要先 `node --run tts:presynth`。**
> `tests/integration/miniprogram-e2e.test.ts` 有一条要取回垫音的音频字节，
> 它读 `audio-cache/`——那个目录是 gitignored 的（按内容寻址，随时可重建），
> 缺了的话取音频的路由直接回 404，那条用例就红。不配 TTS Key 时
> `ttsProvider()` 默认 mock，照样合成得出来。CI 里就是这么做的。

两个工作流：[`content-gate.yml`](.github/workflows/content-gate.yml)
是内容 PR 的进料检查（约 1 秒，不依赖任何服务与密钥）；
[`full-suite.yml`](.github/workflows/full-suite.yml) 带 Postgres + Redis
服务容器，跑迁移、全量用例与覆盖率阈值。

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
| 室内不伪造精确位置 | `location_event.source` 约束 + `src/vision/anchor.ts` 的候选集约束识别；`context/provenance.ts` 判定来源与置信度（室内只认游客的动作，不报就是「不知道」），`context/attention.ts` 负责落位、校验与撤回（落位的 id 必须能被应答路径同一个 `anchorForPlace` 取到，且锚点场景与旅程一致，否则拒写）|
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

## 小程序（M3）

```
miniprogram/
  shared/stream-events.ts   SSE 线上契约，服务端反向引用它做编译期防漂移
  utils/utf8.ts             增量 UTF-8 解码
  utils/sse.ts              SSE 帧解析
  utils/api.ts              类型化 API 客户端（request 可注入）
  utils/audio.ts            顺序音频队列
  pages/journey/            行中页：授权 → 开始 → 到达 → 问一句 → 结束
```

**框架选了原生小程序 + TypeScript**，不是 Taro / uni-app。决定性理由是风险位置：
`onChunkReceived` 是 `RequestTask` 上的方法，封装层未必稳定暴露它，而这个产品的
核心交互全压在原生能力上（定位围栏、相机、录音、后台音频、流式）。

### 流式：小程序没有 EventSource

唯一可行路径是 `wx.request({ enableChunked: true })` 配
`RequestTask.onChunkReceived`（基础库 **2.20.2+**），拿到的是 **ArrayBuffer 分片**。
服务端的 SSE 格式不用改，解析全在客户端，分四层，每层都要能处理跨分片切断：

```
ArrayBuffer 分片 → 增量 UTF-8 解码 → SSE 帧解析 → 类型化事件
```

**第一层是必然踩的坑**：中文一个字 3 字节，分片切在字正中间是常态不是边缘情况；
而小程序运行时不是浏览器，没有全局 `TextDecoder`。所以 `utf8.ts` 自己实现了
增量解码：每次只解码「完整字符」的部分，残缺尾巴留到下一片拼上。
测试覆盖了 1/2/3/5/17/64 字节等各种分片大小，以及故意切在字中间的情形。

基础库低于 2.20.2 时拿不到 `onChunkReceived`，客户端会明确报错而不是静默无声。

### 防契约漂移

`miniprogram/shared/stream-events.ts` 是服务端与小程序共用的线上契约，
服务端有一条编译期断言保证它发出的事件仍满足契约：

```ts
type _WireContractHolds = [StreamedEvent] extends [WireEvent] ? true : never
```

用元组包裹是必要的——裸的 `A | B extends C` 会逐成员分发，只要有一个成员满足
结果就含 `true`，断言会形同虚设。跨网络的契约漂移在运行时只表现为
「有时候没声音」，极难查，所以这条断言值得写对。

契约文件放在 `miniprogram/` 下而不是仓库根：微信开发者工具只打包
`miniprogramRoot` 以内的文件，小程序这边有硬约束，服务端没有。

### 本地联调

```bash
node --run start          # 服务端 :8791
node --run dev            # 同上，但 tsx watch，改了代码自动重起
```

`node --run start` 不是 watch 模式：改了 `src/` 下的代码必须把它重启，
不然接口还在跑旧代码。这个症状很会骗人——加 `profileCompleted` 字段那次，
测试全绿、迁移也 apply 了，curl 回来却没这个字段，看起来像迁移没生效，
其实是进程没换。边改边联调就用 `node --run dev`。

改了 `migrations/` 之后要 `node --run db:migrate`。迁移改的是库、代码改的是读法，
两边都得动：只跑迁移，接口不会多出新字段；只改代码，查询会撞上不存在的列。

端口用 8791 而不是常见的 8787：本机常有别的服务占着 127.0.0.1:8787。
两个进程能同时绑同一端口号（一个 `*:8787`、一个 `127.0.0.1:8787`），
而 `localhost` 命中更具体的那个——表现是请求被不相干的服务接走，
返回它自己的错误码，看起来却像我们的接口坏了。换端口前先
`lsof -nP -iTCP:<port> -sTCP:LISTEN` 确认干净。

开发者工具导入 `miniprogram/` 目录，在「详情 → 本地设置」勾选
**不校验合法域名**，否则 `http://localhost` 会被拦。上线前 `config.ts` 的
`baseUrl` 必须换成已在小程序后台配置的 HTTPS request 合法域名。

开发者工具里没有真实 GPS，行中页用按钮模拟「走到这里」——但走的仍是服务端
真实的围栏判定（两次定位上报 + 去抖 + 最小停留），不绕过。

## 页面与接口

五个页面：

| 页面 | 做什么 | 主要接口 |
|---|---|---|
| 首页 | 选场景、继续未完成的旅程、进入其余页面 | `GET /me/journeys` |
| 行前建档 | 三个问题（年龄段 / 怎么逛 / 语音还是文字），可跳过 | `GET`、`PUT /me/profile` |
| 行中 | 授权 → 开始 → 到达点位 → 问一句（流式+垫音+语音）→ 结束 | 见上文流式一节 |
| 行后游记 | 正文、足迹时间线、史实出处、待确认偏好 | `GET /v1/journeys/:id/travelogue` |
| 我的记忆 | 分层展示，每条可问「为什么」、可改可删，可导出可清空 | `/me/memory/*` |

几处值得单独说明：

- **wx.request 没有 PATCH**。合法值只有 OPTIONS/GET/HEAD/POST/PUT/DELETE/TRACE/CONNECT，
  所以规格里写 PATCH 的两个接口同时开了 PUT，小程序走 PUT。
  同理「清空全部」的确认标记走查询串而不是请求体——文档只定义了 GET 与 POST 的 data 转换规则。
- **建档的「跳过」是真跳过**：不写任何值，保留服务端已有档案。
  写入默认值会让「选了 19_24」和「没答」变得无法区分。
  同一个原因，「这人建过档吗」不能靠看值猜——三问都有数据库默认值，
  选了 companion 和从没打开过建档页在库里长得一样。
  所以 `app_user.profile_updated_at`（迁移 003）只在三问之一真的答了时写入，
  `GET /me/profile` 以 `profileCompleted` 返回；行前提示要不要出现只看这一位。
- **建档选的东西在行中真的生效**：开旅程用档案里的 `defaultMode`
  （它会改变 `proactivity` 的开口阈值与 `planner` 的口吻档位，不只是 prompt 里一句话），
  选了「只看文字」就不把音频排进播放队列。
  档案读不到或遇到本版本不认识的模式时回落 `companion` 并在界面上说明——
  建档可跳过，不该成为开不了旅程的理由。
  行前提示只提一次，说过「先不用」就记在本机不再提。
- **游记不许编造经历**。史实只取已审校锚点是规格 04 §7.1 的硬约束；
  在此之上还禁止虚构地点、动线、天气、同行人和用户的感受，
  并且篇幅跟着素材量走——实测不加这层约束时，一句原话会被扩写成 400 多字虚构的一天。
- **回顾页交代本次记了什么**，并带一键删除（规格 01 §7.2 明写这个入口
  不允许折叠在二级菜单里）。本次新记住的偏好当场列出，每条可以点「这不对」撤掉。
- **推断出来的偏好默认不记**。网关会把 `system_inferred` 分流到 L0，游记页
  列出来让用户确认，确认后才以 `user_confirmed` 升 L2（规格 01 D2）。
  **注意：目前没有任何代码产生 `system_inferred` 候选**，所以这一段在界面上
  始终是空的——闸门和确认入口都已就位，等接入推断逻辑时自动生效。
  另外 L0 有 24 小时 TTL，隔天再打开游记时这些候选已经过期，这是有意的。
- **删除会级联**：删掉一条偏好后，由它支撑的身份特征跟着重算或移除（规格 01 §7.1）。
  标过「这不对」的偏好不会被后续蒸馏复活。

## 登录与鉴权

```
小程序                        服务端                    微信
  wx.login() ──code──▶ POST /v1/auth/wx-login
                              ├─ GET /sns/jscode2session ──▶
                              │   ◀── openid (+unionid)
                              ├─ upsert app_user
                              └─ 签发会话令牌（Redis，30 天滑动续期）
  ◀── { userId, token } ──────┘
  之后每个请求带 Authorization: Bearer <token>
```

要点：

- **只取 openid**（PRD U01）。不索取手机号，`session_key` 拿到即丢弃——
  不解密任何加密数据就不需要持有它，少存一个凭证少一处泄漏面。
- **令牌存的是 SHA-256 哈希**，不是令牌本身。Redis 被读走也不能直接冒用。
- **身份以令牌为准**，不信请求体里的 `userId`。否则填别人的 UUID
  就能读到别人的记忆——对一个主打青少年记忆的产品这是红线。
  旅程接口同样校验归属：拿到 `journeyId` 也驱动不了别人的行程。
- **`wx.login` 只在用户真要登录时调**，不在 `onLoad` 预取。
  code 一次性且约 5 分钟过期，预取的 code 等用户点下按钮时多半已经废了（errcode 40029）。
- **`AUTH_REQUIRED`** 不设时跟着 `WX_APPSECRET` 走。开启后 `/v1/dev/users`
  返回 404——它是无需凭证凭空造身份的后门，不能和强制鉴权并存。

## 还没做

- **TTS 真实音色实测**：链路已通（见下节），但还没用真实 Key 跑过——
  音色代号、合成延迟、成本都待实测。
- **ASR**：语音输入尚未接入。
- **锚点内容**：只录了 4 个锚点（江南贡院号舍、错金银重络铜壶、竹林七贤与荣启期砖画、江南贡院明远楼），审校状态都是 `draft`，四条都没过规格 03 §9.2 的双签。M1 门槛是 30 个。南博 18 件 / 夫子庙 12 处的最终名单待内容负责人核定，选点标准见规格 04 §4.3。
  2026-10-31 定：语料与锚点的产出都移交给单独开发的「知识库供应链中台系统」，
  这个目录将退成下游副本——交付面、验收规则、以及会因此坏掉的对账流程见
  [`content/supply-chain-contract.md`](content/supply-chain-contract.md)。
- **`nextAction` 还没有消费方**：Planner 会算出 `decision.nextAction`（锚点的
  `nextAction.suggest`），但没有任何地方读它，所以「下一站」目前到不了用户。
  `lint:content` 的 `next_action/dangling` 只报警告就是这个缘故——这一栏指错了
  今天也到不了用户，但接上之前得是干净的。
- **围栏坐标**：`content/geofences/fuzimiao.json` 里是占位值，`calibrated: false`。必须按规格 02 §9.3 现场实测后替换。
- **微信登录的真机实测**：链路已通（`wx.login` → `/v1/auth/wx-login` → `code2session`），
  但还没用真实 appsecret 跑过。配 `WX_APPID` / `WX_APPSECRET` 即生效，
  未配时自动回落到 `/v1/dev/users`。
- **真机实测**：目前只在 Node 里用真实 HTTP 分片验证过解析链路，
  还没在开发者工具和真机上跑过——`onChunkReceived` 的真机表现、
  音频队列的后台播放、定位权限弹窗都待实测。
- **游记的内容基础**：锚点审校状态还是 `draft`，所以游记里不会出现任何史实
  （这是规格 04 §7.1 的硬约束，不是 bug）。内容过审后自动生效。
  2026-10-31 起 `approved` 不再是一句自我声明：schema 要求 `YYYY-MM-DD`
  审校日期、待核清单清空，以及**双签两方各一个中台账号**
  （`{ role, account }`，`role` 是 `content_owner` / `history_advisor`，
  `account` 是中台规范化后的邮箱，2026-11-01 定），不满足就加载失败
  （`src/content/loader.ts` 的 `reviewSchema`）。锚点改由中台产出之后，
  这一栏是上游唯一能打开的闸，不能只靠自觉。
- **兑换码、大使后台、运营后台**：按规格 04 排期。

## 环境

Node 22+、pnpm、Docker。数据库端口有意避开默认值（Postgres `55432`、Redis `56379`），避免与本机已有实例冲突；见 `.env.example`。
