import { createInterface } from 'node:readline/promises'
import { uuidv7 } from 'uuidv7'
import { onArrive, onQuestion } from '../agent/respond.js'
import { endJourney, startJourney } from '../context/journey.js'
import { closePool, pool } from '../db/pool.js'
import { closeRedis } from '../db/redis.js'
import { distillJourney } from '../memory/distill.js'
import { getMemoryHooks } from '../memory/retrieval.js'
import * as repo from '../memory/repo.js'
import { readLedger } from '../models/router.js'
import { runDemo } from './demo.js'

/**
 * M2 调试外壳。两种用法：
 *   node --run cli demo   跑完整的「第二次使用」验证脚本（规格 04 §3.4）
 *   node --run cli chat   交互式对话，可模拟坐标与到达点位
 */

const ensureUser = async (openid: string, nickname: string): Promise<string> => {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO app_user (id, wx_openid, nickname, age_band, default_mode)
     VALUES ($1,$2,$3,'19_24','companion')
     ON CONFLICT (wx_openid) DO UPDATE SET nickname = EXCLUDED.nickname
     RETURNING id`,
    [uuidv7(), openid, nickname],
  )
  const id = rows[0]?.id
  if (id === undefined) throw new Error('创建用户失败')
  return id
}

const chat = async (): Promise<void> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const userId = await ensureUser('cli_chat_user', 'CLI 用户')

  const existing = await repo.findActiveJourney(userId)
  if (existing !== null) await endJourney(existing.id)

  const journey = await startJourney({
    userId, mode: 'companion', party: 'solo',
    sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
  })

  console.log(`\n旅程已开始：${journey.id}`)
  console.log('命令：/arrive <poiId>　/at <poiId> <问题>　/ctx　/mem　/end　/quit')
  console.log('点位：fzm_jiangnan_gongyuan  fzm_mingyuan_lou  fzm_wende_qiao  fzm_wuyi_xiang\n')

  let currentPoi: string | null = null

  for (;;) {
    const line = (await rl.question('你 > ')).trim()
    if (line === '') continue

    if (line === '/quit') break

    if (line === '/end') {
      await endJourney(journey.id)
      const report = await distillJourney(journey.id)
      console.log('蒸馏报告：', report)
      break
    }

    if (line === '/ctx') {
      const turn = await onArrive({ journeyId: journey.id, poiId: currentPoi ?? 'fzm_jiangnan_gongyuan' })
      console.log(JSON.stringify(turn.context, null, 2))
      continue
    }

    if (line === '/mem') {
      const hooks = await getMemoryHooks({ userId, currentPlace: currentPoi, currentCity: '南京' })
      console.log(JSON.stringify(hooks, null, 2))
      continue
    }

    if (line.startsWith('/arrive ')) {
      currentPoi = line.slice('/arrive '.length).trim()
      const turn = await onArrive({ journeyId: journey.id, poiId: currentPoi })
      if (turn.spoke) {
        console.log(`\n旅伴 > ${turn.text}`)
        console.log(`       [决策 ${turn.decision} · ${turn.proactivityReason} · 开场=${turn.plan?.openWith} · 要素=${turn.usedElements.join(',')}]\n`)
      } else {
        console.log(`\n旅伴 > （保持安静：${turn.vetoedBy ?? turn.proactivityReason}）\n`)
      }
      continue
    }

    if (line.startsWith('/at ')) {
      const rest = line.slice('/at '.length)
      const spaceIdx = rest.indexOf(' ')
      currentPoi = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)
      const text = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1)
      if (text === '') { console.log('用法：/at <poiId> <问题>'); continue }
      const turn = await onQuestion({ journeyId: journey.id, text, poiId: currentPoi })
      console.log(`\n旅伴 > ${turn.text}\n`)
      continue
    }

    const turn = await onQuestion({ journeyId: journey.id, text: line, poiId: currentPoi })
    console.log(`\n旅伴 > ${turn.text}`)
    if (turn.guardViolations.length > 0) {
      console.log(`       [口吻守卫命中：${turn.guardViolations.join(', ')}]`)
    }
    console.log()
  }

  rl.close()
  console.log('模型账本：', readLedger())
}

const main = async (): Promise<void> => {
  const command = process.argv[2] ?? 'demo'
  if (command === 'demo') await runDemo()
  else if (command === 'chat') await chat()
  else {
    console.error(`未知命令：${command}（可用：demo | chat）`)
    process.exitCode = 1
  }
}

main()
  .then(async () => { await closePool(); await closeRedis() })
  .catch(async (error: unknown) => {
    console.error(error)
    await closePool(); await closeRedis()
    process.exit(1)
  })
