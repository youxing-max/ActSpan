/**
 * LLM 设置页面
 * 配置 AI API 连接信息（Endpoint / API Key / Model）
 * 首次未配置时展示引导浮层
 */

import { useEffect, useState } from 'react';
import { Button, Form, Input, Modal, Space, Typography, App, Select } from 'antd';
import { CheckCircleOutlined } from '@ant-design/icons';
import { getAISettings, saveAISettings, validateEndpoint } from '../../ai/llm-client';
import { AI_CONFIG } from '../../config';
import { OptionsPageLayout, OptionsSectionCard } from '../components/PageLayout';

const { Title, Text, Paragraph } = Typography;

const API_MODE_OPTIONS = [
  { value: 'responses', label: 'OpenAI Responses' },
  { value: 'chat_completions', label: 'Chat Completions' },
];

/** 检查设置是否已配置（合法 endpoint + apiKey） */
const isConfigured = (s: { endpoint?: string; apiKey?: string }): boolean =>
  !!s.apiKey?.trim() && validateEndpoint(String(s.endpoint || '')).ok;

/** endpoint 校验规则：阻止 http 公网地址泄露 API Key */
const endpointRule = {
  validator: async (_rule: unknown, value: unknown) => {
    if (!value) return;
    const result = validateEndpoint(String(value));
    if (!result.ok) throw new Error(result.error);
  },
};

