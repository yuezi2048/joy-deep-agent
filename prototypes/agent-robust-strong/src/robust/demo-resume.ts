import { CheckpointManager } from './checkpoint.js'
import { handleResume } from './resume.js'
async function main() {
  console.log('===== 模拟任务执行并保存进度 =====\n')
  const manager = new CheckpointManager('task-resume-demo')
  manager.recordStep(1, '搜集资料', '找到 5 篇文档')
  manager.recordStep(2, '分析数据', '提取了关键指标')
  manager.recordStep(3, '生成初稿', '完成报告前半部分')
  manager.setState('reportDraft', '报告前半部分内容...')
  const checkpoint = manager.getCheckpoint()
  console.log('任务被中断，已保存进度：')
  console.log(`  ${manager.getSummary()}`)
  console.log(`  中间状态：${JSON.stringify(checkpoint.state)}\n`)
  console.log('===== 用户选择"继续" =====')
  const r1 = handleResume(checkpoint, { choice: 'continue' })
  console.log(`  ${r1.action}`)
  if (r1.manager) {
    console.log(`  恢复后的进度：${r1.manager.getSummary()}`)
    console.log(`  之前的中间状态还在：${JSON.stringify(r1.manager.getCheckpoint().state)}`)
  }
  console.log()
  console.log('===== 用户选择"调整方向" =====')
  const r2 = handleResume(checkpoint, { choice: 'adjust', newInstruction: '报告后半部分改成只写结论' })
  console.log(`  ${r2.action}`)
}
main().catch(console.error)
