<p align="center">
  <img src="public/actspan-logo.svg" width="128" height="128" alt="Actspan Logo">
</p>

<h1 align="center">Actspan</h1>

<p align="center">
  <strong>Your AI browser assistant — search, interact with pages, and organize information in plain language.</strong>
</p>

<p align="center">
  <a href="./README.md">中文</a> | English
</p>

<p align="center">
  <a href="https://github.com/youxing-max/ActSpan/blob/master/LICENSE">
    <img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License">
  </a>
</p>

---

After you ask a question, Actspan quietly calls tools, searches the web, parses data, and gathers information across sites in your browser. It presents the results without interrupting what you're doing.

## Features

- **AI-Native Chat** — Summon the floating ball anytime for natural language interaction with streaming responses
- **In-Place Execution** — Works inside your real browser, reusing your existing login sessions. No cookie migration, no re-login — operates directly on sites you're already signed into
- **36+ Built-in Tools** — Page operations, deep CDP control (10 domains), request interception, DOM/CSS/storage manipulation, navigation, screenshots, network diagnostics, human-in-the-loop confirmation...
- **Workflow Recorder** — Demonstrate a task once. Record your browser actions and let AI clean them up into a reusable workflow
- **Site Workflows** — Declarative JSON definitions to automate website operations without writing code
- **Bring Your Own LLM** — Compatible with any OpenAI API-format service, full data sovereignty
- **MCP Protocol** — Standardized tool registration and invocation with dynamic extension support
- **Agentic Loop** — Codex-style autonomous loop: code handles boundaries, model handles decisions
- **Open Source** — AGPL-3.0 license, community-driven

## Quick Start

```bash
git clone https://github.com/youxing-max/ActSpan.git
cd ActSpan
npm install
npm run build
```

After building, load the `build_version/actspan-extension/` directory in Chrome. See the [Getting Started Guide](docs/en/guide/getting-started.md) for details.

## How It Works

```
You ask a question → AI enters the background Agentic Loop
                   → Channel communication + MCP tool calls + multi-turn reasoning
                   → Results appear in the floating ball
```

Actspan runs on the three-layer Chrome Extension (MV3) architecture:

| Layer | Role |
|-------|------|
| Content Script | Floating ball UI + page interaction |
| Background | AI orchestration + tool dispatch |
| Channel | Cross-layer messaging |

## Documentation

Read the [Actspan documentation](docs/en/index.md) for detailed usage and development guides.

## Development

```bash
npm run dev          # Dev mode (watch build)
npm run build        # Build all components
npm run lint         # Lint check
npm run docs:dev     # Local docs preview
```

## Acknowledgements

This project was initiated in the [linux.do](https://linux.do) community. Thanks to the community members for their feedback and support.

## License

[AGPL-3.0](LICENSE)
