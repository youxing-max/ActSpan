/**
 * Skill URL 匹配器
 * 全局 Skill 始终匹配；域级 Skill 按 url_patterns 匹配
 *
 * 匹配规则复用 site-workflow-matcher 的 glob/regex 逻辑
 */

import type { SkillSpec } from './skill-types';

const REGEX_PREFIX = 'regex:';

/** 将简单 glob pattern 转为正则（支持 * 通配符） */
const globToRegex = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
};

/** 判断 URL 是否匹配单个 pattern */
const matchesPattern = (url: string, pattern: string): boolean => {
  try {
    if (pattern.startsWith(REGEX_PREFIX)) {
      const regex = new RegExp(pattern.slice(REGEX_PREFIX.length));
      return regex.test(url);
    }
    return globToRegex(pattern).test(url);
  } catch {
    return false;
  }
};

/**
 * 根据 URL 匹配可用的 Skill
 * - 全局 Skill：始终返回（enabled 即可）
 * - 域级 Skill：至少一个 url_pattern 命中
 * - 排序：全局优先，域级其次，同层按名称排序
 */
export const matchSkills = (
  url: string,
  allSkills: SkillSpec[],
): SkillSpec[] => {
  return allSkills
    .filter(s => {
      if (!s.enabled) return false;
      if (s.scope === 'global') return true;
      if (!url) return false;
      return s.url_patterns.some(p => matchesPattern(url, p));
    })
    .sort((a, b) => {
      // 全局优先
      if (a.scope !== b.scope) return a.scope === 'global' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
};
