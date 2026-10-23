import { z } from 'zod';

const selector = z.string().trim().min(1).max(2000);
const taskTab = (taskParams, tabIdParam) => ({ ...taskParams, tabId: tabIdParam });
const file = {
    filename: z.string().min(1).max(255),
    base64: z.string().min(1).max(12_000_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    mimeType: z.string().max(255).default('application/octet-stream'),
};

export function registerInteractionTools({ registerTool, callBridge, run, tabIdParam, taskParams }) {
    const tools = [
        ['select', 'Select native option', 'Select a value or exact option label on a native select, without debugger or tab activation.',
            { selector, value: z.string().min(1).max(2000) }],
        ['upload', 'Upload file', 'Create a File from base64 and set a native file input via DataTransfer, or dispatch drag/drop to dropSelector. No system file dialog.',
            { selector: selector.optional(), dropSelector: selector.optional(), ...file }],
        ['key', 'Press key sequence', 'Press keys in order with optional repeat (up to 50); Tab moves focus and Enter activates ordinary controls. Never activates payment targets.',
            { keys: z.array(z.string().min(1).max(60)).min(1).max(50), repeat: z.number().int().min(1).max(50).default(1), selector: selector.optional(), ref: selector.optional(), snapshotId: selector.optional() }],
        ['wait', 'Wait for condition', 'Wait for selector, page text, or a stable idle DOM (no mutation for 500ms). Does not mutate the page.',
            { for: z.enum(['selector', 'text', 'idle']), selector: selector.optional(), text: z.string().min(1).max(2000).optional(), timeoutMs: z.number().int().min(100).max(30000).default(10000) }],
        ['scroll', 'Scroll page', 'Scroll the task-leased tab by pixel offsets, optionally within a selector. Does not activate or focus the tab.',
            { selector: selector.optional(), deltaX: z.number().finite().min(-100000).max(100000).default(0), deltaY: z.number().finite().min(-100000).max(100000).default(0) }],
    ];
    for (const [action, title, description, fields] of tools) {
        const inputSchema = { ...taskTab(taskParams, tabIdParam), ...fields };
        const schema = z.object(inputSchema).strict().superRefine((args, ctx) => {
            if (action === 'upload' && Number(Boolean(args.selector)) + Number(Boolean(args.dropSelector)) !== 1)
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of selector or dropSelector' });
            if (action === 'key' && (Boolean(args.ref) !== Boolean(args.snapshotId) || (args.selector && args.ref)))
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ref requires snapshotId and cannot be combined with selector' });
            if (action === 'wait' && ((args.for === 'selector' && !args.selector) || (args.for === 'text' && !args.text) || (args.for === 'idle' && (args.selector || args.text))))
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Condition requires matching selector or text; idle accepts neither' });
        });
        registerTool(`actspan_page_${action}`, { title, description, inputSchema }, run((args) => {
            const checked = schema.parse(args);
            return callBridge(`page.${action}`, checked, action === 'wait' ? checked.timeoutMs + 5000 : 90000, checked);
        }));
    }
}
