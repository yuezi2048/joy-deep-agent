import { GuardedExecutor } from './guarded-executor.js'
import { ToolBudget } from './tool-budget.js'
async function mockExecutor(): Promise<string> { return `查询结果` }
async function main() {
  const exec = new GuardedExecutor({ budget: new ToolBudget({ maxPerTool: 3, maxTotalCalls: 10 }) })
  console.log('===== 单工具上限 3 次，调 5 次看后两次被拦 =====\n')
  for (let i = 1; i <= 5; i++) {
    const r = await exec.execute('query_order', { orderId: `ORD-${i}` }, mockExecutor)
    console.log(`第 ${i} 次：${r}`)
  }
  console.log('\n预算使用情况：', JSON.stringify(exec.getStats().budget))
}
main().catch(console.error)
