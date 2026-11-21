import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, FileCode, File, Folder, Search } from 'lucide-react';
import type { ShareFileEntry } from '../shared/types.ts';
import { formatBytes } from '../shared/zipSecurity.ts';
import { buildFileTree, type FileTreeNode } from '../utils/fileTree.ts';

interface FileTreeProps {
  files: ShareFileEntry[];
  selectedView: { kind: 'context' } | { kind: 'manifest' } | { kind: 'file'; fileId: string };
  onSelectContext: () => void;
  onSelectManifest: () => void;
  onSelectFile: (file: ShareFileEntry) => void;
}

export const FileTree: React.FC<FileTreeProps> = ({
  files,
  selectedView,
  onSelectContext,
  onSelectManifest,
  onSelectFile,
}) => {
  const [query, setQuery] = useState('');
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set());

  const filteredFiles = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return files;
    return files.filter((f) => f.relativePath.toLowerCase().includes(trimmed));
  }, [files, query]);

  const treeNodes = useMemo(() => buildFileTree(filteredFiles), [filteredFiles]);

  const toggleFolder = (folderPath: string) => {
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  };

  const renderFileIcon = (entry: ShareFileEntry) => {
    if (!entry.isText) return <File className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />;
    if (entry.isActiveContent) {
      return <FileCode className="h-4 w-4 shrink-0 text-blue-700" aria-hidden="true" />;
    }
    return <FileText className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />;
  };

  const renderNode = (node: FileTreeNode, depth: number) => {
    const paddingLeft = 12 + depth * 16;

    if (node.kind === 'folder') {
      const isExpanded = query.trim().length > 0 || !collapsedPaths.has(node.path);
      return (
        <li key={`folder:${node.path}`}>
          <button
            type="button"
            onClick={() => toggleFolder(node.path)}
            aria-expanded={isExpanded}
            style={{ paddingLeft: `${paddingLeft}px` }}
            className="flex w-full items-center justify-between gap-2 py-2 pr-3 text-left text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-700"
          >
            <span className="flex min-w-0 items-center gap-2">
              {isExpanded ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
              )}
              <Folder className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
              <span className="truncate">{node.name}</span>
            </span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-slate-400">
              {node.fileCount}
            </span>
          </button>
          {isExpanded && (
            <ul className="space-y-0.5">{node.children.map((child) => renderNode(child, depth + 1))}</ul>
          )}
        </li>
      );
    }

    const isSelected = selectedView.kind === 'file' && selectedView.fileId === node.entry.id;
    return (
      <li key={`file:${node.entry.id}`}>
        <button
          type="button"
          onClick={() => onSelectFile(node.entry)}
          aria-current={isSelected ? 'true' : undefined}
          style={{ paddingLeft: `${paddingLeft + 20}px` }}
          className={`flex w-full items-center justify-between gap-2 py-2 pr-3 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-blue-700 ${
            isSelected
              ? 'bg-blue-50 font-medium text-blue-900'
              : 'text-slate-700 hover:bg-slate-100'
          }`}
        >
          <span className="flex min-w-0 items-center gap-2">
            {renderFileIcon(node.entry)}
            <span className="truncate">{node.name}</span>
          </span>
          <span className="shrink-0 font-mono text-xs tabular-nums text-slate-500">
            {formatBytes(node.entry.sizeBytes)}
          </span>
        </button>
      </li>
    );
  };

  return (
    <aside
      aria-label="Share archive files"
      className="flex flex-col border border-slate-200 bg-white rounded-xl overflow-hidden"
    >
      <div className="border-b border-slate-200 p-3 space-y-2">
        <div className="text-xs font-semibold text-slate-600">
          Generated outputs
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={onSelectContext}
            aria-current={selectedView.kind === 'context' ? 'page' : undefined}
            className={`rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-blue-700 ${
              selectedView.kind === 'context'
                ? 'bg-blue-700 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            context.md
          </button>
          <button
            type="button"
            onClick={onSelectManifest}
            aria-current={selectedView.kind === 'manifest' ? 'page' : undefined}
            className={`rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-blue-700 ${
              selectedView.kind === 'manifest'
                ? 'bg-blue-700 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            manifest.json
          </button>
        </div>
      </div>

      <div className="border-b border-slate-200 p-3">
        <label htmlFor="file-tree-filter" className="sr-only">
          Filter files by path
        </label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            id="file-tree-filter"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter files..."
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:bg-white focus:outline-none"
          />
        </div>
      </div>

      <div className="max-h-[540px] overflow-y-auto py-1">
        {treeNodes.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-slate-500">
            No files match &ldquo;{query}&rdquo;.
          </div>
        ) : (
          <ul className="space-y-0.5">{treeNodes.map((node) => renderNode(node, 0))}</ul>
        )}
      </div>
    </aside>
  );
};
