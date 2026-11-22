import { TFile, TFolder, type TAbstractFile, type View } from "obsidian";
import { countDirectFiles, type FolderCounts } from "./folder-counts";
import type { DisplaySettings } from "./settings";

interface VirtualInfo {
  height: number;
  width: number;
  childLeft: number;
  childLeftPadding: number;
  childTop: number;
  computed: boolean;
  queued: boolean;
  hidden: boolean;
  next: boolean;
}

interface VirtualRow {
  el: HTMLElement;
  selfEl: HTMLElement;
  file: TAbstractFile;
  parent?: VirtualFolder;
  info: VirtualInfo;
  selectable: boolean;
  shouldDisplay(): boolean;
}

interface VirtualFolder {
  vChildren: { setChildren(rows: VirtualRow[]): void };
}

interface NativeTree {
  root: VirtualFolder;
  filter: unknown;
  activeDom: VirtualRow | null;
  focusedItem: VirtualRow | null;
  selectedDoms: Set<VirtualRow>;
  setFocusedItem(item: VirtualRow | null, scroll: boolean): void;
  deselectItem(item: VirtualRow): void;
  getSelectedItems(): VirtualRow[];
  applySearchFilter(): void;
  infinityScroll: {
    invalidate(folder: VirtualFolder): void;
    scrollIntoView(item: VirtualRow, padding?: number): void;
  };
}

type ExplorerView = View & {
  ready: boolean;
  tree: NativeTree;
  navFileContainerEl: HTMLElement;
  fileItems: Record<string, VirtualRow & Partial<VirtualFolder>>;
  getSortedFolderItems(folder: TFolder): VirtualRow[];
  requestSort(): void;
  revealInFolder(file: TAbstractFile): void;
  startRenameFile(file: TAbstractFile): Promise<void>;
};

interface ExplorerHost {
  settings(): DisplaySettings;
  folderCounts(folder: TFolder): FolderCounts | undefined;
  suspended(): boolean;
  expanded(path: string): boolean;
  setExpanded(folder: TFolder, expanded: boolean, focus?: ToggleRow): void;
}

export function actionLabel(settings: DisplaySettings, expanded: boolean, remaining: number): string {
  if (expanded) return `▲ ${settings.limit}件表示に戻す`;
  return settings.showCount ? `▼ 残り${remaining}件を表示` : "▼ 全件を表示";
}

/** A leaf in the native virtual list. It is never registered as a file item. */
export class ToggleRow implements VirtualRow {
  readonly el: HTMLElement;
  readonly selfEl: HTMLButtonElement;
  readonly selectable = false;
  readonly info: VirtualInfo = {
    height: 0, width: 0, childLeft: 0, childLeftPadding: 0, childTop: 0,
    computed: false, queued: false, hidden: false, next: false,
  };
  parent?: VirtualFolder;

  constructor(doc: Document, readonly file: TFolder, private readonly activate: () => void) {
    this.el = doc.createElement("div");
    this.el.className = "tree-item folder-limit-enhanced-row";
    this.selfEl = doc.createElement("button");
    this.selfEl.type = "button";
    this.selfEl.className = "folder-limit-enhanced-toggle";
    this.selfEl.addEventListener("click", this.onSelfClick);
    for (const type of ["keydown", "keyup", "copy", "cut", "paste"]) {
      this.selfEl.addEventListener(type, this.stopTreeEvent);
    }
    this.el.append(this.selfEl);
  }

  // The built-in search must exclude this row while it restores the full list.
  shouldDisplay(): boolean {
    return false;
  }

  update(label: string, expanded: boolean): void {
    const scope = this.file.isRoot() ? "Vault直下" : `${this.file.name}直下`;
    const text = `${label}（${scope}）`;
    if (this.selfEl.textContent !== text) {
      this.selfEl.textContent = text;
      this.info.computed = false;
    }
    this.selfEl.setAttribute("aria-expanded", String(expanded));
  }

  dispose(): void {
    this.selfEl.removeEventListener("click", this.onSelfClick);
    for (const type of ["keydown", "keyup", "copy", "cut", "paste"]) {
      this.selfEl.removeEventListener(type, this.stopTreeEvent);
    }
    this.el.remove();
  }

  onSelfClick = (event: Event): void => {
    if (event.type === "keydown") event.preventDefault();
    event.stopPropagation();
    this.activate();
  };

  private stopTreeEvent = (event: Event): void => event.stopPropagation();
}

