/**
 * load_tools — 旧版按需加载调用的兼容入口
 *
 * 工具在新会话中默认常驻；execute 只返回分类信息，不承诺注入新 schema。
 */

import type { FunctionDefinition } from './types';
import { ON_DEMAND_CATEGORIES, getToolsByCategory } from './tool-tiers';

export const loadToolsFunction: FunctionDefinition = {
  name: 'load_tools',
  description: 'Legacy compatibility command for tool categories. Tool schemas are already available in the current conversation; use this only to confirm the category contents. It does not load new tools or promise new schemas in the next round.',
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: Object.keys(ON_DEMAND_CATEGORIES),
        description: 'cdp_advanced: DOM manipulation/JS execution/network monitoring/device emulation/dialog/debugging; browser_utils: clipboard/notifications/bookmarks/history/downloads; data_storage: KV storage/downloads; scheduling: timers/persistent tasks',
      },
    },
    required: ['category'],
  },
  supportsParallel: true,
  permissionLevel: 'read',
  execute: async (params: { category: string }) => {
    const { category } = params;
    const tools = getToolsByCategory(category);
    if (tools.length === 0) {
      return {
        success: false,
        error: `未知的工具分类：${category}`,
      };
    }
    const catInfo = ON_DEMAND_CATEGORIES[category];
    return {
      success: true,
      data: {
        loaded: tools,
        already_available: true,
        category,
        label: catInfo?.label || category,
        message: `${tools.length} tools are already available in the ${catInfo?.label || category} category: ${tools.join(', ')}`,
      },
    };
  },
};
