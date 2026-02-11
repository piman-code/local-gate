"use strict";

const {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SuggestModal,
  normalizePath,
  requestUrl,
} = require("obsidian");
const { execFile } = require("child_process");
const fs = require("fs");

const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const LMSTUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";

const COMMON_BIN_PATHS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  `${process.env.HOME || ""}/.local/bin`,
  `${process.env.HOME || ""}/bin`,
].filter((item) => item.length > 0);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeString(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function sanitizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function toTomlQuoted(value) {
  const escaped = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function ensureNoTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function normalizeOllamaBaseUrl(rawUrl) {
  const fallback = OLLAMA_DEFAULT_BASE_URL;
  let value = sanitizeString(rawUrl, fallback);
  value = ensureNoTrailingSlash(value);
  if (value.endsWith("/v1")) {
    value = value.slice(0, -3);
  }
  return value;
}

function normalizeLmStudioBaseUrl(rawUrl) {
  const fallback = LMSTUDIO_DEFAULT_BASE_URL;
  let value = sanitizeString(rawUrl, fallback);
  value = ensureNoTrailingSlash(value);
  if (!value.endsWith("/v1")) {
    value = `${value}/v1`;
  }
  return value;
}

function toOpenAiEndpoint(provider, configuredBaseUrl) {
  if (provider === "ollama") {
    const base = normalizeOllamaBaseUrl(configuredBaseUrl);
    return `${base}/v1`;
  }
  if (provider === "lmstudio") {
    return normalizeLmStudioBaseUrl(configuredBaseUrl);
  }
  return sanitizeString(configuredBaseUrl, "");
}

function buildLocalCodexArgs(model, openAiBaseUrl) {
  return [
    "-c",
    "model_provider=\"local\"",
    "-c",
    `model=${toTomlQuoted(model)}`,
    "-c",
    "model_providers.local.name=\"local\"",
    "-c",
    `model_providers.local.base_url=${toTomlQuoted(openAiBaseUrl)}`,
  ];
}

function providerLabel(provider) {
  if (provider === "ollama") {
    return "Ollama";
  }
  if (provider === "lmstudio") {
    return "LM Studio";
  }
  return "Local";
}

function formatCapabilities(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    return "unknown";
  }
  return capabilities.join(", ");
}

function inferModelCapabilities(provider, modelName, currentCapabilities) {
  const existing = sanitizeStringArray(currentCapabilities);
  if (existing.length > 0) {
    return existing;
  }
  const lowered = String(modelName || "").toLowerCase();
  if (lowered.includes("embed")) {
    return ["embedding"];
  }
  if (provider === "ollama" || provider === "lmstudio") {
    return ["completion"];
  }
  return [];
}

function buildExecPathEnv() {
  const existing = sanitizeString(process.env.PATH, "");
  const parts = existing.length > 0 ? existing.split(":") : [];
  const merged = [...new Set([...COMMON_BIN_PATHS, ...parts])];
  return merged.join(":");
}

function pathExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (_error) {
    return false;
  }
}

function runCommand(command, args, timeoutMs = 8000, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          ...extraEnv,
          PATH: buildExecPathEnv(),
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = sanitizeString(stderr, error.message || "Command failed");
          reject(new Error(message));
          return;
        }
        resolve(stdout || "");
      }
    );
  });
}

async function resolveExecutable(rawCommand, fallbacks = []) {
  const command = sanitizeString(rawCommand, "");
  if (command.length === 0) {
    return "";
  }

  if (command.includes("/") && pathExists(command)) {
    return command;
  }

  for (const entry of fallbacks) {
    if (pathExists(entry)) {
      return entry;
    }
  }

  try {
    const output = await runCommand("/usr/bin/which", [command], 3000);
    const found = sanitizeString(output.split(/\r?\n/)[0], "");
    if (found.length > 0 && pathExists(found)) {
      return found;
    }
  } catch (_error) {
  }

  return command;
}

function parseOllamaShow(showOutput) {
  const lines = String(showOutput || "").split(/\r?\n/);
  const capabilities = [];
  let contextLength = "";
  let section = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    if (/^[A-Za-z][A-Za-z ]+$/.test(trimmed)) {
      section = trimmed.toLowerCase();
      continue;
    }

    if (section === "capabilities") {
      capabilities.push(trimmed);
      continue;
    }

    if (section === "model" && /^context length\s+/i.test(trimmed)) {
      const tail = trimmed.replace(/^context length\s+/i, "").trim();
      contextLength = tail;
    }
  }

  return { capabilities, contextLength };
}

function defaultProfiles() {
  return [
    {
      id: "ollama-gpt-oss-20b",
      name: "Ollama: gpt-oss:20b",
      provider: "ollama",
      endpoint: toOpenAiEndpoint("ollama", OLLAMA_DEFAULT_BASE_URL),
      capabilities: ["completion", "tools", "thinking"],
      command: "codex-acp",
      args: buildLocalCodexArgs("gpt-oss:20b", toOpenAiEndpoint("ollama", OLLAMA_DEFAULT_BASE_URL)),
      env: [],
      setAsDefaultAgent: true,
    },
    {
      id: "ollama-qwen2-5-coder-14b",
      name: "Ollama: qwen2.5-coder:14b",
      provider: "ollama",
      endpoint: toOpenAiEndpoint("ollama", OLLAMA_DEFAULT_BASE_URL),
      capabilities: ["completion", "tools"],
      command: "codex-acp",
      args: buildLocalCodexArgs("qwen2.5-coder:14b", toOpenAiEndpoint("ollama", OLLAMA_DEFAULT_BASE_URL)),
      env: [],
      setAsDefaultAgent: true,
    },
  ];
}

