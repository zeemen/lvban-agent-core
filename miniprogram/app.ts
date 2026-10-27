App({
  onLaunch() {
    const version = wx.getSystemInfoSync().SDKVersion
    // enableChunked 需要 2.20.2 以上；低于此版本流式拿不到，要让用户看得见原因
    if (compareVersion(version, '2.20.2') < 0) {
      wx.showModal({
        title: '微信版本过低',
        content: `当前基础库 ${version}，语音讲解需要 2.20.2 以上。请升级微信后重试。`,
        showCancel: false,
      })
    }
  },
})

function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (na !== nb) return na > nb ? 1 : -1
  }
  return 0
}
