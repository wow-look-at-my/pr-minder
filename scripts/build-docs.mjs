// Build step: gzip the documentation sources so the Worker can serve them as
// pre-compressed blobs (Content-Encoding: gzip, encodeBody: "manual"). Output is
// git-ignored and regenerated at build time (wrangler.toml [build].command), so
// llms.txt / index.html stay the single source of truth -- no committed binaries.
//
// The gzip lands next to the sources, inside the tree `wrangler dev` watches. We only
// (re)write when the source is newer than the existing .gz, so the watcher doesn't see
// the build output change and rebuild in an infinite loop.
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';

for (const file of ['src/docs/index.html', 'src/docs/llms.txt']) {
  const out = `${file}.gz`;
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(file).mtimeMs) continue;
  const gz = gzipSync(readFileSync(file), { level: 9 });
  writeFileSync(out, gz);
  console.log(`gzip ${file} -> ${out} (${gz.length} bytes)`);
}
