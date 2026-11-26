import React from 'react';
import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as pause} from 'node:timers/promises';
import xterm from '@xterm/headless';
import {fixture} from './helpers.js';

// Enable color before Ink/Chalk load, so these tests inspect real ANSI output.
process.env.FORCE_COLOR = '3';
delete process.env.NO_COLOR;
const {renderToString} = await import('ink');
const {render, cleanup} = await import('ink-testing-library');
const {Grid, Terminal} = await import('../src/terminal.js');
const {App} = await import('../src/app.js');
afterEach(cleanup);

async function buffer(frame: string, columns = 40, rows = 4) {
  const terminal = new xterm.Terminal({cols: columns, rows, convertEol: true, allowProposedApi: true});
  await new Promise<void>(resolve => terminal.write(frame, resolve));
  return terminal;
}
test('System inherits terminal defaults and ANSI palette with inverse selection', async () => {
  const grid = new Grid(40, 4);
  grid.text(2, 0, 'Reader'); grid.selected(2, 1, '> Selected', 30);
  grid.text(2, 2, 'Accent', 'accent'); grid.text(2, 3, 'Success', 'ok');
  const frame = renderToString(<Terminal grid={grid} theme="system"/>, {columns: 40});
  assert.doesNotMatch(frame, /\x1b\[(?:38|48);[25];/);
  const terminal = await buffer(frame);
  try {
    const normal = terminal.buffer.active.getLine(0)!.getCell(2)!;
    assert.ok(normal.isFgDefault()); assert.ok(normal.isBgDefault());
    const selection = terminal.buffer.active.getLine(1)!.getCell(2)!;
    assert.ok(selection.isInverse()); assert.ok(selection.isFgDefault()); assert.ok(selection.isBgDefault());
    const accent = terminal.buffer.active.getLine(2)!.getCell(2)!;
    assert.ok(accent.isFgPalette()); assert.equal(accent.getFgColor(), 6);
    assert.ok(accent.isBgDefault());
    const success = terminal.buffer.active.getLine(3)!.getCell(2)!;
    assert.ok(success.isFgPalette()); assert.equal(success.getFgColor(), 2);
  } finally {terminal.dispose();}
});
test('explicit Dark and Light retain their fixed colors and cobalt selection', async () => {
  for (const [theme, background, foreground] of [['dark', 0x101827, 0xe8edf5], ['light', 0xf5f7fb, 0x172337]] as const) {
    const grid = new Grid(40, 4); grid.text(2, 0, 'Reader'); grid.selected(2, 1, '> Selected', 30);
    const terminal = await buffer(renderToString(<Terminal grid={grid} theme={theme}/>, {columns: 40}));
    try {
      const normal = terminal.buffer.active.getLine(0)!.getCell(2)!;
      assert.ok(normal.isFgRGB()); assert.ok(normal.isBgRGB());
      assert.equal(normal.getFgColor(), foreground); assert.equal(normal.getBgColor(), background);
      const selection = terminal.buffer.active.getLine(1)!.getCell(2)!;
      assert.equal(selection.getFgColor(), 0xffffff); assert.equal(selection.getBgColor(), 0x3154ae);
      assert.equal(selection.isInverse(), 0);
    } finally {terminal.dispose();}
  }
});
test('System works without COLORFGBG and preferences preview, save, and cancellation restore the chosen colors', async () => {
  const previous = process.env.COLORFGBG; delete process.env.COLORFGBG;
  const f = await fixture(); let app: ReturnType<typeof render> | undefined;
  const wait = async (predicate: (frame: string) => boolean) => {
    for (let i = 0; i < 100; i++) {await pause(20); if (predicate(app!.lastFrame() || '')) {await pause(40); return;}}
    assert.fail('Expected theme was not rendered: ' + app!.lastFrame());
  };
  const press = async (key: string) => {app!.stdin.write(key); await pause(80);};
  const expectBackground = async (hex: number) => {
    const terminal = await buffer(app!.lastFrame()!, 72, 29);
    try {assert.equal(terminal.buffer.active.getLine(0)!.getCell(0)!.getBgColor(), hex);} finally {terminal.dispose();}
  };
  try {
    app = render(<App store={f.store} startLibrary size={{columns: 72, rows: 30}}/>);
    await wait(frame => frame.includes('Your library is empty'));
    assert.doesNotMatch(app.lastFrame()!, /\x1b\[(?:38|48);[25];/);
    await press(','); await wait(frame => frame.includes('Preferences'));
    await press('\x1b[C'); await expectBackground(0x101827);
    await press('\x1b[C'); await expectBackground(0xf5f7fb);
    await press('\x1b[C'); assert.doesNotMatch(app.lastFrame()!, /\x1b\[(?:38|48);[25];/);
    await press('\x13'); await wait(frame => frame.includes('Preferences saved'));
    assert.equal(f.store.data.preferences.theme, 'system');
    await press(','); await wait(frame => frame.includes('Preferences'));
    await press('\x1b[C'); await press('\x13'); await wait(frame => frame.includes('Preferences saved'));
    assert.equal(f.store.data.preferences.theme, 'dark');
    await press(','); await wait(frame => frame.includes('Preferences'));
    await press('\x1b[C'); await expectBackground(0xf5f7fb);
    await press('\x1b'); await expectBackground(0x101827);
    assert.equal(f.store.data.preferences.theme, 'dark');
  } finally {app?.unmount(); await f.dispose(); if (previous === undefined) delete process.env.COLORFGBG; else process.env.COLORFGBG = previous;}
});
