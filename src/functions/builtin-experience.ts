import type { SiteExperienceMemory } from './site-experience';

/**
 * F1 出厂内置经验层。
 *
 * 出厂段是**只读**的：它只参与 `get` 的合并展示，永远不写进本机层。
 * 本机层存在独立的 storage key（`actspan_site_experience_layers_v1`）下，
 * 所以扩展升级换掉这张表也不会覆盖用户的本机目录——这就是 F1 的
 * 「本机目录升级永不覆盖」。`get` 返回的 `factoryHosts` 让出厂段可被整段识别。
 *
 * 内容来源见规格 §7.4 Q15：huashu-chrome 的 `docs/经验/`（MIT，23 份站点笔记）
 * 可用作出厂内容，但**每份必须按我方靶场复测后才入库**——对方标注的是它的
 * 实测日期，不代表在我们的实现上成立。未复测的站点笔记不得写进这张表，
 * 所以这里出厂条目为空：机制已就位，内容等 Q15 授权的复测结果。
 */
export const BUILTIN_EXPERIENCE_VERSION = 1;

export const BUILTIN_EXPERIENCE_SOURCE = {
  upstream: 'alchaincyf/huashu-chrome',
  license: 'MIT',
  requirement: '每条出厂条目必须按我方靶场复测后才可入库（规格 Q15），并保留出处与署名',
} as const;

/**
 * 出厂条目格式（复测通过后按此追加）：
 *
 * ```ts
 * 'example.com': {
 *   selectors: {
 *     '#submit': {
 *       actions: { click: { attempts: 12, successes: 11, successRate: 11 / 12 } },
 *       requiredPreconditions: ['login'],
 *     },
 *   },
 *   failureReasons: { timeout: 1 },
 * }
 * ```
 *
 * 只允许 `SAFE_ACTIONS` 里的动作与 `SAFE_PRECONDITIONS` 里的前置条件；
 * 不得写入凭据、表单值或完整 URL。
 */
export const BUILTIN_SITE_EXPERIENCE: SiteExperienceMemory = {
  version: BUILTIN_EXPERIENCE_VERSION,
  domains: {},
};

/** 两个调用点共用同一份出厂层，避免各自造一个空对象。 */
export const builtinSiteExperience = (): SiteExperienceMemory => BUILTIN_SITE_EXPERIENCE;
