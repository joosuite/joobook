import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, copyFile, rename, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {LibraryStore} from '../src/store.js';
import {fixture} from './helpers.js';

test('library survives restart with positions, notes, bookmarks, and preferences', async () => {
  const f = await fixture(); try {
    const book = await f.store.import(f.path);
    f.store.update(data => {const b = data.books[0]!; b.position.offset = 120; b.percent = 4;
      b.bookmarks.push({id: 'mark', name: 'lamp', position: {chapter: 0, offset: 120}, quote: 'lamp', created: 'today'});
      b.notes.push({id: 'note', position: {chapter: 0, offset: 120}, end: 124, quote: 'lamp', text: 'A note', created: 'today'});
      data.preferences.width = 72; data.lastBook = book.id;
    });
    const previous = structuredClone(f.store.data); f.store.close();
    const next = new LibraryStore(f.store.home); assert.deepEqual(next.data, previous); next.close();
  } finally {await f.dispose();}
});
test('duplicate imports deduplicate by content and preserve notes when the source moves', async () => {
  const f = await fixture(); try {
    const book = await f.store.import(f.path); f.store.update(data => {data.books[0]!.position.offset = 88;});
    const moved = join(f.directory, 'moved.epub'); await copyFile(f.path, moved); await f.store.import(moved);
    assert.equal(f.store.data.books.length, 1); assert.equal(f.store.data.books[0]!.id, book.id); assert.equal(f.store.data.books[0]!.position.offset, 88);
    assert.equal(f.store.data.books[0]!.path, await realpath(moved));
  } finally {await f.dispose();}
});
test('a second writer is rejected while read-only inspection remains available', async () => {
  const f = await fixture(); try {
    assert.throws(() => new LibraryStore(f.store.home), /already open/);
    const readonly = new LibraryStore(f.store.home, {readonly: true}); assert.deepEqual(readonly.data, f.store.data);
    assert.throws(() => readonly.update(() => {}), /read-only/); readonly.close();
  } finally {await f.dispose();}
});
test('corrupt or unknown-version state is never silently overwritten', async () => {
  const f = await fixture(); try {
    f.store.close(); const path = join(f.store.home, 'library.json');
    for (const contents of ['', '{bad json', JSON.stringify({version: 99})]) {
      await writeFile(path, contents); assert.throws(() => new LibraryStore(f.store.home), /not replaced/);
      assert.equal(await readFile(path, 'utf8'), contents);
    }
  } finally {await f.dispose();}
});
test('relink accepts the same book and refuses a changed edition', async () => {
  const f = await fixture(); try {
    const book = await f.store.import(f.path), moved = join(f.directory, 'relocated.epub');
    await rename(f.path, moved); await assert.rejects(f.store.open(f.store.data.books[0]!));
    await f.store.relink(book.id, moved); assert.equal((await f.store.open(f.store.data.books[0]!)).id, book.id);
    await assert.rejects(f.store.relink(book.id, f.textPath), /different edition/);
  } finally {await f.dispose();}
});
test('export creates a new file containing passages, notes, and bookmarks without replacing previous exports', async () => {
  const f = await fixture(); try {
    const book = await f.store.import(f.path);
    f.store.update(data => {data.books[0]!.notes.push({id: 'a', position: {chapter: 0, offset: 0}, end: 4, quote: 'The lamp', text: 'Read this again.', created: 'today'});});
    const first = f.store.exportNotes(book.id), second = f.store.exportNotes(book.id);
    assert.notEqual(first, second); assert.match(await readFile(first, 'utf8'), /The lamp[\s\S]*Read this again/);
  } finally {await f.dispose();}
});
