import React, { useMemo, useState } from 'react';
import { Columns2, Rows3 } from 'lucide-react';
import { computeLineDiff } from '../shared/diff.ts';

export type DiffLayoutMode = 'unified' | 'split';

interface DiffViewerProps {
  leftLabel: string;
  rightLabel: string;
  leftText: string;
  rightText: string;
  defaultLayout?: DiffLayoutMode;
  maxHeightClass?: string;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({
  leftLabel,
  rightLabel,
  leftText,
  rightText,
  defaultLayout = 'unified',
  maxHeightClass = 'max-h-[540px]',
}) => {
  const [layout, setLayout] = useState<DiffLayoutMode>(defaultLayout);
  const diff = useMemo(() => computeLineDiff(leftText, rightText), [leftText, rightText]);

  return (
    <div className="divide-y divide-slate-200 dark:divide-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 px-4 py-2.5 text-xs dark:bg-slate-900/80">
        <div className="flex flex-wrap items-center gap-2 font-mono tabular-nums">
          <span className="text-slate-600 dark:text-slate-300">
            {leftLabel} → {rightLabel}
          </span>
          <span aria-hidden="true" className="text-slate-400">
            ·
          </span>
          <span className="font-semibold text-emerald-700 dark:text-emerald-400">
            +{diff.addedCount} added
          </span>
          <span aria-hidden="true" className="text-slate-400">
            ·
          </span>
          <span className="font-semibold text-rose-700 dark:text-rose-400">
            -{diff.removedCount} removed
          </span>
        </div>

        <div
          role="group"
          aria-label="Diff layout mode"
          className="inline-flex items-center rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-800"
        >
          <button
            type="button"
            aria-pressed={layout === 'unified'}
            onClick={() => setLayout('unified')}
            className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
              layout === 'unified'
                ? 'bg-blue-700 text-white'
                : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700'
            }`}
          >
            <Rows3 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Unified</span>
          </button>
          <button
            type="button"
            aria-pressed={layout === 'split'}
            onClick={() => setLayout('split')}
            className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
              layout === 'split'
                ? 'bg-blue-700 text-white'
                : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700'
            }`}
          >
            <Columns2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Side-by-side</span>
          </button>
        </div>
      </div>

      {!diff.hasChanges ? (
        <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
          No differences between {leftLabel.toLowerCase()} and {rightLabel.toLowerCase()}.
        </div>
      ) : layout === 'unified' ? (
        <div
          data-testid="diff-unified"
          className={`${maxHeightClass} overflow-auto bg-white font-mono text-xs leading-relaxed dark:bg-slate-900`}
        >
          <table className="w-full border-collapse">
            <caption className="sr-only">
              Unified diff comparing {leftLabel} and {rightLabel}
            </caption>
            <tbody>
              {diff.lines.map((line, index) => {
                const rowClass =
                  line.type === 'add'
                    ? 'bg-emerald-50/90 text-emerald-950 dark:bg-emerald-950/45 dark:text-emerald-100'
                    : line.type === 'remove'
                      ? 'bg-rose-50/90 text-rose-950 dark:bg-rose-950/45 dark:text-rose-100'
                      : 'text-slate-800 dark:text-slate-200';
                const gutterClass =
                  line.type === 'add'
                    ? 'bg-emerald-100/70 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300'
                    : line.type === 'remove'
                      ? 'bg-rose-100/70 text-rose-800 dark:bg-rose-950/70 dark:text-rose-300'
                      : 'bg-slate-50 text-slate-400 dark:bg-slate-950/60 dark:text-slate-500';
                const marker = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';

                return (
                  <tr key={index} className={rowClass}>
                    <td
                      className={`w-11 select-none border-r border-slate-200 px-2 py-0.5 text-right tabular-nums dark:border-slate-800 ${gutterClass}`}
                    >
                      {line.oldLine ?? ''}
                    </td>
                    <td
                      className={`w-11 select-none border-r border-slate-200 px-2 py-0.5 text-right tabular-nums dark:border-slate-800 ${gutterClass}`}
                    >
                      {line.newLine ?? ''}
                    </td>
                    <td className="w-6 select-none px-2 py-0.5 text-center font-bold">
                      {marker}
                    </td>
                    <td className="whitespace-pre pr-4 py-0.5">{line.text || ' '}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          data-testid="diff-split"
          className={`${maxHeightClass} overflow-auto bg-white font-mono text-xs leading-relaxed dark:bg-slate-900`}
        >
          <table className="w-full table-fixed border-collapse min-w-[680px]">
            <caption className="sr-only">
              Side-by-side diff comparing {leftLabel} and {rightLabel}
            </caption>
            <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
              <tr>
                <th className="w-11 px-2 py-1.5 text-right border-r border-slate-200 dark:border-slate-800">
                  Old
                </th>
                <th className="w-1/2 px-3 py-1.5 text-left border-r border-slate-200 dark:border-slate-800">
                  {leftLabel}
                </th>
                <th className="w-11 px-2 py-1.5 text-right border-r border-slate-200 dark:border-slate-800">
                  New
                </th>
                <th className="w-1/2 px-3 py-1.5 text-left">{rightLabel}</th>
              </tr>
            </thead>
            <tbody>
              {diff.sideBySide.map((row, idx) => {
                const leftBg =
                  row.left.type === 'remove'
                    ? 'bg-rose-50/90 text-rose-950 dark:bg-rose-950/45 dark:text-rose-100'
                    : row.left.type === 'empty'
                      ? 'bg-slate-100/70 dark:bg-slate-950/70'
                      : 'text-slate-800 dark:text-slate-200';
                const rightBg =
                  row.right.type === 'add'
                    ? 'bg-emerald-50/90 text-emerald-950 dark:bg-emerald-950/45 dark:text-emerald-100'
                    : row.right.type === 'empty'
                      ? 'bg-slate-100/70 dark:bg-slate-950/70'
                      : 'text-slate-800 dark:text-slate-200';

                return (
                  <tr key={idx} className="border-b border-slate-100/70 dark:border-slate-800/40">
                    <td className="select-none border-r border-slate-200 bg-slate-50 px-2 py-0.5 text-right tabular-nums text-slate-500 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-500">
                      {row.left.lineNumber ?? ''}
                    </td>
                    <td className={`overflow-x-auto whitespace-pre border-r border-slate-200 px-3 py-0.5 dark:border-slate-800 ${leftBg}`}>
                      {row.left.type === 'remove' ? `- ${row.left.text}` : row.left.text || ' '}
                    </td>
                    <td className="select-none border-r border-slate-200 bg-slate-50 px-2 py-0.5 text-right tabular-nums text-slate-500 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-500">
                      {row.right.lineNumber ?? ''}
                    </td>
                    <td className={`overflow-x-auto whitespace-pre px-3 py-0.5 ${rightBg}`}>
                      {row.right.type === 'add' ? `+ ${row.right.text}` : row.right.text || ' '}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
