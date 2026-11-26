import React from 'react';
import {Box, Text, render} from 'ink';
import {App} from '../src/app.js';
import {createDemo} from './demo.js';

const f = await createDemo(process.argv.includes('--missing'));
try {
  const app = render(<Box flexDirection="column"><Text color={process.argv.includes('--light') ? '#40516a' : '#a6b5cb'}>{process.stdout.columns < 52 ? 'DEMO / ACTUAL TUI' : 'DEMO LIBRARY / ACTUAL TERMINAL OUTPUT'}</Text><App store={f.store} startLibrary size={{columns: process.stdout.columns, rows: process.stdout.rows - 1}} theme={process.argv.includes('--light') ? 'light' : 'dark'}/></Box>, {exitOnCtrlC: false});
  const stop = () => app.unmount(); process.once('SIGTERM', stop);
  await app.waitUntilExit(); process.off('SIGTERM', stop);
} finally {await f.dispose();}
