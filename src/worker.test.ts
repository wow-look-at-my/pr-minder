import { describe, it, expect } from 'vitest';
import { verifyWebhook } from './worker';

async function makeSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${hex}`;
}

describe('verifyWebhook', () => {
  it('accepts a valid signature', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const sig = await makeSignature('mysecret', body);
    expect(await verifyWebhook('mysecret', sig, body)).toBe(true);
  });

  it('rejects a wrong secret', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const sig = await makeSignature('wrongsecret', body);
    expect(await verifyWebhook('mysecret', sig, body)).toBe(false);
  });

  it('rejects a tampered body', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const sig = await makeSignature('mysecret', body);
    expect(await verifyWebhook('mysecret', sig, body + ' ')).toBe(false);
  });

  it('rejects a malformed signature header', async () => {
    expect(await verifyWebhook('mysecret', 'not-a-sig', 'body')).toBe(false);
    expect(await verifyWebhook('mysecret', '', 'body')).toBe(false);
  });
});
