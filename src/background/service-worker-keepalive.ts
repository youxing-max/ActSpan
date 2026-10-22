/**
 * service-worker-keepalive.ts — 任务运行期间保活 Service Worker
 *
 * MV3 的 Service Worker 在空闲约 30 秒后会被浏览器挂起。长任务期间如果所有
 * 网络/工具调用恰好处于等待状态，SW 会被回收，下一轮启动时把 running 会话
 * 判定为“后台服务已重启”，从而产生中断提示。
 *
 * 这里用轻量的扩展 API 心跳维持 SW 存活，引用计数为 0 时立即停止，
 * 不影响空闲时的正常回收。
 */

const KEEPALIVE_INTERVAL_MS = 20_000;

type KeepAliveTimer = ReturnType<typeof setInterval>;

let timer: KeepAliveTimer | null = null;
let refCount = 0;

/** 触发一次扩展 API 调用，让浏览器认为 SW 仍在工作 */
function ping() {
  try {
    chrome.runtime.getPlatformInfo(() => {
      // 读取 lastError，避免扩展卸载后产生未处理的运行时错误
      void chrome.runtime.lastError;
    });
  } catch {
    // 扩展上下文失效时忽略，计时器会在释放时清理
  }
}

/**
 * 获取保活引用。返回释放函数；必须与获取次数配对调用。
 * 多个并发任务共享同一个心跳计时器。
 */
export function acquireServiceWorkerKeepAlive(): () => void {
  refCount += 1;
  if (!timer) {
    ping();
    timer = setInterval(ping, KEEPALIVE_INTERVAL_MS);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** 仅供测试与诊断：当前保活引用数与计时器状态 */
export function getServiceWorkerKeepAliveState(): { refCount: number; active: boolean } {
  return { refCount, active: timer !== null };
}
