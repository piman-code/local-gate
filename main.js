"use strict";

const {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  Modal,
  SuggestModal,
  setIcon,
  normalizePath,
  requestUrl,
} = require("obsidian");
const { execFile } = require("child_process");
const fs = require("fs");
let buildFolderWeightMap = (folderPaths = []) => {
  const cleaned = Array.isArray(folderPaths)
    ? folderPaths.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const out = {};
  cleaned.forEach((folder, index) => {
    out[folder] = Math.max(0.25, 1 - index * 0.08);
  });
  return out;
};
let rankContextPackItems = (items, options = {}) => {
  const topK = Math.max(1, Number(options.topK) || 8);
  if (!Array.isArray(items)) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const mentionPath = String(item && item.mentionPath || "").trim();
    const path = String(item && item.path || "").trim();
    const key = mentionPath || path;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
    if (out.length >= topK) {
      break;
    }
  }
  return out;
};
try {
  const ranker = require("./search-ranker");
  if (ranker && typeof ranker.buildFolderWeightMap === "function") {
    buildFolderWeightMap = ranker.buildFolderWeightMap;
  }
  if (ranker && typeof ranker.rankContextPackItems === "function") {
    rankContextPackItems = ranker.rankContextPackItems;
  }
} catch (_error) {
  // Fallback keeps plugin loadable even when sidecar module is missing.
}

const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const LMSTUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
const CONTEXT_PACK_REF_REGEX = /@context-pack\(([a-z0-9][a-z0-9\-]{5,})\)/gi;
const INLINE_CONTEXT_ONLY_GUIDANCE =
  "[지시] 파일/폴더 탐색 도구(List/Search/Glob/Read)를 호출하지 말고, 아래 컨텍스트 텍스트만 근거로 답하세요. (Use only provided context.)";
const INLINE_CONTEXT_ONLY_GUARD =
  "[Context Rule] Use only the supplied context. Do not call filesystem tools (List/Search/Glob/Read).";

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

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
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

function buildProviderCodexArgs(provider, endpoint, model, options = {}) {
  const normalizedProvider = sanitizeString(provider, "");
  const normalizedEndpoint = sanitizeString(endpoint, "");
  const providerName = normalizedProvider === "lmstudio" ? "LM Studio" : "Ollama";
  const wireApi = sanitizeString(options && options.wireApi, "responses");
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
  args.push("-c", `model_providers.${normalizedProvider}.wire_api=${toTomlQuoted(wireApi)}`);
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
  if (item && item.compatible && sanitizeString(item && item.compatibilityReason, "") !== "ok") {
    return `ready (${sanitizeString(item && item.compatibilityReason, "ok")})`;
  }
  if (item && item.compatible) {
    return "ready";
  }
  return `blocked (${sanitizeString(item && item.compatibilityReason, "incompatible")})`;
}

function normalizeCapabilities(capabilities) {
  return sanitizeStringArray(capabilities).map((item) => item.toLowerCase());
}

function evaluateModelCompatibility(provider, modelName, capabilities, options = {}) {
  const caps = normalizeCapabilities(capabilities);
  const loweredName = String(modelName || "").toLowerCase();
  const allowNonTools = options && options.allowNonToolsChatModels === true;

  if (caps.includes("embedding") && !caps.includes("completion")) {
    return { compatible: false, reason: "embedding-only model (no chat)" };
  }
  if (provider === "ollama") {
    if (!caps.includes("completion")) {
      return { compatible: false, reason: "no completion capability" };
    }
    if (!caps.includes("tools") && !allowNonTools) {
      return { compatible: false, reason: "no tools capability (required by codex-acp)" };
    }
    if (!caps.includes("tools") && allowNonTools) {
      return { compatible: true, reason: "no tools capability (experimental override)" };
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
  const inferred = [];
  if (provider === "ollama" || provider === "lmstudio") {
    inferred.push("completion");
  }
  if (/(vision|llava|pixtral|qwen2\.5[-:]?vl|minicpm-v|moondream)/i.test(lowered)) {
    inferred.push("vision");
  }
  return [...new Set(inferred)];
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

function normalizeCapabilityValue(value) {
  const lowered = sanitizeString(String(value || ""), "").toLowerCase();
  if (!lowered) {
    return "";
  }
  if (lowered.includes("tool")) {
    return "tools";
  }
  if (lowered.includes("vision")) {
    return "vision";
  }
  if (lowered.includes("embed")) {
    return "embedding";
  }
  if (lowered.includes("think")) {
    return "thinking";
  }
  if (lowered.includes("completion") || lowered.includes("generate") || lowered.includes("chat")) {
    return "completion";
  }
  return lowered.replace(/[^a-z0-9_-]/g, "");
}

function parseOllamaShowJson(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    const capabilities = [];
    if (Array.isArray(parsed && parsed.capabilities)) {
      parsed.capabilities.forEach((entry) => {
        const normalized = normalizeCapabilityValue(entry);
        if (normalized) {
          capabilities.push(normalized);
        }
      });
    }
    const details = parsed && parsed.details && typeof parsed.details === "object" ? parsed.details : {};
    const fromDetails = details.context_length != null ? String(details.context_length) : "";
    const fromModel = parsed && parsed.model_info && parsed.model_info["context_length"] != null
      ? String(parsed.model_info["context_length"])
      : "";
    const contextLength = sanitizeString(fromDetails || fromModel, "");
    return {
      capabilities: [...new Set(capabilities)],
      contextLength,
    };
  } catch (_error) {
    return null;
  }
}

function parseOllamaShow(showOutput) {
  const lines = String(showOutput || "").split(/\r?\n/);
  const capabilities = new Set();
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
      const normalized = normalizeCapabilityValue(trimmed);
      if (normalized) {
        capabilities.add(normalized);
      }
      continue;
    }

    if (section === "model" && /^context length\s*:?\s*/i.test(trimmed)) {
      const tail = trimmed.replace(/^context length\s*:?\s*/i, "").trim();
      contextLength = tail;
    }
  }

  return { capabilities: Array.from(capabilities), contextLength };
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
    allowNonToolsChatModels: false,
    showBlockedDiscoveredModels: false,
    showHiddenDiscoveredModels: false,
    hiddenDiscoveredModelKeys: [],
    contextPackTopK: 8,
    contextPackMaxItems: 240,
    contextPackInjectInline: true,
    contextPackIncludePreviews: false,
    contextPackAutoPreviewFromQuery: false,
    contextPackForceToollessSend: true,
    suppressThinkingSignals: true,
    uiLanguage: "ko",
    preferChatCompletionsForVision: true,
    contextPacks: [],
    lastScanAt: "",
    lastScanSummary: "",
    lastScanErrors: [],
    lastScanDiagnostics: [],
  };
}

