// Polyfills that MUST load before any @solana/web3.js or Mobile Wallet Adapter code.
// Loaded first from index.js (package.json "main") so the globals exist before
// expo-router boots the app. Kept minimal: web3.js needs a Buffer global and a
// crypto.getRandomValues (the latter via react-native-get-random-values).
import "react-native-get-random-values";
import { Buffer } from "buffer";

if (typeof global.Buffer === "undefined") {
  global.Buffer = Buffer;
}
