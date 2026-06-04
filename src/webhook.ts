// HMAC-SHA256 verification of GitHub webhook signatures (the `x-hub-signature-256` header).
export async function verifyWebhook(secret: string, sigHeader: string, body: string): Promise<boolean> {
  const expected = sigHeader.replace(/^sha256=/, '');
  if (expected.length !== 64) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const sigBytes = new Uint8Array(expected.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(body));
}
