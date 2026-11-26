import React from 'react';
import {Box, Text} from 'ink';
import stringWidth from 'string-width';
import {clean, truncate, wrapText, type Preferences} from './model.js';

export const palettes = {
  system: {background: undefined, text: undefined, muted: undefined, accent: 'cyan', border: undefined, selection: undefined, selected: undefined, ok: 'green', warn: 'yellow', error: 'red'},
  dark: {background: '#101827', text: '#e8edf5', muted: '#a6b5cb', accent: '#8cacff', border: '#576b86', selection: '#3154ae', selected: '#ffffff', ok: '#a6dba8', warn: '#f0cb82', error: '#ffabab'},
  light: {background: '#f5f7fb', text: '#172337', muted: '#40516a', accent: '#3154ae', border: '#64748b', selection: '#3154ae', selected: '#ffffff', ok: '#296537', warn: '#77500e', error: '#a72131'},
};
export type Style = 'text' | 'muted' | 'accent' | 'border' | 'selected' | 'ok' | 'warn' | 'error';
type Cell = {text: string; style: Style};
export class Grid {
  cells: Cell[][];
  constructor(readonly width: number, readonly height: number) {this.cells = Array.from({length: height}, () => Array.from({length: width}, () => ({text: ' ', style: 'text' as Style})));}
  text(x: number, y: number, value: string, style: Style = 'text', width = this.width - x): void {
    if (y < 0 || y >= this.height) return;
    let col = x;
    for (const {segment} of new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(clean(value).replace(/\n/g, ' '))) {
      const n = stringWidth(segment); if (!n) continue;
      if (col + n > Math.min(this.width, x + width)) break;
      if (col >= 0) {this.cells[y]![col] = {text: segment, style}; for (let i = 1; i < n; i++) this.cells[y]![col + i] = {text: '', style};}
      col += n;
    }
  }
  row(y: number, value: string, style: Style = 'text') {this.text(2, y, value, style, this.width - 4);}
  clear(x: number, y: number, width: number, height = 1) {
    for (let row = Math.max(0, y); row < Math.min(this.height, y + height); row++) for (let col = Math.max(0, x); col < Math.min(this.width, x + width); col++) this.cells[row]![col] = {text: ' ', style: 'text'};
  }
  clipped(x: number, y: number, value: string, width: number, style: Style = 'text') {this.text(x, y, truncate(value, width), style, width);}
  selected(x: number, y: number, value: string, width = this.width - x - 2) {
    for (let i = 0; i < width && x + i < this.width; i++) this.cells[y]![x + i] = {text: ' ', style: 'selected'};
    this.clipped(x, y, value, width, 'selected');
  }
  wrap(x: number, y: number, text: string, width: number, style: Style = 'text', rows = this.height - y): number {
    const lines = wrapText(clean(text), width).slice(0, rows);
    lines.forEach((line, i) => this.text(x, y + i, line.text, style, width)); return lines.length;
  }
  rule(y: number, x = 1, width = this.width - 2) {this.text(x, y, '─'.repeat(Math.max(0, width)), 'border');}
  box(x: number, y: number, width: number, height: number, title: string, active = false) {
    const style = active ? 'accent' : 'border';
    this.text(x, y, '┌' + '─'.repeat(width - 2) + '┐', style);
    this.text(x, y + height - 1, '└' + '─'.repeat(width - 2) + '┘', style);
    for (let row = y + 1; row < y + height - 1; row++) {this.text(x, row, '│', style); this.text(x + width - 1, row, '│', style);}
    this.text(x + 2, y, ' ' + truncate(title, width - 6) + ' ', style);
  }
}
export function Terminal({grid, theme}: {grid: Grid; theme: Preferences['theme']}) {
  const p = palettes[theme];
  return <Box flexDirection="column" width={grid.width} height={grid.height} backgroundColor={p.background}>
    {grid.cells.map((row, y) => {
      const runs: {text: string; style: Style}[] = [];
      for (const cell of row) {const last = runs.at(-1); if (last?.style === cell.style) last.text += cell.text; else runs.push({...cell});}
      return <Text key={y} wrap="truncate">{runs.map((run, i) => <Text key={i} color={run.style === 'selected' ? p.selected : p[run.style]} backgroundColor={run.style === 'selected' ? p.selection : p.background} inverse={theme === 'system' && run.style === 'selected'} bold={run.style === 'accent'}>{run.text}</Text>)}</Text>;
    })}
  </Box>;
}
