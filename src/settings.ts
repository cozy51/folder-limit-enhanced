import { App, PluginSettingTab, Setting } from "obsidian";
import type FolderLimitEnhanced from "./main";

export interface DisplaySettings {
  limit: number;
  showCount: boolean;
  showButton: boolean;
  rememberExpanded: boolean;
}

export const DEFAULT_SETTINGS: DisplaySettings = {
  limit: 20,
  showCount: true,
  showButton: true,
  rememberExpanded: true,
};

export function validLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function readData(value: unknown): {
  settings: DisplaySettings;
  expanded: string[];
} {
  const data = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  return {
    settings: {
      limit: validLimit(data.limit) ? data.limit : DEFAULT_SETTINGS.limit,
      showCount: typeof data.showCount === "boolean" ? data.showCount : DEFAULT_SETTINGS.showCount,
      showButton: typeof data.showButton === "boolean" ? data.showButton : DEFAULT_SETTINGS.showButton,
      rememberExpanded: typeof data.rememberExpanded === "boolean"
        ? data.rememberExpanded
        : DEFAULT_SETTINGS.rememberExpanded,
    },
    expanded: Array.isArray(data.expanded)
      ? data.expanded.filter((path): path is string => typeof path === "string" && path.length > 0)
      : [],
  };
}

export class FolderLimitSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly owner: FolderLimitEnhanced) {
    super(app, owner);
  }

  display(): void {
    const { containerEl, owner } = this;
    const settings = owner.settings;
    containerEl.empty();

    new Setting(containerEl)
      .setName("表示件数")
      .setDesc("各フォルダに初期表示するファイル数。1以上の整数を入力してください。")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.step = "1";
        text.setValue(String(settings.limit));
        text.inputEl.addEventListener("change", () => {
          const limit = text.inputEl.valueAsNumber;
          if (validLimit(limit)) owner.updateSettings({ limit });
          text.setValue(String(owner.settings.limit));
        });
      });

    new Setting(containerEl)
      .setName("残り件数を表示")
      .setDesc("省略中のボタンとフォルダメニューに残り件数を表示します。")
      .addToggle((toggle) => toggle.setValue(settings.showCount)
        .onChange((showCount) => owner.updateSettings({ showCount })));

    new Setting(containerEl)
      .setName("展開・省略ボタンを表示")
      .setDesc("オフの場合、フォルダの右クリックメニューから切り替えられます。")
      .addToggle((toggle) => toggle.setValue(settings.showButton)
        .onChange((showButton) => owner.updateSettings({ showButton })));

    new Setting(containerEl)
      .setName("展開状態を記憶")
      .setDesc("展開したフォルダを再起動後も復元します。オフの場合は現在のセッション内で保持します。")
      .addToggle((toggle) => toggle.setValue(settings.rememberExpanded)
        .onChange((rememberExpanded) => owner.updateSettings({ rememberExpanded })));

    if (owner.originalEnabled()) {
      containerEl.createEl("p", {
        text: "Folder Limit が有効です。このプラグインを使用するには、Folder Limit を無効にしてください。",
      });
    }
  }
}
