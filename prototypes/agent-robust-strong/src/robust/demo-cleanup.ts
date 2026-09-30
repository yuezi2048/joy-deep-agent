import { InterruptController } from './interrupt-controller.js'
async function main() {
  console.log('===== 中断时执行所有注册的清理函数 =====\n')
  const interrupt = new InterruptController()
  console.log('模拟打开资源...')
  console.log('  打开数据库连接')
  interrupt.onCleanup(async () => console.log('  [清理] 关闭数据库连接'))
  console.log('  打开文件 output.txt')
  interrupt.onCleanup(async () => console.log('  [清理] 关闭并保存 output.txt'))
  console.log('  发起一个长网络请求')
  interrupt.onCleanup(async () => console.log('  [清理] 取消网络请求'))
  console.log('\n触发中断...')
  interrupt.interrupt('演示清理')
  console.log('\n执行清理：')
  await interrupt.cleanup()
  console.log('\n（所有资源都被正确清理，没有泄漏）')
}
main().catch(console.error)
