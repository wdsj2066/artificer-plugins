import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir(new URL("../plugins/remote/vendor/", import.meta.url), {
  recursive: true,
});
await build({
  entryPoints: ["node_modules/qrcode/lib/browser.js"],
  outfile: "plugins/remote/vendor/qrcode.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  minify: true,
});
await copyFile(
  "node_modules/qrcode/license",
  "plugins/remote/vendor/QRCODE-LICENSE.txt",
);
await copyFile(
  "node_modules/dijkstrajs/LICENSE.md",
  "plugins/remote/vendor/DIJKSTRA-LICENSE.txt",
);
