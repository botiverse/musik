const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function deriveHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function encryptAccessToken(token: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await deriveAesKey(secret),
    encoder.encode(token),
  );
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptAccessToken(
  value: string,
  secret: string,
): Promise<string | null> {
  const [ivPart, ciphertextPart, extra] = value.split(".");
  if (!ivPart || !ciphertextPart || extra !== undefined) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: asArrayBuffer(base64UrlToBytes(ivPart)) },
      await deriveAesKey(secret),
      asArrayBuffer(base64UrlToBytes(ciphertextPart)),
    );
    return decoder.decode(plaintext);
  } catch {
    return null;
  }
}

export async function createLoginState(
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const payload = `${nowSeconds}.${nonce}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await deriveHmacKey(secret),
    encoder.encode(payload),
  );
  return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifyLoginState(
  value: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = 600,
): Promise<boolean> {
  const [issuedPart, nonce, signaturePart, extra] = value.split(".");
  if (!issuedPart || !nonce || !signaturePart || extra !== undefined) return false;
  const issued = Number(issuedPart);
  if (!Number.isInteger(issued) || issued > nowSeconds || issued < nowSeconds - maxAgeSeconds) {
    return false;
  }
  try {
    return crypto.subtle.verify(
      "HMAC",
      await deriveHmacKey(secret),
      asArrayBuffer(base64UrlToBytes(signaturePart)),
      encoder.encode(`${issuedPart}.${nonce}`),
    );
  } catch {
    return false;
  }
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const equals = trimmed.indexOf("=");
    if (equals < 0 || trimmed.slice(0, equals) !== name) continue;
    try {
      return decodeURIComponent(trimmed.slice(equals + 1));
    } catch {
      return null;
    }
  }
  return null;
}
