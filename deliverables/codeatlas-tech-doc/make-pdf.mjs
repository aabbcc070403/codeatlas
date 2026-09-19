// Temp helper: render index.html and print it to the deliverable PDF (A4).
// Usage (from anywhere): node deliverables/codeatlas-tech-doc/make-pdf.mjs
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, 'index.html');
const outPath = join(here, '..', 'CodeAtlas-技术文档.pdf');
const shotPath = join(here, '.preview-full.png');

async function launch() {
  try {
    return await chromium.launch();
  } catch (error) {
    console.warn('bundled chromium unavailable, trying msedge channel:', error.message);
    return await chromium.launch({ channel: 'msedge' });
  }
}

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });

// Wait until every mermaid block has rendered into an svg.
await page.waitForFunction(() => {
  const blocks = Array.from(document.querySelectorAll('.mermaid'));
  return blocks.length > 0 && blocks.every((b) => b.querySelector('svg'));
}, null, { timeout: 60000 });
await page.waitForTimeout(400);

// Full-page screenshot for visual verification (deleted after inspection).
await page.screenshot({ path: shotPath, fullPage: true });

await page.emulateMedia({ media: 'print' });
await page.pdf({
  path: outPath,
  format: 'A4',
  printBackground: true,
  margin: { top: '14mm', bottom: '14mm', left: '13mm', right: '13mm' }
});

const buf = readFileSync(outPath);
const text = buf.toString('latin1');
const pageMarkers = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
const maxCount = counts.length ? Math.max(...counts) : -1;
console.log('PDF written:', outPath);
console.log('size(bytes):', buf.length, '| /Type/Page markers:', pageMarkers, '| max /Count:', maxCount);
await browser.close();
