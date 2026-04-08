import { defineConfig } from "vitest/config";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nobleUtilsPath = require.resolve("@noble/hashes/utils");

export default defineConfig({
  resolve: {
    alias: {
      "@noble/hashes/utils": nobleUtilsPath,
    },
    conditions: ["import", "module", "browser", "default"],
  },
  test: {
    // aztec local network tests take quite some time
    hookTimeout: 200000,
    testTimeout: 200000,
    globals: true,
    fileParallelism: false,
    pool: "forks",
    isolate: false,
    execArgv: ["--experimental-vm-modules"],
    // Use new API to inline dependencies through Vite's transform pipeline
    // This ensures @aztec packages use Vite's module resolution with proper JSON import handling
    server: {
      deps: {
        inline: [/@aztec/, /@noble\/(hashes|curves|ciphers)/, /viem/, /@scure/],
      },
    },
  },
});
