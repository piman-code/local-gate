# Local Gate

Local Gate is an Obsidian plugin that discovers local AI models (Ollama / LM Studio), shows model capabilities, and publishes them into Agent Client so you can select them from the agent dropdown.

## Highlights

- Auto-discovery for local models:
  - Ollama via `ollama list` + `ollama show`
  - LM Studio via `GET /v1/models`
- Capability display (for example: `completion`, `tools`, `thinking`)
- One-click actions from settings:
  - `Add profile`
  - `Apply now`
- Saved profile controls:
  - `Apply`
  - `Delete`
- Agent Client integration:
  - Sync profiles as `customAgents` entries
  - Select each local model directly in Agent Client UI
  - Keep built-in Claude/Codex/Gemini settings stable (Local Gate only manages local custom agents)
- Profile switcher from command palette
- Writes directly to Agent Client Codex config:
  - `.obsidian/plugins/agent-client/data.json`
  - `codex.command`
  - `codex.args`
  - `codex.env`

## Requirements

- Obsidian desktop
- Agent Client plugin installed (`agent-client`)
- Codex ACP binary (`codex-acp`) available in PATH or absolute path
- Optional providers:
  - Ollama running locally
  - LM Studio local server running (OpenAI-compatible endpoint)

## Install with BRAT

1. Install and enable BRAT in Obsidian.
2. Open **BRAT -> Add a beta plugin**.
3. Paste this repository URL: `https://github.com/piman-code/local-gate`.
4. Enable **Local Gate** in Community Plugins.

## Commands

- `Local Gate: Switch Local AI Profile`
- `Local Gate: Apply Last Profile`
- `Local Gate: Scan Local Models`
- `Local Gate: Sync Models to Agent Client`

## Settings overview

- `Scan local models`: refresh discovery list
- `Scan on startup`: auto-scan when Obsidian starts
- `Enable Ollama scan` / `Enable LM Studio scan`
- `Ollama base URL` / `LM Studio base URL`
- `Codex ACP command`
- `Discovered Local Models`: add/apply directly
- `Saved Profiles`: apply/delete quickly
- `Sync to Agent Client`: publish profile list to agent dropdown
- `Advanced Profile JSON`: full manual editing

## Default profiles

- `Ollama: gpt-oss:20b`
- `Ollama: qwen2.5-coder:14b`
- `LM Studio: local-model`

## Advanced profile format

```json
[
  {
    "id": "ollama-gpt-oss-20b",
    "name": "Ollama: gpt-oss:20b",
    "provider": "ollama",
    "endpoint": "http://localhost:11434/v1",
    "capabilities": ["completion", "tools", "thinking"],
    "command": "codex-acp",
    "args": [
      "-c",
      "model_provider=\"local\"",
      "-c",
      "model=\"gpt-oss:20b\"",
      "-c",
      "model_providers.local.name=\"local\"",
      "-c",
      "model_providers.local.base_url=\"http://localhost:11434/v1\""
    ],
    "env": [],
    "setAsDefaultAgent": true
  }
]
```

## Release checklist

1. Push to GitHub.
2. Create a release.
3. Attach:
   - `manifest.json`
   - `main.js`
   - `styles.css`
   - `versions.json`
4. BRAT users add repo URL and install.
