/**
 * 小程序端配置。
 *
 * 本地联调：开发者工具「详情 → 本地设置」勾选「不校验合法域名」，
 * 否则 http://localhost 会被拦。上线前 baseUrl 必须换成已在
 * 小程序后台配置过的 HTTPS request 合法域名。
 */
export const config = {
  baseUrl: 'http://localhost:8787',
  /** M3 阶段没有微信登录，用服务端 /v1/dev/users 建的测试用户 */
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
