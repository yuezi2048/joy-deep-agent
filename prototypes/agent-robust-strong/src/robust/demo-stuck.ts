import { GuardedExecutor } from './guarded-executor.js'
async function mockExecutor(): Promise<string> { return '没有进展的结果' }
async function main() {
  const exec = new GuardedExecutor()
  console.log('===== 连续调同一个工具，第 4 次触发卡死检测 =====\n')
  for (let i = 1; i <= 5; i++) {
    const r = await exec.execute('search', { round: i }, mockExecutor)
    console.log(`第 ${i} 次调 search：${r}`)
  }
}
main().catch(console.error)
