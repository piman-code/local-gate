"use strict";

const {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  Modal,
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

function unquoteValue(value) {
  const text = sanitizeString(value, "");
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function parseModelFromArgs(args) {
  const list = sanitizeStringArray(args);
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index];
    if (token === "-m" || token === "--model") {
      return sanitizeString(list[index + 1], "");
    }
    if (token.startsWith("model=")) {
      return unquoteValue(token.slice("model=".length));
    }
  }
  return "";
}

function deriveModelName(rawProfile) {
  const explicit = sanitizeString(rawProfile && rawProfile.model, "");
  if (explicit.length > 0) {
    return explicit;
  }

  const fromArgs = parseModelFromArgs(rawProfile && rawProfile.args);
  if (fromArgs.length > 0) {
    return fromArgs;
  }

  const name = sanitizeString(rawProfile && rawProfile.name, "");
  const match = name.match(/:\s*(.+)$/);
  if (match && match[1]) {
    return sanitizeString(match[1], "");
  }
  return "";
}

function buildProviderCodexArgs(provider, endpoint, model) {
  const normalizedProvider = sanitizeString(provider, "");
  const normalizedEndpoint = sanitizeString(endpoint, "");
  const providerName = normalizedProvider === "lmstudio" ? "LM Studio" : "Ollama";
  const args = [
    "-c",
    "features.remote_models=false",
    "-c",
    `model_provider=${toTomlQuoted(normalizedProvider)}`,
    "-c",
    `model_provider_ids=[${toTomlQuoted(normalizedProvider)}]`,
  ];
  if (normalizedEndpoint.length > 0) {
    args.push("-c", `model_providers.${normalizedProvider}.base_url=${toTomlQuoted(normalizedEndpoint)}`);
  }
  args.push("-c", `model_providers.${normalizedProvider}.name=${toTomlQuoted(providerName)}`);
  args.push("-c", `model_providers.${normalizedProvider}.wire_api="responses"`);
  const normalizedModel = sanitizeString(model, "");
  if (normalizedModel.length > 0) {
    args.push("-c", `model=${toTomlQuoted(normalizedModel)}`);
  }
  return args;
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

function providerAgentDisplayName(provider) {
  return `Local ${providerLabel(provider)}`;
}

function formatCapabilities(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    return "unknown";
  }
  return capabilities.join(", ");
}

function capabilityBadges(modelName, capabilities) {
  const caps = normalizeCapabilities(capabilities);
  const model = sanitizeString(modelName, "").toLowerCase();
  const badges = [];

  if (caps.includes("completion")) {
    badges.push("💬");
  }
  if (caps.includes("tools")) {
    badges.push("🛠");
  }
  if (caps.includes("vision")) {
    badges.push("👁");
  }
  if (caps.includes("thinking")) {
    badges.push("🧠");
  }
  if (caps.includes("embedding")) {
    badges.push("📎");
  }
  if (model.includes("coder") || model.includes("code")) {
    badges.push("</>");
  }

  return badges.join(" ");
}

function formatCompatibilityStatus(item) {
  if (item && item.compatible) {
    return "ready";
  }
  return `blocked (${sanitizeString(item && item.compatibilityReason, "incompatible")})`;
}

function normalizeCapabilities(capabilities) {
  return sanitizeStringArray(capabilities).map((item) => item.toLowerCase());
}

function evaluateModelCompatibility(provider, modelName, capabilities) {
  const caps = normalizeCapabilities(capabilities);
  const loweredName = String(modelName || "").toLowerCase();

  if (caps.includes("embedding") && !caps.includes("completion")) {
    return { compatible: false, reason: "embedding-only model (no chat)" };
  }
  if (provider === "ollama") {
    if (!caps.includes("completion")) {
      return { compatible: false, reason: "no completion capability" };
    }
    if (!caps.includes("tools")) {
      return { compatible: false, reason: "no tools capability (required by codex-acp)" };
    }
    return { compatible: true, reason: "ok" };
  }

  if (provider === "lmstudio") {
    if (loweredName.includes("embed")) {
      return { compatible: false, reason: "embedding model likely no chat" };
    }
    return { compatible: true, reason: "assumed compatible (OpenAI endpoint)" };
  }

  if (caps.includes("completion")) {
    return { compatible: true, reason: "completion available" };
  }
  return { compatible: false, reason: "unknown capabilities" };
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

    const headingMatch = trimmed.match(
      /^(model|capabilities|parameters|template|system|details|license)\s*:?\s*$/i
    );
    if (headingMatch) {
      section = headingMatch[1].toLowerCase();
      continue;
    }

    if (section === "capabilities") {
      capabilities.push(trimmed);
      continue;
    }

    if (section === "model" && /^context length\s*:?\s*/i.test(trimmed)) {
      const tail = trimmed.replace(/^context length\s*:?\s*/i, "").trim();
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
      model: "gpt-oss:20b",
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
      model: "qwen2.5-coder:14b",
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
    activeProfileByProvider: {},
    discoveredModels: [],
    scanOnStartup: true,
    enableOllamaScan: true,
    enableLmStudioScan: true,
    ollamaBaseUrl: OLLAMA_DEFAULT_BASE_URL,
    lmStudioBaseUrl: LMSTUDIO_DEFAULT_BASE_URL,
    publishProfilesToAgentClient: true,
    autoCreateProfilesFromDiscovery: true,
    autoSyncToAgentClientAfterScan: true,
    showBlockedDiscoveredModels: false,
    hiddenDiscoveredModelKeys: [],
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
  const model = sanitizeString(rawProfile && rawProfile.model, deriveModelName(rawProfile));
  const endpoint = sanitizeString(rawProfile && rawProfile.endpoint, "");
  const capabilities = sanitizeStringArray(rawProfile && rawProfile.capabilities);
  const command = sanitizeString(rawProfile && rawProfile.command, "codex-acp");
  const args = sanitizeStringArray(rawProfile && rawProfile.args);
  const env = sanitizeStringArray(rawProfile && rawProfile.env);
  const setAsDefaultAgent = rawProfile && rawProfile.setAsDefaultAgent !== false;
  const compat = evaluateModelCompatibility(provider, model || name, capabilities);

  return {
    id,
    name,
    provider,
    model,
    endpoint,
    capabilities,
    compatible: compat.compatible,
    compatibilityReason: compat.reason,
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
  const provider = sanitizeString(rawModel && rawModel.provider, "local");
  const model = sanitizeString(rawModel && rawModel.model, "unknown");
  const capabilities = sanitizeStringArray(rawModel && rawModel.capabilities);
  const compat = evaluateModelCompatibility(provider, model, capabilities);
  return {
    key: sanitizeString(rawModel && rawModel.key, fallbackKey),
    provider,
    model,
    endpoint: sanitizeString(rawModel && rawModel.endpoint, ""),
    capabilities,
    compatible: compat.compatible,
    compatibilityReason: compat.reason,
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
      text: `${providerLabel(profile.provider)} | model: ${sanitizeString(profile.model, "(auto)")} | ${profile.id} | capabilities: ${formatCapabilities(profile.capabilities)} | status: ${formatCompatibilityStatus(profile)}`,
      cls: "local-gate-suggest-meta",
    });
  }

  onChooseSuggestion(profile) {
    this.onChoose(profile);
  }
}

