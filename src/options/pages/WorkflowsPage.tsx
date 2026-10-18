import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { BrowserTask, PersistedTaskState } from '../../background/task-types';
import { Alert, App, Button, Input, Modal, Popconfirm, Space, Switch, Tag, Typography } from 'antd';
import type { SkillManifestSource, SkillSpec, WorkflowEntry } from '../../functions/skill-types';
import { normalizeWorkflow } from '../../functions/registry-service';
import { ensureSkillRegistryReady, listManifestSources, registryService } from '../../functions/skill-registry';
import type { RegistrySnapshot } from '../../functions/registry-model';
import { getSyncStatus } from './actspan-console-status';

const { Text } = Typography;
const panel: CSSProperties = { background: '#fff', border: '1px solid #dce5ef', borderRadius: 12, padding: 24 };
const label: CSSProperties = { color: '#52657a', fontSize: 12, letterSpacing: '.08em', textTransform: 'uppercase' };
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const identity = (skill: SkillSpec): string => `${skill.scope}:${skill.name}`;
const changedAt = (timestamp?: number): string => timestamp ? new Date(timestamp).toLocaleString() : '—';

const emptyWorkflow = (): WorkflowEntry => ({
  name: '', label: '', description: '', parameters: { type: 'object', properties: {} },
  plan: { version: 1, steps: [] }, version: 1,
});

const bridgeStatus = (): Promise<'connected' | 'disconnected' | 'unavailable'> => new Promise(resolve => {
  try {
    chrome.runtime.sendMessage({ type: 'actspan_bridge_status' }, (response?: { connected?: boolean }) => {
      resolve(chrome.runtime.lastError || typeof response?.connected !== 'boolean'
        ? 'unavailable' : response.connected ? 'connected' : 'disconnected');
    });
  } catch { resolve('unavailable'); }
});

const readTasks = (): Promise<BrowserTask[]> => new Promise((resolve, reject) => {
  chrome.storage.local.get('actspan_task_state', result => {
    if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
    const state = result.actspan_task_state as PersistedTaskState | undefined;
    resolve(Array.isArray(state?.tasks) ? state.tasks : []);
  });
});

