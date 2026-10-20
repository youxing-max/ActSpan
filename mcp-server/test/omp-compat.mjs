import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const config = read('src/config/index.ts');
assert.match(config, /DEFAULT_ENDPOINT:\s*'https:\/\/ai-api-gateway\.app\.baizhi\.cloud\/api\/openai\/v1\/responses'/);
assert.match(config, /DEFAULT_MODEL:\s*'gpt-6\.1-sol'/);

const client = read('src/ai/llm-client.ts');
assert.match(client, /endpoint:\s*AI_CONFIG\.DEFAULT_ENDPOINT/);
assert.match(client, /model:\s*AI_CONFIG\.DEFAULT_MODEL/);

const settingsPage = read('src/options/pages/LLMSettingsPage.tsx');
assert.match(settingsPage, /AI_CONFIG\.DEFAULT_ENDPOINT/);
assert.match(settingsPage, /AI_CONFIG\.DEFAULT_MODEL/);
assert.doesNotMatch(settingsPage, /gpt-5\.4|gpt-5\.3-codex/);

const bridge = read('mcp-server/bridge.js');
// bridge.js 后来与 createHash 合并成一条 import，断言只关心 randomUUID 来自 node:crypto。
assert.match(bridge, /import \{[^}]*\brandomUUID\b[^}]*\} from 'node:crypto';/);
assert.match(bridge, /randomUUID\(\)/);

console.log('PASS: OMP-compatible Actspan defaults and Node bridge startup contract');
