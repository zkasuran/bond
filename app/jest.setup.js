// Ensure Web Crypto and text codecs exist in the jest environment so the pure crypto
// tests run under Node the same way they run on device.
const { webcrypto } = require("node:crypto");
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}
if (typeof globalThis.TextEncoder === "undefined") {
  const { TextEncoder, TextDecoder } = require("node:util");
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
}
if (typeof globalThis.ReadableStream === "undefined") {
  globalThis.ReadableStream = require("node:stream/web").ReadableStream;
}
