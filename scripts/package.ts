type Manifest = Readonly<Record<string, unknown>>;
type Command = readonly [string, ...string[]];

function isManifest(value: unknown): value is Manifest {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(manifest: Manifest, field: string): string {
  const value = manifest[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`package.json must define a non-empty string "${field}".`);
  }

  return value;
}

function run(command: Command): void {
  const result = Bun.spawnSync(Array.from(command), {
    stderr: "inherit",
    stdout: "inherit",
  });

  if (!result.success) {
    throw new Error(`${command.join(" ")} failed with exit code ${result.exitCode}.`);
  }
}

const packageJson: unknown = await Bun.file("package.json").json();
if (!isManifest(packageJson)) {
  throw new Error("package.json must contain a JSON object.");
}

const name = readRequiredString(packageJson, "name");
const version = readRequiredString(packageJson, "version");
const outputPath = `dist/${name}-${version}.vsix`;
const readmePath = "README.md";
const marketplaceReadmePath = "MARKETPLACE.md";

run(["bun", "run", "build"]);

const repositoryReadme = await Bun.file(readmePath).arrayBuffer();
try {
  await Bun.write(readmePath, Bun.file(marketplaceReadmePath));
  run([
    "bunx",
    "vsce",
    "package",
    "--allow-missing-repository",
    "--no-rewrite-relative-links",
    "--out",
    outputPath,
  ]);
} finally {
  await Bun.write(readmePath, repositoryReadme);
}

console.log(`Created ${outputPath}`);

export {};
