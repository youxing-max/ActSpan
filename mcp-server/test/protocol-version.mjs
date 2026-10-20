import assert from 'node:assert/strict';
import test from 'node:test';
import { compareProtocolVersions, PROTOCOL_VERSION } from '../protocol-version.js';

test('patch differences are compatible and silent', () => {
    const result = compareProtocolVersions(
        { appVersion: '1.1.0', protocolVersion: 1 },
        { appVersion: '1.1.4', protocolVersion: 1 },
    );
    assert.equal(result.compatible, true);
    assert.equal(result.warning, null);
    assert.equal(result.error, null);
});

test('minor skew identifies whether local or peer is behind', () => {
    const localBehind = compareProtocolVersions(
        { appVersion: '1.2.0', protocolVersion: 1 },
        { appVersion: '1.4.0', protocolVersion: 1 },
    );
    assert.equal(localBehind.compatible, true);
    assert.match(localBehind.warning, /local.*behind.*peer/i);

    const peerBehind = compareProtocolVersions(
        { appVersion: '1.4.0', protocolVersion: 1 },
        { appVersion: '1.2.0', protocolVersion: 1 },
    );
    assert.equal(peerBehind.compatible, true);
    assert.match(peerBehind.warning, /peer.*behind.*local/i);
});

test('protocol mismatch is incompatible even when app versions match', () => {
    const result = compareProtocolVersions(
        { appVersion: '1.1.0', protocolVersion: 1 },
        { appVersion: '1.1.0', protocolVersion: 2 },
    );
    assert.equal(result.compatible, false);
    assert.equal(result.warning, null);
    assert.match(result.error, /protocol/i);
});

test('missing app version is silent', () => {
    const result = compareProtocolVersions(
        { appVersion: undefined, protocolVersion: PROTOCOL_VERSION },
        { appVersion: '1.1.0', protocolVersion: PROTOCOL_VERSION },
    );
    assert.equal(result.compatible, true);
    assert.equal(result.warning, null);
    assert.equal(result.error, null);
});

test('version comparison is numeric rather than lexical', () => {
    const result = compareProtocolVersions(
        { appVersion: '1.10.0', protocolVersion: 1 },
        { appVersion: '1.2.0', protocolVersion: 1 },
    );
    assert.match(result.warning, /peer.*behind.*local/i);
    assert.equal(result.localVersion, '1.10.0');
    assert.equal(result.peerVersion, '1.2.0');
});

test('legacy metadata keys remain readable during rollout', () => {
    const result = compareProtocolVersions(
        { version: '1.1.0', protocol: 1 },
        { version: '1.1.0', protocol: 1 },
    );
    assert.equal(result.compatible, true);
    assert.equal(result.localVersion, '1.1.0');
});

test('compatibility result exposes concrete local and peer evidence for status reporting', () => {
    const result = compareProtocolVersions(
        { appVersion: '1.2.0', protocolVersion: 1 },
        { appVersion: '1.3.4', protocolVersion: 1 },
    );
    assert.deepEqual({
        localVersion: result.localVersion,
        peerVersion: result.peerVersion,
        localProtocol: result.localProtocol,
        peerProtocol: result.peerProtocol,
    }, {
        localVersion: '1.2.0',
        peerVersion: '1.3.4',
        localProtocol: 1,
        peerProtocol: 1,
    });
    assert.equal(result.compatible, true);
    assert.match(result.warning, /local.*behind.*peer/i);
});
