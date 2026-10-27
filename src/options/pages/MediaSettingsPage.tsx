/**
 * 图片 / 视频生成设置页
 *
 * 两项能力都要求用户自带接口地址与密钥，扩展只做请求编排，不内置额度。
 */
import { useCallback, useEffect, useState } from 'react';
import { App, Alert, Button, Card, Form, Input, Select, Space, Typography } from 'antd';
import { DEFAULT_MEDIA_SETTINGS } from '../../media/types';
import { IMAGE_MODELS } from '../../media/models';
import type { MediaSettings } from '../../media/types';
import { loadMediaSettings, saveMediaSettings } from '../../media/settings';

const { Paragraph, Text } = Typography;

export function MediaSettingsPage() {
  const { message } = App.useApp();
  const [settings, setSettings] = useState<MediaSettings>(DEFAULT_MEDIA_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadMediaSettings().then((loaded) => {
      setSettings(loaded);
      setLoading(false);
    });
  }, []);

  const patchImage = useCallback((patch: Partial<MediaSettings['image']>) => {
    setSettings((prev) => ({ ...prev, image: { ...prev.image, ...patch } }));
  }, []);

  const patchVideo = useCallback((patch: Partial<MediaSettings['video']>) => {
    setSettings((prev) => ({ ...prev, video: { ...prev.video, ...patch } }));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await saveMediaSettings(settings);
      message.success('图片 / 视频设置已保存');
    } catch {
      message.error('保存失败，请重试');
    } finally {
      setSaving(false);
    }
  }, [settings, message]);

  return (
    <div className="options-form">
      <Alert
        type="info"
        showIcon
        message="图片与视频生成需要你自己接入接口"
        description="扩展不内置任何生成服务额度，也不会上传你的密钥；配置只保存在本机 chrome.storage.local。"
        style={{ marginBottom: 16 }}
      />

      <Card size="small" title="图片生成" style={{ marginBottom: 16 }}>
        <Paragraph type="secondary" style={{ marginBottom: 12 }}>
          按 OpenAI 兼容约定调用 <Text code>{'{baseUrl}/images/generations'}</Text>，
          支持返回 <Text code>b64_json</Text> 或 <Text code>url</Text>。
        </Paragraph>
        <Form layout="vertical">
          <Form.Item label="API 根地址" style={{ marginBottom: 12 }}>
            <Input
              placeholder="https://api.openai.com/v1"
              value={settings.image.baseUrl}
              onChange={(event) => patchImage({ baseUrl: event.target.value })}
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item label="API Key" style={{ marginBottom: 12 }}>
            <Input.Password
              placeholder="sk-..."
              value={settings.image.apiKey}
              onChange={(event) => patchImage({ apiKey: event.target.value })}
              autoComplete="off"
            />
          </Form.Item>
          <Space size={16} wrap>
            <Form.Item label="默认模型" style={{ marginBottom: 0 }}>
              <Select
                style={{ width: 280 }}
                value={settings.image.model}
                onChange={(value) => patchImage({ model: value })}
                options={IMAGE_MODELS.map((item) => ({
                  value: item.id,
                  label: `${item.vendor} · ${item.label}`,
                }))}
              />
            </Form.Item>
          </Space>
          <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
            尺寸、比例、质量这些参数由模型能力决定，在侧边栏的图片面板里按当前模型动态显示，
            这里不需要预先固定。
          </Paragraph>
        </Form>
      </Card>

      <Card size="small" title="视频生成" style={{ marginBottom: 16 }}>
        <Paragraph type="secondary" style={{ marginBottom: 12 }}>
          按「提交任务 + 轮询」约定：
          向 <Text code>{'{baseUrl}{submitPath}'}</Text> POST <Text code>{'{ model, prompt }'}</Text> 拿到任务 ID，
          再 GET <Text code>{'{baseUrl}{queryPath}'}</Text>（可用 <Text code>{'{id}'}</Text> 占位）查状态与地址。
          成功状态识别 <Text code>succeeded / success / completed</Text>。
        </Paragraph>
        <Form layout="vertical">
          <Form.Item label="API 根地址" style={{ marginBottom: 12 }}>
            <Input
              placeholder="https://your-provider.example/v1"
              value={settings.video.baseUrl}
              onChange={(event) => patchVideo({ baseUrl: event.target.value })}
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item label="API Key" style={{ marginBottom: 12 }}>
            <Input.Password
              placeholder="填写你的视频服务密钥"
              value={settings.video.apiKey}
              onChange={(event) => patchVideo({ apiKey: event.target.value })}
              autoComplete="off"
            />
          </Form.Item>
          <Space size={16} wrap>
            <Form.Item label="模型" style={{ marginBottom: 0 }}>
              <Input
                style={{ width: 220 }}
                placeholder="例如 kling-v1 / veo-3"
                value={settings.video.model}
                onChange={(event) => patchVideo({ model: event.target.value })}
                autoComplete="off"
              />
            </Form.Item>
            <Form.Item label="提交路径" style={{ marginBottom: 0 }}>
              <Input
                style={{ width: 220 }}
                value={settings.video.submitPath}
                onChange={(event) => patchVideo({ submitPath: event.target.value })}
                autoComplete="off"
              />
            </Form.Item>
            <Form.Item label="查询路径" style={{ marginBottom: 0 }}>
              <Input
                style={{ width: 220 }}
                value={settings.video.queryPath}
                onChange={(event) => patchVideo({ queryPath: event.target.value })}
                autoComplete="off"
              />
            </Form.Item>
          </Space>
        </Form>
      </Card>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <Button type="primary" loading={saving} disabled={loading} onClick={() => void handleSave()}>
          保存图片 / 视频设置
        </Button>
        <Text type="secondary">密钥仅写入本机存储</Text>
      </div>

      <Alert
        type="warning"
        showIcon
        style={{ marginTop: 20 }}
        message="关于视频接口"
        description="视频生成目前没有统一标准，这里采用「提交 + 轮询」的通用约定；如果你的服务商字段不同（例如用 task_id / data[].video_url），扩展已做多种字段兼容，仍不匹配时会给出原始响应前 200 字，便于排查。"
      />
    </div>
  );
}
