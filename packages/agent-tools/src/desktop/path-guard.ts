/**
 * Workspace 路径围栏(desktop local 版)—— local tool 访问 fs 前先过这一关,
 * 防止 LLM 用 `..` / 绝对路径 / 符号链接 跳出工作目录。
 *
 * NOTE(shared-logic): 逻辑与 `../cloud/path-guard.ts` 等价。两端目前各自
 * 持有一份以维持 local / cloud 工具目录的隔离边界(见 AGENTS.md §1);
 * 后续若做共享逻辑抽取,这是首选合并项之一。
 */

import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

async function assertWithinWorkspace(absolutePath: string, workspaceRoot: string): Promise<void> {
  const rootReal = await realpath(workspaceRoot);

  let candidate = resolve(absolutePath);
  const suffixParts: string[] = [];
  while (true) {
    let ancestorReal: string;
    try {
      ancestorReal = await realpath(candidate);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw err;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new Error(`Workspace path escapes local runtime root: ${absolutePath}`);
      }
      suffixParts.unshift(basename(candidate));
      candidate = parent;
      continue;
    }

    const finalPath =
      suffixParts.length === 0 ? ancestorReal : resolve(ancestorReal, ...suffixParts);
    const rel = relative(rootReal, finalPath);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Workspace path escapes local runtime root: ${absolutePath}`);
    }
    return;
  }
}

/**
 * 把用户给定的(可能相对)路径解析成绝对路径并过 workspace 围栏,
 * 返回经 `path.resolve` 的绝对路径供 fs 操作直接使用。
 */
export async function resolveWithinWorkspace(
  inputPath: string,
  workspaceRoot: string,
): Promise<string> {
  const abs = isAbsolute(inputPath) ? inputPath : resolve(workspaceRoot, inputPath);
  await assertWithinWorkspace(abs, workspaceRoot);
  return abs;
}
