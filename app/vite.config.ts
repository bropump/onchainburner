import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    global: "globalThis",
    "process.env": {},
  },
  resolve: {
    alias: { buffer: "buffer/" },
  },
  optimizeDeps: {
    include: ["buffer"],
    esbuildOptions: {
      define: { global: "globalThis" },
      // Solana/anchor/pump-sdk chunks reference `Buffer` as a free identifier
      // at module-evaluation time; this binds it inside those chunks.
      inject: ["./src/buffer-shim.ts"],
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
