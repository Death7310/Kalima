// Build the single-file offline app: dist/kalima.html
// Inlines every stylesheet in src/styles and every script in src/js (filename order)
// into src/index.html. No dependencies, no network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(rootDir, 'src');
const read = (p) => fs.readFileSync(p, 'utf8');
const list = (dir, ext) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(ext)).sort() : []);

let html = read(path.join(src, 'index.html'));
const css = list(path.join(src, 'styles'), '.css').map((f) => `/* ${f} */\n` + read(path.join(src, 'styles', f))).join('\n');
const jsFiles = list(path.join(src, 'js'), '.js');
const js = jsFiles
  .map((f) => `<script>\n// ---- ${f}\n` + read(path.join(src, 'js', f)).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--') + '\n</script>')
  .join('\n');

if (!html.includes('<!--KALIMA:CSS-->') || !html.includes('<!--KALIMA:JS-->')) {
  console.error('src/index.html must contain <!--KALIMA:CSS--> and <!--KALIMA:JS--> placeholders');
  process.exit(1);
}
html = html.replace('<!--KALIMA:CSS-->', () => `<style>\n${css}\n</style>`).replace('<!--KALIMA:JS-->', () => js);

fs.mkdirSync(path.join(rootDir, 'dist'), { recursive: true });
const out = path.join(rootDir, 'dist', 'kalima.html');
fs.writeFileSync(out, html);
console.log(`built ${path.relative(rootDir, out)}  (${(Buffer.byteLength(html) / 1024).toFixed(0)} KiB, ${jsFiles.length} scripts)`);
