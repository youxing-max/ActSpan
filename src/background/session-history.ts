/**
 * session-history.ts — 会话历史记录构建与持久化
 * 从 session-manager.ts 提取，负责从 eventLog/context 中提取助手回复、工具调用链、调度状态变化，
 * 构建历史记录并写入 chrome.storage。
 */

import type {
    AgentStateTransition,
    Session,
    SessionEventLogItem,
    SessionHistoryRecord,
    SessionHistoryTurn,
    SessionToolCallChainItem,
    SessionAgentTransitionItem,
} from './session-types';
import { MAX_SESSION_HISTORY, SESSION_HISTORY_STORAGE_KEY, LEGACY_SESSION_HISTORY_STORAGE_KEY } from '../session-history/constants';
import { readMigratedStorage } from '../lib/legacy-storage';
import { setLocalStorage } from './session-persistence';
import { parseTurnLifecycleEventPayload, parseEventObject } from './session-event';

// ============ 助手回复提取 ============

/** 提取最新助手回复文本 */
function extractAssistantReply(eventLog: SessionEventLogItem[]): string | undefined {
    for (let index = eventLog.length - 1; index >= 0; index--) {
        const event = eventLog[index];
        if (event.type === 'text') {
            const text = event.content?.trim();
            if (text) return text;
        }
    }
    return undefined;
}

/** 从 turn_completed 事件提取回复 */
function extractTurnCompletedReply(eventLog: SessionEventLogItem[]): string | undefined {
    for (let index = eventLog.length - 1; index >= 0; index--) {
        const event = eventLog[index];
        if (event.type !== 'turn_completed') continue;
        const payload = parseTurnLifecycleEventPayload(event.content || '');
        const text = typeof payload?.lastAgentMessage === 'string'
            ? payload.lastAgentMessage.trim()
            : '';
        if (text) return text;
    }
    return undefined;
}

// ============ 多轮对话提取 ============

/** 历史记录中最多保留的对话轮数（从最新一轮往前保留） */
const MAX_HISTORY_TURNS = 20;
const MAX_TURN_QUERY_CHARS = 300;
const MAX_TURN_REPLY_CHARS = 4_000;

const truncateText = (text: string | undefined, max: number): string | undefined => {
    if (!text) return text;
    if (text.length <= max) return text;
    return `${text.slice(0, max)}…（已截断 ${text.length - max} 字）`;
};

/** 统一裁剪轮次，避免历史记录无限增长 */
const normalizeSessionTurns = (turns: SessionHistoryTurn[]): SessionHistoryTurn[] => turns
    .slice(-MAX_HISTORY_TURNS)
    .map(turn => ({
        ...turn,
        query: truncateText(turn.query, MAX_TURN_QUERY_CHARS) || '(无输入)',
        reply: truncateText(turn.reply, MAX_TURN_REPLY_CHARS),
    }));

/** 合并已保存的旧轮次与本次快照，防止 eventLog 裁剪导致早期轮次丢失 */
export function mergeSessionTurns(
    previous: SessionHistoryTurn[] | undefined,
    incoming: SessionHistoryTurn[] | undefined,
): SessionHistoryTurn[] {
    const merged = new Map<string, SessionHistoryTurn>();
    const keyOf = (turn: SessionHistoryTurn) => turn.runId || `${turn.startedAt}:${turn.query.slice(0, 40)}`;
    for (const turn of previous || []) merged.set(keyOf(turn), turn);
    for (const turn of incoming || []) merged.set(keyOf(turn), turn);
    return normalizeSessionTurns(
        Array.from(merged.values()).sort((left, right) => left.startedAt - right.startedAt),
    );
}

/**
 * 从 eventLog 还原每一轮用户输入与 AI 回复。
 *
 * 之前历史记录只取最新一轮的 assistantReply，多轮对话在页面上只能看到
 * 第一句 summary，后面的轮次全部丢失。这里按 turn_started /
 * turn_completed / turn_aborted 切分轮次，并保留每轮回复。
 */
