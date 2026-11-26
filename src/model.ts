import {stripVTControlCharacters} from 'node:util';
import stringWidth from 'string-width';
import {z} from 'zod';

export const positionSchema = z.object({chapter: z.number().int().nonnegative(), offset: z.number().int().nonnegative()});
export const preferencesSchema = z.object({
  theme: z.enum(['system', 'dark', 'light']).default('system'),
  width: z.number().int().min(32).max(100).default(68),
  spacing: z.enum(['normal', 'relaxed']).default('normal'),
  resume: z.boolean().default(true),
  navigation: z.enum(['vim', 'arrows']).default('arrows'),
  importFolder: z.string().default(''),
});
const bookmarkSchema = z.object({id: z.string(), name: z.string(), position: positionSchema, quote: z.string(), created: z.string()});
const noteSchema = z.object({id: z.string(), position: positionSchema, end: z.number().int().nonnegative(), quote: z.string(), text: z.string(), created: z.string()});
export const entrySchema = z.object({
  id: z.string(), path: z.string(), title: z.string(), author: z.string(), format: z.enum(['EPUB', 'TXT']),
  chapters: z.number().int().positive(), characters: z.number().int().positive(), added: z.string(), opened: z.string().default(''),
  chapterCount: z.number().int().nonnegative().optional(), location: z.string().optional(),
  position: positionSchema, percent: z.number().min(0).max(100),
  bookmarks: z.array(bookmarkSchema), notes: z.array(noteSchema),
});
export const librarySchema = z.object({version: z.literal(1), preferences: preferencesSchema, lastBook: z.string().nullable(), books: z.array(entrySchema)});
export type Position = z.infer<typeof positionSchema>;
export type Preferences = z.infer<typeof preferencesSchema>;
export type Entry = z.infer<typeof entrySchema>;
export type Bookmark = Entry['bookmarks'][number];
export type Note = Entry['notes'][number];
export type Library = z.infer<typeof librarySchema>;
export type SectionKind = 'chapter' | 'section' | 'part' | 'other';
export type TableCell = {text: string; start: number; end: number; header: boolean; colspan: number; rowspan: number; align: 'left' | 'right' | 'center'};
export type TableBlock = {start: number; end: number; caption?: {text: string; start: number; end: number}; rows: TableCell[][]};
export type Chapter = {title: string; text: string; href: string; kind?: SectionKind; tables?: TableBlock[]};
export type ContentsItem = {title: string; position: Position; depth: number; kind: SectionKind; number?: number};
export type Ebook = {id: string; title: string; author: string; format: 'EPUB' | 'TXT'; chapters: Chapter[]; characters: number; contents?: ContentsItem[]};
export type TextPart = {text: string; start?: number; end?: number; style?: 'text' | 'accent' | 'border'; repeated?: boolean};
export type TextLine = {text: string; start: number; end: number; parts?: TextPart[]};
export type Match = {position: Position; end: number; snippet: string};

export function clean(value: unknown): string {
  return stripVTControlCharacters(String(value ?? '')).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\t/g, '    ');
}
export const singleLine = (value: unknown) => clean(value).replace(/\s+/g, ' ').trim();
export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
export function truncate(text: string, width: number): string {
  text = singleLine(text);
  if (stringWidth(text) <= width) return text;
  let result = '';
  for (const {segment} of new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(text)) {
    if (stringWidth(result + segment) > width - 1) break;
    result += segment;
  }
  return width > 0 ? result + '…' : '';
}