function defaultSettings() {
  const profiles = defaultProfiles();
  return {
    agentClientSettingsPath: ".obsidian/plugins/agent-client/data.json",
    codexAcpCommand: "codex-acp",
    ollamaCommand: "ollama",
    profiles,
    lastProfileId: profiles[0].id,
    discoveredModels: [],
    scanOnStartup: true,
    enableOllamaScan: true,
    enableLmStudioScan: true,
    ollamaBaseUrl: OLLAMA_DEFAULT_BASE_URL,
    lmStudioBaseUrl: LMSTUDIO_DEFAULT_BASE_URL,
    publishProfilesToAgentClient: true,
    autoCreateProfilesFromDiscovery: true,
    autoSyncToAgentClientAfterScan: true,
    lastScanAt: "",
    lastScanSummary: "",
    lastScanErrors: [],
  };
}

function sanitizeProfile(rawProfile, index) {
  const fallbackId = `profile-${index + 1}`;
  const id = sanitizeString(rawProfile && rawProfile.id, fallbackId);
  const name = sanitizeString(rawProfile && rawProfile.name, id);
  const provider = sanitizeString(rawProfile && rawProfile.provider, "local");
  const endpoint = sanitizeString(rawProfile && rawProfile.endpoint, "");
  const capabilities = sanitizeStringArray(rawProfile && rawProfile.capabilities);
  const command = sanitizeString(rawProfile && rawProfile.command, "codex-acp");
  const args = sanitizeStringArray(rawProfile && rawProfile.args);
  const env = sanitizeStringArray(rawProfile && rawProfile.env);
  const setAsDefaultAgent = rawProfile && rawProfile.setAsDefaultAgent !== false;

  return {
    id,
    name,
    provider,
    endpoint,
    capabilities,
    command,
    args,
    env,
    setAsDefaultAgent,
  };
}

function normalizeProfiles(rawProfiles) {
  const defaults = defaultProfiles();
  const source = Array.isArray(rawProfiles) && rawProfiles.length > 0 ? rawProfiles : defaults;
  const seen = new Set();
  const result = [];

  source.forEach((rawProfile, index) => {
    const profile = sanitizeProfile(rawProfile, index);
    if (seen.has(profile.id)) {
      return;
    }
    seen.add(profile.id);
    result.push(profile);
  });

  return result.length > 0 ? result : defaults;
}

function sanitizeDiscoveredModel(rawModel, index) {
  const fallbackKey = `model-${index + 1}`;
  return {
    key: sanitizeString(rawModel && rawModel.key, fallbackKey),
    provider: sanitizeString(rawModel && rawModel.provider, "local"),
    model: sanitizeString(rawModel && rawModel.model, "unknown"),
    endpoint: sanitizeString(rawModel && rawModel.endpoint, ""),
    capabilities: sanitizeStringArray(rawModel && rawModel.capabilities),
    contextLength: sanitizeString(rawModel && rawModel.contextLength, ""),
  };
}

function normalizeDiscoveredModels(rawModels) {
  if (!Array.isArray(rawModels)) {
    return [];
  }
  const seen = new Set();
  const result = [];
  rawModels.forEach((entry, index) => {
    const item = sanitizeDiscoveredModel(entry, index);
    if (seen.has(item.key)) {
      return;
    }
    seen.add(item.key);
    result.push(item);
  });
  return result;
}

class ProfileSuggestModal extends SuggestModal {
  constructor(app, profiles, onChoose) {
    super(app);
    this.profiles = profiles;
    this.onChoose = onChoose;
    this.setPlaceholder("Search Local Gate profile...");
  }

  getSuggestions(query) {
    const lowered = query.toLowerCase();
    return this.profiles.filter((profile) => {
      if (lowered.length === 0) {
        return true;
      }
      return (
        profile.name.toLowerCase().includes(lowered) ||
        profile.id.toLowerCase().includes(lowered) ||
        profile.provider.toLowerCase().includes(lowered)
      );
    });
  }

  renderSuggestion(profile, el) {
    const row = el.createDiv({ cls: "local-gate-suggest-row" });
    row.createEl("div", { text: profile.name, cls: "local-gate-suggest-title" });
    row.createEl("small", {
      text: `${providerLabel(profile.provider)} | ${profile.id} | capabilities: ${formatCapabilities(
        profile.capabilities
      )}`,
      cls: "local-gate-suggest-meta",
    });
  }

  onChooseSuggestion(profile) {
    this.onChoose(profile);
  }
}

class LocalGateSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("local-gate-settings");

    containerEl.createEl("h2", { text: "Local Gate" });
    containerEl.createEl("p", {
      text: "Discover local models, show capabilities, and publish them into Agent Client.",
      cls: "local-gate-subtitle",
    });

    const quickSection = containerEl.createDiv({ cls: "local-gate-section" });
    quickSection.createEl("h3", { text: "Quick Actions" });

    new Setting(quickSection)
      .setName("Profile switcher")
      .setDesc("Open interactive profile picker")
      .addButton((button) =>
        button.setButtonText("Open").setCta().onClick(() => {
          this.plugin.openProfileSwitcher();
        })
      );

    new Setting(quickSection)
      .setName("Apply last profile")
      .setDesc(`Current: ${this.plugin.settings.lastProfileId || "(none)"}`)
      .addButton((button) =>
        button.setButtonText("Apply").onClick(async () => {
          await this.plugin.applyLastProfile();
        })
      );

    new Setting(quickSection)
      .setName("Sync to Agent Client")
      .setDesc("Publish saved profiles as Agent Client custom agents")
      .addButton((button) =>
        button.setButtonText("Sync").setCta().onClick(async () => {
          await this.plugin.syncProfilesToAgentClientAgents();
        })
      );

    const scanSection = containerEl.createDiv({ cls: "local-gate-section" });
    scanSection.createEl("h3", { text: "Discovery" });
    scanSection.createEl("p", {
      text: this.plugin.settings.lastScanAt
        ? `Last scan: ${this.plugin.settings.lastScanAt}`
        : "No scan yet.",
      cls: "local-gate-meta",
    });
    if (this.plugin.settings.lastScanSummary) {
      scanSection.createEl("p", {
        text: this.plugin.settings.lastScanSummary,
        cls: "local-gate-meta",
      });
    }
    if (this.plugin.settings.lastScanErrors.length > 0) {
      scanSection.createEl("p", {
        text: `Errors: ${this.plugin.settings.lastScanErrors.join(" | ")}`,
        cls: "local-gate-error",
      });
    }

    new Setting(scanSection)
      .setName("Scan local models")
      .setDesc("Detect models from enabled providers")
      .addButton((button) =>
        button.setButtonText("Scan now").setCta().onClick(async () => {
          await this.plugin.scanAndStoreModels({ silent: false });
          this.display();
        })
      );

    new Setting(scanSection)
      .setName("Scan on startup")
      .setDesc("Refresh model list when Obsidian starts")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.scanOnStartup).onChange(async (value) => {
          this.plugin.settings.scanOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName("Enable Ollama scan")
      .setDesc("Use CLI first, HTTP fallback next")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableOllamaScan).onChange(async (value) => {
          this.plugin.settings.enableOllamaScan = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName("Enable LM Studio scan")
      .setDesc("Query OpenAI-compatible /models endpoint")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableLmStudioScan).onChange(async (value) => {
          this.plugin.settings.enableLmStudioScan = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName("Ollama command")
      .setDesc("Path or command for Ollama CLI")
      .addText((text) =>
        text
          .setPlaceholder("ollama")
          .setValue(this.plugin.settings.ollamaCommand)
          .onChange(async (value) => {
            this.plugin.settings.ollamaCommand = sanitizeString(value, "ollama");
            await this.plugin.saveSettings();
          })
      );

    new Setting(scanSection)
      .setName("Codex ACP command")
      .setDesc("Path or command for codex-acp")
      .addText((text) =>
        text
          .setPlaceholder("codex-acp")
          .setValue(this.plugin.settings.codexAcpCommand)
          .onChange(async (value) => {
            this.plugin.settings.codexAcpCommand = sanitizeString(value, "codex-acp");
            await this.plugin.saveSettings();
          })
      );

    new Setting(scanSection)
      .setName("Ollama base URL")
      .setDesc("Example: http://127.0.0.1:11434")
      .addText((text) =>
        text
          .setPlaceholder(OLLAMA_DEFAULT_BASE_URL)
          .setValue(this.plugin.settings.ollamaBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.ollamaBaseUrl = normalizeOllamaBaseUrl(value);
            await this.plugin.saveSettings();
          })
      );

    new Setting(scanSection)
      .setName("LM Studio base URL")
      .setDesc("Example: http://127.0.0.1:1234/v1")
      .addText((text) =>
        text
          .setPlaceholder(LMSTUDIO_DEFAULT_BASE_URL)
          .setValue(this.plugin.settings.lmStudioBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.lmStudioBaseUrl = normalizeLmStudioBaseUrl(value);
            await this.plugin.saveSettings();
          })
      );

    new Setting(scanSection)
      .setName("Auto-create profiles from discovered models")
      .setDesc("Save newly discovered models into Saved Profiles")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoCreateProfilesFromDiscovery).onChange(async (value) => {
          this.plugin.settings.autoCreateProfilesFromDiscovery = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName("Publish profiles to Agent Client")
      .setDesc("Show local models in Agent Client agent dropdown")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.publishProfilesToAgentClient).onChange(async (value) => {
          this.plugin.settings.publishProfilesToAgentClient = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName("Auto-sync after scan")
      .setDesc("Sync profiles into Agent Client right after scanning")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSyncToAgentClientAfterScan).onChange(async (value) => {
          this.plugin.settings.autoSyncToAgentClientAfterScan = value;
          await this.plugin.saveSettings();
        })
      );

    const discoveredSection = containerEl.createDiv({ cls: "local-gate-section" });
    discoveredSection.createEl("h3", { text: "Discovered Local Models" });
    if (this.plugin.settings.discoveredModels.length === 0) {
      discoveredSection.createEl("p", { text: "No models discovered yet.", cls: "local-gate-empty" });
    } else {
      this.plugin.settings.discoveredModels.forEach((model) => {
        const row = new Setting(discoveredSection)
          .setName(`${providerLabel(model.provider)}: ${model.model}`)
          .setDesc(
            `${model.endpoint} | capabilities: ${formatCapabilities(model.capabilities)}${
              model.contextLength ? ` | context: ${model.contextLength}` : ""
            }`
          )
          .addButton((button) =>
            button.setButtonText("Add profile").onClick(async () => {
              await this.plugin.addDiscoveredModelAsProfile(model);
              this.display();
            })
          )
          .addButton((button) =>
            button.setButtonText("Apply").setCta().onClick(async () => {
              await this.plugin.applyDiscoveredModel(model);
            })
          );
        row.settingEl.addClass("local-gate-model-row");
      });
    }

    const profileSection = containerEl.createDiv({ cls: "local-gate-section" });
    profileSection.createEl("h3", { text: "Saved Profiles" });
    this.plugin.settings.profiles.forEach((profile) => {
      const row = new Setting(profileSection)
        .setName(profile.name)
        .setDesc(
          `${providerLabel(profile.provider)} | ${profile.id} | capabilities: ${formatCapabilities(
            profile.capabilities
          )}`
        )
        .addButton((button) =>
          button.setButtonText("Apply").onClick(async () => {
            await this.plugin.applyProfile(profile);
          })
        )
        .addButton((button) =>
          button.setButtonText("Delete").onClick(async () => {
            await this.plugin.deleteProfile(profile.id);
            this.display();
          })
        );
      row.settingEl.addClass("local-gate-profile-row");
    });

    const integrationSection = containerEl.createDiv({ cls: "local-gate-section" });
    integrationSection.createEl("h3", { text: "Integration" });

    new Setting(integrationSection)
      .setName("Agent Client settings path")
      .setDesc("Vault-relative path to Agent Client data.json")
      .addText((text) =>
        text
          .setPlaceholder(".obsidian/plugins/agent-client/data.json")
          .setValue(this.plugin.settings.agentClientSettingsPath)
          .onChange(async (value) => {
            this.plugin.settings.agentClientSettingsPath = sanitizeString(
              value,
              ".obsidian/plugins/agent-client/data.json"
            );
            await this.plugin.saveSettings();
          })
      );

    let profileJsonDraft = JSON.stringify(this.plugin.settings.profiles, null, 2);
    const advancedSection = containerEl.createDiv({ cls: "local-gate-section" });
    advancedSection.createEl("h3", { text: "Advanced Profile JSON" });
    new Setting(advancedSection)
      .setName("Profiles JSON")
      .setDesc("Manual edit. Fields: id, name, provider, endpoint, capabilities, command, args, env, setAsDefaultAgent")
      .addTextArea((textArea) => {
        textArea.setValue(profileJsonDraft);
        textArea.inputEl.rows = 14;
        textArea.inputEl.cols = 80;
        textArea.onChange((value) => {
          profileJsonDraft = value;
        });
      });

    new Setting(advancedSection)
      .setName("Save / Reset")
      .setDesc("Validate and persist profile JSON")
      .addButton((button) =>
        button.setButtonText("Save").setCta().onClick(async () => {
          try {
            const parsed = JSON.parse(profileJsonDraft);
            this.plugin.settings.profiles = normalizeProfiles(parsed);
            if (!this.plugin.settings.profiles.find((item) => item.id === this.plugin.settings.lastProfileId)) {
              this.plugin.settings.lastProfileId = this.plugin.settings.profiles[0]?.id || "";
            }
            await this.plugin.saveSettings();
            new Notice("Local Gate: profiles saved.");
            this.display();
          } catch (error) {
            new Notice(`Local Gate: invalid JSON (${error.message}).`);
          }
        })
      )
      .addButton((button) =>
        button.setButtonText("Reset defaults").onClick(async () => {
          this.plugin.settings.profiles = defaultProfiles();
          this.plugin.settings.lastProfileId = this.plugin.settings.profiles[0].id;
          await this.plugin.saveSettings();
          new Notice("Local Gate: defaults restored.");
          this.display();
        })
      );
  }
}

class LocalGatePlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    await this.ensureBuiltinAgentsHealthy();

    this.addCommand({
      id: "local-gate-switch-profile",
      name: "Local Gate: Switch Local AI Profile",
      callback: () => this.openProfileSwitcher(),
    });

    this.addCommand({
      id: "local-gate-apply-last-profile",
      name: "Local Gate: Apply Last Profile",
      callback: async () => {
        await this.applyLastProfile();
      },
    });

    this.addCommand({
      id: "local-gate-scan-local-models",
      name: "Local Gate: Scan Local Models",
      callback: async () => {
        await this.scanAndStoreModels({ silent: false });
      },
    });

    this.addCommand({
      id: "local-gate-sync-agent-client-models",
      name: "Local Gate: Sync Models to Agent Client",
      callback: async () => {
        await this.syncProfilesToAgentClientAgents();
      },
    });

    this.addSettingTab(new LocalGateSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.publishProfilesToAgentClient) {
        await this.syncProfilesToAgentClientAgents(true);
      }
      if (this.settings.scanOnStartup) {
        await this.scanAndStoreModels({ silent: true });
      }
    });
  }

  async loadSettings() {
    const defaults = defaultSettings();
    const loaded = (await this.loadData()) || {};
    const profiles = normalizeProfiles(loaded.profiles);
    const discovered = normalizeDiscoveredModels(loaded.discoveredModels);

    this.settings = {
      agentClientSettingsPath: sanitizeString(loaded.agentClientSettingsPath, defaults.agentClientSettingsPath),
      codexAcpCommand: sanitizeString(
        loaded.codexAcpCommand,
        sanitizeString(profiles[0]?.command, defaults.codexAcpCommand)
      ),
      ollamaCommand: sanitizeString(loaded.ollamaCommand, defaults.ollamaCommand),
      profiles,
      lastProfileId: sanitizeString(loaded.lastProfileId, profiles[0]?.id || defaults.lastProfileId),
      discoveredModels: discovered,
      scanOnStartup: typeof loaded.scanOnStartup === "boolean" ? loaded.scanOnStartup : defaults.scanOnStartup,
      enableOllamaScan:
        typeof loaded.enableOllamaScan === "boolean" ? loaded.enableOllamaScan : defaults.enableOllamaScan,
      enableLmStudioScan:
        typeof loaded.enableLmStudioScan === "boolean"
          ? loaded.enableLmStudioScan
          : defaults.enableLmStudioScan,
      ollamaBaseUrl: normalizeOllamaBaseUrl(loaded.ollamaBaseUrl || defaults.ollamaBaseUrl),
      lmStudioBaseUrl: normalizeLmStudioBaseUrl(loaded.lmStudioBaseUrl || defaults.lmStudioBaseUrl),
      publishProfilesToAgentClient:
        typeof loaded.publishProfilesToAgentClient === "boolean"
          ? loaded.publishProfilesToAgentClient
          : defaults.publishProfilesToAgentClient,
      autoCreateProfilesFromDiscovery:
        typeof loaded.autoCreateProfilesFromDiscovery === "boolean"
          ? loaded.autoCreateProfilesFromDiscovery
          : defaults.autoCreateProfilesFromDiscovery,
      autoSyncToAgentClientAfterScan:
        typeof loaded.autoSyncToAgentClientAfterScan === "boolean"
          ? loaded.autoSyncToAgentClientAfterScan
          : defaults.autoSyncToAgentClientAfterScan,
      lastScanAt: sanitizeString(loaded.lastScanAt, ""),
      lastScanSummary: sanitizeString(loaded.lastScanSummary, ""),
      lastScanErrors: sanitizeStringArray(loaded.lastScanErrors),
    };

    this.settings.profiles = this.settings.profiles
      .map((profile) => {
        const migrated = { ...profile };
        if (migrated.provider === "local") {
          if (String(migrated.name || "").toLowerCase().includes("lm studio")) {
            migrated.provider = "lmstudio";
          } else {
            migrated.provider = "ollama";
          }
        }
        if (!sanitizeString(migrated.endpoint, "")) {
          migrated.endpoint =
            migrated.provider === "lmstudio"
              ? toOpenAiEndpoint("lmstudio", this.settings.lmStudioBaseUrl)
              : toOpenAiEndpoint("ollama", this.settings.ollamaBaseUrl);
        }
        migrated.command = sanitizeString(migrated.command, this.settings.codexAcpCommand || "codex-acp");
        migrated.capabilities = inferModelCapabilities(
          migrated.provider,
          migrated.name,
          sanitizeStringArray(migrated.capabilities)
        );
        return sanitizeProfile(migrated, 0);
      })
      .filter((profile) => !(profile.id === "lmstudio-default" || profile.id === "lmstudio-local-model"));

    if (this.settings.profiles.length === 0) {
      this.settings.profiles = defaultProfiles();
    }
    if (!this.settings.profiles.find((profile) => profile.id === this.settings.lastProfileId)) {
      this.settings.lastProfileId = this.settings.profiles[0].id;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  openProfileSwitcher() {
    if (!Array.isArray(this.settings.profiles) || this.settings.profiles.length === 0) {
      new Notice("Local Gate: no saved profile.");
      return;
    }
    new ProfileSuggestModal(this.app, this.settings.profiles, async (profile) => {
      await this.applyProfile(profile);
    }).open();
  }

  getProfileById(profileId) {
    return this.settings.profiles.find((entry) => entry.id === profileId) || null;
  }

  async applyLastProfile() {
    const profile = this.getProfileById(this.settings.lastProfileId);
    if (!profile) {
      new Notice("Local Gate: last profile not found.");
      return;
    }
    await this.applyProfile(profile);
  }

  async resolveCodexCommand(preferred) {
    const command = sanitizeString(preferred, this.settings.codexAcpCommand || "codex-acp");
    const resolved = await resolveExecutable(command, [
      `${process.env.HOME || ""}/.local/bin/codex-acp`,
      "/opt/homebrew/bin/codex-acp",
      "/usr/local/bin/codex-acp",
    ]);
    return sanitizeString(resolved, command);
  }

  async resolveNodeCommand() {
    const resolved = await resolveExecutable("node", [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ]);
    return sanitizeString(resolved, "node");
  }

  async buildCodexAcpLaunchSpec(preferredCommand) {
    const codexCommand = await this.resolveCodexCommand(preferredCommand);
    let codexRealPath = codexCommand;
    try {
      codexRealPath = fs.realpathSync(codexCommand);
    } catch (_error) {
    }

    const nodeCommand = await this.resolveNodeCommand();
    if (pathExists(codexRealPath) && codexRealPath.endsWith(".js") && pathExists(nodeCommand)) {
      return {
        command: nodeCommand,
        argsPrefix: [codexRealPath],
        nodePath: nodeCommand,
        codexPath: codexRealPath,
      };
    }

    return {
      command: codexCommand,
      argsPrefix: [],
      nodePath: pathExists(nodeCommand) ? nodeCommand : "",
      codexPath: codexCommand,
    };
  }

  toLocalGateAgentId(profile) {
    return `local-gate-${slugify(profile.id) || slugify(profile.name)}`;
  }

  isLocalOverrideArgs(args) {
    return sanitizeStringArray(args).some((arg) =>
      arg.includes("model_provider=\"local\"") || arg.includes("model_providers.local")
    );
  }

  async ensureBuiltinAgentsHealthy() {
    const path = normalizePath(this.settings.agentClientSettingsPath);
    const data = await this.readOrCreateAgentClientSettings(path);
    const launch = await this.buildCodexAcpLaunchSpec(this.settings.codexAcpCommand || "codex-acp");
    const codex = data.codex || {};
    const wasLocalOverride = this.isLocalOverrideArgs(codex.args);

    let changed = false;
    const nextCodex = {
      id: sanitizeString(codex.id, "codex-acp"),
      displayName: sanitizeString(codex.displayName, "Codex"),
      apiKey: sanitizeString(codex.apiKey, ""),
      command: launch.command,
      args: [...launch.argsPrefix],
      env: sanitizeStringArray(codex.env),
    };

    if (JSON.stringify(nextCodex) !== JSON.stringify(codex)) {
      data.codex = nextCodex;
      changed = true;
    }

    if (launch.nodePath && sanitizeString(data.nodePath, "") !== launch.nodePath) {
      data.nodePath = launch.nodePath;
      changed = true;
    }

    if (changed) {
      await this.app.vault.adapter.write(path, `${JSON.stringify(data, null, 2)}\n`);
      if (wasLocalOverride) {
        new Notice("Local Gate: restored built-in Codex to default (cloud) mode.");
      }
    }

    this.settings.codexAcpCommand = launch.codexPath;
    await this.saveSettings();
  }

  async applyProfile(profile) {
    const normalized = sanitizeProfile(profile, 0);
    const saved = this.upsertProfile(normalized);
    this.settings.lastProfileId = saved.id;
    await this.saveSettings();

    const preferredAgentId = this.toLocalGateAgentId(saved);
    if (this.settings.publishProfilesToAgentClient) {
      await this.syncProfilesToAgentClientAgents(true, preferredAgentId);
    } else {
      const path = normalizePath(this.settings.agentClientSettingsPath);
      const data = await this.readOrCreateAgentClientSettings(path);
      data.defaultAgentId = preferredAgentId;
      await this.app.vault.adapter.write(path, `${JSON.stringify(data, null, 2)}\n`);
    }

    new Notice(`Local Gate: applied "${saved.name}" as active local agent.`);
  }

  async deleteProfile(profileId) {
    const originalCount = this.settings.profiles.length;
    this.settings.profiles = this.settings.profiles.filter((profile) => profile.id !== profileId);
    if (this.settings.profiles.length === originalCount) {
      new Notice("Local Gate: profile not found.");
      return;
    }
    if (this.settings.profiles.length === 0) {
      this.settings.profiles = defaultProfiles();
    }
    if (!this.settings.profiles.find((profile) => profile.id === this.settings.lastProfileId)) {
      this.settings.lastProfileId = this.settings.profiles[0].id;
    }
    await this.saveSettings();
    new Notice("Local Gate: profile deleted.");
    if (this.settings.publishProfilesToAgentClient) {
      await this.syncProfilesToAgentClientAgents(true);
    }
  }

  createProfileFromDiscovered(model) {
    const provider = sanitizeString(model.provider, "local");
    const endpoint =
      provider === "ollama"
        ? toOpenAiEndpoint("ollama", this.settings.ollamaBaseUrl)
        : provider === "lmstudio"
        ? toOpenAiEndpoint("lmstudio", this.settings.lmStudioBaseUrl)
        : sanitizeString(model.endpoint, "");
    const modelName = sanitizeString(model.model, "unknown");
    const idBase = `${provider}-${slugify(modelName) || "model"}`;

    return {
      id: idBase,
      name: `${providerLabel(provider)}: ${modelName}`,
      provider,
      endpoint,
      capabilities: inferModelCapabilities(provider, modelName, sanitizeStringArray(model.capabilities)),
      command: this.settings.codexAcpCommand || "codex-acp",
      args: buildLocalCodexArgs(modelName, endpoint),
      env: [],
      setAsDefaultAgent: true,
    };
  }

  getUniqueProfileId(baseId) {
    const current = new Set(this.settings.profiles.map((profile) => profile.id));
    if (!current.has(baseId)) {
      return baseId;
    }
    let suffix = 2;
    while (current.has(`${baseId}-${suffix}`)) {
      suffix += 1;
    }
    return `${baseId}-${suffix}`;
  }

  upsertProfile(profile) {
    const existingIndex = this.settings.profiles.findIndex(
      (item) => item.provider === profile.provider && item.name === profile.name
    );
    if (existingIndex >= 0) {
      this.settings.profiles[existingIndex] = sanitizeProfile(
        {
          ...this.settings.profiles[existingIndex],
          ...profile,
        },
        existingIndex
      );
      return this.settings.profiles[existingIndex];
    }

    const normalized = sanitizeProfile(profile, this.settings.profiles.length);
    normalized.id = this.getUniqueProfileId(normalized.id);
    this.settings.profiles.push(normalized);
    return normalized;
  }

  async addDiscoveredModelAsProfile(model) {
    const created = this.createProfileFromDiscovered(model);
    const saved = this.upsertProfile(created);
    this.settings.lastProfileId = saved.id;
    await this.saveSettings();
    new Notice(`Local Gate: profile saved (${saved.name}).`);
    if (this.settings.publishProfilesToAgentClient) {
      await this.syncProfilesToAgentClientAgents(true);
    }
  }

  async applyDiscoveredModel(model) {
    const profile = this.createProfileFromDiscovered(model);
    await this.applyProfile(profile);
  }

  async scanAndStoreModels(options = { silent: false }) {
    const silent = options && options.silent === true;
    if (!silent) {
      new Notice("Local Gate: scanning...");
    }

    const found = [];
    const errors = [];

    if (!this.settings.enableOllamaScan && !this.settings.enableLmStudioScan) {
      this.settings.lastScanErrors = ["Both provider scans are disabled."];
      this.settings.lastScanSummary = "No provider enabled.";
      this.settings.lastScanAt = new Date().toLocaleString();
      await this.saveSettings();
      if (!silent) {
        new Notice("Local Gate: enable at least one provider scan.");
      }
      return;
    }

    if (this.settings.enableOllamaScan) {
      try {
        const ollama = await this.scanOllamaModels();
        found.push(...ollama);
      } catch (error) {
        errors.push(`Ollama: ${error.message}`);
      }
    }

    if (this.settings.enableLmStudioScan) {
      try {
        const lm = await this.scanLmStudioModels();
        found.push(...lm);
      } catch (error) {
        errors.push(`LM Studio: ${error.message}`);
      }
    }

    this.settings.discoveredModels = normalizeDiscoveredModels(found).map((model) => ({
      ...model,
      capabilities: inferModelCapabilities(model.provider, model.model, model.capabilities),
    }));
    this.settings.lastScanErrors = errors;
    this.settings.lastScanAt = new Date().toLocaleString();
    this.settings.lastScanSummary = `Discovered ${this.settings.discoveredModels.length} model(s).`;

    if (this.settings.autoCreateProfilesFromDiscovery) {
      this.settings.discoveredModels.forEach((model) => {
        const profile = this.createProfileFromDiscovered(model);
        this.upsertProfile(profile);
      });
    }

    const hasLmStudioModel = this.settings.discoveredModels.some((model) => model.provider === "lmstudio");
    const lmStudioErrored = errors.some((entry) => entry.startsWith("LM Studio:"));
    if (!hasLmStudioModel && lmStudioErrored) {
      this.settings.profiles = this.settings.profiles.filter((profile) => {
        if (profile.provider !== "lmstudio") {
          return true;
        }
        const lowered = `${profile.id} ${profile.name}`.toLowerCase();
        return !lowered.includes("default");
      });
    }

    await this.saveSettings();

    if (this.settings.publishProfilesToAgentClient && this.settings.autoSyncToAgentClientAfterScan) {
      await this.syncProfilesToAgentClientAgents(true);
    }

    if (!silent) {
      if (this.settings.discoveredModels.length > 0) {
        new Notice(
          `Local Gate: found ${this.settings.discoveredModels.length} model(s).` +
            (errors.length > 0 ? ` Errors: ${errors.join(" | ")}` : "")
        );
      } else {
        new Notice(`Local Gate: no model found.${errors.length > 0 ? ` ${errors.join(" | ")}` : ""}`);
      }
    }
  }

  async scanOllamaModels() {
    const models = [];
    const endpoint = toOpenAiEndpoint("ollama", this.settings.ollamaBaseUrl);
    const apiBase = normalizeOllamaBaseUrl(this.settings.ollamaBaseUrl);

    let cliWorked = false;
    const resolvedOllama = await resolveExecutable(this.settings.ollamaCommand || "ollama", [
      "/opt/homebrew/bin/ollama",
      "/usr/local/bin/ollama",
    ]);

    try {
      const listOutput = await runCommand(resolvedOllama, ["list"], 8000);
      const lines = listOutput
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      const entries = lines.slice(1).map((line) => line.split(/\s+/)[0]).filter(Boolean);
      const names = [...new Set(entries)];

      for (const name of names) {
        let capabilities = [];
        let contextLength = "";
        try {
          const showOutput = await runCommand(resolvedOllama, ["show", name], 6000);
          const parsed = parseOllamaShow(showOutput);
          capabilities = parsed.capabilities;
          contextLength = parsed.contextLength;
        } catch (_error) {
        }

        models.push({
          key: `ollama:${name}`,
          provider: "ollama",
          model: name,
          endpoint,
          capabilities: inferModelCapabilities("ollama", name, capabilities),
          contextLength,
        });
      }
      cliWorked = models.length > 0;
    } catch (_error) {
    }

    if (cliWorked) {
      return models;
    }

    const tagsResponse = await requestUrl({
      url: `${apiBase}/api/tags`,
      method: "GET",
      throw: false,
    });

    if (tagsResponse.status >= 400) {
      throw new Error(`Could not scan via CLI or HTTP (${tagsResponse.status})`);
    }

    const payload = tagsResponse.json;
    const list = Array.isArray(payload && payload.models) ? payload.models : [];
    const out = [];
    for (const entry of list) {
      const modelName = sanitizeString(entry && (entry.model || entry.name), "");
      if (!modelName) {
        continue;
      }

      let capabilities = [];
      let contextLength = "";
      try {
        const showResponse = await requestUrl({
          url: `${apiBase}/api/show`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: modelName }),
          throw: false,
        });
        if (showResponse.status < 400) {
          const showJson = showResponse.json || {};
          if (Array.isArray(showJson.capabilities)) {
            capabilities = sanitizeStringArray(showJson.capabilities);
          }
          if (showJson.details && showJson.details.context_length != null) {
            contextLength = String(showJson.details.context_length);
          }
        }
      } catch (_error) {
      }

      out.push({
        key: `ollama:${modelName}`,
        provider: "ollama",
        model: modelName,
        endpoint,
        capabilities: inferModelCapabilities("ollama", modelName, capabilities),
        contextLength,
      });
    }

    return out;
  }

  async scanLmStudioModels() {
    const base = normalizeLmStudioBaseUrl(this.settings.lmStudioBaseUrl);
    const attempts = [`${base}/models`, `${ensureNoTrailingSlash(base.replace(/\/v1$/, ""))}/v1/models`];
    let lastError = "";

    for (const url of attempts) {
      try {
        const response = await requestUrl({
          url,
          method: "GET",
          throw: false,
        });
        if (response.status >= 400) {
          lastError = `HTTP ${response.status} at ${url}`;
          continue;
        }
        const payload = response.json;
        const models = Array.isArray(payload && payload.data) ? payload.data : [];
        return models
          .map((entry) => sanitizeString(entry && entry.id, ""))
          .filter(Boolean)
          .map((modelId) => ({
            key: `lmstudio:${modelId}`,
            provider: "lmstudio",
            model: modelId,
            endpoint: base,
            capabilities: ["completion"],
            contextLength: "",
          }));
      } catch (error) {
        lastError = error.message;
      }
    }

    throw new Error(lastError || "LM Studio endpoint not reachable");
  }

  async syncProfilesToAgentClientAgents(silent = false, preferredDefaultAgentId = "") {
    const path = normalizePath(this.settings.agentClientSettingsPath);
    const data = await this.readOrCreateAgentClientSettings(path);
    const customAgents = Array.isArray(data.customAgents) ? data.customAgents : [];
    const kept = customAgents.filter((agent) => !String(agent && agent.id || "").startsWith("local-gate-"));

    const launch = await this.buildCodexAcpLaunchSpec(this.settings.codexAcpCommand || "codex-acp");
    const generated = this.settings.profiles.map((profile) => {
      const baseEnv = sanitizeStringArray(profile.env);
      if (!baseEnv.some((entry) => entry.startsWith("PATH="))) {
        baseEnv.unshift(`PATH=${buildExecPathEnv()}`);
      }
      return {
        id: this.toLocalGateAgentId(profile),
        displayName: `[Local] ${profile.name}`,
        command: launch.command,
        args: [...launch.argsPrefix, ...sanitizeStringArray(profile.args)],
        env: baseEnv,
      };
    });

    data.customAgents = [...kept, ...generated];
    if (preferredDefaultAgentId && generated.some((agent) => agent.id === preferredDefaultAgentId)) {
      data.defaultAgentId = preferredDefaultAgentId;
    }
    if (launch.nodePath) {
      data.nodePath = launch.nodePath;
    }
    await this.app.vault.adapter.write(path, `${JSON.stringify(data, null, 2)}\n`);

    if (!silent) {
      new Notice(`Local Gate: synced ${generated.length} model agent(s) to Agent Client.`);
    }
  }

  async readOrCreateAgentClientSettings(path) {
    await this.ensureParentFolder(path);
    if (!(await this.app.vault.adapter.exists(path))) {
      return {
        codex: {
          id: "codex-acp",
          displayName: "Codex",
          apiKey: "",
          command: "codex-acp",
          args: [],
          env: [],
        },
        customAgents: [],
        defaultAgentId: "codex-acp",
      };
    }

    try {
      const raw = await this.app.vault.adapter.read(path);
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        if (!Array.isArray(parsed.customAgents)) {
          parsed.customAgents = [];
        }
        return parsed;
      }
    } catch (_error) {
    }

    return {
      codex: {
        id: "codex-acp",
        displayName: "Codex",
        apiKey: "",
        command: "codex-acp",
        args: [],
        env: [],
      },
      customAgents: [],
      defaultAgentId: "codex-acp",
    };
  }

  async ensureParentFolder(filePath) {
    const parts = filePath.split("/");
    if (parts.length < 2) {
      return;
    }
    const folder = parts.slice(0, -1).join("/");
    if (!folder) {
      return;
    }
    if (!(await this.app.vault.adapter.exists(folder))) {
      await this.app.vault.adapter.mkdir(folder);
    }
  }
}

module.exports = LocalGatePlugin;
