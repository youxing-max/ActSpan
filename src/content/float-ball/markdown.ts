/**
 * 悬浮胶囊 — Markdown 解析工具
 */

/** 转义 HTML 特殊字符 */
export const escapeHtml = (text: string): string => {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
};

/** 常见图片扩展名 */
const IMG_EXT_RE = /\.(jpe?g|png|gif|webp|svg|bmp|avif)(\?[^\s)]*)?$/i;

/** 匹配 markdown 图片语法 ![alt](url) */
const MD_IMG_RE = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/;

/** 内联 Markdown：图片、链接、加粗、斜体、删除线、行内代码 */
export const inlineMarkdown = (escaped: string): string => {
  // 先用占位符保护图片和链接语法，防止内部的特殊字符被其他规则误匹配
  const slots: string[] = [];
  const ph = (s: string) => { slots.push(s); return `%%SLOT${slots.length - 1}%%`; };

  let result = escaped
    // 1. 显式图片语法 ![alt](url) — 最先处理
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) =>
      ph(`<img src="${url}" alt="${alt}" class="mole-md-img" loading="lazy">`))
    // 2. 链接语法 [text](url) — 图片 URL 渲染为 <img>，去掉文本内多余反引号
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, rawText: string, url: string) => {
      const text = rawText.replace(/^`+|`+$/g, '');
      return ph(IMG_EXT_RE.test(url)
        ? `<img src="${url}" alt="${text}" class="mole-md-img" loading="lazy">`
        : `<a href="${url}" target="_blank" rel="noopener">${text}</a>`);
    });

  // 3. 其他内联格式（在链接已保护后安全执行）
  // 注意：不渲染行内反引号为 <code>，AI 常用反引号"强调"文本而非代码，渲染成 code 反而影响可读性和点击
  result = result
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/`(.+?)`/g, '$1');

  // 4. 还原占位符
  return result.replace(/%%SLOT(\d+)%%/g, (_, i) => slots[+i]);
};

/**
 * 缩短 URL 用于显示
 * https://www.bilibili.com/video/BV1Za4y1L7DN/ → bilibili.com/video/BV1Za4y…
 */
const shortenUrl = (url: string): string => {
  try {
    const u = new URL(url.replace(/&amp;/g, '&'));
    const domain = u.hostname.replace(/^www\./, '');
    const path = decodeURIComponent(u.pathname).replace(/\/$/, '');
    const query = u.search;
    if (!path || path === '/') return domain;
    const full = domain + path + (query ? '?…' : '');
    if (full.length <= 40) return full;
    // 保留域名 + 路径前段 + 文件名
    const segments = path.split('/').filter(Boolean);
    if (segments.length <= 2) return domain + '/' + segments.join('/').slice(0, 30) + '…';
    return domain + '/' + segments[0] + '/…/' + segments[segments.length - 1].slice(0, 18);
  } catch {
    return url.slice(0, 40) + '…';
  }
};

/** 构建 link chip HTML */
const buildLinkChip = (href: string, urlText: string): string => {
  try {
    const cleanUrl = urlText.replace(/&amp;/g, '&');
    const domain = new URL(cleanUrl).hostname.replace(/^www\./, '');
    const favicon = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
    const short = shortenUrl(cleanUrl);
    return `<a href="${href}" target="_blank" rel="noopener" class="mole-link-chip" data-url="${cleanUrl}" title="${escapeHtml(cleanUrl)}">`
      + `<img src="${favicon}" class="mole-link-favicon" onerror="this.style.display='none'">`
      + `<span class="mole-link-text">${escapeHtml(short)}</span></a>`;
  } catch {
    return `<a href="${href}" target="_blank" rel="noopener">${urlText}</a>`;
  }
};

/**
 * 后处理 HTML：
 * 1. 自动链接裸 URL（在纯文本中，不在 tag 属性内）
 * 2. 图片 URL 链接升级为 <img>
 * 3. URL 文本链接升级为 link chip（favicon + 短域名）
 */
const postProcessHtml = (html: string): string => {
  // 第一步：裸 URL 自动链接（安全地只处理文本段，跳过 HTML 标签内容）
  const parts = html.split(/(<[^>]+>)/);
  let inAnchor = false;
  let inCode = false;
  html = parts.map(part => {
    if (part.startsWith('<')) {
      if (/^<a[\s>]/.test(part)) inAnchor = true;
      if (part === '</a>') inAnchor = false;
      if (/^<(?:code|pre)[\s>]/.test(part)) inCode = true;
      if (/^<\/(?:code|pre)>/.test(part)) inCode = false;
      return part;
    }
    // 纯文本段：不在 <a> 和 <code>/<pre> 内时，自动链接裸 URL
    if (inAnchor || inCode) return part;
    return part.replace(
      /\bhttps?:\/\/[^\s<]+/g,
      url => `<a href="${url.replace(/&amp;/g, '&')}" target="_blank" rel="noopener">${url}</a>`,
    );
  }).join('');

  // 第二步：图片链接升级
  html = html.replace(
    /<a\s+href="([^"]+)"[^>]*>([^<]*)<\/a>/g,
    (match, url, text) => {
      if (IMG_EXT_RE.test(url)) {
        return `<img src="${url}" alt="${text || 'image'}" class="mole-md-img" loading="lazy">`;
      }
      return match;
    },
  );

  // 第三步：URL 文本链接 → link chip（仅当链接文本本身是 URL 时）
  html = html.replace(
    /<a\s+href="([^"]+)"[^>]*>(https?:\/\/[^<]+)<\/a>/g,
    (_, href, urlText) => buildLinkChip(href, urlText),
  );

  return html;
};

