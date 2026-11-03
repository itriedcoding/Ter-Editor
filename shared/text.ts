export interface TextRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** All positions are 1-based line/column, matching the VS Code API. */
export function offsetAt(text: string, line: number, column: number): number {
  const lines = text.split('\n');
  const targetLine = Math.max(1, Math.min(line, lines.length));
  let offset = 0;
  for (let i = 0; i < targetLine - 1; i += 1) offset += lines[i].length + 1;
  return offset + Math.min(Math.max(column - 1, 0), lines[targetLine - 1].length);
}

export function positionAt(text: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, clamped);
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/** Applies non-overlapping edits to a string, returning the new content. */
export function applyTextEdits(text: string, edits: Array<TextRange & { newText: string }>): string {
  const sorted = [...edits].sort((a, b) => offsetAt(text, b.startLine, b.startColumn) - offsetAt(text, a.startLine, a.startColumn));
  let result = text;
  for (const edit of sorted) {
    const start = offsetAt(result, edit.startLine, edit.startColumn);
    const end = offsetAt(result, edit.endLine, edit.endColumn);
    result = result.slice(0, start) + edit.newText + result.slice(Math.max(start, end));
  }
  return result;
}

export function lineCount(text: string): number {
  let count = 1;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) count += 1;
  return count;
}
