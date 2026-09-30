import 'dotenv/config'
import { buildGroundedPrompt, hasSourceCitation } from './grounding.js'
import { SafeLLM } from './safe-llm.js'
async function main() {
  const llm = new SafeLLM({ apiKey: process.env.DEEPSEEK_API_KEY! })
  const sources = [{ id: '1', title: '产品技术栈说明', content: '本产品前端支持 Vue3 和 React 两种框架，后端基于 Node.js。' }]
  console.log('===== 场景1：问材料里有的内容 =====\n')
  const q1 = '产品的前端支持哪些框架？'
  const a1 = await llm.chat([{ role: 'user', content: buildGroundedPrompt(q1, sources) }])
  console.log(`问：${q1}`); console.log(`答：${a1}`); console.log(`标注了来源：${hasSourceCitation(a1)}\n`)
  console.log('===== 场景2：问材料里没有的内容（容易诱发幻觉）=====\n')
  const q2 = '产品支持 Angular 框架吗？'
  const a2 = await llm.chat([{ role: 'user', content: buildGroundedPrompt(q2, sources) }])
  console.log(`问：${q2}`); console.log(`答：${a2}`)
  console.log('（资料里完全没提 Angular，健壮的回答应该说"资料中没有相关信息"）\n')
}
main().catch(console.error)
