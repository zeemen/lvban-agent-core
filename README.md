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

## 还没做

- **真实模型**：当前只有 mock 适配器。接通义千问 / 豆包 / DeepSeek = 在 `src/models/` 下新增一个实现 `ModelAdapter` 的文件并注册。
- **锚点内容**：只录了 2 个样例锚点（江南贡院号舍、错金银重络铜壶），且审校状态为 `draft`。南博 18 件 / 夫子庙 12 处的最终名单待内容负责人核定，选点标准见规格 04 §4.3。
- **围栏坐标**：`content/geofences/fuzimiao.json` 里是占位值，`calibrated: false`。必须按规格 02 §9.3 现场实测后替换。
- **小程序前端**：M3。
- **ASR / TTS、兑换码、大使后台、运营后台**：按规格 04 排期。

## 环境

Node 22+、pnpm、Docker。数据库端口有意避开默认值（Postgres `55432`、Redis `56379`），避免与本机已有实例冲突；见 `.env.example`。
