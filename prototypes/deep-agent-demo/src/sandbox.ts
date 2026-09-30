// 沙箱模块
// 管理智能体的工作区，本质上处理的是文件映射和安全隔离
import fs from "fs";
import path from "path";

export interface SandboxConfig {
  // 工作区路径
  workspaceDir: string;
  // 输出目录，相对于工作区
  outputDir?: string;
  // 是否开启日志
  verbose?: boolean;
}

export interface SandboxContent {
  // 工作区真实路径
  workspacePath: string;
  // 输出真实路径
  outputPath?: string;
  // 沙箱内写文件
  writeFile: (filename: string, content: string) => string;
  // 沙箱内读文件
  readFile: (filename: string) => string | null;
  // 列出的文件
  listFiles: () => string[]
  // 路径是否在沙箱内 安全校验
  isPathSafe: (targetPath: string) => boolean
}

// 创建沙箱上下文（所有文件操作目录）
export function createSandbox(config: SandboxConfig) : SandboxContent {
  const workspacePath = path.resolve(config.workspaceDir);
  const outputDir = config.outputDir || 'output';
  const outputPath = path.join(workspacePath, outputDir);
  const verbose = config.verbose ?? true;

  // 确保输出目录存在
  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputPath, {recursive : true});
  }

  if (verbose) {
    console.log(`[Sandbox] 工作区初始化完成`)
    console.log(`[Sandbox]   真实路径：${workspacePath}`)
    console.log(`[Sandbox]   输出目录：${outputPath}`)
  }

  // 安全校验，目标路径必须在工作区内
  function isPathSafe(targetPath: string) : boolean {
    const resolved = path.resolve(outputPath, targetPath);
    return resolved.startsWith(outputPath)
  }

  // 写文件到输出目录
  function writeFile(filename : string, content : string) : string {
    if (!isPathSafe(filename)) {
      throw new Error(`[Sandbox] 安全拦截，路径越界 ${filename}`)
    }

    const targetPath = path.join(outputPath, filename);
    // 确保子目录存在
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, {recursive : true});
    }
    fs.writeFileSync(targetPath, content, 'utf-8')
    if (verbose) {
      console.log(`[Sandbox] 文件已写入：${path.relative(workspacePath, targetPath)}`)
    }

    return targetPath;
  }

  // 读取目录的文件
  function readFile(filename : string) : string | null {
    if (!isPathSafe(filename)) {
      console.warn(`[Sandbox] 安全拦截：路径越界，无法读取 ${filename}`)
      return null
    }

    const targetPath = path.join(outputPath, filename);
    if (!fs.existsSync(targetPath)) {
      return null;
    }

    return fs.readFileSync(targetPath, 'utf-8');
  }

  // 列出 输出目录中所有的文件
  function listFiles() : string[] {
    if (!fs.existsSync(outputPath)) {
      return [];
    }

    const walk = (dir: string) : string[] => {
      const entries = fs.readdirSync(dir, {withFileTypes: true})
      return entries.flatMap(entry => {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          return walk(fullPath)
        }
        return [path.relative(outputPath, fullPath)]
      })
    }

    return walk(outputPath)
  }

  return {
  workspacePath,
  outputPath,
  writeFile,
  readFile,
  listFiles,
  isPathSafe,
}
}