class LocalGateFolderSuggestModal extends SuggestModal {
  constructor(app, folders, onChoose) {
    super(app);
    this.folders = folders;
    this.onChoose = onChoose;
    this.setPlaceholder("Select folder for @mentions...");
  }

  getSuggestions(query) {
    const lowered = query.toLowerCase();
    return this.folders.filter((folder) => (lowered.length === 0 ? true : folder.toLowerCase().includes(lowered)));
  }

  renderSuggestion(folder, el) {
    el.createEl("div", { text: folder || "/" });
  }

  onChooseSuggestion(folder) {
    this.onChoose(folder);
  }
}

class LocalGateMultiMentionModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.activeTab = "folders";
    this.query = "";
    this.selectedFolders = new Set();
    this.selectedFiles = new Set();
    this.folders = plugin.getFolderListFromVault();
    this.files = plugin.getMarkdownFilePaths();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("local-gate-mention-modal");

    contentEl.createEl("h3", { text: "Multi @mentions" });

    const tabRow = contentEl.createDiv({ cls: "local-gate-mention-tabs" });
    this.folderTabButton = tabRow.createEl("button", { text: "Folders" });
    this.fileTabButton = tabRow.createEl("button", { text: "Files" });
    this.folderTabButton.onclick = () => {
      this.activeTab = "folders";
      this.render();
    };
    this.fileTabButton.onclick = () => {
      this.activeTab = "files";
      this.render();
    };

    const searchWrap = contentEl.createDiv({ cls: "local-gate-mention-search-wrap" });
    this.searchInput = searchWrap.createEl("input", {
      type: "text",
      placeholder: "Search folders/files...",
      cls: "local-gate-mention-search",
    });
    this.searchInput.oninput = () => {
      this.query = sanitizeString(this.searchInput.value, "").toLowerCase();
      this.renderList();
    };

    this.summaryEl = contentEl.createDiv({ cls: "local-gate-mention-summary" });
    this.listEl = contentEl.createDiv({ cls: "local-gate-mention-list" });

    const actionRow = contentEl.createDiv({ cls: "local-gate-mention-actions" });
    const clearButton = actionRow.createEl("button", { text: "Clear" });
    clearButton.onclick = () => {
      this.selectedFolders.clear();
      this.selectedFiles.clear();
      this.render();
    };

    const copyButton = actionRow.createEl("button", { text: "Copy @mentions", cls: "mod-cta" });
    copyButton.onclick = async () => {
      await this.copyMentions();
    };

    this.render();
    window.setTimeout(() => this.searchInput && this.searchInput.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }

  getFilteredItems() {
    const source = this.activeTab === "folders" ? this.folders : this.files;
    if (!this.query) {
      return source;
    }
    return source.filter((item) => item.toLowerCase().includes(this.query));
  }

  toggleSelection(item) {
    if (this.activeTab === "folders") {
      if (this.selectedFolders.has(item)) {
        this.selectedFolders.delete(item);
      } else {
        this.selectedFolders.add(item);
      }
      return;
    }

    if (this.selectedFiles.has(item)) {
      this.selectedFiles.delete(item);
    } else {
      this.selectedFiles.add(item);
    }
  }

  render() {
    this.folderTabButton.classList.toggle("local-gate-tab-active", this.activeTab === "folders");
    this.fileTabButton.classList.toggle("local-gate-tab-active", this.activeTab === "files");
    this.renderSummary();
    this.renderList();
  }

  renderSummary() {
    this.summaryEl.empty();
    this.summaryEl.setText(
      `Selected folders: ${this.selectedFolders.size} | files: ${this.selectedFiles.size} | ` +
        `tab: ${this.activeTab === "folders" ? "Folders" : "Files"}`
    );
  }

  renderList() {
    this.listEl.empty();
    const items = this.getFilteredItems();
    const maxRows = 200;
    const visible = items.slice(0, maxRows);

    if (visible.length === 0) {
      this.listEl.createEl("div", { text: "No matches.", cls: "local-gate-mention-empty" });
      return;
    }

    visible.forEach((item) => {
      const selected = this.activeTab === "folders" ? this.selectedFolders.has(item) : this.selectedFiles.has(item);
      const row = this.listEl.createDiv({ cls: "local-gate-mention-row" });
      row.addClass(selected ? "local-gate-mention-row-selected" : "local-gate-mention-row-normal");

      const check = row.createEl("input", { type: "checkbox" });
      check.checked = selected;
      check.onclick = (event) => {
        event.stopPropagation();
        this.toggleSelection(item);
        this.render();
      };

      const label = row.createEl("div", { cls: "local-gate-mention-row-label" });
      label.setText(item);

      row.onclick = () => {
        this.toggleSelection(item);
        this.render();
      };
    });

    if (items.length > maxRows) {
      this.listEl.createEl("div", {
        text: `Showing first ${maxRows} of ${items.length}. Refine search for more.`,
        cls: "local-gate-mention-hint",
      });
    }
  }

  async copyMentions() {
    const folders = Array.from(this.selectedFolders);
    const files = Array.from(this.selectedFiles);
    const built = this.plugin.buildMentionsFromSelections(folders, files);

    if (!built.mentions) {
      new Notice("Local Gate: no notes selected.");
      return;
    }

    try {
      const inserted = await this.plugin.copyMentionsAndTryInsertToChat(built.mentions);
      new Notice(
        `Local Gate: copied ${built.count} @mentions` +
          (inserted ? " and inserted into active chat." : ". Auto-insert unavailable, paste manually.") +
          (built.truncated ? ` (limited to ${built.count}/${built.total})` : "")
      );
      this.close();
    } catch (error) {
      new Notice(`Local Gate: failed to copy mentions (${error.message}).`);
    }
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
      .setName("Sync to Agent Client")
      .setDesc("Publish local provider agents (Ollama / LM Studio) to Agent Client")
      .addButton((button) =>
        button.setButtonText("Sync").setCta().onClick(async () => {
          await this.plugin.syncProfilesToAgentClientAgents();
        })
      );

    new Setting(quickSection)
      .setName("Folder @mentions")
      .setDesc("Copy many note references from one folder (RAG-style context)")
      .addButton((button) =>
        button.setButtonText("Copy").onClick(async () => {
          await this.plugin.copyFolderMentionsToClipboard();
        })
      );

    new Setting(quickSection)
      .setName("Multi @mentions")
      .setDesc("Select many folders/files and copy merged note references")
      .addButton((button) =>
        button.setButtonText("Open").onClick(async () => {
          await this.plugin.copyMultiMentionsToClipboard();
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
      .setDesc("Keep discovered model state for apply/sync")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoCreateProfilesFromDiscovery).onChange(async (value) => {
          this.plugin.settings.autoCreateProfilesFromDiscovery = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName("Publish profiles to Agent Client")
      .setDesc("Show local providers in agent dropdown and select models from chat model picker")
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

    new Setting(scanSection)
      .setName("Show blocked discovered models")
      .setDesc("Show non-applicable models in list (disabled/gray)")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showBlockedDiscoveredModels).onChange(async (value) => {
          this.plugin.settings.showBlockedDiscoveredModels = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    const discoveredSection = containerEl.createDiv({ cls: "local-gate-section" });
    discoveredSection.createEl("h3", { text: "Discovered Local Models" });
    const hiddenKeys = new Set(this.plugin.settings.hiddenDiscoveredModelKeys);
    const visibleModels = this.plugin.settings.discoveredModels.filter((model) => {
      if (hiddenKeys.has(model.key)) {
        return false;
      }
      if (!this.plugin.settings.showBlockedDiscoveredModels && !model.compatible) {
        return false;
      }
      return true;
    });
    const hiddenBlockedCount = this.plugin.settings.discoveredModels.filter(
      (model) => !model.compatible && !this.plugin.settings.showBlockedDiscoveredModels
    ).length;
    const hiddenManualCount = this.plugin.settings.hiddenDiscoveredModelKeys.length;
    if (hiddenBlockedCount > 0 || hiddenManualCount > 0) {
      discoveredSection.createEl("p", {
        text: `Hidden: blocked ${hiddenBlockedCount}, manual ${hiddenManualCount}`,
        cls: "local-gate-meta",
      });
    }

    if (visibleModels.length === 0) {
      discoveredSection.createEl("p", { text: "No models discovered yet.", cls: "local-gate-empty" });
    } else {
      visibleModels.forEach((model) => {
        const row = new Setting(discoveredSection)
          .setName(`${providerLabel(model.provider)}: ${model.model}${model.compatible ? "" : " (blocked)"}`)
          .setDesc(
            `${capabilityBadges(model.model, model.capabilities)} | ${model.endpoint} | capabilities: ${formatCapabilities(model.capabilities)}${
              model.contextLength ? ` | context: ${model.contextLength}` : ""
            } | status: ${formatCompatibilityStatus(model)}`
          )
          .addButton((button) =>
            button
              .setButtonText("Apply")
              .setCta()
              .setDisabled(!model.compatible)
              .onClick(async () => {
                await this.plugin.applyDiscoveredModel(model);
                this.display();
              })
          )
          .addButton((button) =>
            button.setButtonText("Hide").onClick(async () => {
              await this.plugin.hideDiscoveredModel(model.key);
              this.display();
            })
          );
        row.settingEl.addClass("local-gate-model-row");
        if (!model.compatible) {
          row.settingEl.addClass("local-gate-row-unsupported");
        }
      });
    }

    if (hiddenManualCount > 0) {
      new Setting(discoveredSection)
        .setName("Reset hidden models")
        .setDesc("Unhide all manually hidden discovered models")
        .addButton((button) =>
          button.setButtonText("Reset").onClick(async () => {
            await this.plugin.unhideAllDiscoveredModels();
            this.display();
          })
        );
    }

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

    this.addCommand({
      id: "local-gate-copy-folder-mentions",
      name: "Local Gate: Copy Folder @Mentions",
      callback: async () => {
        await this.copyFolderMentionsToClipboard();
      },
    });

    this.addCommand({
      id: "local-gate-copy-multi-mentions",
      name: "Local Gate: Copy Multi @Mentions (Folders/Files)",
      callback: async () => {
        await this.copyMultiMentionsToClipboard();
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
      this.patchAgentClientModelPicker();
    });

    this.registerInterval(
      window.setInterval(() => {
        this.patchAgentClientModelPicker();
      }, 3000)
    );
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
      activeProfileByProvider: {},
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
      showBlockedDiscoveredModels:
        typeof loaded.showBlockedDiscoveredModels === "boolean"
          ? loaded.showBlockedDiscoveredModels
          : defaults.showBlockedDiscoveredModels,
      hiddenDiscoveredModelKeys: sanitizeStringArray(loaded.hiddenDiscoveredModelKeys),
      lastScanAt: sanitizeString(loaded.lastScanAt, ""),
      lastScanSummary: sanitizeString(loaded.lastScanSummary, ""),
      lastScanErrors: sanitizeStringArray(loaded.lastScanErrors),
    };

    if (loaded.activeProfileByProvider && typeof loaded.activeProfileByProvider === "object") {
      Object.entries(loaded.activeProfileByProvider).forEach(([provider, profileId]) => {
        const safeProvider = sanitizeString(provider, "");
        const safeProfileId = sanitizeString(profileId, "");
        if (safeProvider.length > 0 && safeProfileId.length > 0) {
          this.settings.activeProfileByProvider[safeProvider] = safeProfileId;
        }
      });
    }

    this.settings.profiles = this.settings.profiles
      .map((profile, index) => {
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
        return sanitizeProfile(migrated, index);
      })
      .filter((profile) => !(profile.id === "lmstudio-default" || profile.id === "lmstudio-local-model"));

    if (this.settings.profiles.length === 0) {
      this.settings.profiles = defaultProfiles();
    }
    if (!this.settings.profiles.find((profile) => profile.id === this.settings.lastProfileId)) {
      this.settings.lastProfileId = this.settings.profiles[0].id;
    }

    Object.entries(this.settings.activeProfileByProvider).forEach(([provider, profileId]) => {
      const exists = this.settings.profiles.some((profile) => profile.provider === provider && profile.id === profileId);
      if (!exists) {
        delete this.settings.activeProfileByProvider[provider];
      }
    });

    const discoveredKeys = new Set(this.settings.discoveredModels.map((model) => model.key));
    this.settings.hiddenDiscoveredModelKeys = this.settings.hiddenDiscoveredModelKeys.filter((key) => discoveredKeys.has(key));
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  isDiscoveredModelHidden(modelKey) {
    return this.settings.hiddenDiscoveredModelKeys.includes(modelKey);
  }

  async hideDiscoveredModel(modelKey) {
    if (!this.settings.hiddenDiscoveredModelKeys.includes(modelKey)) {
      this.settings.hiddenDiscoveredModelKeys.push(modelKey);
      await this.saveSettings();
    }
  }

  async unhideAllDiscoveredModels() {
    this.settings.hiddenDiscoveredModelKeys = [];
    await this.saveSettings();
  }

  getFolderListFromVault() {
    const files = this.app.vault.getMarkdownFiles();
    const folders = new Set();
    files.forEach((file) => {
      const parentPath = sanitizeString((file.parent && file.parent.path) || "", "");
      if (parentPath.length > 0) {
        folders.add(parentPath);
      }
    });
    return Array.from(folders).sort((a, b) => a.localeCompare(b));
  }

  getMarkdownFilePaths() {
    return this.app.vault
      .getMarkdownFiles()
      .map((file) => sanitizeString(file.path, "").replace(/\\/g, "/"))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }

  normalizeMentionPath(filePath) {
    return sanitizeString(filePath, "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\.md$/i, "");
  }

  collectMentionFilePaths(folderPaths = [], filePaths = []) {
    const allFiles = this.getMarkdownFilePaths();
    const selected = new Set();
    const normalizedFolders = sanitizeStringArray(folderPaths)
      .map((folder) => folder.replace(/\\/g, "/").replace(/\/+$/, ""))
      .filter(Boolean);

    normalizedFolders.forEach((folder) => {
      const prefix = `${folder}/`;
      allFiles.forEach((filePath) => {
        if (filePath.startsWith(prefix)) {
          selected.add(filePath);
        }
      });
    });

    sanitizeStringArray(filePaths)
      .map((filePath) => filePath.replace(/\\/g, "/").replace(/^\/+/, ""))
      .forEach((filePath) => {
        if (allFiles.includes(filePath)) {
          selected.add(filePath);
        }
      });

    return Array.from(selected).sort((a, b) => a.localeCompare(b));
  }

  buildMentionsFromSelections(folderPaths = [], filePaths = []) {
    const files = this.collectMentionFilePaths(folderPaths, filePaths);
    const limit = 80;
    const selected = files.slice(0, limit);
    const mentions = selected
      .map((filePath) => {
        const normalized = this.normalizeMentionPath(filePath);
        if (!normalized) {
          return "";
        }
        const mention = `@${normalized}`;
        // Keep both formats together so either @ parser or auto-link path parser can pick it up.
        return `${mention} [[${normalized}]]`;
      })
      .filter(Boolean)
      .join(" ");
    return {
      mentions,
      count: selected.length,
      truncated: files.length > selected.length,
      total: files.length,
    };
  }

  buildMentionsFromFolder(folderPath) {
    return this.buildMentionsFromSelections([folderPath], []);
  }

  getAgentClientPlugin() {
    return this.app && this.app.plugins && this.app.plugins.plugins
      ? this.app.plugins.plugins["agent-client"] || null
      : null;
  }

  getActiveAgentClientChatView() {
    const agentClient = this.getAgentClientPlugin();
    if (!agentClient || typeof agentClient.getAllChatViews !== "function") {
      return null;
    }
    const views = agentClient.getAllChatViews();
    if (!Array.isArray(views) || views.length === 0) {
      return null;
    }

    const activeId = sanitizeString(String(agentClient.lastActiveChatViewId || ""), "");
    if (activeId.length > 0) {
      const active = views.find((view) => sanitizeString(String(view && view.viewId || ""), "") === activeId);
      if (active) {
        return active;
      }
    }

    const mostRecentLeaf =
      this.app && this.app.workspace && typeof this.app.workspace.getMostRecentLeaf === "function"
        ? this.app.workspace.getMostRecentLeaf()
        : null;
    if (mostRecentLeaf) {
      const fromLeaf = views.find((view) => view && view.leaf === mostRecentLeaf);
      if (fromLeaf) {
        return fromLeaf;
      }
    }

    if (typeof document !== "undefined" && document.activeElement) {
      const focused = views.find((view) => {
        const container = view && (view.containerEl || view.contentEl);
        return container && typeof container.contains === "function" && container.contains(document.activeElement);
      });
      if (focused) {
        return focused;
      }
    }

    return views[0];
  }

  findChatInputElement(view) {
    const roots = [view && view.containerEl, view && view.contentEl].filter(Boolean);
    for (const root of roots) {
      if (typeof root.querySelector === "function") {
        const input = root.querySelector("textarea, input[type='text'], [contenteditable='true']");
        if (input) {
          return input;
        }
      }
    }
    return null;
  }

  triggerChatInputRefresh(view, nextText) {
    const methods = [
      "handleInputChange",
      "onInputChange",
      "onPromptChange",
      "scheduleAutoLink",
      "processAutoLinks",
      "refreshMentions",
      "refreshModelList",
      "refreshModelOptions",
    ];
    methods.forEach((methodName) => {
      const fn = view && view[methodName];
      if (typeof fn !== "function") {
        return;
      }
      try {
        if (fn.length >= 1) {
          fn.call(view, nextText);
        } else {
          fn.call(view);
        }
      } catch (_error) {
      }
    });
  }

  appendTextViaDomInput(view, text) {
    const input = this.findChatInputElement(view);
    if (!input) {
      return false;
    }

    const currentValue =
      "value" in input ? sanitizeString(String(input.value || ""), "") : sanitizeString(input.textContent || "", "");
    const nextText = currentValue.length > 0 ? `${currentValue}\n${text}` : text;

    if ("value" in input) {
      input.value = nextText;
    } else {
      input.textContent = nextText;
    }

    try {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_error) {
    }
    this.triggerChatInputRefresh(view, nextText);
    return true;
  }

  async tryInsertMentionsToActiveChat(mentions) {
    const text = sanitizeString(mentions, "");
    if (text.length === 0) {
      return false;
    }

    const view = this.getActiveAgentClientChatView();
    if (!view) {
      return false;
    }

    const insertMethods = ["appendToInput", "appendInputText", "insertTextAtCursor", "insertText", "appendMessageText"];
    for (const methodName of insertMethods) {
      const fn = view[methodName];
      if (typeof fn !== "function") {
        continue;
      }
      try {
        const result = fn.length >= 1 ? await fn.call(view, text) : await fn.call(view);
        if (result !== false) {
          this.triggerChatInputRefresh(view, text);
          return true;
        }
      } catch (_error) {
      }
    }

    if (typeof view.getInputState === "function" && typeof view.setInputState === "function") {
      const current = view.getInputState() || {};
      const currentText = sanitizeString(current.text, "");
      const currentImages = Array.isArray(current.images) ? current.images : [];
      const nextText = currentText.length > 0 ? `${currentText}\n${text}` : text;
      view.setInputState({ text: nextText, images: currentImages });
      this.triggerChatInputRefresh(view, nextText);
      return true;
    }

    return this.appendTextViaDomInput(view, text);
  }

  async copyMentionsAndTryInsertToChat(mentions) {
    await navigator.clipboard.writeText(mentions);
    try {
      return await this.tryInsertMentionsToActiveChat(mentions);
    } catch (_error) {
      return false;
    }
  }

  async copyFolderMentionsToClipboard() {
    const folders = this.getFolderListFromVault();
    if (folders.length === 0) {
      new Notice("Local Gate: no folders with markdown files found.");
      return;
    }

    new LocalGateFolderSuggestModal(this.app, folders, async (folder) => {
      const built = this.buildMentionsFromFolder(folder);
      if (!built.mentions) {
        new Notice("Local Gate: no markdown notes found in selected folder.");
        return;
      }
      try {
        const inserted = await this.copyMentionsAndTryInsertToChat(built.mentions);
        new Notice(
          `Local Gate: copied ${built.count} @mentions from "${folder}"` +
            (inserted ? " and inserted into active chat." : ". Auto-insert unavailable, paste manually.") +
            (built.truncated ? ` (limited to ${built.count}/${built.total})` : "")
        );
      } catch (error) {
        new Notice(`Local Gate: failed to copy mentions (${error.message}).`);
      }
    }).open();
  }

  async copyMultiMentionsToClipboard() {
    const folders = this.getFolderListFromVault();
    const files = this.getMarkdownFilePaths();
    if (folders.length === 0 && files.length === 0) {
      new Notice("Local Gate: no markdown files found.");
      return;
    }
    new LocalGateMultiMentionModal(this.app, this).open();
  }

  openProfileSwitcher() {
    if (!Array.isArray(this.settings.profiles) || this.settings.profiles.length === 0) {
      new Notice("Local Gate: no saved profile.");
      return;
    }
    const compatibleProfiles = this.settings.profiles
      .map((profile, index) => sanitizeProfile(profile, index))
      .filter((profile) => profile.compatible);
    if (compatibleProfiles.length === 0) {
      new Notice("Local Gate: no compatible profile to apply.");
      return;
    }
    new ProfileSuggestModal(this.app, compatibleProfiles, async (profile) => {
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

  toProviderAgentId(provider) {
    return `local-gate-provider-${slugify(provider) || "local"}`;
  }

  getPreferredProfileForProvider(provider, compatibleProfiles, preferredProfileId = "") {
    const scoped = compatibleProfiles.filter((profile) => profile.provider === provider);
    if (scoped.length === 0) {
      return null;
    }

    const requestedId = sanitizeString(preferredProfileId, "");
    if (requestedId.length > 0) {
      const requested = scoped.find((profile) => profile.id === requestedId);
      if (requested) {
        return requested;
      }
    }

    const preferredId = sanitizeString(this.settings.activeProfileByProvider[provider], "");
    if (preferredId.length > 0) {
      const match = scoped.find((profile) => profile.id === preferredId);
      if (match) {
        return match;
      }
    }

    const last = scoped.find((profile) => profile.id === this.settings.lastProfileId);
    if (last) {
      return last;
    }

    return scoped[0];
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

    const customAgents = Array.isArray(data.customAgents) ? data.customAgents : [];
    const normalizedCustomAgents = customAgents.map((agent) => {
      const item = agent && typeof agent === "object" ? { ...agent } : {};
      const id = sanitizeString(item.id, "");
      if (id === this.toProviderAgentId("ollama")) {
        const nextDisplayName = providerAgentDisplayName("ollama");
        if (sanitizeString(item.displayName, "") !== nextDisplayName) {
          item.displayName = nextDisplayName;
          changed = true;
        }
        return item;
      }
      if (id === this.toProviderAgentId("lmstudio")) {
        const nextDisplayName = providerAgentDisplayName("lmstudio");
        if (sanitizeString(item.displayName, "") !== nextDisplayName) {
          item.displayName = nextDisplayName;
          changed = true;
        }
        return item;
      }
      return agent;
    });
    if (changed) {
      data.customAgents = normalizedCustomAgents;
    }

    if (changed) {
      await this.persistAgentClientSettings(path, data);
      if (wasLocalOverride) {
        new Notice("Local Gate: restored built-in Codex to default (cloud) mode.");
      }
    }

    this.settings.codexAcpCommand = launch.codexPath;
    await this.saveSettings();
  }

  async applyProfile(profile) {
    const normalized = sanitizeProfile(profile, 0);
    if (!normalized.compatible) {
      new Notice(`Local Gate: "${normalized.name}" blocked (${normalized.compatibilityReason}).`);
      return;
    }

    const saved = this.upsertProfile(normalized);
    this.settings.lastProfileId = saved.id;
    this.settings.activeProfileByProvider[saved.provider] = saved.id;
    await this.saveSettings();

    const preferredAgentId = this.toProviderAgentId(saved.provider);
    if (this.settings.publishProfilesToAgentClient) {
      await this.syncProfilesToAgentClientAgents(true, preferredAgentId, {
        [saved.provider]: saved.id,
      });
      await this.enforceProviderAgentModel(saved);
    } else {
      new Notice("Local Gate: enable 'Publish profiles to Agent Client' to apply local model.");
      return;
    }

    new Notice(
      `Local Gate: applied ${providerLabel(saved.provider)} default model -> ${sanitizeString(saved.model, saved.name)}.`
    );
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
    Object.entries(this.settings.activeProfileByProvider).forEach(([provider, savedId]) => {
      if (savedId === profileId) {
        const next = this.settings.profiles.find((profile) => profile.provider === provider && profile.compatible);
        if (next) {
          this.settings.activeProfileByProvider[provider] = next.id;
        } else {
          delete this.settings.activeProfileByProvider[provider];
        }
      }
    });
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
      model: modelName,
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
    this.settings.activeProfileByProvider[saved.provider] = saved.id;
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

    this.settings.discoveredModels = normalizeDiscoveredModels(found).map((model, index) =>
      sanitizeDiscoveredModel(
        {
          ...model,
          capabilities: inferModelCapabilities(model.provider, model.model, model.capabilities),
        },
        index
      )
    );
    const discoveredKeys = new Set(this.settings.discoveredModels.map((model) => model.key));
    this.settings.hiddenDiscoveredModelKeys = this.settings.hiddenDiscoveredModelKeys.filter((key) =>
      discoveredKeys.has(key)
    );
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

  getProviderEndpoint(provider, preferredProfile) {
    const fromProfile = sanitizeString(preferredProfile && preferredProfile.endpoint, "");
    if (fromProfile.length > 0) {
      return fromProfile;
    }
    if (provider === "lmstudio") {
      return toOpenAiEndpoint("lmstudio", this.settings.lmStudioBaseUrl);
    }
    if (provider === "ollama") {
      return toOpenAiEndpoint("ollama", this.settings.ollamaBaseUrl);
    }
    return "";
  }

  getLocalModelsForProvider(provider, preferredModel = "") {
    const normalizedProvider = sanitizeString(provider, "");
    const models = [];
    const seen = new Set();
    const addModel = (raw) => {
      const safe = sanitizeString(raw, "");
      if (!safe || seen.has(safe)) {
        return;
      }
      seen.add(safe);
      models.push(safe);
    };

    addModel(preferredModel);

    sanitizeStringArray(
      this.settings.discoveredModels
        .filter((entry) => entry && entry.provider === normalizedProvider && entry.compatible !== false)
        .map((entry) => entry.model)
    ).forEach(addModel);

    this.settings.profiles
      .map((entry, index) => sanitizeProfile(entry, index))
      .filter((entry) => entry.provider === normalizedProvider && entry.compatible)
      .map((entry) => sanitizeString(entry.model, deriveModelName(entry)))
      .forEach(addModel);

    return models.slice(0, 80);
  }

  buildAgentModelHintFields(provider, selectedModel) {
    const model = sanitizeString(selectedModel, "");
    const models = this.getLocalModelsForProvider(provider, model);
    if (model.length === 0 && models.length === 0) {
      return {};
    }
    const effectiveModel = model.length > 0 ? model : models[0];
    const effectiveModels = models.length > 0 ? models : [effectiveModel];
    return {
      model: effectiveModel,
      defaultModel: effectiveModel,
      preferredModel: effectiveModel,
      selectedModel: effectiveModel,
      models: effectiveModels,
      availableModels: effectiveModels,
      modelOptions: effectiveModels,
      availableModelIds: effectiveModels,
    };
  }

  normalizeModelOptionKey(rawModel) {
    return sanitizeString(rawModel, "")
      .replace(/\s+\((low|medium|high|xhigh)\)$/i, "")
      .trim();
  }

  extractModelKeyFromOption(option) {
    if (typeof option === "string") {
      return sanitizeString(option, "");
    }
    if (!option || typeof option !== "object") {
      return "";
    }

    const keys = ["id", "value", "model", "name", "label", "text", "title"];
    for (const key of keys) {
      const value = sanitizeString(option[key], "");
      if (value) {
        return value;
      }
    }

    if (option.model && typeof option.model === "object") {
      const nested = sanitizeString(option.model.id || option.model.name || option.model.value, "");
      if (nested) {
        return nested;
      }
    }

    return "";
  }

  optionMatchesAllowedModel(option, allowedModels) {
    const extracted = this.normalizeModelOptionKey(this.extractModelKeyFromOption(option));
    if (!extracted) {
      return false;
    }

    return allowedModels.some((model) => {
      const normalizedAllowed = this.normalizeModelOptionKey(model);
      if (!normalizedAllowed) {
        return false;
      }
      return (
        extracted === normalizedAllowed ||
        extracted.includes(normalizedAllowed) ||
        normalizedAllowed.includes(extracted)
      );
    });
  }

  buildModelOptionFromTemplate(template, model) {
    if (typeof template === "string" || !template || typeof template !== "object") {
      return model;
    }

    const next = { ...template };
    const textKeys = ["id", "value", "model", "name", "label", "text", "title"];
    textKeys.forEach((key) => {
      if (typeof next[key] === "string") {
        next[key] = model;
      }
    });
    if (next.model && typeof next.model === "object") {
      const modelObj = { ...next.model };
      if (typeof modelObj.id === "string") {
        modelObj.id = model;
      }
      if (typeof modelObj.name === "string") {
        modelObj.name = model;
      }
      if (typeof modelObj.value === "string") {
        modelObj.value = model;
      }
      next.model = modelObj;
    }
    return next;
  }

  filterModelOptionArray(options, allowedModels) {
    if (!Array.isArray(options)) {
      return options;
    }
    const allowed = sanitizeStringArray(allowedModels).map((item) => this.normalizeModelOptionKey(item)).filter(Boolean);
    if (allowed.length === 0) {
      return options;
    }

    const filtered = options.filter((option) => this.optionMatchesAllowedModel(option, allowed));
    if (filtered.length > 0) {
      return filtered;
    }

    const template = options.find((entry) => entry != null);
    return allowed.map((model) => this.buildModelOptionFromTemplate(template, model));
  }

  filterModelPayload(payload, allowedModels) {
    if (Array.isArray(payload)) {
      return this.filterModelOptionArray(payload, allowedModels);
    }
    if (!payload || typeof payload !== "object") {
      return payload;
    }

    const next = { ...payload };
    const arrayKeys = ["models", "availableModels", "modelOptions", "options", "items", "data", "list"];
    let touched = false;
    arrayKeys.forEach((key) => {
      if (Array.isArray(next[key])) {
        next[key] = this.filterModelOptionArray(next[key], allowedModels);
        touched = true;
      }
    });

    const allowed = sanitizeStringArray(allowedModels).map((item) => this.normalizeModelOptionKey(item)).filter(Boolean);
    const preferred = allowed[0] || "";
    if (preferred) {
      const selectedKeys = ["model", "selectedModel", "modelId", "selectedModelId", "currentModel", "currentModelId"];
      selectedKeys.forEach((key) => {
        if (typeof next[key] === "string") {
          const current = this.normalizeModelOptionKey(next[key]);
          if (!allowed.some((item) => current === item || current.includes(item) || item.includes(current))) {
            next[key] = preferred;
            touched = true;
          }
        }
      });
    }

    return touched ? next : payload;
  }

  detectProviderFromAgentId(agentId) {
    const id = sanitizeString(agentId, "").toLowerCase();
    if (id.includes("ollama")) {
      return "ollama";
    }
    if (id.includes("lmstudio")) {
      return "lmstudio";
    }
    return "";
  }

  detectProviderFromDisplayName(displayName) {
    const lowered = sanitizeString(displayName, "").toLowerCase();
    if (lowered.includes("ollama")) {
      return "ollama";
    }
    if (lowered.includes("lm studio") || lowered.includes("lmstudio")) {
      return "lmstudio";
    }
    return "";
  }

  detectProviderFromModelName(modelName) {
    const model = sanitizeString(modelName, "");
    if (!model) {
      return "";
    }

    const discovered = this.settings.discoveredModels.find((entry) => sanitizeString(entry.model, "") === model);
    if (discovered) {
      return sanitizeString(discovered.provider, "");
    }

    const profile = this.settings.profiles
      .map((entry, index) => sanitizeProfile(entry, index))
      .find((entry) => sanitizeString(entry.model, deriveModelName(entry)) === model);
    if (profile) {
      return sanitizeString(profile.provider, "");
    }

    if (model.includes(":")) {
      return "ollama";
    }
    return "";
  }

  getCurrentModelFromView(view) {
    if (!view) {
      return "";
    }

    const methodNames = ["getSelectedModel", "getCurrentModel", "getModel", "getModelId"];
    for (const methodName of methodNames) {
      const fn = view[methodName];
      if (typeof fn !== "function") {
        continue;
      }
      try {
        const result = fn.call(view);
        if (typeof result === "string") {
          return sanitizeString(result, "");
        }
        if (result && typeof result === "object") {
          const nested = sanitizeString(result.id || result.model || result.name || result.value, "");
          if (nested) {
            return nested;
          }
        }
      } catch (_error) {
      }
    }

    const directKeys = ["selectedModel", "currentModel", "model", "selectedModelId", "currentModelId", "modelId"];
    for (const key of directKeys) {
      const raw = view[key];
      if (typeof raw === "string") {
        const value = sanitizeString(raw, "");
        if (value) {
          return value;
        }
      } else if (raw && typeof raw === "object") {
        const nested = sanitizeString(raw.id || raw.model || raw.name || raw.value, "");
        if (nested) {
          return nested;
        }
      }
    }

    if (typeof view.getInputState === "function") {
      try {
        const state = view.getInputState() || {};
        const fromState = sanitizeString(state.model || state.modelId, "");
        if (fromState) {
          return fromState;
        }
      } catch (_error) {
      }
    }

    return "";
  }

  getCurrentAgentFromView(view) {
    if (!view) {
      return null;
    }

    const methodNames = ["getSelectedAgent", "getCurrentAgent", "getAgent", "getActiveAgent"];
    for (const methodName of methodNames) {
      const fn = view[methodName];
      if (typeof fn !== "function") {
        continue;
      }
      try {
        const result = fn.call(view);
        if (result && typeof result === "object") {
          return result;
        }
      } catch (_error) {
      }
    }

    const directKeys = ["selectedAgent", "currentAgent", "agent", "activeAgent"];
    for (const key of directKeys) {
      const value = view[key];
      if (value && typeof value === "object") {
        return value;
      }
    }

    return null;
  }

  resolveProviderForView(view) {
    const currentAgent = this.getCurrentAgentFromView(view);
    const directAgentIdKeys = ["selectedAgentId", "currentAgentId", "agentId", "activeAgentId"];
    for (const key of directAgentIdKeys) {
      const provider = this.detectProviderFromAgentId(sanitizeString(view && view[key], ""));
      if (provider) {
        return provider;
      }
    }

    if (currentAgent) {
      const fromId = this.detectProviderFromAgentId(sanitizeString(currentAgent.id || currentAgent.agentId, ""));
      if (fromId) {
        return fromId;
      }
      const fromName = this.detectProviderFromDisplayName(
        sanitizeString(currentAgent.displayName || currentAgent.name || currentAgent.label, "")
      );
      if (fromName) {
        return fromName;
      }
    }

    const currentModel = this.getCurrentModelFromView(view);
    return this.detectProviderFromModelName(currentModel);
  }

  isLocalGateContext(view) {
    const provider = this.resolveProviderForView(view);
    if (provider) {
      return true;
    }
    const currentModel = this.getCurrentModelFromView(view);
    const modelProvider = this.detectProviderFromModelName(currentModel);
    return modelProvider.length > 0;
  }

  filterModelResultForLocalContext(view, result) {
    if (!this.isLocalGateContext(view)) {
      return result;
    }

    const currentModel = this.getCurrentModelFromView(view);
    const provider = this.resolveProviderForView(view) || this.detectProviderFromModelName(currentModel);
    const allowed = this.getLocalModelsForProvider(provider || "ollama", currentModel);
    if (allowed.length === 0) {
      return result;
    }

    if (result && typeof result.then === "function") {
      return result
        .then((resolved) => this.filterModelPayload(resolved, allowed))
        .catch(() => result);
    }
    return this.filterModelPayload(result, allowed);
  }

  patchModelMethodOnTarget(target, methodName, viewRef = null) {
    if (!target || typeof target[methodName] !== "function") {
      return false;
    }

    const original = target[methodName];
    if (original.__localGateModelPatched === true) {
      return false;
    }

    const plugin = this;
    const wrapped = function(...args) {
      const result = original.apply(this, args);
      const currentView = viewRef || this;
      return plugin.filterModelResultForLocalContext(currentView, result);
    };
    wrapped.__localGateModelPatched = true;
    wrapped.__localGateOriginal = original;
    target[methodName] = wrapped;
    return true;
  }

  patchAgentClientModelPicker(plugin = this.getAgentClientPlugin()) {
    if (!plugin) {
      return false;
    }

    let patched = false;
    const methodCandidates = [
      "getAvailableModels",
      "getModelOptions",
      "buildModelOptions",
      "resolveModelOptions",
      "listModels",
      "getModels",
      "computeModelOptions",
    ];

    methodCandidates.forEach((methodName) => {
      if (this.patchModelMethodOnTarget(plugin, methodName, this.getActiveAgentClientChatView())) {
        patched = true;
      }
    });

    const views = typeof plugin.getAllChatViews === "function" ? plugin.getAllChatViews() : [];
    if (Array.isArray(views)) {
      views.forEach((view) => {
        methodCandidates.forEach((methodName) => {
          if (this.patchModelMethodOnTarget(view, methodName, view)) {
            patched = true;
          }
        });
      });
    }

    return patched;
  }

  async enforceProviderAgentModel(profile) {
    const normalized = sanitizeProfile(profile, 0);
    const provider = sanitizeString(normalized.provider, "");
    const model = sanitizeString(normalized.model, deriveModelName(normalized));
    if (!provider || !model) {
      return;
    }

    const path = normalizePath(this.settings.agentClientSettingsPath);
    const data = await this.readOrCreateAgentClientSettings(path);
    const customAgents = Array.isArray(data.customAgents) ? data.customAgents : [];
    const targetId = this.toProviderAgentId(provider);
    const targetIndex = customAgents.findIndex((agent) => sanitizeString(agent && agent.id, "") === targetId);
    if (targetIndex < 0) {
      return;
    }

    const launch = await this.buildCodexAcpLaunchSpec(this.settings.codexAcpCommand || "codex-acp");
    const endpoint = this.getProviderEndpoint(provider, normalized);
    const nextArgs = [...launch.argsPrefix, ...buildProviderCodexArgs(provider, endpoint, model)];
    const existing = customAgents[targetIndex] || {};
    const nextEnv = sanitizeStringArray(existing.env);
    if (!nextEnv.some((entry) => entry.startsWith("PATH="))) {
      nextEnv.unshift(`PATH=${buildExecPathEnv()}`);
    }

    customAgents[targetIndex] = {
      ...existing,
      id: targetId,
      displayName: providerAgentDisplayName(provider),
      command: launch.command,
      args: nextArgs,
      env: nextEnv,
      ...this.buildAgentModelHintFields(provider, model),
    };
    data.customAgents = customAgents;
    if (launch.nodePath) {
      data.nodePath = launch.nodePath;
    }
    await this.persistAgentClientSettings(path, data);
  }

  async callOptionalMethod(target, methodName, args = []) {
    if (!target || typeof target[methodName] !== "function") {
      return false;
    }
    try {
      await target[methodName](...args);
      return true;
    } catch (_error) {
      return false;
    }
  }

  async refreshAgentClientViews(plugin, nextSettings) {
    this.patchAgentClientModelPicker(plugin);
    let touched = false;
    const pluginMethods = [
      "ensureDefaultAgentId",
      "notifySettingsChanged",
      "notifySettingsUpdated",
      "refreshAgents",
      "refreshAgentList",
      "refreshViews",
      "rerenderViews",
    ];
    for (const methodName of pluginMethods) {
      const args = methodName.toLowerCase().includes("settings") ? [nextSettings] : [];
      if (await this.callOptionalMethod(plugin, methodName, args)) {
        touched = true;
      }
    }

    if (plugin.settingsStore && typeof plugin.settingsStore.set === "function") {
      try {
        plugin.settingsStore.set(plugin.settings || nextSettings);
        touched = true;
      } catch (_error) {
      }
    }

    const views = typeof plugin.getAllChatViews === "function" ? plugin.getAllChatViews() : [];
    if (Array.isArray(views)) {
      const viewMethods = [
        "onSettingsUpdated",
        "refreshAgentOptions",
        "refreshModelOptions",
        "refreshModelList",
        "refreshMentions",
        "processAutoLinks",
        "requestUpdate",
        "render",
      ];
      for (const view of views) {
        for (const methodName of viewMethods) {
          const args = methodName === "onSettingsUpdated" ? [plugin.settings || nextSettings] : [];
          if (await this.callOptionalMethod(view, methodName, args)) {
            touched = true;
          }
        }
      }
    }

    return touched;
  }

  async restartAgentClientSessions(plugin) {
    let restarted = false;
    const pluginRestartMethods = [
      "restartAgent",
      "restartCurrentAgent",
      "restartActiveAgent",
      "restartDefaultAgent",
      "reloadActiveAgent",
      "reloadAgentRuntime",
    ];
    for (const methodName of pluginRestartMethods) {
      if (await this.callOptionalMethod(plugin, methodName, [])) {
        restarted = true;
      }
    }

    const views = typeof plugin.getAllChatViews === "function" ? plugin.getAllChatViews() : [];
    if (Array.isArray(views)) {
      const viewRestartMethods = [
        "restartAgent",
        "restartSession",
        "restartCurrentAgent",
        "reconnectAgent",
      ];
      for (const view of views) {
        for (const methodName of viewRestartMethods) {
          if (await this.callOptionalMethod(view, methodName, [])) {
            restarted = true;
          }
        }
      }
    }

    return restarted;
  }

  async updateAgentClientRuntime(settingsObject) {
    const plugin = this.app && this.app.plugins && this.app.plugins.plugins
      ? this.app.plugins.plugins["agent-client"]
      : null;
    if (!plugin) {
      return false;
    }

    const nextSettings = clone(settingsObject);
    let updated = false;
    try {
      if (typeof plugin.saveSettingsAndNotify === "function") {
        await plugin.saveSettingsAndNotify(nextSettings);
        updated = true;
      }
    } catch (_error) {
    }

    if (!updated) {
      try {
        plugin.settings = nextSettings;
        if (typeof plugin.ensureDefaultAgentId === "function") {
          plugin.ensureDefaultAgentId();
        }
        if (plugin.settingsStore && typeof plugin.settingsStore.set === "function") {
          plugin.settingsStore.set(plugin.settings);
        }
        if (typeof plugin.saveSettings === "function") {
          await plugin.saveSettings();
        } else if (typeof plugin.saveData === "function") {
          await plugin.saveData(plugin.settings);
        }
        updated = true;
      } catch (_error) {
      }
    }

    if (!updated) {
      try {
        if (typeof plugin.loadSettings === "function") {
          await plugin.loadSettings();
          if (plugin.settingsStore && typeof plugin.settingsStore.set === "function") {
            plugin.settingsStore.set(plugin.settings);
          }
          updated = true;
        }
      } catch (_error) {
      }
    }

    if (updated) {
      this.patchAgentClientModelPicker(plugin);
      await this.refreshAgentClientViews(plugin, nextSettings);
      await this.restartAgentClientSessions(plugin);
    }

    return updated;
  }

  async persistAgentClientSettings(path, data) {
    await this.updateAgentClientRuntime(data);
    await this.app.vault.adapter.write(path, `${JSON.stringify(data, null, 2)}\n`);
  }

  async syncProfilesToAgentClientAgents(
    silent = false,
    preferredDefaultAgentId = "",
    preferredProfileIdsByProvider = {}
  ) {
    const path = normalizePath(this.settings.agentClientSettingsPath);
    const data = await this.readOrCreateAgentClientSettings(path);
    const customAgents = Array.isArray(data.customAgents) ? data.customAgents : [];
    const kept = customAgents.filter((agent) => !String(agent && agent.id || "").startsWith("local-gate-"));

    const launch = await this.buildCodexAcpLaunchSpec(this.settings.codexAcpCommand || "codex-acp");
    const normalizedProfiles = this.settings.profiles.map((profile, index) => sanitizeProfile(profile, index));
    const compatibleProfiles = normalizedProfiles.filter((profile) => profile.compatible);
    const supportedProviders = ["ollama", "lmstudio"];
    const providersToGenerate = supportedProviders.filter((provider) =>
      compatibleProfiles.some((profile) => profile.provider === provider)
    );

    const generated = providersToGenerate
      .map((provider) => {
        const preferredProfile = this.getPreferredProfileForProvider(
          provider,
          compatibleProfiles,
          preferredProfileIdsByProvider[provider]
        );
        if (!preferredProfile) {
          return null;
        }
        const selectedModel = sanitizeString(preferredProfile.model, deriveModelName(preferredProfile));
        const endpoint = this.getProviderEndpoint(provider, preferredProfile);
        const baseEnv = sanitizeStringArray(preferredProfile.env);
        if (!baseEnv.some((entry) => entry.startsWith("PATH="))) {
          baseEnv.unshift(`PATH=${buildExecPathEnv()}`);
        }

        this.settings.activeProfileByProvider[provider] = preferredProfile.id;
        return {
          id: this.toProviderAgentId(provider),
          displayName: providerAgentDisplayName(provider),
          command: launch.command,
          args: [...launch.argsPrefix, ...buildProviderCodexArgs(provider, endpoint, selectedModel)],
          env: baseEnv,
          ...this.buildAgentModelHintFields(provider, selectedModel),
        };
      })
      .filter(Boolean);

    Object.keys(this.settings.activeProfileByProvider).forEach((provider) => {
      if (!providersToGenerate.includes(provider)) {
        delete this.settings.activeProfileByProvider[provider];
      }
    });

    data.customAgents = [...kept, ...generated];
    const generatedIds = new Set(generated.map((agent) => agent.id));

    if (preferredDefaultAgentId && generatedIds.has(preferredDefaultAgentId)) {
      data.defaultAgentId = preferredDefaultAgentId;
    } else if (
      sanitizeString(data.defaultAgentId, "").startsWith("local-gate-") &&
      !generatedIds.has(data.defaultAgentId)
    ) {
      data.defaultAgentId = "codex-acp";
    } else if (!sanitizeString(data.defaultAgentId, "").startsWith("local-gate-") && generated.length > 0) {
      const preferredProvider = compatibleProfiles.find((profile) => profile.id === this.settings.lastProfileId)?.provider;
      const preferredProviderAgent = preferredProvider ? this.toProviderAgentId(preferredProvider) : "";
      data.defaultAgentId = generatedIds.has(preferredProviderAgent) ? preferredProviderAgent : generated[0].id;
    }

    if (launch.nodePath) {
      data.nodePath = launch.nodePath;
    }
    await this.persistAgentClientSettings(path, data);
    await this.saveSettings();

    if (!silent) {
      const skipped = normalizedProfiles.length - compatibleProfiles.length;
      new Notice(
        `Local Gate: synced ${generated.length} provider agent(s) to Agent Client.` +
          (skipped > 0 ? ` Skipped ${skipped} incompatible profile(s).` : "")
      );
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
