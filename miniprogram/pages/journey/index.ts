import { SCENES, config, sceneById, type ScenePoi } from '../../config'
import {
  nextStep, openSample, pickedOutcome, rejectedAllOutcome,
  settleOnCorrection, settleOnMoveOn,
  type PendingSample, type VisionAnchorResponse, type VisionCandidate,
} from '../../shared/vision-flow'
import type { ArriveResult, DeclaredPlace, HitRateReport, LvbanClient, Profile } from '../../utils/api'
import { currentSession, getClient, requireSession } from '../../utils/app-client'
import { createAudioQueue, wxAudioContextFactory, type AudioQueue } from '../../utils/audio'
import { wxStorage } from '../../utils/auth'
import { capturePhoto, wxPhotoDeps } from '../../utils/photo'
import {
  createNudgeStore, journeyModeFrom, modeLabel, shouldSuggestProfile,
  voiceEnabledFor, type NudgeStore,
} from '../../utils/preferences'

/**
 * 行中页 —— M3 的主链路。
 *
 * 授权 → 开始旅程 → 到达点位 / 拍一下 → 问一句（流式 + 垫音 + 语音）→ 结束旅程。
 *
 * 室外（夫子庙）靠围栏：开发者工具里没有真实 GPS，所以点位用按钮模拟
 * 「走到这里」，走的仍是服务端真实的围栏判定（两次定位上报 + 去抖 + 最小停留）。
 *
 * 室内（南博）不做空间定位（规格 02 §4.4）：不问「人在哪」，只问「在看哪件」，
 * 所以这里没有坐标模拟，进点位靠「拍一下」（§4.2，PRD U07）。
 */

type TrackConsent = 'none' | 'visited_points_only' | 'full_track'

type Line = {
  /** card 是规格 02 §7.1 的静默卡片：不出声，点一下才播 */
  readonly kind: 'filler' | 'agent' | 'user' | 'system' | 'card'
  readonly text: string
  readonly note?: string
  /** 只有 card 有：点一下要播的音频键。非 Top 30 锚点没有预合成，就不显示播放 */
  readonly audioKey?: string
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
  sceneId: string
  sceneName: string
  indoor: boolean
  pois: readonly ScenePoi[]
  /** ask_user_pick：候选交给用户点，不替他选第一个 */
  picks: readonly VisionCandidate[]
  /** auto_accept 之后留着的纠正入口（PRD U07「识别结果可纠正」） */
  correctable: boolean
  /** 命中率跌破阈值：主入口让位给「问一句」（规格 02 §4.3） */
  fallbackActive: boolean
  fallbackHint: string
  profileLoaded: boolean
  profileHint: string
  suggestProfile: boolean
  modeName: string
  voiceOn: boolean
}

let client: LvbanClient | null = null
let audio: AudioQueue | null = null
let userId = ''
let profile: Profile | null = null
let nudge: NudgeStore | null = null
/** 挂起的命中率样本：一次识别只结算一次，见 shared/vision-flow.ts */
let pendingSample: PendingSample = null

const CONSENT_LABELS: Record<TrackConsent, string> = {
  none: '本次不保存轨迹',
  visited_points_only: '仅保存访问点位',
  full_track: '保存完整轨迹',
}

