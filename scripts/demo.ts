import {writeFile, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture, tableFixture} from '../test/helpers.js';
import {progress} from '../src/model.js';

export async function createDemo(missing = false, tables = false) {
  const f = await fixture();
  try {
    if (tables) await writeFile(f.path, tableFixture());
    const book = await f.store.import(f.path);
    for (const name of ['Station notes', 'Winter journal', 'Letters from the coast', 'The night train', 'A garden in November', 'Walking home', 'The last platform']) {
      const path = join(f.directory, name + '.txt');
      await writeFile(path, `${name}\n\nThis is original demonstration text for jbook.\n\nThe station was quiet. A reader sat beside a lamp and opened a notebook. The last train would arrive before sunset.`);
      await f.store.import(path);
    }
    f.store.update(data => {
      const entry = data.books.find(b => b.id === book.id)!;
      entry.opened = new Date().toISOString(); entry.percent = 12; entry.position.offset = Math.floor(book.characters * .12);
      if (tables) {entry.position = {chapter: 0, offset: book.chapters[0]!.tables?.[0]?.start || 0}; entry.percent = progress(book, entry.position);}
      entry.bookmarks = [{id: 'demo-mark', name: 'The note in the margin', position: {chapter: 0, offset: 75}, quote: 'found a note in the margin.', created: new Date().toISOString()}];
      entry.notes = [{id: 'demo-note', position: {chapter: 0, offset: 0}, end: 39, quote: book.chapters[0]!.text.slice(0, 39), text: 'The quiet station gives the traveller time to read.', created: new Date().toISOString()}];
    });
    await writeFile(join(f.directory, 'damaged.epub'), 'This is not a ZIP archive.');
    if (missing) await unlink(f.path);
    return f;
  } catch (error) {await f.dispose(); throw error;}
}
