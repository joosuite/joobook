import {test} from 'node:test';
import assert from 'node:assert/strict';
import {zipSync, strToU8} from 'fflate';
import {parseEpub, parseTxt} from '../src/ebook.js';
import {clean, wrapText, lineAt, searchBook, atPercent, progress, parseLocation} from '../src/model.js';
import {epub} from './helpers.js';
import stringWidth from 'string-width';

test('EPUB 3 follows spine order, decodes archive paths, and uses navigation labels', () => {
  const book = parseEpub(epub(), 'fallback');
  assert.equal(book.title, 'The Reading Room'); assert.equal(book.author, 'Demo Author');
  assert.deepEqual(book.chapters.map(c => c.title), ['At the station', 'In the garden']);
  assert.match(book.chapters[0]!.text, /traveller/);
  assert.doesNotMatch(book.chapters[0]!.text, /ignore me|display:none/);
});
test('damaged, image-only, and non-ZIP books fail with a useful error', () => {
  assert.throws(() => parseEpub(epub({broken: true}), 'fallback'), /no readable chapters/);
  assert.throws(() => parseEpub(strToU8('not a zip'), 'fallback'));
  assert.throws(() => parseEpub(zipSync({'META-INF/container.xml': strToU8('<container/>')}), 'fallback'), /no package/);
});
test('TXT recognizes chapter headings and UTF-16 byte-order marks', () => {
  const book = parseTxt(strToU8('Preface\n\nChapter I\nFirst\n\nChapter II\nSecond'), 'Title');
  assert.deepEqual(book.chapters.map(c => c.title), ['Introduction', 'Chapter I', 'Chapter II']);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('A room with a lamp.', 'utf16le')]);
  assert.equal(parseTxt(utf16, 'Title').chapters[0]!.text, 'A room with a lamp.');
  assert.throws(() => parseTxt(new Uint8Array([0xff, 0xff, 0xff]), 'x'), /encoding/);
  assert.throws(() => parseTxt(strToU8('   '), 'x'), /empty/);
});
test('terminal controls are stripped from file content and metadata', () => {
  assert.equal(clean('\x1b[31mred\x1b[0m\x1b]52;c;secret\x07\x00\r\nhello'), 'red\nhello');
  assert.equal(parseTxt(strToU8('hello\x1b[2Jworld'), 'x').chapters[0]!.text, 'helloworld');
});
test('wrapped lines retain source offsets across terminal widths and wide characters', () => {
  const source = 'A quiet station with 中文 words and a longwordwithoutanyspaces.\n\nAnother paragraph. café 👩🏽‍💻';
  for (const width of [8, 28, 68]) {
    const lines = wrapText(source, width);
    for (const line of lines) {assert.equal(source.slice(line.start, line.end).trimEnd(), line.text); assert.ok(stringWidth(line.text) <= width);}
    const anchor = source.indexOf('words'); const line = lines[lineAt(lines, anchor)]!;
    assert.ok(line.start <= anchor && line.end > anchor);
  }
});
test('search preserves original offsets and treats regex syntax as literal text', () => {
  const book = parseTxt(strToU8('İ small case. A [lamp] and another LAMP. More lamp.'), 'x');
  const matches = searchBook(book, 'lamp'); assert.equal(matches.length, 3);
  for (const match of matches) assert.equal(book.chapters[0]!.text.slice(match.position.offset, match.end).toLowerCase(), 'lamp');
  assert.equal(searchBook(book, '[lamp]').length, 1); assert.equal(searchBook(book, 'lamp', 2).length, 2);
  assert.equal(searchBook(book, '').length, 0);
});
test('percentage navigation spans chapters and validates chapter and percentage bounds', () => {
  const book = parseEpub(epub(), 'x');
  for (const percent of [0, 12, 50, 99, 100]) assert.ok(Math.abs(progress(book, atPercent(book, percent)) - percent) < .1);
  assert.deepEqual(parseLocation('ch 2', book), {chapter: 1, offset: 0});
  for (const value of ['-1%', '101%', 'ch 0', 'ch 3', 'garbage', '1e2']) assert.equal(parseLocation(value, book), undefined);
});
