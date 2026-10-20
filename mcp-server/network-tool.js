import { z } from 'zod';

const STRATEGY = 'START HERE when you need DATA rather than an action. Never guess an endpoint name from memory — list first, pick by response size (Content-Length when the server reports it; otherwise size is unknown). A: try fetch with changed pagination parameters first. B: if replay fails, returns 406, or requires page-generated x-s/x-t signatures, drive the site UI and read the resulting network response instead; do not fight the signature. C: before persisting with a failing entry point, inspect another site data entry for the same content. Capture starts on first use and cannot recover earlier requests; reload:true explicitly refreshes the tab to capture first-load traffic. Index 0 is the newest matching completed response, 1 the previous batch, and so on.';

export function registerNetworkTools({ registerTool, callBridge, run, tabIdParam, taskParams }) {
  const common = {
    ...taskParams,
    tabId: tabIdParam,
    reload: z.boolean().optional().describe('Explicitly reload the task-owned tab after starting capture to observe first-load requests. This navigates the tab and requires a write lease.'),
    urlFilter: z.string().trim().min(1).optional().describe('Substring from a previously listed URL; matches across cursor variants. Never guess endpoints.'),
  };
  registerTool('actspan_network_list', {
    title: 'List captured browser requests',
    description: `${STRATEGY} List recent completed requests with status, MIME type and reported response Content-Length; no body or credentials are included. If empty, the diagnostic explains how to observe traffic.`,
    inputSchema: { ...common, limit: z.number().int().min(1).max(2000).optional() },
  }, run((args = {}) => callBridge('network.list', args, 30000, args)));
  registerTool('actspan_network_detail', {
    title: 'Inspect captured browser request',
    description: `${STRATEGY} Inspect one observed request by requestId or urlFilter; optional includeBody reads up to 50 KB of its response. Does not expose request cookies, authorization or post data.`,
    inputSchema: {
      ...common,
      requestId: z.string().trim().min(1).optional().describe('Exact requestId from list; cannot be combined with reload:true or urlFilter.'),
      index: z.number().int().min(0).optional().describe('Offset backward among matching completed requests; defaults to 0.'),
      includeBody: z.boolean().optional(),
    },
  }, run((args = {}) => callBridge('network.detail', args, 30000, args)));
  registerTool('actspan_network_query', {
    title: 'Read captured network response',
    description: `${STRATEGY} Read the actual response body of the newest matching URL by default. Increment index to retrieve older paginated batches (0 latest, 1 prior). Response text is capped at 50 KB; unavailable bodies fail with diagnostic rather than invented content.`,
    inputSchema: {
      ...common,
      urlFilter: z.string().trim().min(1).describe('Observed URL substring selecting actual matching requests.'),
      index: z.number().int().min(0).optional().describe('Offset backward among matching completed requests; defaults to 0.'),
    },
  }, run((args = {}) => callBridge('network.query', args, 30000, args)));
}

export default registerNetworkTools;
