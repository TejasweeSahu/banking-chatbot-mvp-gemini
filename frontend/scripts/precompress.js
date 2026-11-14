/**
 * Writes Brotli (.br) and gzip (.gz) copies of the built text assets so the
 * Express server can serve them pre-compressed (no runtime compression, which
 * would also risk buffering the chat's Server-Sent Events stream).
 */
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const TEXT = /\.(js|css|svg|json)$/;
let count = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (TEXT.test(name) && statSync(file).size > 1024) {
      const data = readFileSync(file);
      writeFileSync(`${file}.br`, brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
      writeFileSync(`${file}.gz`, gzipSync(data, { level: 9 }));
      count += 1;
    }
  }
}

walk(dist);
console.log(`precompressed ${count} files (br + gzip)`);
