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
let canvas: HTMLCanvasElement | null = null;
let canvasMode = false;
let frameQueue: Promise<void> = Promise.resolve();
let finishing: Promise<void> | null = null;
let captureError: Error | null = null;

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

/** 等最后一帧及 dataavailable/stop 完成，保留 chunks 供取件。 */
const finishRecorder = (): Promise<void> => {
    if (finishing) return finishing;
    clearAutoStop();
    active = false;
    finishing = (async () => {
        try {
            await frameQueue;
            const rec = recorder;
            if (rec && rec.state !== 'inactive') {
                await new Promise<void>((resolve, reject) => {
                    rec.onstop = () => resolve();
                    rec.onerror = () => reject(new Error('录屏编码失败'));
                    rec.stop();
                });
            }
        } finally {
            recorder = null;
            canvas = null;
            stopTracks();
        }
    })();
    return finishing;
};

const prepareRecording = (): void => {
    if (active || recorder || chunks.length) throw new Error('已有进行中或待取件的录制');
    chunks = [];
    finishing = null;
    frameQueue = Promise.resolve();
    captureError = null;
};

const beginMediaRecorder = (media: MediaStream): void => {
    stream = media;
    const mimeType = pickMimeType();
    recorder = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    recorder.start(1000);
};

const armAutoStop = (maxDurationMs: number): void => {
    if (maxDurationMs > 0) {
        autoStopTimer = setTimeout(() => {
            void finishRecorder().catch(err => { captureError = err; });
        }, maxDurationMs);
    }
};

const startRecording = async (streamId: string, maxDurationMs: number): Promise<void> => {
    prepareRecording();
    canvasMode = false;
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

    try {
        beginMediaRecorder(await navigator.mediaDevices.getUserMedia(constraints));
        active = true;
        armAutoStop(maxDurationMs);
    } catch (err) { stopTracks(); recorder = null; throw err; }
};

const stopRecording = async (): Promise<{ dataUrl: string; sizeBytes: number }> => {
    await finishRecorder();
    if (captureError) throw captureError;
    if (chunks.length === 0) throw new Error('录屏未采集到任何帧');
    return assembleBlob();
};

const cancelRecording = async (): Promise<void> => {
    try { await finishRecorder(); } finally { chunks = []; captureError = null; }
};

/** 解码 base64 jpeg 为 HTMLImageElement */
const loadImage = (src: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('帧解码失败'));
        img.src = src;
    });

const startCanvasRecording = (maxDurationMs: number): void => {
    prepareRecording();
    canvasMode = true;
    active = true;
    armAutoStop(maxDurationMs);
};

const appendFrame = (data: string): Promise<void> => {
    if (!active || !canvasMode) return Promise.resolve();
    const next = frameQueue.then(async () => {
        const image = await loadImage(`data:image/jpeg;base64,${data}`);
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            beginMediaRecorder(canvas.captureStream(0));
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('无法创建 canvas 上下文');
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        // 显式请求采样，隐藏 offscreen 文档没有 requestAnimationFrame 回调。
        (stream!.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack).requestFrame();
        await new Promise(resolve => setTimeout(resolve, 0));
    });
    frameQueue = next.catch(err => { captureError = err; });
    return next;
};

export const initScreenCapture = (): void => {
    chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
        const frame = message as Record<string, unknown>;
        if (frame.type === 'screen_record_canvas_start') {
            try {
                startCanvasRecording(Number(frame.maxDurationMs) || 0);
                sendResponse({ success: true });
            } catch (err) { sendResponse({ success: false, error: String(err) }); }
            return false;
        }
        if (frame.type === 'screen_record_frame') {
            void appendFrame(String(frame.data || '')).then(
                () => sendResponse({ success: true }),
                err => sendResponse({ success: false, error: String(err) }),
            );
            return true;
        }
        if (frame.type === 'screen_record_finish') {
            void finishRecorder().then(
                () => sendResponse({ success: true }),
                err => sendResponse({ success: false, error: String(err) }),
            );
            return true;
        }
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
            void cancelRecording().then(
                () => sendResponse({ success: true }),
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