export function extractSessionTurns(
    eventLog: SessionEventLogItem[],
    fallback?: { summary?: string; startedAt?: number; reply?: string },
): SessionHistoryTurn[] {
    const turns: SessionHistoryTurn[] = [];
    let current: SessionHistoryTurn | null = null;

    const resolvedStartedAt = fallback?.startedAt || eventLog[0]?.timestamp || Date.now();

    const ensureCurrent = () => {
        if (current) return current;
        if (!fallback?.summary) return null;
        current = {
            query: fallback.summary,
            status: 'running',
            startedAt: resolvedStartedAt,
            reply: fallback.reply,
        };
        return current;
    };

    for (const event of eventLog) {
        const timestamp = event.timestamp;

        if (event.type === 'turn_started') {
            if (current) {
                turns.push({ ...current, endedAt: timestamp, status: current.status === 'running' ? 'error' : current.status });
            }
            let parsed: { query?: unknown; runId?: unknown; startedAt?: unknown } | null = null;
            try {
                parsed = JSON.parse(event.content || '{}');
            } catch {
                // 兼容非 JSON 的旧格式
            }
            const query = typeof parsed?.query === 'string' ? parsed.query.trim() : '';
            current = {
                runId: typeof parsed?.runId === 'string' ? parsed.runId : undefined,
                query: query || fallback?.summary || '(无输入)',
                status: 'running',
                startedAt: typeof parsed?.startedAt === 'number' ? parsed.startedAt : (timestamp || resolvedStartedAt),
            };
            continue;
        }

        if (event.type === 'text') {
            const text = event.content?.trim();
            if (text) {
                const turn = ensureCurrent();
                if (turn) turn.reply = text;
            }
            continue;
        }

        if (event.type !== 'turn_completed' && event.type !== 'turn_aborted') continue;

        const turn = ensureCurrent();
        if (!turn) continue;
        const payload = parseTurnLifecycleEventPayload(event.content || '');
        const endedAt = typeof payload?.endedAt === 'number' ? payload.endedAt : (timestamp || Date.now());
        const durationMs = typeof payload?.durationMs === 'number'
            ? payload.durationMs
            : Math.max(0, endedAt - turn.startedAt);
        turn.status = event.type === 'turn_completed' && payload?.status === 'done' ? 'done' : 'error';
        turn.endedAt = endedAt;
        turn.durationMs = durationMs;
        turn.failureCode = payload?.failureCode;
        turn.error = payload?.reason;
        const lastMessage = typeof payload?.lastAgentMessage === 'string'
            ? payload.lastAgentMessage.trim()
            : '';
        if (lastMessage) turn.reply = lastMessage;
        turns.push(turn);
        current = null;
    }

    if (current) {
        turns.push(current);
    }

    if (turns.length === 0 && fallback?.summary) {
        turns.push({
            query: fallback.summary,
            status: 'done',
            reply: fallback.reply,
            startedAt: resolvedStartedAt,
        });
    }

    return normalizeSessionTurns(turns);
}

// ============ 工具调用提取 ============

/** 从 function_call 文案中解析工具名 */
function parseToolName(rawContent: string): string {
    const raw = (rawContent || '').trim();
    if (!raw) return '';

    try {
        const parsed = JSON.parse(raw) as { name?: string };
        if (parsed?.name) return parsed.name;
    } catch {
        // 非 JSON，走文本回退
    }

    const matched = raw.match(/正在调用\s+([a-zA-Z0-9_:-]+)\.\.\./);
    if (matched?.[1]) return matched[1];

    return raw.replace(/^正在调用\s+/, '').replace(/\.\.\.$/, '').trim();
}

/** 提取工具调用名称列表（去重） */
function extractToolCalls(eventLog: SessionEventLogItem[]): string[] {
    const toolCalls: string[] = [];
    const seen = new Set<string>();

    for (const event of eventLog) {
        if (event.type !== 'function_call') continue;

        const toolName = parseToolName(event.content || '');

        if (!toolName || seen.has(toolName)) continue;
        seen.add(toolName);
        toolCalls.push(toolName);
    }

    return toolCalls;
}

