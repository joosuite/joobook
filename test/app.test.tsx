import React from 'react';
import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as pause} from 'node:timers/promises';
import {unlink, writeFile} from 'node:fs/promises';
import {render, cleanup} from 'ink-testing-library';
import stringWidth from 'string-width';
import {App} from '../src/app.js';
import {fixture, chapterFixture, tableFixture} from './helpers.js';
import {layoutChapter} from '../src/reader.js';

afterEach(cleanup);
type Rendered = ReturnType<typeof render>;
async function until(app: Rendered, pattern: RegExp) {
  for (let i = 0; i < 100 && !pattern.test(app.lastFrame() || ''); i++) await pause(20);
  assert.match(app.lastFrame() || '', pattern); await pause(40);
}
async function press(app: Rendered, key: string) {app.stdin.write(key); await pause(80);}
test('tables scroll across borders, reflow on resize, and keep searchable note anchors', async () => {
  const f = await fixture(); let app: Rendered | undefined;
  try {
    const table = `<table><tr><th>First column heading</th><th>Second column heading</th></tr>${Array.from({length: 20}, (_, i) => `<tr><td>Item row ${i + 1}</td><td>Value row ${i + 1} for this entry</td></tr>`).join('')}</table>`;
    await writeFile(f.path, tableFixture(table)); const book = await f.store.import(f.path);
    app = render(<App store={f.store} initialBook={book} size={{columns: 100, rows: 36}}/>);
    await until(app, /┌─+┬─+┐/);
    const lines = layoutChapter(book.chapters[0], 68);
    for (let i = 1; i <= 20; i++) {
      await press(app, '\x1b[B');
      for (let wait = 0; wait < 100 && app.lastFrame()!.split('\n')[8]?.trim() !== lines[i]!.text.trim(); wait++) await pause(20);
      assert.equal(app.lastFrame()!.split('\n')[8]?.trim(), lines[i]!.text.trim(), `scroll ${i}, position ${JSON.stringify(f.store.data.books[0]!.position)}\n${app.lastFrame()}`);
      await pause(40);
    }
    await pause(250); const saved = {...f.store.data.books[0]!.position};
    app.rerender(<App store={f.store} initialBook={book} size={{columns: 36, rows: 18}}/>);
    await pause(100); assert.deepEqual(f.store.data.books[0]!.position, saved);
    await press(app, '/'); await until(app, /Enter search/); await press(app, 'Value row 12'); await press(app, '\r'); await until(app, /1 matches/);
    await press(app, '\r'); await until(app, /Value row 12/);
    await press(app, 'v'); await press(app, 'n'); await until(app, /Your note/);
    await press(app, 'Table note'); await press(app, '\x13'); await until(app, /Note saved/);
    const note = f.store.data.books[0]!.notes[0]!;
    assert.match(note.quote, /Value row 12/);
    assert.equal(book.chapters[note.position.chapter]!.text.slice(note.position.offset, note.end), note.quote);
  } finally {app?.unmount(); await f.dispose();}
});
test('reader, chapter jumps, contents, and bookmarks use book chapters instead of file indexes', async () => {
  const f = await fixture(); let app: Rendered | undefined;
  try {
    await writeFile(f.path, chapterFixture()); const book = await f.store.import(f.path);
    f.store.update(data => {data.books[0]!.position = {chapter: 17, offset: 4871};});
    app = render(<App store={f.store} initialBook={book} size={{columns: 100, rows: 36}}/>);
    await until(app, /CHAPTER 1 \/ 2/); assert.doesNotMatch(app.lastFrame()!, /CHAPTER 18/);
    await press(app, 'g'); await until(app, /Enter 0–100% or ch 1–2/);
    await press(app, 'ch 2'); await press(app, '\r'); await until(app, /CHAPTER 2 \/ 2/);
    await press(app, 't'); await until(app, /Contents · 2 chapters/);
    await press(app, '\x1b[H'); await press(app, '\r'); await until(app, /FRONT MATTER/);
    await press(app, ']'); await until(app, /CHAPTER 1 \/ 2/);
    await press(app, 'b'); await until(app, /Bookmark saved/);
    assert.deepEqual(f.store.data.books[0]!.bookmarks[0]!.position, {chapter: 17, offset: 0});
    await press(app, 'm'); await until(app, /Chapter 1 ·/);
  } finally {app?.unmount(); await f.dispose();}
});
test('arrow paging and hints work for new libraries and saved Vim preferences', async () => {
  for (const navigation of ['arrows', 'vim'] as const) {
    const f = await fixture(); let app: Rendered | undefined;
    try {
      assert.equal(f.store.data.preferences.navigation, 'arrows');
      if (navigation === 'vim') f.store.update(data => {data.preferences.navigation = 'vim';});
      const book = await f.store.import(f.path);
      app = render(<App store={f.store} initialBook={book} size={{columns: 100, rows: 36}}/>);
      await until(app, /CHAPTER 1/);
      assert.match(app.lastFrame()!, /←\/→ page\s+↑\/↓ scroll/);
      assert.doesNotMatch(app.lastFrame()!, /h\/l|j\/k/);
      if (navigation === 'arrows') {
        await press(app, 'l'); await pause(250);
        assert.deepEqual(f.store.data.books[0]!.position, {chapter: 0, offset: 0});
      }
      await press(app, '\x1b[C'); await pause(250);
      assert.ok(f.store.data.books[0]!.position.offset > 0);
      await press(app, '\x1b[D'); await pause(250);
      assert.deepEqual(f.store.data.books[0]!.position, {chapter: 0, offset: 0});
    } finally {app?.unmount(); await f.dispose();}
  }
});
test('backward reading navigation clamps at the start of the book and crosses chapter boundaries', async () => {
  const f = await fixture(); let app: Rendered | undefined; try {
    const book = await f.store.import(f.path);
    app = render(<App store={f.store} initialBook={book} size={{columns: 72, rows: 30}}/>);
    await until(app, /CHAPTER 1/);
    for (const key of ['\x1b[A', '\x1b[D', '\x1b[5~']) {
      await press(app, key);
      assert.match(app.lastFrame()!, /CHAPTER 1/);
    }
    await press(app, '\x1b[B'); await press(app, '\x1b[B'); await press(app, '\x1b[5~'); await pause(250);
    assert.deepEqual(f.store.data.books[0]!.position, {chapter: 0, offset: 0});
    await press(app, ']'); await until(app, /CHAPTER 2/); await press(app, '\x1b[A'); await until(app, /CHAPTER 1/); await pause(250);
    assert.equal(f.store.data.books[0]!.position.chapter, 0);
    assert.ok(f.store.data.books[0]!.position.offset > 0);
  } finally {app?.unmount(); await f.dispose();}
});
test('empty library, import browser, help return path, and typed file import work', async () => {
  const f = await fixture(); let app: Rendered | undefined; try {
    app = render(<App store={f.store} startLibrary size={{columns: 72, rows: 30}}/>);
    await until(app, /Your library is empty/); await press(app, 'i'); await until(app, /import local books/);
    await press(app, '?'); await until(app, /keyboard help/); await press(app, '\x1b'); await until(app, /import local books/);
    await press(app, 'p'); await press(app, '\x15'); await press(app, f.textPath); await press(app, '\r'); await until(app, /1 book imported/);
    assert.equal(f.store.data.books.length, 1); await press(app, '\r'); await until(app, /CHAPTER 1/);
  } finally {app?.unmount(); await f.dispose();}
});
test('reading, paging, bookmarks, note selection, note save, and search use real book data', async () => {
  const f = await fixture(); let app: Rendered | undefined; try {
    const book = await f.store.import(f.path);
    app = render(<App store={f.store} initialBook={book} size={{columns: 100, rows: 36}}/>);
    await until(app, /The reading room was quiet/); await press(app, '\x1b[C'); await pause(250);
    assert.ok(f.store.data.books[0]!.position.offset > 0);
    await press(app, 'b'); await until(app, /Bookmark saved/); assert.equal(f.store.data.books[0]!.bookmarks.length, 1);
    await press(app, 'm'); await until(app, /1 bookmarks/); await press(app, '\x1b');
    await press(app, 'v'); await until(app, /VISUAL/); await press(app, 'n'); await until(app, /Your note/);
    await press(app, 'Remember the lamp.'); await press(app, '\x13'); await until(app, /Note saved/);
    assert.equal(app.lastFrame()!.split('\n').find(l => l.includes('Note saved.'))?.trim(), 'Note saved.');
    assert.equal(f.store.data.books[0]!.notes[0]!.text, 'Remember the lamp.');
    await press(app, '\x1b'); await press(app, '/'); await until(app, /Enter search/);
    await press(app, 'garden'); await until(app, /\/ garden/);
    await press(app, '\r'); await until(app, /[1-9]\d* matches/);
    await press(app, '\r'); await until(app, /CHAPTER/);
  } finally {app?.unmount(); await f.dispose();}
});
test('go-to validation, chapter jumps, and preferences preview/save work', async () => {
  const f = await fixture(); let app: Rendered | undefined; try {
    const book = await f.store.import(f.path); app = render(<App store={f.store} initialBook={book} size={{columns: 72, rows: 30}}/>);
    await until(app, /CHAPTER 1/); await press(app, 'g'); await press(app, '101%'); await press(app, '\r'); await until(app, /Enter 0–100%/);
    await press(app, '\x15'); await press(app, 'ch 2'); await press(app, '\r'); await until(app, /CHAPTER 2/);
    await press(app, ','); await until(app, /Preferences/); await press(app, '\x1b[B'); await press(app, '\x1b[C'); await press(app, '\x13'); await until(app, /Preferences saved/);
    assert.equal(f.store.data.preferences.width, 72);
    await press(app, 't'); await until(app, /Contents/); await press(app, '\x1b[A'); await press(app, '\r'); await until(app, /CHAPTER 1/);
  } finally {app?.unmount(); await f.dispose();}
});
test('removal defaults to keep, confirmation removes metadata while keeping original file', async () => {
  const f = await fixture(); let app: Rendered | undefined; try {
    await f.store.import(f.path); app = render(<App store={f.store} startLibrary size={{columns: 100, rows: 36}}/>);
    await until(app, /The Reading Room/); await press(app, 'd'); await until(app, /Remove book/); await press(app, '\r');
    assert.equal(f.store.data.books.length, 1);
    await press(app, 'd'); await press(app, '\x1b[C'); await press(app, '\r'); await until(app, /Your library is empty/);
    assert.equal(f.store.data.books.length, 0); assert.ok((await f.store.import(f.path)).id);
  } finally {app?.unmount(); await f.dispose();}
});
test('minimum terminal stays within its cell dimensions and every help line is reachable', async () => {
  const f = await fixture(); let app: Rendered | undefined; try {
    const book = await f.store.import(f.path); app = render(<App store={f.store} initialBook={book} size={{columns: 36, rows: 18}}/>);
    await until(app, /CHAPTER 1/);
    for (const key of ['?', '\x1b[F', '\x1b', 't', '\x1b', 'v', 'n', '\x1b', '\x1b', ',']) {
      await press(app, key); const frame = app.lastFrame() || '';
      assert.ok(frame.split('\n').length <= 17, frame); assert.ok(frame.split('\n').every(l => stringWidth(l) <= 36), frame);
    }
    await press(app, '\x1b'); await press(app, '?'); await press(app, '\x1b[F'); await until(app, /Vim shortcuts/);
  } finally {app?.unmount(); await f.dispose();}
});
test('a missing source shows recovery and preserves the entry', async () => {
  const f = await fixture(); let app: Rendered | undefined; try {
    await f.store.import(f.path); await unlink(f.path);
    app = render(<App store={f.store} startLibrary size={{columns: 72, rows: 30}}/>);
    await until(app, /The Reading Room/); await press(app, '\r'); await until(app, /Book file unavailable/);
    assert.match(app.lastFrame()!, /l locate file/); assert.equal(f.store.data.books.length, 1);
  } finally {app?.unmount(); await f.dispose();}
});
test('minimum note input remains inside the editor and the whole removal description scrolls', async () => {
  const f = await fixture(); let app: Rendered | undefined; try {
    const book = await f.store.import(f.path); app = render(<App store={f.store} initialBook={book} size={{columns: 36, rows: 18}}/>);
    await until(app, /CHAPTER 1/); await press(app, 'v'); await press(app, 'n'); await press(app, 'Visible note');
    const lines = app.lastFrame()!.split('\n'), field = lines.findIndex(l => l.includes('Visible note')), bottom = lines.findIndex(l => l.includes('└'));
    assert.ok(field >= 0 && field < bottom, app.lastFrame());
    await press(app, '\x1b'); await press(app, '\x1b'); await press(app, '\x1b'); await press(app, 'd');
    await until(app, /Remove book/); await press(app, '\x1b[6~'); await until(app, /stays\s+on disk/);
    await press(app, '\r'); assert.equal(f.store.data.books.length, 1);
  } finally {app?.unmount(); await f.dispose();}
});
test('short wide library metadata stays above its footer separator', async () => {
  const f = await fixture(); let app: Rendered | undefined; try {
    await f.store.import(f.path); app = render(<App store={f.store} startLibrary size={{columns: 90, rows: 18}}/>);
    await until(app, /Book details/);
    const lines = app.lastFrame()!.split('\n'), separator = lines[14]!;
    assert.match(separator, /^\s*─+\s*$/); assert.doesNotMatch(lines.slice(10).join('\n'), /Demo Author|EPUB|chapters/);
  } finally {app?.unmount(); await f.dispose();}
});
test('long import failures can be scrolled to the final recovery sentence at minimum size', async () => {
  const f = await fixture(); let app: Rendered | undefined; try {
    const failure = 'The book cannot be read. '.repeat(40) + 'FINAL RECOVERY SENTENCE';
    f.store.import = async () => {throw new Error(failure);};
    app = render(<App store={f.store} startLibrary size={{columns: 36, rows: 18}}/>);
    await until(app, /Your library is empty/); await press(app, 'i'); await until(app, /import local books/); await press(app, 'p'); await press(app, '\x15'); await press(app, f.textPath); await press(app, '\r');
    await until(app, /1 failed/);
    for (let i = 0; i < 12; i++) await press(app, '\x1b[6~');
    await until(app, /FINAL\s+RECOVERY SENTENCE/); assert.match(app.lastFrame()!, /File 1 \/ 1/);
  } finally {app?.unmount(); await f.dispose();}
});
