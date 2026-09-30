import { truncateResult } from './result-truncate.js'
import { estimateTokens } from './token-counter.js'
async function main() {
  console.log('===== 模拟一个超大的工具返回 =====\n')
  let bigResult = '【文件开头】这是重要的配置信息\n'
  bigResult += '中间的普通数据行\n'.repeat(2000)
  bigResult += '【文件结尾】这是重要的总结信息'
  console.log(`原始大小：${bigResult.length} 字符，约 ${estimateTokens(bigResult)} token`)
  const truncated = truncateResult(bigResult, { maxTokens: 500 })
  console.log(`截断后：${truncated.length} 字符，约 ${estimateTokens(truncated)} token\n`)
  console.log('截断后的内容：')
  console.log('---')
  console.log(truncated.slice(0, 200))
  console.log('...')
  console.log(truncated.slice(-200))
  console.log('---')
  console.log(`\n是否保留了开头的关键信息：${truncated.includes('文件开头') ? '是' : '否'}`)
  console.log(`是否保留了结尾的关键信息：${truncated.includes('文件结尾') ? '是' : '否'}`)
  console.log(`是否有截断标记：${truncated.includes('已截断') ? '是' : '否'}`)
}
main().catch(console.error)
