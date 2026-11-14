const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const sourceRoot = path.resolve(__dirname, "../src");
const outputRoot = path.resolve(__dirname, "../dist");

function collectTypeScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

function copyJsonFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      copyJsonFiles(entryPath);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      const outputPath = path.join(outputRoot, path.relative(sourceRoot, entryPath));
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.copyFileSync(entryPath, outputPath);
    }
  }
}

async function build() {
  const entryPoints = collectTypeScriptFiles(sourceRoot);
  fs.rmSync(outputRoot, { recursive: true, force: true });

  await esbuild.build({
    entryPoints,
    outbase: sourceRoot,
    outdir: outputRoot,
    platform: "node",
    format: "cjs",
    target: "node20",
    sourcemap: true,
    packages: "external",
    tsconfig: path.resolve(__dirname, "../tsconfig.json"),
  });

  copyJsonFiles(sourceRoot);
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
