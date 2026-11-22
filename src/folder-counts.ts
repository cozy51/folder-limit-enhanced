import { TFile, TFolder } from "obsidian";

export interface FolderCounts {
  directFiles: number;
  totalFiles: number;
  subfolders: number;
}

export function countDirectFiles(folder: TFolder): number {
  let count = 0;
  for (const child of folder.children) {
    if (child instanceof TFile) count++;
  }
  return count;
}

export function countFolderTree(root: TFolder): WeakMap<TFolder, FolderCounts> {
  const counts = new WeakMap<TFolder, FolderCounts>();
  const folders: { folder: TFolder; counts: FolderCounts; parent?: FolderCounts }[] = [
    { folder: root, counts: { directFiles: 0, totalFiles: 0, subfolders: 0 } },
  ];

  for (const entry of folders) {
    const { folder, counts: current } = entry;
    counts.set(folder, current);
    for (const child of folder.children) {
      if (child instanceof TFolder) {
        folders.push({
          folder: child,
          counts: { directFiles: 0, totalFiles: 0, subfolders: 0 },
          parent: current,
        });
      } else if (child instanceof TFile) {
        current.directFiles++;
      }
    }
    current.totalFiles = current.directFiles;
  }

  // Sum children into parents in reverse visit order, without recursive calls.
  for (let index = folders.length - 1; index > 0; index--) {
    const { counts: current, parent } = folders[index];
    if (!parent) continue;
    parent.totalFiles += current.totalFiles;
    parent.subfolders += current.subfolders + 1;
  }

  return counts;
}
