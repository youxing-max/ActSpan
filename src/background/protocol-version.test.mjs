import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const bundle = await build({
  stdin: {
    contents: "export { compareProtocolVersions, PROTOCOL_VERSION } from './src/background/protocol-version.ts';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { compareProtocolVersions, PROTOCOL_VERSION } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const extensionPackage = JSON.parse(await readFile('package.json', 'utf8'));
const bridgePackage = JSON.parse(await readFile('mcp-server/package.json', 'utf8'));
const manifest = JSON.parse(await readFile('public/manifest.json', 'utf8'));

test('extension and bridge package plus manifest versions stay synchronized', () => {
  assert.equal(extensionPackage.version, bridgePackage.version);
  assert.equal(manifest.version, extensionPackage.version);
});

test('extension protocol helper keeps patch skew silent', () => {
  const [major, minor] = extensionPackage.version.split('.');
  const result = compareProtocolVersions(
    { appVersion: extensionPackage.version, protocolVersion: PROTOCOL_VERSION },
    { appVersion: `${major}.${minor}.99`, protocolVersion: PROTOCOL_VERSION },
  );
  assert.equal(result.compatible, true);
  assert.equal(result.warning, null);
});

test('extension helper identifies the local side when its minor version is behind', () => {
  const result = compareProtocolVersions(
    { appVersion: '1.2.0', protocolVersion: PROTOCOL_VERSION },
    { appVersion: '1.10.0', protocolVersion: PROTOCOL_VERSION },
  );
  assert.equal(result.compatible, true);
  assert.match(result.warning, /local.*behind.*peer/i);
});

test('extension helper stays silent when either app version is missing', () => {
  const result = compareProtocolVersions(
    { appVersion: undefined, protocolVersion: PROTOCOL_VERSION },
    { appVersion: '1.10.0', protocolVersion: PROTOCOL_VERSION },
  );
  assert.equal(result.compatible, true);
  assert.equal(result.warning, null);
});

test('extension protocol helper flags protocol mismatch', () => {
  const result = compareProtocolVersions(
    { appVersion: extensionPackage.version, protocolVersion: PROTOCOL_VERSION },
    { appVersion: extensionPackage.version, protocolVersion: PROTOCOL_VERSION + 1 },
  );
  assert.equal(result.compatible, false);
  assert.match(result.error, /protocol/i);
});
