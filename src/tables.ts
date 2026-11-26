import {randomUUID} from 'node:crypto';
import {parseDocument, DomUtils} from 'htmlparser2';
import stringWidth from 'string-width';
import {fragmentOffsets} from './contents.js';
import {wrapText, type TableBlock, type TableCell, type TextLine, type TextPart} from './model.js';

type Element = ReturnType<typeof DomUtils.findAll>[number];
function ancestor(element: Element, tag: string): Element | undefined {
  let parent = element.parent;
  while (parent) {if ('name' in parent && parent.name === tag) return parent; parent = parent.parent;}
  return;
}
function span(value: string | undefined): number {const n = Number(value); return Number.isInteger(n) && n > 0 ? Math.min(n, 128) : 1;}

export function extractTables(html: string, text: string, plain: (html: string) => string): TableBlock[] {
  if (!/<table\b/i.test(html)) return [];
  const document = parseDocument(html, {withStartIndices: true, withEndIndices: true, recognizeSelfClosing: true});
  const tables = DomUtils.findAll(element => element.name === 'table' && !ancestor(element, 'table'), document.children);
  if (!tables.length) return [];
  const prefix = '__jbook_' + randomUUID(), insertions: {at: number; text: string}[] = [], ids: string[] = [];
  const mark = (at: number) => {const id = `${prefix}_${ids.length}`; ids.push(id); insertions.push({at, text: `<span id="${id}"></span>`}); return id;};
  const bounds = (element: Element, outside = false): [string, string] | undefined => {
    if (element.startIndex === null || element.endIndex === null) return;
    const raw = html.slice(element.startIndex, element.endIndex + 1), opening = raw.match(/^<(?:"[^"]*"|'[^']*'|[^'">])*>/);
    if (!opening) return;
    const closing = raw.match(new RegExp(`</${element.name}\\s*>$`, 'i'));
    const start = outside ? element.startIndex : element.startIndex + opening[0].length;
    const end = outside ? element.endIndex + 1 : closing ? element.endIndex + 1 - closing[0].length : element.endIndex + 1;
    return [mark(start), mark(Math.max(start, end))];
  };
  const pending = tables.map(table => ({
    bounds: bounds(table, true),
    caption: (() => {const caption = DomUtils.getElementsByTagName('caption', table.children, false)[0]; return caption ? bounds(caption) : undefined;})(),
    rows: DomUtils.findAll(element => element.name === 'tr' && ancestor(element, 'table') === table, table.children).map(row =>
      DomUtils.findAll(element => (element.name === 'td' || element.name === 'th') && ancestor(element, 'tr') === row, row.children).map(cell => ({
        bounds: bounds(cell), header: cell.name === 'th', colspan: span(cell.attribs.colspan), rowspan: span(cell.attribs.rowspan),
        align: cell.attribs.align || cell.attribs.style?.match(/text-align\s*:\s*(right|center)/i)?.[1] || 'left',
      }))),
  }));
  let marked = html;
  for (const insertion of insertions.sort((a, b) => b.at - a.at)) marked = marked.slice(0, insertion.at) + insertion.text + marked.slice(insertion.at);
  const offsets = fragmentOffsets(marked, text, ids, plain);
  const content = (range: [string, string] | undefined) => {
    if (!range) return;
    const begin = offsets.get(range[0]), finish = offsets.get(range[1]);
    if (begin === undefined || finish === undefined || finish < begin) return;
    const raw = text.slice(begin, finish), trimmed = raw.trim();
    const start = begin + raw.length - raw.trimStart().length;
    return {text: trimmed, start, end: start + trimmed.length};
  };
  const result: TableBlock[] = [];
  for (const table of pending) {
    const range = table.bounds && [offsets.get(table.bounds[0]), offsets.get(table.bounds[1])];
    if (!range || range[0] === undefined || range[1] === undefined || range[1] <= range[0]) continue;
    const rows: TableCell[][] = []; let valid = true;
    for (const row of table.rows) {
      const cells: TableCell[] = [];
      for (const cell of row) {
        const value = content(cell.bounds); if (!value) {valid = false; break;}
        cells.push({...value, header: cell.header, colspan: cell.colspan, rowspan: cell.rowspan, align: cell.align === 'right' || cell.align === 'center' ? cell.align : 'left'});
      }
      if (!valid) break;
      if (cells.length) rows.push(cells);
    }
    if (valid && rows.length) result.push({start: range[0], end: range[1], caption: content(table.caption), rows});
  }
  return result;
}

