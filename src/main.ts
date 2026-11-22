import { Notice, Plugin, TFolder, type EventRef, type View } from "obsidian";
import { actionLabel, Explorer, type ToggleRow } from "./explorer";
import { DEFAULT_SETTINGS, FolderLimitSettingTab, readData, type DisplaySettings } from "./settings";

interface CommunityPlugins {
  enabledPlugins?: Set<string>;
  on?(name: "changed", callback: () => void): EventRef;
}

export default class FolderLimitEnhanced extends Plugin {
  settings = { ...DEFAULT_SETTINGS };
  private readonly expanded = new Set<string>();
  private readonly explorers = new Map<View, Explorer>();
  private active = false;
  private conflictReported = false;
  private conflictAtLastSync = false;
  private saves = Promise.resolve();

  async onload(): Promise<void> {
    const data = readData(await this.loadData());
    this.settings = data.settings;
    if (this.settings.rememberExpanded) {
      for (const path of data.expanded) this.expanded.add(path);
    }

    this.active = true;
    this.addSettingTab(new FolderLimitSettingTab(this.app, this));
    const { workspace, vault } = this.app;
    workspace.onLayoutReady(() => this.syncExplorers());
    this.registerEvent(workspace.on("layout-change", () => this.syncExplorers()));
    this.registerEvent(workspace.on("active-leaf-change", () => this.syncExplorers()));
    const plugins = this.communityPlugins();
    if (typeof plugins?.on === "function") {
      this.registerEvent(plugins.on("changed", () => this.syncExplorers()));
    }
    this.registerEvent(workspace.on("file-menu", (menu, file, source) => {
      if (source !== "file-explorer-context-menu" || this.settings.showButton
        || this.originalEnabled() || !(file instanceof TFolder)) return;
      for (const explorer of this.explorers.values()) {
        const remaining = explorer.remaining(file);
        if (!remaining) continue;
        menu.addItem((item) => item
          .setTitle(actionLabel(this.settings, this.expanded.has(file.path), remaining))
          .onClick(() => this.setExpanded(file, !this.expanded.has(file.path))));
        break;
      }
    }));

    this.registerEvent(vault.on("rename", (file, oldPath) => {
      if (file instanceof TFolder) this.moveExpandedPaths(oldPath, file.path);
    }));
    this.registerEvent(vault.on("delete", (file) => {
      if (!(file instanceof TFolder)) return;
      for (const explorer of this.explorers.values()) explorer.forgetFolder(file.path);
      this.moveExpandedPaths(file.path);
    }));
  }

  onunload(): void {
    this.active = false;
    for (const explorer of this.explorers.values()) explorer.dispose();
    this.explorers.clear();
  }

  originalEnabled(): boolean {
    return this.communityPlugins()?.enabledPlugins?.has?.("folder-limit") === true;
  }

  updateSettings(changes: Partial<DisplaySettings>): void {
    this.settings = { ...this.settings, ...changes };
    for (const explorer of this.explorers.values()) explorer.refresh();
    this.persist();
  }

  private syncExplorers(): void {
    if (!this.active || !this.app.workspace.layoutReady) return;
    const conflict = this.suspended();
    if (this.conflictAtLastSync !== conflict) {
      this.conflictAtLastSync = conflict;
      for (const explorer of this.explorers.values()) explorer.refresh();
    }

    const views = new Set(this.app.workspace.getLeavesOfType("file-explorer").map((leaf) => leaf.view));
    for (const [view, explorer] of this.explorers) {
      if (!views.has(view)) {
        explorer.dispose();
        this.explorers.delete(view);
      }
    }
    for (const view of views) {
      if (this.explorers.has(view)) continue;
      const explorer = Explorer.attach(view, {
        settings: () => this.settings,
        suspended: () => this.suspended(),
        expanded: (path) => this.expanded.has(path),
        setExpanded: (folder, expanded, focus) => this.setExpanded(folder, expanded, focus),
      });
      if (explorer) this.explorers.set(view, explorer);
    }
  }

  private communityPlugins(): CommunityPlugins | undefined {
    // The community-plugin manager has no public API for querying enabled IDs.
    return (this.app as unknown as { plugins?: CommunityPlugins }).plugins;
  }

  private suspended(): boolean {
    const conflict = this.originalEnabled();
    if (conflict && !this.conflictReported) {
      new Notice("Folder Limit Enhanced は表示制限を停止しました。使用するには元の Folder Limit を無効にしてください。");
    }
    this.conflictReported = conflict;
    return conflict;
  }

  private setExpanded(folder: TFolder, expanded: boolean, focus?: ToggleRow): void {
    if (!this.active || this.suspended()) return;
    if (expanded) this.expanded.add(folder.path);
    else this.expanded.delete(folder.path);
    for (const explorer of this.explorers.values()) explorer.updateFolder(folder, focus);
    if (this.settings.rememberExpanded) this.persist();
  }

  private moveExpandedPaths(oldPath: string, newPath?: string): void {
    const paths = [...this.expanded].filter((path) => path === oldPath || path.startsWith(oldPath + "/"));
    if (!paths.length) return;
    for (const path of paths) {
      this.expanded.delete(path);
      if (newPath) this.expanded.add(newPath + path.slice(oldPath.length));
    }
    if (this.settings.rememberExpanded) this.persist();
  }

  private persist(): void {
    const snapshot = {
      ...this.settings,
      expanded: this.settings.rememberExpanded ? [...this.expanded] : [],
    };
    this.saves = this.saves.then(() => this.saveData(snapshot)).catch((error: unknown) => {
      console.error("Folder Limit Enhanced: could not save settings", error);
      if (this.active) new Notice("Folder Limit Enhanced の設定を保存できませんでした。");
    });
  }
}