// Each wrapped line keeps its source offsets. Resizing never changes a saved anchor.
export function wrapText(text: string, width: number): TextLine[] {
  width = Math.max(2, width);
  const result: TextLine[] = [];
  let paragraphStart = 0;
  for (const paragraph of text.split('\n')) {
    if (!paragraph) result.push({text: '', start: paragraphStart, end: paragraphStart});
    else {
      let start = 0, cursor = 0, columns = 0, lastSpace = -1;
      const segments = new Map([...new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(paragraph)].map(s => [s.index, s.segment]));
      const flush = (end: number) => {
        result.push({text: paragraph.slice(start, end).trimEnd(), start: paragraphStart + start, end: paragraphStart + end});
        start = end;
        while (paragraph[start] === ' ') start++;
        cursor = start; columns = 0; lastSpace = -1;
      };
      while (cursor < paragraph.length) {
        const char = segments.get(cursor)!;
        const size = stringWidth(char);
        if (columns + size > width && cursor > start) {flush(lastSpace > start ? lastSpace + 1 : cursor); continue;}
        if (char === ' ') lastSpace = cursor;
        columns += size; cursor += char.length;
      }
      if (start < paragraph.length) flush(paragraph.length);
    }
    paragraphStart += paragraph.length + 1;
  }
  return result.length ? result : [{text: '', start: 0, end: 0}];
}
export function lineAt(lines: TextLine[], offset: number): number {
  let lo = 0, hi = lines.length - 1;
  while (lo < hi) {const mid = Math.ceil((lo + hi) / 2); if (lines[mid]!.start <= offset) lo = mid; else hi = mid - 1;}
  return lo;
}
export function normalizePosition(book: Ebook, position: Position): Position {
  const chapter = clamp(position.chapter, 0, book.chapters.length - 1);
  return {chapter, offset: clamp(position.offset, 0, book.chapters[chapter]!.text.length)};
}
export function progress(book: Ebook, position: Position): number {
  const p = normalizePosition(book, position);
  const before = book.chapters.slice(0, p.chapter).reduce((n, c) => n + c.text.length, 0);
  return Math.min(100, (before + p.offset) / book.characters * 100);
}
export function atPercent(book: Ebook, percent: number): Position {
  let offset = Math.floor(book.characters * clamp(percent, 0, 100) / 100);
  for (let chapter = 0; chapter < book.chapters.length; chapter++) {
    const length = book.chapters[chapter]!.text.length;
    if (offset < length || chapter === book.chapters.length - 1) return {chapter, offset: Math.min(offset, length)};
    offset -= length;
  }
  return {chapter: 0, offset: 0};
}
export function searchBook(book: Ebook, query: string, limit = 1000): Match[] {
  query = singleLine(query);
  if (!query) return [];
  // RegExp preserves offsets when Unicode case folding changes string length.
  const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const matches: Match[] = [];
  for (let chapter = 0; chapter < book.chapters.length; chapter++) {
    const text = book.chapters[chapter]!.text;
    for (const match of text.matchAll(regex)) {
      const offset = match.index!, end = offset + match[0].length;
      matches.push({position: {chapter, offset}, end, snippet: singleLine(text.slice(Math.max(0, offset - 35), end + 90))});
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}
export function parseLocation(value: string, book: Ebook): Position | undefined {
  const chapter = value.trim().match(/^ch\s*(\d+)$/i);
  if (chapter) {const entry = chapterEntries(book)[Number(chapter[1]) - 1]; return entry ? {...entry.position} : undefined;}
  if (!/^\d+(?:\.\d+)?%?$/.test(value.trim())) return;
  const n = Number(value.trim().replace('%', ''));
  return n >= 0 && n <= 100 ? atPercent(book, n) : undefined;
}

export function bookContents(book: Ebook): ContentsItem[] {
  return book.contents ?? book.chapters.map((chapter, index) => ({title: chapter.title, position: {chapter: index, offset: 0}, depth: 0, kind: 'chapter', number: index + 1}));
}
export function chapterEntries(book: Ebook): ContentsItem[] {return bookContents(book).filter(entry => entry.kind === 'chapter');}
export function comparePositions(a: Position, b: Position): number {return a.chapter - b.chapter || a.offset - b.offset;}
export function contentsIndex(book: Ebook, position: Position): number {
  const entries = bookContents(book);
  let current = -1;
  for (let i = 0; i < entries.length; i++) {if (comparePositions(entries[i]!.position, position) > 0) break; current = i;}
  return current;
}
export function chapterInfo(book: Ebook, position: Position): {header: string; label: string; title: string; number?: number; total: number} {
  position = normalizePosition(book, position);
  const chapters = chapterEntries(book), entries = bookContents(book);
  const section = book.chapters[position.chapter]!;
  const entry = entries[contentsIndex(book, position)];
  const owner = entry?.number === undefined ? undefined : chapters.find(chapter => chapter.number === entry.number);
  if (owner) return {header: `CHAPTER ${owner.number} / ${chapters.length}`, label: `Chapter ${owner.number}`, title: owner.title, number: owner.number, total: chapters.length};
  const title = entry?.position.chapter === position.chapter ? entry.title : section.title;
  const beforeFirst = chapters[0] && comparePositions(position, chapters[0].position) < 0;
  return {header: beforeFirst ? 'FRONT MATTER' : entry?.kind === 'part' ? 'PART' : chapters.length ? 'SECTION' : `SECTION ${position.chapter + 1} / ${book.chapters.length}`, label: title, title, total: chapters.length};
}
export function countLabel(entry: Pick<Entry, 'chapters' | 'chapterCount'>): string {
  const count = entry.chapterCount || entry.chapters, noun = entry.chapterCount ? 'chapter' : 'section';
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