type Placed = {cell: TableCell; row: number; column: number};
const decoration = (text: string, style: TextPart['style'] = 'border'): TextPart => ({text, style});
function line(parts: TextPart[], anchor: number): TextLine {
  const source = parts.filter(part => part.start !== undefined && !part.repeated);
  return {text: parts.map(part => part.text).join(''), start: source.length ? Math.min(...source.map(part => part.start!)) : anchor, end: source.length ? Math.max(...source.map(part => part.end!)) : anchor, parts};
}
function wrapCell(cell: TableCell, width: number, repeated = false): TextPart[][] {
  return wrapText(cell.text, width).map(part => [{text: part.text, start: cell.start + part.start, end: cell.start + part.start + part.text.length, style: cell.header ? 'accent' : 'text', repeated}]);
}

export function renderTable(table: TableBlock, width: number): TextLine[] {
  const matrix: (Placed | undefined)[][] = table.rows.map(() => []), placed: Placed[] = [];
  let columns = 0;
  // Bound malformed spans before constructing a rectangular layout. All source
  // cells remain available in the stacked fallback, including unusually wide tables.
  const complex = table.rows.some(row => row.reduce((n, cell) => n + cell.colspan, 0) > 128);
  if (!complex) table.rows.forEach((row, r) => {
    let c = 0;
    for (const cell of row) {
      while (matrix[r]![c]) c++;
      const item = {cell, row: r, column: c}; placed.push(item);
      for (let rr = r; rr < Math.min(table.rows.length, r + cell.rowspan); rr++) for (let cc = c; cc < c + cell.colspan; cc++) matrix[rr]![cc] = item;
      c += cell.colspan; columns = Math.max(columns, c);
    }
  });
  const sizes = Array.from({length: columns}, () => 1);
  for (const {cell, column} of placed) {
    const desired = Math.max(1, ...cell.text.split('\n').map(text => stringWidth(text)));
    const perColumn = Math.max(1, Math.ceil((desired - 3 * (cell.colspan - 1)) / cell.colspan));
    for (let c = column; c < column + cell.colspan; c++) sizes[c] = Math.max(sizes[c] || 1, perColumn);
  }
  const available = width - 1 - columns * 3, minimum = sizes.map(size => Math.min(size, 12));
  if (complex || !columns || available < minimum.reduce((n, size) => n + size, 0)) return stacked(table, width, matrix);
  const widths = [...minimum];
  while (widths.reduce((n, size) => n + size, 0) < available) {
    let column = -1;
    for (let c = 0; c < columns; c++) if (sizes[c]! > widths[c]! && (column < 0 || sizes[c]! - widths[c]! > sizes[column]! - widths[column]!)) column = c;
    if (column < 0) break;
    widths[column] = widths[column]! + 1;
  }
  const lines: TextLine[] = [];
  if (table.caption?.text) lines.push(...wrapText(table.caption.text, width).map(part => line([{text: part.text, start: table.caption!.start + part.start, end: table.caption!.start + part.start + part.text.length, style: 'accent'}], table.start)));
  const boundary = (row: number, c: number) => c === 0 || c === columns || matrix[row]?.[c - 1] !== matrix[row]?.[c];
  const junctions: Record<number, string> = {2: '─', 8: '─', 10: '─', 3: '└', 6: '┌', 9: '┘', 12: '┐', 7: '├', 13: '┤', 14: '┬', 11: '┴', 15: '┼'};
  const rule = (above: number | undefined, below: number | undefined, anchor: number) => {
    let text = '';
    for (let c = 0; c <= columns; c++) {
      const bits = (above !== undefined && boundary(above, c) ? 1 : 0) | (c < columns ? 2 : 0) | (below !== undefined && boundary(below, c) ? 4 : 0) | (c > 0 ? 8 : 0);
      text += junctions[bits] || '─'; if (c < columns) text += '─'.repeat(widths[c]! + 2);
    }
    lines.push(line([decoration(text)], anchor));
  };
  rule(undefined, 0, table.rows[0]?.[0]?.start ?? table.start);
  for (let r = 0; r < matrix.length; r++) {
    const cells: {item?: Placed; width: number; parts: TextPart[][]}[] = [];
    for (let c = 0; c < columns;) {
      const item = matrix[r]![c], count = item ? item.cell.colspan : 1;
      const cellWidth = widths.slice(c, c + count).reduce((n, value) => n + value, 0) + (count - 1) * 3;
      cells.push({item, width: cellWidth, parts: item ? wrapCell(item.cell, cellWidth, item.row < r) : []}); c += count;
    }
    const anchor = table.rows[r]?.[0]?.start ?? table.start;
    for (let y = 0; y < Math.max(1, ...cells.map(cell => cell.parts.length)); y++) {
      const parts: TextPart[] = [decoration('│ ')];
      for (const cell of cells) {
        const value = cell.parts[y] || [], length = stringWidth(value.map(part => part.text).join('')), space = Math.max(0, cell.width - length);
        const left = cell.item?.cell.align === 'right' ? space : cell.item?.cell.align === 'center' ? Math.floor(space / 2) : 0;
        parts.push(decoration(' '.repeat(left), 'text'), ...value, decoration(' '.repeat(space - left), 'text'), decoration(' │ '));
      }
      const last = parts.at(-1)!; last.text = last.text.slice(0, -1);
      lines.push(line(parts, anchor));
    }
    rule(r, r + 1 < matrix.length ? r + 1 : undefined, r + 1 < matrix.length ? table.rows[r + 1]?.[0]?.start ?? anchor : table.end);
  }
  return lines;
}

