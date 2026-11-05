/**
 * 云端连接器配置页面（token 隔离模式）
 * 用户填服务器地址 + 个人 token，扩展拼成 ws://host/ws?token=xxx 连接云端
 * 云端按 token 把每条连接绑定到用户，实现多用户共享云端、按 token 隔离调用
 */

import { useCallback, useEffect, useState } from 'react';
import { App, Alert, Button, Input, Space, Switch, Tag, Typography } from 'antd';
import { CloudOutlined, ReloadOutlined } from '@ant-design/icons';
import { OptionsPageLayout, OptionsSectionCard } from '../components/PageLayout';

const { Paragraph, Text } = Typography;

/** chrome.storage.local 配置键（与 background/cloud-bridge.ts 保持一致） */
const CLOUD_BRIDGE_SETTINGS_KEY = 'actspan_cloud_bridge_settings';
/** 后台状态查询消息类型 */
const STATUS_GET_MESSAGE = '__cloud_bridge_status_get';
/** 后台状态变更广播消息类型 */
const STATUS_CHANGED_MESSAGE = '__cloud_bridge_status_changed';

type CloudBridgeConnState = 'connected' | 'connecting' | 'disconnected' | 'auth_failed' | 'replaced' | 'disabled';

interface CloudBridgeSettings {
    enabled: boolean;
    serverUrl: string;
    token: string;
}

interface CloudBridgeStatus {
    enabled: boolean;
    state: CloudBridgeConnState;
    serverUrl: string;
    hasToken: boolean;
    lastError: string | null;
    lastConnectedAt: number | null;
}

/** 默认云端服务器地址（与 background/cloud-bridge.ts 的 DEFAULT_CLOUD_SERVER_URL 保持一致） */
const DEFAULT_CLOUD_SERVER_URL = 'ws://actspan.chenyang-zhang.devbox.in.chaitin.net:8787/ws';
const DEFAULT_SETTINGS: CloudBridgeSettings = { enabled: false, serverUrl: DEFAULT_CLOUD_SERVER_URL, token: '' };

const readSettings = (): Promise<CloudBridgeSettings> => {
    return new Promise((resolve) => {
        chrome.storage.local.get([CLOUD_BRIDGE_SETTINGS_KEY], (result) => {
            const raw = result?.[CLOUD_BRIDGE_SETTINGS_KEY];
            if (!raw || typeof raw !== 'object') return resolve({ ...DEFAULT_SETTINGS });
            const obj = raw as Record<string, unknown>;
            resolve({
                enabled: obj.enabled === true,
                serverUrl: typeof obj.serverUrl === 'string' ? obj.serverUrl : '',
                token: typeof obj.token === 'string' ? obj.token : '',
            });
        });
    });
};

const writeSettings = (settings: CloudBridgeSettings): Promise<void> => {
    return new Promise((resolve) => {
        chrome.storage.local.set({ [CLOUD_BRIDGE_SETTINGS_KEY]: settings }, () => resolve());
    });
};

const fetchStatus = (): Promise<CloudBridgeStatus | null> => {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ type: STATUS_GET_MESSAGE }, (response) => {
                if (chrome.runtime.lastError) {
                    resolve(null);
                    return;
                }
                resolve((response as CloudBridgeStatus) || null);
            });
        } catch {
            resolve(null);
        }
    });
};

/** 校验服务器地址 */
const validateServerUrl = (url: string): string | null => {
    if (!url.trim()) return '请输入服务器地址';
    try {
        const u = new URL(url.trim());
        if (u.protocol !== 'wss:' && u.protocol !== 'ws:') {
            return `仅支持 ws:// 或 wss://，当前协议: ${u.protocol}`;
        }
        return null;
    } catch (err: any) {
        return `URL 非法: ${err?.message || '解析失败'}`;
    }
};