/** 提取工具调用链（含执行结果） */
function extractToolCallChain(eventLog: SessionEventLogItem[]): SessionToolCallChainItem[] {
    const chain: SessionToolCallChainItem[] = [];
    const pendingIndexes: number[] = [];
    const pendingByCallId = new Map<string, number>();
    const pendingByItemId = new Map<string, number>();
    const removePendingIndex = (index: number) => {
        const pos = pendingIndexes.indexOf(index);
        if (pos >= 0) pendingIndexes.splice(pos, 1);
    };

    const markCompleted = (index: number, status: SessionToolCallChainItem['status'], message: string | undefined, endedAt: number | undefined) => {
        const item = chain[index];
        if (!item) return;
        item.status = status;
        if (message && !item.message) {
            item.message = message;
        } else if (message) {
            item.message = message;
        }
        item.endedAt = endedAt;
    };

    for (const event of eventLog) {
        if (event.type === 'turn_item_started') {
            const payload = parseEventObject(event.content || '');
            if (!payload) continue;
            const itemType = String(payload.itemType || '');
            if (itemType !== 'function_call') continue;
            const callId = typeof payload.callId === 'string' ? payload.callId : '';
            const itemId = typeof payload.itemId === 'string' ? payload.itemId : '';
            const funcName = typeof payload.name === 'string' && payload.name.trim()
                ? payload.name.trim()
                : parseToolName(event.content || '');
            if (!funcName) continue;
            if (callId && pendingByCallId.has(callId)) continue;
            if (itemId && pendingByItemId.has(itemId)) continue;

            const index = chain.length;
            chain.push({
                funcName,
                status: 'running',
                startedAt: event.timestamp,
            });
            pendingIndexes.push(index);
            if (callId) pendingByCallId.set(callId, index);
            if (itemId) pendingByItemId.set(itemId, index);
            continue;
        }

        if (event.type === 'turn_item_completed') {
            const payload = parseEventObject(event.content || '');
            if (!payload) continue;
            const itemType = String(payload.itemType || '');
            if (itemType !== 'function_call') continue;
            const callId = typeof payload.callId === 'string' ? payload.callId : '';
            const itemId = typeof payload.itemId === 'string' ? payload.itemId : '';
            const statusRaw = String(payload.status || '').toLowerCase();
            const status: SessionToolCallChainItem['status'] = statusRaw === 'error' || statusRaw === 'cancelled'
                ? 'error'
                : 'done';
            const index = (callId && pendingByCallId.get(callId) !== undefined)
                ? pendingByCallId.get(callId)!
                : (itemId && pendingByItemId.get(itemId) !== undefined)
                    ? pendingByItemId.get(itemId)!
                    : undefined;
            if (index === undefined) continue;
            markCompleted(index, status, undefined, event.timestamp);
            removePendingIndex(index);
            if (callId) pendingByCallId.delete(callId);
            if (itemId) pendingByItemId.delete(itemId);
            continue;
        }

        if (event.type === 'function_call') {
            const funcName = parseToolName(event.content || '');
            if (!funcName) continue;

            const payload = parseEventObject(event.content || '');
            const callId = typeof payload?.callId === 'string' ? payload.callId : '';
            if (callId && pendingByCallId.has(callId)) continue;

            chain.push({
                funcName,
                status: 'running',
                startedAt: event.timestamp,
            });
            const index = chain.length - 1;
            pendingIndexes.push(index);
            if (callId) pendingByCallId.set(callId, index);
            continue;
        }

        if (event.type === 'function_result') {
            const payload = parseEventObject(event.content || '');
            const callId = typeof payload?.callId === 'string' ? payload.callId : '';
            const resultText = typeof payload?.message === 'string'
                ? payload.message.trim()
                : (event.content || '').trim();
            const isError = typeof payload?.success === 'boolean'
                ? payload.success === false
                : /出错|失败|异常/i.test(resultText);
            const targetIndex = (callId && pendingByCallId.get(callId) !== undefined)
                ? pendingByCallId.get(callId)!
                : pendingIndexes.shift();
            if (targetIndex === undefined) continue;

            markCompleted(targetIndex, isError ? 'error' : 'done', resultText || undefined, event.timestamp);
            removePendingIndex(targetIndex);
            if (callId) pendingByCallId.delete(callId);
            continue;
        }

        if (event.type === 'error' && pendingIndexes.length > 0) {
            for (const index of pendingIndexes) {
                markCompleted(index, 'error', '会话异常终止', event.timestamp);
            }
            pendingIndexes.length = 0;
            pendingByCallId.clear();
            pendingByItemId.clear();
        }
    }

    return chain;
}

// ============ 调度状态变化提取 ============

/** 提取调度状态变化日志 */
function extractAgentTransitions(eventLog: SessionEventLogItem[]): SessionAgentTransitionItem[] {
    const transitions: SessionAgentTransitionItem[] = [];

    for (const event of eventLog) {
        if (event.type !== 'agent_state') continue;

        try {
            const parsed = JSON.parse(event.content) as AgentStateTransition;
            transitions.push({
                phase: parsed.to,
                round: parsed.round || 0,
                reason: parsed.reason || '',
                updatedAt: parsed.timestamp || event.timestamp || Date.now(),
            });
        } catch {
            // 忽略异常格式的 agent_state
        }
    }

    return transitions;
}

// ============ 历史记录构建与持久化 ============

