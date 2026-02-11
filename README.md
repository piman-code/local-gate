# Local Gate

Local Gate is an Obsidian plugin that lets you switch between multiple local AI profiles and apply the selected profile to Agent Client's Codex configuration.

## What it does

- Stores multiple local AI profiles (Ollama, LM Studio, OpenAI-compatible local endpoints)
- Adds a command palette switcher: `Local Gate: Switch Local AI Profile`
- Writes the selected profile to:
  - `.obsidian/plugins/agent-client/data.json`
  - `codex.command`
  - `codex.args`
  - `codex.env`
- Optionally sets `defaultAgentId` to `codex-acp`

## Requirements

- Obsidian desktop
- Agent Client plugin installed (`agent-client`)
- Codex ACP binary (`codex-acp`) available in PATH or set by full path in profile

## Install with BRAT

1. Install and enable the BRAT plugin in Obsidian.
2. Open **BRAT -> Add a beta plugin**.
3. Paste your repository URL for this plugin.
4. Enable **Local Gate** in Community Plugins.

This repository must contain `manifest.json` and `main.js` at repo root (already included).

## Commands

- `Local Gate: Switch Local AI Profile`
- `Local Gate: Apply Last Profile`

## Settings

- `Agent Client settings path`: vault-relative path to Agent Client's `data.json`
- `Profiles JSON`: full editable profile list
- `Save profile JSON`: validate and save profile list
- `Reset defaults`: restore bundled profile presets

## Default profiles

- `Ollama: gpt-oss:20b`
- `Ollama: qwen2.5-coder`
- `LM Studio: default model`

## Profile format

```json
[
  {
    "id": "ollama-gpt-oss-20b",
    "name": "Ollama: gpt-oss:20b",
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

## Publish checklist

1. Push this repository to GitHub.
2. Create a release and attach:
   - `manifest.json`
   - `main.js`
   - `versions.json`
3. Share the repo URL for BRAT users.
