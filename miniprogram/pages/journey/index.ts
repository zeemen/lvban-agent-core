import { config } from '../../config'
import type { LvbanClient } from '../../utils/api'
import { getClient, requireSession } from '../../utils/app-client'
import { createAudioQueue, wxAudioContextFactory, type AudioQueue } from '../../utils/audio'

/**
 * 行中页 —— M3 的主链路。
 *
 * 授权 → 开始旅程 → 到达点位 → 问一句（流式 + 垫音 + 语音）→ 结束旅程。
 *
 * 开发者工具里没有真实 GPS，所以点位用按钮模拟「走到这里」，
 * 走的仍是服务端真实的围栏判定（两次定位上报 + 去抖 + 最小停留）。
 */

type TrackConsent = 'none' | 'visited_points_only' | 'full_track'

type Line = {
  readonly kind: 'filler' | 'agent' | 'user' | 'system'
  readonly text: string
  readonly note?: string
}

type PageData = {
  consentGiven: boolean
  trackConsent: TrackConsent
  journeyId: string | null
  currentPoi: string | null
  currentPoiName: string
  lines: Line[]
  input: string
  busy: boolean
  timing: string
  ttsProvider: string
  pois: typeof config.pois
}

let client: LvbanClient | null = null
let audio: AudioQueue | null = null
let userId = ''

const CONSENT_LABELS: Record<TrackConsent, string> = {
  none: '本次不保存轨迹',
  visited_points_only: '仅保存访问点位',
  full_track: '保存完整轨迹',
}

