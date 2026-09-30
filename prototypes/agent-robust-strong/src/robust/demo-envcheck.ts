import { checkEnvironment, getEnvInfo } from './env-check.js'
async function main() {
  console.log('===== 当前环境信息 =====\n')
  const info = getEnvInfo()
  console.log(`操作系统：${info.platform}`)
  console.log(`Node 版本：${info.nodeVersion}`)
  console.log(`当前目录：${info.cwd}`)
  console.log(`架构：${info.arch}\n`)
  console.log('===== 检查环境是否满足要求 =====\n')
  const result = await checkEnvironment({ commands: ['node', 'git', '肯定不存在的命令abcxyz'], minNodeMajor: 18 })
  console.log(`检查通过：${result.passed}`)
  if (result.issues.length > 0) {
    console.log('发现的问题：')
    result.issues.forEach((i) => console.log(`  - ${i}`))
  } else console.log('所有要求都满足')
}
main().catch(console.error)
