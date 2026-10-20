export const PROTOCOL_VERSION = 1;

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

type ProtocolMetadata = {
  appVersion?: unknown;
  protocolVersion?: unknown;
  version?: unknown;
  protocol?: unknown;
};

type ParsedVersion = { text: string; parts: [number, number, number] };

export type ProtocolComparison = {
  compatible: boolean;
  warning: string | null;
  error: string | null;
  localVersion: string | null;
  peerVersion: string | null;
  localProtocol: number | null;
  peerProtocol: number | null;
};

function readMetadataValue(metadata: ProtocolMetadata | string | null | undefined, primary: keyof ProtocolMetadata, legacy: keyof ProtocolMetadata): unknown {
  if (typeof metadata === 'string') return primary === 'appVersion' ? metadata : undefined;
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = metadata[primary];
  return value === undefined ? metadata[legacy] : value;
}

function parseVersion(value: unknown): ParsedVersion | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = VERSION_PATTERN.exec(text);
  if (!match) return null;
  return { text, parts: [Number(match[1]), Number(match[2]), Number(match[3])] };
}

function parseProtocol(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** Compare local and peer bridge metadata; protocol skew is incompatible, app skew is informational. */
export function compareProtocolVersions(
  local: ProtocolMetadata | string | null | undefined,
  peer: ProtocolMetadata | string | null | undefined,
): ProtocolComparison {
  const localVersion = parseVersion(readMetadataValue(local, 'appVersion', 'version'));
  const peerVersion = parseVersion(readMetadataValue(peer, 'appVersion', 'version'));
  const localProtocol = parseProtocol(readMetadataValue(local, 'protocolVersion', 'protocol'));
  const peerProtocol = parseProtocol(readMetadataValue(peer, 'protocolVersion', 'protocol'));

  if (localProtocol !== null && peerProtocol !== null && localProtocol !== peerProtocol) {
    return {
      compatible: false,
      warning: null,
      error: `Protocol mismatch: local protocol ${localProtocol}, peer protocol ${peerProtocol}`,
      localVersion: localVersion?.text || null,
      peerVersion: peerVersion?.text || null,
      localProtocol,
      peerProtocol,
    };
  }

  let warning: string | null = null;
  if (localVersion && peerVersion) {
    const [localMajor, localMinor, localPatch] = localVersion.parts;
    const [peerMajor, peerMinor, peerPatch] = peerVersion.parts;
    if (localMajor !== peerMajor) {
      warning = localMajor < peerMajor
        ? `Local app version ${localVersion.text} is behind peer app version ${peerVersion.text} by major version`
        : `Peer app version ${peerVersion.text} is behind local app version ${localVersion.text} by major version`;
    } else if (localMinor !== peerMinor) {
      warning = localMinor < peerMinor
        ? `Local app version ${localVersion.text} is behind peer app version ${peerVersion.text} by minor version`
        : `Peer app version ${peerVersion.text} is behind local app version ${localVersion.text} by minor version`;
    } else if (localPatch !== peerPatch) {
      warning = null;
    }
  }

  return {
    compatible: true,
    warning,
    error: null,
    localVersion: localVersion?.text || null,
    peerVersion: peerVersion?.text || null,
    localProtocol,
    peerProtocol,
  };
}
