const TOOL_LAYERS = {
  dom_actions: {
    label: 'DOM actions',
    description: 'To interact with a page, use skill/page/cdp_input; do not scrape large data by repeated clicks.',
    tools: ['skill', 'page', 'cdp_input', 'cdp_dom', 'cdp_frame', 'cdp_dialog', 'tab_navigate'],
  },
  network_data: {
    label: 'Network data',
    description: 'For data rather than an action, prefer cdp_network/fetch_url and extract_data; use data_pipeline for exports, not screenshots.',
    tools: ['cdp_network', 'fetch_url', 'extract_data', 'data_pipeline', 'download_file'],
  },
  pixel_fallback: {
    label: 'Pixel fallback',
    description: 'When DOM and network cannot expose the target, use screenshot; do not start with pixels for structured data.',
    tools: ['screenshot', 'cdp_emulation', 'cdp_debug'],
  },
  sessions_meta: {
    label: 'Sessions and meta',
    description: 'For independent work, ask the user, notifications, storage or Webhook push to Feishu/Lark/Bark/Slack/Discord/WeCom; do not use page reading to configure a push.',
    tools: ['agent', 'ask_user', 'request_confirmation', 'webhook', 'notification', 'clipboard_ops', 'bookmark_ops', 'history_search', 'storage_kv', 'timer', 'resident_runtime', 'selection_context', 'save_workflow', 'load_tools', 'todo', 'compact', 'status', 'adopt', 'site_experience'],
  },
};

/** Semantic tool layers; legacy load_tools category names remain valid for older callers. */
export const ON_DEMAND_CATEGORIES: Record<string, {
  label: string;
  description: string;
  tools: string[];
}> = {
  ...TOOL_LAYERS,
  cdp_advanced: {
    label: 'CDP Advanced Tools',
    description: 'DOM manipulation, JS execution, network monitoring, device emulation, dialog handling, debugging tools',
    tools: ['cdp_dom', 'cdp_frame', 'cdp_network', 'cdp_emulation', 'cdp_dialog', 'cdp_debug'],
  },
  browser_utils: {
    label: 'Browser Utilities',
    description: 'Clipboard, notifications, Webhook push to Feishu/Lark/Bark/Slack/Discord/WeCom, bookmarks, history, downloads',
    tools: ['clipboard_ops', 'notification', 'webhook', 'bookmark_ops', 'history_search', 'download_file'],
  },
  data_storage: {
    label: 'Data Persistence',
    description: 'KV key-value storage, file download & save',
    tools: ['storage_kv', 'download_file'],
  },
  scheduling: {
    label: 'Scheduling',
    description: 'Timers, persistent background tasks',
    tools: ['timer', 'resident_runtime'],
  },
};

/** Resolve a tool category. Tools are already resident in new conversations. */
export const getToolsByCategory = (category: string): string[] => {
  return ON_DEMAND_CATEGORIES[category]?.tools || [];
};

/** Compact orientation only; full schemas remain the source of tool arguments. */
export const buildToolCatalog = (availableNames?: readonly string[]): string => {
  const available = availableNames ? new Set(availableNames) : null;
  const rows = Object.values(TOOL_LAYERS).map(({ label, description, tools }) => {
    const listed = tools.filter(name => !available || available.has(name));
    return `| ${label} | ${listed.join(', ')} | ${description} |`;
  });
  return ['\n## Resident Tool Catalog', 'Tool schemas are already available; load_tools is a legacy compatibility command, not a prerequisite.',
    '| Layer | Tools | When to use / avoid |', '|-------|-------|---------------------|', ...rows,
    ...(available?.has('agent') || !available ? ['The unified agent tool handles subtask; spawn_subtask is its legacy alias, not a separate schema.'] : []),
  ].join('\n');
};
