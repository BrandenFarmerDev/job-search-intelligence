import js from "@eslint/js";
import globals from "globals";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/.wrangler/**", "**/dist/**", "**/coverage/**", "**/node_modules/**", "reports/**"],
  },
  {
    files: ["**/*.{js,mjs}"],
    ignores: ["app/frontend/public/**"],
    ...js.configs.recommended,
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["app/frontend/public/**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      sourceType: "script",
      globals: globals.browser,
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  {
    files: ["app/frontend/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      "jsx-a11y": jsxA11y,
      "react-hooks": reactHooks,
    },
    rules: {
      ...jsxA11y.configs.recommended.rules,
      ...reactHooks.configs.flat.recommended.rules,
    },
  },
  {
    files: ["app/backend/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
      },
    },
  },
  {
    files: ["**/*.test.{ts,tsx}", "**/test/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
);
