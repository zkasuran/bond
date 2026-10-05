// Bond uses the jest-expo preset. transformIgnorePatterns adds the ESM-only crypto and
// encoding packages so babel-jest transforms them; without this jest cannot import them.
module.exports = {
  preset: "jest-expo",
  setupFiles: ["<rootDir>/jest.setup.js"],
  // A fresh clone transforms React Native and Expo cold, which can push the first
  // render-heavy test past jest's 5 s default. Thirty seconds keeps a clean checkout green.
  testTimeout: 30000,
  testMatch: ["**/src/**/*.test.ts", "**/src/**/*.test.tsx"],
  transformIgnorePatterns: [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|@noble/.*|@scure/.*|canonicalize|ulidx))",
  ],
};
