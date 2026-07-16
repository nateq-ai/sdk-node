import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node18",
  outExtensions: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
});
