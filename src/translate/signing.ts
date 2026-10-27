/**
 * 翻译签名工具
 *
 * 百度用 MD5(appid+q+salt+key)，有道 v3 用 SHA-256(appKey+截断q+salt+curtime+secret)。
 * SHA-256 走 WebCrypto；MD5 因为不在 WebCrypto 里，这里自带一份最小实现。
 */

const LEFT_ROTATE = (x: number, c: number) => (x << c) | (x >>> (32 - c));

const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = Array.from({ length: 64 }, (_, index) =>
  Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0);

const toLittleEndianHex = (value: number): string => {
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += ((value >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return out;
};

/** 计算字符串的 MD5（UTF-8 编码），返回 32 位小写十六进制 */
export const md5Hex = (input: string): string => {
  const message = new TextEncoder().encode(input);
  const byteLength = message.length;
  const paddedLength = (((byteLength + 8) >> 6) + 1) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(message);
  buffer[byteLength] = 0x80;

  const view = new DataView(buffer.buffer);
  const bitLength = byteLength * 8;
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const words = new Array<number>(16);
  for (let chunk = 0; chunk < paddedLength; chunk += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(chunk + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + K[i] + words[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + LEFT_ROTATE(f, SHIFTS[i])) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return `${toLittleEndianHex(a0)}${toLittleEndianHex(b0)}${toLittleEndianHex(c0)}${toLittleEndianHex(d0)}`;
};

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

/** 计算字符串的 SHA-256（UTF-8 编码），返回 64 位小写十六进制 */
export const sha256Hex = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(digest);
};
