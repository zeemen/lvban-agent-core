import Redis from 'ioredis'
import { config } from '../config/index.js'

// lazyConnect：单测只 import 纯函数模块时不该顺带建立连接
export const redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 })

export const closeRedis = async (): Promise<void> => {
  await redis.quit()
}
