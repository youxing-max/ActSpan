import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 判断当前模块是否被直接执行。
 *
 * npm 全局安装时 `node_modules/.bin/*` 是指向真实文件的软链，
 * `process.argv[1]` 是软链路径，直接与 `import.meta.url` 比较会判定失败，
 * 导致 CLI 静默空转。这里统一按真实路径比较。
 */
export function isDirectExecution(metaUrl) {
    if (!process.argv[1]) return false;
    try {
        return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
    } catch {
        return false;
    }
}
