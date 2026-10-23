import { appendFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';

const safePath = (value) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('savePath must be an explicit non-empty path');
    if (value.includes('\0')) throw new Error('savePath contains NUL');
    if (/(^|[\\/])\.\.?([\\/]|$)/.test(value)) throw new Error('savePath must not contain traversal segments');
    return value;
};
const pagePreview = (value) => value === undefined ? null : JSON.stringify(value).slice(0, 2000);
const writePage = async (savePath, value, first) => {
    const target = safePath(savePath);
    await (first ? writeFile : appendFile)(target, `${JSON.stringify(value)}\n`);
    return target;
};
const writeBinaryChunks = async (savePath, transfer, callBridge, task) => {
    const target = safePath(savePath);
    await writeFile(target, '');
    try {
        for (let offset = 0; offset < transfer.bytes; offset += 65536) {
            const chunk = await callBridge('data.fetch_chunk', { transferId: transfer.transferId, offset, length: 65536 }, 30000, task);
            if (!chunk?.base64 || chunk.offset !== offset) throw new Error('Invalid binary transfer chunk');
            await appendFile(target, Buffer.from(chunk.base64, 'base64'));
        }
        return target;
    } finally {
        await callBridge('data.fetch_release', { transferId: transfer.transferId }, 10000, task).catch(() => undefined);
    }
};

export default function registerDataTools({ registerTool, callBridge, run, tabIdParam, taskParams }) {
    registerTool('actspan_data_fetch', {
        title: 'Fetch data',
        description: 'Fetch page or binary data through the extension. Binary is extension-side by default for cross-origin resources; via page is only for Referer-sensitive resources. Binary returns a bounded transfer descriptor; use savePath to stream chunks in the MCP server process.',
        inputSchema: { ...taskParams, tabId: tabIdParam, url: z.string().url(), binary: z.boolean().default(false), via: z.enum(['extension', 'page']).default('extension'), referer: z.string().url().optional(), sections: z.array(z.enum(['meta', 'content', 'links', 'headings'])).optional(), max_content_length: z.number().int().min(500).max(10000).default(5000), savePath: z.string().min(1).optional() },
    }, run(async (args) => {
        const { savePath, ...params } = args || {};
        const task = args || {};
        const result = await callBridge('data.fetch', params, 60000, task);
        if (savePath) {
            if (!params.binary) throw new Error('savePath is supported for binary fetch only; use data.paginate for NDJSON');
            const target = await writeBinaryChunks(savePath, result, callBridge, task);
            return { saved: target, bytes: result.bytes, status: result.status, content_type: result.content_type };
        }
        return result;
    }));

    registerTool('actspan_data_paginate', {
        title: 'Paginate data',
        description: 'Fetch JSON pages through bounded extension calls without guessing pagination. Provide param or cursorParam. Stop reasons are identical_response, non_2xx, max_pages, normal_end, or credential_page (a credential/token URL is never returned). savePath writes one JSON page per line in the MCP server process and returns only a summary plus first-page preview. A page over 64KiB is rejected as PAGE_TOO_LARGE rather than truncated.',
        inputSchema: { ...taskParams, tabId: tabIdParam, url: z.string().url(), params: z.record(z.unknown()).default({}), param: z.string().min(1).optional(), cursorParam: z.string().min(1).optional(), cursorPath: z.string().min(1).optional(), maxPages: z.number().int().min(1).max(100).default(10), savePath: z.string().min(1).optional() },
    }, run(async (args) => {
        const { savePath, ...params } = args || {};
        const task = args || {};
        if (!params.param && !params.cursorParam) throw new Error('Provide param for page pagination or cursorParam for cursor pagination; no pagination parameter was guessed');
        if (params.param && params.cursorParam) throw new Error('param and cursorParam are mutually exclusive');
        if (params.cursorParam && !params.cursorPath) throw new Error('cursorParam requires cursorPath');
        const maxPages = Math.min(100, Math.max(1, Math.floor(Number(params.maxPages) || 10)));
        let page = 1; let cursor; let previous = ''; let stop_reason = 'normal_end'; let firstPage; let page_count = 0; let actual_page_sizes = [];
        for (let index = 0; index < maxPages; index += 1) {
            const request = { ...params, ...(params.param ? { page } : {}), ...(params.cursorParam && cursor !== undefined ? { cursor } : {}) };
            const result = await callBridge('data.paginate', request, 90000, task);
            if (!result?.ok) { stop_reason = result?.stop_reason || 'non_2xx'; break; }
            const signature = JSON.stringify(result.data);
            if (previous && signature === previous) { stop_reason = 'identical_response'; break; }
            previous = signature; if (firstPage === undefined) firstPage = result.data;
            page_count += 1; if (typeof result.actual_page_size === 'number') actual_page_sizes.push(result.actual_page_size);
            if (savePath) await writePage(savePath, result.data, page_count === 1);
            if (result.data === null || result.data === '' || (Array.isArray(result.data) && result.data.length === 0)) { stop_reason = 'normal_end'; break; }
            if (params.cursorParam) { if (result.nextCursor === undefined || result.nextCursor === null || result.nextCursor === '') { stop_reason = 'normal_end'; break; } cursor = result.nextCursor; }
            else page += 1;
            if (index === maxPages - 1) stop_reason = 'max_pages';
        }
        return { page_count, stop_reason, actual_page_sizes, ...(savePath ? { saved: safePath(savePath) } : {}), first_page_preview: pagePreview(firstPage) };
    }));

    registerTool('actspan_data_download', {
        title: 'Download file', description: 'Download a URL, text, or screenshot through chrome.downloads. Uses saveAs:false to avoid a system save dialog and has no inline size limit.',
        inputSchema: { ...taskParams, tabId: tabIdParam, url: z.string().url().optional(), content: z.string().optional(), artifact_id: z.string().min(1).optional(), filename: z.string().min(1).optional() },
    }, run((args) => callBridge('data.download', args || {}, 60000, args || {})));
}

export { safePath };
