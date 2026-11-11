/**
 * 小程序端配置。
 *
 * 端口刻意避开 8787：本机另有一个长期运行的服务绑在 127.0.0.1:8787。
 * 两个进程可以同时绑同一端口号（一个 *:8787、一个 127.0.0.1:8787），
 * 而 localhost 命中更具体的那个 —— 表现为请求被不相干的服务接走、返回 401，
 * 看起来却像是我们的接口出错。
 *
 * 本地联调：开发者工具「详情 → 本地设置」勾选「不校验合法域名」，
 * 否则 http://localhost 会被拦。上线前 baseUrl 必须换成已在
 * 小程序后台配置过的 HTTPS request 合法域名。
 *
 * **真机调试要把 localhost 换成这台机器的局域网地址**（`ipconfig getifaddr en0`，
 * 形如 http://192.168.x.x:8791）。手机上的 localhost 是手机自己，连不到开发机——
 * 这一条一分钟就能让人白跑一趟。服务端已经监听 0.0.0.0（`src/http/server.ts:67`），
 * 手机和开发机在同一个 Wi-Fi 下即可；「不校验合法域名」对真机调试同样生效，
 * 走预览（开发版）则要在手机上先打开调试。
 */

export type ScenePoi = {
  readonly id: string
  readonly name: string
  readonly lat: number
  readonly lng: number
}

export type Scene = {
  readonly id: string
  readonly name: string
  readonly desc: string
  /**
   * 室内只问「在看哪件」，不问「人在哪」（规格 02 §4.4）。
   * 所以室内场景没有围栏模拟点：进点位靠「拍一下」，不靠坐标。
   */
  readonly indoor: boolean
  readonly ready: boolean
  readonly pois: readonly ScenePoi[]
}

/**
 * 室外的坐标是围栏占位值（`content/geofences/*.json` 的 `calibrated: false`），
 * 现场实测后要连同围栏一起替换（规格 02 §9.3）。
 * 这份清单要和围栏文件里的 poiId 对齐，少一个点，开发者工具里就走不到它。
 */
export const SCENES: readonly Scene[] = [
  {
    id: 'fuzimiao',
    name: '夫子庙',
    desc: '室外 · 秦淮赶考',
    indoor: false,
    ready: true,
    pois: [
      { id: 'fzm_tianxia_wenshu', name: '天下文枢坊', lat: 32.0203, lng: 118.7889 },
      { id: 'fzm_dacheng_dian', name: '大成殿', lat: 32.0208, lng: 118.7893 },
      { id: 'fzm_jiangnan_gongyuan', name: '江南贡院', lat: 32.0211, lng: 118.7905 },
      { id: 'fzm_mingyuan_lou', name: '明远楼', lat: 32.0214, lng: 118.7908 },
      { id: 'fzm_wende_qiao', name: '文德桥', lat: 32.0199, lng: 118.7881 },
      { id: 'fzm_wuyi_xiang', name: '乌衣巷', lat: 32.0196, lng: 118.7885 },
    ],
  },
  {
    id: 'nanjing_museum',
    name: '南京博物院',
    desc: '室内 · 拍一下认展品',
    indoor: true,
    ready: true,
    pois: [],
  },
]

export const sceneById = (id: string): Scene | undefined =>
  SCENES.find((scene) => scene.id === id)

export const config = {
  baseUrl: 'http://localhost:8791',
  /**
   * 本地联调回落身份。服务端没配 WX_APPSECRET 时 /v1/auth/wx-login 回 503，
   * 此时用 /v1/dev/users 拿一个稳定身份把链路跑完（见 utils/auth.ts）。
   * 服务端一旦强制鉴权，dev 接口返回 404，这条路自动失效。
   */
  devOpenId: 'miniprogram_dev_user',
  defaultSceneId: 'fuzimiao',
} as const