/** 将原始文本拆分为段落，代码块作为完整单元保留不被打断 */
const splitBlocks = (text: string): string[] => {
  const result: string[] = [];
  const lines = text.split('\n');
  let buf: string[] = [];
  let inFence = false;

  const flushBuf = () => {
    if (buf.length === 0) return;
    const joined = buf.join('\n');
    // 按双换行拆分非代码块内容，标题和水平线独立成 block
    const preprocessed = joined
      .replace(/^(#{1,6}\s+.+)$/gm, '\n\n$1\n\n')
      .replace(/^([-*_]{3,})\s*$/gm, '\n\n$1\n\n');
    for (const b of preprocessed.split(/\n{2,}/)) {
      const t = b.trim();
      if (t) result.push(t);
    }
    buf = [];
  };

  for (const line of lines) {
    if (!inFence && /^```/.test(line.trim())) {
      flushBuf();
      inFence = true;
      buf.push(line);
      continue;
    }
    if (inFence && /^```\s*$/.test(line.trim())) {
      buf.push(line);
      result.push(buf.join('\n'));
      buf = [];
      inFence = false;
      continue;
    }
    buf.push(line);
  }
  flushBuf();
  return result;
};

/** Markdown 文本转 HTML（支持标题、列表、表格、水平线、代码块、段落、内联格式） */
export const markdownToHtml = (text: string): string => {
  const blocks = splitBlocks(text);
  let html = '';

  for (const trimmed of blocks) {
    if (!trimmed) continue;
    const lines = trimmed.split('\n');

    // 代码块
    const fenceMatch = trimmed.match(/^```([a-zA-Z0-9_-]*)[ \t]*\n([\s\S]*?)\n?```\s*$/);
    if (fenceMatch) {
      const language = (fenceMatch[1] || '').trim();
      const codeText = fenceMatch[2];

      // markdown/md 语言标记 → 直接当 markdown 渲染
      // 无语言标记但包含 markdown 语法（标题/图片/链接/列表）→ 也当 markdown 渲染
      const isMdLang = /^(?:markdown|md)$/i.test(language);
      const codeLines = codeText.split('\n').filter(l => l.trim());
      const MD_SYNTAX_RE = /^#{1,6}\s|!\[.*\]\(|^\[.*\]\(|^[-*]\s|^>\s|^\d+\.\s/;
      if (isMdLang || (!language && codeLines.length > 0 && codeLines.some(l => MD_SYNTAX_RE.test(l.trim())))) {
        html += markdownToHtml(codeText);
        continue;
      }

      const langClass = language ? ` class="language-${escapeHtml(language)}"` : '';
      html += `<pre><code${langClass}>${escapeHtml(codeText)}</code></pre>`;
      continue;
    }

    // 水平分割线
    if (/^[-*_]{3,}\s*$/.test(trimmed)) {
      html += '<hr>';
      continue;
    }

    // 标题
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length + 2, 5);
      const tag = `h${level}`;
      html += `<${tag}>${inlineMarkdown(escapeHtml(headingMatch[2]))}</${tag}>`;
      continue;
    }

    // 引用
    if (lines.every((line) => line.trim().startsWith('>'))) {
      const quote = lines
        .map((line) => line.trim().replace(/^>\s?/, ''))
        .map((line) => inlineMarkdown(escapeHtml(line)))
        .join('<br>');
      html += `<blockquote>${quote}</blockquote>`;
      continue;
    }

    // 表格
    if (lines.length >= 2 && lines[0].includes('|') && /^\|?[\s:]*-+[\s:]*/.test(lines[1])) {
      const parseRow = (row: string): string[] =>
        row.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

      const headers = parseRow(lines[0]);
      const bodyRows = lines.slice(2).filter(l => l.includes('|'));

      html += '<table><thead><tr>';
      for (const h of headers) {
        html += `<th>${inlineMarkdown(escapeHtml(h))}</th>`;
      }
      html += '</tr></thead>';

      if (bodyRows.length > 0) {
        html += '<tbody>';
        for (const row of bodyRows) {
          const cells = parseRow(row);
          html += '<tr>';
          for (const cell of cells) {
            html += `<td>${inlineMarkdown(escapeHtml(cell))}</td>`;
          }
          html += '</tr>';
        }
        html += '</tbody>';
      }
      html += '</table>';
      continue;
    }

    // 无序列表
    if (lines.some(l => /^[-*]\s/.test(l.trim()))) {
      html += '<ul>' + lines
        .filter(l => /^[-*]\s/.test(l.trim()))
        .map(l => `<li>${inlineMarkdown(escapeHtml(l.trim().replace(/^[-*]\s+/, '')))}</li>`)
        .join('') + '</ul>';
      continue;
    }

    // 有序列表
    if (lines.some(l => /^\d+\.\s/.test(l.trim()))) {
      html += '<ol>' + lines
        .filter(l => /^\d+\.\s/.test(l.trim()))
        .map(l => `<li>${inlineMarkdown(escapeHtml(l.trim().replace(/^\d+\.\s+/, '')))}</li>`)
        .join('') + '</ol>';
      continue;
    }

    // 普通段落
    html += `<p>${inlineMarkdown(escapeHtml(trimmed).replace(/\n/g, '<br>'))}</p>`;
  }

  return postProcessHtml(html);
};
