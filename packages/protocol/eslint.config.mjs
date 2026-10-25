import tseslint from "typescript-eslint";

export default tseslint.config(...tseslint.configs.recommended, {
  files: ["src/**/*.ts", "test/**/*.mjs"],
  rules: {
    "no-console": "error",
    "no-eval": "error",
    "no-implied-eval": "error",
  },
});
