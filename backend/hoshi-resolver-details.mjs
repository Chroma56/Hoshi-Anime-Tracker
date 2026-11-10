
import { readFileSync } from 'node:fs';

const file = 'node_modules/anime-sdk/dist/index.cjs';
const lines = readFileSync(file, 'utf8').split(/\r?\n/);

function printSection(label, lineNumber, before = 12, after = 12) {
  console.log('\n--- ' + label + ' ---');
  const start = Math.max(1, lineNumber - before);
  const end = Math.min(lines.length, lineNumber + after);

  for (let n = start; n <= end; n++) {
    console.log(`${n}: ${lines[n - 1]}`);
  }
}

console.log('================================');
console.log('HOSHI RESOLVER DETAILS V1');
console.log('================================');

// MegaPlay errors identified by the previous inspection.
printSection('MEGAPLAY ERROR 1', 2105, 22, 8);
printSection('MEGAPLAY ERROR 2', 2257, 22, 8);

// Find AllManga's stream resolution method.
const start = lines.findIndex(line =>
  line.includes('var AllmangaProvider = class')
);

const end = lines.findIndex((line, index) =>
  index > start && line.includes('// src/providers/') 
);

if (start >= 0) {
  const stop = end > start ? end : Math.min(start + 700, lines.length);

  const matches = [];
  for (let i = start; i < stop; i++) {
    if (
      /resolveStream\(|throw new Error|streams\.length|sources\.length|tobeparsed/i
        .test(lines[i])
    ) {
      matches.push(i + 1);
    }
  }

  console.log('\nALLMANGA_MATCH_COUNT:', matches.length);

  for (const n of matches.slice(0, 12)) {
    printSection('ALLMANGA CODE', n, 5, 5);
  }
} else {
  console.log('ALLMANGA_CLASS_NOT_FOUND');
}

console.log('\nRESULT: RESOLVER_DETAILS_COMPLETE');
console.log('Local SDK source inspection only.');
