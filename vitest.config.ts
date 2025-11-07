import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  resolve: {
    conditions: ["import", "module", "browser", "default"],
  },
  test: {
    // aztec sandbox tests take quite some time
    hookTimeout: 200000,
    testTimeout: 200000,
    globalSetup: "./vitest.setup.ts",
    fileParallelism: false,
    globals: true,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
        isolate: false,
        execArgv: ["--experimental-vm-modules"],
      },
    },
    // Use new API to inline dependencies through Vite's transform pipeline
    // This ensures @aztec packages use Vite's module resolution with proper JSON import handling
    server: {
      deps: {
        inline: [/@aztec/, /@noble\/(hashes|curves|ciphers)/, /viem/, /@scure/],
      },
    },
  },
});
