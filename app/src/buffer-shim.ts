/**
 * Injected by esbuild into every pre-bundled dependency chunk
 * (`optimizeDeps.esbuildOptions.inject`).
 *
 * `src/polyfills.ts` sets `globalThis.Buffer` as the entry module's first
 * import, which is enough for our own code — but Vite pre-bundles anchor and
 * pump-sdk into separate chunks that reference `Buffer` at module-evaluation
 * time, and those evaluate before the entry's import runs. Injecting the
 * binding directly into those chunks is what makes the free identifier
 * resolve there.
 */
export { Buffer } from "buffer";