function sanitizeProfile(rawProfile, index, options = {}) {
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
  const compat = evaluateModelCompatibility(provider, model || name, capabilities, options);

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

function normalizeProfiles(rawProfiles, options = {}) {
  const defaults = defaultProfiles();
  const source = Array.isArray(rawProfiles) && rawProfiles.length > 0 ? rawProfiles : defaults;
  const seen = new Set();
  const result = [];

  source.forEach((rawProfile, index) => {
    const profile = sanitizeProfile(rawProfile, index, options);
    if (seen.has(profile.id)) {
      return;
    }
    seen.add(profile.id);
    result.push(profile);
  });

  return result.length > 0 ? result : defaults;
}

function sanitizeDiscoveredModel(rawModel, index, options = {}) {
  const fallbackKey = `model-${index + 1}`;
  const provider = sanitizeString(rawModel && rawModel.provider, "local");
  const model = sanitizeString(rawModel && rawModel.model, "unknown");
  const capabilities = sanitizeStringArray(rawModel && rawModel.capabilities);
  const compat = evaluateModelCompatibility(provider, model, capabilities, options);
  return {
    key: sanitizeString(rawModel && rawModel.key, fallbackKey),
    provider,
    model,
    endpoint: sanitizeString(rawModel && rawModel.endpoint, ""),
    capabilities,
    compatible: compat.compatible,
    compatibilityReason: compat.reason,
    contextLength: sanitizeString(rawModel && rawModel.contextLength, ""),
    discoverySource: sanitizeString(rawModel && rawModel.discoverySource, "unknown"),
    detectionState: sanitizeString(rawModel && rawModel.detectionState, "detected"),
  };
}

function normalizeDiscoveredModels(rawModels, options = {}) {
  if (!Array.isArray(rawModels)) {
    return [];
  }
  const seen = new Set();
  const result = [];
  rawModels.forEach((entry, index) => {
    const item = sanitizeDiscoveredModel(entry, index, options);
    if (seen.has(item.key)) {
      return;
    }
    seen.add(item.key);
    result.push(item);
  });
  return result;
}

function sanitizeContextPackItem(rawItem) {
  const path = sanitizeString(rawItem && rawItem.path, "");
  const mentionPath = sanitizeString(rawItem && rawItem.mentionPath, "");
  const preview = sanitizeString(rawItem && rawItem.preview, "");
  const folderPath = sanitizeString(rawItem && rawItem.folderPath, "");
  if (!path || !mentionPath) {
    return null;
  }
  return {
    path,
    mentionPath,
    preview,
    folderPath,
  };
}

function sanitizeContextPack(rawPack, index) {
  const fallbackId = `pack-${index + 1}`;
  const id = sanitizeString(rawPack && rawPack.id, fallbackId).toLowerCase();
  const createdAt = sanitizeString(rawPack && rawPack.createdAt, new Date().toISOString());
  const sourceFolders = sanitizeStringArray(rawPack && rawPack.sourceFolders);
  const items = Array.isArray(rawPack && rawPack.items)
    ? rawPack.items.map((entry) => sanitizeContextPackItem(entry)).filter(Boolean)
    : [];
  const filePaths = sanitizeStringArray(rawPack && rawPack.filePaths);
  const topK = Math.max(1, Number(rawPack && rawPack.topK) || 8);

  return {
    id,
    label: sanitizeString(rawPack && rawPack.label, `Context Pack ${index + 1}`),
    createdAt,
    sourceFolders,
    filePaths: filePaths.length > 0 ? filePaths : items.map((item) => item.path),
    items,
    totalFiles: Math.max(items.length, filePaths.length),
    topK,
    lastUsedAt: sanitizeString(rawPack && rawPack.lastUsedAt, ""),
  };
}

function normalizeContextPacks(rawPacks) {
  if (!Array.isArray(rawPacks)) {
    return [];
  }
  const seen = new Set();
  const result = [];
  rawPacks.forEach((entry, index) => {
    const item = sanitizeContextPack(entry, index);
    if (!item.id || seen.has(item.id)) {
      return;
    }
    seen.add(item.id);
    result.push(item);
  });
  return result.slice(0, 40);
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
    this.setPlaceholder("Select folder for context pack...");
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

    contentEl.createEl("h3", { text: "Multi Context Pack" });

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

    const copyButton = actionRow.createEl("button", { text: "Create Context Pack", cls: "mod-cta" });
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
    const built = await this.plugin.createContextPackFromSelections(folders, files);

    if (!built.reference) {
      new Notice("Local Gate: no notes selected.");
      return;
    }

    try {
      const inserted = await this.plugin.copyMentionsAndTryInsertToChat(built.reference);
      new Notice(
        `Local Gate: context pack ready (${built.packId}, files ${built.count})` +
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

  currentLanguage() {
    return sanitizeString(this.plugin.settings && this.plugin.settings.uiLanguage, "ko").toLowerCase() === "en"
      ? "en"
      : "ko";
  }

  isKo() {
    return this.currentLanguage() === "ko";
  }

  koen(ko, en) {
    return this.isKo() ? ko : en;
  }

  koenDesc(ko, en, beginnerHintKo = "", beginnerHintEn = "") {
    const fragment = document.createDocumentFragment();
    const main = document.createElement("div");
    main.className = "local-gate-desc-main";
    main.textContent = this.koen(ko, en);
    fragment.appendChild(main);
    const hintText = this.isKo() ? sanitizeString(beginnerHintKo, "") : sanitizeString(beginnerHintEn, "");
    if (hintText) {
      const hint = document.createElement("small");
      hint.className = "local-gate-desc-hint";
      hint.textContent = this.isKo() ? `초보자 팁: ${hintText}` : `Beginner tip: ${hintText}`;
      fragment.appendChild(hint);
    }
    return fragment;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("local-gate-settings");

    containerEl.createEl("h2", { text: this.koen("로컬 게이트", "Local Gate") });
    containerEl.createEl("p", {
      text: this.koen(
        "로컬 모델을 탐색하고 기능을 확인한 뒤 Agent Client에 바로 반영합니다.",
        "Discover local models, inspect capabilities, and publish them to Agent Client."
      ),
      cls: "local-gate-subtitle",
    });

    const langTabs = containerEl.createDiv({ cls: "local-gate-lang-tabs" });
    const koTab = langTabs.createEl("button", { text: "KO" });
    const enTab = langTabs.createEl("button", { text: "EN" });
    koTab.classList.toggle("local-gate-lang-tab-active", this.isKo());
    enTab.classList.toggle("local-gate-lang-tab-active", !this.isKo());
    koTab.onclick = async () => {
      if (this.plugin.settings.uiLanguage === "ko") {
        return;
      }
      this.plugin.settings.uiLanguage = "ko";
      await this.plugin.saveSettings();
      this.display();
    };
    enTab.onclick = async () => {
      if (this.plugin.settings.uiLanguage === "en") {
        return;
      }
      this.plugin.settings.uiLanguage = "en";
      await this.plugin.saveSettings();
      this.display();
    };

    const quickSection = containerEl.createDiv({ cls: "local-gate-section" });
    quickSection.createEl("h3", { text: this.koen("빠른 작업", "Quick Actions") });

    new Setting(quickSection)
      .setName(this.koen("Agent Client 동기화", "Sync to Agent Client"))
      .setDesc(
        this.koenDesc(
          "로컬 제공자 에이전트(Ollama/LM Studio)를 Agent Client에 반영합니다.",
          "Publish local provider agents (Ollama / LM Studio) to Agent Client.",
          "모델 목록을 바꾼 뒤 한 번 눌러주면 채팅창 선택 목록에 바로 반영됩니다."
        )
      )
      .addButton((button) =>
        button.setButtonText(this.koen("동기화", "Sync")).setCta().onClick(async () => {
          await this.plugin.syncProfilesToAgentClientAgents();
        })
      );

    new Setting(quickSection)
      .setName(this.koen("폴더 컨텍스트 팩", "Folder Context Pack"))
      .setDesc(
        this.koenDesc(
          "한 폴더에서 짧은 컨텍스트 참조 1개를 만듭니다.",
          "Create one short context reference from one folder.",
          "많은 파일을 바로 붙이지 않고 참조 토큰으로 입력창을 깔끔하게 유지합니다."
        )
      )
      .addButton((button) =>
        button.setButtonText(this.koen("생성", "Create")).onClick(async () => {
          await this.plugin.copyFolderMentionsToClipboard();
        })
      );

    new Setting(quickSection)
      .setName(this.koen("멀티 컨텍스트 팩", "Multi Context Pack"))
      .setDesc(
        this.koenDesc(
          "여러 폴더/파일을 선택해 하나의 context-pack 참조로 입력합니다.",
          "Select many folders/files and insert one context-pack reference.",
          "여러 문서를 한번에 태그할 때 사용합니다."
        )
      )
      .addButton((button) =>
        button.setButtonText(this.koen("열기", "Open")).onClick(async () => {
          await this.plugin.copyMultiMentionsToClipboard();
        })
      );

    new Setting(quickSection)
      .setName(this.koen("문서 태그 리셋", "Reset Document Tags"))
      .setDesc(
        this.koenDesc(
          "현재 채팅 입력창의 문서 태그(@... / context pack)를 정리하거나 원복합니다.",
          "Reset or clean document tags (@... / context pack) in current chat input.",
          "컨텍스트 팩을 확장한 직후라면 확장 전 문장으로 되돌리기를 우선 시도합니다."
        )
      )
      .addButton((button) =>
        button.setButtonText(this.koen("리셋", "Reset")).onClick(async () => {
          const reset = this.plugin.resetContextPackInActiveChatInput();
          new Notice(
            reset
              ? "Local Gate: 문서 태그를 리셋했습니다. / reset document tags in input."
              : "Local Gate: 리셋할 문서 태그를 찾지 못했습니다. / no document tags to reset."
          );
        })
      );

    const scanSection = containerEl.createDiv({ cls: "local-gate-section" });
    scanSection.createEl("h3", { text: this.koen("모델 탐색", "Discovery") });
    scanSection.createEl("p", {
      text: this.plugin.settings.lastScanAt
        ? `${this.koen("최근 스캔", "Last scan")}: ${this.plugin.settings.lastScanAt}`
        : this.koen("아직 스캔 기록이 없습니다.", "No scan yet."),
      cls: "local-gate-meta",
    });
    if (this.plugin.settings.lastScanSummary) {
      scanSection.createEl("p", {
        text: `${this.koen("요약", "Summary")}: ${this.plugin.settings.lastScanSummary}`,
        cls: "local-gate-meta",
      });
    }
    if (this.plugin.settings.lastScanErrors.length > 0) {
      scanSection.createEl("p", {
        text: `${this.koen("오류", "Errors")}: ${this.plugin.settings.lastScanErrors.join(" | ")}`,
        cls: "local-gate-error",
      });
    }

    new Setting(scanSection)
      .setName(this.koen("로컬 모델 스캔", "Scan local models"))
      .setDesc(this.koenDesc("활성화된 제공자에서 모델을 탐지합니다.", "Detect models from enabled providers."))
      .addButton((button) =>
        button.setButtonText(this.koen("지금 스캔", "Scan now")).setCta().onClick(async () => {
          await this.plugin.scanAndStoreModels({ silent: false });
          this.display();
        })
      );

    new Setting(scanSection)
      .setName(this.koen("시작 시 자동 스캔", "Scan on startup"))
      .setDesc(
        this.koenDesc(
          "Obsidian 시작 시 모델 목록을 자동 갱신합니다.",
          "Refresh model list when Obsidian starts.",
          "처음부터 최신 모델 목록을 쓰고 싶다면 켜두세요."
        )
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.scanOnStartup).onChange(async (value) => {
          this.plugin.settings.scanOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName(this.koen("Ollama 스캔 사용", "Enable Ollama scan"))
      .setDesc(
        this.koenDesc(
          "Ollama 모델 탐색을 켭니다(CLI 우선, HTTP 폴백).",
          "Enable Ollama model discovery (CLI first, HTTP fallback)."
        )
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableOllamaScan).onChange(async (value) => {
          this.plugin.settings.enableOllamaScan = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName(this.koen("LM Studio 스캔 사용", "Enable LM Studio scan"))
      .setDesc(
        this.koenDesc(
          "LM Studio OpenAI 호환 /models 엔드포인트를 조회합니다.",
          "Query OpenAI-compatible /models endpoint from LM Studio."
        )
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableLmStudioScan).onChange(async (value) => {
          this.plugin.settings.enableLmStudioScan = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName(this.koen("Ollama 명령어", "Ollama command"))
      .setDesc(
        this.koenDesc("Ollama CLI 실행 경로/명령어입니다.", "Path or command for Ollama CLI.")
      )
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
      .setName(this.koen("Codex ACP 명령어", "Codex ACP command"))
      .setDesc(
        this.koenDesc(
          "codex-acp 실행 경로/명령어입니다.",
          "Path or command for codex-acp.",
          "상대경로보다 절대경로를 쓰면 환경마다 덜 흔들립니다."
        )
      )
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
      .setName(this.koen("Ollama 기본 URL", "Ollama base URL"))
      .setDesc(this.koenDesc("예시: http://127.0.0.1:11434", "Example: http://127.0.0.1:11434"))
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
      .setName(this.koen("LM Studio 기본 URL", "LM Studio base URL"))
      .setDesc(this.koenDesc("예시: http://127.0.0.1:1234/v1", "Example: http://127.0.0.1:1234/v1"))
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
      .setName(this.koen("탐색 모델로 프로필 자동 생성", "Auto-create profiles from discovered models"))
      .setDesc(
        this.koenDesc(
          "탐지한 모델 상태를 Apply/Sync에 바로 쓰도록 유지합니다.",
          "Keep discovered model state for apply/sync."
        )
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoCreateProfilesFromDiscovery).onChange(async (value) => {
          this.plugin.settings.autoCreateProfilesFromDiscovery = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName(this.koen("Agent Client로 프로필 게시", "Publish profiles to Agent Client"))
      .setDesc(
        this.koenDesc(
          "Agent 드롭다운/모델 선택기에 로컬 제공자를 노출합니다.",
          "Show local providers in agent dropdown and select models from chat model picker."
        )
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.publishProfilesToAgentClient).onChange(async (value) => {
          this.plugin.settings.publishProfilesToAgentClient = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName(this.koen("스캔 직후 자동 동기화", "Auto-sync after scan"))
      .setDesc(
        this.koenDesc(
          "스캔 완료 직후 Agent Client로 프로필을 자동 반영합니다.",
          "Sync profiles into Agent Client right after scanning."
        )
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSyncToAgentClientAfterScan).onChange(async (value) => {
          this.plugin.settings.autoSyncToAgentClientAfterScan = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName(this.koen("툴 미지원 채팅 모델 허용 (실험)", "Allow non-tools chat models (experimental)"))
      .setDesc(
        this.koenDesc(
          "tools 기능이 없어도 completion 가능 모델을 사용 가능으로 간주합니다.",
          "Treat completion-capable models as usable even if tools capability is missing.",
          "호환성 완화 옵션입니다. 일부 모델은 실제 동작이 제한될 수 있습니다."
        )
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.allowNonToolsChatModels).onChange(async (value) => {
          this.plugin.settings.allowNonToolsChatModels = value;
          this.plugin.recomputeCompatibilityFlags();
          await this.plugin.saveSettings();
          this.display();
        })
      );

    new Setting(scanSection)
      .setName(this.koen("Context Pack 동적 top-k", "Context Pack dynamic top-k"))
      .setDesc(
        this.koenDesc(
          "전송 시 context pack에서 주입할 노트 개수입니다.",
          "How many notes are injected from a context pack at send time.",
          "값이 클수록 정보량은 늘지만 입력창이 길어질 수 있습니다."
        )
      )
      .addText((text) =>
        text
          .setPlaceholder("8")
          .setValue(String(this.plugin.settings.contextPackTopK))
          .onChange(async (value) => {
            const parsed = Math.max(1, Math.min(30, Number(value) || 8));
            this.plugin.settings.contextPackTopK = parsed;
            await this.plugin.saveSettings();
          })
      );

    new Setting(scanSection)
      .setName(this.koen("Context Pack 인라인 스니펫 주입", "Context Pack inject as inline snippets"))
      .setDesc(
        this.koenDesc(
          "@path 태그 대신 정렬된 노트 미리보기를 프롬프트에 직접 넣습니다.",
          "Avoid @path injection. Insert ranked note previews directly in prompt.",
          "문서 태그가 지저분하게 보일 때 인라인 모드가 더 읽기 쉽습니다."
        )
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.contextPackInjectInline !== false).onChange(async (value) => {
          this.plugin.settings.contextPackInjectInline = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName(this.koen("Context Pack 노트 미리보기 포함", "Context Pack include note previews"))
      .setDesc(
        this.koenDesc(
          "OFF: 폴더/문서 수만 표시(짧음), ON: 정리된 스니펫 라인 포함.",
          "OFF: folder/doc-count only (short), ON: include sanitized snippet lines."
        )
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.contextPackIncludePreviews === true).onChange(async (value) => {
          this.plugin.settings.contextPackIncludePreviews = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName(this.koen("질문 키워드 기반 자동 미리보기", "Context Pack auto-preview by query keywords"))
      .setDesc(
        this.koenDesc(
          "ON이면 요약/분석 같은 단어에서 미리보기를 자동 확장합니다.",
          "When ON, words like summary/analysis auto-enable previews.",
          "채팅창이 복잡해지면 OFF 유지가 좋습니다."
        )
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.contextPackAutoPreviewFromQuery === true).onChange(async (value) => {
          this.plugin.settings.contextPackAutoPreviewFromQuery = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName(this.koen("인라인 모드 강제 Tool-less 전송", "Context Pack force tool-less send (inline mode)"))
      .setDesc(
        this.koenDesc(
          "인라인 컨텍스트가 있을 때 도구 호출을 강하게 비활성화합니다.",
          "When inline context is injected, aggressively turn tools off to prevent tool loops.",
          "툴 반복 호출(루프)이 보이면 ON을 유지하세요."
        )
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.contextPackForceToollessSend !== false).onChange(async (value) => {
          this.plugin.settings.contextPackForceToollessSend = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName(this.koen("Vision 모델에 chat_completions 우선", "Prefer chat_completions for vision models"))
      .setDesc(
        this.koenDesc(
          "vision 지원 로컬 모델에 chat_completions wire API를 우선 사용합니다.",
          "Use chat_completions wire API for vision-capable local models."
        )
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.preferChatCompletionsForVision !== false).onChange(async (value) => {
          this.plugin.settings.preferChatCompletionsForVision = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName(this.koen("Thinking/Reasoning 신호 억제(최선 시도)", "Suppress thinking/reasoning signals (best effort)"))
      .setDesc(
        this.koenDesc(
          "알려진 요청 플래그를 조정해 과도한 thinking/status 노이즈를 줄입니다.",
          "Set known request flags to reduce excessive thinking/status chatter.",
          "엔진 자체 출력은 완전 차단되지 않을 수 있습니다."
        )
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.suppressThinkingSignals !== false).onChange(async (value) => {
          this.plugin.settings.suppressThinkingSignals = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(scanSection)
      .setName(this.koen("차단된 탐색 모델 표시", "Show blocked discovered models"))
      .setDesc(
        this.koenDesc(
          "적용 불가 모델도 목록에 표시합니다(비활성/회색).",
          "Show non-applicable models in list (disabled/gray)."
        )
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showBlockedDiscoveredModels).onChange(async (value) => {
          this.plugin.settings.showBlockedDiscoveredModels = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    new Setting(scanSection)
      .setName(this.koen("숨김 처리 모델 표시", "Show hidden discovered models"))
      .setDesc(
        this.koenDesc(
          "수동으로 숨긴 모델을 별도 목록에 표시합니다.",
          "Display manually hidden models in separate list."
        )
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showHiddenDiscoveredModels).onChange(async (value) => {
          this.plugin.settings.showHiddenDiscoveredModels = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    const discoveredSection = containerEl.createDiv({ cls: "local-gate-section" });
    discoveredSection.createEl("h3", { text: this.koen("탐지된 로컬 모델", "Discovered Local Models") });
    const hiddenKeys = new Set(this.plugin.settings.hiddenDiscoveredModelKeys);
    const allModels = this.plugin.settings.discoveredModels;
    const hiddenModels = allModels.filter((model) => hiddenKeys.has(model.key));
    const detectedModels = allModels.filter((model) => !hiddenKeys.has(model.key));
    const blockedModels = detectedModels.filter((model) => !model.compatible);
    const readyModels = detectedModels.filter((model) => model.compatible);
    const hiddenManualCount = hiddenModels.length;

    discoveredSection.createEl("p", {
      text:
        `${this.koen("탐지", "Detected")} ${detectedModels.length}` +
        ` | ${this.koen("사용가능", "ready")} ${readyModels.length}` +
        ` | ${this.koen("차단", "blocked")} ${blockedModels.length}` +
        ` | ${this.koen("숨김", "hidden")} ${hiddenModels.length}`,
      cls: "local-gate-meta",
    });

    if (this.plugin.settings.lastScanDiagnostics.length > 0) {
      discoveredSection.createEl("p", {
        text: this.plugin.settings.lastScanDiagnostics.join(" | "),
        cls: "local-gate-meta",
      });
    }

    const renderModelRows = (title, models, options = {}) => {
      const section = discoveredSection.createDiv({ cls: "local-gate-model-group" });
      section.createEl("h4", { text: title });
      if (models.length === 0) {
        section.createEl("p", { text: this.koen("모델이 없습니다.", "No models."), cls: "local-gate-empty" });
        return;
      }
      models.forEach((model) => {
        const blockedSuffix = model.compatible ? "" : ` (${this.koen("차단", "blocked")})`;
        const row = new Setting(section)
          .setName(`${providerLabel(model.provider)}: ${model.model}${blockedSuffix}`)
          .setDesc(
            `${capabilityBadges(model.model, model.capabilities)} | ${this.koen("엔드포인트", "endpoint")}: ${model.endpoint} | ${this.koen("기능", "capabilities")}: ${formatCapabilities(model.capabilities)}${
              model.contextLength ? ` | ${this.koen("컨텍스트", "context")}: ${model.contextLength}` : ""
            } | ${this.koen("출처", "source")}: ${sanitizeString(model.discoverySource, "unknown")} | ${this.koen("상태", "status")}: ${formatCompatibilityStatus(model)}`
          );

        if (!options.hiddenOnly) {
          row.addButton((button) =>
            button
              .setButtonText(this.koen("적용", "Apply"))
              .setCta()
              .setDisabled(!model.compatible)
              .onClick(async () => {
                await this.plugin.applyDiscoveredModel(model);
                this.display();
              })
          );
          row.addButton((button) =>
            button.setButtonText(this.koen("숨김", "Hide")).onClick(async () => {
              await this.plugin.hideDiscoveredModel(model.key);
              this.display();
            })
          );
        } else {
          row.addButton((button) =>
            button.setButtonText(this.koen("숨김해제", "Unhide")).onClick(async () => {
              await this.plugin.unhideDiscoveredModel(model.key);
              this.display();
            })
          );
        }

        row.settingEl.addClass("local-gate-model-row");
        if (!model.compatible) {
          row.settingEl.addClass("local-gate-row-unsupported");
        }
      });
    };

    renderModelRows(this.koen("탐지됨/사용가능", "Detected / Ready"), readyModels);
    if (this.plugin.settings.showBlockedDiscoveredModels) {
      renderModelRows(this.koen("차단됨(탐지됐지만 적용 불가)", "Blocked (Detected but not applicable)"), blockedModels);
    } else if (blockedModels.length > 0) {
      discoveredSection.createEl("p", {
        text: this.koen(
          `차단 모델 ${blockedModels.length}개는 숨김 처리 중입니다. '차단된 탐색 모델 표시'를 켜서 원인을 확인하세요.`,
          `Blocked models are hidden (${blockedModels.length}). Enable 'Show blocked discovered models' to inspect reasons.`
        ),
        cls: "local-gate-meta",
      });
    }

    if (this.plugin.settings.showHiddenDiscoveredModels) {
      renderModelRows(this.koen("숨김됨(수동)", "Hidden (manual)"), hiddenModels, { hiddenOnly: true });
    } else if (hiddenModels.length > 0) {
      discoveredSection.createEl("p", {
        text: this.koen(
          `숨김 모델 ${hiddenModels.length}개 목록은 접혀 있습니다. '숨김 처리 모델 표시'를 켜서 확인하세요.`,
          `Hidden models list collapsed (${hiddenModels.length}). Enable 'Show hidden discovered models' to inspect.`
        ),
        cls: "local-gate-meta",
      });
    }

    if (hiddenManualCount > 0) {
      new Setting(discoveredSection)
        .setName(this.koen("숨김 모델 초기화", "Reset hidden models"))
        .setDesc(
          this.koenDesc("수동 숨김된 모델을 모두 다시 표시합니다.", "Unhide all manually hidden discovered models.")
        )
        .addButton((button) =>
          button.setButtonText(this.koen("초기화", "Reset")).onClick(async () => {
            await this.plugin.unhideAllDiscoveredModels();
            this.display();
          })
        );
    }

    const integrationSection = containerEl.createDiv({ cls: "local-gate-section" });
    integrationSection.createEl("h3", { text: this.koen("연동", "Integration") });

    new Setting(integrationSection)
      .setName(this.koen("Agent Client 설정 경로", "Agent Client settings path"))
      .setDesc(
        this.koenDesc(
          "Vault 기준 Agent Client data.json 경로입니다.",
          "Vault-relative path to Agent Client data.json.",
          "기본값을 유지하는 것이 가장 안전합니다."
        )
      )
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
    this.__localGateModelSyncState = {};
    this.__localGateModelSyncInFlight = false;
    this.__localGateModelSyncTimer = null;
    this.__contextPackInputSnapshots = new WeakMap();

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
      name: "Local Gate: Create Folder Context Pack",
      callback: async () => {
        await this.copyFolderMentionsToClipboard();
      },
    });

    this.addCommand({
      id: "local-gate-copy-multi-mentions",
      name: "Local Gate: Create Multi Context Pack (Folders/Files)",
      callback: async () => {
        await this.copyMultiMentionsToClipboard();
      },
    });

    this.addCommand({
      id: "local-gate-expand-context-pack-input",
      name: "Local Gate: Expand Context Packs in Current Chat Input",
      callback: async () => {
        const expanded = this.expandContextPackInActiveChatInput();
        if (expanded) {
          new Notice("Local Gate: expanded context pack references in input.");
        } else {
          new Notice("Local Gate: no context pack reference found in active input.");
        }
      },
    });

    this.addCommand({
      id: "local-gate-reset-context-pack-input",
      name: "Local Gate: Reset Document Tags in Current Chat Input",
      callback: async () => {
        const reset = this.resetContextPackInActiveChatInput();
        if (reset) {
          new Notice("Local Gate: 문서 태그를 리셋했습니다. / reset document tags in input.");
        } else {
          new Notice("Local Gate: 리셋할 문서 태그를 찾지 못했습니다. / no document tags to reset.");
        }
      },
    });

    this.addCommand({
      id: "local-gate-sync-selected-chat-model",
      name: "Local Gate: Sync Selected Chat Model to Runtime",
      callback: async () => {
        const synced = await this.syncSelectedModelFromActiveView(true);
        if (synced) {
          new Notice("Local Gate: synced selected chat model to runtime.");
        } else {
          new Notice("Local Gate: no local model change detected.");
        }
      },
    });

    this.addSettingTab(new LocalGateSettingTab(this.app, this));
    this.bindGlobalContextPackHooks();

    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.publishProfilesToAgentClient) {
        await this.syncProfilesToAgentClientAgents(true);
      }
      if (this.settings.scanOnStartup) {
        await this.scanAndStoreModels({ silent: true });
      }
      this.patchAgentClientModelPicker();
      this.patchAgentClientModelSelectionHooks();
      this.patchContextPackSendHooks();
      this.bindGlobalContextPackHooks();
      await this.syncSelectedModelFromActiveView(true);
    });

    this.registerInterval(
      window.setInterval(() => {
        this.patchAgentClientModelPicker();
        this.patchAgentClientModelSelectionHooks();
        this.patchContextPackSendHooks();
        this.bindGlobalContextPackHooks();
        this.syncSelectedModelFromActiveView(true).catch(() => {});
      }, 3000)
    );
  }

  async loadSettings() {
    const defaults = defaultSettings();
    const loaded = (await this.loadData()) || {};
    const allowNonTools =
      typeof loaded.allowNonToolsChatModels === "boolean"
        ? loaded.allowNonToolsChatModels
        : defaults.allowNonToolsChatModels;
    const profiles = normalizeProfiles(loaded.profiles, {
      allowNonToolsChatModels: allowNonTools,
    });
    const discovered = normalizeDiscoveredModels(loaded.discoveredModels, {
      allowNonToolsChatModels: allowNonTools,
    });
    const contextPacks = normalizeContextPacks(loaded.contextPacks);

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
      allowNonToolsChatModels: allowNonTools,
      showBlockedDiscoveredModels:
        typeof loaded.showBlockedDiscoveredModels === "boolean"
          ? loaded.showBlockedDiscoveredModels
          : defaults.showBlockedDiscoveredModels,
      showHiddenDiscoveredModels:
        typeof loaded.showHiddenDiscoveredModels === "boolean"
          ? loaded.showHiddenDiscoveredModels
          : defaults.showHiddenDiscoveredModels,
      hiddenDiscoveredModelKeys: sanitizeStringArray(loaded.hiddenDiscoveredModelKeys),
      contextPackTopK: Math.max(1, Math.min(30, Number(loaded.contextPackTopK) || defaults.contextPackTopK)),
      contextPackMaxItems: Math.max(20, Math.min(800, Number(loaded.contextPackMaxItems) || defaults.contextPackMaxItems)),
      contextPackInjectInline:
        typeof loaded.contextPackInjectInline === "boolean"
          ? loaded.contextPackInjectInline
          : defaults.contextPackInjectInline,
      contextPackIncludePreviews:
        typeof loaded.contextPackIncludePreviews === "boolean"
          ? loaded.contextPackIncludePreviews
          : defaults.contextPackIncludePreviews,
      contextPackAutoPreviewFromQuery:
        typeof loaded.contextPackAutoPreviewFromQuery === "boolean"
          ? loaded.contextPackAutoPreviewFromQuery
          : defaults.contextPackAutoPreviewFromQuery,
      contextPackForceToollessSend:
        typeof loaded.contextPackForceToollessSend === "boolean"
          ? loaded.contextPackForceToollessSend
          : defaults.contextPackForceToollessSend,
      suppressThinkingSignals:
        typeof loaded.suppressThinkingSignals === "boolean"
          ? loaded.suppressThinkingSignals
          : defaults.suppressThinkingSignals,
      uiLanguage:
        sanitizeString(loaded.uiLanguage, defaults.uiLanguage).toLowerCase() === "en"
          ? "en"
          : "ko",
      preferChatCompletionsForVision:
        typeof loaded.preferChatCompletionsForVision === "boolean"
          ? loaded.preferChatCompletionsForVision
          : defaults.preferChatCompletionsForVision,
      contextPacks,
      lastScanAt: sanitizeString(loaded.lastScanAt, ""),
      lastScanSummary: sanitizeString(loaded.lastScanSummary, ""),
      lastScanErrors: sanitizeStringArray(loaded.lastScanErrors),
      lastScanDiagnostics: sanitizeStringArray(loaded.lastScanDiagnostics),
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
        return sanitizeProfile(migrated, index, {
          allowNonToolsChatModels: this.settings.allowNonToolsChatModels,
        });
      })
      .filter((profile) => !(profile.id === "lmstudio-default" || profile.id === "lmstudio-local-model"));

    if (this.settings.profiles.length === 0) {
      this.settings.profiles = defaultProfiles().map((entry, index) =>
        sanitizeProfile(entry, index, {
          allowNonToolsChatModels: this.settings.allowNonToolsChatModels,
        })
      );
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
    this.settings.contextPacks = normalizeContextPacks(this.settings.contextPacks);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  recomputeCompatibilityFlags() {
    this.settings.profiles = this.settings.profiles
      .map((profile, index) =>
        sanitizeProfile(profile, index, {
          allowNonToolsChatModels: this.settings.allowNonToolsChatModels,
        })
      )
      .filter((profile) => profile.id !== "lmstudio-default" && profile.id !== "lmstudio-local-model");

    this.settings.discoveredModels = this.settings.discoveredModels.map((entry, index) =>
      sanitizeDiscoveredModel(entry, index, {
        allowNonToolsChatModels: this.settings.allowNonToolsChatModels,
      })
    );
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

  async unhideDiscoveredModel(modelKey) {
    const before = this.settings.hiddenDiscoveredModelKeys.length;
    this.settings.hiddenDiscoveredModelKeys = this.settings.hiddenDiscoveredModelKeys.filter((entry) => entry !== modelKey);
    if (before !== this.settings.hiddenDiscoveredModelKeys.length) {
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

  createContextPackId() {
    const base = Date.now().toString(36);
    const rand = Math.floor(Math.random() * 36 ** 4)
      .toString(36)
      .padStart(4, "0");
    return `cp-${base}-${rand}`;
  }

  buildContextPackReference(packId) {
    return `@context-pack(${packId})`;
  }

  extractPreviewText(rawText) {
    let source = String(rawText || "");
    source = source.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/m, "");
    const collapsed = sanitizeString(source, "")
      .replace(/\r?\n+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
      .replace(/\[\[([^\]]+)\]\]/g, (_match, link) => {
        const safe = sanitizeString(link, "");
        if (!safe) {
          return "";
        }
        const parts = safe.split("/");
        return sanitizeString(parts[parts.length - 1], safe);
      })
      .replace(/[#>*`~\[\]\(\)!]/g, " ")
      .trim();
    return collapsed.slice(0, 320);
  }

  stripMetadataNoise(rawText) {
    const text = sanitizeString(rawText, "");
    if (!text) {
      return "";
    }
    const cleaned = text
      .replace(
        /\b(plugin|generated_at|window_start|window_end|feeds_checked|items_count|items_without_date|items_filtered_by_keyword|items_deduped|feed_errors|translation_provider|translation_model|titles_translated)\s*:/gi,
        " "
      )
      .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\b/gi, " ")
      .replace(/\.\d+z\b/gi, " ")
      .replace(/\b\d+\b/g, " ")
      .replace(/[_]{2,}/g, " ")
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned;
  }

  redactPathLikeText(rawText) {
    let text = sanitizeString(rawText, "");
    if (!text) {
      return "";
    }
    text = text
      .replace(/\[\[[^\]]+\]\]/g, "[링크]")
      .replace(/\/Users\/[^\s]+/g, "[경로생략]")
      .replace(/[A-Za-z]:\\[^\s]+/g, "[경로생략]")
      .replace(/\b(?:[A-Za-z0-9._-]+\/){2,}[A-Za-z0-9._-]+(?:\.md)?\b/g, "[경로생략]")
      .replace(/[\[\]]{2,}/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text;
  }

  sanitizePathStringsForPrompt(rawText) {
    let text = sanitizeString(rawText, "");
    if (!text) {
      return "";
    }
    text = text
      .replace(/\bfile:\/\/\/[^\s)\]}>"'`]+/gi, "[경로생략]")
      .replace(/\/Users\/[^\s)\]}>"'`]+/g, "[경로생략]")
      .replace(/[A-Za-z]:\\[^\s)\]}>"'`]+/g, "[경로생략]")
      .replace(/\b(?!https?:\/\/)(?:\.\.?\/)?(?:[A-Za-z0-9._-]+\/){2,}[A-Za-z0-9._-]+(?:\.[A-Za-z0-9._-]+)?\b/g, "[경로생략]")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text;
  }

  hasInlineContextPayload(rawText) {
    const text = sanitizeString(rawText, "");
    if (!text) {
      return false;
    }
    return (
      /\[Context Pack [^\]]*,\s*inline\]/i.test(text) ||
      text.includes(INLINE_CONTEXT_ONLY_GUIDANCE) ||
      text.includes(INLINE_CONTEXT_ONLY_GUARD)
    );
  }

  enforceInlineContextGuard(rawText) {
    const text = sanitizeString(rawText, "");
    if (!text) {
      return "";
    }
    if (!this.hasInlineContextPayload(text)) {
      return text;
    }
    if (text.includes(INLINE_CONTEXT_ONLY_GUARD)) {
      return text;
    }
    return `${INLINE_CONTEXT_ONLY_GUARD}\n${text}`;
  }

  async readNotePreview(filePath) {
    const safePath = sanitizeString(filePath, "");
    if (!safePath) {
      return "";
    }
    try {
      const raw = await this.app.vault.adapter.read(safePath);
      return this.extractPreviewText(raw);
    } catch (_error) {
      return "";
    }
  }

  async createContextPackFromSelections(folderPaths = [], filePaths = []) {
    const files = this.collectMentionFilePaths(folderPaths, filePaths);
    const limit = Math.max(20, Math.min(800, Number(this.settings.contextPackMaxItems) || 240));
    const selected = files.slice(0, limit);
    const items = (
      await Promise.all(
        selected.map(async (filePath) => {
          const mentionPath = this.normalizeMentionPath(filePath);
          if (!mentionPath) {
            return null;
          }
          const preview = await this.readNotePreview(filePath);
          const folderPath = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
          return {
            path: filePath,
            mentionPath,
            preview,
            folderPath,
          };
        })
      )
    ).filter(Boolean);

    if (items.length === 0) {
      return {
        reference: "",
        packId: "",
        count: 0,
        truncated: false,
        total: files.length,
      };
    }

    const packId = this.createContextPackId();
    const labelSource = sanitizeStringArray(folderPaths)[0] || sanitizeStringArray(filePaths)[0] || "selection";
    const pack = sanitizeContextPack(
      {
        id: packId,
        label: `Context Pack: ${labelSource}`,
        createdAt: new Date().toISOString(),
        sourceFolders: sanitizeStringArray(folderPaths),
        filePaths: items.map((item) => item.path),
        items,
        topK: this.settings.contextPackTopK,
      },
      0
    );

    const retained = this.settings.contextPacks.filter((entry) => entry.id !== pack.id);
    this.settings.contextPacks = [pack, ...retained].slice(0, 40);
    await this.saveSettings();

    return {
      reference: this.buildContextPackReference(pack.id),
      packId: pack.id,
      count: items.length,
      truncated: files.length > items.length,
      total: files.length,
    };
  }

  findContextPack(packId) {
    const id = sanitizeString(packId, "").toLowerCase();
    if (!id) {
      return null;
    }
    return this.settings.contextPacks.find((entry) => entry.id === id) || null;
  }

  getContextPackIdsFromText(text) {
    const ids = [];
    const target = sanitizeString(text, "");
    if (!target) {
      return ids;
    }
    const regex = new RegExp(CONTEXT_PACK_REF_REGEX.source, "gi");
    let match = regex.exec(target);
    while (match) {
      const id = sanitizeString(match[1], "").toLowerCase();
      if (id && !ids.includes(id)) {
        ids.push(id);
      }
      match = regex.exec(target);
    }
    return ids;
  }

  buildMentionsTextFromPackItems(items) {
    return items
      .map((item) => {
        const normalized = sanitizeString(item && item.mentionPath, "");
        if (!normalized) {
          return "";
        }
        const mention = `@${normalized}`;
        return `${mention} [[${normalized}]]`;
      })
      .filter(Boolean)
      .join(" ");
  }

  folderAliasFromPath(rawPath) {
    const safe = sanitizeString(rawPath, "");
    if (!safe) {
      return "";
    }
    const parts = safe.split("/").filter(Boolean);
    return sanitizeString(parts[parts.length - 1], safe);
  }

  buildFolderOnlyContextText(pack, rankedCount) {
    const folders = sanitizeStringArray(pack && pack.sourceFolders)
      .map((entry) => this.folderAliasFromPath(entry))
      .filter(Boolean);
    const uniqueFolders = [...new Set(folders)];
    const folderLabel = uniqueFolders.length > 0 ? uniqueFolders.slice(0, 3).join(", ") : "선택한 노트";
    return `- [폴더] ${folderLabel}\n- [문서수] ${rankedCount}/${Math.max(1, Number(pack && pack.totalFiles) || rankedCount)}`;
  }

  buildInlineSnippetTextFromPackItems(items, pack, options = {}) {
    const includePreviews = options.includePreviews === true || this.settings.contextPackIncludePreviews === true;
    if (!includePreviews) {
      return this.buildFolderOnlyContextText(pack, items.length);
    }
    return items
      .map((item, index) => {
        const rawPreview = sanitizeString(item && item.preview, "");
        const preview = this.redactPathLikeText(this.stripMetadataNoise(rawPreview));
        const docLabel = `문서 ${index + 1}`;
        if (preview) {
          return `- [${docLabel}] ${preview.slice(0, 300)}`;
        }
        return `- [${docLabel}] (미리보기 없음)`;
      })
      .filter(Boolean)
      .join("\n");
  }

  expandContextPackReferences(rawText) {
    const original = sanitizeString(rawText, "");
    if (!original) {
      return { text: original, expandedIds: [], missingIds: [] };
    }
    const ids = this.getContextPackIdsFromText(original);
    if (ids.length === 0) {
      return { text: original, expandedIds: [], missingIds: [] };
    }

    const query = original.replace(CONTEXT_PACK_REF_REGEX, " ").replace(/\s+/g, " ").trim();
    let nextText = original;
    const expandedIds = [];
    const missingIds = [];
    let touchedPack = false;

    ids.forEach((id) => {
      const pack = this.findContextPack(id);
      if (!pack) {
        missingIds.push(id);
        return;
      }
      const topK = Math.max(1, Number(pack.topK || this.settings.contextPackTopK || 8));
      const ranked = rankContextPackItems(pack.items, {
        query,
        topK,
        folderWeights: buildFolderWeightMap(pack.sourceFolders),
      });
      const inlineMode = this.settings.contextPackInjectInline !== false;
      const shouldAutoPreview = this.settings.contextPackAutoPreviewFromQuery === true;
      const needsDetailFromQuery =
        shouldAutoPreview &&
        /(요약|정리|핵심|summary|summarize|analysis|analyze|분석|비교|요지|브리핑)/i.test(query);
      const includePreviews = this.settings.contextPackIncludePreviews === true || needsDetailFromQuery;
      const payloadText = inlineMode
        ? this.buildInlineSnippetTextFromPackItems(ranked, pack, {
            includePreviews,
          })
        : this.buildMentionsTextFromPackItems(ranked);
      const includeGuidance =
        inlineMode &&
        expandedIds.length === 0 &&
        !nextText.includes(INLINE_CONTEXT_ONLY_GUIDANCE);
      const guidanceLine = includeGuidance ? `${INLINE_CONTEXT_ONLY_GUIDANCE}\n` : "";
      const replacement =
        payloadText.length > 0
          ? inlineMode
            ? `[Context Pack ${id}: ${ranked.length}/${pack.totalFiles}, inline]\n${guidanceLine}${payloadText}\n`
            : `[Context Pack ${id}: ${ranked.length}/${pack.totalFiles}] ${payloadText}`
          : `[Context Pack ${id}: no usable notes]`;
      const tokenRegex = new RegExp(`@context-pack\\(${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`, "ig");
      nextText = nextText.replace(tokenRegex, replacement);
      expandedIds.push(id);
      pack.lastUsedAt = new Date().toISOString();
      touchedPack = true;
    });

    if (touchedPack) {
      this.settings.contextPacks = normalizeContextPacks(this.settings.contextPacks);
      this.saveSettings().catch(() => {});
    }

    return { text: nextText, expandedIds, missingIds };
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

  findChatSendButtons(view) {
    const roots = [view && view.containerEl, view && view.contentEl].filter(Boolean);
    const selectors = [
      "button[type='submit']",
      "button[name='send']",
      "[role='button'][aria-label*='Send']",
      "[role='button'][aria-label*='send']",
      "button[aria-label*='Send']",
      "button[aria-label*='send']",
      "button[title*='Send']",
      "button[title*='send']",
      "button[data-action='send']",
      "[data-action='send']",
      ".chat-send-button",
      ".send-button",
      ".mod-cta",
    ];
    const seen = new Set();
    const out = [];
    roots.forEach((root) => {
      if (typeof root.querySelectorAll !== "function") {
        return;
      }
      selectors.forEach((selector) => {
        root.querySelectorAll(selector).forEach((button) => {
          if (!button || seen.has(button)) {
            return;
          }
          seen.add(button);
          out.push(button);
        });
      });
    });
    return out;
  }

  isLikelySendControl(target) {
    const node = target && target.nodeType === 1 ? target : null;
    if (!node || typeof node.matches !== "function") {
      return false;
    }
    if (
      node.matches(
        "button[type='submit'],button[name='send'],button[aria-label*='Send'],button[aria-label*='send'],button[title*='Send'],button[title*='send'],button[data-action='send'],[role='button'][aria-label*='Send'],[role='button'][aria-label*='send'],[data-action='send'],.chat-send-button,.send-button,.mod-cta"
      )
    ) {
      return true;
    }
    const parentButton = typeof node.closest === "function" ? node.closest("button,[role='button']") : null;
    if (!parentButton) {
      return false;
    }
    const hint = `${sanitizeString(parentButton.getAttribute && parentButton.getAttribute("aria-label"), "")} ${sanitizeString(parentButton.getAttribute && parentButton.getAttribute("title"), "")} ${sanitizeString(parentButton.className, "")}`.toLowerCase();
    return hint.includes("send");
  }

  isLikelyModelControl(target) {
    const node = target && target.nodeType === 1 ? target : null;
    if (!node || typeof node.matches !== "function") {
      return false;
    }
    if (
      node.matches(
        "select,[role='combobox'],[aria-haspopup='listbox'],button[aria-label*='Model'],button[aria-label*='model'],button[title*='Model'],button[title*='model'],[data-action*='model'],[class*='model']"
      )
    ) {
      return true;
    }
    const parent = typeof node.closest === "function" ? node.closest("button,[role='button'],[role='option'],[aria-haspopup='listbox']") : null;
    if (!parent) {
      return false;
    }
    const hint = `${sanitizeString(parent.getAttribute && parent.getAttribute("aria-label"), "")} ${sanitizeString(parent.getAttribute && parent.getAttribute("title"), "")} ${sanitizeString(parent.className, "")}`.toLowerCase();
    return hint.includes("model") || hint.includes("모델");
  }

  scheduleActiveModelSync(delayMs = 120) {
    if (typeof window === "undefined") {
      this.syncSelectedModelFromActiveView(true).catch(() => {});
      return;
    }
    if (this.__localGateModelSyncTimer) {
      window.clearTimeout(this.__localGateModelSyncTimer);
    }
    this.__localGateModelSyncTimer = window.setTimeout(() => {
      this.__localGateModelSyncTimer = null;
      this.syncSelectedModelFromActiveView(true).catch(() => {});
    }, Math.max(20, Number(delayMs) || 120));
  }

  currentUiLanguage() {
    return sanitizeString(this.settings && this.settings.uiLanguage, "ko").toLowerCase() === "en" ? "en" : "ko";
  }

  uiText(ko, en) {
    return this.currentUiLanguage() === "ko" ? ko : en;
  }

  basenameFromMentionPath(rawPath) {
    const safe = sanitizeString(rawPath, "");
    if (!safe) {
      return "";
    }
    const parts = safe.split("/").filter(Boolean);
    return sanitizeString(parts[parts.length - 1], safe);
  }

  parseMentionPathsFromInputText(rawText) {
    const text = sanitizeString(rawText, "");
    if (!text) {
      return [];
    }
    const out = [];
    const seen = new Set();
    const push = (entry) => {
      const safe = sanitizeString(entry, "");
      if (!safe || seen.has(safe)) {
        return;
      }
      seen.add(safe);
      out.push(safe);
    };

    const pairedRegex = /@([^\s]+)\s+\[\[([^\]]+)\]\]/g;
    let paired = pairedRegex.exec(text);
    while (paired) {
      const candidate = sanitizeString(paired[2], "");
      if (candidate) {
        push(candidate);
      }
      paired = pairedRegex.exec(text);
    }

    const directRegex = /@([A-Za-z0-9._\-\/]+(?:\.md)?)/g;
    let direct = directRegex.exec(text);
    while (direct) {
      const candidate = sanitizeString(direct[1], "");
      if (candidate && candidate !== "context-pack" && !candidate.startsWith("context-pack(")) {
        if (candidate.includes("/") || candidate.toLowerCase().endsWith(".md")) {
          push(candidate);
        }
      }
      direct = directRegex.exec(text);
    }

    return out;
  }

  collectSelectedDocsFromInputText(rawText, view = null) {
    let sourceText = sanitizeString(rawText, "");
    let packIds = this.getContextPackIdsFromText(sourceText);

    if (packIds.length === 0 && view && this.__contextPackInputSnapshots) {
      const snapshot = this.__contextPackInputSnapshots.get(view);
      if (snapshot && sanitizeString(snapshot.after, "") === sourceText) {
        sourceText = sanitizeString(snapshot.before, sourceText);
        packIds = this.getContextPackIdsFromText(sourceText);
      }
    }

    const paths = [];
    const seen = new Set();
    const pushPath = (entry) => {
      const safe = sanitizeString(entry, "");
      if (!safe || seen.has(safe)) {
        return;
      }
      seen.add(safe);
      paths.push(safe);
    };

    packIds.forEach((id) => {
      const pack = this.findContextPack(id);
      if (!pack) {
        return;
      }
      if (Array.isArray(pack.items)) {
        pack.items.forEach((item) => {
          const mention = sanitizeString(item && item.mentionPath, "");
          if (mention) {
            pushPath(mention);
            return;
          }
          const filePath = sanitizeString(item && item.path, "");
          if (filePath) {
            pushPath(this.normalizeMentionPath(filePath));
          }
        });
      } else if (Array.isArray(pack.filePaths)) {
        pack.filePaths.forEach((filePath) => {
          pushPath(this.normalizeMentionPath(filePath));
        });
      }
    });

    this.parseMentionPathsFromInputText(sourceText).forEach((entry) => pushPath(entry));

    return { paths, packIds };
  }

  buildSelectedDocsSummary(selection) {
    const count = Array.isArray(selection && selection.paths) ? selection.paths.length : 0;
    if (count === 0) {
      return this.uiText("선택 문서 없음", "No selected docs");
    }
    if (count <= 3) {
      const names = selection.paths.map((entry) => this.basenameFromMentionPath(entry)).filter(Boolean).join(", ");
      return this.uiText(`선택 ${count}개: ${names}`, `Selected ${count}: ${names}`);
    }
    return this.uiText(`선택 문서 ${count}개`, `Selected ${count} docs`);
  }

  ensureChatQuickControls(view) {
    if (!view || typeof document === "undefined") {
      return false;
    }
    const input = this.findChatInputElement(view);
    if (!input) {
      return false;
    }
    const anchor =
      (typeof input.closest === "function"
        ? input.closest(".agent-client-chat-input-container,.agent-client-chat-input,form")
        : null) ||
      input.parentElement;
    if (!anchor || !anchor.parentElement) {
      return false;
    }

    let panel = input.__localGateQuickControlPanel;
    if (!panel || !panel.isConnected) {
      panel = document.createElement("div");
      panel.className = "local-gate-chat-tools";

      const actionRow = document.createElement("div");
      actionRow.className = "local-gate-chat-tool-actions";
      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.className = "local-gate-chat-tool-btn mod-cta";
      const resetBtn = document.createElement("button");
      resetBtn.type = "button";
      resetBtn.className = "local-gate-chat-tool-btn";

      const selectIcon = document.createElement("span");
      const resetIcon = document.createElement("span");
      const selectLabel = document.createElement("span");
      const resetLabel = document.createElement("span");
      selectLabel.className = "local-gate-chat-tool-label";
      resetLabel.className = "local-gate-chat-tool-label";
      selectBtn.appendChild(selectIcon);
      selectBtn.appendChild(selectLabel);
      resetBtn.appendChild(resetIcon);
      resetBtn.appendChild(resetLabel);
      try {
        setIcon(selectIcon, "plus");
        setIcon(resetIcon, "minus");
      } catch (_error) {
      }

      selectBtn.onclick = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await this.copyMultiMentionsToClipboard();
        this.updateChatQuickControls(view);
      };
      resetBtn.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const reset = this.resetContextPackInViewInput(view);
        new Notice(
          reset
            ? this.uiText("Local Gate: 문서 태그를 리셋했습니다.", "Local Gate: reset document tags in input.")
            : this.uiText("Local Gate: 리셋할 문서 태그가 없습니다.", "Local Gate: no document tags to reset.")
        );
        this.updateChatQuickControls(view);
      };
      actionRow.appendChild(selectBtn);
      actionRow.appendChild(resetBtn);

      const detail = document.createElement("details");
      detail.className = "local-gate-chat-selection";
      const summary = document.createElement("summary");
      summary.className = "local-gate-chat-selection-summary";
      const body = document.createElement("div");
      body.className = "local-gate-chat-selection-body";
      detail.appendChild(summary);
      detail.appendChild(body);

      panel.appendChild(actionRow);
      panel.appendChild(detail);
      anchor.parentElement.insertBefore(panel, anchor);

      panel.__localGateSelectLabelEl = selectLabel;
      panel.__localGateResetLabelEl = resetLabel;
      panel.__localGateSummaryEl = summary;
      panel.__localGateBodyEl = body;
      panel.__localGateDetailEl = detail;
      input.__localGateQuickControlPanel = panel;
    }

    if (!input.__localGateQuickControlInputHooked) {
      const update = () => this.updateChatQuickControls(view);
      try {
        input.addEventListener("input", update, true);
        input.addEventListener("change", update, true);
        input.addEventListener("keyup", update, true);
        input.__localGateQuickControlInputHooked = true;
        input.__localGateQuickControlInputHandler = update;
      } catch (_error) {
      }
    }

    this.updateChatQuickControls(view);
    return true;
  }

  updateChatQuickControls(view) {
    if (!view) {
      return false;
    }
    const input = this.findChatInputElement(view);
    if (!input) {
      return false;
    }
    const panel = input.__localGateQuickControlPanel;
    if (!panel || !panel.isConnected) {
      return false;
    }
    const selectLabel = panel.__localGateSelectLabelEl;
    const resetLabel = panel.__localGateResetLabelEl;
    const summaryEl = panel.__localGateSummaryEl;
    const bodyEl = panel.__localGateBodyEl;
    const detailEl = panel.__localGateDetailEl;

    if (selectLabel) {
      selectLabel.textContent = this.uiText("+선택", "+Select");
    }
    if (resetLabel) {
      resetLabel.textContent = this.uiText("-리셋", "-Reset");
    }
    if (!summaryEl || !bodyEl || !detailEl) {
      return false;
    }

    const inputText = this.getViewInputText(view);
    const selection = this.collectSelectedDocsFromInputText(inputText, view);
    summaryEl.textContent = this.buildSelectedDocsSummary(selection);

    const items = selection.paths.slice(0, 24);
    while (bodyEl.firstChild) {
      bodyEl.removeChild(bodyEl.firstChild);
    }
    const meta = document.createElement("div");
    meta.className = "local-gate-chat-selection-meta";
    meta.textContent = this.uiText(
      `컨텍스트 팩 ${selection.packIds.length}개 / 문서 ${selection.paths.length}개`,
      `${selection.packIds.length} context packs / ${selection.paths.length} docs`
    );
    bodyEl.appendChild(meta);

    if (items.length === 0) {
      detailEl.style.display = "none";
      const empty = document.createElement("div");
      empty.className = "local-gate-chat-selection-empty";
      empty.textContent = this.uiText("현재 선택된 문서가 없습니다.", "No selected documents in input.");
      bodyEl.appendChild(empty);
      detailEl.open = false;
      return true;
    }

    detailEl.style.display = "";

    const list = document.createElement("ul");
    list.className = "local-gate-chat-selection-list";
    items.forEach((entry) => {
      const li = document.createElement("li");
      li.textContent = this.basenameFromMentionPath(entry);
      list.appendChild(li);
    });
    bodyEl.appendChild(list);

    if (selection.paths.length > items.length) {
      const more = document.createElement("div");
      more.className = "local-gate-chat-selection-more";
      more.textContent = this.uiText(
        `외 ${selection.paths.length - items.length}개 문서`,
        `${selection.paths.length - items.length} more docs`
      );
      bodyEl.appendChild(more);
    }
    return true;
  }

  expandContextPackInActiveChatInput() {
    const active = this.getActiveAgentClientChatView();
    if (!active) {
      return false;
    }
    return this.expandContextPackInViewInput(active);
  }

  bindContextPackDomHooks(view) {
    if (!view) {
      return false;
    }
    let touched = false;
    const input = this.findChatInputElement(view);
    if (input && !input.__localGateContextPackInputHooked) {
      const keydownHandler = (event) => {
        const key = sanitizeString(String(event && event.key || ""), "").toLowerCase();
        if (key !== "enter") {
          return;
        }
        if (event && event.shiftKey) {
          return;
        }
        this.expandContextPackInViewInput(view) || this.expandContextPackInActiveChatInput();
        this.updateChatQuickControls(view);
      };
      try {
        input.addEventListener("keydown", keydownHandler, true);
        input.__localGateContextPackInputHooked = true;
        touched = true;
      } catch (_error) {
      }

      const formEl = typeof input.closest === "function" ? input.closest("form") : null;
      if (formEl && !formEl.__localGateContextPackFormHooked) {
        const submitHandler = () => {
          this.expandContextPackInViewInput(view) || this.expandContextPackInActiveChatInput();
        };
        try {
          formEl.addEventListener("submit", submitHandler, true);
          formEl.__localGateContextPackFormHooked = true;
          touched = true;
        } catch (_error) {
        }
      }
    }

    const sendButtons = this.findChatSendButtons(view);
    sendButtons.forEach((button) => {
      if (button.__localGateContextPackSendHooked) {
        return;
      }
      const sendHandler = () => {
        this.expandContextPackInViewInput(view) || this.expandContextPackInActiveChatInput();
        this.syncSelectedModelFromView(view, true).catch(() => {});
        this.updateChatQuickControls(view);
      };
      try {
        button.addEventListener("pointerdown", sendHandler, true);
        button.addEventListener("mousedown", sendHandler, true);
        button.addEventListener("touchstart", sendHandler, true);
        button.addEventListener("click", sendHandler, true);
        button.__localGateContextPackSendHooked = true;
        touched = true;
      } catch (_error) {
      }
    });
    if (this.ensureChatQuickControls(view)) {
      touched = true;
    }
    return touched;
  }

  bindGlobalContextPackHooks() {
    if (this.__localGateGlobalContextPackHooksBound || typeof document === "undefined") {
      return false;
    }
    this.__localGateGlobalContextPackHooksBound = true;
    const keydownHandler = (event) => {
      const key = sanitizeString(String(event && event.key || ""), "").toLowerCase();
      if (key !== "enter" || (event && event.shiftKey)) {
        return;
      }
      this.expandContextPackInActiveChatInput();
    };
    const pointerHandler = (event) => {
      const target = event && event.target ? event.target : null;
      if (!target) {
        return;
      }
      if (this.isLikelySendControl(target)) {
        this.expandContextPackInActiveChatInput();
        this.syncSelectedModelFromActiveView(true).catch(() => {});
        return;
      }
      if (this.isLikelyModelControl(target)) {
        this.scheduleActiveModelSync();
      }
    };
    const changeHandler = (event) => {
      const target = event && event.target ? event.target : null;
      if (!target) {
        return;
      }
      if (this.isLikelyModelControl(target)) {
        this.scheduleActiveModelSync(40);
      }
    };

    if (typeof this.registerDomEvent === "function") {
      this.registerDomEvent(document, "keydown", keydownHandler, true);
      this.registerDomEvent(document, "pointerdown", pointerHandler, true);
      this.registerDomEvent(document, "mousedown", pointerHandler, true);
      this.registerDomEvent(document, "change", changeHandler, true);
      return true;
    }

    try {
      document.addEventListener("keydown", keydownHandler, true);
      document.addEventListener("pointerdown", pointerHandler, true);
      document.addEventListener("mousedown", pointerHandler, true);
      document.addEventListener("change", changeHandler, true);
      return true;
    } catch (_error) {
      return false;
    }
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
    this.updateChatQuickControls(view);
    return true;
  }

  getViewInputText(view) {
    if (!view) {
      return "";
    }
    if (typeof view.getInputState === "function") {
      try {
        const state = view.getInputState() || {};
        const fromState = sanitizeString(state.text, "");
        if (fromState) {
          return fromState;
        }
      } catch (_error) {
      }
    }
    const input = this.findChatInputElement(view);
    if (!input) {
      return "";
    }
    return "value" in input
      ? sanitizeString(String(input.value || ""), "")
      : sanitizeString(input.textContent || "", "");
  }

  setViewInputText(view, nextText) {
    const text = sanitizeString(nextText, "");
    if (!view) {
      return false;
    }
    if (typeof view.getInputState === "function" && typeof view.setInputState === "function") {
      try {
        const current = view.getInputState() || {};
        const currentImages = Array.isArray(current.images) ? current.images : [];
        view.setInputState({ text, images: currentImages });
        this.triggerChatInputRefresh(view, text);
        this.updateChatQuickControls(view);
        return true;
      } catch (_error) {
      }
    }
    const input = this.findChatInputElement(view);
    if (!input) {
      return false;
    }
    if ("value" in input) {
      input.value = text;
    } else {
      input.textContent = text;
    }
    try {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_error) {
    }
    this.triggerChatInputRefresh(view, text);
    this.updateChatQuickControls(view);
    return true;
  }

  rememberContextPackInputSnapshot(view, beforeText, afterText) {
    if (!view || !this.__contextPackInputSnapshots || typeof this.__contextPackInputSnapshots.set !== "function") {
      return;
    }
    const before = sanitizeString(beforeText, "");
    const after = sanitizeString(afterText, "");
    if (!before || !after || before === after) {
      return;
    }
    try {
      this.__contextPackInputSnapshots.set(view, {
        before,
        after,
        ts: Date.now(),
      });
    } catch (_error) {
    }
  }

  stripContextPackArtifactsFromInput(rawText) {
    const text = sanitizeString(rawText, "");
    if (!text) {
      return "";
    }
    const lines = text.split(/\r?\n/);
    const kept = [];
    lines.forEach((line) => {
      const trimmed = sanitizeString(line, "");
      if (!trimmed) {
        kept.push("");
        return;
      }
      if (trimmed === INLINE_CONTEXT_ONLY_GUIDANCE || trimmed === INLINE_CONTEXT_ONLY_GUARD) {
        return;
      }
      if (/^\[Context Pack [^\]]+\]/i.test(trimmed)) {
        return;
      }
      if (/^- \[(폴더|문서수|문서\s*\d+)\]/i.test(trimmed)) {
        return;
      }
      if (/^(@[^\s]+(?:\s+\[\[[^\]]+\]\])?\s*)+$/i.test(trimmed)) {
        return;
      }
      kept.push(line);
    });
    let out = kept.join("\n");
    out = out
      .replace(new RegExp(CONTEXT_PACK_REF_REGEX.source, "gi"), " ")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return out;
  }

  expandContextPackInViewInput(view) {
    const targetView = view || this.getActiveAgentClientChatView();
    const currentText = this.getViewInputText(targetView);
    const hasReference = currentText && new RegExp(CONTEXT_PACK_REF_REGEX.source, "i").test(currentText);
    if (!hasReference) {
      return false;
    }
    const expanded = this.expandContextPackReferences(currentText);
    if (expanded.missingIds.length > 0) {
      new Notice(`Local Gate: missing context pack ${expanded.missingIds.join(", ")}`);
    }
    let nextText = expanded.text;
    if (this.settings.contextPackInjectInline !== false && this.hasInlineContextPayload(nextText)) {
      nextText = this.enforceInlineContextGuard(this.sanitizePathStringsForPrompt(nextText));
    }
    if (expanded.expandedIds.length === 0 || nextText === currentText) {
      return false;
    }
    const applied = this.setViewInputText(targetView, nextText);
    if (applied) {
      this.rememberContextPackInputSnapshot(targetView, currentText, nextText);
      this.updateChatQuickControls(targetView);
    }
    return applied;
  }

  sanitizeInlineContextInViewInput(view) {
    const targetView = view || this.getActiveAgentClientChatView();
    const currentText = this.getViewInputText(targetView);
    if (!currentText || this.settings.contextPackInjectInline === false || !this.hasInlineContextPayload(currentText)) {
      return { changed: false, inlineContextOnly: false, text: currentText };
    }
    const nextText = this.enforceInlineContextGuard(this.sanitizePathStringsForPrompt(currentText));
    if (nextText !== currentText) {
      this.setViewInputText(targetView, nextText);
      this.rememberContextPackInputSnapshot(targetView, currentText, nextText);
      this.updateChatQuickControls(targetView);
      return { changed: true, inlineContextOnly: true, text: nextText };
    }
    return { changed: false, inlineContextOnly: true, text: currentText };
  }

  resetContextPackInViewInput(view) {
    const targetView = view || this.getActiveAgentClientChatView();
    if (!targetView) {
      return false;
    }
    const currentText = this.getViewInputText(targetView);
    if (!currentText) {
      return false;
    }
    let nextText = currentText;
    if (this.__contextPackInputSnapshots && typeof this.__contextPackInputSnapshots.get === "function") {
      const snapshot = this.__contextPackInputSnapshots.get(targetView);
      if (snapshot && sanitizeString(snapshot.after, "") === currentText) {
        nextText = sanitizeString(snapshot.before, "");
      }
    }
    if (nextText === currentText) {
      nextText = this.stripContextPackArtifactsFromInput(currentText);
    }
    if (nextText === currentText) {
      return false;
    }
    const applied = this.setViewInputText(targetView, nextText);
    if (applied && this.__contextPackInputSnapshots && typeof this.__contextPackInputSnapshots.delete === "function") {
      this.__contextPackInputSnapshots.delete(targetView);
    }
    if (applied) {
      this.updateChatQuickControls(targetView);
    }
    return applied;
  }

  resetContextPackInActiveChatInput() {
    const active = this.getActiveAgentClientChatView();
    if (!active) {
      return false;
    }
    return this.resetContextPackInViewInput(active);
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
          this.updateChatQuickControls(view);
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
      this.updateChatQuickControls(view);
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
      const built = await this.createContextPackFromSelections([folder], []);
      if (!built.reference) {
        new Notice("Local Gate: no markdown notes found in selected folder.");
        return;
      }
      try {
        const inserted = await this.copyMentionsAndTryInsertToChat(built.reference);
        new Notice(
          `Local Gate: context pack from "${folder}" -> ${built.packId} (${built.count} files)` +
            (inserted ? " and inserted into active chat." : ". Auto-insert unavailable, paste manually.") +
            (built.truncated ? ` (limited to ${built.count}/${built.total})` : "")
        );
      } catch (error) {
        new Notice(`Local Gate: failed to create context pack (${error.message}).`);
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
      .map((profile, index) =>
        sanitizeProfile(profile, index, {
          allowNonToolsChatModels: this.settings.allowNonToolsChatModels,
        })
      )
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
    const normalized = sanitizeProfile(profile, 0, {
      allowNonToolsChatModels: this.settings.allowNonToolsChatModels,
    });
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
        existingIndex,
        {
          allowNonToolsChatModels: this.settings.allowNonToolsChatModels,
        }
      );
      return this.settings.profiles[existingIndex];
    }

    const normalized = sanitizeProfile(profile, this.settings.profiles.length, {
      allowNonToolsChatModels: this.settings.allowNonToolsChatModels,
    });
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
    const diagnostics = [];

    if (!this.settings.enableOllamaScan && !this.settings.enableLmStudioScan) {
      this.settings.lastScanErrors = ["Both provider scans are disabled."];
      this.settings.lastScanSummary = "No provider enabled.";
      this.settings.lastScanDiagnostics = [];
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
        found.push(...ollama.models);
        if (ollama.diagnostic) {
          diagnostics.push(ollama.diagnostic);
        }
      } catch (error) {
        errors.push(`Ollama: ${error.message}`);
      }
    }

    if (this.settings.enableLmStudioScan) {
      try {
        const lm = await this.scanLmStudioModels();
        found.push(...lm.models);
        if (lm.diagnostic) {
          diagnostics.push(lm.diagnostic);
        }
      } catch (error) {
        errors.push(`LM Studio: ${error.message}`);
      }
    }

    this.settings.discoveredModels = normalizeDiscoveredModels(found, {
      allowNonToolsChatModels: this.settings.allowNonToolsChatModels,
    }).map((model, index) =>
      sanitizeDiscoveredModel(
        {
          ...model,
          capabilities: inferModelCapabilities(model.provider, model.model, model.capabilities),
        },
        index,
        {
          allowNonToolsChatModels: this.settings.allowNonToolsChatModels,
        }
      )
    );
    const discoveredKeys = new Set(this.settings.discoveredModels.map((model) => model.key));
    this.settings.hiddenDiscoveredModelKeys = this.settings.hiddenDiscoveredModelKeys.filter((key) =>
      discoveredKeys.has(key)
    );
    this.settings.lastScanErrors = errors;
    this.settings.lastScanDiagnostics = diagnostics;
    this.settings.lastScanAt = new Date().toLocaleString();
    const blockedCount = this.settings.discoveredModels.filter((model) => !model.compatible).length;
    const readyCount = this.settings.discoveredModels.length - blockedCount;
    this.settings.lastScanSummary =
      `Discovered ${this.settings.discoveredModels.length} model(s). ` +
      `Ready ${readyCount}, blocked ${blockedCount}.`;

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
    const endpoint = toOpenAiEndpoint("ollama", this.settings.ollamaBaseUrl);
    const apiBase = normalizeOllamaBaseUrl(this.settings.ollamaBaseUrl);
    const resolvedOllama = await resolveExecutable(this.settings.ollamaCommand || "ollama", [
      "/opt/homebrew/bin/ollama",
      "/usr/local/bin/ollama",
    ]);
    let listedNames = [];
    let listSource = "cli-list";

    try {
      const listOutput = await runCommand(resolvedOllama, ["list"], 8000);
      const lines = listOutput
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      listedNames = [...new Set(lines.slice(1).map((line) => line.split(/\s+/)[0]).filter(Boolean))];
    } catch (_error) {
    }

    if (listedNames.length === 0) {
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
      listedNames = [...new Set(list.map((entry) => sanitizeString(entry && (entry.model || entry.name), "")).filter(Boolean))];
      listSource = "http-tags";
    }

    if (listedNames.length === 0) {
      throw new Error("No models found from ollama list/api/tags");
    }

    const models = [];
    let fromJson = 0;
    let fromText = 0;
    let fromHttp = 0;
    let inferredOnly = 0;

    for (const modelName of listedNames) {
      let capabilities = [];
      let contextLength = "";
      let discoverySource = "";

      try {
        const showJsonOutput = await runCommand(resolvedOllama, ["show", modelName, "--json"], 6000);
        const parsedJson = parseOllamaShowJson(showJsonOutput);
        if (parsedJson) {
          capabilities = sanitizeStringArray(parsedJson.capabilities);
          contextLength = sanitizeString(parsedJson.contextLength, "");
          discoverySource = "ollama-cli-show-json";
          fromJson += 1;
        }
      } catch (_error) {
      }

      if (!discoverySource) {
        try {
          const showOutput = await runCommand(resolvedOllama, ["show", modelName], 6000);
          const parsedText = parseOllamaShow(showOutput);
          if (parsedText.capabilities.length > 0 || parsedText.contextLength) {
            capabilities = sanitizeStringArray(parsedText.capabilities);
            contextLength = sanitizeString(parsedText.contextLength, "");
            discoverySource = "ollama-cli-show-text";
            fromText += 1;
          }
        } catch (_error) {
        }
      }

      if (!discoverySource) {
        try {
          const showResponse = await requestUrl({
            url: `${apiBase}/api/show`,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: modelName }),
            throw: false,
          });
          if (showResponse.status < 400) {
            const parsedHttp = parseOllamaShowJson(JSON.stringify(showResponse.json || {}));
            if (parsedHttp) {
              capabilities = sanitizeStringArray(parsedHttp.capabilities);
              contextLength = sanitizeString(parsedHttp.contextLength, "");
              discoverySource = "ollama-http-show";
              fromHttp += 1;
            }
          }
        } catch (_error) {
        }
      }

      if (!discoverySource) {
        discoverySource = "inferred-from-name";
        inferredOnly += 1;
      }

      models.push({
        key: `ollama:${modelName}`,
        provider: "ollama",
        model: modelName,
        endpoint,
        capabilities: inferModelCapabilities("ollama", modelName, capabilities),
        contextLength,
        discoverySource,
        detectionState: "detected",
      });
    }

    const diagnostic =
      `Ollama list ${listedNames.length} / detected ${models.length} / undetected ${Math.max(0, listedNames.length - models.length)}` +
      ` (source: ${listSource}, capability json ${fromJson}, text ${fromText}, http ${fromHttp}, inferred ${inferredOnly})`;
    return { models, diagnostic };
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
        const discovered = models
          .map((entry) => sanitizeString(entry && entry.id, ""))
          .filter(Boolean)
          .map((modelId) => ({
            key: `lmstudio:${modelId}`,
            provider: "lmstudio",
            model: modelId,
            endpoint: base,
            capabilities: ["completion"],
            contextLength: "",
            discoverySource: "lmstudio-http-models",
            detectionState: "detected",
          }));
        return {
          models: discovered,
          diagnostic: `LM Studio list ${discovered.length} / detected ${discovered.length} / undetected 0 (source: ${url})`,
        };
      } catch (error) {
        lastError = error.message;
      }
    }

    throw new Error(lastError || "LM Studio endpoint not reachable");
  }

  resolveWireApiForModel(provider, modelName, capabilities = []) {
    const normalizedProvider = sanitizeString(provider, "");
    const loweredModel = sanitizeString(modelName, "").toLowerCase();
    const caps = normalizeCapabilities(capabilities);
    const hasVision =
      caps.includes("vision") ||
      /(vision|llava|pixtral|qwen2\.5[-:]?vl|minicpm-v|moondream|janus)/i.test(loweredModel);
    if (hasVision && this.settings.preferChatCompletionsForVision !== false) {
      return "chat_completions";
    }
    if (normalizedProvider === "ollama" || normalizedProvider === "lmstudio") {
      return "responses";
    }
    return "responses";
  }

  resolveWireApiForProfile(profile) {
    const normalized = sanitizeProfile(profile, 0, {
      allowNonToolsChatModels: this.settings.allowNonToolsChatModels,
    });
    return this.resolveWireApiForModel(normalized.provider, normalized.model, normalized.capabilities);
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
      .map((entry, index) =>
        sanitizeProfile(entry, index, {
          allowNonToolsChatModels: this.settings.allowNonToolsChatModels,
        })
      )
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
      .map((entry, index) =>
        sanitizeProfile(entry, index, {
          allowNonToolsChatModels: this.settings.allowNonToolsChatModels,
        })
      )
      .find((entry) => sanitizeString(entry.model, deriveModelName(entry)) === model);
    if (profile) {
      return sanitizeString(profile.provider, "");
    }

    if (model.includes(":")) {
      return "ollama";
    }
    return "";
  }

  findProfileForProviderModel(provider, model) {
    const safeProvider = sanitizeString(provider, "");
    const safeModel = sanitizeString(model, "");
    if (!safeProvider || !safeModel) {
      return null;
    }
    const normalizedProfiles = this.settings.profiles.map((entry, index) =>
      sanitizeProfile(entry, index, {
        allowNonToolsChatModels: this.settings.allowNonToolsChatModels,
      })
    );
    const exact = normalizedProfiles.find(
      (entry) => entry.provider === safeProvider && sanitizeString(entry.model, deriveModelName(entry)) === safeModel
    );
    if (exact) {
      return exact;
    }

    const discovered = this.settings.discoveredModels.find(
      (entry) => entry.provider === safeProvider && sanitizeString(entry.model, "") === safeModel
    );
    if (discovered) {
      return sanitizeProfile(this.createProfileFromDiscovered(discovered), 0, {
        allowNonToolsChatModels: this.settings.allowNonToolsChatModels,
      });
    }

    return sanitizeProfile(
      {
        id: `${safeProvider}-${slugify(safeModel) || "model"}-adhoc`,
        name: `${providerLabel(safeProvider)}: ${safeModel}`,
        provider: safeProvider,
        model: safeModel,
        endpoint: this.getProviderEndpoint(safeProvider, null),
        capabilities: inferModelCapabilities(safeProvider, safeModel, []),
        command: this.settings.codexAcpCommand || "codex-acp",
        args: buildLocalCodexArgs(safeModel, this.getProviderEndpoint(safeProvider, null)),
        env: [],
        setAsDefaultAgent: true,
      },
      0,
      {
        allowNonToolsChatModels: this.settings.allowNonToolsChatModels,
      }
    );
  }

  async syncSelectedModelFromView(view, silent = true) {
    if (this.__localGateModelSyncInFlight) {
      return false;
    }
    const provider = this.resolveProviderForView(view);
    if (!provider || (provider !== "ollama" && provider !== "lmstudio")) {
      return false;
    }
    const currentModelRaw = this.getCurrentModelFromView(view);
    const currentModel = sanitizeString(this.normalizeModelOptionKey(currentModelRaw), "");
    if (!currentModel) {
      return false;
    }

    if (!this.__localGateModelSyncState) {
      this.__localGateModelSyncState = {};
    }
    const previous = sanitizeString(this.__localGateModelSyncState[provider], "");
    if (previous === currentModel) {
      return false;
    }

    const profile = this.findProfileForProviderModel(provider, currentModel);
    if (!profile || !profile.compatible) {
      return false;
    }

    this.__localGateModelSyncInFlight = true;
    try {
      await this.enforceProviderAgentModel(profile);
      this.settings.activeProfileByProvider[provider] = profile.id;
      await this.saveSettings();
      this.__localGateModelSyncState[provider] = currentModel;
      if (!silent) {
        new Notice(`Local Gate: applied selected model ${currentModel} (${providerLabel(provider)}).`);
      }
      return true;
    } catch (_error) {
      return false;
    } finally {
      this.__localGateModelSyncInFlight = false;
    }
  }

  async syncSelectedModelFromActiveView(silent = true) {
    const view = this.getActiveAgentClientChatView();
    if (!view) {
      return false;
    }
    return this.syncSelectedModelFromView(view, silent);
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

  patchModelSelectionSetterOnTarget(target, methodName, viewRef = null) {
    if (!target || typeof target[methodName] !== "function") {
      return false;
    }
    const original = target[methodName];
    if (original.__localGateModelSelectionPatched === true) {
      return false;
    }
    const plugin = this;
    const wrapped = function(...args) {
      const result = original.apply(this, args);
      const currentView = viewRef || this;
      const trigger = () => {
        plugin.syncSelectedModelFromView(currentView, true).catch(() => {});
      };
      if (result && typeof result.then === "function") {
        return result.finally(trigger);
      }
      trigger();
      return result;
    };
    wrapped.__localGateModelSelectionPatched = true;
    wrapped.__localGateOriginal = original;
    target[methodName] = wrapped;
    return true;
  }

  patchAgentClientModelSelectionHooks(plugin = this.getAgentClientPlugin()) {
    if (!plugin) {
      return false;
    }
    let patched = false;
    const selectionMethods = [
      "setSelectedModel",
      "setModel",
      "setModelId",
      "setCurrentModel",
      "selectModel",
      "updateModel",
      "updateSelectedModel",
      "handleModelChange",
      "onModelChange",
      "handleModelSelect",
    ];

    selectionMethods.forEach((methodName) => {
      if (this.patchModelSelectionSetterOnTarget(plugin, methodName, this.getActiveAgentClientChatView())) {
        patched = true;
      }
    });

    const views = typeof plugin.getAllChatViews === "function" ? plugin.getAllChatViews() : [];
    if (Array.isArray(views)) {
      views.forEach((view) => {
        selectionMethods.forEach((methodName) => {
          if (this.patchModelSelectionSetterOnTarget(view, methodName, view)) {
            patched = true;
          }
        });
      });
    }
    return patched;
  }

  resolveRuntimeContextForView(view) {
    const provider = sanitizeString(this.resolveProviderForView(view), "");
    const model = sanitizeString(this.normalizeModelOptionKey(this.getCurrentModelFromView(view)), "");
    if (!provider || !model) {
      return {
        provider,
        model,
        wireApi: "responses",
        isVision: false,
      };
    }
    const profile = this.findProfileForProviderModel(provider, model);
    const wireApi = profile
      ? this.resolveWireApiForProfile(profile)
      : this.resolveWireApiForModel(provider, model, inferModelCapabilities(provider, model, []));
    return {
      provider,
      model,
      wireApi,
      isVision: wireApi === "chat_completions",
    };
  }

  collectMutableSendObjects(sendArgs) {
    const out = [];
    const seen = new Set();
    const push = (value) => {
      if (!isPlainObject(value) || seen.has(value)) {
        return;
      }
      seen.add(value);
      out.push(value);
    };
    const visit = (value, depth = 0) => {
      if (depth > 4 || value == null) {
        return;
      }
      if (Array.isArray(value)) {
        value.slice(0, 20).forEach((item) => visit(item, depth + 1));
        return;
      }
      if (!isPlainObject(value)) {
        return;
      }
      push(value);
      const nestedKeys = [
        "payload",
        "request",
        "options",
        "config",
        "body",
        "data",
        "input",
        "message",
        "messages",
        "params",
        "args",
        "requestOptions",
        "chatRequest",
        "completionRequest",
      ];
      nestedKeys.forEach((key) => {
        if (key in value) {
          visit(value[key], depth + 1);
        }
      });
    };
    if (Array.isArray(sendArgs)) {
      sendArgs.forEach((arg) => visit(arg, 0));
    } else {
      visit(sendArgs, 0);
    }
    return out;
  }

  applyToolSuppressionInPayload(value, depth = 0, seen = new Set()) {
    if (depth > 5 || value == null || typeof value !== "object" || seen.has(value)) {
      return;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      value.slice(0, 24).forEach((item) => this.applyToolSuppressionInPayload(item, depth + 1, seen));
      return;
    }
    if (!isPlainObject(value)) {
      return;
    }

    value.localGateContextOnly = true;
    value.tool_choice = "none";
    value.toolChoice = "none";
    value.disableTools = true;
    if ("allowTools" in value) {
      value.allowTools = false;
    }
    if ("enableTools" in value) {
      value.enableTools = false;
    }
    if ("toolsEnabled" in value) {
      value.toolsEnabled = false;
    }
    if (Array.isArray(value.tools)) {
      value.tools = [];
    }
    if (Array.isArray(value.availableTools)) {
      value.availableTools = [];
    }
    if (Array.isArray(value.enabledTools)) {
      value.enabledTools = [];
    }
    if (isPlainObject(value.options)) {
      if ("allowTools" in value.options) {
        value.options.allowTools = false;
      }
      if ("enableTools" in value.options) {
        value.options.enableTools = false;
      }
      if (Array.isArray(value.options.tools)) {
        value.options.tools = [];
      }
    }

    [
      "payload",
      "request",
      "options",
      "config",
      "body",
      "data",
      "input",
      "message",
      "messages",
      "params",
      "args",
      "requestOptions",
      "chatRequest",
      "completionRequest",
    ].forEach((key) => {
      if (key in value) {
        this.applyToolSuppressionInPayload(value[key], depth + 1, seen);
      }
    });
  }

  applyThinkingSuppressionInPayload(value, depth = 0, seen = new Set()) {
    if (depth > 5 || value == null || typeof value !== "object" || seen.has(value)) {
      return;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      value.slice(0, 24).forEach((item) => this.applyThinkingSuppressionInPayload(item, depth + 1, seen));
      return;
    }
    if (!isPlainObject(value)) {
      return;
    }

    [
      "thinking",
      "include_thinking",
      "includeThinking",
      "show_thinking",
      "showThinking",
      "show_reasoning",
      "showReasoning",
      "reasoning_enabled",
      "reasoningEnabled",
      "include_reasoning",
      "includeReasoning",
      "return_reasoning",
      "returnReasoning",
      "think",
    ].forEach((key) => {
      if (key in value) {
        value[key] = false;
      }
    });

    if ("reasoning" in value) {
      if (typeof value.reasoning === "boolean") {
        value.reasoning = false;
      } else if (isPlainObject(value.reasoning)) {
        if ("enabled" in value.reasoning) {
          value.reasoning.enabled = false;
        }
        if ("include" in value.reasoning) {
          value.reasoning.include = false;
        }
      }
    }
    if (isPlainObject(value.options)) {
      if ("think" in value.options) {
        value.options.think = false;
      }
      if ("include_thinking" in value.options) {
        value.options.include_thinking = false;
      }
      if ("includeThinking" in value.options) {
        value.options.includeThinking = false;
      }
    }

    [
      "payload",
      "request",
      "options",
      "config",
      "body",
      "data",
      "input",
      "message",
      "messages",
      "params",
      "args",
      "requestOptions",
      "chatRequest",
      "completionRequest",
      "reasoning",
    ].forEach((key) => {
      if (key in value) {
        this.applyThinkingSuppressionInPayload(value[key], depth + 1, seen);
      }
    });
  }

  applySendRuntimeGuards(sendArgs, runtimeContext, inlineContextOnly) {
    const wireApi = sanitizeString(runtimeContext && runtimeContext.wireApi, "");
    const model = sanitizeString(runtimeContext && runtimeContext.model, "");
    const forceToollessSend = inlineContextOnly && this.settings.contextPackForceToollessSend !== false;
    const suppressThinkingSignals = this.settings.suppressThinkingSignals !== false;
    this.collectMutableSendObjects(sendArgs).forEach((entry) => {
      const hasRequestShape = [
        "messages",
        "input",
        "prompt",
        "text",
        "model",
        "wire_api",
        "wireApi",
        "tools",
        "tool_choice",
        "toolChoice",
        "request",
        "payload",
        "options",
        "data",
      ].some((key) => key in entry);
      if (!hasRequestShape) {
        return;
      }
      if (wireApi) {
        entry.wire_api = wireApi;
        entry.wireApi = wireApi;
        if ("apiMode" in entry && typeof entry.apiMode === "string") {
          entry.apiMode = wireApi;
        }
        if ("api_mode" in entry && typeof entry.api_mode === "string") {
          entry.api_mode = wireApi;
        }
      }
      if (model) {
        if ("model" in entry && typeof entry.model === "string") {
          entry.model = model;
        }
        if ("selectedModel" in entry && typeof entry.selectedModel === "string") {
          entry.selectedModel = model;
        }
      }
      if (inlineContextOnly) {
        entry.localGateContextOnly = true;
      }
      if (forceToollessSend) {
        this.applyToolSuppressionInPayload(entry);
      }
      if (suppressThinkingSignals) {
        this.applyThinkingSuppressionInPayload(entry);
      }
    });
  }

  countImageHints(value) {
    const queue = [value];
    const seen = new Set();
    let scanned = 0;
    let count = 0;
    while (queue.length > 0 && scanned < 160) {
      const current = queue.shift();
      scanned += 1;
      if (current == null) {
        continue;
      }
      if (typeof current !== "object") {
        continue;
      }
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      if (Array.isArray(current)) {
        current.slice(0, 20).forEach((item) => queue.push(item));
        continue;
      }
      const type = sanitizeString(current.type, "").toLowerCase();
      const mime = sanitizeString(current.mimeType || current.mime_type || current.mimetype, "").toLowerCase();
      if (
        type.includes("image") ||
        mime.startsWith("image/") ||
        "image" in current ||
        "image_url" in current ||
        "imageUrl" in current
      ) {
        count += 1;
      }
      ["images", "image", "image_url", "imageUrl", "input_image", "content", "attachments", "messages", "parts", "input", "data"].forEach((key) => {
        if (key in current) {
          queue.push(current[key]);
        }
      });
    }
    return count;
  }

  extractSendPayloadShape(sendArgs, view) {
    const objects = this.collectMutableSendObjects(sendArgs);
    const keys = new Set();
    objects.forEach((entry) => {
      Object.keys(entry).slice(0, 20).forEach((key) => keys.add(key));
    });
    let stateImageCount = 0;
    if (view && typeof view.getInputState === "function") {
      try {
        const state = view.getInputState() || {};
        stateImageCount = Array.isArray(state.images) ? state.images.length : 0;
      } catch (_error) {
      }
    }
    return {
      argCount: Array.isArray(sendArgs) ? sendArgs.length : 0,
      objectCount: objects.length,
      keys: Array.from(keys).slice(0, 24),
      imageLikeCount: this.countImageHints(sendArgs),
      stateImageCount,
    };
  }

  logSendDiagnostics(level, payload) {
    const entry = { ...payload, ts: new Date().toISOString() };
    try {
      if (level === "error") {
        console.error("[Local Gate][send]", entry);
      } else {
        console.info("[Local Gate][send]", entry);
      }
    } catch (_error) {
    }
  }

  prepareSendPreflight(view, sendArgs, methodName = "") {
    const currentView = view || this.getActiveAgentClientChatView();
    if (currentView) {
      this.expandContextPackInViewInput(currentView) || this.expandContextPackInActiveChatInput();
    }
    const sanitized = this.sanitizeInlineContextInViewInput(currentView);
    const runtimeContext = this.resolveRuntimeContextForView(currentView);
    this.applySendRuntimeGuards(sendArgs, runtimeContext, sanitized.inlineContextOnly);
    const payloadShape = this.extractSendPayloadShape(sendArgs, currentView);
    const shouldTrace = sanitized.inlineContextOnly || runtimeContext.isVision || payloadShape.imageLikeCount > 0;
    if (shouldTrace) {
      this.logSendDiagnostics("info", {
        phase: "before-send",
        method: sanitizeString(methodName, ""),
        provider: runtimeContext.provider || "unknown",
        model: runtimeContext.model || "unknown",
        wireApi: runtimeContext.wireApi || "responses",
        inlineContextOnly: sanitized.inlineContextOnly,
        payloadShape,
      });
    }
    const syncPromise = currentView
      ? this.syncSelectedModelFromView(currentView, true).catch(() => false)
      : Promise.resolve(false);
    return {
      currentView,
      runtimeContext,
      inlineContextOnly: sanitized.inlineContextOnly,
      payloadShape,
      syncPromise,
    };
  }

  patchContextSendMethodOnTarget(target, methodName, viewRef = null) {
    if (!target || typeof target[methodName] !== "function") {
      return false;
    }
    const original = target[methodName];
    if (original.__localGateContextPackPatched === true) {
      return false;
    }
    const plugin = this;
    const isAsyncFunction = original && original.constructor && original.constructor.name === "AsyncFunction";
    const wrapped = function(...args) {
      const currentView = viewRef || this;
      const preflight = plugin.prepareSendPreflight(currentView, args, methodName);
      const runOriginal = () => {
        try {
          const result = original.apply(this, args);
          if (result && typeof result.then === "function") {
            return result.catch((error) => {
              plugin.logSendDiagnostics("error", {
                phase: "send-failed",
                method: sanitizeString(methodName, ""),
                provider: preflight.runtimeContext.provider || "unknown",
                model: preflight.runtimeContext.model || "unknown",
                wireApi: preflight.runtimeContext.wireApi || "responses",
                inlineContextOnly: preflight.inlineContextOnly,
                payloadShape: preflight.payloadShape,
                error: sanitizeString(error && error.message, String(error || "unknown error")),
              });
              throw error;
            });
          }
          return result;
        } catch (error) {
          plugin.logSendDiagnostics("error", {
            phase: "send-failed",
            method: sanitizeString(methodName, ""),
            provider: preflight.runtimeContext.provider || "unknown",
            model: preflight.runtimeContext.model || "unknown",
            wireApi: preflight.runtimeContext.wireApi || "responses",
            inlineContextOnly: preflight.inlineContextOnly,
            payloadShape: preflight.payloadShape,
            error: sanitizeString(error && error.message, String(error || "unknown error")),
          });
          throw error;
        }
      };
      if (isAsyncFunction) {
        return preflight.syncPromise.catch(() => false).then(() => runOriginal());
      }
      preflight.syncPromise.catch(() => {});
      return runOriginal();
    };
    wrapped.__localGateContextPackPatched = true;
    wrapped.__localGateOriginal = original;
    target[methodName] = wrapped;
    return true;
  }

  patchContextPackSendHooks(plugin = this.getAgentClientPlugin()) {
    if (!plugin) {
      return false;
    }
    let patched = false;
    const sendMethodCandidates = [
      "sendMessage",
      "sendPrompt",
      "submitPrompt",
      "submitInput",
      "submitMessage",
      "sendCurrentMessage",
      "sendInput",
      "onSendMessage",
      "onSendClick",
      "handleSubmit",
      "handleSend",
      "onSubmit",
      "triggerSend",
      "requestAssistantReply",
      "runPrompt",
    ];

    const activeView = this.getActiveAgentClientChatView();
    if (activeView && this.bindContextPackDomHooks(activeView)) {
      patched = true;
    }

    sendMethodCandidates.forEach((methodName) => {
      if (this.patchContextSendMethodOnTarget(plugin, methodName, this.getActiveAgentClientChatView())) {
        patched = true;
      }
    });

    const views = typeof plugin.getAllChatViews === "function" ? plugin.getAllChatViews() : [];
    if (Array.isArray(views)) {
      views.forEach((view) => {
        if (this.bindContextPackDomHooks(view)) {
          patched = true;
        }
        sendMethodCandidates.forEach((methodName) => {
          if (this.patchContextSendMethodOnTarget(view, methodName, view)) {
            patched = true;
          }
        });
      });
    }
    return patched;
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
    const normalized = sanitizeProfile(profile, 0, {
      allowNonToolsChatModels: this.settings.allowNonToolsChatModels,
    });
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
    const wireApi = this.resolveWireApiForProfile(normalized);
    const nextArgs = [...launch.argsPrefix, ...buildProviderCodexArgs(provider, endpoint, model, { wireApi })];
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
    await this.persistAgentClientSettings(path, data, {
      runtimeExpectation: {
        provider,
        model,
        wireApi,
      },
    });
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
    this.patchAgentClientModelSelectionHooks(plugin);
    this.patchContextPackSendHooks(plugin);
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

  runtimeExpectationNeedsRestart(runtimeExpectation) {
    if (!runtimeExpectation || typeof runtimeExpectation !== "object") {
      return false;
    }
    const expectedProvider = sanitizeString(runtimeExpectation.provider, "");
    const expectedModel = sanitizeString(runtimeExpectation.model, "");
    const expectedWireApi = sanitizeString(runtimeExpectation.wireApi, "").toLowerCase();
    if (!expectedProvider || !expectedModel) {
      return false;
    }
    const view = this.getActiveAgentClientChatView();
    if (!view) {
      return false;
    }
    const currentProvider = sanitizeString(this.resolveProviderForView(view), "");
    if (!currentProvider || currentProvider !== expectedProvider) {
      return false;
    }
    const currentModel = sanitizeString(this.normalizeModelOptionKey(this.getCurrentModelFromView(view)), "");
    if (currentModel && currentModel !== expectedModel) {
      return true;
    }
    if (expectedWireApi) {
      const currentAgent = this.getCurrentAgentFromView(view) || {};
      const args = sanitizeStringArray(currentAgent.args);
      if (args.length > 0) {
        const hasWireApi = args.some((entry) => {
          const lowered = sanitizeString(entry, "").toLowerCase();
          return lowered.includes("wire_api") && lowered.includes(expectedWireApi);
        });
        if (!hasWireApi) {
          return true;
        }
      }
    }
    return false;
  }

  async updateAgentClientRuntime(settingsObject, options = {}) {
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
      this.patchAgentClientModelSelectionHooks(plugin);
      const refreshed = await this.refreshAgentClientViews(plugin, nextSettings);
      const needsRestart = this.runtimeExpectationNeedsRestart(options.runtimeExpectation);
      if (!refreshed || needsRestart) {
        await this.restartAgentClientSessions(plugin);
      }
    }

    return updated;
  }

  async persistAgentClientSettings(path, data, options = {}) {
    await this.updateAgentClientRuntime(data, options);
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
    const normalizedProfiles = this.settings.profiles.map((profile, index) =>
      sanitizeProfile(profile, index, {
        allowNonToolsChatModels: this.settings.allowNonToolsChatModels,
      })
    );
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
        const wireApi = this.resolveWireApiForProfile(preferredProfile);
        const baseEnv = sanitizeStringArray(preferredProfile.env);
        if (!baseEnv.some((entry) => entry.startsWith("PATH="))) {
          baseEnv.unshift(`PATH=${buildExecPathEnv()}`);
        }

        this.settings.activeProfileByProvider[provider] = preferredProfile.id;
        return {
          id: this.toProviderAgentId(provider),
          displayName: providerAgentDisplayName(provider),
          command: launch.command,
          args: [...launch.argsPrefix, ...buildProviderCodexArgs(provider, endpoint, selectedModel, { wireApi })],
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