function supportedView(view: View): view is ExplorerView {
  const candidate = view as Partial<ExplorerView>;
  const tree = candidate.tree;
  return typeof candidate.getSortedFolderItems === "function"
    && typeof candidate.requestSort === "function"
    && typeof candidate.revealInFolder === "function"
    && typeof candidate.startRenameFile === "function"
    && !!candidate.fileItems && !!candidate.navFileContainerEl
    && typeof tree?.root?.vChildren?.setChildren === "function"
    && typeof tree.infinityScroll?.invalidate === "function"
    && typeof tree.infinityScroll?.scrollIntoView === "function"
    && typeof tree.setFocusedItem === "function"
    && typeof tree.deselectItem === "function"
    && typeof tree.selectedDoms?.has === "function"
    && typeof tree.getSelectedItems === "function"
    && typeof tree.applySearchFilter === "function";
}

function nativeSorter(view: ExplorerView): ExplorerView["getSortedFolderItems"] {
  const initial = view.getSortedFolderItems;
  const prototype = Object.hasOwn(view, "getSortedFolderItems") ? null : Object.getPrototypeOf(view);
  // Another plugin can wrap or restore the prototype after this view is attached.
  return (folder) => {
    const current: unknown = prototype && Reflect.get(prototype, "getSortedFolderItems", view);
    return (typeof current === "function" ? current : initial).call(view, folder);
  };
}

/** Restore an instance method without overwriting subsequent changes by other plugins. */
function wrap<T extends object, K extends keyof T>(
  target: T, key: K, factory: (original: T[K]) => T[K],
): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  const replacement = factory(target[key]);
  target[key] = replacement;
  return () => {
    if (target[key] !== replacement) return;
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  };
}

/** Adapter for the built-in file-explorer virtual tree. */
export class Explorer {
  private readonly rows = new Map<TFolder, ToggleRow>();
  private readonly badges = new Map<TFolder, { row: VirtualRow; el: HTMLElement }>();
  private readonly cleanup: (() => void)[] = [];
  private readonly sortedItems: (folder: TFolder) => VirtualRow[];
  private active = true;

  static attach(view: View, host: ExplorerHost): Explorer | null {
    return supportedView(view) ? new Explorer(view, host) : null;
  }

  private constructor(private readonly view: ExplorerView, private readonly host: ExplorerHost) {
    const tree = view.tree;
    this.sortedItems = nativeSorter(view);
    this.cleanup.push(wrap(view, "getSortedFolderItems", () => (folder) =>
      this.limitItems(folder, this.sortedItems(folder))));

    // A focused control can be activated with the tree's keyboard navigation,
    // but must never become the target of Copy, Cut, or Delete.
    this.cleanup.push(wrap(tree, "getSelectedItems", (original) => () => {
      const selection = original.call(tree);
      return this.active ? selection.filter((row) => !(row instanceof ToggleRow)) : selection;
    }));

    let searching = !!tree.filter;
    let showUnsupported = this.showUnsupported();
    this.cleanup.push(wrap(tree, "applySearchFilter", (original) => () => {
      original.call(tree);
      const changed = searching !== !!tree.filter || showUnsupported !== this.showUnsupported();
      searching = !!tree.filter;
      showUnsupported = this.showUnsupported();
      if (this.active && changed) this.refresh();
    }));

    this.cleanup.push(wrap(view, "revealInFolder", (original) => (file) => {
      this.revealLimitedFile(file);
      original.call(view, file);
    }));
    this.cleanup.push(wrap(view, "startRenameFile", (original) => (file) => {
      this.revealLimitedFile(file);
      return original.call(view, file);
    }));
    this.refresh();
  }

  refresh(): void {
    this.view.requestSort();
  }

  remaining(folder: TFolder): number {
    if (!this.active || this.host.suspended() || this.view.tree.filter) return 0;
    let count = 0;
    for (const row of this.sortedItems(folder)) {
      if (this.countsAsFile(row)) count++;
    }
    return Math.max(0, count - this.host.settings().limit);
  }

  updateFolder(folder: TFolder, focus?: ToggleRow): void {
    const { view } = this;
    const container = folder.isRoot() ? view.tree.root : view.fileItems[folder.path];
    if (!view.ready || !container || !isVirtualFolder(container)) return;

    container.vChildren.setChildren(view.getSortedFolderItems(folder));
    const scroll = view.tree.infinityScroll;
    scroll.invalidate(container);
    if (focus && this.rows.get(folder) === focus) {
      scroll.scrollIntoView(focus, 4);
      if (focus.selfEl.isConnected) focus.selfEl.focus({ preventScroll: true });
    }
  }

  forgetFolder(path: string): void {
    for (const folder of this.rows.keys()) {
      if (folder.path === path || folder.path.startsWith(path + "/")) this.removeRow(folder);
    }
    for (const folder of this.badges.keys()) {
      if (folder.path === path || folder.path.startsWith(path + "/")) this.removeBadge(folder);
    }
  }

  dispose(): void {
    this.active = false;
    for (const folder of this.rows.keys()) this.removeRow(folder);
    for (const folder of this.badges.keys()) this.removeBadge(folder);
    for (const restore of this.cleanup.reverse()) restore();
    this.refresh();
  }

