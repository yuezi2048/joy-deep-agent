import { safeExec } from './safe-exec.js'
async function main() {
  console.log('===== 命令超时强制终止 =====\n')
  console.log('执行一个 10 秒的命令，超时设了 2 秒...')
  const start = Date.now()
  const result = await safeExec('node', ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 2000 })
  const elapsed = Date.now() - start
  console.log(`\n实际耗时：${(elapsed / 1000).toFixed(1)} 秒`)
  console.log(`成功：${result.success}`)
  console.log(`说明：${result.message}`)
  console.log(`\n（命令本来要 10 秒，但 2 秒就被超时强制终止了）`)
}
main().catch(console.error)
