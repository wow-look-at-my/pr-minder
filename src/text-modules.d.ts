// Wrangler bundles .html/.txt/.sql imports as strings (baked into the Worker at build time).
// These ambient declarations let tsc type those imports as `string`.
declare module '*.html' {
  const content: string;
  export default content;
}
declare module '*.txt' {
  const content: string;
  export default content;
}
