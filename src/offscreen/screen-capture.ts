/**
 * 屏幕录制（tabCapture + MediaRecorder），运行在 offscreen 文档里。
 *
 * 只被 service worker 通过 chrome.runtime.onMessage 驱动，自身不主动对外：
 *   { type: 'screen_record_start', streamId, maxDurationMs }  → 开始录制
 *   { type: 'screen_record_stop' }                            → 停止并回传 webm base64
 *   { type: 'screen_record_cancel' }                          → 放弃并清理
 *
 * 视频以 webm 编码回传（dataUrl + sizeBytes），分辨率默认 1280x720@15fps
 * 以控制体积；超过 maxDurationMs 自动停止（停止后仍可再 stop 取件）。
 */

let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];
let active = false;
let autoStopTimer: ReturnType<typeof setTimeout> | null = null;

/** Uint8Array → base64（分块拼接，避免大数组的栈溢出） */
const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode(...bytes.subarray(i, i + step));
    }
    return btoa(binary);
};

const pickMimeType = (): string | undefined => {
    const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (const mime of candidates) {
        if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) return mime;
    }
    return undefined;
};

const assembleBlob = async (): Promise<{ dataUrl: string; sizeBytes: number }> => {
    const mime = 'video/webm';
    const blob = new Blob(chunks, { type: mime });
    chunks = [];
    const buffer = await blob.arrayBuffer();
    return { dataUrl: `data:${mime};base64,${arrayBufferToBase64(buffer)}`, sizeBytes: buffer.byteLength };
};

const stopTracks = (): void => {
    if (stream) {
        try { stream.getTracks().forEach((track) => track.stop()); } catch { /* 忽略 */ }
        stream = null;
    }
};

const clearAutoStop = (): void => {
    if (autoStopTimer) {
        clearTimeout(autoStopTimer);
        autoStopTimer = null;
    }
};

/** 停止 MediaRecorder 与音视频轨；chunks 保留供 stopRecording 组装。 */
const finishRecorder = (): void => {
    clearAutoStop();
    if (recorder && recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* 忽略 */ }
    }
    recorder = null;
    active = false;
    stopTracks();
};

const startRecording = async (streamId: string, maxDurationMs: number): Promise<void> => {
    if (active) throw new Error('录制已在进行中');
    const constraints = {
        audio: false,
        video: {
            mandatory: {
                chromeMediaSource: 'tab',
                chromeMediaSourceId: streamId,
                maxWidth: 1280,
                maxHeight: 720,
                maxFrameRate: 15,
            },
        },
    } as MediaStreamConstraints;

    stream = await navigator.mediaDevices.getUserMedia(constraints);
    chunks = [];
    const mimeType = pickMimeType();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    recorder.start(1000);
    active = true;

    if (maxDurationMs > 0) {
        autoStopTimer = setTimeout(() => finishRecorder(), maxDurationMs);
    }
};

const stopRecording = async (): Promise<{ dataUrl: string; sizeBytes: number }> => {
    if (!active) {
        if (chunks.length === 0) throw new Error('没有进行中的录制');
        return assembleBlob();
    }

    const rec = recorder;
    clearAutoStop();
    if (rec && rec.state !== 'inactive') {
        await new Promise<void>((resolve) => {
            rec.onstop = () => resolve();
            rec.stop();
        });
    }
    recorder = null;
    active = false;
    stopTracks();
    return assembleBlob();
};

const cancelRecording = (): void => {
    finishRecorder();
    chunks = [];
};

/** 解码 base64 jpeg 为 HTMLImageElement */
const loadImage = (src: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('帧解码失败'));
        img.src = src;
    });

/**
 * 把 debugger screencast 的 jpeg 帧序列按 fps 实时重放到 canvas，
 * 经 captureStream + MediaRecorder 编成 webm（无需额外 muxer 库）。
 * 用于无人值守录屏回退路径（tabCapture 因 activeTab 手势被拒时）。
 */
const encodeFrames = async (
    frames: Array<{ data: string; ts: number }>,
    fps: number,
): Promise<{ dataUrl: string; sizeBytes: number }> => {
    if (!frames.length) throw new Error('没有可编码的帧');
    // 并行预解码全部帧（消除逐帧 loadImage 的串行延迟）
    const images = await Promise.all(frames.map((f) => loadImage(`data:image/jpeg;base64,${f.data}`)));
    const first = images[0];
    const canvas = document.createElement('canvas');
    canvas.width = first.naturalWidth || 1280;
    canvas.height = first.naturalHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 canvas 上下文');

    const stream = canvas.captureStream(fps);
    const mimeType = pickMimeType();
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const out: Blob[] = [];
    rec.ondataavailable = (e: BlobEvent) => { if (e.data && e.data.size > 0) out.push(e.data); };
    const stopped = new Promise<void>((resolve) => { rec.onstop = () => resolve(); });
    rec.start();

    // 快进绘制：不等真实帧间隔（旧实现 N 帧 × 1000/fps 毫秒导致长录屏必然超时），
    // 每帧用 requestAnimationFrame 让出一拍采样窗口，编码耗时从秒级降到毫秒级。
    for (const img of images) {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());

    const blob = new Blob(out, { type: 'video/webm' });
    const buffer = await blob.arrayBuffer();
    return { dataUrl: `data:video/webm;base64,${arrayBufferToBase64(buffer)}`, sizeBytes: buffer.byteLength };
};

export const initScreenCapture = (): void => {
    chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
        const frame = message as Record<string, unknown>;
        if (frame.type === 'screen_record_start') {
            void startRecording(String(frame.streamId), Number(frame.maxDurationMs) || 0).then(
                () => sendResponse({ success: true }),
                (err: unknown) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }),
            );
            return true;
        }
        if (frame.type === 'screen_record_stop') {
            void stopRecording().then(
                (payload) => sendResponse({ success: true, ...payload }),
                (err: unknown) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }),
            );
            return true;
        }
        if (frame.type === 'screen_record_cancel') {
            cancelRecording();
            sendResponse({ success: true });
            return true;
        }
        if (frame.type === 'screen_record_encode') {
            const frames = Array.isArray(frame.frames) ? frame.frames as Array<{ data: string; ts: number }> : [];
            void encodeFrames(frames, Number(frame.fps) || 2).then(
                (payload) => sendResponse({ success: true, ...payload }),
                (err: unknown) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }),
            );
            return true;
        }
        if (frame.type === 'screen_record_ping') {
            sendResponse({ success: true, ready: true });
            return false;
        }
        return false;
    });
};
