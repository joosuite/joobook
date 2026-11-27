#!/usr/bin/env node
import React from 'react';
import {parseArgs} from 'node:util';
import {render} from 'ink';
import {App} from './app.js';
import {LibraryStore} from './store.js';
import {clean, type Ebook, type Preferences} from './model.js';

const help = `joobook · read local EPUB and TXT ebooks in your terminal

Usage: joobook [options] [book.epub | book.txt ...]

  --home PATH        Store the library, positions, and notes here
  --theme NAME       system, dark, or light; overrides the saved theme
  --library          Start at the library instead of resuming a book
  --list             Print the saved library as JSON; no TUI required
  --no-alt-screen    Render in the terminal's normal screen
  --help, -h         Show help
  --version, -v      Show version

File arguments import books. The first file opens after import unless --library
is supplied. With no file arguments, joobook resumes your last book by default.

In the app: i imports, Enter reads, ? lists shortcuts, and Ctrl+C saves and quits.
Original book files stay in place. Node.js 22+ is required.
`;

export async function main() {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {
    home: {type: 'string'}, theme: {type: 'string'}, library: {type: 'boolean'}, list: {type: 'boolean'},
    'no-alt-screen': {type: 'boolean'}, help: {type: 'boolean', short: 'h'}, version: {type: 'boolean', short: 'v'},
  }});
  if (values.help) {process.stdout.write(help); return;}
  if (values.version) {process.stdout.write('joobook 0.1.0\n'); return;}
  if (values.theme && !['system', 'dark', 'light'].includes(values.theme)) throw new Error('--theme must be system, dark, or light.');
  if (values.list && positionals.length) throw new Error('--list cannot be combined with files to import.');
  if (!values.list && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('joobook needs an interactive terminal. Use --list to inspect your library or --help for usage.');
  const store = new LibraryStore(values.home, {readonly: values.list});
  if (values.list) {process.stdout.write(JSON.stringify(store.data.books, null, 2) + '\n'); return;}
  let restored = false, instance: ReturnType<typeof render> | undefined;
  const alternate = !values['no-alt-screen'];
  const restore = () => {if (restored) return; restored = true; if (alternate) process.stdout.write('\x1b[?1049l'); process.stdout.write('\x1b[?25h');};
  const terminate = () => instance?.unmount();
  const onExit = () => {restore(); store.close();};
  process.once('exit', onExit); process.once('SIGTERM', terminate); process.once('SIGHUP', terminate);
  try {
    let first: Ebook | undefined;
    for (const path of positionals) {const imported = await store.import(path); first ??= imported;}
    if (alternate) process.stdout.write('\x1b[?1049h');
    instance = render(<App store={store} initialBook={values.library ? undefined : first} startLibrary={values.library} theme={values.theme as Preferences['theme'] | undefined}/>, {exitOnCtrlC: false, patchConsole: false});
    await instance.waitUntilExit();
  } finally {
    instance?.unmount(); restore(); store.close(); process.off('exit', onExit); process.off('SIGTERM', terminate); process.off('SIGHUP', terminate);
  }
}
main().catch(error => {process.stderr.write(`joobook: ${clean((error as Error).message)}\n`); process.exitCode = 1;});
