import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {zipSync, strToU8, unzipSync} from 'fflate';
import {LibraryStore} from '../src/store.js';

export function epub(options: {epub2?: boolean; broken?: boolean} = {}): Uint8Array {
  const paragraph = 'The reading room was quiet. A traveller opened a book beside the lamp and found a note in the margin. The note pointed to a garden beyond the old station. ';
  return zipSync(Object.fromEntries(Object.entries({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'OPS/package.opf': `<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>The Reading Room</dc:title><dc:creator>Demo Author</dc:creator></metadata><manifest><item id="a" href="chapter%201.xhtml" media-type="application/xhtml+xml"/><item id="b" href="chapter2.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>`,
    'OPS/chapter 1.xhtml': options.broken ? '<html><body><img src="cover.jpg"/></body></html>' : `<html><head><title>First</title><style>.x{display:none}</style></head><body><h1>The station</h1><p>${paragraph.repeat(60)}</p><script>ignore me</script><p>中文 café 👩🏽‍💻</p></body></html>`,
    'OPS/chapter2.xhtml': options.broken ? '' : '<html><body><h1>The garden</h1><p>The garden was full of late roses. A second traveller was reading beside the gate.</p></body></html>',
    'OPS/nav.xhtml': options.epub2 ? '' : '<html><body><nav epub:type="toc"><ol><li><a href="chapter%201.xhtml">At the station</a></li><li><a href="chapter2.xhtml">In the garden</a></li></ol></nav></body></html>',
    'OPS/toc.ncx': options.epub2 ? '<ncx><navMap><navPoint><navLabel><text>At the station</text></navLabel><content src="chapter%201.xhtml"/><navPoint><navLabel><text>In the garden</text></navLabel><content src="chapter2.xhtml"/></navPoint></navPoint></navMap></ncx>' : '<ncx/>',
  }).map(([name, value]) => [name, strToU8(value)])));
}
export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'joobook-test-'));
  const path = join(directory, 'reader.epub'); await writeFile(path, epub());
  const textPath = join(directory, 'notes.txt'); await writeFile(textPath, 'Chapter 1\nA quiet room.\n\nChapter 2\nA garden.');
  const store = new LibraryStore(join(directory, 'state'));
  return {directory, path, textPath, store, dispose: async () => {store.close(); await rm(directory, {recursive: true, force: true});}};
}

export function chapterFixture() {
  const documents = Array.from({length: 17}, (_, i) => ({file: `front-${i}.xhtml`, title: `Foreword ${i + 1}`, type: 'frontmatter', body: '<p>Front matter, not a numbered chapter.</p>'}));
  documents.push(
    {file: 'chapter1.xhtml', title: 'Chapter 1. Audience building', type: 'chapter', body: `<p>${'A reader opens a book beside the station lamp. '.repeat(200)}</p>`},
    {file: 'exercise.xhtml', title: 'A practical exercise', type: 'bodymatter', body: '<p>This section continues chapter one in another content file.</p>'},
    {file: 'chapter2.xhtml', title: 'Chapter 2. Finding customers', type: 'chapter', body: '<p>The second chapter starts here.</p>'},
  );
  const files: Record<string, string> = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OPS/package.opf"/></rootfiles></container>',
    'OPS/package.opf': `<package><metadata><title>Chapter counter fixture</title></metadata><manifest>${documents.map((d, i) => `<item id="d${i}" href="${d.file}" media-type="application/xhtml+xml"/>`).join('')}<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/></manifest><spine>${documents.map((_, i) => `<itemref idref="d${i}"/>`).join('')}</spine></package>`,
    'OPS/nav.xhtml': `<html><body><nav epub:type="toc"><ol>${documents.slice(0, 17).map(d => `<li><a href="${d.file}">${d.title}</a></li>`).join('')}<li><a href="chapter1.xhtml">Chapter 1. Audience building</a><ol><li><a href="exercise.xhtml">A practical exercise</a></li></ol></li><li><a href="chapter2.xhtml">Chapter 2. Finding customers</a></li></ol></nav></body></html>`,
  };
  for (const d of documents) files['OPS/' + d.file] = `<html><body epub:type="${d.type}"><h1>${d.title}</h1>${d.body}</body></html>`;
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}

export function anchoredFixture(epub2 = false) {
  const files: Record<string, string> = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OPS/package.opf"/></rootfiles></container>',
    'OPS/package.opf': `<package><metadata><title>Anchored chapters</title></metadata><manifest><item id="book" href="book.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine><itemref idref="book"/></spine></package>`,
    'OPS/book.xhtml': '<html><body epub:type="part"><h1>Part I</h1><p>A preface before the chapters.</p><section epub:type="chapter" id="one"><h1>Chapter 1. A &amp; B</h1><p>First chapter text.</p><h2 id="inside">Introduction</h2><p>Still the first chapter.</p></section><section epub:type="chapter" id="第二"><h1>Chapter 2. The garden</h1><p>Second chapter text.</p></section></body></html>',
    'OPS/nav.xhtml': epub2 ? '<html/>' : '<html><body><nav epub:type="page-list"><ol><li><a href="book.xhtml#one">Page 9</a></li></ol></nav><nav epub:type="toc"><ol><li><a href="book.xhtml">Part I</a><ol><li><a href="book.xhtml#one">Chapter <span>1</span>. A &amp; B</a><ol><li><a href="book.xhtml#inside">Introduction</a></li></ol></li><li><a href="book.xhtml#%E7%AC%AC%E4%BA%8C">Chapter 2. The garden</a></li></ol></li></ol></nav></body></html>',
    'OPS/toc.ncx': '<ncx><navMap><navPoint><navLabel><text>Part I</text></navLabel><content src="book.xhtml"/><navPoint><navLabel><text>Chapter 1. A &amp; B</text></navLabel><content src="book.xhtml#one"/><navPoint><navLabel><text>Introduction</text></navLabel><content src="book.xhtml#inside"/></navPoint></navPoint><navPoint><navLabel><text>Chapter 2. The garden</text></navLabel><content src="book.xhtml#%E7%AC%AC%E4%BA%8C"/></navPoint></navPoint></navMap></ncx>',
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}

export function tableFixture(table = '<table><caption>Workshop options</caption><thead><tr><th>Service</th><th>Problem</th></tr></thead><tbody><tr><td>Small workshops</td><td>Time away from work</td></tr><tr><td>Follow-up</td><td>New habits fade</td></tr></tbody></table>') {
  const archive = unzipSync(epub());
  archive['OPS/chapter 1.xhtml'] = strToU8(`<html><body><h1>Chapter 1</h1><p>Before the table.</p>${table}<p>After the table.</p></body></html>`);
  return zipSync(archive);
}
