// Build step: gzip the documentation sources so the Worker can serve them as
// pre-compressed blobs (Content-Encoding: gzip, encodeBody: "manual"). Output is
// git-ignored and regenerated on every build (wrangler.toml [build].command), so
// llms.txt / index.html stay the single source of truth -- no committed binaries.
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

const sources = ['src/docs/index.html', 'src/docs/llms.txt'];
for (const file of sources) {
  const gz = gzipSync(readFileSync(file), { level: 9 });
  writeFileSync(`${file}.gz`, gz);
  console.log(`gzip ${file} -> ${file}.gz (${gz.length} bytes)`);
}