Page<PageData, WechatMiniprogram.Page.CustomOption>({
  data: {
    consentGiven: false,
    // 规格 01 §2.3：默认不是「完整轨迹」，也不是「什么都不留」
    trackConsent: 'visited_points_only',
    journeyId: null,
    currentPoi: null,
    currentPoiName: '',
    lines: [],
    input: '',
    busy: false,
    timing: '',
    ttsProvider: '',
    pois: config.pois,
  },

  onLoad() {
    client = getClient()
    audio = createAudioQueue({
      createContext: wxAudioContextFactory,
      onError: (src) => {
        // 一段音频放不出来不该让对话中断，但要让人看见
        this.appendLine({ kind: 'system', text: `音频播放失败：${src}` })
      },
    })
  },

  onUnload() {
    audio?.destroy()
    audio = null
  },

  appendLine(line: Line) {
    this.setData({ lines: [...this.data.lines, line] })
  },

  onConsentChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ trackConsent: e.detail.value as TrackConsent })
  },

  onInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ input: e.detail.value })
  },

  /** 开始旅程：这是采集的唯一入口（规格 02 §1 Usage Mode Collection） */
  async onStart() {
    if (client === null || this.data.busy) return
    this.setData({ busy: true })
    try {
      // 登录放在这里：用户按下「开始」才去换 code（PRD U01：未授权可浏览不可开旅程）
      const session = await requireSession()
      userId = session.userId
      const journey = await client.startJourney({
        userId,
        mode: 'companion',
        party: 'solo',
        sceneId: config.sceneId,
        trackConsent: this.data.trackConsent,
      })
      this.setData({
        consentGiven: true,
        journeyId: journey.journeyId,
        lines: [{
          kind: 'system',
          text: `旅程已开始 · ${CONSENT_LABELS[this.data.trackConsent as TrackConsent]}`,
          note: '只有现在开始之后才会采集位置；随时可以结束并一键删除',
        }],
      })
    } catch (error) {
      this.appendLine({ kind: 'system', text: `开始失败：${(error as Error).message}` })
    } finally {
      this.setData({ busy: false })
    }
  },

  /**
   * 模拟走到某个点位。
   * 上报两次定位是为了满足服务端围栏的去抖与最小停留条件——
   * 这里不绕过服务端判定，否则测到的就不是真实链路。
   */
  async onArrive(e: WechatMiniprogram.BaseEvent<Record<string, never>, { id: string }>) {
    const poi = config.pois.find((p) => p.id === e.currentTarget.dataset.id)
    const journeyId = this.data.journeyId
    if (client === null || poi === undefined || journeyId === null || this.data.busy) return

    this.setData({ busy: true })
    try {
      const now = Date.now()
      await client.sendSignals(journeyId, [
        { lat: poi.lat, lng: poi.lng, accuracyM: 12, at: new Date(now).toISOString(), speedMps: 0.4 },
        { lat: poi.lat, lng: poi.lng, accuracyM: 14, at: new Date(now + 25_000).toISOString(), speedMps: 0.3 },
      ])
      const result = await client.arrive(journeyId, poi.id)
      this.setData({ currentPoi: poi.id, currentPoiName: poi.name })

      if (result.spoke && result.text !== null) {
        this.appendLine({ kind: 'agent', text: result.text, note: `到达 ${poi.name}` })
      } else {
        this.appendLine({
          kind: 'system',
          text: `到了${poi.name}，但旅伴选择不开口：${result.vetoedBy ?? result.proactivityReason}`,
        })
      }
    } catch (error) {
      this.appendLine({ kind: 'system', text: `到达失败：${(error as Error).message}` })
    } finally {
      this.setData({ busy: false })
    }
  },

  /** 问一句：流式 + 垫音 + 逐句语音 */
  onAsk() {
    const text = this.data.input.trim()
    const journeyId = this.data.journeyId
    if (client === null || text === '' || journeyId === null || this.data.busy) return

    this.appendLine({ kind: 'user', text })
    this.setData({ input: '', busy: true, timing: '' })

    const started = Date.now()
    let agentLineIndex = -1

    client.askStream(
      { journeyId, text, poiId: this.data.currentPoi ?? undefined },
      {
        onEvent: (event) => {
          if (event.type === 'filler') {
            // 垫音是本地预合成的：先播声音，再显示文字
            audio?.push(client!.audioUrl(event.audioKey))
            this.appendLine({
              kind: 'filler', text: event.text,
              note: `${Date.now() - started}ms · 预合成`,
            })
            return
          }

          if (event.type === 'sentence') {
            if (agentLineIndex < 0) {
              agentLineIndex = this.data.lines.length
              this.appendLine({ kind: 'agent', text: event.text, note: `第一句 ${event.atMs}ms` })
            } else {
              const lines = [...this.data.lines]
              const prev = lines[agentLineIndex]
              if (prev !== undefined) {
                lines[agentLineIndex] = { ...prev, text: `${prev.text}${event.text}` }
                this.setData({ lines })
              }
            }
            return
          }

          if (event.type === 'audio') {
            audio?.push(client!.audioUrl(event.audioKey))
            return
          }

          if (event.type === 'error') {
            this.appendLine({ kind: 'system', text: event.message })
            this.appendLine({ kind: 'agent', text: event.fallbackText })
            return
          }

          if (event.type === 'done') {
            const t = event.timing
            this.setData({
              timing: `垫音 ${t.fillerAtMs}ms · 首句 ${t.firstSentenceMs ?? '—'}ms`
                + ` · 首句语音 ${t.firstAudioMs ?? '—'}ms · 全部 ${t.totalMs}ms`,
              ttsProvider: t.ttsProvider ?? '未配置（只显示文字）',
            })
          }
        },
        onError: (message) => {
          this.appendLine({ kind: 'system', text: message })
          this.setData({ busy: false })
        },
        onComplete: () => this.setData({ busy: false }),
      },
    )
  },

  /** 结束旅程：规格 01 §7 要求这里必须能看到记了什么、并能一键删除 */
  async onEnd() {
    const journeyId = this.data.journeyId
    if (client === null || journeyId === null) return
    audio?.clear()
    try {
      await client.endJourney(journeyId)
      this.appendLine({ kind: 'system', text: '旅程已结束，行后蒸馏已排队' })
      this.setData({ journeyId: null, consentGiven: false })
      // 规格 01 §7.2：结束之后必须直接看到「记了什么」与一键删除，
      // 不能把回顾折叠进二级菜单。
      // 用 redirectTo 而不是 navigateTo：旅程已经结束，留在返回栈里的是一个
      // 被重置过的行中页，返回到它没有意义
      wx.redirectTo({ url: `/pages/travelogue/index?journeyId=${journeyId}` })
    } catch (error) {
      this.appendLine({ kind: 'system', text: `结束失败：${(error as Error).message}` })
    }
  },

  async onDelete() {
    const journeyId = this.data.journeyId
    if (client === null || journeyId === null) return
    const confirm = await wx.showModal({
      title: '删除本次记录',
      content: '这次旅程的点位、提问与足迹都会被删除，不可恢复。',
      confirmText: '删除',
      confirmColor: '#b4472a',
    })
    if (!confirm.confirm) return
    await client.deleteJourney(journeyId)
    this.setData({ journeyId: null, consentGiven: false, lines: [], currentPoi: null })
  },
})