/** 状态 → 显示 */
const stateDisplay = (state: CloudBridgeConnState | undefined): { label: string; color: string; hint: string } => {
    switch (state) {
        case 'connected':
            return { label: '已连接', color: 'success', hint: '云端可以调用本地工具' };
        case 'connecting':
            return { label: '连接中', color: 'processing', hint: '正在建立 WebSocket 连接' };
        case 'auth_failed':
            return { label: 'Token 无效', color: 'error', hint: '云端拒绝了 token，已停止重连。请检查 token 是否正确' };
        case 'replaced':
            return { label: '连接已被替换', color: 'warning', hint: '另一浏览器正在使用同一 token；需要在此恢复时请先停用，再启用' };
        case 'disconnected':
            return { label: '未连接', color: 'warning', hint: '每 2.5 秒自动重连' };
        case 'disabled':
        default:
            return { label: '未启用', color: 'default', hint: '启用开关处于关闭状态' };
    }
};

export function CloudConnectorPage() {
    const { message } = App.useApp();
    const [settings, setSettings] = useState<CloudBridgeSettings>(DEFAULT_SETTINGS);
    const [serverUrlInput, setServerUrlInput] = useState('');
    const [tokenInput, setTokenInput] = useState('');
    const [status, setStatus] = useState<CloudBridgeStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const [s, st] = await Promise.all([readSettings(), fetchStatus()]);
            setSettings(s);
            setServerUrlInput(s.serverUrl);
            setTokenInput(s.token);
            setStatus(st);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
        const listener = (msg: any) => {
            if (msg?.type === STATUS_CHANGED_MESSAGE && msg.data) {
                setStatus(msg.data as CloudBridgeStatus);
            }
        };
        chrome.runtime.onMessage.addListener(listener);
        return () => chrome.runtime.onMessage.removeListener(listener);
    }, [refresh]);

    const handleSave = async (patch: Partial<CloudBridgeSettings>) => {
        const next: CloudBridgeSettings = {
            enabled: patch.enabled ?? settings.enabled,
            serverUrl: (patch.serverUrl ?? serverUrlInput).trim(),
            token: (patch.token ?? tokenInput).trim(),
        };
        // 启用前必须校验
        if (next.enabled) {
            const urlErr = validateServerUrl(next.serverUrl);
            if (urlErr) {
                void message.error(urlErr);
                return;
            }
            if (!next.token) {
                void message.error('请输入 token');
                return;
            }
        }
        setSaving(true);
        try {
            await writeSettings(next);
            setSettings(next);
            void message.success(next.enabled ? '云端连接器已启用' : '云端连接器已停用');
            // background 通过 storage.onChanged 自动重连/断开；延迟拉一次状态
            setTimeout(() => { void fetchStatus().then(setStatus); }, 400);
        } catch (err: any) {
            void message.error(`保存失败: ${err?.message || '未知错误'}`);
        } finally {
            setSaving(false);
        }
    };

    const urlError = serverUrlInput.trim() ? validateServerUrl(serverUrlInput) : null;
    const dirty =
        serverUrlInput.trim() !== settings.serverUrl ||
        tokenInput.trim() !== settings.token;

    const sd = stateDisplay(status?.state);

    return (
        <OptionsPageLayout
            eyebrow="Cloud Connector"
            title="云端连接器"
            description={
                <>
                    填入云端服务器地址和你的个人 token，扩展会把本地浏览器能力（页面读取、截图、标签页操作等 34+ MCP 工具）
                    通过 <Text code>ws://</Text> 暴露给云端。多用户共享同一云端，云端按 token 隔离调用。
                </>
            }
            extra={
                <Button icon={<ReloadOutlined />} onClick={() => void refresh()} loading={loading}>
                    刷新
                </Button>
            }
            metrics={[
                {
                    label: '连接状态',
                    value: <Tag icon={<CloudOutlined />} color={sd.color}>{sd.label}</Tag>,
                    hint: sd.hint,
                    accent: status?.state === 'connected' ? 'green'
                        : status?.state === 'auth_failed' ? 'red'
                        : status?.state === 'connecting' ? 'blue'
                        : settings.enabled ? 'orange'
                        : 'neutral',
                },
                {
                    label: 'Token',
                    value: status?.hasToken ? '已配置' : '未配置',
                    hint: status?.hasToken ? '为安全起见不回显 token' : '需要云端分配的个人 token',
                    accent: status?.hasToken ? 'blue' : 'neutral',
                },
                {
                    label: '最近连接',
                    value: status?.lastConnectedAt ? new Date(status.lastConnectedAt).toLocaleTimeString() : '从未',
                    hint: status?.lastConnectedAt ? new Date(status.lastConnectedAt).toLocaleDateString() : '尚未成功连接过',
                    accent: 'neutral',
                },
            ]}
        >
            {status?.state === 'auth_failed' && (
                <Alert
                    style={{ marginBottom: 16 }}
                    type="error"
                    showIcon
                    message="Token 无效"
                    description={
                        <>
                            云端拒绝了当前 token（关闭码 4001），已停止重连。
                            请检查 token 是否输入正确，或联系云端管理员重新分配。修改后点击「保存」会重新连接。
                        </>
                    }
                />
            )}

            <OptionsSectionCard
                title="连接配置"
                description={
                    <>
                        实际连接地址由扩展自动拼接为 <Text code>{'<服务器地址>?token=<你的token>'}</Text>，
                        云端校验 token 后将该连接与你的账号绑定。
                    </>
                }
            >
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                    <div>
                        <Text strong>服务器地址</Text>
                        <Input
                            style={{ marginTop: 8 }}
                            placeholder={DEFAULT_CLOUD_SERVER_URL}
                            value={serverUrlInput}
                            onChange={(e) => setServerUrlInput(e.target.value)}
                            status={urlError ? 'error' : undefined}
                            allowClear
                        />
                        {urlError ? (
                            <Paragraph type="danger" style={{ marginTop: 4, marginBottom: 0, fontSize: 12 }}>
                                {urlError}
                            </Paragraph>
                        ) : null}
                    </div>
                    <div>
                        <Text strong>个人 Token</Text>
                        <Input.Password
                            style={{ marginTop: 8 }}
                            placeholder="云端分配的个人 token"
                            value={tokenInput}
                            onChange={(e) => setTokenInput(e.target.value)}
                            autoComplete="off"
                        />
                        <Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 0, fontSize: 12 }}>
                            云端按 token 隔离用户。同一 token 仅保留最新浏览器连接；需同时使用多台设备时，请分别分配 token。
                        </Paragraph>
                    </div>
                    <Space>
                        <Button
                            type="primary"
                            onClick={() => void handleSave({})}
                            loading={saving}
                            disabled={!dirty || !!urlError || !serverUrlInput.trim() || !tokenInput.trim()}
                        >
                            保存配置
                        </Button>
                        <Switch
                            checked={settings.enabled}
                            loading={saving}
                            onChange={(checked) => void handleSave({ enabled: checked })}
                            checkedChildren="已启用"
                            unCheckedChildren="已停用"
                        />
                    </Space>
                    {(!settings.serverUrl || !settings.token) && (
                        <Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
                            服务器地址已预填默认值，填入你的个人 token 并保存后，再启用开关。
                        </Paragraph>
                    )}
                </Space>
            </OptionsSectionCard>

            <OptionsSectionCard
                title="使用说明"
                description="云端如何通过此连接器调用本地浏览器能力"
                className="options-section-gap"
            >
                <Paragraph style={{ fontSize: 13 }}>
                    1. 启用后，扩展在后台通过 WebSocket 连接到云端，断线每 2.5 秒自动重连；token 无效或连接被另一浏览器替换时停止重连，修改配置或重新启用可恢复。
                </Paragraph>
                <Paragraph style={{ fontSize: 13 }}>
                    2. 云端使用 JSON-RPC 2.0 协议下发请求：<Text code>tools/list</Text> 获取工具列表，
                    <Text code>tools/call</Text> 调用具体工具。
                </Paragraph>
                <Paragraph style={{ fontSize: 13 }}>
                    3. 所有工具在本地浏览器内执行，复用当前登录态和 Cookie，结果通过同一连接回传。
                </Paragraph>
                <Paragraph style={{ fontSize: 13, marginBottom: 0 }}>
                    4. 所有工具直接执行（自由模式，无审批弹窗），调用方对操作结果负责。
                </Paragraph>
            </OptionsSectionCard>
        </OptionsPageLayout>
    );
}
