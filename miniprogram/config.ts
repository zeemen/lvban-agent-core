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
 */
export const config = {
  baseUrl: 'http://localhost:8791',
  /**
   * 本地联调回落身份。服务端没配 WX_APPSECRET 时 /v1/auth/wx-login 回 503，
   * 此时用 /v1/dev/users 拿一个稳定身份把链路跑完（见 utils/auth.ts）。
   * 服务端一旦强制鉴权，dev 接口返回 404，这条路自动失效。
   */
  devOpenId: 'miniprogram_dev_user',
  sceneId: 'fuzimiao',
  /** 开发者工具里没有真实 GPS，用这些点位模拟到达 */
  pois: [
    { id: 'fzm_jiangnan_gongyuan', name: '江南贡院', lat: 32.0211, lng: 118.7905 },
    { id: 'fzm_mingyuan_lou', name: '明远楼', lat: 32.0214, lng: 118.7908 },
    { id: 'fzm_wende_qiao', name: '文德桥', lat: 32.0199, lng: 118.7881 },
    { id: 'fzm_wuyi_xiang', name: '乌衣巷', lat: 32.0196, lng: 118.7885 },
  ],
} as const
