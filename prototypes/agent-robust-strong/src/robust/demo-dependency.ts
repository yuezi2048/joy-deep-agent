import { GuardedExecutor } from './guarded-executor.js'
import { DependencyChecker } from './tool-dependency.js'
async function mockExecutor(name: string): Promise<string> {
  if (name === 'check_stock') return '库存充足：100 件'
  if (name === 'create_order') return '订单创建成功'
  return '未知'
}
async function main() {
  const exec = new GuardedExecutor({ dependencyChecker: new DependencyChecker([{ toolName: 'create_order', requires: ['check_stock'] }]) })
  console.log('===== 场景1：错误顺序，没查库存直接下单 =====')
  const r1 = await exec.execute('create_order', { item: 'iPhone' }, mockExecutor)
  console.log(`  ${r1}\n`)
  console.log('===== 场景2：正确顺序 =====')
  console.log('  先查库存：')
  const r2 = await exec.execute('check_stock', { item: 'iPhone' }, mockExecutor)
  console.log(`    ${r2}`)
  console.log('  再下单：')
  const r3 = await exec.execute('create_order', { item: 'iPhone' }, mockExecutor)
  console.log(`    ${r3}`)
}
main().catch(console.error)
