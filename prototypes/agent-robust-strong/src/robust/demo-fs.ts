import { safeReadFile, safeWriteFile } from './fs-guard.js'
import fs from 'fs'
async function main() {
  console.log('===== 场景1：读不存在的文件 =====\n')
  console.log(`错误：${safeReadFile('/不存在的路径xyz/file.txt').error}\n`)
  console.log('===== 场景2：写到不存在的目录 =====\n')
  console.log(`错误：${safeWriteFile('/不存在的目录xyz/out.txt', '内容').error}\n`)
  console.log('===== 场景3：正常写文件 =====\n')
  const r3 = safeWriteFile('./test-output.txt', '这是测试内容')
  console.log(`写入：${r3.ok ? '成功' : r3.error}\n`)
  console.log('===== 场景4：读刚写的文件 =====\n')
  const r4 = safeReadFile('./test-output.txt')
  console.log(`内容：${r4.content ?? r4.error}\n`)
  console.log('===== 场景5：把目录当文件读 =====\n')
  console.log(`错误：${safeReadFile('.').error}\n`)
  if (fs.existsSync('./test-output.txt')) { fs.unlinkSync('./test-output.txt'); console.log('（已清理测试文件）') }
}
main().catch(console.error)
