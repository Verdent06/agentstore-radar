import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", "data/**", "web/.next/**", "web/out/**", "mcp/dist/**", "aggregate/**"],
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts", "mcp/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
