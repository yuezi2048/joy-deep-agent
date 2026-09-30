import 'dotenv/config'
import { factCheck } from './self-check.js'
import { SafeLLM } from './safe-llm.js'
async function main() {
  const llm = new SafeLLM({ apiKey: process.env.DEEPSEEK_API_KEY! })
  const material = '小明今年 25 岁，是一名前端工程师，会 Vue 和 React。'
  console.log('===== 场景1：核查一段忠实于原文的回答 =====\n')
  const faithful = '小明是前端工程师，掌握 Vue 和 React。'
  const c1 = await factCheck(faithful, material, llm)
  console.log(`待核查：${faithful}`); console.log(`发现编造：${c1.hasFabrication}`); console.log(`问题：${JSON.stringify(c1.issues)}\n`)
  console.log('===== 场景2：核查一段有编造的回答 =====\n')
  const fabricated = '小明是前端工程师，会 Vue 和 React，年薪 50 万，有 10 年经验。'
  const c2 = await factCheck(fabricated, material, llm)
  console.log(`待核查：${fabricated}`); console.log(`发现编造：${c2.hasFabrication}`)
  console.log(`问题：${JSON.stringify(c2.issues, null, 2)}`); console.log(`建议重新生成：${c2.shouldRegenerate}\n`)
}
main().catch(console.error)
