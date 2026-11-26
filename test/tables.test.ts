import {test} from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {parseEpub} from '../src/ebook.js';
import {layoutChapter, readingLineAt} from '../src/reader.js';
import {searchBook} from '../src/model.js';
import {tableFixture} from './helpers.js';

test('EPUB tables retain rows, headings, and captions without changing source text', () => {
  const book = parseEpub(tableFixture(), 'fixture'), chapter = book.chapters[0]!;
  assert.equal(chapter.text, 'Chapter 1\n\nBefore the table.\n\nWorkshop optionsServiceProblemSmall workshopsTime away from workFollow-upNew habits fade\n\nAfter the table.');
  const table = chapter.tables![0]!;
  assert.equal(table.caption?.text, 'Workshop options');
  assert.deepEqual(table.rows.map(row => row.map(cell => cell.text)), [['Service', 'Problem'], ['Small workshops', 'Time away from work'], ['Follow-up', 'New habits fade']]);
  for (const row of table.rows) for (const cell of row) assert.equal(chapter.text.slice(cell.start, cell.end), cell.text);
  assert.deepEqual(parseEpub(tableFixture(), 'fixture').chapters[0]!.tables, chapter.tables);
});
test('wide tables align columns and narrow tables switch to labeled rows', () => {
  const chapter = parseEpub(tableFixture(), 'fixture').chapters[0]!;
  const wide = layoutChapter(chapter, 68), narrow = layoutChapter(chapter, 28);
  const text = wide.map(line => line.text).join('\n');
  assert.match(text, /┌─+┬─+┐/); assert.match(text, /│ Small workshops\s+│ Time away from work\s+│/);
  const small = narrow.map(line => line.text).join('\n');
  assert.doesNotMatch(small, /┌/); assert.match(small, /Row 1\nService\n  Small workshops\n\nProblem\n  Time away from work/);
  assert.match(small, /Row 2/); assert.match(small, /After the table/);
  for (const [width, lines] of [[68, wide], [28, narrow]] as const) for (const line of lines) assert.ok(stringWidth(line.text) <= width, line.text);
});
test('wrapped cell text and search matches retain exact source positions after reflow', () => {
  const book = parseEpub(tableFixture('<table><tr><th>Left heading</th><th>Right heading</th></tr><tr><td>A long description with 中文 and café and 👩🏽‍💻 that wraps into several lines.</td><td>Needle in the second column with another long description.</td></tr></table>'), 'fixture');
  const chapter = book.chapters[0]!, match = searchBook(book, 'Needle')[0]!;
  for (const width of [68, 44, 28]) {
    const lines = layoutChapter(chapter, width), index = readingLineAt(lines, match.position.offset);
    assert.ok(lines.slice(index, index + 4).some(line => line.text.includes('Needle')));
    for (const line of lines) {
      assert.ok(stringWidth(line.text) <= width, line.text);
      for (const part of line.parts || []) if (part.start !== undefined) assert.equal(chapter.text.slice(part.start, part.end), part.text);
    }
  }
});
test('merged columns and rows preserve values and grouping in both layouts', () => {
  const chapter = parseEpub(tableFixture('<table><tr><th colspan="2">Offer details</th></tr><tr><th>Group</th><th>Price</th></tr><tr><td rowspan="2">Group A</td><td align="right">10</td></tr><tr><td>20</td></tr></table>'), 'fixture').chapters[0]!;
  const wide = layoutChapter(chapter, 68).map(line => line.text).join('\n');
  assert.match(wide, /Offer details/); assert.equal(wide.match(/Group A/g)?.length, 2);
  assert.match(wide, /10/); assert.match(wide, /20/);
  const narrow = layoutChapter(chapter, 16).map(line => line.text).join('\n');
  assert.match(narrow, /Offer details/);
  assert.match(narrow, /Price\n  10/); assert.match(narrow, /Price\n  20/);
});
test('multiple tables, empty cells, and nested table text do not lose surrounding content', () => {
  const chapter = parseEpub(tableFixture('<table><tr><th>Name</th><th>Note</th></tr><tr><td>First</td><td></td></tr></table><p>Between tables.</p><table><tr><td>Outer<table><tr><td>Nested left</td><td>Nested right</td></tr></table></td><td>Last</td></tr></table>'), 'fixture').chapters[0]!;
  assert.equal(chapter.tables!.length, 2); assert.equal(chapter.tables![0]!.rows[1]![1]!.text, '');
  const rendered = layoutChapter(chapter, 68).map(line => line.text).join('\n');
  for (const text of ['Before the table.', 'Between tables.', 'Nested left', 'Nested right', 'After the table.', 'Last']) assert.ok(rendered.includes(text), rendered);
});
test('small tables and source headers remain reachable at the start of a chapter', () => {
  const chapter = parseEpub(tableFixture('<table><tr><th>Service</th><th>Problem</th></tr><tr><td>Workshops</td><td>Time away</td></tr></table>'), 'fixture').chapters[0]!;
  const table = chapter.tables![0]!;
  const only = {...chapter, text: chapter.text.slice(table.start, table.end), tables: [{...table, start: 0, end: table.end - table.start, caption: undefined, rows: table.rows.map(row => row.map(cell => ({...cell, start: cell.start - table.start, end: cell.end - table.start})))}]};
  const lines = layoutChapter(only, 68), offset = only.tables[0]!.rows[0]![0]!.start;
  assert.match(lines[readingLineAt(lines, offset)]!.text, /┌/);
});
