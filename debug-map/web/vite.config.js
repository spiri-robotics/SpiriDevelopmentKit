import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";

// Relative asset paths: SpiriConfig serves this page under /plugin/<name>/.
// zenoh-ts imports its key expression code as a wasm module. MapLibre's worker
// is an ES module.
export default defineConfig({
  base: "./",
  plugins: [wasm()],
  build: { target: "es2022" },
  worker: { format: "es" },
});
