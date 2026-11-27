import React from 'react';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import xterm from '@xterm/headless';

// Enable color before Ink/Chalk load, so these tests inspect real ANSI output.
process.env.FORCE_COLOR = '3';
delete process.env.NO_COLOR;
const {renderToString} = await import('ink');
const {Grid, Terminal} = await import('../src/terminal.js');

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
