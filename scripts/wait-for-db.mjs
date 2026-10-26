import { execSync } from 'node:child_process'

const DEADLINE_MS = 60_000
const POLL_MS = 1_000
const started = Date.now()

while (Date.now() - started < DEADLINE_MS) {
  try {
    execSync('docker exec lvban-pg pg_isready -U lvban -d lvban', { stdio: 'ignore' })
    execSync('docker exec lvban-redis redis-cli ping', { stdio: 'ignore' })
    console.log('postgres + redis ready')
    process.exit(0)
  } catch {
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}
console.error('timed out waiting for postgres/redis')
process.exit(1)
