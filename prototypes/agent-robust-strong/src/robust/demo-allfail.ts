import { MultiProvider } from './multi-provider.js'
async function main() {
  console.log('===== 所有供应商都故障，看兜底 =====\n')
  const multi = new MultiProvider([
    { name: '供应商A（挂）', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-错误key-A', model: 'deepseek-chat', priority: 1 },
    { name: '供应商B（挂）', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-错误key-B', model: 'deepseek-chat', priority: 2 },
  ])
  const reply = await multi.chat([{ role: 'user', content: '你好' }])
  console.log(`\n最终回复：${reply}`)
  console.log('\n（注意：所有供应商都挂了，程序没有崩溃，而是返回了兜底提示）')
}
main().catch(console.error)
