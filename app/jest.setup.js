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
// The motion layer runs on Reanimated 4 worklets, which need the native runtime. Under
// node both packages swap to their official mocks so rendering tests exercise the real
// components with animations resolved to their final values.
jest.mock("react-native-worklets", () => require("react-native-worklets/src/mock"));
jest.mock("react-native-reanimated", () => require("react-native-reanimated/mock"));
