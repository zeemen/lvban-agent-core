/**
 * 静默卡片的线上契约 —— 服务端与小程序共用这一份。
 *
 * 和 stream-events.ts 同一个理由：跨网络的契约没有自我纠正的机会。
 * 这张卡片漂移了的表现是「气泡上没字」或者「点一下没声音」，都不报错。
 *
 * 和那边的做法稍有不同：那边是服务端自己定义事件、再用一条编译期断言
 * 证明它仍满足这里的窄类型（因为事件里还套着 PlanDecision、ContextState
 * 这些服务端内部的大结构）。这张卡片四个字段全部跨网络，没有「服务端更丰富」
 * 的部分，所以直接单一来源：服务端 import 这里，不再自己写一份。
 *
 * 为什么放在 miniprogram/ 下而不是仓库根：微信开发者工具只打包
 * miniprogramRoot 以内的文件，小程序这边有硬约束，服务端没有。
 */

export type SilentCard = {
  readonly anchorId: string
  readonly name: string
  /** 气泡上那一句，来自锚点八要素的开场钩子 */
  readonly hint: string
  /** 点一下要播的音频键；只有 Top 30 预合成过，其余为 null */
  readonly audioKey: string | null
}
