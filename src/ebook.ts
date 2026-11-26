import {readFile, realpath, stat} from 'node:fs/promises';
import {basename, extname, posix} from 'node:path';
import {createHash} from 'node:crypto';
import {unzipSync, strFromU8} from 'fflate';
import {XMLParser} from 'fast-xml-parser';
import {convert} from 'html-to-text';
import {clean, singleLine, type Chapter, type Ebook, type SectionKind} from './model.js';
import {buildContents, epubNavigation, fragmentOffsets, fragmentKinds, htmlKind, type TocLink} from './contents.js';
import {extractTables} from './tables.js';

const MAX_FILE = 64 * 1024 * 1024;
const MAX_EXPANDED = 128 * 1024 * 1024;
const parser = new XMLParser({ignoreAttributes: false, removeNSPrefix: true, processEntities: false, parseTagValue: false, attributeNamePrefix: '@'});
type Xml = Record<string, any>;
const array = <T>(x: T | T[] | undefined): T[] => x === undefined ? [] : Array.isArray(x) ? x : [x];
function value(x: unknown): string {const raw = typeof x === 'object' && x !== null ? (x as Xml)['#text'] : x; return singleLine(convert(String(raw ?? ''), {wordwrap: false}));}
function resolveEntry(base: string, href: string): string {
  let decoded: string;
  try {decoded = decodeURIComponent(href.split('#')[0]!.split('?')[0]!);} catch {throw new Error('The EPUB contains an invalid file reference.');}
  if (!decoded) return base;
  const path = posix.normalize(posix.join(posix.dirname(base), decoded));
  if (path.startsWith('../') || path.startsWith('/') || /^[a-z]+:/i.test(decoded)) throw new Error('The EPUB references content outside its archive.');
  return path;
}
function plain(html: string): string {
  return clean(convert(html, {wordwrap: false, preserveNewlines: false, selectors: [
    {selector: 'a', options: {ignoreHref: true}}, {selector: 'img', format: 'skip'},
    ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(selector => ({selector, options: {uppercase: false}})),
    {selector: 'script', format: 'skip'}, {selector: 'style', format: 'skip'},
  ]})).replace(/\n{3,}/g, '\n\n').trim();
}
function titleFromHtml(html: string): string {
  const heading = html.match(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/i) ?? html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return heading ? singleLine(plain(heading[1]!)) : '';
}
export function parseEpub(bytes: Uint8Array, fallback: string): Ebook {
  let expanded = 0;
  const archive = unzipSync(bytes, {filter: file => {
    // Images, embedded fonts, and scripts never need to be inflated for a text reader.
    if (!/\.(?:xml|opf|ncx|x?html?|txt)$/i.test(file.name) && file.name !== 'mimetype') return false;
    expanded += file.originalSize;
    if (file.originalSize > 24 * 1024 * 1024 || expanded > MAX_EXPANDED) throw new Error('The EPUB exceeds the 128 MiB text limit.');
    return true;
  }});
  const get = (path: string) => {
    const data = archive[path];
    if (!data) throw new Error(`The EPUB is incomplete: missing ${singleLine(path)}.`);
    return strFromU8(data);
  };
  const container = parser.parse(get('META-INF/container.xml')) as Xml;
  const roots = array<Xml>(container.container?.rootfiles?.rootfile);
  const packagePath = roots.find(r => r['@media-type'] === 'application/oebps-package+xml')?.['@full-path'] ?? roots[0]?.['@full-path'];
  if (!packagePath) throw new Error('The EPUB has no package document.');
  const pkg = (parser.parse(get(packagePath)) as Xml).package;
  if (!pkg) throw new Error('The EPUB package document is invalid.');
  const items = array<Xml>(pkg.manifest?.item);
  const manifest = new Map(items.map(item => [String(item['@id']), item]));
  const labels = new Map<string, string>();
  let tocLinks: TocLink[] = [], tocBase = packagePath;
  const ncxItem = items.find(item => item['@media-type'] === 'application/x-dtbncx+xml');
  if (ncxItem) {
    const ncxPath = resolveEntry(packagePath, ncxItem['@href']);
    if (archive[ncxPath]) {
      tocBase = ncxPath;
      const walk = (points: Xml | Xml[] | undefined, depth = 0, parent?: number) => {for (const point of array(points)) {
        const index = tocLinks.length;
        tocLinks.push({title: value(point.navLabel?.text), href: point.content?.['@src'], depth, parent});
        if (point.content?.['@src']) {const target = resolveEntry(ncxPath, point.content['@src']); if (!labels.has(target)) labels.set(target, value(point.navLabel?.text));}
        walk(point.navPoint, depth + 1, index);
      }};
      walk((parser.parse(get(ncxPath)) as Xml).ncx?.navMap?.navPoint);
    }
  }
  const nav = items.find(item => String(item['@properties'] ?? '').split(/\s+/).includes('nav'));
  if (nav) {
    const navPath = resolveEntry(packagePath, nav['@href']);
    if (archive[navPath]) {
      const navigation = epubNavigation(get(navPath));
      if (navigation.some(link => link.href)) {tocLinks = navigation; tocBase = navPath;}
      for (const link of navigation) if (link.href) {
        let target: string; try {target = resolveEntry(navPath, link.href);} catch {continue;}
        if (!labels.has(target)) labels.set(target, link.title);
      }
    }
  }
  const chapters: Chapter[] = [];
  const htmlByPath = new Map<string, string>();
  for (const ref of array<Xml>(pkg.spine?.itemref)) {
    if (ref['@linear'] === 'no') continue;
    const item = manifest.get(String(ref['@idref']));
    if (!item) throw new Error('The EPUB spine references a missing chapter.');
    if (!/^(application\/xhtml\+xml|text\/html)$/.test(item['@media-type'])) continue;
    const href = resolveEntry(packagePath, item['@href']);
    const html = get(href), text = plain(html);
    if (text) {
      const title = labels.get(href) || titleFromHtml(html) || `Section ${chapters.length + 1}`;
      chapters.push({title, text, href, kind: htmlKind(html, title), tables: extractTables(html, text, plain)}); htmlByPath.set(href, html);
    }
  }
  if (!chapters.length) throw new Error('The EPUB has no readable chapters. It may be image-only or protected by DRM.');
  const target = (href: string) => ({path: resolveEntry(tocBase, href), fragment: href.includes('#') ? decodeURIComponent(href.slice(href.indexOf('#') + 1)) || undefined : undefined});
  const fragments = new Map<string, string[]>();
  for (const link of tocLinks) if (link.href) {
    try {const resolved = target(link.href); if (resolved.fragment) fragments.set(resolved.path, [...(fragments.get(resolved.path) || []), resolved.fragment]);} catch {}
  }
  const anchors = new Map<string, Map<string, number>>();
  const kinds = new Map<string, Map<string, SectionKind>>();
  for (const [path, ids] of fragments) {
    const section = chapters.find(chapter => chapter.href === path), html = htmlByPath.get(path);
    if (section && html) {anchors.set(path, fragmentOffsets(html, section.text, ids, plain)); kinds.set(path, fragmentKinds(html, ids));}
  }
  const contents = buildContents(chapters, tocLinks, target, anchors, kinds);
  return {id: createHash('sha256').update(bytes).digest('hex'), title: value(array(pkg.metadata?.title)[0]) || fallback,
    author: array(pkg.metadata?.creator).map(value).filter(Boolean).join(', ') || 'Unknown author', format: 'EPUB', chapters, contents,
    characters: chapters.reduce((n, c) => n + c.text.length, 0)};
}
export function parseTxt(bytes: Uint8Array, name: string): Ebook {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  let text: string;
  try {text = clean(new TextDecoder(encoding, {fatal: true}).decode(bytes)).trim();}
  catch {throw new Error('The text file is not UTF-8 or UTF-16. Convert its encoding and import it again.');}
  if (!text) throw new Error('The text file is empty.');
  if (bytes.filter(c => c === 0).length > bytes.length / 20 && encoding === 'utf-8') throw new Error('This file appears to be binary rather than plain text.');
  const chapters: Chapter[] = [];
  const headings = [...text.matchAll(/^(?:chapter\s+(?:\d+|[ivxlcdm]+)\b[^\n]*|#{1,2}\s+[^\n]+)$/gim)];
  if (headings.length > 1) {
    if (headings[0]!.index! > 0) {const preface = text.slice(0, headings[0]!.index).trim(); if (preface) chapters.push({title: 'Introduction', text: preface, href: '', kind: 'other'});}
    headings.forEach((heading, index) => {chapters.push({title: singleLine(heading[0].replace(/^#+\s*/, '')), text: text.slice(heading.index!, headings[index + 1]?.index ?? text.length).trim(), href: '', kind: 'chapter'});});
  } else chapters.push({title: name, text, href: '', kind: 'section'});
  const contents = buildContents(chapters, [], href => ({path: href}), new Map());
  if (headings.length === 1) {
    const offset = headings[0]!.index!;
    contents.splice(0, contents.length);
    if (offset > 0) contents.push({title: 'Introduction', position: {chapter: 0, offset: 0}, depth: 0, kind: 'other'});
    contents.push({title: singleLine(headings[0]![0].replace(/^#+\s*/, '')), position: {chapter: 0, offset}, depth: 0, kind: 'chapter', number: 1});
  }
  return {id: createHash('sha256').update(bytes).digest('hex'), title: name, author: 'Unknown author', format: 'TXT', chapters, contents, characters: chapters.reduce((n, c) => n + c.text.length, 0)};
}
export async function readEbook(file: string): Promise<{book: Ebook; path: string}> {
  const path = await realpath(file);
  const info = await stat(path);
  if (!info.isFile()) throw new Error('Choose an EPUB or TXT file, not a directory.');
  if (info.size > MAX_FILE) throw new Error('This file exceeds the 64 MiB import limit.');
  const extension = extname(path).toLowerCase();
  if (!['.epub', '.txt'].includes(extension)) throw new Error('Only .epub and .txt files are supported.');
  const bytes = await readFile(path);
  if (bytes.length > MAX_FILE) throw new Error('This file exceeds the 64 MiB import limit.');
  const fallback = singleLine(basename(path, extname(path)).replace(/[_-]+/g, ' '));
  try {return {book: extension === '.epub' ? parseEpub(bytes, fallback) : parseTxt(bytes, fallback), path};}
  catch (error) {throw new Error(`Cannot read ${singleLine(basename(path))}: ${(error as Error).message}`);}
}
