import { safeParseJSON } from './safe-json.js'
async function main() {
  console.log('===== 测试各种脏 JSON =====\n')
  const testCases = [
    { name: '干净的 JSON', input: '{"name": "大伟", "age": 30}' },
    { name: '带 markdown 代码块', input: '```json\n{"name": "大伟", "age": 30}\n```' },
    { name: '前面有解释文字', input: '好的，这是结果：{"name": "大伟", "age": 30}' },
    { name: '前后都有文字 + 代码块', input: '没问题！\n```json\n{"status": "ok", "data": [1,2,3]}\n```\n以上就是结果。' },
    { name: '数组类型', input: '这是列表：\n["苹果", "香蕉", "橙子"]' },
    { name: '完全不是 JSON', input: '这就是一段普通的话，没有任何 JSON' },
  ]
  for (const tc of testCases) {
    const result = safeParseJSON(tc.input)
    const status = result !== null ? '✓ 解析成功' : '✗ 解析失败（返回 null）'
    console.log(`【${tc.name}】 ${status}`)
    console.log(`  输入：${tc.input.replace(/\n/g, '\\n')}`)
    console.log(`  输出：${JSON.stringify(result)}\n`)
  }
}
main().catch(console.error)
