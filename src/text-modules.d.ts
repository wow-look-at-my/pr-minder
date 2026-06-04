// The docs are gzipped at build time (scripts/build-docs.mjs) and imported as binary
// blobs. Wrangler's "Data" module rule (wrangler.toml) makes a .gz import an ArrayBuffer.
declare module '*.gz' {
  const content: ArrayBuffer;
  export default content;
}