export function WorkflowsPage() {
  const { message } = App.useApp();
  const [snapshot, setSnapshot] = useState<RegistrySnapshot | null>(null);
  const [sources, setSources] = useState<SkillManifestSource[]>([]);
  const [bridge, setBridge] = useState<'connected' | 'disconnected' | 'unavailable'>('unavailable');
  const [tasks, setTasks] = useState<BrowserTask[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedExports, setSelectedExports] = useState<string[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<{ skill: SkillSpec; workflow: WorkflowEntry } | null>(null);
  const [editorJson, setEditorJson] = useState('');
  const [editorError, setEditorError] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      await ensureSkillRegistryReady();
      const [next, manifestSources, bridgeConnection, taskRecords] = await Promise.all([
        registryService.listAll(), listManifestSources(), bridgeStatus(), readTasks(),
      ]);
      setSnapshot(next);
      setSources(manifestSources);
      setBridge(bridgeConnection);
      setTasks(taskRecords);
      setError('');
    } catch (cause) {
      setError(`Registry: ${errorText(cause)}`);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void loadData();
    const unsubscribe = registryService.subscribe(() => { void loadData(); });
    const onStorage = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'local' && (changes.actspan_skills || changes.actspan_skill_sources || changes.actspan_task_state)) void loadData();
    };
    const onMessage = (event: { type?: string }) => {
      if (event?.type === 'registry_changed') void loadData();
    };
    chrome.storage.onChanged.addListener(onStorage);
    const bridgeTimer = window.setInterval(() => { void bridgeStatus().then(setBridge); }, 10_000);
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      unsubscribe();
      chrome.storage.onChanged.removeListener(onStorage);
      window.clearInterval(bridgeTimer);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, [loadData]);

  const skills = snapshot?.skills || [];
  const current = skills.find(skill => identity(skill) === selected) || skills[0];
  const syncError = sources.find(source => source.enabled && source.lastSyncError);
  const syncStatus = getSyncStatus(sources);
  const showError = (cause: unknown) => {
    setError(errorText(cause));
    void message.error(errorText(cause));
  };

  const openEditor = (skill?: SkillSpec, workflow?: WorkflowEntry) => {
    setEditing(skill && workflow ? { skill, workflow } : null);
    setEditorJson(JSON.stringify(workflow
      ? { ...workflow, url_patterns: skill?.url_patterns, enabled: skill?.enabled, scope: skill?.scope }
      : { ...emptyWorkflow(), url_patterns: ['*://*/*'], enabled: true, scope: 'domain' }, null, 2));
    setEditorError('');
    setEditorOpen(true);
  };

  const saveWorkflow = async () => {
    try {
      const raw = JSON.parse(editorJson);
      const now = Date.now();
      const workflow = normalizeWorkflow({ ...raw, updatedAt: now }, now);
      if (!workflow) throw new Error('工作流必须包含 name、label 和非空 plan.steps 数组');
      const scope = raw.scope === 'global' ? 'global' : 'domain';
      const oldSkill = editing?.skill;
      if (oldSkill && oldSkill.scope !== scope) throw new Error('不能通过工作流编辑器更改现有 Skill 的 scope');
      const skillName = oldSkill?.name || `user-${workflow.name.replace(/\s+/g, '-')}`;
      const patterns = Array.isArray(raw.url_patterns) ? raw.url_patterns : oldSkill?.url_patterns || ['*://*/*'];
      if (scope === 'domain' && patterns.length === 0) throw new Error('Domain Skill 至少需要一个 URL 匹配规则');
      const replacement: SkillSpec = {
        name: skillName,
        label: oldSkill && oldSkill.workflows.length > 1 ? oldSkill.label : workflow.label,
        description: oldSkill && oldSkill.workflows.length > 1 ? oldSkill.description : workflow.description,
        scope: oldSkill?.scope || scope,
        url_patterns: patterns,
        guide: oldSkill?.guide || '',
        workflows: oldSkill ? [
          ...oldSkill.workflows.filter(item => item.name !== editing?.workflow.name && item.name !== workflow.name), workflow,
        ] : [workflow],
        enabled: raw.enabled !== false,
        source: 'user',
        version: oldSkill?.version || 1,
        createdAt: oldSkill?.createdAt || now,
        updatedAt: now,
      };
      const result = await registryService.upsertSkill(replacement);
      setSelected(identity(replacement));
      setEditorOpen(false);
      void message.success(`已保存 ${workflow.name} · revision ${result.revision}`);
      await loadData();
    } catch (cause) { setEditorError(errorText(cause)); }
  };

  const deleteWorkflow = async (skill: SkillSpec, workflow: WorkflowEntry) => {
    try {
      if (skill.source !== 'user') throw new Error('只允许删除用户创建的工作流');
      const remaining = skill.workflows.filter(item => item.name !== workflow.name);
      const result = remaining.length
        ? await registryService.upsertSkill({ ...skill, workflows: remaining, updatedAt: Date.now() })
        : await registryService.remove(skill.name, skill.scope);
      void message.success(`已删除 ${workflow.name} · revision ${result.revision}`);
      await loadData();
    } catch (cause) { showError(cause); }
  };

  const setEnabled = async (skill: SkillSpec, enabled: boolean) => {
    try {
      const result = await registryService.upsertSkill({ ...skill, enabled, source: 'user', manifestUrl: undefined, updatedAt: Date.now() });
      void message.success(`已更新 ${skill.name} · revision ${result.revision}`);
      await loadData();
    } catch (cause) { showError(cause); }
  };

  const exportWorkflows = () => {
    const workflows = skills.flatMap(skill => skill.workflows
      .filter(workflow => selectedExports.includes(`${identity(skill)}:${workflow.name}`))
      .map(workflow => ({ ...workflow, url_patterns: skill.url_patterns, enabled: skill.enabled, scope: skill.scope })));
    if (!workflows.length) { void message.warning('请先选择工作流'); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, workflows }, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `actspan-workflows-${workflows.length}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importWorkflows = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      if (!input.files?.[0]) return;
      try {
        const imported = JSON.parse(await input.files[0].text());
        const items = Array.isArray(imported) ? imported : imported?.workflows;
        if (!Array.isArray(items)) throw new Error('导入文件必须包含 workflows 数组');
        let count = 0;
        for (const raw of items) {
          const now = Date.now();
          const workflow = normalizeWorkflow({ ...raw, updatedAt: now }, now);
          if (!workflow) throw new Error(`第 ${count + 1} 条工作流缺少有效的 name 或 plan.steps`);
          const name = `user-${workflow.name.replace(/\s+/g, '-')}`;
          const existing = await registryService.get(name, 'domain');
          if (existing && !window.confirm(`“${workflow.name}” 已存在，是否覆盖？`)) continue;
          const patterns = Array.isArray(raw.url_patterns) && raw.url_patterns.length ? raw.url_patterns : existing?.url_patterns || ['*://*/*'];
          await registryService.upsertSkill({
            name, label: workflow.label, description: workflow.description, scope: 'domain',
            url_patterns: patterns, guide: '', workflows: [workflow], enabled: raw.enabled !== false,
            source: 'user', version: existing?.version || 1, createdAt: existing?.createdAt || now, updatedAt: now,
          });
          count++;
        }
        await loadData();
        void message.success(`已导入 ${count} 个工作流`);
      } catch (cause) { showError(cause); }
    };
    input.click();
  };

  return (
    <div style={{ color: '#14253A', padding: '12px 0 32px' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap', marginBottom: 24 }}>
        <div>
          <div style={label}>ACTSPAN / REGISTRY</div>
          <h1 style={{ fontSize: 32, margin: '4px 0 8px', color: '#14253A' }}>Skills &amp; Workflows</h1>
          <Text type="secondary">实时管理浏览器技能和工作流。所有操作写入同一注册表。</Text>
        </div>
        <Space wrap>
          <Button type="primary" onClick={() => openEditor()}>新建工作流</Button>
          <Button onClick={importWorkflows}>导入</Button>
          <Button onClick={exportWorkflows} disabled={!selectedExports.length}>导出 ({selectedExports.length})</Button>
          <Button loading={loading} onClick={() => void loadData()}>刷新</Button>
        </Space>
      </header>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
      <section aria-label="Registry 状态" style={{ ...panel, display: 'flex', gap: 36, flexWrap: 'wrap', marginBottom: 20 }}>
        <div><div style={label}>REVISION</div><strong style={{ fontSize: 26 }}>{snapshot?.revision ?? '—'}</strong></div>
        <div><div style={label}>同步状态</div><Tag color={syncStatus === 'error' ? 'red' : syncStatus === 'stale' ? 'orange' : 'blue'}>{syncStatus}</Tag></div>
        <div><div style={label}>最后更新</div>{changedAt(snapshot?.updatedAt)}</div>
        <div><div style={label}>MCP Bridge</div>{bridge === 'connected' ? '已连接' : bridge === 'disconnected' ? '未连接' : '状态不可用'}</div>
      </section>
      {(sources.length > 0 || syncError) && <section aria-label="Manifest 来源" style={{ ...panel, marginBottom: 20 }}>
        <div style={label}>MANIFEST SOURCES</div>
        {sources.map(source => <div key={source.url} style={{ marginTop: 8 }}>
          <Text strong>{source.label || source.url}</Text> · <Text code>{source.url}</Text> · {source.enabled ? '启用' : '停用'} · {source.syncStartedAt && Date.now() - source.syncStartedAt < 10 * 60 * 1000 ? `同步中 ${changedAt(source.syncStartedAt)}` : `上次同步 ${changedAt(source.lastSyncAt)}`}
          {source.lastSyncError && <Alert type="error" showIcon message={source.lastSyncError} style={{ marginTop: 6 }} />}
        </div>)}
      </section>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 20, alignItems: 'start' }}>
        <section aria-label="技能目录" style={panel}>
          <div style={{ ...label, marginBottom: 12 }}>SKILLS / {skills.length}</div>
          {!skills.length && <Text type="secondary">暂无技能。可以新建或导入工作流。</Text>}
          {skills.map(skill => <button key={identity(skill)} type="button" onClick={() => setSelected(identity(skill))}
            aria-pressed={current && identity(current) === identity(skill)}
            style={{ display: 'block', width: '100%', textAlign: 'left', background: current && identity(current) === identity(skill) ? '#eaf1ff' : '#fff', border: 'none', borderLeft: `3px solid ${current && identity(current) === identity(skill) ? '#2563EB' : 'transparent'}`, padding: '13px 12px', color: '#14253A', cursor: 'pointer', marginTop: 4 }}>
            <strong>{skill.label || skill.name}</strong><br />
            <Text type="secondary">{skill.name} · v{skill.version} · {skill.scope} · {skill.source}</Text>
          </button>)}
        </section>
        <section aria-label="技能详情" style={panel}>
          {!current ? <Text type="secondary">选择技能查看详情。</Text> : <>
            <div style={label}>SKILL DETAIL</div>
            <h2 style={{ margin: '8px 0 4px', color: '#14253A' }}>{current.label}</h2>
            <Text type="secondary">{current.description}</Text>
            <div style={{ margin: '14px 0', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Tag color="blue">{current.scope}</Tag><Tag>{current.source}</Tag><Tag>v{current.version}</Tag>
              <Text type="secondary">更新于 {changedAt(current.updatedAt)}</Text>
              <Switch aria-label={`${current.name} 启用状态`} checked={current.enabled} onChange={enabled => void setEnabled(current, enabled)} />
            </div>
            {current.manifestUrl && <p>Manifest: <Text code>{current.manifestUrl}</Text></p>}
            <p>匹配范围：{current.url_patterns.length ? current.url_patterns.map(pattern => <Tag key={pattern}>{pattern}</Tag>) : '所有页面'}</p>
            <div style={{ ...label, margin: '24px 0 12px' }}>WORKFLOWS / {current.workflows.length}</div>
            {current.workflows.map(workflow => <article key={workflow.name} style={{ borderTop: '1px solid #dce5ef', padding: '16px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div><strong>{workflow.label || workflow.name}</strong> <Text code>{workflow.name}</Text><div><Text type="secondary">{workflow.description}</Text></div></div>
                <Space>
                  <input aria-label={`导出 ${workflow.name}`} type="checkbox" checked={selectedExports.includes(`${identity(current)}:${workflow.name}`)}
                    onChange={event => setSelectedExports(keys => event.target.checked ? [...keys, `${identity(current)}:${workflow.name}`] : keys.filter(key => key !== `${identity(current)}:${workflow.name}`))} />
                  <Button size="small" onClick={() => openEditor(current, workflow)}>编辑</Button>
                  <Popconfirm title={`确定删除 “${workflow.name}” 吗？`} onConfirm={() => void deleteWorkflow(current, workflow)} disabled={current.source !== 'user'}>
                    <Button size="small" danger disabled={current.source !== 'user'}>删除</Button>
                  </Popconfirm>
                </Space>
              </div>
              <div style={{ marginTop: 8 }}>v{workflow.version || 1} · {workflow.plan?.steps?.length || 0} 步 · 更新于 {changedAt(workflow.updatedAt)}</div>
              <ol>{(workflow.steps || workflow.plan?.steps || []).map((step: { id?: string; capability?: string; action?: string }, index: number) =>
                <li key={step.id || index}>{step.capability || step.action || '未知步骤'}</li>)}</ol>
            </article>)}
          </>}
        </section>
      </div>
      <section aria-label="任务记录" style={{ ...panel, marginTop: 20 }}>
        <div style={label}>TASK ACTIVITY / {tasks.length}</div>
        {!tasks.length && <p><Text type="secondary">暂无任务记录。</Text></p>}
        {tasks.slice().sort((a, b) => b.updatedAt - a.updatedAt).map(task => <div key={task.taskId} style={{ borderTop: '1px solid #dce5ef', padding: '12px 0' }}>
          <Text strong>{task.taskId}</Text> · {task.state} · {task.owner} · revision {task.registryRevision}
          <div><Text type="secondary">Session {task.sessionId} · Tab {task.activeTabId ?? (task.ownedTabIds.join(', ') || '—')} · {changedAt(task.updatedAt)}</Text></div>
          {task.error && <Text type="danger">{task.error.code}: {task.error.message}</Text>}
        </div>)}
      </section>
      <Modal title={editing ? `编辑 ${editing.workflow.name}` : '新建工作流'} open={editorOpen} onCancel={() => setEditorOpen(false)} onOk={() => void saveWorkflow()}
        okText="保存" cancelText="取消" width={720} destroyOnClose>
        <p>编辑工作流 JSON；必须包含非空 plan.steps。保存后同步到 Skill Registry。</p>
        <Input.TextArea aria-label="工作流 JSON" value={editorJson} onChange={event => { setEditorJson(event.target.value); setEditorError(''); }} rows={18} style={{ fontFamily: 'monospace' }} />
        {editorError && <Alert type="error" showIcon message={editorError} style={{ marginTop: 12 }} />}
      </Modal>
    </div>
  );
}
