// 第8节：文件操作防护
import fs from 'fs'
import path from 'path'
export interface FsCheckResult {
  ok: boolean
  message: string
}
export function checkReadable(filePath: string): FsCheckResult {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) return { ok: false, message: `文件不存在：${resolved}` }
  try { fs.accessSync(resolved, fs.constants.R_OK) } catch { return { ok: false, message: `没有读权限：${resolved}` } }
  if (fs.statSync(resolved).isDirectory()) return { ok: false, message: `这是一个目录，不是文件：${resolved}` }
  return { ok: true, message: '可读' }
}
export function checkWritable(filePath: string): FsCheckResult {
  const resolved = path.resolve(filePath)
  const dir = path.dirname(resolved)
  if (!fs.existsSync(dir)) return { ok: false, message: `目标目录不存在：${dir}` }
  try { fs.accessSync(dir, fs.constants.W_OK) } catch { return { ok: false, message: `目录没有写权限：${dir}` } }
  if (fs.existsSync(resolved)) {
    try { fs.accessSync(resolved, fs.constants.W_OK) } catch { return { ok: false, message: `文件存在但没有写权限：${resolved}` } }
  }
  return { ok: true, message: '可写' }
}
export function safeReadFile(filePath: string): { content?: string; error?: string } {
  const check = checkReadable(filePath)
  if (!check.ok) return { error: check.message }
  try { return { content: fs.readFileSync(path.resolve(filePath), 'utf-8') } }
  catch (err: any) { return { error: `读取失败：${err.message}` } }
}
export function safeWriteFile(filePath: string, content: string): { ok: boolean; error?: string } {
  const check = checkWritable(filePath)
  if (!check.ok) return { ok: false, error: check.message }
  try { fs.writeFileSync(path.resolve(filePath), content, 'utf-8'); return { ok: true } }
  catch (err: any) {
    if (err.code === 'ENOSPC') return { ok: false, error: '磁盘空间不足，无法写入' }
    return { ok: false, error: `写入失败：${err.message}` }
  }
}
