/**
 * 文件操作防护
 * 操作前检查，把环境问题提前暴露
 */

import fs from 'fs'
import path from 'path'

export interface FsCheckResult {
  ok: boolean
  message: string
}

/**
 * 读文件前检查
 */
export function checkReadable(filePath: string): FsCheckResult {
  const resolved = path.resolve(filePath)

  if (!fs.existsSync(resolved)) {
    return { ok: false, message: `文件不存在：${resolved}` }
  }

  try {
    fs.accessSync(resolved, fs.constants.R_OK)
  } catch {
    return { ok: false, message: `没有读权限：${resolved}` }
  }

  const stat = fs.statSync(resolved)
  if (stat.isDirectory()) {
    return { ok: false, message: `这是一个目录，不是文件：${resolved}` }
  }

  return { ok: true, message: '可读' }
}

/**
 * 写文件前检查
 */
export function checkWritable(filePath: string): FsCheckResult {
  const resolved = path.resolve(filePath)
  const dir = path.dirname(resolved)

  // 检查目录是否存在
  if (!fs.existsSync(dir)) {
    return { ok: false, message: `目标目录不存在：${dir}` }
  }

  // 检查目录写权限
  try {
    fs.accessSync(dir, fs.constants.W_OK)
  } catch {
    return { ok: false, message: `目录没有写权限：${dir}` }
  }

  // 如果文件已存在，检查是否可覆盖
  if (fs.existsSync(resolved)) {
    try {
      fs.accessSync(resolved, fs.constants.W_OK)
    } catch {
      return { ok: false, message: `文件存在但没有写权限：${resolved}` }
    }
  }

  return { ok: true, message: '可写' }
}

/**
 * 安全读文件（带检查）
 */
export function safeReadFile(filePath: string): { content?: string; error?: string } {
  const check = checkReadable(filePath)
  if (!check.ok) return { error: check.message }

  try {
    return { content: fs.readFileSync(path.resolve(filePath), 'utf-8') }
  } catch (err: any) {
    return { error: `读取失败：${err.message}` }
  }
}

/**
 * 安全写文件（带检查）
 */
export function safeWriteFile(
  filePath: string,
  content: string,
): { ok: boolean; error?: string } {
  const check = checkWritable(filePath)
  if (!check.ok) return { ok: false, error: check.message }

  try {
    fs.writeFileSync(path.resolve(filePath), content, 'utf-8')
    return { ok: true }
  } catch (err: any) {
    // 磁盘满等运行时错误
    if (err.code === 'ENOSPC') {
      return { ok: false, error: '磁盘空间不足，无法写入' }
    }
    return { ok: false, error: `写入失败：${err.message}` }
  }
}