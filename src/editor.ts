import type {Key} from 'ink';
import {clean} from './model.js';
export type Editor = {value: string; cursor: number};
export const editor = (value = ''): Editor => ({value, cursor: value.length});
export function edit(state: Editor, input: string, key: Key, multiline = false): Editor {
  const {value} = state; let {cursor} = state;
  const previous = () => cursor - ([...value.slice(0, cursor)].at(-1)?.length ?? 0);
  const next = () => cursor + ([...value.slice(cursor)][0]?.length ?? 0);
  if (key.ctrl) {
    if (input === 'a') cursor = value.lastIndexOf('\n', cursor - 1) + 1;
    if (input === 'e') {const end = value.indexOf('\n', cursor); cursor = end < 0 ? value.length : end;}
    if (input === 'u') return {value: value.slice(cursor), cursor: 0};
    return {value, cursor};
  }
  if (key.home) return {value, cursor: value.lastIndexOf('\n', cursor - 1) + 1};
  if (key.end) {const end = value.indexOf('\n', cursor); return {value, cursor: end < 0 ? value.length : end};}
  if (key.leftArrow) return {value, cursor: previous()};
  if (key.rightArrow) return {value, cursor: next()};
  if (key.upArrow || key.downArrow) {
    if (!multiline) return state;
    const start = value.lastIndexOf('\n', cursor - 1) + 1, column = cursor - start;
    if (key.upArrow && start > 0) {const previousStart = value.lastIndexOf('\n', start - 2) + 1; return {value, cursor: Math.min(start - 1, previousStart + column)};}
    if (key.downArrow) {const end = value.indexOf('\n', cursor); if (end >= 0) {const nextEnd = value.indexOf('\n', end + 1); return {value, cursor: Math.min(nextEnd < 0 ? value.length : nextEnd, end + 1 + column)};}}
    return state;
  }
  if (key.backspace || key.delete) {
    const begin = previous(); return {value: value.slice(0, begin) + value.slice(cursor), cursor: begin};
  }
  if (key.tab || key.escape || key.pageDown || key.pageUp || (key.return && !multiline)) return state;
  const inserted = key.return ? '\n' : clean(input).replace(multiline ? /\r/g : /[\r\n]/g, '');
  if (value.length + inserted.length > 100_000) return state;
  return {value: value.slice(0, cursor) + inserted + value.slice(cursor), cursor: cursor + inserted.length};
}
