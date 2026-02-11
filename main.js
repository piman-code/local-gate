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

const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";
const LMSTUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";

const DEFAULT_PROFILES = [
  {
    id: "ollama-gpt-oss-20b",
    name: "Ollama: gpt-oss:20b",
    provider: "ollama",
    endpoint: OLLAMA_DEFAULT_BASE_URL,
    capabilities: ["completion", "tools", "thinking"],
    command: "codex-acp",
    args: buildLocalCodexArgs("gpt-oss:20b", OLLAMA_DEFAULT_BASE_URL),
    env: [],
    setAsDefaultAgent: true,
  },
  {
    id: "ollama-qwen2-5-coder-14b",
    name: "Ollama: qwen2.5-coder:14b",
    provider: "ollama",
    endpoint: OLLAMA_DEFAULT_BASE_URL,
    capabilities: ["completion", "tools"],
    command: "codex-acp",
    args: buildLocalCodexArgs("qwen2.5-coder:14b", OLLAMA_DEFAULT_BASE_URL),
    env: [],
    setAsDefaultAgent: true,
  },
  {
    id: "lmstudio-local-model",
    name: "LM Studio: local-model",
    provider: "lmstudio",
    endpoint: LMSTUDIO_DEFAULT_BASE_URL,
    capabilities: ["completion"],
    command: "codex-acp",
    args: buildLocalCodexArgs("local-model", LMSTUDIO_DEFAULT_BASE_URL),
    env: [],
    setAsDefaultAgent: true,
  },
];

const DEFAULT_SETTINGS = {
  agentClientSettingsPath: ".obsidian/plugins/agent-client/data.json",
  codexAcpCommand: "codex-acp",
  profiles: DEFAULT_PROFILES,
  lastProfileId: "ollama-gpt-oss-20b",
  discoveredModels: [],
  scanOnStartup: true,
  enableOllamaScan: true,
  enableLmStudioScan: true,
  ollamaBaseUrl: OLLAMA_DEFAULT_BASE_URL,
  lmStudioBaseUrl: LMSTUDIO_DEFAULT_BASE_URL,
  lastScanAt: "",
};

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
  return value.filter((entry) => typeof entry === "string");
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

function buildLocalCodexArgs(model, baseUrl) {
  return [
    "-c",
    "model_provider=\"local\"",
    "-c",
    `model=${toTomlQuoted(model)}`,
    "-c",
    "model_providers.local.name=\"local\"",
    "-c",
    `model_providers.local.base_url=${toTomlQuoted(baseUrl)}`,
  ];
}

function formatCapabilities(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    return "unknown";
  }
  return capabilities.join(", ");
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

function parseOllamaShow(showOutput) {
  const lines = showOutput.split(/\r?\n/);
  const capabilities = [];
  let contextLength = "";
  let currentSection = "";

  lines.forEach((line) => {
    if (/^\s{2}[A-Za-z][A-Za-z ]+$/.test(line)) {
      currentSection = line.trim().toLowerCase();
      return;
    }

    if (!/^\s{4}\S/.test(line)) {
      return;
    }

    const content = line.trim();

    if (currentSection === "capabilities") {
      capabilities.push(content);
      return;
    }

    if (currentSection === "model" && content.startsWith("context length")) {
      const parts = content.split(/\s+/);
      contextLength = parts[parts.length - 1] || "";
    }
  });

  return { capabilities, contextLength };
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
  const source = Array.isArray(rawProfiles) && rawProfiles.length > 0 ? rawProfiles : DEFAULT_PROFILES;
  const seenIds = new Set();
  const result = [];

  source.forEach((rawProfile, index) => {
    const sanitized = sanitizeProfile(rawProfile, index);
    if (seenIds.has(sanitized.id)) {
      return;
    }
    seenIds.add(sanitized.id);
    result.push(sanitized);
  });

  return result.length > 0 ? result : clone(DEFAULT_PROFILES);
}

function sanitizeDiscoveredModel(rawModel, index) {
  const fallbackKey = `model-${index + 1}`;
  const key = sanitizeString(rawModel && rawModel.key, fallbackKey);
  const provider = sanitizeString(rawModel && rawModel.provider, "local");
  const model = sanitizeString(rawModel && rawModel.model, "unknown");
  const endpoint = sanitizeString(rawModel && rawModel.endpoint, "");
  const capabilities = sanitizeStringArray(rawModel && rawModel.capabilities);
  const contextLength = sanitizeString(rawModel && rawModel.contextLength, "");

  return {
    key,
    provider,
    model,
    endpoint,
    capabilities,
    contextLength,
  };
}

