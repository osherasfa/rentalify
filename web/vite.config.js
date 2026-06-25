import { defineConfig } from "vite";

// Relative base so the build works under any path, including GitHub Pages
// project sites served from https://<user>.github.io/<repo>/.
export default defineConfig({
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
});
