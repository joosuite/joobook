import {mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {librarySchema, preferencesSchema, chapterEntries, chapterInfo, type Library, type Entry, type Ebook} from './model.js';
import {readEbook} from './ebook.js';

export function defaultHome(): string {return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'joobook');}
export function expandPath(path: string): string {return resolve(path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);}
export class LibraryStore {
  data: Library;
  readonly home: string;
  private lock?: number;
  private token = randomUUID();
  constructor(home = defaultHome(), options: {readonly?: boolean} = {}) {
    this.home = expandPath(home);
    mkdirSync(this.home, {recursive: true, mode: 0o700});
    if (!options.readonly) this.acquire();
    try {
      let contents: string | undefined;
      try {contents = readFileSync(join(this.home, 'library.json'), 'utf8');}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      this.data = contents !== undefined ? librarySchema.parse(JSON.parse(contents)) : {version: 1, preferences: preferencesSchema.parse({}), lastBook: null, books: []};
      if (contents === undefined && !options.readonly) this.persist(this.data);
    } catch (error) {this.close(); throw new Error(`Cannot load ${join(this.home, 'library.json')}. Your data was not replaced. ${(error as Error).message}`);}
  }
  private acquire(): void {
    const file = join(this.home, 'library.lock');
    try {this.lock = openSync(file, 'wx', 0o600);}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: {pid: number; token: string};
      try {owner = JSON.parse(readFileSync(file, 'utf8')); if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error();}
      catch {throw new Error(`Cannot read ${file}. Check that no joobook instance is running before removing the lock.`);}
      try {process.kill(owner.pid, 0);}
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') {unlinkSync(file); this.acquire(); return;}
      }
      throw new Error('This library is already open in another joobook instance. Close it first, or use --home for a separate library.');
    }
    writeFileSync(this.lock, JSON.stringify({pid: process.pid, token: this.token}));
  }
  private persist(data: Library): void {
    if (this.lock === undefined) throw new Error('The library was opened read-only.');
    const destination = join(this.home, 'library.json'), temporary = join(this.home, `.library-${this.token}.tmp`);
    const fd = openSync(temporary, 'w', 0o600);
    try {writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fsyncSync(fd);} finally {closeSync(fd);}
    try {renameSync(temporary, destination);} catch (error) {try {unlinkSync(temporary);} catch {} throw error;}
  }
  update(change: (data: Library) => void): void {
    const next = structuredClone(this.data); change(next);
    const valid = librarySchema.parse(next); this.persist(valid); this.data = valid;
  }
  async import(file: string): Promise<Ebook> {
    const {book, path} = await readEbook(expandPath(file));
    this.update(data => {
      const existing = data.books.find(entry => entry.id === book.id);
      if (existing) {existing.path = path; existing.chapterCount = chapterEntries(book).length; existing.location = chapterInfo(book, existing.position).label;}
      else data.books.push({id: book.id, path, title: book.title, author: book.author, format: book.format, chapters: book.chapters.length, characters: book.characters,
        chapterCount: chapterEntries(book).length, location: chapterInfo(book, {chapter: 0, offset: 0}).label,
        added: new Date().toISOString(), opened: '', position: {chapter: 0, offset: 0}, percent: 0, bookmarks: [], notes: []});
      data.preferences.importFolder = dirname(path);
    });
    return book;
  }
  async open(entry: Entry): Promise<Ebook> {
    const {book} = await readEbook(entry.path);
    if (book.id !== entry.id) throw new Error('The source file has changed. Import it as a new book to keep existing notes anchored to the original text.');
    const count = chapterEntries(book).length, location = chapterInfo(book, entry.position).label;
    if (entry.chapterCount !== count || entry.location !== location) this.update(data => {const saved = data.books.find(b => b.id === entry.id)!; saved.chapterCount = count; saved.location = location;});
    return book;
  }
  async relink(id: string, file: string): Promise<void> {
    const {book, path} = await readEbook(expandPath(file));
    if (book.id !== id) throw new Error('This is a different edition or file. Choose the original book to preserve the positions of your notes.');
    this.update(data => {const entry = data.books.find(b => b.id === id); if (!entry) throw new Error('Book no longer exists.'); entry.path = path;});
  }
  exportNotes(id: string, book?: Ebook): string {
    const entry = this.data.books.find(b => b.id === id);
    if (!entry) throw new Error('Book no longer exists.');
    const lines = [entry.title, entry.author, '', 'NOTES', ''];
    const label = (position: Entry['position']) => book ? chapterInfo(book, position).label : `Section ${position.chapter + 1}`;
    for (const note of entry.notes) lines.push(`${label(note.position)}, character ${note.position.offset}`, `> ${note.quote}`, '', note.text, '');
    lines.push('BOOKMARKS', '');
    for (const mark of entry.bookmarks) lines.push(mark.name, `${label(mark.position)}, character ${mark.position.offset}`, mark.quote, '');
    const folder = join(this.home, 'exports'); mkdirSync(folder, {recursive: true, mode: 0o700});
    const path = join(folder, `${entry.title.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 60) || 'book'}-${randomUUID().slice(0, 8)}.txt`);
    writeFileSync(path, lines.join('\n') + '\n', {encoding: 'utf8', flag: 'wx', mode: 0o600});
    return path;
  }
  close(): void {
    if (this.lock === undefined) return;
    closeSync(this.lock); this.lock = undefined;
    const file = join(this.home, 'library.lock');
    try {if (JSON.parse(readFileSync(file, 'utf8')).token === this.token) unlinkSync(file);} catch {}
  }
}
