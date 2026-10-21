import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');

test('active float-ball entry uses Actspan symbols and DOM contracts', async () => {
  const entry = read('src/content/float-ball-react.tsx');
  assert.equal(existsSync(join(root, 'src/content/float-ball/ActspanRoot.tsx')), true);
  assert.match(entry, /import \{ ActspanRoot \} from ['"]\.\/float-ball\/ActspanRoot['"]/);
  assert.match(entry, /actspan-root/);
  assert.match(entry, /actspan-react-root/);
  assert.match(entry, /actspan-escape/);
  assert.match(entry, /actspan-click-outside/);
  assert.doesNotMatch(entry, /MoleRoot|mole-root|mole-react-root|mole-escape|mole-click-outside/);
});

test('active context graph no longer exposes Mole symbols', () => {
  const activeFiles = [
    'src/content/float-ball/ActspanRoot.tsx',
    'src/content/float-ball/context/ActspanContext.tsx',
    'src/content/float-ball/context/useActspan.ts',
    'src/content/float-ball/context/context.ts',
    'src/content/float-ball/context/reducer.ts',
    'src/content/float-ball/context/types.ts',
    'src/sidepanel/SidePanelApp.tsx',
  ];
  for (const file of activeFiles) {
    assert.equal(existsSync(join(root, file)), true, file);
    assert.doesNotMatch(read(file), /\bMole(?:Root|Provider|Context|State|Action|Inner)?\b|\buseMole\b|\bmoleReducer\b/);
  }
});

test('active DOM producers and consumers share Actspan contracts', () => {
  const contracts = {
    'src/content/float-ball-react.tsx': ['actspan-root'],
    'src/content/recorder-overlay.ts': ['actspan-recorder-overlay', 'data-actspan-step'],
    'src/content/float-ball/hooks/useGlobalEvents.ts': ['actspan-escape', 'actspan-click-outside'],
    'src/content/float-ball/hooks/useRecorder.ts': ['#actspan-root', '#actspan-recorder-overlay'],
    'src/functions/cdp-dom.ts': ["getElementById('actspan-root')"],
    'src/functions/extract-data.ts': ["child.id === 'actspan-root'"],
  };
  for (const [file, expected] of Object.entries(contracts)) {
    const source = read(file);
    for (const contract of expected) assert.match(source, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(source, /mole-root|mole-recorder-overlay|mole-escape|mole-click-outside/);
  }
});

test('legacy storage identifiers remain explicit migration inputs', () => {
  const llm = read('src/ai/llm-client.ts');
  assert.match(llm, /actspan_ai_settings/);
  assert.match(llm, /mole_ai_settings/);
  assert.match(read('src/lib/legacy-storage.test.mjs'), /mole_timers/);
});
