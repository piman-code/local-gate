# Local Gate

Local Gate is an Obsidian plugin that discovers local AI models (Ollama / LM Studio), shows model capabilities, and publishes them into Agent Client so you can select them from the agent dropdown.

## Highlights

- Auto-discovery for local models:
  - Ollama via `ollama list` + `ollama show`
  - LM Studio via `GET /v1/models`
- Capability display (for example: `completion`, `tools`, `thinking`)
- Compatibility gate:
  - Non-chat / non-tool models are shown as `blocked`
  - Blocked models cannot be applied
  - Blocked profiles are excluded from Agent Client sync
- Provider-first Agent Client integration:
  - Switch agent by provider (`Local Ollama`, `Local LM Studio`)
  - Local Gate `Apply` updates Agent Client argument `model="<selected>"`
  - Apply/Sync updates Agent Client runtime immediately (no Obsidian restart needed)
- One-click actions from settings:
  - `Apply`
  - `Hide`
  - `Multi @mentions` (folders/files)
- Agent Client integration:
  - Sync provider agents as `customAgents` entries
  - Keep model list in Agent Client model dropdown (via Codex remote models)
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
- `Local Gate: Copy Folder @Mentions`
- `Local Gate: Copy Multi @Mentions (Folders/Files)`

## Settings overview

- `Scan local models`: refresh discovery list
- `Scan on startup`: auto-scan when Obsidian starts
- `Enable Ollama scan` / `Enable LM Studio scan`
- `Ollama base URL` / `LM Studio base URL`
- `Codex ACP command`
- `Discovered Local Models`: apply/hide directly
- `Sync to Agent Client`: publish profile list to agent dropdown

## Release checklist

1. Push to GitHub.
2. Create a release.
3. Attach:
   - `manifest.json`
   - `main.js`
   - `styles.css`
   - `versions.json`
4. BRAT users add repo URL and install.
