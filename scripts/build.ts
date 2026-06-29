import { build } from "bun";

const result = await build({
  entrypoints: ["./src/extension.ts"],
  external: ["vscode"],
  format: "cjs",
  minify: false,
  outdir: "./dist",
  sourcemap: "external",
  target: "node",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const bundle = await Bun.file("./dist/extension.js").text();
if (!bundle.includes("module.exports")) {
  throw new Error("VS Code extension bundle must use CommonJS exports.");
}
