/**
 * Comparing and deriving from RADAR_TOKEN. Web Crypto only, so the same code runs in Node and
 * on Workers.
 */

/** Equality that takes the same time wherever the strings differ. */
export function sameSecret(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/**
 * The OAuth `state` for the Gmail connection. It used to be the radar token itself, which
 * sent the master password to Google and into the browser history. An HMAC proves the same
 * thing (the link came from someone who knows the token) without revealing it.
 */
export async function oauthState(token: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('gmail-oauth-state'));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
