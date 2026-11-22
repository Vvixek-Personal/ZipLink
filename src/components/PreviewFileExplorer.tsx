import React, { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  Folder,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  Search,
  ShieldBan,
  Type,
} from 'lucide-react';
import type { PreviewFileEntry } from '../shared/types.ts';
import { formatBytes, getLowerExtension } from '../shared/zipSecurity.ts';
import { buildPreviewFileTree, type PreviewTreeNode } from '../utils/fileTree.ts';

interface PreviewFileExplorerProps {
  files: PreviewFileEntry[];
  activeHtmlPath: string;
  selectedFilePath: string;
  onSelectHtmlFile: (relativePath: string) => void;
  onSelectInspectFile: (file: PreviewFileEntry) => void;
}

function renderAssetIcon(entry: PreviewFileEntry) {
  if (entry.blockedInPreview) {
    return <ShieldBan className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />;
  }
  if (entry.isHtml) {
    return <Globe className="h-4 w-4 shrink-0 text-blue-700" aria-hidden="true" />;
  }
  const ext = getLowerExtension(entry.relativePath);
  if (['.css', '.js', '.mjs', '.cjs', '.json', '.xml'].includes(ext)) {
    return <FileCode2 className="h-4 w-4 shrink-0 text-slate-600" aria-hidden="true" />;
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.avif'].includes(ext)) {
    return <ImageIcon className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />;
  }
  if (['.woff', '.woff2', '.ttf', '.otf', '.eot'].includes(ext)) {
    return <Type className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />;
  }
  return <File className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />;
}

export const PreviewFileExplorer: React.FC<PreviewFileExplorerProps> = ({
  files,
  activeHtmlPath,
  selectedFilePath,
  onSelectHtmlFile,
  onSelectInspectFile,
}) => {
  const [query, setQuery] = useState('');
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());

  const filteredFiles = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return files;
    return files.filter((f) => f.relativePath.toLowerCase().includes(trimmed));
  }, [files, query]);

  const treeNodes = useMemo(() => buildPreviewFileTree(filteredFiles), [filteredFiles]);

  const inspectedEntry = useMemo(
    () => files.find((f) => f.relativePath === selectedFilePath) ?? null,
    [files, selectedFilePath],
  );

  const toggleFolder = (folderPath: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  };

  const renderNode = (node: PreviewTreeNode, depth: number) => {
    const paddingLeft = 10 + depth * 14;

    if (node.kind === 'folder') {
      const isExpanded = query.trim().length > 0 || !collapsedFolders.has(node.path);
      return (
        <li key={`folder:${node.path}`}>
          <button
            type="button"
            onClick={() => toggleFolder(node.path)}
            aria-expanded={isExpanded}
            style={{ paddingLeft: `${paddingLeft}px` }}
            className="flex w-full items-center justify-between gap-2 py-1.5 pr-3 text-left text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-700"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              {isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
              )}
              {isExpanded ? (
                <FolderOpen className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
              ) : (
                <Folder className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
              )}
              <span className="truncate">{node.name}</span>
            </span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-slate-400">
              {node.fileCount}
            </span>
          </button>
          {isExpanded && (
            <ul className="space-y-0.5">{node.children.map((child) => renderNode(child, depth + 1))}</ul>
          )}
        </li>
      );
    }

    const isActivePreview = node.entry.relativePath === activeHtmlPath;
    const isSelected = node.entry.relativePath === selectedFilePath;

    return (
      <li key={`file:${node.entry.id}`}>
        <button
          type="button"
          onClick={() => {
            onSelectInspectFile(node.entry);
            if (node.entry.isHtml && !node.entry.blockedInPreview) {
              onSelectHtmlFile(node.entry.relativePath);
            }
          }}
          aria-current={isActivePreview ? 'page' : isSelected ? 'true' : undefined}
          title={
            node.entry.isHtml
              ? `Preview ${node.entry.relativePath}`
              : node.entry.blockReason || node.entry.relativePath
          }
          style={{ paddingLeft: `${paddingLeft + 18}px` }}
          className={`flex w-full items-center justify-between gap-2 py-1.5 pr-3 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:outline-blue-700 ${
            isActivePreview
              ? 'bg-blue-50 font-semibold text-blue-900'
              : isSelected
                ? 'bg-slate-100 font-medium text-slate-900'
                : 'text-slate-700 hover:bg-slate-100'
          }`}
        >
          <span className="flex min-w-0 items-center gap-2">
            {renderAssetIcon(node.entry)}
            <span className="truncate">{node.name}</span>
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-slate-400">
            {formatBytes(node.entry.sizeBytes)}
          </span>
        </button>
      </li>
    );
  };

  return (
    <aside
      aria-label="Website file explorer"
      className="flex flex-col rounded-xl border border-slate-200 bg-white overflow-hidden"
    >
      <div className="border-b border-slate-200 px-3.5 py-2.5 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-800">Explorer</span>
        <span className="font-mono text-[11px] tabular-nums text-slate-500">
          {files.length} files
        </span>
      </div>

      <div className="border-b border-slate-200 p-2.5">
        <label htmlFor="preview-explorer-filter" className="sr-only">
          Filter extracted files
        </label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            id="preview-explorer-filter"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter files..."
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:bg-white focus:outline-none"
          />
        </div>
      </div>

      <div className="max-h-[440px] lg:max-h-[540px] flex-1 overflow-y-auto py-1">
        {treeNodes.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-slate-500">
            No files match &ldquo;{query}&rdquo;.
          </div>
        ) : (
          <ul className="space-y-0.5">{treeNodes.map((node) => renderNode(node, 0))}</ul>
        )}
      </div>

      {inspectedEntry && (
        <div className="border-t border-slate-200 bg-slate-50 px-3.5 py-2.5 space-y-1 text-xs">
          <div className="font-medium text-slate-900 truncate" title={inspectedEntry.relativePath}>
            {inspectedEntry.relativePath.split('/').pop()}
          </div>
          <div className="font-mono text-[11px] text-slate-500 break-all">
            {inspectedEntry.relativePath}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 text-[11px] font-mono tabular-nums text-slate-500">
            <span>{formatBytes(inspectedEntry.sizeBytes)}</span>
            <span aria-hidden="true">·</span>
            <span>{inspectedEntry.blockedInPreview ? 'Blocked asset' : inspectedEntry.mimeType.split(';')[0]}</span>
          </div>
          {inspectedEntry.isHtml && inspectedEntry.relativePath !== activeHtmlPath && (
            <button
              type="button"
              onClick={() => onSelectHtmlFile(inspectedEntry.relativePath)}
              className="mt-1 text-[11px] font-semibold text-blue-700 hover:text-blue-800 hover:underline"
            >
              Open page in preview
            </button>
          )}
          {inspectedEntry.blockReason && (
            <div className="text-[11px] text-amber-800 leading-snug">
              {inspectedEntry.blockReason}
            </div>
          )}
        </div>
      )}
    </aside>
  );
};
