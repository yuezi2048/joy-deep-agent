import { GuardedExecutor } from './guarded-executor.js'
let realCallCount = 0
async function countingExecutor(name: string, args: any): Promise<string> {
  realCallCount++
  console.log(`    [真正执行了第 ${realCallCount} 次] ${name}(${JSON.stringify(args)})`)
  return `订单详情：已发货`
}
async function main() {
  const exec = new GuardedExecutor()
  console.log('===== 连续 3 次相同调用，应该只真正执行 1 次 =====\n')
  for (let i = 1; i <= 3; i++) {
    console.log(`  第 ${i} 次调用 query_order(ORD-1)：`)
    const r = await exec.execute('query_order', { orderId: 'ORD-1' }, countingExecutor)
    console.log(`    返回：${r}\n`)
  }
  console.log(`真正执行次数：${realCallCount}（虽然调用了 3 次，但只真正执行了 1 次）`)
}
main().catch(console.error)
