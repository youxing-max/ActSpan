/**
 * 翻译设置页
 *
 * 用户自行接入翻译服务：每个供应商独立填写凭据，扩展只保存到本地
 * chrome.storage.local，不代管也不上传。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Alert, Button, Card, Form, Input, Select, Space, Switch, Tag, Typography } from 'antd';
import {
  TRANSLATE_LANGS,
  TRANSLATE_PROVIDERS,
  TRANSLATE_TARGET_LANGS,
  isProviderConfigured,
} from '../../translate/types';
import type { TranslateLangCode, TranslateProviderId, TranslateSettings } from '../../translate/types';
import { DEFAULT_TRANSLATE_SETTINGS } from '../../translate/types';
import { loadTranslateSettings, saveTranslateSettings } from '../../translate/settings';

const { Paragraph, Text } = Typography;

export function TranslateSettingsPage() {
  const { message } = App.useApp();
  const [settings, setSettings] = useState<TranslateSettings>(DEFAULT_TRANSLATE_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadTranslateSettings().then((loaded) => {
      setSettings(loaded);
      setLoading(false);
    });
  }, []);

  const patchProvider = useCallback((id: TranslateProviderId, patch: Record<string, unknown>) => {
    setSettings((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [id]: { ...prev.providers[id], ...patch },
      },
    }));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await saveTranslateSettings(settings);
      message.success('翻译设置已保存');
    } catch {
      message.error('保存失败，请重试');
    } finally {
      setSaving(false);
    }
  }, [settings, message]);

  const configuredCount = useMemo(
    () => TRANSLATE_PROVIDERS.filter((item) => isProviderConfigured(item.id, settings.providers[item.id])).length,
    [settings.providers],
  );

  return (
    <div className="options-form">
      <Alert
        type="info"
        showIcon
        message="翻译功能需要你自己接入服务商"
        description="扩展不内置任何翻译密钥，也不会把密钥上传到第三方服务器；密钥只保存在本机 chrome.storage.local。"
        style={{ marginBottom: 16 }}
      />

      <Card title="默认行为" size="small" style={{ marginBottom: 16 }}>
        <Form layout="vertical">
          <Form.Item label="默认供应商" style={{ marginBottom: 12 }}>
            <Select
              value={settings.provider}
              onChange={(value) => setSettings((prev) => ({ ...prev, provider: value }))}
              options={TRANSLATE_PROVIDERS.map((item) => ({
                value: item.id,
                label: `${item.label}${isProviderConfigured(item.id, settings.providers[item.id]) ? '（已配置）' : ''}`,
              }))}
            />
          </Form.Item>
          <Space size={16} wrap>
            <Form.Item label="源语言" style={{ marginBottom: 0 }}>
              <Select
                style={{ width: 150 }}
                value={settings.source}
                onChange={(value: TranslateLangCode) => setSettings((prev) => ({ ...prev, source: value }))}
                options={TRANSLATE_LANGS.map((item) => ({ value: item.code, label: item.label }))}
              />
            </Form.Item>
            <Form.Item label="目标语言" style={{ marginBottom: 0 }}>
              <Select
                style={{ width: 150 }}
                value={settings.target}
                onChange={(value: TranslateLangCode) => setSettings((prev) => ({ ...prev, target: value }))}
                options={TRANSLATE_TARGET_LANGS.map((item) => ({ value: item.code, label: item.label }))}
              />
            </Form.Item>
          </Space>
        </Form>
      </Card>

      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {TRANSLATE_PROVIDERS.map((meta) => {
          const config = settings.providers[meta.id] || {};
          const ready = isProviderConfigured(meta.id, config);
          return (
            <Card
              key={meta.id}
              size="small"
              title={(
                <Space>
                  {meta.label}
                  {ready ? <Tag color="green">已配置</Tag> : <Tag>未配置</Tag>}
                </Space>
              )}
            >
              <Paragraph type="secondary" style={{ marginBottom: 12 }}>
                {meta.hint}
                {' '}
                <a href={meta.docs} target="_blank" rel="noreferrer">接口文档</a>
              </Paragraph>
              <Form layout="vertical">
                {meta.auth === 'apiKey' ? (
                  <Form.Item label="API Key" style={{ marginBottom: 12 }}>
                    <Input.Password
                      placeholder={`粘贴 ${meta.label} 的 API Key`}
                      value={config.apiKey || ''}
                      onChange={(event) => patchProvider(meta.id, { apiKey: event.target.value })}
                      autoComplete="off"
                    />
                  </Form.Item>
                ) : (
                  <Space size={16} wrap>
                    <Form.Item label="App ID" style={{ marginBottom: 12 }}>
                      <Input
                        style={{ width: 240 }}
                        placeholder="应用 ID / APPID"
                        value={config.appId || ''}
                        onChange={(event) => patchProvider(meta.id, { appId: event.target.value })}
                        autoComplete="off"
                      />
                    </Form.Item>
                    <Form.Item label="密钥" style={{ marginBottom: 12 }}>
                      <Input.Password
                        style={{ width: 320 }}
                        placeholder="应用密钥 / 密钥"
                        value={config.appSecret || ''}
                        onChange={(event) => patchProvider(meta.id, { appSecret: event.target.value })}
                        autoComplete="off"
                      />
                    </Form.Item>
                  </Space>
                )}
                {meta.id === 'deepl' && (
                  <Form.Item label="使用 Free 接口（api-free.deepl.com）" style={{ marginBottom: 0 }}>
                    <Switch
                      checked={config.useFreeApi === true}
                      onChange={(checked) => patchProvider(meta.id, { useFreeApi: checked })}
                    />
                    <Text type="secondary" style={{ marginLeft: 12 }}>
                      Key 以 <Text code>:fx</Text> 结尾时一般属于免费版
                    </Text>
                  </Form.Item>
                )}
              </Form>
            </Card>
          );
        })}
      </Space>

      <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 16 }}>
        <Button type="primary" loading={saving} disabled={loading} onClick={() => void handleSave()}>
          保存翻译设置
        </Button>
        <Text type="secondary">已配置 {configuredCount} / {TRANSLATE_PROVIDERS.length} 个供应商</Text>
      </div>

      <Alert
        type="warning"
        showIcon
        style={{ marginTop: 20 }}
        message="跨域说明"
        description="翻译请求由扩展页面直接发往各供应商域名（已声明 <all_urls> 主机权限），不经过本项目的中转服务。若供应商侧限制了来源或配额，请在其控制台调整。"
      />
    </div>
  );
}
