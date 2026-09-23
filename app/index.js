// Custom entry: load Solana/web3.js polyfills, then hand off to expo-router.
// package.json "main" points here instead of "expo-router/entry" so the Buffer
// and crypto globals are installed before any app or wallet code runs.
import "./polyfill";
import "expo-router/entry";