const FALLBACK_SCENE = SCENES[0] as (typeof SCENES)[number]

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
    sceneId: FALLBACK_SCENE.id,
    sceneName: FALLBACK_SCENE.name,
    indoor: FALLBACK_SCENE.indoor,
    pois: FALLBACK_SCENE.pois,
    picks: [],
    correctable: false,
    fallbackActive: false,
    fallbackHint: '',
    profileLoaded: false,
    profileHint: '',
    suggestProfile: false,
    modeName: '',
    // 档案读到之前按服务端的默认值（念给我听）
    voiceOn: true,
  },

  onLoad(query: Record<string, string | undefined>) {
    client = getClient()
    nudge = createNudgeStore(wxStorage())
    const scene = sceneById(query.sceneId ?? config.defaultSceneId) ?? FALLBACK_SCENE
    this.setData({
      sceneId: scene.id, sceneName: scene.name,
      indoor: scene.indoor, pois: scene.pois,
    })
    audio = createAudioQueue({
      createContext: wxAudioContextFactory,
      onError: (src) => {
        // 一段音频放不出来不该让对话中断，但要让人看见
        this.appendLine({ kind: 'system', text: `音频播放失败：${src}` })
      },
    })
  },

  onShow() {
    // 不是 onLoad：从建档页改完回来要立刻反映出来
    void this.loadProfile()
  },

  onUnload() {
    audio?.destroy()
    audio = null
  },

  /**
   * 读档案，决定这次用哪副面孔、放不放声音（PRD U02）。
   * 没登录就不读（PRD U01：未授权可浏览）；读不到也不算失败——
   * 建档本来就可以跳过，回落到默认值继续走，但要说出来，
   * 否则用户会以为自己建档选的生效了。
   */
  async loadProfile() {
    if (currentSession() === null) return
    try {
      profile = await getClient().getProfile()
      this.setData({ profileHint: '' })
    } catch (error) {
      profile = null
      this.setData({ profileHint: `读不到你的档案，这次先按默认的来：${(error as Error).message}` })
    }
    this.setData({
      profileLoaded: profile !== null,
      modeName: modeLabel(journeyModeFrom(profile)),
      voiceOn: voiceEnabledFor(profile),
      suggestProfile: shouldSuggestProfile(profile, nudge?.dismissed() ?? false),
    })
  },

  /** 「先不用」：这台设备上不再提，但默认值是什么要接着给他看 */
  onDismissProfileNudge() {
    nudge?.dismiss()
    this.setData({ suggestProfile: false })
  },

  onEditProfile() {
    wx.navigateTo({ url: '/pages/profile/index' })
  },

  /** 建档里选了「只看文字」就不排队播——文字照常显示 */
  playAudio(audioKey: string) {
    if (!this.data.voiceOn || client === null) return
    audio?.push(client.audioUrl(audioKey))
  },

  /**
   * 点开静默卡片。
   *
   * 刻意要用户自己点：SOFT_HINT 的全部意义就是没打断他——
   * 到了这一步还自动播，等于把这一档变回 SPEAK。
   */
  onPlayCard(e: WechatMiniprogram.BaseEvent<Record<string, never>, { key: string }>) {
    const key = e.currentTarget.dataset.key
    if (key) this.playAudio(key)
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
      // 页面打开时可能还没登录，档案要等到这一刻才读得到
      if (profile === null) await this.loadProfile()
      const mode = journeyModeFrom(profile)
      const journey = await client.startJourney({
        userId,
        mode,
        party: 'solo',
        sceneId: this.data.sceneId,
        trackConsent: this.data.trackConsent,
      })
      this.setData({
        consentGiven: true,
        journeyId: journey.journeyId,
        lines: [{
          kind: 'system',
          text: `${this.data.sceneName} · 旅程已开始 · ${modeLabel(mode)}`
            + ` · ${CONSENT_LABELS[this.data.trackConsent as TrackConsent]}`,
          note: this.data.indoor
            ? '室内不定位，也不猜你在哪：拍一下你正在看的那件，或者直接问我一句'
            : (this.data.voiceOn
              ? '只有现在开始之后才会采集位置；随时可以结束并一键删除'
              : '按你建档选的只显示文字、不放声音；位置也只在现在之后才采集'),
        }],
      })
      void this.refreshHitRate()
    } catch (error) {
      this.appendLine({ kind: 'system', text: `开始失败：${(error as Error).message}` })
    } finally {
      this.setData({ busy: false })
    }
  },

  /**
   * 识别命中率低于阈值就把主入口让给「问一句」（规格 02 §4.3、PRD U07）。
   * 开局先读一次：熔断是运行时状态，不该等用户先拍一张才发现已经降级。
   */
  async refreshHitRate() {
    if (client === null) return
    try {
      this.applyHitRate(await client.visionHitRate())
    } catch {
      // 读不到就按没降级走：这只是入口排序，不该拦住整条链路
    }
  },

  applyHitRate(report: HitRateReport) {
    this.setData({
      fallbackActive: report.fallbackActive,
      fallbackHint: report.fallbackActive
        ? `最近 ${report.samples} 次识别命中率 ${report.hitRate ?? '—'}，`
          + `低于 ${report.threshold}：先用「问一句」更省事`
        : '',
    })
  },

  /** 把三档决策共用的那几行渲染收在一处（规格 02 §7.1 的三值） */
  renderArrival(result: ArriveResult, placeName: string) {
    if (result.spoke && result.text !== null) {
      this.appendLine({ kind: 'agent', text: result.text, note: `到达 ${placeName}` })
      return
    }
    if (result.card !== null) {
      // 分不够开口、或者主动频次到了：出气泡，不出声（规格 02 §7.1）
      this.appendLine({
        kind: 'card',
        text: result.card.hint,
        audioKey: result.card.audioKey ?? undefined,
        note: `到了${placeName}，没出声：${result.proactivityReason}`,
      })
      return
    }
    this.appendLine({
      kind: 'system',
      text: `到了${placeName}，但旅伴选择不开口：${result.vetoedBy ?? result.proactivityReason}`,
    })
  },

  /**
   * 模拟走到某个点位。
   * 上报两次定位是为了满足服务端围栏的去抖与最小停留条件——
   * 这里不绕过服务端判定，否则测到的就不是真实链路。
   */
  async onArrive(e: WechatMiniprogram.BaseEvent<Record<string, never>, { id: string }>) {
    const poi = this.data.pois.find((p) => p.id === e.currentTarget.dataset.id)
    const journeyId = this.data.journeyId
    if (client === null || poi === undefined || journeyId === null || this.data.busy) return

    await this.settleMoveOn()
    this.setData({ busy: true })
    try {
      const now = Date.now()
      await client.sendSignals(journeyId, [
        { lat: poi.lat, lng: poi.lng, accuracyM: 12, at: new Date(now).toISOString(), speedMps: 0.4 },
        { lat: poi.lat, lng: poi.lng, accuracyM: 14, at: new Date(now + 25_000).toISOString(), speedMps: 0.3 },
      ])
      const result = await client.arrive(journeyId, poi.id)
      this.setData({ currentPoi: poi.id, currentPoiName: poi.name, correctable: false })
      this.renderArrival(result, poi.name)
    } catch (error) {
      this.appendLine({ kind: 'system', text: `到达失败：${(error as Error).message}` })
    } finally {
      this.setData({ busy: false })
    }
  },

  /* ───────────────── 拍一下（规格 02 §4.2，PRD U07）───────────────── */

  /**
   * 拍一张，让服务端在本场景的候选里认。
   *
   * 候选集由服务端按旅程场景收窄，客户端不传展品清单：清单交给客户端决定，
   * 就可能在南博拍一张却认出夫子庙的点位来（§4.2 候选集约束是命中率的关键）。
   */
  async onShoot() {
    const journeyId = this.data.journeyId
    if (client === null || journeyId === null || this.data.busy) return

    await this.settleMoveOn()
    this.setData({ busy: true, picks: [], correctable: false })
    try {
      const photo = await capturePhoto(wxPhotoDeps())
      const res = await client.visionAnchor({ journeyId, imageKey: photo.imageKey })
      this.applyVision(res, journeyId)
    } catch (error) {
      const message = (error as Error).message
      // 用户自己取消了，不是失败，不该在对话里留一行红字
      if (!message.includes('cancel')) {
        this.appendLine({ kind: 'system', text: `识别失败：${message}` })
      }
    } finally {
      this.setData({ busy: false })
    }
  },

  async applyVision(res: VisionAnchorResponse, journeyId: string) {
    this.applyHitRate({
      samples: 0, hitRate: null, threshold: 0, fallbackActive: res.fallbackActive,
    })
    if (res.fallbackActive && res.fallbackReason !== null) {
      this.setData({ fallbackHint: res.fallbackReason })
    }

    const step = nextStep(res)
    pendingSample = openSample(step, journeyId)

    if (step.kind === 'ask') {
      this.appendLine({ kind: 'system', text: step.hint })
      return
    }
    if (step.kind === 'pick') {
      this.setData({ picks: step.candidates })
      return
    }

    if (step.landingRejected !== null) {
      this.appendLine({
        kind: 'system',
        text: `认出来了，但这次没记上：${step.landingRejected}`,
      })
    }
    this.setData({ correctable: true })
    await this.enterExhibit(step.pick, {
      locationSource: 'vision_anchor', locationConfidence: step.pick.confidence,
    })
  },

  /**
   * 落到某一件展品上。
   *
   * 室内不上报坐标：§4.4 明说不写「人在哪」。来源必须自报，
   * 不报就被当成 inferred、置信度按推断打折，拍一下认出来的点位
   * 会因此过不了 §7.2 的 0.6 否决线。
   */
  async enterExhibit(pick: VisionCandidate, place: DeclaredPlace) {
    const journeyId = this.data.journeyId
    if (client === null || journeyId === null) return
    this.setData({ currentPoi: pick.exhibitId, currentPoiName: pick.name })
    const result = await client.arrive(journeyId, pick.exhibitId, place)
    this.renderArrival(result, pick.name)
  },

  /** ask_user_pick 之后点了一件：要落位，但这一次不计入命中率（见 vision-flow） */
  async onPick(e: WechatMiniprogram.BaseEvent<Record<string, never>, { id: string }>) {
    const pick = this.data.picks.find((c) => c.exhibitId === e.currentTarget.dataset.id)
    const journeyId = this.data.journeyId
    if (client === null || pick === undefined || journeyId === null || this.data.busy) return

    this.setData({ busy: true, picks: [] })
    try {
      await client.visionOutcome(pickedOutcome(journeyId, pick.exhibitId))
      // user_confirmed 的置信度由服务端定成 1.0，客户端报多少都不作数
      await this.enterExhibit(pick, { locationSource: 'user_confirmed' })
    } catch (error) {
      this.appendLine({ kind: 'system', text: `记下来失败：${(error as Error).message}` })
    } finally {
      this.setData({ busy: false })
    }
  },

  /** 「都不是」：没有落位要做，但这次识别确实没成，要计入命中率 */
  async onRejectAll() {
    const journeyId = this.data.journeyId
    if (client === null || journeyId === null) return
    pendingSample = null
    this.setData({ picks: [] })
    try {
      this.applyHitRate(await client.visionOutcome(rejectedAllOutcome(journeyId)))
    } catch {
      // 命中率没记上不该影响用户接着问
    }
    this.appendLine({ kind: 'system', text: '那就直接问我一句——你看到的是什么样子？' })
  },

  /**
   * 「不是这件」：撤回认错的那条落位，并把这次记成纠正。
   * 撤回是必须的，否则语义足迹里会留下一件其实没看过的展品（§4.4）。
   */
  async onNotThis() {
    const out = settleOnCorrection(pendingSample)
    pendingSample = null
    this.setData({ correctable: false, currentPoi: null, currentPoiName: '' })
    if (client === null || out === null) return
    try {
      this.applyHitRate(await client.visionOutcome(out))
      this.appendLine({ kind: 'system', text: '已撤回刚才那条记录。再拍一张，或者直接问我。' })
    } catch (error) {
      this.appendLine({ kind: 'system', text: `撤回失败：${(error as Error).message}` })
    }
  },

  /**
   * 用户没纠正就往下走了：上一次识别就此算命中（规格 02 §4.3）。
   *
   * 不在落位当场记，是因为 /outcome 没有撤销样本的办法：当场乐观记一笔、
   * 用户再纠正时又记一笔，一次识别就成了半命中半纠正，熔断该响时晚响。
   */
  async settleMoveOn() {
    const out = settleOnMoveOn(pendingSample)
    pendingSample = null
    if (client === null || out === null) return
    try {
      this.applyHitRate(await client.visionOutcome(out))
    } catch {
      // 记不上命中率不该拦住用户的下一步
    }
    this.setData({ correctable: false })
  },

  /** 问一句：流式 + 垫音 + 逐句语音 */
  onAsk() {
    const text = this.data.input.trim()
    const journeyId = this.data.journeyId
    if (client === null || text === '' || journeyId === null || this.data.busy) return

    void this.settleMoveOn()
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
            this.playAudio(event.audioKey)
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
            this.playAudio(event.audioKey)
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
    await this.settleMoveOn()
    audio?.clear()
    try {
      await client.endJourney(journeyId)
      this.appendLine({ kind: 'system', text: '旅程已结束，行后蒸馏已排队' })
      this.setData({ journeyId: null, consentGiven: false, picks: [], correctable: false })
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
    pendingSample = null
    await client.deleteJourney(journeyId)
    this.setData({
      journeyId: null, consentGiven: false, lines: [],
      currentPoi: null, picks: [], correctable: false,
    })
  },
})
