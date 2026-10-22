import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
// SDK 的 exports 映射指向 dist/esm，深路径必须落到那里；写 client/index.js 会直接找不到模块。
import { Client } from '../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const fixtureRoot = resolve(root, 'fixtures');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
export const FIXTURE_NAMES = Object.freeze(['playground.html', 'creds.html', 'csp.html', 'frame-inner.html', 'newtab.html', 'newtab-child.html', 'flow.html', 'acceptance.html', 'gaps.html']);

export async function startFixtureHost() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
      if (pathname === '/acceptance.json') {
        const body = Buffer.from(JSON.stringify({ page: 1, items: ['fixture'], next: null }));
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': body.byteLength });
        response.end(body);
        return;
      }
      const relative = pathname === '/' ? '/playground.html' : pathname;
      const file = normalize(join(fixtureRoot, relative));
      const name = file.slice(fixtureRoot.length + 1);
      if (!file.startsWith(fixtureRoot) || !FIXTURE_NAMES.includes(name)) { response.writeHead(404).end('fixture not found'); return; }
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'content-length': body.byteLength });
      response.end(body);
    } catch (error) { response.writeHead(error?.code === 'ENOENT' ? 404 : 500).end(String(error?.message || error)); }
  });
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolvePromise); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  if (!port) throw new Error('Fixture host failed to acquire a port');
  return {
    port,
    url: (name = 'playground.html', hostname = 'localhost') => `http://${hostname}:${port}/${name}`,
    // 浏览器对靶场主机保持 keep-alive 连接，server.close 会一直等这些连接自然结束，
    // 于是 close() 永不 resolve、整个进程吊死。先掐连接再关。
    close: () => new Promise((resolvePromise, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolvePromise());
    }),
  };
}

function parseMcpText(result) {
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  if (typeof text !== 'string') return result;
  try { return JSON.parse(text); } catch { return text; }
}

export async function createMcpHarness() {
  const extensionId = String(process.env.ACTSPAN_EXTENSION_IDS || process.env.ACTSPAN_EXTENSION_ID || '').trim();
  const command = process.env.ACTSPAN_MCP_COMMAND || process.execPath;
  let args;
  try { args = process.env.ACTSPAN_MCP_ARGS ? JSON.parse(process.env.ACTSPAN_MCP_ARGS) : [join(root, '..', 'mcp-server', 'index.js')]; } catch (error) { throw new Error(`ACTSPAN_MCP_ARGS must be a JSON array: ${error.message}`); }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('ACTSPAN_MCP_ARGS must be a JSON string array');
  if (!process.env.ACTSPAN_MCP_COMMAND && !extensionId) throw new Error('MCP acceptance setup is incomplete: set ACTSPAN_EXTENSION_IDS to the installed extension ID; the test will not guess or fake pairing.');
  const logDir = mkdtempSync(join(tmpdir(), 'actspan-scenarios-'));
  const bridgeUrl = process.env.ACTSPAN_BRIDGE_URL || 'ws://127.0.0.1:30121';
  const transport = new StdioClientTransport({ command, args, cwd: join(root, '..', 'mcp-server'), env: { ...getDefaultEnvironment(), ...process.env, ACTSPAN_API_URL: process.env.ACTSPAN_API_URL || 'https://acceptance.invalid', ACTSPAN_API_KEY: process.env.ACTSPAN_API_KEY || 'acceptance-only-key', ...(extensionId ? { ACTSPAN_EXTENSION_IDS: extensionId } : {}), ACTSPAN_BRIDGE_URL: bridgeUrl, ACTSPAN_MCP_LOG: join(logDir, 'mcp-server.log'), MOLE_MCP_LOG: join(logDir, 'mcp-server.log') }, stderr: 'pipe' });
  const client = new Client({ name: 'actspan-scenarios', version: '1.0.0' });
  try { await client.connect(transport); } catch (error) {
    await client.close().catch(() => undefined);
    throw new Error(`Actspan MCP server did not start. Inspect ${join(logDir, 'mcp-server.log')}: ${error.message}`);
  }
  try {
    const callRaw = (name, args = {}) => client.callTool({ name, arguments: args });
    const call = async (name, args = {}) => {
      const result = await callRaw(name, args);
      if (result?.isError) throw new Error(`${name}: ${result.content?.map((item) => item.text || '').join('\n') || 'tool failed'}`);
      return parseMcpText(result);
    };
    const listed = await client.listTools(); const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
    const requireTool = (name) => { if (!tools.has(name)) throw new Error(`Actspan contract unavailable: MCP tool ${name} is not registered; refusing to skip/pass.`); return tools.get(name); };
    const status = await call('actspan_status');
    if (status?.connected !== true) throw new Error(`Actspan extension is not connected through the existing bridge: ${JSON.stringify(status)}. This suite never fakes a bridge or launches Chrome.`);
    return { client, tools, call, callRaw, requireTool, async close() { await client.close(); } };
  } catch (error) {
    // 子进程不关掉会一直占着 stdio 管道，node --test 的事件循环永远清不空，整个进程吊死。
    await client.close().catch(() => undefined);
    throw error;
  }
}

export async function waitForPageValue(read, expression, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await read(expression); if (typeof expected === 'function' ? expected(value) : Object.is(value, expected)) return value; await delay(80); }
  throw new Error(`Timed out waiting for page expression: ${expression}`);
}

export { delay };
