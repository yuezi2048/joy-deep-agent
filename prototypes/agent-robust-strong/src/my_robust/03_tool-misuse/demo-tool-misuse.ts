/**
 * 工具误用防护演示
 * 运行：pnpm exec tsx src/my_robust/03_tool-misuse/demo-tool-misuse.ts
 */

import { GuardedExecutor } from './guarded-executor.js'
import { ToolBudget } from './tool-budget.js'
import { DependencyChecker } from './tool-dependency.js'

// 模拟的真实工具执行器
async function mockExecutor(name: string, args: any): Promise<string> {
  if (name === 'check_stock') return `库存：100 件`
  if (name === 'create_order') return `订单创建成功`
  if (name === 'query_order') return `订单详情：已发货`
  return `未知工具 ${name}`
}

async function main() {
  // ── 演示一：重复调用去重 ──
  console.log('=== 演示一：重复调用去重 ===\n')
  const exec1 = new GuardedExecutor()
  const r1a = await exec1.execute('query_order', { orderId: 'ORD-1' }, mockExecutor)
  console.log(`第一次调用：${r1a}`)
  const r1b = await exec1.execute('query_order', { orderId: 'ORD-1' }, mockExecutor)
  console.log(`第二次相同调用：${r1b}（命中缓存，没有真正执行）\n`)

  // ── 演示二：调用预算 ──
  console.log('=== 演示二：调用预算上限 ===\n')
  const exec2 = new GuardedExecutor({
    budget: new ToolBudget({ maxPerTool: 3 }),
  })
  for (let i = 1; i <= 5; i++) {
    // 每次参数不同，避免命中去重，专门测预算
    const r = await exec2.execute('query_order', { orderId: `ORD-${i}` }, mockExecutor)
    console.log(`第 ${i} 次调用：${r}`)
  }
  console.log()

  // ── 演示三：依赖顺序约束 ──
  console.log('=== 演示三：依赖顺序约束 ===\n')
  const exec3 = new GuardedExecutor({
    dependencyChecker: new DependencyChecker([
      { toolName: 'create_order', requires: ['check_stock'] },
    ]),
  })
  // 错误顺序：还没查库存就下单
  console.log('尝试不查库存直接下单：')
  const r3a = await exec3.execute('create_order', { item: 'A' }, mockExecutor)
  console.log(`  ${r3a}\n`)
  // 正确顺序：先查库存
  console.log('先查库存：')
  const r3b = await exec3.execute('check_stock', { item: 'A' }, mockExecutor)
  console.log(`  ${r3b}`)
  console.log('再下单：')
  const r3c = await exec3.execute('create_order', { item: 'A' }, mockExecutor)
  console.log(`  ${r3c}\n`)

  // ── 演示四：卡死检测 ──
  console.log('=== 演示四：卡死检测 ===\n')
  const exec4 = new GuardedExecutor()
  for (let i = 1; i <= 4; i++) {
    // 连续调同一个工具（参数不同避免去重），第4次触发卡死检测
    const r = await exec4.execute('check_stock', { round: i }, mockExecutor)
    console.log(`第 ${i} 次：${r}`)
  }
}

main().catch(console.error)