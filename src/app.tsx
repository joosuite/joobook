import React, {useEffect, useMemo, useRef, useState} from 'react';
import {useApp, useInput, useStdout} from 'ink';
import {readdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, dirname, extname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {atPercent, clamp, clean, lineAt, normalizePosition, parseLocation, progress, searchBook, singleLine, truncate, wrapText, bookContents, chapterEntries, chapterInfo, contentsIndex, countLabel, type Bookmark, type Ebook, type Entry, type Note, type Position, type Preferences} from './model.js';
import {expandPath, LibraryStore} from './store.js';
import {Grid, Terminal, type Style} from './terminal.js';
import {edit, editor, type Editor} from './editor.js';
import {copyText} from './clipboard.js';
import stringWidth from 'string-width';
import {layoutChapter, readingLineAt} from './reader.js';

type View = 'library' | 'reader' | 'contents' | 'find' | 'bookmarks' | 'notes' | 'select' | 'note' | 'goto' | 'import' | 'importing' | 'import-error' | 'preferences' | 'help' | 'confirm' | 'unavailable' | 'rename' | 'error';
type Form = 'filter' | 'query' | 'goto' | 'note' | 'path' | 'rename' | null;
type FileItem = {name: string; path: string; directory: boolean};
type ImportResult = {name: string; error?: string};
type Confirmation = {title: string; description: string; accept: () => void; back: View};
export type AppProps = {store: LibraryStore; initialBook?: Ebook; initialId?: string; startLibrary?: boolean; size?: {columns: number; rows: number}; theme?: Preferences['theme']};
const names: Record<View, string> = {library: 'library', reader: 'reading', contents: 'contents', find: 'find in book', bookmarks: 'bookmarks', notes: 'notes', select: 'select passage', note: 'edit note', goto: 'go to position', import: 'import local books', importing: 'importing books', 'import-error': 'import results', preferences: 'preferences', help: 'keyboard help', confirm: 'confirm', unavailable: 'book unavailable', rename: 'rename bookmark', error: 'error details'};
const HELP = [
  'LIBRARY', '↑/↓             Move selection', 'Enter           Open or resume book', 'i               Import local files', '/               Filter title or author', 's               Sort: recent, title, author', 'f               Shelf: all, reading, unread, finished', 'd               Remove book, then confirm', 'q               Save and quit', '',
  'READING', '←/→ or PgUp/Dn  Previous / next page', '↑/↓             Scroll one line', '[ / ]           Previous / next chapter', 'g               Go to percentage or ch N', 't               Contents', '/               Find text in the whole book', 'b               Bookmark this position', 'm               List bookmarks', 'a               List notes', 'v               Select passage', 'f               Toggle focus reading', 'Esc             Back to library', '',
  'SELECTION AND NOTES', 'Arrows          Extend selected passage', 'Shift+arrows    Extend selected passage', 'n               Write a note on the selection', 'y               Copy passage to clipboard', 'Ctrl+S          Save note', 'Enter           New line in note editor', 'Esc             Cancel editor, keep selection', '',
  'BOOKMARKS AND NOTES', 'Enter           Jump to saved position', 'r               Rename bookmark', 'e               Edit note', 'd               Delete, then confirm', 'x               Export notes and bookmarks', '',
  'FILE BROWSER', '↑/↓             Move selection', 'Enter           Open directory or import selection', 'Space           Select or unselect a file', 'a               Select all visible books', 'p               Type a file or directory path', 'Backspace       Parent directory', 'Esc             Cancel remaining imports / back', '',
  'EVERYWHERE', ',               Preferences', '?               This help', '!               Read the full current error', 'Esc             Back or cancel', 'Ctrl+C          Save position and quit', '',
  'EPUB and TXT only. Images, CSS, and DRM are not supported.', 'TXT accepts UTF-8 or UTF-16. UTF-16 needs a byte-order mark.', 'Books stay in their source folders. joobook stores positions and notes.', 'Vim shortcuts can be enabled in preferences.',
];

export function App({store, initialBook, initialId, startLibrary = false, size, theme: overrideTheme}: AppProps) {
  const {exit} = useApp(), {stdout} = useStdout();
  const [dimensions, setDimensions] = useState({columns: stdout.columns || 100, rows: stdout.rows || 36});
  useEffect(() => {const resize = () => setDimensions({columns: stdout.columns || 100, rows: stdout.rows || 36}); stdout.on('resize', resize); return () => {stdout.off('resize', resize);};}, [stdout]);
  const w = Math.max(1, size?.columns ?? dimensions.columns), h = Math.max(1, (size?.rows ?? dimensions.rows) - 1);
  const [revision, refresh] = useState(0);
  const [view, setView] = useState<View>(initialBook ? 'reader' : 'library');
  const [book, setBook] = useState<Ebook | undefined>(initialBook);
  const [bookId, setBookId] = useState<string | undefined>(initialId || initialBook?.id);
  const active = store.data.books.find(b => b.id === bookId);
  const [position, setPosition] = useState<Position>(active?.position || {chapter: 0, offset: 0});
  const positionRef = useRef(position); positionRef.current = position;
  const [readingCursor, setReadingCursor] = useState<{book: string; chapter: number; offset: number; width: number; index: number}>();
  const [cursor, setCursor] = useState(0), [filter, setFilter] = useState(''), [shelf, setShelf] = useState(0), [sort, setSort] = useState(0);
  const [form, setForm] = useState<Form>(null), [input, setInput] = useState<Editor>(editor());
  const [notice, setNotice] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [errorDetail, setErrorDetail] = useState<{text: string; back: View; form: Form; cursor: number}>();
  const [unavailableError, setUnavailableError] = useState(''), [detailScroll, setDetailScroll] = useState(0);
  const [focus, setFocus] = useState(false), [query, setQuery] = useState(''), [returnView, setReturnView] = useState<View>('library');
  const [overlayBack, setOverlayBack] = useState<View>('library');
  const [selection, setSelection] = useState<{anchor: number; cursor: number}>({anchor: 0, cursor: 0});
  const [editingNote, setEditingNote] = useState<string | undefined>();
  const [noteBack, setNoteBack] = useState<View>('select');
  const [confirmation, setConfirmation] = useState<Confirmation>(), [confirmRemove, setConfirmRemove] = useState(false);
  const [prefs, setPrefs] = useState<Preferences>(store.data.preferences);
  const [folder, setFolder] = useState(store.data.preferences.importFolder || homedir());
  const [files, setFiles] = useState<FileItem[]>([]), [chosen, setChosen] = useState<string[]>([]);
  const [results, setResults] = useState<ImportResult[]>([]), [queueSize, setQueueSize] = useState(0), [importName, setImportName] = useState('');
  const cancelled = useRef(false), mounted = useRef(true), opening = useRef(false), importToken = useRef(0);
  const settings = view === 'preferences' ? prefs : store.data.preferences;
  const theme = view === 'preferences' ? prefs.theme : overrideTheme || settings.theme;
  const wide = w >= 90, textWidth = Math.max(8, Math.min(settings.width, w - 8));
  const lines = useMemo(() => layoutChapter(book?.chapters[position.chapter], textWidth), [book, position.chapter, textWidth]);
  const readerY = focus && view === 'reader' ? 3 : h < 25 ? 6 : 8;
  const lineIndex = readingCursor?.book === book?.id && readingCursor?.chapter === position.chapter && readingCursor?.offset === position.offset && readingCursor?.width === textWidth ? clamp(readingCursor.index, 0, lines.length - 1) : readingLineAt(lines, position.offset);
  const pageLines = Math.max(1, Math.floor((h - 6 - readerY) / (settings.spacing === 'relaxed' ? 2 : 1)));
  const books = useMemo(() => {
    const needle = filter.toLocaleLowerCase();
    const list = store.data.books.filter(b => `${b.title} ${b.author}`.toLocaleLowerCase().includes(needle) && (!shelf || (shelf === 1 ? b.percent > 0 && b.percent < 100 : shelf === 2 ? b.percent === 0 : b.percent === 100)));
    return list.sort((a, b) => sort === 1 ? a.title.localeCompare(b.title) : sort === 2 ? a.author.localeCompare(b.author) || a.title.localeCompare(b.title) : (b.opened || b.added).localeCompare(a.opened || a.added));
  }, [store, revision, filter, shelf, sort]);
  const matches = useMemo(() => book ? searchBook(book, query) : [], [book, query]);
  const contents = useMemo(() => book ? bookContents(book) : [], [book]);
  const numberedChapters = useMemo(() => book ? chapterEntries(book) : [], [book]);
  const helpLines = useMemo(() => HELP.flatMap(text => wrapText(text, Math.max(2, w - 6)).map(l => l.text)), [w]);
  const rowStep = view === 'bookmarks' || view === 'notes' || view === 'find' ? (w < 60 ? 4 : 5) : 2;
  const listRows = Math.max(1, Math.floor((h - 11) / rowStep));
  const write = (change: Parameters<LibraryStore['update']>[0]): boolean => {try {store.update(change); refresh(v => v + 1); setError(''); return true;} catch (e) {setError('Could not save: ' + clean((e as Error).message)); return false;}};
  const savePosition = (): boolean => {
    if (!book || !bookId) return true;
    const p = normalizePosition(book, positionRef.current), percent = progress(book, p);
    const existing = store.data.books.find(b => b.id === bookId);
    if (existing?.position.chapter === p.chapter && existing.position.offset === p.offset && existing.percent === percent) return true;
    return write(data => {const entry = data.books.find(b => b.id === bookId); if (entry) {entry.position = p; entry.percent = percent; entry.location = chapterInfo(book, p).label;}});
  };
  const flush = useRef(savePosition); flush.current = savePosition;
  useEffect(() => {const timer = setTimeout(() => {flush.current();}, 200); return () => clearTimeout(timer);}, [position, bookId]);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false; flush.current();};}, []);
  const quit = () => {if (savePosition()) exit();};
  const go = (p: Position, renderedLine?: number) => {if (book) {
    const normalized = normalizePosition(book, p); positionRef.current = normalized; setPosition(normalized);
    setReadingCursor(renderedLine === undefined ? undefined : {book: book.id, chapter: normalized.chapter, offset: normalized.offset, width: textWidth, index: renderedLine});
  }};
  const route = (next: View) => {setView(next); setCursor(0); setForm(null); setError(''); setNotice('');};
  const startForm = (kind: Form, value = '') => {setForm(kind); setInput(editor(value)); setError('');};
  async function openBook(entry: Entry) {
    if (opening.current) return; opening.current = true;
    if (!savePosition()) {opening.current = false; return;}
    setBusy(true); setNotice('Opening ' + entry.title + '…'); setError('');
    try {
      const loaded = await store.open(entry);
      if (!mounted.current) return;
      if (!write(data => {data.lastBook = entry.id; data.books.find(b => b.id === entry.id)!.opened = new Date().toISOString();})) return;
      setBook(loaded); setBookId(entry.id); const p = normalizePosition(loaded, entry.position); positionRef.current = p; setPosition(p); setReadingCursor(undefined); setFocus(false); route('reader');
    } catch (e) {setBook(undefined); setBookId(entry.id); setUnavailableError(clean((e as Error).message)); setError(''); setNotice(''); setDetailScroll(0); setView('unavailable'); setForm(null);}
    finally {opening.current = false; if (mounted.current) setBusy(false);}
  }
  useEffect(() => {
    if (initialBook) {write(data => {data.lastBook = initialBook.id; const entry = data.books.find(b => b.id === initialBook.id); if (entry) entry.opened = new Date().toISOString();}); return;}
    if (!startLibrary && store.data.preferences.resume && store.data.lastBook) {const entry = store.data.books.find(b => b.id === store.data.lastBook); if (entry) void openBook(entry);}
  }, []);
  useEffect(() => {
    if (view !== 'import') return;
    let live = true; setFiles([]); setBusy(true);
    readdir(folder, {withFileTypes: true}).then(items => {
      if (!live) return;
      const visible = items.filter(f => !f.name.startsWith('.') && (f.isDirectory() || ['.epub', '.txt'].includes(extname(f.name).toLowerCase()))).map(f => ({name: f.name, path: join(folder, f.name), directory: f.isDirectory()}));
      visible.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
      if (dirname(folder) !== folder) visible.unshift({name: '../', path: dirname(folder), directory: true});
      setFiles(visible); setCursor(0); setError('');
    }).catch(e => {if (live) setError(`Cannot read folder: ${clean(e.message)}. Press p to choose another path.`);}).finally(() => {if (live) setBusy(false);});
    return () => {live = false;};
  }, [view, folder]);
  async function importFiles(paths: string[]) {
    if (!paths.length) return;
    const token = ++importToken.current; cancelled.current = false; setResults([]); setQueueSize(paths.length); setView('importing'); setForm(null); setBusy(true); setError('');
    const completed: ImportResult[] = [];
    for (const path of paths) {
      if (cancelled.current || !mounted.current || importToken.current !== token) break;
      setImportName(basename(path)); await nextTurn();
      try {await store.import(path); completed.push({name: basename(path)});} catch (e) {completed.push({name: basename(path), error: clean((e as Error).message)});}
      if (!mounted.current) break;
      setResults([...completed]); refresh(v => v + 1); await nextTurn();
    }
    if (!mounted.current) return;
    setBusy(false); setChosen([]); setCursor(0); setImportName('');
    if (completed.some(r => r.error)) setView('import-error');
    else {route('library'); setNotice(`${completed.length} book${completed.length === 1 ? '' : 's'} imported${cancelled.current ? '; remaining queue cancelled' : ''}.`);}
  }
  function showImport(locate = false) {setReturnView(locate ? 'unavailable' : 'library'); route('import'); setChosen([]); if (locate) startForm('path', active?.path || folder);}
  async function chooseFile(path: string) {
    if (returnView === 'unavailable' && active) {
      setBusy(true);
      try {await store.relink(active.id, path); refresh(v => v + 1); await openBook(store.data.books.find(b => b.id === active.id)!);}
      catch (e) {setError(clean((e as Error).message));} finally {setBusy(false);}
    } else await importFiles([path]);
  }
  const confirm = (title: string, description: string, back: View, accept: () => void) => {setConfirmation({title, description, back, accept}); setConfirmRemove(false); route('confirm');};
  function move(delta: number) {
    const count = view === 'library' ? books.length : view === 'contents' ? contents.length : view === 'find' ? matches.length : view === 'bookmarks' ? active?.bookmarks.length || 0 : view === 'notes' ? active?.notes.length || 0 : view === 'import' ? files.length : view === 'preferences' ? 5 : view === 'import-error' ? results.length : helpLines.length;
    setCursor(c => clamp(c + delta, 0, Math.max(0, count - 1)));
  }
  function scroll(amount: number) {
    if (!book) return;
    const target = lineIndex + amount;
    if (target < 0) {
      if (position.chapter === 0) go({chapter: 0, offset: 0});
      else {
        const chapter = position.chapter - 1, previous = layoutChapter(book.chapters[chapter], textWidth), index = Math.max(0, previous.length - pageLines);
        go({chapter, offset: previous[index]!.start}, index);
      }
    } else if (target >= lines.length) {
      if (position.chapter < book.chapters.length - 1) go({chapter: position.chapter + 1, offset: 0});
      else {go({chapter: position.chapter, offset: book.chapters[position.chapter]!.text.length}); setNotice('End of book.');}
    } else go({chapter: position.chapter, offset: lines[target]!.start}, target);
  }
  function beginNote(note?: Note) {
    setEditingNote(note?.id); setNoteBack(note ? 'notes' : 'select');
    if (note) {go(note.position); setSelection({anchor: note.position.offset, cursor: note.end});}
    setView('note'); startForm('note', note?.text || '');
  }
  function saveNote() {
    if (!book || !active) return;
    const start = Math.min(selection.anchor, selection.cursor), end = Math.max(selection.anchor, selection.cursor);
    const quote = book.chapters[position.chapter]!.text.slice(start, end);
    if (!quote.trim()) {setError('Select a passage before saving a note.'); return;}
    if (write(data => {
      const entry = data.books.find(b => b.id === active.id)!;
      const existing = entry.notes.find(n => n.id === editingNote);
      if (existing) existing.text = input.value.trim();
      else entry.notes.push({id: randomUUID(), position: {chapter: position.chapter, offset: start}, end, quote, text: input.value.trim(), created: new Date().toISOString()});
    })) {route('notes'); setNotice('Note saved.');}
  }
  function submitForm() {
    if (form === 'filter') {setFilter(input.value); setForm(null); setCursor(0);}
    if (form === 'query') {setQuery(singleLine(input.value)); setForm(null); setCursor(0);}
    if (form === 'goto' && book) {const p = parseLocation(input.value, book); if (p) {go(p); route('reader');} else setError(numberedChapters.length ? `Enter 0–100% or ch 1–${numberedChapters.length}.` : 'Enter 0–100%.');}
    if (form === 'rename' && active) {
      const mark = active.bookmarks[cursor]; if (!mark) return;
      if (!input.value.trim()) {setError('Enter a bookmark name.'); return;}
      if (write(data => {data.books.find(b => b.id === active.id)!.bookmarks.find(b => b.id === mark.id)!.name = singleLine(input.value);})) {setView('bookmarks'); setForm(null);}
    }
    if (form === 'path') {
      const path = expandPath(input.value.trim());
      setBusy(true);
      import('node:fs/promises').then(fs => fs.stat(path)).then(info => {if (info.isDirectory()) {setFolder(path); setForm(null); setBusy(false);} else {setForm(null); void chooseFile(path);}}).catch(e => {setError(clean(e.message)); setBusy(false);});
    }
  }

  useInput((keyInput, key) => {
    const vim = settings.navigation === 'vim';
    const down = key.downArrow || (vim && keyInput === 'j'), up = key.upArrow || (vim && keyInput === 'k');
    const left = key.leftArrow || (vim && keyInput === 'h'), right = key.rightArrow || (vim && keyInput === 'l');
    if (key.ctrl && keyInput === 'c') {cancelled.current = true; quit(); return;}
    if (w < 36 || h < 17) {if (keyInput === 'q') quit(); return;}
    if (view === 'importing') {if (key.escape) {cancelled.current = true; setNotice('Finishing current file; remaining imports cancelled.');} return;}
    if (busy) {if (key.escape && view === 'import') {setBusy(false); route(returnView);} return;}
    if (view === 'error') {
      if (key.escape) {setView(errorDetail?.back || 'library'); setForm(errorDetail?.form || null); setCursor(errorDetail?.cursor || 0); return;}
      const count = wrapText(errorDetail?.text || '', w - 6).length;
      if (down || key.pageDown) setCursor(c => clamp(c + (key.pageDown ? h - 9 : 1), 0, count - 1));
      if (up || key.pageUp) setCursor(c => Math.max(0, c - (key.pageUp ? h - 9 : 1)));
      return;
    }
    if (keyInput === '!' && error) {setErrorDetail({text: error, back: view, form, cursor}); setView('error'); setForm(null); setCursor(0); return;}
    if (form) {
      if (key.escape) {
        setForm(null); setError('');
        if (form === 'note') setView(noteBack);
        if (form === 'goto') setView('reader');
        if (form === 'rename') setView('bookmarks');
        return;
      }
      if (form === 'note' && key.ctrl && keyInput === 's') {saveNote(); return;}
      if (key.return && form !== 'note') {submitForm(); return;}
      setInput(state => edit(state, keyInput, key, form === 'note')); return;
    }
    if (view === 'confirm') {
      if (key.escape || keyInput === 'q') {route(confirmation?.back || 'library'); return;}
      if (left || right || key.tab) setConfirmRemove(v => !v);
      const count = wrapText(confirmation?.description || '', w - 6).length;
      if (down || key.pageDown) setCursor(c => clamp(c + (key.pageDown ? 5 : 1), 0, count - 1));
      if (up || key.pageUp) setCursor(c => Math.max(0, c - (key.pageUp ? 5 : 1)));
      if (key.return) {if (confirmRemove) confirmation?.accept(); else route(confirmation?.back || 'library');}
      return;
    }
    if (view === 'preferences') {
      if (key.escape) {route(overlayBack); return;}
      if (key.ctrl && keyInput === 's') {if (write(data => {data.preferences = prefs;})) {route(overlayBack); setNotice('Preferences saved.');} return;}
      if (up) move(-1);
      if (down || key.tab) move(1);
      if (left || right || key.return || keyInput === ' ') {
        const delta = left ? -1 : 1;
        setPrefs(p => {
          if (cursor === 0) {const themes: Preferences['theme'][] = ['system', 'dark', 'light']; return {...p, theme: themes[(themes.indexOf(p.theme) + delta + 3) % 3]!};}
          if (cursor === 1) return {...p, width: clamp(p.width + delta * 4, 32, 100)};
          if (cursor === 2) return {...p, spacing: p.spacing === 'normal' ? 'relaxed' : 'normal'};
          if (cursor === 3) return {...p, resume: !p.resume};
          return {...p, navigation: p.navigation === 'vim' ? 'arrows' : 'vim'};
        });
      }
      return;
    }
    if (keyInput === '?' && view !== 'help') {setOverlayBack(view); route('help'); return;}
    if (keyInput === ',' && !['help', 'unavailable', 'import-error'].includes(view)) {setOverlayBack(view); setPrefs(store.data.preferences); route('preferences'); return;}
    if (key.escape) {
      if (view === 'help') route(overlayBack);
      else if (view === 'import') route(returnView);
      else if (view === 'select') route('reader');
      else if (['contents', 'find', 'notes', 'bookmarks'].includes(view)) route('reader');
      else {if (savePosition()) route('library');}
      return;
    }
    if (view === 'unavailable' || view === 'import-error') {
      const message = view === 'unavailable' ? unavailableError : results[cursor]?.error || '';
      const count = wrapText(message, w - 6).length;
      if (key.pageDown || key.pageUp || (view === 'unavailable' && (down || up))) {setDetailScroll(s => clamp(s + (key.pageDown ? 5 : key.pageUp ? -5 : down ? 1 : -1), 0, Math.max(0, count - 1))); return;}
      if (view === 'import-error' && (down || up)) setDetailScroll(0);
    }
    if (view === 'select' && book) {
      if (keyInput === 'n') {beginNote(); return;}
      if (keyInput === 'y') {void copyText(book.chapters[position.chapter]!.text.slice(Math.min(selection.anchor, selection.cursor), Math.max(selection.anchor, selection.cursor))).then(() => setNotice('Passage copied.')).catch(e => setError(clean(e.message))); return;}
      let end = selection.cursor;
      const source = book.chapters[position.chapter]!.text;
      if (left) end -= [...source.slice(0, end)].at(-1)?.length || 0;
      if (right) end += [...source.slice(end)][0]?.length || 0;
      if (down || up) {const line = clamp(readingLineAt(lines, end) + (down ? 1 : -1), 0, lines.length - 1); end = down ? lines[line]!.end : lines[line]!.start; if (line < lineIndex || line >= lineIndex + pageLines) go({chapter: position.chapter, offset: lines[line]!.start}, line);}
      setSelection(s => ({...s, cursor: clamp(end, 0, source.length)})); return;
    }
    if (view === 'reader' && book && active) {
      if (down || up) {scroll(down ? 1 : -1); return;}
      if (key.pageDown || right || keyInput === ' ') {scroll(pageLines); return;}
      if (key.pageUp || left) {scroll(-pageLines); return;}
      if (keyInput === '[' || keyInput === ']') {
        const targets = numberedChapters.length ? numberedChapters : contents;
        const current = numberedChapters.length ? numberedChapters.findIndex(entry => entry.number === chapterInfo(book, position).number) : contentsIndex(book, position);
        const target = targets[clamp(current + (keyInput === ']' ? 1 : -1), 0, targets.length - 1)];
        if (target) go(target.position); return;
      }
      if (keyInput === 't') {route('contents'); setCursor(Math.max(0, contentsIndex(book, position)));}
      if (keyInput === '/') {route('find'); startForm('query', query);}
      if (keyInput === 'g') {setView('goto'); startForm('goto');}
      if (keyInput === 'f') setFocus(v => !v);
      if (keyInput === 'm') route('bookmarks');
      if (keyInput === 'a') route('notes');
      if (keyInput === 'v') {
        let index = lines.findIndex((line, i) => i >= lineIndex && line.end > line.start);
        if (index < 0) index = lineIndex;
        const line = lines[index]!;
        setSelection({anchor: line.start, cursor: line.end}); go({chapter: position.chapter, offset: line.start}, index); route('select');
      }
      if (keyInput === 'b') {
        const p = {...position}; const quote = singleLine(book.chapters[p.chapter]!.text.slice(p.offset, p.offset + 160));
        if (active.bookmarks.some(b => b.position.chapter === p.chapter && b.position.offset === p.offset)) {setNotice('This position is already bookmarked.'); return;}
        if (write(data => data.books.find(b => b.id === active.id)!.bookmarks.push({id: randomUUID(), name: quote.slice(0, 60) || book.chapters[p.chapter]!.title, position: p, quote, created: new Date().toISOString()}))) setNotice('Bookmark saved. Press m to view bookmarks.');
      }
      return;
    }
    if (down || up) {move(down ? 1 : -1); return;}
    if (key.pageDown || key.pageUp) {move((key.pageDown ? 1 : -1) * (view === 'help' ? Math.max(1, h - 9) : listRows)); return;}
    if (key.home) {setCursor(0); return;}
    if (key.end) {move(1_000_000); return;}
    if (view === 'library') {
      if (keyInput === 'q') {quit(); return;}
      if (keyInput === 'i') showImport();
      if (keyInput === '/') startForm('filter', filter);
      if (keyInput === 's') {setSort(s => (s + 1) % 3); setCursor(0);}
      if (keyInput === 'f') {setShelf(s => (s + 1) % 4); setCursor(0);}
      const entry = books[clamp(cursor, 0, Math.max(0, books.length - 1))];
      if (key.return && entry) void openBook(entry);
      if (keyInput === 'd' && entry) confirm('Remove book from library?', `${entry.title}\n\nThis removes its reading position, ${entry.bookmarks.length} bookmarks, and ${entry.notes.length} notes.\n\nThe original ${entry.format} file stays on disk.`, 'library', () => {
        if (write(data => {data.books = data.books.filter(b => b.id !== entry.id); if (data.lastBook === entry.id) data.lastBook = null;})) {if (bookId === entry.id) {setBook(undefined); setBookId(undefined);} route('library'); setNotice('Book removed. Original file kept.');}
      });
    } else if (view === 'contents' && key.return) {if (contents[cursor]) go(contents[cursor]!.position); route('reader');
    } else if (view === 'find') {
      if (keyInput === '/') startForm('query', query);
      if (key.return) {if (matches[cursor]) {go(matches[cursor]!.position); route('reader');} else startForm('query', query);}
    } else if (view === 'bookmarks' || view === 'notes') {
      const item = view === 'bookmarks' ? active?.bookmarks[cursor] : active?.notes[cursor];
      if (key.return && item) {go(item.position); route('reader');}
      if (keyInput === 'x' && active) {try {setNotice('Exported to ' + store.exportNotes(active.id, book));} catch (e) {setError(clean((e as Error).message));}}
      if (keyInput === 'r' && view === 'bookmarks' && item) {setView('rename'); startForm('rename', (item as Bookmark).name);}
      if (keyInput === 'e' && view === 'notes' && item) beginNote(item as Note);
      if (keyInput === 'd' && item && active) {const back = view; confirm(`Delete ${view === 'notes' ? 'note' : 'bookmark'}?`, 'This deletes the saved item. The book and its reading position stay in your library.', back, () => {
        if (write(data => {const entry = data.books.find(b => b.id === active.id)!; if (back === 'notes') entry.notes = entry.notes.filter(n => n.id !== item.id); else entry.bookmarks = entry.bookmarks.filter(n => n.id !== item.id);})) route(back);
      });}
    } else if (view === 'import') {
      if (keyInput === 'p') {startForm('path', folder + '/'); return;}
      if (key.backspace || key.delete) {setFolder(dirname(folder)); return;}
      const file = files[cursor];
      if (keyInput === ' ' && file && !file.directory) setChosen(v => v.includes(file.path) ? v.filter(p => p !== file.path) : [...v, file.path]);
      if (keyInput === 'a' && returnView !== 'unavailable') setChosen(files.filter(f => !f.directory).map(f => f.path));
      if (key.return) {if (chosen.length && returnView !== 'unavailable') void importFiles(chosen); else if (file?.directory) setFolder(file.path); else if (file) void chooseFile(file.path); else startForm('path', folder + '/');}
    } else if (view === 'import-error') {
      if (key.return) route('library');
      if (keyInput === 'r') showImport();
    } else if (view === 'unavailable') {
      if (keyInput === 'l') showImport(true);
      if (keyInput === 'i') showImport();
    } else if (view === 'help' && (keyInput === '?' || keyInput === 'q')) route(overlayBack);
  });

  const grid = new Grid(w, h);
  if (w < 36 || h < 17) {
    grid.wrap(0, 0, 'joobook needs at least 36 columns and 18 rows. Resize the terminal.', w, 'warn', h - 2); grid.text(0, h - 1, 'q quit', 'muted');
    return <Terminal grid={grid} theme={theme}/>;
  }
  const row = (y: number, text: string, style: Style = 'text') => grid.row(y, text, style);
  const statusY = h - 5, ruleY = h - 3;
  grid.row(0, 'joobook', 'accent'); grid.text(12, 0, names[view], 'muted', w - 14);
  if (w >= 90) grid.text(w - 22, 0, 'LOCAL · EPUB / TXT', 'muted');
  grid.rule(1); grid.rule(ruleY);
  const footer = (text: string) => {grid.clear(0, h - 2, w, 2); return grid.wrap(2, h - 2, text, w - 4, 'muted', 2);};
  const status = (text: string, style: Style = 'muted') => {grid.clear(0, statusY, w, 2); return grid.wrap(2, statusY, text, w - 4, style, 2);};
  const page = (title: string) => grid.box(1, 3, w - 2, h - 8, title, true);
  function drawEditor(y: number, rows: number, prefix = '') {
    const available = w - 8, source = input.value;
    const withCursor = source.slice(0, input.cursor) + '█' + source.slice(input.cursor);
    const wrapped = wrapText(prefix + withCursor, available);
    const cursorLine = lineAt(wrapped, prefix.length + input.cursor);
    const start = Math.max(0, cursorLine - rows + 1);
    wrapped.slice(start, start + rows).forEach((line, i) => grid.text(4, y + i, line.text, 'accent', available));
  }
  if (view === 'library') {
    const tabs = ['All ' + store.data.books.length, 'Reading', 'Unread', 'Finished'];
    let tx = 2; tabs.forEach((label, i) => {const t = i === shelf ? '[' + label + ']' : label; if (tx + t.length < w - 2) {grid.text(tx, 3, t, i === shelf ? 'accent' : 'muted'); tx += t.length + 2;}});
    const entry = books[clamp(cursor, 0, Math.max(0, books.length - 1))];
    const split = Math.floor(w * .58), visible = Math.max(1, Math.floor((h - (wide ? 14 : 12)) / 2));
    const start = Math.max(0, Math.min(cursor - visible + 1, books.length - visible));
    if (wide) {grid.box(1, 5, split - 1, h - 12, 'Books', true); grid.box(split + 1, 5, w - split - 2, h - 12, 'Book details');}
    const listWidth = wide ? split - 6 : w - 4, listY = wide ? 7 : 6;
    if (!books.length) {
      row(8, store.data.books.length ? 'No books match this shelf or filter.' : 'Your library is empty.', 'accent');
      grid.wrap(2, 11, store.data.books.length ? '/ edit filter · f change shelf' : 'Add an EPUB or a text file to start reading.', w - 4);
      row(15, 'i  Import a book', 'accent');
      if (h > 25) {row(20, 'Or open one from your shell:', 'muted'); row(22, 'joobook ~/Books/alice.epub');}
    } else books.slice(start, start + visible).forEach((b, i) => {
      const y = listY + i * 2, selected = b === entry;
      const percent = `${Math.floor(b.percent)}%`, title = truncate(b.title, listWidth - 9);
      if (selected) grid.selected(wide ? 3 : 2, y, '> ' + title, listWidth); else grid.text(wide ? 3 : 2, y, '  ' + title, 'text', listWidth);
      grid.text((wide ? split - 9 : w - 7), y, percent, selected ? 'selected' : 'muted', 5);
      grid.clipped(wide ? 5 : 4, y + 1, b.author, listWidth - 3, 'muted');
    });
    if (wide && entry) {
      const x = split + 4, width = w - x - 4;
      if (h < 30) {
        const details = [entry.title, `${entry.format} · ${countLabel(entry)} · ${Math.floor(entry.percent)}%`, entry.author, `${entry.bookmarks.length} bookmarks · ${entry.notes.length} notes`, 'Enter  Continue reading'];
        details.slice(0, Math.max(1, h - 15)).forEach((text, i) => grid.clipped(x, 7 + i, text, width, i === 0 ? 'accent' : 'muted'));
      } else {
        grid.wrap(x, 8, entry.title, width, 'accent', 2); grid.wrap(x, 11, entry.author, width, 'muted', 2);
        grid.text(x, 14, `${entry.format} · ${countLabel(entry)}`, 'muted', width);
        grid.text(x, 17, entry.percent >= 100 ? 'Finished' : entry.percent > 0 ? 'Currently reading' : 'Unread', 'ok', width);
        grid.clipped(x, 19, `${entry.location || `Section ${entry.position.chapter + 1}`} · ${Math.floor(entry.percent)}%`, width);
        grid.text(x, 22, `${entry.bookmarks.length} bookmarks · ${entry.notes.length} notes`, 'muted', width); grid.text(x, 25, 'Enter  Continue reading', 'accent', width);
      }
    }
    status(`${books.length} books · ${['last opened first', 'title A–Z', 'author A–Z'][sort]}${filter ? ' · filter: ' + filter : ''}`);
    footer(wide ? '↑/↓ select  Enter read  i import  / filter  s sort  f shelf  d remove  , settings  ? help' : '↑/↓ select  Enter read  i import  ? help');
    if (form === 'filter') {status('Filter books'); drawEditor(statusY + 1, 1); footer('Enter apply filter  Esc cancel');}
  } else if ((view === 'reader' || view === 'select') && book) {
    const chapter = chapterInfo(book, position);
    const x = Math.floor((w - textWidth) / 2), startY = h < 25 ? 6 : 8;
    if (!(focus && view === 'reader')) {
      grid.text(x, 3, chapter.header, 'accent', textWidth);
      grid.clipped(x, 5, chapter.title, textWidth);
    } else {grid.clear(0, 0, w); grid.row(0, book.title, 'muted');}
    const actualStart = focus && view === 'reader' ? 3 : startY;
    const capacity = Math.max(1, Math.floor((statusY - actualStart - 1) / (settings.spacing === 'relaxed' ? 2 : 1)));
    const top = Math.min(lineIndex, Math.max(0, lines.length - 1));
    lines.slice(top, top + capacity).forEach((line, index) => {
      const y = actualStart + index * (settings.spacing === 'relaxed' ? 2 : 1);
      const parts = line.parts || [{text: line.text, start: line.start, end: line.end, style: 'text' as const}];
      let cx = x;
      for (const part of parts) {
        if (view !== 'select' || part.start === undefined) grid.text(cx, y, part.text, part.style || 'text', textWidth - (cx - x));
        else {
          const a = Math.min(selection.anchor, selection.cursor), b = Math.max(selection.anchor, selection.cursor);
          let column = cx;
          for (const point of new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(part.text)) {
            grid.text(column, y, point.segment, part.start + point.index >= a && part.start + point.index < b ? 'selected' : part.style || 'text');
            column = cx + stringWidth(part.text.slice(0, point.index + point.segment.length));
          }
        }
        cx += stringWidth(part.text);
      }
    });
    if (view === 'select') {status(`VISUAL · ${Math.abs(selection.cursor - selection.anchor)} characters selected`); footer('Arrows extend  n add note  y copy  Esc cancel');}
    else if (focus) {status(`${Math.floor(progress(book, position))}%`); footer('f show controls');}
    else {status(`${truncate(book.title, Math.max(10, w - 30))} · ${Math.floor(progress(book, position))}%`); footer(wide ? '←/→ page  ↑/↓ scroll  t contents  / find  b bookmark  a notes  ? help' : '←/→ page  ↑/↓ scroll  ? help');}
  } else if (view === 'contents' && book) {
    const visible = Math.max(1, Math.floor((h - 10) / 2)), start = Math.max(0, cursor - visible + 1);
    const count = numberedChapters.length ? `${numberedChapters.length} chapters` : `${contents.length} sections`;
    const pw = wide ? Math.floor(w * .46) : w - 2; grid.box(1, 3, pw, h - 9, `Contents · ${count}`, true);
    const current = contentsIndex(book, position);
    contents.slice(start, start + visible).forEach((c, i) => {const n = start + i, label = c.kind === 'chapter' ? String(c.number).padStart(2) : '  ', text = `${n === current ? '>' : ' '} ${label}  ${'  '.repeat(Math.min(3, c.depth))}${c.title}`; if (n === cursor) grid.selected(3, 5 + i * 2, text, pw - 4); else grid.clipped(3, 5 + i * 2, text, pw - 4);});
    if (wide) {const x = pw + 5; grid.text(x, 6, 'READING POSITION', 'muted'); grid.wrap(x, 9, chapterInfo(book, position).title, w - x - 3, 'accent', 3); grid.wrap(x, 14, book.chapters[position.chapter]!.text.slice(position.offset, position.offset + 600), w - x - 4, 'muted', Math.max(1, h - 21));}
    status(`Entry ${cursor + 1} / ${contents.length} · > current section`); footer('↑/↓ select  Enter jump  Esc reading');
  } else if (['bookmarks', 'notes', 'find'].includes(view) && book) {
    row(3, truncate(book.title, w - 4), 'accent');
    const items = view === 'find' ? matches : view === 'notes' ? active?.notes || [] : active?.bookmarks || [];
    const start = Math.max(0, cursor - listRows + 1);
    if (view === 'find' && form !== 'query') row(5, `/ ${query || 'Enter a search phrase'}`, 'muted');
    if (!items.length) {
      row(9, view === 'find' ? 'No matches' : `No ${view} yet.`, 'warn');
      grid.wrap(2, 12, view === 'find' ? 'Try a shorter phrase. Enter edits your search.' : view === 'notes' ? 'While reading, press v to select a passage, then n to write a note.' : 'While reading, press b to save the current position.', w - 4, 'muted', 4);
    }
    items.slice(start, start + listRows).forEach((item, i) => {
      const y = 7 + i * rowStep, n = start + i;
      const title = `${chapterInfo(book, item.position).label} · ${Math.floor(progress(book, item.position))}%`;
      if (n === cursor) grid.selected(2, y, '> ' + title, w - 4); else row(y, '  ' + title, 'muted');
      const detail = 'snippet' in item ? item.snippet : 'name' in item ? item.name : item.quote;
      grid.wrap(4, y + 1, detail, w - 8, view === 'notes' ? 'accent' : 'text', 1);
      if ('text' in item) grid.wrap(4, y + 2, item.text || '(highlight without a note)', w - 8, 'muted', 1);
      else if ('quote' in item) grid.wrap(4, y + 2, item.quote, w - 8, 'muted', 1);
    });
    status(`${items.length}${view === 'find' && items.length >= 1000 ? '+' : ''} ${view === 'find' ? 'matches' : view} · ${items.length ? cursor + 1 : 0} / ${items.length}`);
    footer(view === 'find' ? 'Enter jump/edit  / search  Esc reading' : view === 'notes' ? 'Enter jump  e edit  d delete  x export  Esc' : 'Enter jump  r rename  d delete  x export  Esc');
    if (form === 'query') {drawEditor(5, 1, '/ '); footer('Enter search  Esc cancel');}
  } else if (view === 'goto' || view === 'rename') {
    page(view === 'goto' ? 'Go to position' : 'Rename bookmark');
    grid.wrap(3, 6, view === 'goto' ? numberedChapters.length ? `Enter 0–100% or ch 1–${numberedChapters.length}.` : 'Enter 0–100%.' : 'Enter a name for this bookmark.', w - 6, 'muted', 2);
    drawEditor(10, Math.max(1, h - 19)); footer('Enter save  Esc cancel');
  } else if (view === 'note' && book) {
    page('Edit note');
    const quote = book.chapters[position.chapter]!.text.slice(Math.min(selection.anchor, selection.cursor), Math.max(selection.anchor, selection.cursor));
    const quoteRows = Math.min(5, Math.max(2, Math.floor((h - 13) / 3)));
    grid.wrap(3, 5, quote, w - 6, 'accent', quoteRows); grid.rule(6 + quoteRows, 3, w - 6);
    grid.text(4, 7 + quoteRows, 'Your note', 'muted'); drawEditor(8 + quoteRows, Math.max(1, statusY - 9 - quoteRows));
    status('Unsaved changes · blank note saves a highlight'); footer('Ctrl+S save  Enter new line  Esc cancel');
  } else if (view === 'import') {
    grid.clipped(2, 3, folder, w - 4, 'accent');
    if (form !== 'path') row(5, returnView === 'unavailable' ? 'Locate the original book file' : 'TYPE   NAME', 'muted');
    const visible = Math.max(1, Math.floor((h - 12) / 2)), start = Math.max(0, cursor - visible + 1);
    files.slice(start, start + visible).forEach((f, i) => {const text = `${f.directory ? '[dir]' : chosen.includes(f.path) ? '[+]' : '[ ]'}  ${f.name}${f.directory && f.name !== '../' ? '/' : ''}`; if (start + i === cursor) grid.selected(2, 7 + i * 2, '> ' + text); else grid.clipped(2, 7 + i * 2, '  ' + text, w - 4);});
    if (!files.length && !busy) grid.wrap(2, 8, 'No EPUB or TXT files here. Press p to type a different path.', w - 4, 'muted', 4);
    status(`${chosen.length} selected · originals stay on disk`); footer('Space select  Enter open/import  p path  Esc');
    if (form === 'path') {drawEditor(5, 2); footer('Enter open path  Esc cancel');}
  } else if (view === 'importing') {
    row(3, `Importing · ${results.length} / ${queueSize}`, 'accent');
    const shown = results.slice(-Math.max(1, Math.floor((h - 16) / 2)));
    shown.forEach((r, i) => grid.clipped(2, 7 + i * 2, `${r.error ? '[!]' : '[ok]'} ${r.name}`, w - 4, r.error ? 'error' : 'ok'));
    grid.clipped(2, statusY - 3, '[..] ' + importName, w - 4, 'accent');
    status(notice || 'Reading text and chapter metadata…'); footer('Esc cancel remaining imports');
  } else if (view === 'import-error') {
    const result = results[clamp(cursor, 0, Math.max(0, results.length - 1))];
    row(3, `${results.filter(r => !r.error).length} imported · ${results.filter(r => r.error).length} failed`, 'muted');
    if (result) {
      grid.clipped(3, 5, result.name, w - 6, 'accent');
      const details = wrapText(result.error || 'Imported successfully.', w - 6), count = Math.max(1, statusY - 8);
      const start = Math.min(detailScroll, Math.max(0, details.length - count));
      details.slice(start, start + count).forEach((line, i) => grid.text(3, 7 + i, line.text, result.error ? 'error' : 'ok', w - 6));
      status(`File ${cursor + 1} / ${results.length} · line ${start + 1} / ${details.length}`);
    }
    footer('↑/↓ file  PgUp/Dn scroll  r retry  Enter library');
  } else if (view === 'preferences') {
    page('Preferences');
    const rows = [['Theme', prefs.theme], ['Reading width', `${prefs.width} columns`], ['Line spacing', prefs.spacing], ['Resume last book', prefs.resume ? 'On' : 'Off'], ['Navigation', prefs.navigation === 'vim' ? 'Vim + arrows' : 'Arrows only']];
    const step = h < 26 ? 1 : 3;
    rows.forEach(([label, value], i) => {const y = 5 + i * step; if (w < 60) {const text = `${label}: ${value}`; if (i === cursor) grid.selected(3, y, '> ' + text, w - 6); else grid.clipped(5, y, text, w - 8);} else {if (i === cursor) grid.selected(3, y, '> ' + label, w - 6); else grid.text(5, y, label!); grid.text(Math.floor(w / 2), y, value!, i === cursor ? 'selected' : 'muted', Math.floor(w / 2) - 5);}});
    if (h >= 26) {grid.text(5, 5 + rows.length * step, 'Library data · change with --home', 'muted', w - 10); grid.clipped(5, 6 + rows.length * step, store.home, w - 10, 'muted');}
    status('Changes preview; Ctrl+S keeps them.'); footer('↑/↓ field  ←/→ change  Ctrl+S save  Esc');
  } else if (view === 'help') {
    const wrapped = helpLines;
    const start = Math.min(cursor, Math.max(0, wrapped.length - (h - 9)));
    wrapped.slice(start, start + h - 9).forEach((line, i) => grid.text(3, 3 + i, line, line && line === line.toUpperCase() ? 'accent' : 'text', w - 6));
    status(`Help ${start + 1}–${Math.min(wrapped.length, start + h - 9)} / ${wrapped.length}`); footer('↑/↓ scroll  PgUp/PgDn page  Esc close');
  } else if (view === 'confirm' && confirmation) {
    grid.clipped(2, 3, confirmation.title, w - 4, 'accent');
    const description = wrapText(confirmation.description, w - 6), count = Math.max(1, h - 11);
    const start = Math.min(cursor, Math.max(0, description.length - count));
    description.slice(start, start + count).forEach((line, i) => grid.text(3, 5 + i, line.text, 'text', w - 6));
    const y = h - 6; if (!confirmRemove) grid.selected(3, y, '[ Keep ]', 10); else grid.text(3, y, '  Keep');
    if (confirmRemove) grid.selected(16, y, '[ Delete ]', 12); else grid.text(16, y, '  Delete', 'muted');
    status(`Keep is default · line ${start + 1} / ${description.length}`); footer('↑/↓ scroll  ←/→ choose  Enter confirm  Esc');
  } else if (view === 'unavailable') {
    row(3, 'Book file unavailable', 'accent'); grid.clipped(3, 5, active?.title || '', w - 6);
    const details = wrapText(unavailableError || 'The source file was moved or cannot be read.', w - 6), count = Math.max(1, statusY - 8);
    const start = Math.min(detailScroll, Math.max(0, details.length - count));
    details.slice(start, start + count).forEach((line, i) => grid.text(3, 7 + i, line.text, 'error', w - 6));
    status('Saved progress and notes are kept.'); footer('↑/↓ scroll  l locate file  Esc library');
  } else if (view === 'error') {
    row(3, 'Could not complete the action', 'error');
    const details = wrapText(errorDetail?.text || '', w - 6), count = Math.max(1, statusY - 6), start = Math.min(cursor, Math.max(0, details.length - count));
    details.slice(start, start + count).forEach((line, i) => grid.text(3, 5 + i, line.text, 'text', w - 6));
    status(`Line ${start + 1} / ${details.length}`); footer('↑/↓ scroll  PgUp/Dn page  Esc back');
  }
  if (busy && view !== 'importing') status(notice || 'Loading…');
  if (notice && !busy && view !== 'importing') status(notice, 'ok');
  if (error && view !== 'unavailable' && view !== 'error') {status(error, 'error'); footer('! full error  Esc back');}
  return <Terminal grid={grid} theme={theme}/>;
}