export function LLMSettingsPage() {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [setupForm] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const endpoint = Form.useWatch('endpoint', form);
  const apiKey = Form.useWatch('apiKey', form);
  const model = Form.useWatch('model', form);

  /* 加载已保存的设置，判断是否需要引导 */
  useEffect(() => {
    const load = async () => {
      const settings = await getAISettings();
      form.setFieldsValue({
        endpoint: settings.endpoint || AI_CONFIG.DEFAULT_ENDPOINT,
        apiKey: settings.apiKey || '',
        model: settings.model || AI_CONFIG.DEFAULT_MODEL,
        apiMode: settings.apiMode || 'responses',
      });
      if (!isConfigured(settings)) {
        setupForm.setFieldsValue({
          endpoint: AI_CONFIG.DEFAULT_ENDPOINT,
          apiKey: '',
          model: AI_CONFIG.DEFAULT_MODEL,
          apiMode: settings.apiMode || 'responses',
        });
        setShowSetup(true);
      }
      setLoaded(true);
    };
    void load();
  }, [form, setupForm]);

  /* 保存设置（通用） */
  const doSave = async (values: Record<string, any>, fromSetup = false) => {
    setSaving(true);
    try {
      await saveAISettings({
        endpoint: String(values.endpoint || AI_CONFIG.DEFAULT_ENDPOINT).trim(),
        apiKey: String(values.apiKey || '').trim(),
        model: String(values.model || AI_CONFIG.DEFAULT_MODEL).trim(),
        apiMode: values.apiMode || 'responses',
      });
      if (fromSetup) {
        setShowSetup(false);
        form.setFieldsValue({
          endpoint: values.endpoint || AI_CONFIG.DEFAULT_ENDPOINT,
          apiKey: values.apiKey,
          model: values.model || AI_CONFIG.DEFAULT_MODEL,
          apiMode: values.apiMode || 'responses',
        });
      }
      void message.success('设置已保存，Actspan 准备就绪');
    } catch (err: any) {
      void message.error(err?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  /* 主表单保存 */
  const handleSave = async () => {
    const values = form.getFieldsValue();
    await doSave(values);
  };

  /* 引导浮层保存 */
  const handleSetupSave = async () => {
    try {
      const values = await setupForm.validateFields();
      await doSave(values, true);
    } catch {
      /* 表单校验不通过，忽略 */
    }
  };

  if (!loaded) return null;

  const configured = isConfigured({ endpoint, apiKey });
  const endpointLabel = endpoint ? String(endpoint).replace(/^https?:\/\//, '') : '未配置';
  const endpointCheck = validateEndpoint(String(endpoint || ''));
  const endpointWarning = endpointCheck.ok ? endpointCheck.warning : undefined;

  return (
    <>
      <OptionsPageLayout
        eyebrow="Core Setup"
        title="模型与连接配置"
        description="配置与 OMP anyrouter 一致的 OpenAI Responses API 连接，也可以填写其他兼容服务。"
        extra={
          <Space>
            <Button onClick={() => form.resetFields()}>重置表单</Button>
            <Button type="primary" loading={saving} onClick={() => void handleSave()}>
              保存设置
            </Button>
          </Space>
        }
        metrics={[
          {
            label: '连接状态',
            value: configured ? '已连接' : '待配置',
            hint: configured ? 'API 地址和密钥已写入本地存储' : '完成三项配置后即可启用 AI 助手',
            accent: configured ? 'green' : 'orange',
          },
          {
            label: '当前模型',
            value: model || AI_CONFIG.DEFAULT_MODEL,
            hint: '与 OMP anyrouter 当前配置一致，可按需修改',
            accent: 'blue',
          },
          {
            label: '服务地址',
            value: endpoint ? '已设置' : '未设置',
            hint: endpointLabel,
            accent: 'neutral',
          },
        ]}
      >
        <OptionsSectionCard
          title="连接配置"
          description="Actspan 使用 OpenAI Responses API 格式与大语言模型通信。"
        >
          <Form form={form} layout="vertical" className="options-form-panel">
            <Form.Item
              label="Endpoint URL"
              name="endpoint"
              rules={[endpointRule]}
              extra={endpointWarning
                ? <Text type="warning">{endpointWarning}</Text>
                : '填写完整 Responses API 地址；默认只允许 https'}
            >
              <Input placeholder={AI_CONFIG.DEFAULT_ENDPOINT} />
            </Form.Item>
            <Form.Item
              label="API Key"
              name="apiKey"
              extra="你的 API 密钥，仅存储在本地浏览器中"
            >
              <Input.Password placeholder="sk-..." />
            </Form.Item>
            <Form.Item
              label="Model"
              name="model"
              extra="默认使用 OMP anyrouter 中配置的 gpt-6.1-sol，也可填写该 provider 下的其他模型"
            >
              <Input placeholder={AI_CONFIG.DEFAULT_MODEL} />
            </Form.Item>
            <Form.Item
              label="API 模式"
              name="apiMode"
              extra="Responses 或 Chat Completions；本地模型（Ollama/LM Studio）选 Chat Completions"
            >
              <Select options={API_MODE_OPTIONS} />
            </Form.Item>
            <Form.Item style={{ marginBottom: 0 }}>
              <Button type="primary" loading={saving} onClick={() => void handleSave()}>
                保存设置
              </Button>
            </Form.Item>
          </Form>
        </OptionsSectionCard>
      </OptionsPageLayout>

      {/* 首次配置引导浮层 */}
      <Modal
        open={showSetup}
        closable={false}
        maskClosable={false}
        footer={null}
        width={520}
        centered
        styles={{
          body: { padding: '36px 32px 28px' },
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <img
            src={chrome.runtime?.getURL?.('actspan-logo.svg') || '/actspan-logo.svg'}
            alt="Actspan"
            style={{ width: 64, height: 64, marginBottom: 12 }}
          />
          <Title level={4} style={{ marginBottom: 4, fontWeight: 600 }}>欢迎使用 Actspan</Title>
          <Paragraph type="secondary" style={{ fontSize: 14, marginBottom: 0, lineHeight: 1.6 }}>
            只需三步，即可让 AI 助手在你的浏览器中工作。
            <br />
            配置完成后，在任意网页按 <Text keyboard>⌘ M</Text> 唤起 Actspan。
          </Paragraph>
        </div>

        <Form form={setupForm} layout="vertical" requiredMark={false}>
          <Form.Item
            label={<span style={{ fontWeight: 500 }}>API 地址</span>}
            name="endpoint"
            rules={[{ required: true, message: '请填写 API Endpoint' }, endpointRule]}
            extra="填写完整 API 地址；默认只允许 https（本机调试可用 localhost）"
          >
            <Input placeholder={AI_CONFIG.DEFAULT_ENDPOINT} />
          </Form.Item>
          <Form.Item
            label={<span style={{ fontWeight: 500 }}>API 密钥</span>}
            name="apiKey"
            rules={[{ required: true, message: '请填写 API Key' }]}
            extra="密钥仅存储在本地浏览器，不会写入仓库"
          >
            <Input.Password placeholder="sk-..." />
          </Form.Item>
          <Form.Item label={<span style={{ fontWeight: 500 }}>模型</span>} name="model">
            <Input placeholder={AI_CONFIG.DEFAULT_MODEL} />
          </Form.Item>
          <Form.Item
            label={<span style={{ fontWeight: 500 }}>API 模式</span>}
            name="apiMode"
            extra="本地模型（Ollama/LM Studio）请选择 Chat Completions"
          >
            <Select options={API_MODE_OPTIONS} />
          </Form.Item>

          <Button
            type="primary"
            block
            loading={saving}
            icon={<CheckCircleOutlined />}
            onClick={() => void handleSetupSave()}
            style={{ height: 40, fontWeight: 500, borderRadius: 8 }}
          >
            开始使用 Actspan
          </Button>
        </Form>
      </Modal>
    </>
  );
}
