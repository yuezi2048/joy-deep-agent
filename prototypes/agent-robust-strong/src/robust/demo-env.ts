import { safeExec } from './safe-exec.js'
import { safeReadFile, safeWriteFile } from './fs-guard.js'
import { checkEnvironment, getEnvInfo } from './env-check.js'
async function main() {
  console.log('=== 演示一：环境预检 ===\n')
  console.log('当前环境：', JSON.stringify(getEnvInfo(), null, 2))
  const envCheck = await checkEnvironment({ commands: ['node', 'git', '不存在的命令xyz'], minNodeMajor: 18 })
  console.log(`\n环境检查通过：${envCheck.passed}`)
  if (envCheck.issues.length > 0) { console.log('发现问题：'); envCheck.issues.forEach((i) => console.log(`  - ${i}`)) }
  console.log()
  console.log('=== 演示二：执行正常命令 ===\n')
  const r1 = await safeExec('node', ['--version'])
  console.log(`成功：${r1.success}，退出码：${r1.exitCode}`)
  console.log(`输出：${r1.stdout.trim()}`); console.log(`说明：${r1.message}\n`)
  console.log('=== 演示三：执行不存在的命令 ===\n')
  const r2 = await safeExec('这个命令不存在xyz', [])
  console.log(`成功：${r2.success}`); console.log(`说明：${r2.message}\n`)
  console.log('=== 演示四：命令超时强制终止 ===\n')
  console.log('执行一个 10 秒的命令，但超时设了 2 秒...')
  const r3 = await safeExec('node', ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 2000 })
  console.log(`成功：${r3.success}`); console.log(`说明：${r3.message}\n`)
  console.log('=== 演示五：文件操作前置检查 ===\n')
  console.log(`读不存在的文件：${safeReadFile('/不存在的路径/file.txt').error}`)
  console.log(`写到不存在的目录：${safeWriteFile('/不存在的目录xyz/out.txt', '内容').error}`)
  const w = safeWriteFile('./test-output.txt', '测试内容')
  console.log(`写当前目录：${w.ok ? '成功' : w.error}`)
}
main().catch(console.error)
