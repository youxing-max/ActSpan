/**
 * SSRF 防护：拦截指向本机/内网的 http(s) 请求。
 * 仅做字面量判定；DNS 重绑定仍由浏览器网络栈决定，无法在此完全消除。
 */
const isPrivateIPv4 = (host: string): boolean => {
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  if (/^0\./.test(host)) return true;
  const private172 = host.match(/^172\.(\d{1,3})\./);
  return Boolean(private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31);
};

/** 把 IPv6 文本解析为 8 个 16 位分组；无法解析时返回 null。 */
const parseIPv6 = (host: string): number[] | null => {
  const input = host.replace(/%.*$/, '');
  if (!input.includes(':')) return null;
  // 兼容直接传入的 ::ffff:127.0.0.1（URL 规范化前）
  const dotted = input.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const [, prefix, a, b, c, d] = dotted.map((part) => part);
    return parseIPv6(`${prefix}${((Number(a) << 8) | Number(b)).toString(16)}:${((Number(c) << 8) | Number(d)).toString(16)}`);
  }
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (!part) return [];
    const groups: number[] = [];
    for (const piece of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };
  const head = parseGroups(halves[0]);
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  return [...head, ...Array(missing).fill(0), ...tail];
};

const isPrivateIPv6 = (host: string): boolean => {
  if (host === '::' || host === '::1') return true;
  const groups = parseIPv6(host);
  if (!groups) return false;
  const isZeroPrefix = groups.slice(0, 5).every((group) => group === 0);
  // IPv4-mapped（::ffff:7f00:1）与 IPv4-compatible（::7f00:1）
  if (isZeroPrefix && (groups[5] === 0xffff || groups[5] === 0)) {
    const ipv4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
    return isPrivateIPv4(ipv4);
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  return false;
};

/** 已知“任意子域都解析到指定地址”的通配 DNS 服务，常见于内网 SSRF 绕过。 */
const WILDCARD_DNS_SUFFIXES = [
  'nip.io',
  'sslip.io',
  'xip.io',
  'localtest.me',
  'lvh.me',
  'vcap.me',
  'traefik.me',
  'lacolhost.me',
];

export const isPrivateHostname = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host === '0.0.0.0') return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (WILDCARD_DNS_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return true;
  if (isPrivateIPv4(host)) return true;
  return isPrivateIPv6(host);
};

export const isBlockedFetchUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
    return isPrivateHostname(url.hostname);
  } catch {
    return true;
  }
};

/** 可导航 URL 白名单：http/https，以及 about:blank。拒绝 file/data/javascript 等协议。 */
export const isSafeNavigableUrl = (value: string): boolean => {
  try {
    const url = new URL(String(value).trim());
    if (url.protocol === 'http:' || url.protocol === 'https:') return true;
    return url.protocol === 'about:' && url.pathname === 'blank';
  } catch {
    return false;
  }
};
