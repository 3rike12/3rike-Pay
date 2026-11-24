import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/webhook": "http://localhost:3000",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    // Do not gzip every chunk just to print its size: with the wallet libraries that is real build time.
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        pay: fileURLToPath(new URL("./pay.html", import.meta.url)),
      },
    },
  },
});
