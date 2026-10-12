'use strict';
// Drop-in replacement for decode-uri-component@0.2.2 (GHSA-vcc3-ghjq-m6fr: exponential-time
// decoding of malformed percent-encoded input). The fixed upstream release (0.5.0) is ESM only,
// and Bond's consumer (query-string@7, via expo-router) loads it with require(), so this CJS
// version keeps the same API: decode with the built-in decoder, and on malformed input fall
// back to a single left-to-right pass that decodes every valid UTF-8 %XX sequence and keeps
// any invalid one as literal text. Linear in the input length, so no input can stall it.
// Wired in via "overrides" in app/package.json.

function decodeRun(run) {
  // run: one or more consecutive %XX tokens. Decode the longest valid UTF-8 prefix at each
  // position (1 to 4 bytes); a byte that starts no valid sequence is kept as written.
  const tokens = run.match(/%[a-f0-9]{2}/gi);
  let out = '';
  let i = 0;
  while (i < tokens.length) {
    let decoded = false;
    for (let len = Math.min(4, tokens.length - i); len >= 1; len--) {
      try {
        out += decodeURIComponent(tokens.slice(i, i + len).join(''));
        i += len;
        decoded = true;
        break;
      } catch (_) {
        // not a valid sequence of this length, try a shorter one
      }
    }
    if (!decoded) {
      out += tokens[i];
      i += 1;
    }
  }
  return out;
}

module.exports = function decodeUriComponent(encodedURI) {
  if (typeof encodedURI !== 'string') {
    throw new TypeError('Expected `encodedURI` to be of type `string`, got `' + typeof encodedURI + '`');
  }
  const input = encodedURI.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(input);
  } catch (_) {
    return input.replace(/(?:%[a-f0-9]{2})+/gi, decodeRun);
  }
};
