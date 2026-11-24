import type { ShareFileEntry } from '../shared/types.ts';

export interface FileTreeFolderNode {
  kind: 'folder';
  name: string;
  path: string;
  children: FileTreeNode[];
  fileCount: number;
  totalBytes: number;
}

export interface FileTreeFileNode {
  kind: 'file';
  name: string;
  path: string;
  entry: ShareFileEntry;
}

export type FileTreeNode = FileTreeFolderNode | FileTreeFileNode;

export function buildFileTree(files: ShareFileEntry[]): FileTreeNode[] {
  const root: FileTreeFolderNode = {
    kind: 'folder',
    name: '',
    path: '',
    children: [],
    fileCount: 0,
    totalBytes: 0,
  };

  const folderMap = new Map<string, FileTreeFolderNode>();
  folderMap.set('', root);

  for (const entry of files) {
    const parts = entry.relativePath.split('/');
    let currentPath = '';
    let parent = root;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let folder = folderMap.get(currentPath);
      if (!folder) {
        folder = {
          kind: 'folder',
          name: part,
          path: currentPath,
          children: [],
          fileCount: 0,
          totalBytes: 0,
        };
        folderMap.set(currentPath, folder);
        parent.children.push(folder);
      }
      folder.fileCount++;
      folder.totalBytes += entry.sizeBytes;
      parent = folder;
    }

    root.fileCount++;
    root.totalBytes += entry.sizeBytes;

    parent.children.push({
      kind: 'file',
      name: parts[parts.length - 1],
      path: entry.relativePath,
      entry,
    });
  }

  const sortNodes = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === 'folder' ? -1 : 1;
      }
      return a.name.localeCompare(b.name, 'en');
    });
    for (const node of nodes) {
      if (node.kind === 'folder') {
        sortNodes(node.children);
      }
    }
  };

  sortNodes(root.children);
  return root.children;
}

export function buildSuggestedPrompt(contextUrl: string, archiveName: string): string {
  return [
    `Please review the extracted files from "${archiveName}" using this context.md URL:`,
    contextUrl,
    ``,
    `Summarize the project structure, highlight key entry points, and answer questions using only the files listed in context.md.`,
  ].join('\n');
}

export function formatUtcDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
