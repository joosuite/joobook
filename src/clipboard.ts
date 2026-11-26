import {spawn} from 'node:child_process';
export async function copyText(text: string): Promise<void> {
  const commands = process.platform === 'darwin' ? [['pbcopy']] : process.platform === 'win32' ? [['clip.exe']] : [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']];
  for (const [command, ...args] of commands) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command!, args, {stdio: ['pipe', 'ignore', 'ignore']});
        const timeout = setTimeout(() => {child.kill(); reject(new Error('Clipboard timed out.'));}, 2000);
        child.once('error', error => {clearTimeout(timeout); reject(error);});
        child.once('close', code => {clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Clipboard command failed.'));});
        child.stdin.on('error', () => {}); child.stdin.end(text);
      });
      return;
    } catch {}
  }
  throw new Error('Clipboard unavailable. Save a note, then use x in Notes to export the passage.');
}