  private showUnsupported(): boolean {
    return this.view.navFileContainerEl.classList.contains("show-unsupported");
  }

  private countsAsFile(row: VirtualRow): boolean {
    return row.file instanceof TFile && typeof row.shouldDisplay === "function" && row.shouldDisplay();
  }

  private limitItems(folder: TFolder, items: VirtualRow[]): VirtualRow[] {
    if (!this.active || !(folder instanceof TFolder)) return items;
    if (this.host.suspended() || !Array.isArray(items)) {
      this.removeRow(folder);
      this.removeBadge(folder);
      return items;
    }

    const settings = this.host.settings();
    const { limit, showButton } = settings;
    const searching = !!this.view.tree.filter;
    const expanded = this.host.expanded(folder.path);
    const truncate = !searching && !expanded;
    let visible: VirtualRow[] | undefined;
    let fileCount = 0;
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (this.countsAsFile(item) && ++fileCount > limit && truncate) {
        visible ??= items.slice(0, index);
        this.clearHiddenSelection(item);
      } else {
        visible?.push(item);
      }
    }

    if (settings.showFolderCounts) this.updateBadge(folder, fileCount);
    else this.removeBadge(folder);

    if (searching || fileCount <= limit || !showButton) {
      this.removeRow(folder);
      return visible ?? items;
    }

    let toggle = this.rows.get(folder);
    if (!toggle) {
      const row = new ToggleRow(this.view.containerEl.ownerDocument, folder, () => {
        if (this.active && !this.host.suspended()) {
          this.host.setExpanded(folder, !this.host.expanded(folder.path), row);
        }
      });
      this.rows.set(folder, row);
      toggle = row;
    }
    toggle.update(actionLabel(settings, expanded, fileCount - limit), expanded);
    visible ??= items.slice();
    visible.push(toggle);
    return visible;
  }

  private updateBadge(folder: TFolder, displayableCount: number): void {
    const row = this.view.fileItems[folder.path];
    let badge = this.badges.get(folder);
    if (badge && badge.row !== row) {
      this.removeBadge(folder);
      badge = undefined;
    }
    if (row?.file !== folder) return;
    if (!badge) {
      const el = row.selfEl.ownerDocument.createElement("span");
      el.className = "folder-limit-enhanced-count";
      badge = { row, el };
      this.badges.set(folder, badge);
    }
    const counts = this.host.settings().includeSubfolders ? this.host.folderCounts(folder) : undefined;
    const fileCount = counts?.directFiles ?? countDirectFiles(folder);
    const hasSubfolders = counts && counts.subfolders > 0;
    const text = hasSubfolders
      ? `${fileCount} / ${counts.totalFiles} · ${counts.subfolders}フォルダ`
      : String(fileCount);
    if (badge.el.textContent !== text) {
      badge.el.textContent = text;
      row.info.computed = false;
    }
    let title = `${folder.path} の直下に ${fileCount}件`;
    if (fileCount !== displayableCount) title += `（一覧の表示対象 ${displayableCount}件）`;
    if (hasSubfolders) title += `・配下を含めて ${counts.totalFiles}件、サブフォルダ ${counts.subfolders}個`;
    if (badge.el.title !== title) badge.el.title = title;
    if (badge.el.parentNode !== row.selfEl) {
      row.selfEl.append(badge.el);
      row.info.computed = false;
    }
  }

  private removeBadge(folder: TFolder): void {
    const badge = this.badges.get(folder);
    if (!badge) return;
    badge.el.remove();
    badge.row.info.computed = false;
    this.badges.delete(folder);
  }

  private revealLimitedFile(file: TAbstractFile): void {
    if (!this.active || this.host.suspended() || this.view.tree.filter
      || !(file instanceof TFile) || !file.parent || this.host.expanded(file.parent.path)) return;
    let count = 0;
    for (const row of this.sortedItems(file.parent)) {
      if (!this.countsAsFile(row)) continue;
      count++;
      if (row.file !== file) continue;
      if (count > this.host.settings().limit) this.host.setExpanded(file.parent, true);
      break;
    }
  }

  private clearHiddenSelection(row: VirtualRow): void {
    const tree = this.view.tree;
    if (tree.selectedDoms.has(row)) tree.deselectItem(row);
    if (tree.focusedItem === row) tree.setFocusedItem(null, false);
    if (tree.activeDom === row) tree.activeDom = null;
  }

  private removeRow(folder: TFolder): void {
    const row = this.rows.get(folder);
    if (!row) return;
    this.clearHiddenSelection(row);
    row.dispose();
    this.rows.delete(folder);
  }
}

function isVirtualFolder(row: Partial<VirtualFolder>): row is VirtualFolder {
  return typeof row.vChildren?.setChildren === "function";
}
