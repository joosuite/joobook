import {parseDocument, DomUtils} from 'htmlparser2';
import {singleLine, comparePositions, type Chapter, type ContentsItem, type SectionKind} from './model.js';

type Element = ReturnType<typeof DomUtils.findAll>[number];
export type TocLink = {title: string; href?: string; depth: number; parent?: number; kind?: SectionKind};
const otherTypes = new Set(['cover', 'titlepage', 'halftitlepage', 'copyright-page', 'frontmatter', 'backmatter', 'toc', 'preface', 'foreword', 'introduction', 'dedication', 'acknowledgments', 'epigraph', 'prologue', 'epilogue', 'appendix', 'index', 'bibliography', 'glossary', 'colophon', 'endnotes', 'footnotes', 'afterword', 'contributors']);
export function sectionKind(title: string, types = ''): SectionKind {
  const tokens = types.toLowerCase().split(/\s+/).map(token => token.replace(/^doc-/, ''));
  if (tokens.includes('chapter')) return 'chapter';
  if (tokens.some(token => otherTypes.has(token))) return 'other';
  if (tokens.includes('part') || /^(?:part|book)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five)\b/i.test(title)) return 'part';
  if (/^(?:chapter|chapitre|kapitel|cap[ií]tulo|capitolo|hoofdstuk|глава)\s+\S|^第.+章/iu.test(title)) return 'chapter';
  if (/^(?:table of contents|brief contents|contents|cover|title page|copyright|preface|foreword|introduction|dedication|acknowledg(?:e)?ments|epigraph|prologue|epilogue|appendi(?:x|ces)|index|bibliography|glossary|colophon|endnotes|afterword|about the author|transcriber[’']?s? notes)\b/i.test(title)) return 'other';
  return 'section';
}
const types = (element: Element) => `${element.attribs['epub:type'] || ''} ${element.attribs.role || ''}`;
export function htmlKind(html: string, title: string): SectionKind {
  const document = parseDocument(html);
  const body = DomUtils.getElementsByTagName('body', document.children, true)[0];
  const typed = DomUtils.findAll(element => !!types(element).trim(), body?.children || document.children);
  const bodyKind = body ? sectionKind(title, types(body)) : sectionKind(title);
  if (bodyKind !== 'section') return bodyKind;
  const structural = typed.find(element => sectionKind('', types(element)) === 'chapter');
  return structural ? 'chapter' : sectionKind(title);
}
export function epubNavigation(html: string): TocLink[] {
  const document = parseDocument(html);
  const navs = DomUtils.getElementsByTagName('nav', document.children, true);
  const nav = navs.find(element => types(element).split(/\s+/).some(type => type === 'toc' || type === 'doc-toc'));
  if (!nav) return [];
  const ol = DomUtils.getElementsByTagName('ol', nav.children, true)[0];
  if (!ol) return [];
  const links: TocLink[] = [];
  const walk = (list: Element, depth: number, parent?: number) => {
    for (const li of DomUtils.getElementsByTagName('li', list.children, false)) {
      const label = DomUtils.getElementsByTagName('a', li.children, false)[0] || DomUtils.getElementsByTagName('span', li.children, false)[0];
      const index = links.length, title = singleLine(label ? DomUtils.textContent(label) : '');
      links.push({title, href: label?.attribs.href, depth, parent, kind: sectionKind(title, label ? types(label) : '')});
      for (const child of DomUtils.getElementsByTagName('ol', li.children, false)) walk(child, depth + 1, index);
    }
  };
  walk(ol, 0); return links;
}

// Mark an auxiliary conversion, never the stored text. This leaves existing
// source offsets, bookmarks, and notes unchanged when resolving TOC fragments.
export function fragmentOffsets(html: string, text: string, ids: string[], plain: (html: string) => string): Map<string, number> {
  const wanted = new Set(ids), offsets = new Map<string, number>();
  if (!wanted.size) return offsets;
  const document = parseDocument(html, {withStartIndices: true});
  const elements = DomUtils.findAll(element => wanted.has(element.attribs.id || element.attribs.name || ''), document.children);
  const markers = new Map<number, string>();
  const insertions: {at: number; marker: string}[] = [];
  for (const element of elements) {
    if (element.startIndex === null) continue;
    const id = element.attribs.id || element.attribs.name!;
    const opening = html.slice(element.startIndex).match(/^<(?:"[^"]*"|'[^']*'|[^'">])*>/);
    if (!opening) continue;
    const index = markers.size; markers.set(index, id);
    insertions.push({at: element.startIndex + opening[0].length, marker: `\ue000JOOBOOK${index}\ue001`});
  }
  let marked = html;
  for (const insertion of insertions.sort((a, b) => b.at - a.at)) marked = marked.slice(0, insertion.at) + insertion.marker + marked.slice(insertion.at);
  const converted = plain(marked);
  const marker = /\ue000JOOBOOK(\d+)\ue001/g;
  let source = 0, rendered = 0;
  // Only whitespace may differ in the auxiliary conversion. Fail closed for
  // unsupported formatting instead of making up a chapter position.
  if (converted.replace(marker, '').replace(/\s/g, '') !== text.replace(/\s/g, '')) return offsets;
  while (rendered < converted.length) {
    if (converted.startsWith('\ue000JOOBOOK', rendered)) {
      marker.lastIndex = rendered; const match = marker.exec(converted);
      if (match?.index === rendered) {
        while (/\s/.test(text[source] || '') && source < text.length) source++;
        const id = markers.get(Number(match[1])); if (id) offsets.set(id, source);
        rendered = marker.lastIndex; continue;
      }
    }
    if (/\s/.test(converted[rendered]!)) {rendered++; continue;}
    while (source < text.length && /\s/.test(text[source]!)) source++;
    rendered++; source++;
  }
  return offsets;
}

