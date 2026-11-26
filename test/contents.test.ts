import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {strToU8, strFromU8, unzipSync, zipSync} from 'fflate';
import {parseEpub, parseTxt} from '../src/ebook.js';
import {chapterEntries, chapterInfo, bookContents, parseLocation, searchBook, progress} from '../src/model.js';
import {chapterFixture, anchoredFixture, fixture} from './helpers.js';

test('seventeen front-matter files do not turn chapter one into chapter eighteen', () => {
  const book = parseEpub(chapterFixture(), 'fixture');
  assert.equal(book.chapters.length, 20);
  assert.equal(chapterEntries(book).length, 2);
  assert.equal(chapterInfo(book, {chapter: 17, offset: 4871}).header, 'CHAPTER 1 / 2');
  assert.equal(chapterInfo(book, {chapter: 18, offset: 20}).header, 'CHAPTER 1 / 2');
  assert.equal(chapterInfo(book, {chapter: 19, offset: 0}).header, 'CHAPTER 2 / 2');
  assert.equal(chapterInfo(book, {chapter: 0, offset: 0}).header, 'FRONT MATTER');
  assert.equal(chapterInfo(book, {chapter: 17, offset: 4871}).title, 'Chapter 1. Audience building');
  assert.deepEqual(parseLocation('ch 1', book), {chapter: 17, offset: 0});
  assert.deepEqual(parseLocation('ch 2', book), {chapter: 19, offset: 0});
  assert.equal(parseLocation('ch 3', book), undefined);
});
for (const epub2 of [false, true]) test(`EPUB ${epub2 ? 2 : 3} resolves multiple chapters and nested sections within one file`, () => {
  const book = parseEpub(anchoredFixture(epub2), 'fixture');
  const chapters = chapterEntries(book);
  assert.equal(book.chapters.length, 1); assert.equal(chapters.length, 2);
  assert.deepEqual(chapters.map(chapter => chapter.title), ['Chapter 1. A & B', 'Chapter 2. The garden']);
  for (const chapter of chapters) {
    assert.equal(chapter.position.chapter, 0);
    assert.ok(book.chapters[0]!.text.slice(chapter.position.offset).startsWith(chapter.title));
    assert.equal(chapterInfo(book, chapter.position).header, `CHAPTER ${chapter.number} / 2`);
  }
  assert.ok(chapters[1]!.position.offset > chapters[0]!.position.offset);
  const nested = bookContents(book).find(entry => entry.title === 'Introduction')!;
  assert.equal(nested.kind, 'section'); assert.equal(nested.number, 1);
  assert.equal(chapterInfo(book, nested.position).header, 'CHAPTER 1 / 2');
  assert.deepEqual(parseLocation('ch 2', book), chapters[1]!.position);
  assert.ok(bookContents(book).every(entry => entry.title !== 'Page 9'));
  const expected = 'Part I\n\nA preface before the chapters.\n\nChapter 1. A & B\n\nFirst chapter text.\n\nIntroduction\n\nStill the first chapter.\n\nChapter 2. The garden\n\nSecond chapter text.';
  assert.equal(book.chapters[0]!.text, expected);
  const match = searchBook(book, 'Second chapter text')[0]!;
  assert.equal(chapterInfo(book, match.position).header, 'CHAPTER 2 / 2');
});
test('unnumbered chapter titles use EPUB semantics inside a part', () => {
  const archive = unzipSync(anchoredFixture());
  for (const path of ['OPS/book.xhtml', 'OPS/nav.xhtml', 'OPS/toc.ncx']) archive[path] = strToU8(strFromU8(archive[path]!).replaceAll('Chapter <span>1</span>. A &amp; B', 'A &amp; B').replaceAll('Chapter 1. A &amp; B', 'A &amp; B').replaceAll('Chapter 2. The garden', 'The garden'));
  const book = parseEpub(zipSync(archive), 'fixture');
  assert.deepEqual(chapterEntries(book).map(entry => entry.title), ['A & B', 'The garden']);
  assert.equal(chapterInfo(book, parseLocation('ch 2', book)!).header, 'CHAPTER 2 / 2');
});
test('a part linking to its first chapter does not hide that chapter', () => {
  const archive = unzipSync(anchoredFixture());
  archive['OPS/nav.xhtml'] = strToU8(strFromU8(archive['OPS/nav.xhtml']!).replace('href="book.xhtml">Part I', 'href="book.xhtml#one">Part I'));
  const book = parseEpub(zipSync(archive), 'fixture');
  assert.equal(chapterEntries(book).length, 2);
  assert.equal(chapterInfo(book, parseLocation('ch 1', book)!).header, 'CHAPTER 1 / 2');
});
test('TXT front matter is not a chapter and single-chapter files keep source offsets', () => {
  const book = parseTxt(strToU8('Preface\n\nChapter I\nFirst\n\nChapter II\nSecond'), 'fixture');
  assert.equal(book.chapters.length, 3); assert.equal(chapterEntries(book).length, 2);
  assert.deepEqual(parseLocation('ch 1', book), {chapter: 1, offset: 0});
  assert.equal(chapterInfo(book, {chapter: 0, offset: 0}).header, 'FRONT MATTER');
  const text = 'Preface\n\nChapter 1\nFirst chapter text.';
  const single = parseTxt(strToU8(text), 'fixture');
  assert.equal(single.chapters[0]!.text, text);
  assert.deepEqual(parseLocation('ch 1', single), {chapter: 0, offset: text.indexOf('Chapter 1')});
  const unstructured = parseTxt(strToU8('A short plain text file.'), 'fixture');
  assert.equal(chapterInfo(unstructured, {chapter: 0, offset: 0}).header, 'SECTION 1 / 1');
});
test('opening an existing library refreshes counts without moving progress, bookmarks, or notes', async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, chapterFixture()); const book = await f.store.import(f.path);
    f.store.update(data => {
      const entry = data.books[0]!;
      delete entry.chapterCount; delete entry.location;
      entry.position = {chapter: 17, offset: 4871}; entry.percent = progress(book, entry.position);
      entry.bookmarks.push({id: 'saved', name: 'A saved passage', quote: book.chapters[17]!.text.slice(4871, 4900), position: {...entry.position}, created: 'today'});
      entry.notes.push({id: 'note', position: {...entry.position}, end: 4900, quote: book.chapters[17]!.text.slice(4871, 4900), text: 'Keep this note.', created: 'today'});
    });
    const before = structuredClone(f.store.data.books[0]!);
    await f.store.open(before);
    const after = f.store.data.books[0]!;
    assert.equal(after.chapterCount, 2); assert.equal(after.location, 'Chapter 1');
    assert.equal(after.chapters, 20);
    assert.deepEqual(after.position, before.position); assert.equal(after.percent, before.percent);
    assert.deepEqual(after.bookmarks, before.bookmarks); assert.deepEqual(after.notes, before.notes);
    const exported = await import('node:fs/promises').then(fs => fs.readFile(f.store.exportNotes(book.id, book), 'utf8'));
    assert.match(exported, /Chapter 1, character 4871/); assert.doesNotMatch(exported, /Chapter 18/);
  } finally {await f.dispose();}
});