/** 历史记录里最终回复的最大长度：防止整页文本/日志把 storage 撑爆 */
const MAX_ASSISTANT_REPLY_CHARS = 8_000;

const truncateAssistantReply = (reply: string | undefined): string | undefined => {
    if (!reply) return reply;
    if (reply.length <= MAX_ASSISTANT_REPLY_CHARS) return reply;
    return `${reply.slice(0, MAX_ASSISTANT_REPLY_CHARS)}\n…（已截断 ${reply.length - MAX_ASSISTANT_REPLY_CHARS} 字）`;
};

/** 构建会话历史记录 */
export function buildSessionHistoryRecord(session: Session): SessionHistoryRecord {
    const updatedAt = Date.now();
    const startedAt = session.startedAt || session.createdAt || updatedAt;
    const endedAt = session.endedAt ?? (session.status === 'running' ? undefined : updatedAt);
    const durationMs = session.durationMs ?? (endedAt ? Math.max(0, endedAt - startedAt) : undefined);
    const assistantReply = extractTurnCompletedReply(session.eventLog) || extractAssistantReply(session.eventLog);
    // 优先使用运行期累积的快照：eventLog 只有 500 条，长回答可能撑满一轮
    const turns = normalizeSessionTurns(
        session.turns?.length
            ? session.turns
            : extractSessionTurns(session.eventLog, {
                summary: session.summary,
                startedAt,
                reply: assistantReply,
            }),
    );

    return {
        sessionId: session.id,
        summary: session.summary,
        status: session.status,
        startedAt,
        endedAt,
        durationMs,
        failureCode: session.failureCode,
        lastError: session.lastError,
        assistantReply: truncateAssistantReply(assistantReply),
        turns,
        toolCalls: extractToolCalls(session.eventLog),
        toolCallChain: extractToolCallChain(session.eventLog),
        agentTransitions: extractAgentTransitions(session.eventLog),
        updatedAt,
    };
}

/** 会话历史写入队列，避免并发覆盖 */
let sessionHistoryPersistQueue: Promise<void> = Promise.resolve();

/** 读取全部会话历史记录（供侧边栏历史面板与会话恢复使用） */
export async function readSessionHistoryRecords(): Promise<SessionHistoryRecord[]> {
    const history = (await readMigratedStorage<SessionHistoryRecord[]>(
        chrome.storage.local,
        SESSION_HISTORY_STORAGE_KEY,
        LEGACY_SESSION_HISTORY_STORAGE_KEY,
    )) || [];
    return Array.isArray(history) ? history : [];
}

/** 删除指定会话的历史记录（会话“清除”后必须真正消失） */
export function removeSessionHistory(sessionId: string) {
    sessionHistoryPersistQueue = sessionHistoryPersistQueue
        .then(async () => {
            const history = (await readMigratedStorage<SessionHistoryRecord[]>(
                chrome.storage.local,
                SESSION_HISTORY_STORAGE_KEY,
                LEGACY_SESSION_HISTORY_STORAGE_KEY,
            )) || [];
            const nextHistory = history.filter(item => item.sessionId !== sessionId);
            if (nextHistory.length === history.length) return;
            await setLocalStorage({ [SESSION_HISTORY_STORAGE_KEY]: nextHistory });
        })
        .catch((err) => {
            console.error('[Actspan] 删除会话历史失败:', err);
        });
}

/** 写入/更新会话历史 */
export function persistSessionHistory(session: Session) {
    if (session.status === 'running') return;

    const record = buildSessionHistoryRecord(session);

    sessionHistoryPersistQueue = sessionHistoryPersistQueue
        .then(async () => {
            const history = (await readMigratedStorage<SessionHistoryRecord[]>(
                chrome.storage.local,
                SESSION_HISTORY_STORAGE_KEY,
                LEGACY_SESSION_HISTORY_STORAGE_KEY,
            )) || [];
            const previous = history.find(item => item.sessionId === record.sessionId);
            const nextRecord: SessionHistoryRecord = {
                ...record,
                turns: mergeSessionTurns(previous?.turns, record.turns),
            };
            const nextHistory = [nextRecord, ...history.filter(item => item.sessionId !== record.sessionId)]
                .sort((left, right) => right.updatedAt - left.updatedAt)
                .slice(0, MAX_SESSION_HISTORY);

            await setLocalStorage({
                [SESSION_HISTORY_STORAGE_KEY]: nextHistory,
            });
        })
        .catch((err) => {
            console.error('[Actspan] 保存会话历史失败:', err);
        });
}
