/* Hoshi SDK Resolver Inspection V1 — local files only; no network or video requests. */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const require = createRequire(import.meta.url);
console.log('================================');
console.log('HOSHI SDK RESOLVER INSPECTION V1');
console.log('================================');

let entry;
try { entry = require.resolve('anime-sdk'); }
catch { console.log('RESULT: SDK_PACKAGE_NOT_FOUND'); process.exitCode = 1; }

if (entry) {
  let directory = dirname(realpathSync(entry));
  let root = null;
  let pkg = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const candidate = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (candidate.name === 'anime-sdk') { root = directory; pkg = candidate; break; }
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  if (!root) {
    console.log('RESULT: PACKAGE_ROOT_NOT_FOUND');
    process.exitCode = 1;
  } else {
    console.log('SDK_VERSION:', String(pkg.version ?? 'unknown'));
    console.log('NODE_VERSION:', process.version);
    console.log('PACKAGE_ENTRY:', relative(root, entry));

    const patterns = [
      ['NO_VIDEO_SOURCES', /no video sources found|no video sources|no streams? found/i],
      ['MEGAPLAY_RESOLVER', /MegaPlayProvider|resolveStream\s*\(/],
      ['ALLMANGA_RESOLVER', /AllmangaProvider|AllMangaProvider/],
    ];
    const hits = Object.fromEntries(patterns.map(([name]) => [name, []]));
    let scanned = 0;
    let bytes = 0;

    function scan(dir, depth) {
      if (depth > 7 || scanned >= 500 || bytes >= 12_000_000) return;
      let children;
      try { children = readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const child of children) {
        if (scanned >= 500 || bytes >= 12_000_000) break;
        const path = join(dir, child.name);
        if (child.isDirectory()) {
          if (child.name !== 'node_modules' && !child.name.startsWith('.')) scan(path, depth + 1);
        } else if (child.isFile() && /\.(?:js|mjs|cjs|ts)$/.test(child.name) && !/\.d\.ts$/.test(child.name)) {
          let size;
          try { size = statSync(path).size; } catch { continue; }
          if (size > 2_000_000) continue;
          scanned++;
          bytes += size;
          let contents;
          try { contents = readFileSync(path, 'utf8'); } catch { continue; }
          const lines = contents.split(/\r?\n/);
          for (let line = 0; line < lines.length; line++) {
            for (const [name, re] of patterns) {
              if (hits[name].length >= 8 || !re.test(lines[line])) continue;
              const position = lines[line].search(re);
              const excerpt = lines[line].slice(Math.max(0, position - 70), position + 140)
                .replace(/https?:\/\/[^\s"'`<>]+/gi, '[URL_REDACTED]')
                .replace(/\b[A-Za-z0-9_-]{50,}\b/g, '[VALUE_REDACTED]');
              hits[name].push({ file: relative(root, path), line: line + 1, excerpt });
            }
          }
        }
      }
    }
    scan(root, 0);
    console.log('FILES_SCANNED:', scanned);
    for (const [name] of patterns) {
      console.log('--- ' + name + ' ---');
      if (!hits[name].length) console.log('NOT_FOUND');
      for (const hit of hits[name]) {
        console.log('FILE:', hit.file);
        console.log('LINE:', hit.line);
        console.log('CONTEXT:', hit.excerpt);
      }
    }
    console.log('RESULT: LOCAL_INSPECTION_COMPLETE');
    console.log('No provider requests, video downloads or proxy operations performed.');
  }
}
