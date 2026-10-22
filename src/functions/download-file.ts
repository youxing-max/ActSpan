/**
 * 文件下载工具
 * 使用 chrome.downloads API 下载文件或将文本内容保存为文件
 */

import type { FunctionDefinition } from './types';
import { ArtifactStore } from '../lib/artifact-store';
import { isBlockedFetchUrl } from '../lib/ssrf-guard';
import { isCredentialUrl } from './redact';

const MAX_INLINE_BYTES = 10 * 1024 * 1024;
const BLOCKED_EXTENSIONS = new Set([
  'command', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'app', 'scr', 'exe', 'dmg', 'pkg', 'jar', 'vbs', 'hta',
]);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** 只保留文件名本身，拒绝路径穿越、控制字符、Windows 保留名和可执行后缀。 */
export const sanitizeFilename = (value?: string): { name?: string; error?: string } => {
  const raw = String(value || '').trim();
  if (!raw) return {};
  let name = raw.split(/[\\/]/).pop()?.replace(/\p{Cc}/gu, '').trim() || '';
  name = name.replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') return { error: 'filename 不是合法文件名' };
  if (WINDOWS_RESERVED.test(name)) return { error: 'filename 使用了系统保留名' };
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (BLOCKED_EXTENSIONS.has(ext)) return { error: `不允许下载可执行文件（.${ext}）` };
  return { name: name.slice(0, 200) };
};

/** 从 URL 路径推导文件名，避免服务端 Content-Disposition 决定扩展名。 */
const filenameFromUrl = (value: string): string => {
  try {
    const last = new URL(value).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last);
  } catch {
    return '';
  }
};

/** 根据文件名后缀推断 MIME 类型 */
const inferMimeType = (filename?: string): string => {
  if (!filename) return 'text/plain';
  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    json: 'application/json',
    csv: 'text/csv',
    html: 'text/html',
    htm: 'text/html',
    xml: 'application/xml',
    md: 'text/markdown',
    txt: 'text/plain',
    js: 'application/javascript',
    css: 'text/css',
  };
  return mimeMap[ext || ''] || 'text/plain';
};

export const downloadFileFunction: FunctionDefinition = {
  name: 'download_file',
  description: 'LAST RESORT for extracting structured data, not for a user-requested file. Try first: cdp_network to inspect actual responses, page(action="view") to read rendered content, fetch_url for an observed URL, or data_pipeline to export structured results. Use download_file when the user needs an actual file saved. saveAs:false avoids the system save dialog when used through a workflow. Can download a URL, save text content, or export a screenshot artifact.',
  supportsParallel: true,
  permissionLevel: 'sensitive',
  approvalMessageTemplate: 'AI 正在请求下载文件 "{filename}"',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'File URL to download. Mutually exclusive with content/artifact_id',
      },
      content: {
        type: 'string',
        description: 'Text content to save as a file. Mutually exclusive with url/artifact_id',
      },
      artifact_id: {
        type: 'string',
        description: 'Screenshot artifact ID (returned by the screenshot tool). Automatically retrieves the image from local storage and downloads it',
      },
      filename: {
        type: 'string',
        description: 'Filename to save as (e.g. "report.txt", "data.json", "screenshot.png"). Auto-inferred if omitted',
      },
    },
    required: [],
  },
  validate: (params: { url?: string; content?: string; artifact_id?: string; filename?: string }) => {
    const sources = [params.url !== undefined, params.content !== undefined, params.artifact_id !== undefined].filter(Boolean).length;
    if (sources === 0) return 'One of url, content, or artifact_id is required';
    if (sources > 1) return 'Only one of url, content, or artifact_id can be provided';
    if (params.url !== undefined) {
      try {
        if (!/^https?:$/.test(new URL(params.url).protocol)) return 'url must be an http/https link';
      } catch {
        return 'url must be an http/https link';
      }
      if (isBlockedFetchUrl(params.url)) return 'url 不允许指向本机或内网地址';
      if (isCredentialUrl(params.url)) return '凭据页面不允许下载';
    }
    if (params.filename !== undefined) {
      const sanitized = sanitizeFilename(params.filename);
      if (sanitized.error) return sanitized.error;
    }
    if (params.content !== undefined && new Blob([params.content]).size > MAX_INLINE_BYTES) {
      return `content exceeds ${MAX_INLINE_BYTES} bytes`;
    }
    return null;
  },
  execute: async (params: { url?: string; content?: string; artifact_id?: string; filename?: string }) => {
    const { url, content, artifact_id, filename } = params;

    const validationError = downloadFileFunction.validate?.(params);
    if (validationError) return { success: false, error: validationError };
    const safeFilename = sanitizeFilename(filename);
    if (safeFilename.error) return { success: false, error: safeFilename.error };
    // URL 下载始终显式指定文件名，防止 Content-Disposition 给出可执行后缀。
    const urlFilename = url ? sanitizeFilename(filenameFromUrl(url) || 'actspan-download') : undefined;
    if (urlFilename?.error) return { success: false, error: urlFilename.error };
    const effectiveFilename = safeFilename.name || urlFilename?.name;

    try {
      let downloadUrl = url;

      // 如果传入了 artifact_id，从 ArtifactStore 取出 dataUrl
      if (artifact_id) {
        const artifact = await ArtifactStore.getScreenshot(artifact_id);
        if (!artifact) {
          return { success: false, error: `截图不存在或已过期：${artifact_id}` };
        }
        if (!/^data:image\/(?:png|jpeg);base64,/i.test(artifact.dataUrl)
          || artifact.dataUrl.slice(artifact.dataUrl.indexOf(',') + 1).length > Math.ceil(MAX_INLINE_BYTES / 3) * 4) {
          return { success: false, error: '截图格式不受支持或文件过大' };
        }
        downloadUrl = artifact.dataUrl;
      }

      // 如果是文本内容，转为 data URL
      if (content !== undefined) {
        const mime = inferMimeType(filename);
        const base64 = btoa(unescape(encodeURIComponent(content)));
        downloadUrl = `data:${mime};charset=utf-8;base64,${base64}`;
      }
      if (!downloadUrl) {
        return { success: false, error: '无法生成下载链接' };
      }

      const downloadOptions: chrome.downloads.DownloadOptions = {
        url: downloadUrl,
        saveAs: false,
      };
      if (effectiveFilename) {
        downloadOptions.filename = effectiveFilename;
      }

      const downloadId = await chrome.downloads.download(downloadOptions);

      return {
        success: true,
        data: {
          message: effectiveFilename ? `已开始下载：${effectiveFilename}` : '已开始下载',
          download_id: downloadId,
        },
      };
    } catch (err: any) {
      return { success: false, error: err.message || '下载失败' };
    }
  },
};