export function fragmentKinds(html: string, ids: string[]): Map<string, SectionKind> {
  const wanted = new Set(ids), result = new Map<string, SectionKind>();
  const document = parseDocument(html);
  for (const element of DomUtils.findAll(node => wanted.has(node.attribs.id || node.attribs.name || ''), document.children)) {
    let node: typeof element | typeof element.parent = element;
    while (node && 'attribs' in node) {
      const kind = sectionKind('', types(node));
      if (kind !== 'section') {result.set(element.attribs.id || element.attribs.name!, kind); break;}
      node = node.parent;
    }
  }
  return result;
}

export function buildContents(chapters: Chapter[], links: TocLink[], resolve: (href: string) => {path: string; fragment?: string}, anchors: Map<string, Map<string, number>>, kinds = new Map<string, Map<string, SectionKind>>()): ContentsItem[] {
  const entries: (ContentsItem & {source: number; parent?: number})[] = [];
  const hasNavigation = links.some(link => link.href);
  for (let source = 0; source < links.length; source++) {
    const link = links[source]!; if (!link.href) continue;
    let target: {path: string; fragment?: string};
    try {target = resolve(link.href);} catch {continue;}
    const chapter = chapters.findIndex(section => section.href === target.path); if (chapter < 0) continue;
    const offset = target.fragment ? anchors.get(target.path)?.get(target.fragment) : 0;
    if (offset === undefined) continue;
    const labelKind = link.kind || sectionKind(link.title);
    const inheritedKind = target.fragment ? kinds.get(target.path)?.get(target.fragment) || chapters[chapter]!.kind : chapters[chapter]!.kind;
    const kind = labelKind !== 'section' ? labelKind : inheritedKind || 'section';
    if (entries.some(entry => entry.position.chapter === chapter && entry.position.offset === offset && entry.title === link.title)) continue;
    entries.push({title: link.title || chapters[chapter]!.title, position: {chapter, offset}, depth: link.depth, kind, source, parent: link.parent});
  }
  if (!hasNavigation) chapters.forEach((section, chapter) => entries.push({title: section.title, position: {chapter, offset: 0}, depth: 0, kind: section.kind || sectionKind(section.title), source: chapter}));
  const bySource = new Map(entries.map(entry => [entry.source, entry]));
  const parentChain = (entry: typeof entries[number], candidates: Set<number>) => {
    let parent = entry.parent;
    while (parent !== undefined) {if (candidates.has(parent) && bySource.get(parent)?.position.chapter === entry.position.chapter) return true; parent = links[parent]?.parent;}
    return false;
  };
  const explicit = entries.filter(entry => entry.kind === 'chapter');
  const candidates = explicit.length ? explicit : hasNavigation ? entries.filter(entry => entry.kind === 'section') : [];
  const candidateIds = new Set(candidates.map(entry => entry.source));
  const starts = new Set<string>();
  const roots = candidates.filter(entry => !parentChain(entry, candidateIds)).sort((a, b) => comparePositions(a.position, b.position)).filter(entry => {
    const key = `${entry.position.chapter}:${entry.position.offset}`;
    if (starts.has(key)) return false; starts.add(key); return true;
  });
  roots.forEach((entry, index) => {entry.kind = 'chapter'; entry.number = index + 1;});
  const rootIds = new Set(roots.map(entry => entry.source));
  for (const entry of entries) if (!rootIds.has(entry.source) && (entry.kind === 'chapter' || parentChain(entry, rootIds))) entry.kind = 'section';
  for (let chapter = 0; chapter < chapters.length; chapter++) if (!entries.some(entry => entry.position.chapter === chapter && entry.position.offset === 0)) {
    const section = chapters[chapter]!;
    entries.push({title: section.title, position: {chapter, offset: 0}, depth: 0, kind: section.kind === 'other' || section.kind === 'part' ? section.kind : 'section', source: -1});
  }
  entries.sort((a, b) => comparePositions(a.position, b.position));
  let current: number | undefined;
  return entries.map(({source: _source, parent: _parent, ...entry}) => {
    if (entry.kind === 'chapter') current = entry.number;
    else if (entry.kind === 'other' || entry.kind === 'part') current = undefined;
    else entry.number = current;
    return entry;
  });
}