function stacked(table: TableBlock, width: number, matrix: (Placed | undefined)[][]): TextLine[] {
  const lines: TextLine[] = [];
  const emit = (cell: TableCell, repeated = false, indent = 0, anchor = cell.start) => {
    for (const parts of wrapCell(cell, Math.max(2, width - indent), repeated)) lines.push(line([decoration(' '.repeat(indent), 'text'), ...parts], anchor));
  };
  if (table.caption?.text) emit({...table.caption, header: true, colspan: 1, rowspan: 1, align: 'left'});
  const headerRows = table.rows.findIndex(row => row.some(cell => !cell.header));
  const count = headerRows < 0 ? table.rows.length : headerRows;
  const headers: (TableCell | undefined)[] = [];
  for (let r = 0; r < count; r++) {
    if (matrix[r]) matrix[r]!.forEach((item, column) => {if (item?.cell.text) headers[column] = item.cell;});
    else {let column = 0; for (const cell of table.rows[r]!) {for (let c = 0; c < cell.colspan; c++) headers[column++] = cell;}}
  }
  // Keep group headings that a later header row refines. Field labels alone
  // would otherwise discard the text of merged, multi-level headings.
  if (count < table.rows.length) {
    const labels = new Set(headers);
    for (const cell of table.rows.slice(0, count).flat()) if (!labels.has(cell)) emit(cell);
  }
  for (let r = count < table.rows.length ? count : 0; r < table.rows.length; r++) {
    const anchor = table.rows[r]![0]?.start || table.start;
    lines.push(line([decoration(`Row ${r - (count < table.rows.length ? count : 0) + 1}`, 'accent')], anchor));
    const cells = matrix[r]?.length ? [...new Set(matrix[r]!.filter((cell): cell is Placed => !!cell))] : table.rows[r]!.map((cell, column) => ({cell, row: r, column}));
    for (const item of cells) {
      const header = headers[item.column];
      if (header && !item.cell.header) emit(header, true, 0, item.cell.start);
      else if (!item.cell.header) lines.push(line([decoration(`Column ${item.column + 1}`, 'accent')], item.cell.start));
      emit(item.cell, item.row < r, 2, item.cell.start);
      lines.push(line([], item.cell.end));
    }
  }
  return lines;
}
