export type DiffLineType = 'context' | 'add' | 'remove';

export interface DiffLine {
  type: DiffLineType;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface SideBySideCell {
  lineNumber: number | null;
  text: string;
  type: DiffLineType | 'empty';
}

export interface SideBySideRow {
  left: SideBySideCell;
  right: SideBySideCell;
}

export interface DiffResult {
  lines: DiffLine[];
  sideBySide: SideBySideRow[];
  addedCount: number;
  removedCount: number;
  unchangedCount: number;
  hasChanges: boolean;
}

export function splitNormalizedLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

export function computeLineDiff(originalText: string, modifiedText: string): DiffResult {
  const oldLines = splitNormalizedLines(originalText);
  const newLines = splitNormalizedLines(modifiedText);

  // Fast common prefix & suffix trimming
  let prefixLen = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefixLen < minLen && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const lines: DiffLine[] = [];

  for (let i = 0; i < prefixLen; i++) {
    lines.push({
      type: 'context',
      oldLine: i + 1,
      newLine: i + 1,
      text: oldLines[i],
    });
  }

  const midOld = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const midNew = newLines.slice(prefixLen, newLines.length - suffixLen);

  const m = midOld.length;
  const n = midNew.length;

  if (m === 0 && n === 0) {
    // identical middle
  } else if (m === 0) {
    for (let j = 0; j < n; j++) {
      lines.push({
        type: 'add',
        oldLine: null,
        newLine: prefixLen + j + 1,
        text: midNew[j],
      });
    }
  } else if (n === 0) {
    for (let i = 0; i < m; i++) {
      lines.push({
        type: 'remove',
        oldLine: prefixLen + i + 1,
        newLine: null,
        text: midOld[i],
      });
    }
  } else if (m * n <= 2_500_000) {
    // Classic LCS dynamic programming on the changed middle window
    const width = n + 1;
    const dp = new Int32Array((m + 1) * width);

    for (let i = m - 1; i >= 0; i--) {
      const rowOffset = i * width;
      const nextRowOffset = (i + 1) * width;
      for (let j = n - 1; j >= 0; j--) {
        if (midOld[i] === midNew[j]) {
          dp[rowOffset + j] = 1 + dp[nextRowOffset + j + 1];
        } else {
          const down = dp[nextRowOffset + j];
          const right = dp[rowOffset + j + 1];
          dp[rowOffset + j] = down >= right ? down : right;
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midOld[i] === midNew[j]) {
        lines.push({
          type: 'context',
          oldLine: prefixLen + i + 1,
          newLine: prefixLen + j + 1,
          text: midOld[i],
        });
        i++;
        j++;
      } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
        lines.push({
          type: 'remove',
          oldLine: prefixLen + i + 1,
          newLine: null,
          text: midOld[i],
        });
        i++;
      } else {
        lines.push({
          type: 'add',
          oldLine: null,
          newLine: prefixLen + j + 1,
          text: midNew[j],
        });
        j++;
      }
    }
    while (i < m) {
      lines.push({
        type: 'remove',
        oldLine: prefixLen + i + 1,
        newLine: null,
        text: midOld[i],
      });
      i++;
    }
    while (j < n) {
      lines.push({
        type: 'add',
        oldLine: null,
        newLine: prefixLen + j + 1,
        text: midNew[j],
      });
      j++;
    }
  } else {
    // Bounded fallback for gigantic changed sections (> 1500x1500 changed lines)
    for (let i = 0; i < m; i++) {
      lines.push({
        type: 'remove',
        oldLine: prefixLen + i + 1,
        newLine: null,
        text: midOld[i],
      });
    }
    for (let j = 0; j < n; j++) {
      lines.push({
        type: 'add',
        oldLine: null,
        newLine: prefixLen + j + 1,
        text: midNew[j],
      });
    }
  }

  for (let s = 0; s < suffixLen; s++) {
    const oldIdx = oldLines.length - suffixLen + s;
    const newIdx = newLines.length - suffixLen + s;
    lines.push({
      type: 'context',
      oldLine: oldIdx + 1,
      newLine: newIdx + 1,
      text: oldLines[oldIdx],
    });
  }

  let addedCount = 0;
  let removedCount = 0;
  let unchangedCount = 0;
  for (const line of lines) {
    if (line.type === 'add') addedCount++;
    else if (line.type === 'remove') removedCount++;
    else unchangedCount++;
  }

  const sideBySide = buildSideBySideRows(lines);

  return {
    lines,
    sideBySide,
    addedCount,
    removedCount,
    unchangedCount,
    hasChanges: addedCount > 0 || removedCount > 0,
  };
}

export function buildSideBySideRows(lines: DiffLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let idx = 0;

  while (idx < lines.length) {
    const line = lines[idx];
    if (line.type === 'context') {
      rows.push({
        left: { lineNumber: line.oldLine, text: line.text, type: 'context' },
        right: { lineNumber: line.newLine, text: line.text, type: 'context' },
      });
      idx++;
      continue;
    }

    const removes: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (idx < lines.length && lines[idx].type === 'remove') {
      removes.push(lines[idx]);
      idx++;
    }
    while (idx < lines.length && lines[idx].type === 'add') {
      adds.push(lines[idx]);
      idx++;
    }

    const pairCount = Math.max(removes.length, adds.length);
    for (let k = 0; k < pairCount; k++) {
      const rem = removes[k];
      const add = adds[k];
      rows.push({
        left: rem
          ? { lineNumber: rem.oldLine, text: rem.text, type: 'remove' }
          : { lineNumber: null, text: '', type: 'empty' },
        right: add
          ? { lineNumber: add.newLine, text: add.text, type: 'add' }
          : { lineNumber: null, text: '', type: 'empty' },
      });
    }
  }

  return rows;
}
