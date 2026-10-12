'use strict';
// Drop-in replacement for bigint-buffer@1.1.5 (GHSA-3gc7-fjrx-p6mg / CVE-2025-3194, no patched
// release upstream). Bond pulls bigint-buffer only through @solana/spl-token ->
// @solana/buffer-layout-utils, which calls exactly these four functions to read and write u64
// token amounts. This version is pure JS with no native binding, and it validates its input:
// a non-buffer, a non-bigint, a negative value, a bad width or a value that does not fit the
// width throws a TypeError or RangeError instead of overflowing or silently truncating.
// Wired in via "overrides" in app/package.json and server/package.json.
const { Buffer } = require('buffer');

function assertBuffer(buf) {
  if (!(buf instanceof Uint8Array)) {
    throw new TypeError('bigint-buffer-safe: expected a Buffer or Uint8Array');
  }
}

function assertWidth(width) {
  if (!Number.isSafeInteger(width) || width < 0) {
    throw new RangeError('bigint-buffer-safe: width must be a non-negative integer');
  }
}

function hexOf(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

function toBigIntBE(buf) {
  assertBuffer(buf);
  return buf.length === 0 ? 0n : BigInt('0x' + hexOf(buf));
}

function toBigIntLE(buf) {
  assertBuffer(buf);
  return toBigIntBE(Uint8Array.from(buf).reverse());
}

function toBufferBE(num, width) {
  if (typeof num !== 'bigint') throw new TypeError('bigint-buffer-safe: expected a BigInt');
  assertWidth(width);
  if (num < 0n) throw new RangeError('bigint-buffer-safe: negative values are not supported');
  if (num === 0n) return Buffer.alloc(width);
  const hex = num.toString(16);
  if (hex.length > width * 2) {
    throw new RangeError('bigint-buffer-safe: value does not fit in ' + width + ' bytes');
  }
  return Buffer.from(hex.padStart(width * 2, '0'), 'hex');
}

function toBufferLE(num, width) {
  return Buffer.from(toBufferBE(num, width)).reverse();
}

exports.toBigIntLE = toBigIntLE;
exports.toBigIntBE = toBigIntBE;
exports.toBufferLE = toBufferLE;
exports.toBufferBE = toBufferBE;
