import { build } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// One HTML file, including the optional report exporters and embedded fonts.
// Opening the normal Vite dist/index.html via file:// cannot load module chunks.
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'dist-portable');
await build({
  root,
  base: './',
  build: {
    outDir: output,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    rolldownOptions: { output: { codeSplitting: false } },
  },
});

let html = await readFile(resolve(output, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)];
if (scripts.length !== 1) throw new Error('Expected a single bundled script.');
for (const [tag, path] of scripts) {
  const js = await readFile(resolve(output, path), 'utf8');
  html = html.replace(tag, () => `<script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script>`);
}
for (const [tag, path] of [...html.matchAll(/<link\b[^>]*\bhref="([^"]+\.css)"[^>]*>/g)]) {
  const css = await readFile(resolve(output, path), 'utf8');
  html = html.replace(tag, () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`);
}
if (/<(?:script|link)\b[^>]*(?:src|href)="(?:\.\/)?assets\//.test(html)) {
  throw new Error('Portable HTML still references external assets.');
}
const downloads = resolve(root, 'downloads');
await mkdir(downloads, { recursive: true });
await writeFile(resolve(downloads, 'Balance.html'), html);
console.log('Portable app: downloads/Balance.html');
