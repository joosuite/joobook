import React from 'react';
import {PassThrough, Writable} from 'node:stream';
import {stripVTControlCharacters} from 'node:util';
import {existsSync} from 'node:fs';
import {mkdir, writeFile, copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import xterm from '@xterm/headless';
import {createCanvas, GlobalFonts} from '@napi-rs/canvas';
import {createDemo} from './demo.js';

process.env.FORCE_COLOR = '3';
delete process.env.NO_COLOR;
const {render, Box, Text} = await import('ink');
const {App} = await import('../src/app.js');
const {palettes} = await import('../src/terminal.js');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, '.impeccable', 'review');
const fonts = ['/System/Library/Fonts/Menlo.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', 'C:\\Windows\\Fonts\\consola.ttf'];
const font = fonts.find(existsSync);
const family = font && GlobalFonts.registerFromPath(font, 'JoobookMono') ? 'JoobookMono' : 'monospace';

class Input extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean) {this.isRaw = value; return this;}
  ref() {return this;}
  unref() {return this;}
}
class Output extends Writable {
  isTTY = true;
  frame = '';
  constructor(readonly columns: number, readonly rows: number) {super();}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {this.frame = chunk.toString(); done();}
}
type Capture = {name: string; columns: number; rows: number; steps?: [string, string][]; light?: boolean; missing?: boolean; system?: boolean; tables?: boolean};
const captures: Capture[] = [
  {name: 'library-wide', columns: 120, rows: 36},
  {name: 'reader-wide', columns: 120, rows: 36, steps: [['\r', 'CHAPTER 1']]},
  {name: 'contents', columns: 100, rows: 36, steps: [['\r', 'CHAPTER 1'], ['t', 'Contents']]},
  {name: 'find', columns: 100, rows: 36, steps: [['\r', 'CHAPTER 1'], ['/', 'find in book'], ['garden', 'garden'], ['\r', 'matches']]},
  {name: 'notes', columns: 100, rows: 36, steps: [['\r', 'CHAPTER 1'], ['a', '1 notes']]},
  {name: 'note-editor', columns: 100, rows: 36, steps: [['\r', 'CHAPTER 1'], ['v', 'VISUAL'], ['n', 'Your note']]},
  {name: 'preferences', columns: 100, rows: 36, steps: [[',', 'Preferences']]},
  {name: 'library-narrow', columns: 52, rows: 24},
  {name: 'reader-minimum', columns: 36, rows: 19, steps: [['\r', 'CHAPTER 1']]},
  {name: 'preferences-minimum', columns: 36, rows: 19, steps: [[',', 'Preferences']]},
  {name: 'library-short-wide', columns: 90, rows: 19},
  {name: 'note-minimum', columns: 36, rows: 19, steps: [['\r', 'CHAPTER 1'], ['v', 'VISUAL'], ['n', 'Your note'], ['A note about the lamp.', 'A note about the lamp.']]},
  {name: 'remove-minimum', columns: 36, rows: 19, steps: [['d', 'Remove book'], ['\x1b[6~', 'on disk.']]},
  {name: 'import-error-minimum', columns: 36, rows: 19, steps: [['i', 'import local books'], ['p', 'Enter open path'], ['damaged.epub', 'Enter open path'], ['\r', '1 failed']]},
  {name: 'reader-light', columns: 100, rows: 36, light: true, steps: [['\r', 'CHAPTER 1']]},
  {name: 'unavailable-minimum', columns: 36, rows: 19, missing: true, steps: [['\r', 'Book file unavailable'], ['\x1b[6~', 'Saved progress']]},
  {name: 'system-terminal', columns: 100, rows: 36, system: true, steps: [[',', 'Preferences']]},
  {name: 'system-terminal-minimum', columns: 36, rows: 19, system: true, steps: [[',', 'Preferences']]},
  {name: 'tables-wide', columns: 100, rows: 36, system: true, tables: true, steps: [['\r', 'Workshop options']]},
  {name: 'tables-minimum', columns: 36, rows: 19, system: true, tables: true, steps: [['\r', 'Row 1']]},
  {name: 'tables-minimum-next', columns: 36, rows: 19, system: true, tables: true, steps: [['\r', 'Row 1'], ['\x1b[C', 'Problem']]},
];

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);}
  return (crc ^ 0xffffffff) >>> 0;
}
function provenance(png: Buffer, description: string): Buffer {
  const data = Buffer.concat([Buffer.from('tEXt'), Buffer.from('impeccable:prompt\0' + description)]);
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length - 4); checksum.writeUInt32BE(crc32(data));
  return Buffer.concat([png.subarray(0, -12), length, data, checksum, png.subarray(-12)]);
}
const ansi16 = ['#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5', '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff'];
function color(number: number, rgb: boolean, palette: boolean, fallback: string, ansi = ansi16): string {
  if (rgb) return '#' + number.toString(16).padStart(6, '0');
  if (!palette) return fallback;
  if (number < 16) return ansi[number]!;
  if (number >= 232) {const n = 8 + (number - 232) * 10; return `rgb(${n},${n},${n})`;}
  const n = number - 16, level = (v: number) => v ? 55 + v * 40 : 0;
  return `rgb(${level(Math.floor(n / 36))},${level(Math.floor(n / 6) % 6)},${level(n % 6)})`;
}
async function capture(spec: Capture) {
  const demo = await createDemo(spec.missing, spec.tables), stdout = new Output(spec.columns, spec.rows), stdin = new Input();
  // An illustrative blue terminal profile tests inherited colors, not a joobook palette.
  const palette = spec.system ? {...palettes.dark, background: '#2453aa', text: '#ffffff'} : palettes[spec.light ? 'light' : 'dark'];
  const ansi = spec.system ? ansi16.map((value, i) => ({1: '#ffd0d0', 2: '#caf5ae', 3: '#fff2ad', 6: '#bbf0ff'}[i] || value)) : ansi16;
  const cellColor = (value: number, rgb: boolean, indexed: boolean, fallback: string) => color(value, rgb, indexed, fallback, ansi);
  const app = render(<Box flexDirection="column"><Text color={spec.system ? undefined : palette.muted}>{spec.columns < 52 ? 'DEMO / INK OUTPUT' : 'DEMO LIBRARY / ACTUAL INK OUTPUT'}</Text><App store={demo.store} startLibrary size={{columns: spec.columns, rows: spec.rows - 1}} theme={spec.system ? 'system' : spec.light ? 'light' : 'dark'}/></Box>, {
    stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: new Output(spec.columns, spec.rows) as unknown as NodeJS.WriteStream,
    debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  const wait = async (text: string) => {
    for (let i = 0; i < 150; i++) {await pause(25); if (stripVTControlCharacters(stdout.frame).replace(/\s+/g, ' ').includes(text)) {await pause(60); return;}}
    throw new Error(`${spec.name}: missing ${text}\n${stripVTControlCharacters(stdout.frame)}`);
  };
  const terminal = new xterm.Terminal({cols: spec.columns, rows: spec.rows, convertEol: true, allowProposedApi: true, scrollback: 0});
  try {
    await wait('The Reading Room');
    for (const [keys, expected] of spec.steps || []) {stdin.write(keys); await wait(expected);}
    await new Promise<void>(resolve => terminal.write(stdout.frame, resolve));
    const canvas = createCanvas(spec.columns * 9 + 24, spec.rows * 21 + 24), context = canvas.getContext('2d');
    context.fillStyle = palette.background; context.fillRect(0, 0, canvas.width, canvas.height);
    const text: string[] = [];
    for (let y = 0; y < spec.rows; y++) {
      const line = terminal.buffer.active.getLine(y)!; text.push(line.translateToString(false));
      for (let x = 0; x < spec.columns; x++) {
        const cell = line.getCell(x)!;
        context.fillStyle = cell.isInverse() ? cellColor(cell.getFgColor(), cell.isFgRGB(), cell.isFgPalette(), palette.text) : cellColor(cell.getBgColor(), cell.isBgRGB(), cell.isBgPalette(), palette.background);
        context.fillRect(12 + x * 9, 12 + y * 21, 9, 21);
      }
      for (let x = 0; x < spec.columns; x++) {
        const cell = line.getCell(x)!; if (!cell.getWidth() || !cell.getChars().trim()) continue;
        context.fillStyle = cell.isInverse() ? cellColor(cell.getBgColor(), cell.isBgRGB(), cell.isBgPalette(), palette.background) : cellColor(cell.getFgColor(), cell.isFgRGB(), cell.isFgPalette(), palette.text);
        context.font = `${cell.isBold() ? 'bold ' : ''}15px ${family}`;
        context.fillText(cell.getChars(), 12 + x * 9, 28 + y * 21);
      }
    }
    if (!text.join('\n').includes('DEMO')) throw new Error('Capture lost its demo label.');
    const origin = `Source: actual joobook React/Ink frames captured by scripts/capture-screenshots.tsx in a ${spec.columns}x${spec.rows} virtual terminal.${spec.system ? ' System theme with an illustrative custom blue terminal profile; not the user\'s actual Ocean configuration.' : ''} Original demo content from scripts/demo.ts. No user data; no generated image.`;
    await writeFile(join(output, spec.name + '.png'), provenance(await canvas.encode('png'), origin));
    await writeFile(join(output, spec.name + '.txt'), text.join('\n') + '\n');
    console.log(spec.name);
  } finally {terminal.dispose(); app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); await demo.dispose();}
}
await mkdir(output, {recursive: true});
const requested = process.argv.slice(2);
for (const name of requested) if (!captures.some(c => c.name === name)) throw new Error('Unknown capture: ' + name);
for (const spec of captures.filter(c => !requested.length || requested.includes(c.name))) await capture(spec);
const assets = join(root, 'assets', 'screenshots'); await mkdir(assets, {recursive: true});
if (!requested.length || requested.includes('library-wide')) await copyFile(join(output, 'library-wide.png'), join(assets, 'library.png'));
if (!requested.length || requested.includes('reader-wide')) await copyFile(join(output, 'reader-wide.png'), join(assets, 'reader.png'));
