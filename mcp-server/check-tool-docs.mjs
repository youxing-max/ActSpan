#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_NAMES } from './catalog.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DOCS = ['MCP-BRIDGE.md', 'README.md'];
const TOOL_NAME_PATTERN = /\bactspan_[a-z_]+\b/g;

const targets = process.argv.slice(2);
const docs = targets.length > 0 ? targets : DEFAULT_DOCS;

const documented = new Set();
for (const doc of docs) {
    const path = resolve(REPO_ROOT, doc);
    let text;
    try {
        text = readFileSync(path, 'utf8');
    } catch (err) {
        console.error(`check-tool-docs: cannot read ${path}: ${err.message}`);
        process.exit(2);
    }
    for (const match of text.matchAll(TOOL_NAME_PATTERN)) documented.add(match[0]);
}

const known = new Set(TOOL_NAMES);
const missing = TOOL_NAMES.filter((name) => !documented.has(name));
const extra = [...documented].filter((name) => !known.has(name)).sort();

console.log(`docs=${docs.length} tools=${TOOL_NAMES.length} missing=${missing.length} extra=${extra.length}`);
if (missing.length > 0) console.log(`missing: ${missing.join(', ')}`);
if (extra.length > 0) console.log(`extra: ${extra.join(', ')}`);

process.exit(missing.length > 0 || extra.length > 0 ? 1 : 0);
