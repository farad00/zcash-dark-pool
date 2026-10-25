export default [
  {
    files: ["src/**/*.mjs", "test/**/*.mjs", "build-vault.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        fetch: "readonly",
        TextEncoder: "readonly",
        Uint8Array: "readonly",
        WebSocket: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-console": "error",
      "no-unused-vars": "error",
      "no-unreachable": "error",
      "constructor-super": "error",
      "no-constant-condition": "error",
    },
  },
];
