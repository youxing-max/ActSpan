/**
 * MCP tool result envelope + the two handler wrappers built on it.
 *
 * `{ success: false }` is a legitimate payload for tools whose failure carries diagnostics
 * (act returns `trace` and `reads` there), so promoting it to `isError` is a choice that only
 * the wrappers which cannot carry a structured payload may make — never the default.
 */
export function createToolResult({ safeError }) {
    const ok = (data) => ({
        content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
    });
    const fail = (error) => ({
        content: [{ type: 'text', text: `Actspan error: ${safeError(error)}` }],
        isError: true,
    });
    // promote: 结构化失败升级成 isError 只保留一条 message，trace 等字段会整段丢掉。
    const runner = (promote) => (fn) => async (args) => {
        try {
            const result = await fn(args || {});
            if (promote && result && typeof result === 'object' && result.success === false) {
                return fail(result.error || result.message || result.data?.message || '操作失败');
            }
            return ok(result);
        } catch (error) {
            return fail(error);
        }
    };
    return { ok, fail, run: runner(true), runStructured: runner(false) };
}