function normalizeDiscoveredModels(rawModels) {
  if (!Array.isArray(rawModels)) {
    return [];
  }
  const seen = new Set();
  const result = [];
  rawModels.forEach((rawModel, index) => {
    const item = sanitizeDiscoveredModel(rawModel, index);
    if (seen.has(item.key)) {
      return;
    }
    seen.add(item.key);
    result.push(item);
  });
  return result;
}

function runCommand(command, args, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
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
        profile.provider.toLowerCase().includes(lowered) ||
        profile.command.toLowerCase().includes(lowered)
      );
    });
  }

  renderSuggestion(profile, el) {
    const row = el.createDiv({ cls: "local-gate-suggest-row" });
    row.createEl("div", { text: profile.name, cls: "local-gate-suggest-title" });
    row.createEl("small", {
      text: `${providerLabel(profile.provider)} | ${profile.id} | ${formatCapabilities(profile.capabilities)}`,
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
      text: "Detect local AI models, show capabilities, and apply one click to Agent Client Codex settings.",
      cls: "local-gate-subtitle",
    });

    const quickActionsSection = containerEl.createDiv({ cls: "local-gate-section" });
    quickActionsSection.createEl("h3", { text: "Quick Actions" });

    new Setting(quickActionsSection)
      .setName("Profile switcher")
      .setDesc("Open interactive picker")
      .addButton((button) =>
        button.setButtonText("Open").setCta().onClick(() => {
          this.plugin.openProfileSwitcher();
        })
      );

    new Setting(quickActionsSection)
      .setName("Apply last profile")
      .setDesc(`Current: ${this.plugin.settings.lastProfileId || "(none)"}`)
      .addButton((button) =>
        button.setButtonText("Apply").onClick(async () => {
          await this.plugin.applyLastProfile();
        })
      );

    const scanSection = containerEl.createDiv({ cls: "local-gate-section" });
    scanSection.createEl("h3", { text: "Discovery" });
    scanSection.createEl("p", {
      text: this.plugin.settings.lastScanAt
        ? `Last scan: ${this.plugin.settings.lastScanAt}`
        : "No scan yet. Click Scan now.",
      cls: "local-gate-meta",
    });

    new Setting(scanSection)
      .setName("Scan local models")
      .setDesc("Detect models from configured local providers")
      .addButton((button) =>
        button.setButtonText("Scan now").setCta().onClick(async () => {
          await this.plugin.scanAndStoreModels({ silent: false });
          this.display();
        })
      );

    new Setting(scanSection)
      .setName("Scan on startup")
      .setDesc("Automatically refresh model list when Obsidian starts")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.scanOnStartup).onChange(async (value) => {
          this.plugin.settings.scanOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName("Enable Ollama scan")
      .setDesc("Use `ollama list` and `ollama show`")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableOllamaScan).onChange(async (value) => {
          this.plugin.settings.enableOllamaScan = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName("Enable LM Studio scan")
      .setDesc("Use OpenAI-compatible endpoint /v1/models")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableLmStudioScan).onChange(async (value) => {
          this.plugin.settings.enableLmStudioScan = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName("Ollama base URL")
      .setDesc("Example: http://localhost:11434/v1")
      .addText((text) =>
        text
          .setPlaceholder(OLLAMA_DEFAULT_BASE_URL)
          .setValue(this.plugin.settings.ollamaBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.ollamaBaseUrl = sanitizeString(value, OLLAMA_DEFAULT_BASE_URL);
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
            this.plugin.settings.lmStudioBaseUrl = sanitizeString(value, LMSTUDIO_DEFAULT_BASE_URL);
            await this.plugin.saveSettings();
          })
      );

    new Setting(scanSection)
      .setName("Codex ACP command")
      .setDesc("Path or command used for applied profiles")
      .addText((text) =>
        text
          .setPlaceholder("codex-acp")
          .setValue(this.plugin.settings.codexAcpCommand)
          .onChange(async (value) => {
            this.plugin.settings.codexAcpCommand = sanitizeString(value, "codex-acp");
            await this.plugin.saveSettings();
          })
      );

    const discoveredSection = containerEl.createDiv({ cls: "local-gate-section" });
    discoveredSection.createEl("h3", { text: "Discovered Local Models" });

    if (this.plugin.settings.discoveredModels.length === 0) {
      discoveredSection.createEl("p", {
        text: "No discovered models yet.",
        cls: "local-gate-empty",
      });
    } else {
      this.plugin.settings.discoveredModels.forEach((model) => {
        const setting = new Setting(discoveredSection)
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
            button.setButtonText("Apply now").setCta().onClick(async () => {
              await this.plugin.applyDiscoveredModel(model);
            })
          );
        setting.settingEl.addClass("local-gate-model-row");
      });
    }

    const profileSection = containerEl.createDiv({ cls: "local-gate-section" });
    profileSection.createEl("h3", { text: "Saved Profiles" });

    this.plugin.settings.profiles.forEach((profile) => {
      const setting = new Setting(profileSection)
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
        );
      setting.settingEl.addClass("local-gate-profile-row");
    });

    let profileJsonDraft = JSON.stringify(this.plugin.settings.profiles, null, 2);

    const jsonSection = containerEl.createDiv({ cls: "local-gate-section" });
    jsonSection.createEl("h3", { text: "Advanced Profile JSON" });

    new Setting(jsonSection)
      .setName("Profiles JSON")
      .setDesc("Fields: id, name, provider, endpoint, capabilities, command, args, env, setAsDefaultAgent")
      .addTextArea((textArea) => {
        textArea.setValue(profileJsonDraft);
        textArea.inputEl.rows = 16;
        textArea.inputEl.cols = 80;
        textArea.onChange((value) => {
          profileJsonDraft = value;
        });
      });

    new Setting(jsonSection)
      .setName("Save profile JSON")
      .setDesc("Validate and save")
      .addButton((button) =>
        button.setButtonText("Save").setCta().onClick(async () => {
          try {
            const parsed = JSON.parse(profileJsonDraft);
            const normalizedProfiles = normalizeProfiles(parsed);
            this.plugin.settings.profiles = normalizedProfiles;
            if (!normalizedProfiles.find((profile) => profile.id === this.plugin.settings.lastProfileId)) {
              this.plugin.settings.lastProfileId = normalizedProfiles[0].id;
            }
            await this.plugin.saveSettings();
            new Notice("Local Gate: profiles saved.");
            this.display();
          } catch (error) {
            new Notice(`Local Gate: invalid profile JSON (${error.message})`);
          }
        })
      )
      .addButton((button) =>
        button.setButtonText("Reset defaults").onClick(async () => {
          this.plugin.settings.profiles = clone(DEFAULT_PROFILES);
          this.plugin.settings.lastProfileId = this.plugin.settings.profiles[0].id;
          await this.plugin.saveSettings();
          new Notice("Local Gate: default profiles restored.");
          this.display();
        })
      );

    const integrationSection = containerEl.createDiv({ cls: "local-gate-section" });
    integrationSection.createEl("h3", { text: "Integration" });

    new Setting(integrationSection)
      .setName("Agent Client settings path")
      .setDesc("Vault-relative path to Agent Client data.json")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.agentClientSettingsPath)
          .setValue(this.plugin.settings.agentClientSettingsPath)
          .onChange(async (value) => {
            this.plugin.settings.agentClientSettingsPath = sanitizeString(
              value,
              DEFAULT_SETTINGS.agentClientSettingsPath
            );
            await this.plugin.saveSettings();
          })
      );
  }
}

