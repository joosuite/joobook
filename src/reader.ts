import {wrapText, lineAt, type Chapter, type TextLine} from './model.js';
import {renderTable} from './tables.js';

export function layoutChapter(chapter: Chapter | undefined, width: number): TextLine[] {
  if (!chapter) return wrapText('', width);
  if (!chapter.tables?.length) return wrapText(chapter.text, width);
  const lines: TextLine[] = [];
  const prose = (start: number, end: number) => {
    if (end <= start) return;
    lines.push(...wrapText(chapter.text.slice(start, end), width).map(line => ({...line, start: start + line.start, end: start + line.end})));
  };
  let offset = 0;
  for (const table of chapter.tables) {
    if (table.start < offset || table.end > chapter.text.length) continue;
    prose(offset, table.start); lines.push(...renderTable(table, width), {text: '', start: table.end, end: table.end}); offset = table.end;
  }
  prose(offset, chapter.text.length);
  return lines.length ? lines : wrapText(chapter.text, width);
}

// Table rows can wrap several cells or repeat a merged heading. Their source
// ranges need not follow visual order, so search actual cell spans first.
export function readingLineAt(lines: TextLine[], offset: number): number {
  if (!lines.some(line => line.parts)) return lineAt(lines, offset);
  for (const repeat of [false, true]) {
    const found = lines.findIndex(line => line.parts ? line.parts.some(part => !!part.repeated === repeat && part.start !== undefined && part.start <= offset && offset < part.end!) : !repeat && line.start <= offset && offset < line.end);
    if (found >= 0) {
      let start = found;
      while (offset === lines[found]!.start && start > 0 && lines[start - 1]!.start === offset && lines[start - 1]!.parts?.every(part => part.start === undefined || part.repeated)) start--;
      return start;
    }
  }
  let best = 0, distance = Infinity;
  for (let i = 0; i < lines.length; i++) {const d = Math.abs(lines[i]!.start - offset); if (d < distance) {best = i; distance = d;}}
  return best;
}
