"use strict";

const {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SuggestModal,
  normalizePath,
} = require("obsidian");

const DEFAULT_PROFILES = [
  {
    id: "ollama-gpt-oss-20b",
    name: "Ollama: gpt-oss:20b",
    command: "codex-acp",
    args: [
      "-c",
      "model_provider=\"local\"",
      "-c",
      "model=\"gpt-oss:20b\"",
      "-c",
      "model_providers.local.name=\"local\"",
      "-c",
      "model_providers.local.base_url=\"http://localhost:11434/v1\"",
    ],
    env: [],
    setAsDefaultAgent: true,
  },
  {
    id: "ollama-qwen2.5-coder",
    name: "Ollama: qwen2.5-coder",
    command: "codex-acp",
    args: [
      "-c",
      "model_provider=\"local\"",
      "-c",
      "model=\"qwen2.5-coder:14b\"",
      "-c",
      "model_providers.local.name=\"local\"",
      "-c",
      "model_providers.local.base_url=\"http://localhost:11434/v1\"",
    ],
    env: [],
    setAsDefaultAgent: true,
  },
  {
    id: "lmstudio-default",
    name: "LM Studio: default model",
    command: "codex-acp",
    args: [
      "-c",
      "model_provider=\"local\"",
      "-c",
      "model=\"local-model\"",
      "-c",
      "model_providers.local.name=\"local\"",
      "-c",
      "model_providers.local.base_url=\"http://127.0.0.1:1234/v1\"",
    ],
    env: [],
    setAsDefaultAgent: true,
  },
];

const DEFAULT_SETTINGS = {
  agentClientSettingsPath: ".obsidian/plugins/agent-client/data.json",
  profiles: DEFAULT_PROFILES,
  lastProfileId: "ollama-gpt-oss-20b",
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

function sanitizeProfile(rawProfile, index) {
  const fallbackId = `profile-${index + 1}`;
  const id = sanitizeString(rawProfile && rawProfile.id, fallbackId);
  const name = sanitizeString(rawProfile && rawProfile.name, id);
  const command = sanitizeString(rawProfile && rawProfile.command, "codex-acp");
  const args = sanitizeStringArray(rawProfile && rawProfile.args);
  const env = sanitizeStringArray(rawProfile && rawProfile.env);
  const setAsDefaultAgent = rawProfile && rawProfile.setAsDefaultAgent !== false;

  return {
    id,
    name,
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
        profile.command.toLowerCase().includes(lowered)
      );
    });
  }

  renderSuggestion(profile, el) {
    el.createEl("div", { text: profile.name });
    el.createEl("small", { text: `${profile.id} | ${profile.command}` });
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

    containerEl.createEl("h2", { text: "Local Gate" });
    containerEl.createEl("p", {
      text: "Local Gate writes the selected local profile into Agent Client's data.json (codex section).",
    });

    new Setting(containerEl)
      .setName("Agent Client settings path")
      .setDesc("Vault-relative path to Agent Client data.json")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.agentClientSettingsPath)
          .setValue(this.plugin.settings.agentClientSettingsPath)
          .onChange(async (value) => {
            this.plugin.settings.agentClientSettingsPath =
              sanitizeString(value, DEFAULT_SETTINGS.agentClientSettingsPath);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Profile switcher")
      .setDesc("Open an interactive profile picker")
      .addButton((button) =>
        button.setButtonText("Open").onClick(() => {
          this.plugin.openProfileSwitcher();
        })
      );

    new Setting(containerEl)
      .setName("Apply last profile")
      .setDesc(`Current: ${this.plugin.settings.lastProfileId || "(none)"}`)
      .addButton((button) =>
        button.setButtonText("Apply").onClick(async () => {
          await this.plugin.applyLastProfile();
        })
      );

    containerEl.createEl("h3", { text: "Profiles" });
    this.plugin.settings.profiles.forEach((profile) => {
      new Setting(containerEl)
        .setName(profile.name)
        .setDesc(`${profile.id} | ${profile.command}`)
        .addButton((button) =>
          button.setButtonText("Apply").onClick(async () => {
            await this.plugin.applyProfile(profile);
          })
        );
    });

    let profileJsonDraft = JSON.stringify(this.plugin.settings.profiles, null, 2);

    new Setting(containerEl)
      .setName("Profiles JSON")
      .setDesc("Edit profiles as JSON array. Fields: id, name, command, args, env, setAsDefaultAgent")
      .addTextArea((textArea) => {
        textArea.setValue(profileJsonDraft);
        textArea.inputEl.rows = 18;
        textArea.inputEl.cols = 80;
        textArea.onChange((value) => {
          profileJsonDraft = value;
        });
      });

    new Setting(containerEl)
      .setName("Save profile JSON")
      .setDesc("Validate and store profile list")
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

    this.addSettingTab(new LocalGateSettingTab(this.app, this));
  }

  async loadSettings() {
    const loaded = await this.loadData();
    const normalizedProfiles = normalizeProfiles(loaded && loaded.profiles);

    this.settings = {
      agentClientSettingsPath: sanitizeString(
        loaded && loaded.agentClientSettingsPath,
        DEFAULT_SETTINGS.agentClientSettingsPath
      ),
      profiles: normalizedProfiles,
      lastProfileId: sanitizeString(
        loaded && loaded.lastProfileId,
        normalizedProfiles[0] ? normalizedProfiles[0].id : DEFAULT_SETTINGS.lastProfileId
      ),
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

  async applyProfile(profile) {
    const path = normalizePath(this.settings.agentClientSettingsPath);
    const agentSettings = await this.readOrCreateAgentClientSettings(path);

    const existingCodex = agentSettings.codex || {};
    agentSettings.codex = {
      id: sanitizeString(existingCodex.id, "codex-acp"),
      displayName: sanitizeString(existingCodex.displayName, "Codex"),
      apiKey: sanitizeString(existingCodex.apiKey, ""),
      command: sanitizeString(profile.command, "codex-acp"),
      args: sanitizeStringArray(profile.args),
      env: sanitizeStringArray(profile.env),
    };

    if (profile.setAsDefaultAgent !== false) {
      agentSettings.defaultAgentId = agentSettings.codex.id || "codex-acp";
    }

    await this.app.vault.adapter.write(path, `${JSON.stringify(agentSettings, null, 2)}\n`);

    this.settings.lastProfileId = profile.id;
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
}

module.exports = LocalGatePlugin;
