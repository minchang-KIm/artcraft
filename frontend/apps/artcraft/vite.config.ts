import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "path";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// NB(bt): This configuration file can specify bundler rollup options, compiler plugins,
// import path resolution, dev server HTTP headers, CORS options, path rewriting, etc.
// Read the vite docs for more: https://vitejs.dev/config/

const SPARK_MODULE_SUBPATH = "/@sparkjsdev/spark/dist/spark.module.js";
const SPARK_WASM_PATTERN =
  /module_or_path = new URL\("(data:application\/wasm;base64,[^"]+)", import\.meta\.url\);/;

const sparkWasmDataUrlFix = (): Plugin => ({
  name: "spark-wasm-data-url-fix",
  enforce: "pre",
  apply: "serve",
  transform(code, id) {
    if (!id.includes(SPARK_MODULE_SUBPATH)) {
      return null;
    }

    const match = code.match(SPARK_WASM_PATTERN);
    if (!match) {
      return null;
    }

    const [, dataUrl] = match;
    const patched = code.replace(
      SPARK_WASM_PATTERN,
      `module_or_path = "${dataUrl}";`,
    );

    return {
      code: patched,
      map: null,
    };
  },
});

const projectRoot = __dirname;
const appRoot = path.resolve(projectRoot, "app");
const workspaceRoot = path.resolve(projectRoot, "..", "..");
const poseWorkerPath = path.resolve(workspaceRoot, "../../../workers/pose/landmarker-worker.mjs");

// Vite rewrites dynamic import() in .mjs files into a static import of its
// client, which breaks classic workers. Serve the original bytes in dev;
// production emits the same file as an asset below.
const poseWorkerDevAsset = (): Plugin => ({
  name: "pose-worker-dev-asset",
  configureServer(server) {
    server.middlewares.use("/__total_recall_pose_worker.js", (_request, response) => {
      response.setHeader("Content-Type", "text/javascript; charset=utf-8");
      response.end(readFileSync(poseWorkerPath));
    });
  },
});

export default defineConfig({
  root: appRoot,
  optimizeDeps: {
    exclude: ["@sparkjsdev/spark"],
  },
  build: {
    outDir: path.resolve(projectRoot, "dist"),
    // A data URL has an opaque origin and cannot enforce the pose worker's
    // same-origin resource policy. Always emit it as a real asset.
    assetsInlineLimit: (file) => file.endsWith("landmarker-worker.mjs") ? false : undefined,
    rollupOptions: {
      input: {
        index: resolve(projectRoot, "app/index.html"),
      },
    },
  },
  plugins: [
    react(),
    poseWorkerDevAsset(),
    sparkWasmDataUrlFix(),
    tsconfigPaths({
      // Resolve workspace packages to source for every importer, including shared
      // libraries. Fresh release checkouts have no prebuilt library dist files.
      projects: [path.resolve(workspaceRoot, "tsconfig.base.json")],
    }),
    wasm(),
    topLevelAwait(),
  ],
  server: {
    fs: {
      allow: [workspaceRoot, path.resolve(workspaceRoot, "../../../workers/pose")],
    },
  },
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "@preact/signals-core",
      "@preact/signals-react"
    ],
  },
});
