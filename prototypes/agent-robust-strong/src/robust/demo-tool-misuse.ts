import { GuardedExecutor } from './guarded-executor.js'
import { ToolBudget } from './tool-budget.js'
import { DependencyChecker } from './tool-dependency.js'
async function mockExecutor(name: string): Promise<string> {
  if (name === 'check_stock') return `库存：100 件`
  if (name === 'create_order') return `订单创建成功`
  if (name === 'query_order') return `订单详情：已发货`
  return `未知工具 ${name}`
}
async function main() {
  console.log('=== 演示一：重复调用去重 ===\n')
  const exec1 = new GuardedExecutor()
  const r1a = await exec1.execute('query_order', { orderId: 'ORD-1' }, mockExecutor)
  console.log(`第一次调用：${r1a}`)
  const r1b = await exec1.execute('query_order', { orderId: 'ORD-1' }, mockExecutor)
  console.log(`第二次相同调用：${r1b}（命中缓存）\n`)

  console.log('=== 演示二：调用预算上限 ===\n')
  const exec2 = new GuardedExecutor({ budget: new ToolBudget({ maxPerTool: 3 }) })
  for (let i = 1; i <= 5; i++) {
    const r = await exec2.execute('query_order', { orderId: `ORD-${i}` }, mockExecutor)
    console.log(`第 ${i} 次调用：${r}`)
  }
  console.log()

  console.log('=== 演示三：依赖顺序约束 ===\n')
  const exec3 = new GuardedExecutor({ dependencyChecker: new DependencyChecker([{ toolName: 'create_order', requires: ['check_stock'] }]) })
  console.log('尝试不查库存直接下单：')
  console.log(`  ${await exec3.execute('create_order', { item: 'A' }, mockExecutor)}\n`)
  console.log('先查库存：')
  console.log(`  ${await exec3.execute('check_stock', { item: 'A' }, mockExecutor)}`)
  console.log('再下单：')
  console.log(`  ${await exec3.execute('create_order', { item: 'A' }, mockExecutor)}\n`)

  console.log('=== 演示四：卡死检测 ===\n')
  const exec4 = new GuardedExecutor()
  for (let i = 1; i <= 4; i++) {
    const r = await exec4.execute('check_stock', { round: i }, mockExecutor)
    console.log(`第 ${i} 次：${r}`)
  }
}
main().catch(console.error)
