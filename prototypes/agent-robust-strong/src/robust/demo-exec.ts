import { safeExec } from './safe-exec.js'
async function main() {
  console.log('===== 场景1：执行成功的命令 =====\n')
  const r1 = await safeExec('node', ['--version'])
  console.log(`成功：${r1.success}`); console.log(`退出码：${r1.exitCode}`)
  console.log(`输出：${r1.stdout.trim()}`); console.log(`说明：${r1.message}\n`)
  console.log('===== 场景2：退出码非 0 的命令 =====\n')
  const r2 = await safeExec('node', ['-e', 'process.exit(1)'])
  console.log(`成功：${r2.success}`); console.log(`退出码：${r2.exitCode}`); console.log(`说明：${r2.message}\n`)
  console.log('===== 场景3：命令不存在 =====\n')
  const r3 = await safeExec('这个命令根本不存在abcxyz', [])
  console.log(`成功：${r3.success}`); console.log(`退出码：${r3.exitCode}`); console.log(`说明：${r3.message}\n`)
}
main().catch(console.error)
