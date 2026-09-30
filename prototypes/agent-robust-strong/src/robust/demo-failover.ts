import 'dotenv/config'
import { MultiProvider } from './multi-provider.js'
async function main() {
  console.log('===== 主供应商故障，自动转移到备用 =====\n')
  const multi = new MultiProvider([
    { name: '主供应商（故意配错key模拟故障）', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-这是一个会失败的错误key', model: 'deepseek-chat', priority: 1 },
    { name: '备用供应商（正常）', baseURL: 'https://api.deepseek.com/v1', apiKey: process.env.DEEPSEEK_API_KEY!, model: 'deepseek-chat', priority: 2 },
  ])
  console.log('发起调用（主供应商会失败，应自动切到备用）...\n')
  const reply = await multi.chat([{ role: 'user', content: '用一句话解释什么是故障转移' }])
  console.log(`\n最终回复：${reply}`)
  console.log(`\n各供应商最终状态：`)
  console.log(JSON.stringify(multi.getStatus(), null, 2))
}
main().catch(console.error)