class LocalGatePlugin extends Plugin {
  async onload() {
    await this.loadSettings();

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

    this.addSettingTab(new LocalGateSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.scanOnStartup && this.settings.discoveredModels.length === 0) {
        await this.scanAndStoreModels({ silent: true });
      }
    });
  }

  async loadSettings() {
    const loaded = (await this.loadData()) || {};
    const normalizedProfiles = normalizeProfiles(loaded.profiles);
    const normalizedDiscovered = normalizeDiscoveredModels(loaded.discoveredModels);

    this.settings = {
      agentClientSettingsPath: sanitizeString(
        loaded.agentClientSettingsPath,
        DEFAULT_SETTINGS.agentClientSettingsPath
      ),
      codexAcpCommand: sanitizeString(
        loaded.codexAcpCommand,
        normalizedProfiles[0] ? normalizedProfiles[0].command : DEFAULT_SETTINGS.codexAcpCommand
      ),
      profiles: normalizedProfiles,
      lastProfileId: sanitizeString(
        loaded.lastProfileId,
        normalizedProfiles[0] ? normalizedProfiles[0].id : DEFAULT_SETTINGS.lastProfileId
      ),
      discoveredModels: normalizedDiscovered,
      scanOnStartup: typeof loaded.scanOnStartup === "boolean" ? loaded.scanOnStartup : DEFAULT_SETTINGS.scanOnStartup,
      enableOllamaScan:
        typeof loaded.enableOllamaScan === "boolean" ? loaded.enableOllamaScan : DEFAULT_SETTINGS.enableOllamaScan,
      enableLmStudioScan:
        typeof loaded.enableLmStudioScan === "boolean"
          ? loaded.enableLmStudioScan
          : DEFAULT_SETTINGS.enableLmStudioScan,
      ollamaBaseUrl: sanitizeString(loaded.ollamaBaseUrl, DEFAULT_SETTINGS.ollamaBaseUrl),
      lmStudioBaseUrl: sanitizeString(loaded.lmStudioBaseUrl, DEFAULT_SETTINGS.lmStudioBaseUrl),
      lastScanAt: sanitizeString(loaded.lastScanAt, ""),
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  openProfileSwitcher() {
    const profiles = this.settings.profiles;
    if (profiles.length === 0) {
      new Notice("Local Gate: no profiles configured.");
      return;
    }

    new ProfileSuggestModal(this.app, profiles, async (profile) => {
      await this.applyProfile(profile);
    }).open();
  }

  async applyLastProfile() {
    const lastId = this.settings.lastProfileId;
    const profile = this.settings.profiles.find((entry) => entry.id === lastId);
    if (!profile) {
      new Notice("Local Gate: last profile not found.");
      return;
    }
    await this.applyProfile(profile);
  }

  getCodexCommandFallback() {
    const configured = sanitizeString(this.settings.codexAcpCommand, "");
    if (configured.length > 0) {
      return configured;
    }
    const fromProfile = this.settings.profiles.find((profile) => sanitizeString(profile.command, "").length > 0);
    if (fromProfile) {
      return fromProfile.command;
    }
    return "codex-acp";
  }

  createProfileFromDiscovered(model) {
    const endpoint = sanitizeString(
      model.endpoint,
      model.provider === "lmstudio" ? this.settings.lmStudioBaseUrl : this.settings.ollamaBaseUrl
    );
    const idBase = `${model.provider}-${slugify(model.model) || "model"}`;
    return {
      id: idBase,
      name: `${providerLabel(model.provider)}: ${model.model}`,
      provider: model.provider,
      endpoint,
      capabilities: sanitizeStringArray(model.capabilities),
      command: this.getCodexCommandFallback(),
      args: buildLocalCodexArgs(model.model, endpoint),
      env: [],
      setAsDefaultAgent: true,
    };
  }

  makeUniqueProfileId(baseId) {
    const seen = new Set(this.settings.profiles.map((profile) => profile.id));
    if (!seen.has(baseId)) {
      return baseId;
    }
    let index = 2;
    while (seen.has(`${baseId}-${index}`)) {
      index += 1;
    }
    return `${baseId}-${index}`;
  }

  async addDiscoveredModelAsProfile(model) {
    const template = this.createProfileFromDiscovered(model);
    const existing = this.settings.profiles.find(
      (profile) => profile.provider === model.provider && profile.name === template.name
    );

    if (existing) {
      existing.endpoint = template.endpoint;
      existing.capabilities = template.capabilities;
      existing.command = template.command;
      existing.args = template.args;
      existing.env = template.env;
      existing.setAsDefaultAgent = template.setAsDefaultAgent;
      this.settings.lastProfileId = existing.id;
      await this.saveSettings();
      new Notice(`Local Gate: updated profile "${existing.name}".`);
      return;
    }

    template.id = this.makeUniqueProfileId(template.id);
    this.settings.profiles.push(template);
    this.settings.lastProfileId = template.id;
    await this.saveSettings();
    new Notice(`Local Gate: added profile "${template.name}".`);
  }

  async applyDiscoveredModel(model) {
    const profile = this.createProfileFromDiscovered(model);
    await this.applyProfile(profile);
  }

  async applyProfile(profile) {
    const path = normalizePath(this.settings.agentClientSettingsPath);
    const agentSettings = await this.readOrCreateAgentClientSettings(path);

    const existingCodex = agentSettings.codex || {};
    agentSettings.codex = {
      id: sanitizeString(existingCodex.id, "codex-acp"),
      displayName: sanitizeString(existingCodex.displayName, "Codex"),
      apiKey: sanitizeString(existingCodex.apiKey, ""),
      command: sanitizeString(profile.command, this.getCodexCommandFallback()),
      args: sanitizeStringArray(profile.args),
      env: sanitizeStringArray(profile.env),
    };

    if (profile.setAsDefaultAgent !== false) {
      agentSettings.defaultAgentId = agentSettings.codex.id || "codex-acp";
    }

    await this.app.vault.adapter.write(path, `${JSON.stringify(agentSettings, null, 2)}\n`);
    this.settings.lastProfileId = profile.id;
    this.settings.codexAcpCommand = sanitizeString(profile.command, this.settings.codexAcpCommand);
    await this.saveSettings();
    new Notice(`Local Gate: applied "${profile.name}".`);
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
        defaultAgentId: "codex-acp",
      };
    }

    try {
      const raw = await this.app.vault.adapter.read(path);
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed;
      }
    } catch (error) {
      new Notice(`Local Gate: invalid Agent Client JSON, creating a safe replacement (${error.message}).`);
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
      defaultAgentId: "codex-acp",
    };
  }

  async ensureParentFolder(filePath) {
    const parts = filePath.split("/");
    if (parts.length < 2) {
      return;
    }
    const folderPath = parts.slice(0, -1).join("/");
    if (folderPath.length === 0) {
      return;
    }
    if (!(await this.app.vault.adapter.exists(folderPath))) {
      await this.app.vault.adapter.mkdir(folderPath);
    }
  }

  async scanAndStoreModels(options = { silent: false }) {
    const silent = options.silent === true;
    if (!silent) {
      new Notice("Local Gate: scanning local models...");
    }

    const found = [];
    const errors = [];

    if (this.settings.enableOllamaScan) {
      try {
        const ollamaModels = await this.scanOllamaModels();
        found.push(...ollamaModels);
      } catch (error) {
        errors.push(`Ollama: ${error.message}`);
      }
    }

    if (this.settings.enableLmStudioScan) {
      try {
        const lmStudioModels = await this.scanLmStudioModels();
        found.push(...lmStudioModels);
      } catch (error) {
        errors.push(`LM Studio: ${error.message}`);
      }
    }

    this.settings.discoveredModels = normalizeDiscoveredModels(found);
    this.settings.lastScanAt = new Date().toLocaleString();
    await this.saveSettings();

    if (!silent) {
      if (this.settings.discoveredModels.length > 0) {
        new Notice(
          `Local Gate: found ${this.settings.discoveredModels.length} model(s).` +
            (errors.length > 0 ? ` Partial errors: ${errors.join(" | ")}` : "")
        );
      } else {
        new Notice(`Local Gate: no models found.${errors.length > 0 ? ` ${errors.join(" | ")}` : ""}`);
      }
    }
  }

  async scanOllamaModels() {
    const listOutput = await runCommand("ollama", ["list"], 6000);
    const lines = listOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length <= 1) {
      return [];
    }

    const modelNames = lines
      .slice(1)
      .map((line) => line.split(/\s+/)[0])
      .filter((modelName) => modelName && modelName.toLowerCase() !== "name");

    const uniqueModels = [...new Set(modelNames)];
    const discovered = [];

    for (const modelName of uniqueModels) {
      let capabilities = [];
      let contextLength = "";

      try {
        const showOutput = await runCommand("ollama", ["show", modelName], 6000);
        const parsed = parseOllamaShow(showOutput);
        capabilities = parsed.capabilities;
        contextLength = parsed.contextLength;
      } catch (_error) {
        capabilities = [];
      }

      discovered.push({
        key: `ollama:${modelName}`,
        provider: "ollama",
        model: modelName,
        endpoint: this.settings.ollamaBaseUrl,
        capabilities,
        contextLength,
      });
    }

    return discovered;
  }

  async scanLmStudioModels() {
    const base = sanitizeString(this.settings.lmStudioBaseUrl, LMSTUDIO_DEFAULT_BASE_URL).replace(/\/+$/, "");
    const response = await requestUrl({
      url: `${base}/models`,
      method: "GET",
      throw: false,
    });

    if (response.status >= 400) {
      throw new Error(`HTTP ${response.status} from ${base}/models`);
    }

    const payload = response.json;
    const models = Array.isArray(payload && payload.data) ? payload.data : [];
    return models
      .map((entry) => sanitizeString(entry && entry.id, ""))
      .filter((modelId) => modelId.length > 0)
      .map((modelId) => ({
        key: `lmstudio:${modelId}`,
        provider: "lmstudio",
        model: modelId,
        endpoint: this.settings.lmStudioBaseUrl,
        capabilities: ["completion"],
        contextLength: "",
      }));
  }
}

module.exports = LocalGatePlugin;
