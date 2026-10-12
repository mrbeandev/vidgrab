import { ivFromSequence, type Segment } from "@shared/m3u8";
import { fetchBytes, type FetchOpts } from "./net";

/** Copy any view into a fresh, non-shared ArrayBuffer (WebCrypto's BufferSource typing requires it). */
function toAB(u8: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}

interface LoadedKey {
  dec: CryptoKey;
  enc: CryptoKey; // used for the "no padding" fallback trick
}

/** Caches key bytes + imported CryptoKeys per key URI for one job. */
export class KeyStore {
  private keys = new Map<string, Promise<LoadedKey>>();

  constructor(private readonly fetchOpts: Omit<FetchOpts, "signal">) {}

  private load(uri: string, signal?: AbortSignal): Promise<LoadedKey> {
    let p = this.keys.get(uri);
    if (!p) {
      p = fetchBytes(uri, { ...this.fetchOpts, signal }).then(async (rawIn) => {
        const raw = toAB(rawIn);
        if (raw.byteLength !== 16) throw new Error(`AES-128 key must be 16 bytes, got ${raw.byteLength}`);
        const [dec, enc] = await Promise.all([
          crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["decrypt"]),
          crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["encrypt"]),
        ]);
        return { dec, enc };
      });
      p.catch(() => this.keys.delete(uri));
      this.keys.set(uri, p);
    }
    return p;
  }

  /** Decrypt a full AES-128-CBC segment (PKCS#7, with a fallback for unpadded streams). */
  async decrypt(seg: Segment, data: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    const k = seg.key;
    if (!k || k.method === "NONE") return data;
    if (k.method !== "AES-128") throw new Error(`Unsupported encryption: ${k.method}`);
    if (!k.uri) throw new Error("AES-128 key without URI");
    const key = await this.load(k.uri, signal);
    const iv = k.iv ?? ivFromSequence(seg.sn);
    const usable = data.byteLength - (data.byteLength % 16);
    const buf = usable === data.byteLength ? data : data.subarray(0, usable);
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: toAB(iv) }, key.dec, toAB(buf)));
    } catch {
      return decryptUnpadded(key, iv, buf);
    }
  }
}

/**
 * CBC decryption of data that lacks PKCS#7 padding: append one block that, after decryption,
 * yields valid padding (encrypt a full pad block chained on the last ciphertext block), then drop it.
 */
async function decryptUnpadded(key: LoadedKey, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.byteLength < 16) return data;
  const lastBlock = data.subarray(data.byteLength - 16);
  const pad = new Uint8Array(16).fill(16);
  // Encrypting an empty-ish payload with iv=lastBlock produces E(pad ⊕ lastBlock) + an extra pad block;
  // we need only the first 16 bytes.
  const extra = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: toAB(lastBlock) }, key.enc, toAB(pad)));
  const joined = new Uint8Array(data.byteLength + 16);
  joined.set(data, 0);
  joined.set(extra.subarray(0, 16), data.byteLength);
  const out = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: toAB(iv) }, key.dec, toAB(joined)));
  return out.subarray(0, data.byteLength);
}
