/* eslint-disable no-console */
// Run with: tsx scripts/build-aztec-standards.ts [commit-or-tag]
// This script builds @defi-wonderland/aztec-standards from the specified commit/tag
// and stores artifacts in src/artifacts and target in ./target

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPXEClient, waitForPXE } from "@aztec/aztec.js";
import { startSandbox, SandboxManager } from "./start-sandbox.js";

const REPO = "https://github.com/defi-wonderland/aztec-standards.git";

function run(cmd: string, opts: Record<string, any> = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}
function tryRun(cmd: string, opts: Record<string, any> = {}) {
  try {
    execSync(cmd, { stdio: "inherit", ...opts });
    return true;
  } catch {
    return false;
  }
}
function which(bin: string) {
  const res = spawnSync(
    process.platform === "win32" ? "where" : "which",
    [bin],
    { stdio: "pipe" },
  );
  return res.status === 0;
}
function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}
function cp(src: string, dst: string) {
  if (!fs.existsSync(src)) return;
  ensureDir(path.dirname(dst));
  fs.cpSync(src, dst, { recursive: true });
}

function readJSON<T = any>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Check if a sandbox is already running and responsive
 */
async function checkExistingSandbox(): Promise<boolean> {
  try {
    console.log("🔍 Checking for existing sandbox on http://localhost:8080...");

    // Use a simple fetch request with timeout instead of waitForPXE
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const response = await fetch("http://localhost:8080", {
      method: "GET",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      console.log("✅ Found existing responsive sandbox");
      return true;
    } else {
      console.log(
        "ℹ️ Sandbox responded but not ready, checking with waitForPXE...",
      );
      // Use waitForPXE to double-check if sandbox is actually ready
      const pxe = createPXEClient("http://localhost:8080");
      await waitForPXE(pxe);
      console.log("✅ Sandbox is ready after waitForPXE check");
      return true;
    }
  } catch (error) {
    console.log("ℹ️ No existing sandbox found or not responsive");
    return false;
  }
}

/**
 * Ensure sandbox is running for codegen
 */
async function ensureSandboxForCodegen(): Promise<SandboxManager | null> {
  // Always start a fresh sandbox for codegen to ensure reliability
  console.log("🚀 Starting fresh sandbox for codegen...");
  const sandboxManager = await startSandbox({ verbose: false });
  console.log("✅ Fresh sandbox started for codegen");
  return sandboxManager;
}

/**
 * Detect the actual Yarn version being used by the system
 */
function detectSystemYarnVersion(): "v1" | "v4" {
  try {
    const result = spawnSync("yarn", ["--version"], { stdio: "pipe" });
    if (result.status === 0) {
      const version = result.stdout.toString().trim();
      console.log(` System Yarn version: ${version}`);

      // Check if it's v4+ (4.0.0 or higher)
      const versionParts = version.split(".");
      const major = parseInt(versionParts[0], 10);

      if (major >= 4) {
        console.log("📦 System is using Yarn v4+");
        return "v4";
      } else {
        console.log("📦 System is using Yarn v1");
        return "v1";
      }
    }
  } catch (error) {
    console.log("⚠️ Could not detect Yarn version, defaulting to v1");
  }

  return "v1";
}

/**
 * Detect the preferred package manager for a repository
 */
function detectPackageManager(repoDir: string): string {
  const pkgJson = readJSON<{ packageManager?: string }>(
    path.join(repoDir, "package.json"),
  );

  if (pkgJson?.packageManager) {
    // Extract package manager from packageManager field (e.g., "yarn@1.22.22" -> "yarn")
    const pm = pkgJson.packageManager.split("@")[0];
    console.log(`📦 Detected package manager from package.json: ${pm}`);
    return pm;
  }

  // Check for lockfiles
  if (fs.existsSync(path.join(repoDir, "yarn.lock"))) {
    console.log(" Detected package manager from lockfile: yarn");
    return "yarn";
  }
  if (fs.existsSync(path.join(repoDir, "pnpm-lock.yaml"))) {
    console.log(" Detected package manager from lockfile: pnpm");
    return "pnpm";
  }
  if (fs.existsSync(path.join(repoDir, "package-lock.json"))) {
    console.log("📦 Detected package manager from lockfile: npm");
    return "npm";
  }

  // Default to npm
  console.log(" No package manager detected, defaulting to npm");
  return "npm";
}

/**
 * Run a command with the appropriate package manager
 */
function runWithPackageManager(repoDir: string, command: string): boolean {
  const pm = detectPackageManager(repoDir);

  switch (pm) {
    case "yarn":
      const systemYarnVersion = detectSystemYarnVersion();
      console.log(
        `🔧 Running yarn command with system version: ${systemYarnVersion}`,
      );

      if (systemYarnVersion === "v4") {
        // For Yarn v4, we need to be more careful about workspace context
        // Try running the command directly first
        if (tryRun(`cd "${repoDir}" && yarn ${command}`)) {
          return true;
        }

        // If that fails, try with --ignore-workspace-root-check
        console.log(
          "⚠️ Direct yarn command failed, trying with workspace flags",
        );
        return tryRun(
          `cd "${repoDir}" && yarn ${command} --ignore-workspace-root-check`,
        );
      } else {
        // Yarn v1
        return tryRun(`cd "${repoDir}" && yarn ${command}`);
      }
    case "pnpm":
      return tryRun(`cd "${repoDir}" && pnpm ${command}`);
    case "npm":
    default:
      return tryRun(`cd "${repoDir}" && npm run ${command}`);
  }
}

/**
 * Install dependencies with the appropriate package manager
 */
function installDependencies(repoDir: string): boolean {
  const pm = detectPackageManager(repoDir);

  switch (pm) {
    case "yarn":
      const systemYarnVersion = detectSystemYarnVersion();
      console.log(`📦 Installing with system Yarn ${systemYarnVersion}`);

      if (systemYarnVersion === "v4") {
        // Yarn v4+ doesn't support --no-audit, --no-fund
        return tryRun(`cd "${repoDir}" && yarn install`);
      } else {
        // Yarn v1
        return tryRun(`cd "${repoDir}" && yarn install --no-audit --no-fund`);
      }
    case "pnpm":
      return tryRun(`cd "${repoDir}" && pnpm install --no-audit --no-fund`);
    case "npm":
    default:
      return tryRun(`cd "${repoDir}" && npm install --no-audit --no-fund`);
  }
}

/**
 * Run aztec codegen with proper sandbox configuration
 */
function runCodegen(repoDir: string): boolean {
  console.log("🔧 Running aztec codegen...");

  // Use the correct syntax without invalid options
  const approaches = [
    // Approach 1: Try with src/artifacts (like in GitHub workflows)
    `cd "${repoDir}" && aztec codegen target --outdir src/artifacts`,

    // Approach 2: Try with src/artifacts and force flag
    `cd "${repoDir}" && aztec codegen target --outdir src/artifacts --force`,
  ];

  for (const approach of approaches) {
    console.log(`🔧 Trying: ${approach}`);
    if (tryRun(approach)) {
      console.log("✅ Codegen completed successfully");
      return true;
    }
    console.log("⚠️ Approach failed, trying next...");
  }

  console.error("❌ All codegen approaches failed");
  return false;
}

/**
 * Copy files without overwriting existing ones
 */
function copyFilesWithoutOverwrite(
  sourceDir: string,
  targetDir: string,
): number {
  if (!fs.existsSync(sourceDir)) {
    console.log(`⚠️ Source directory ${sourceDir} does not exist`);
    return 0;
  }

  ensureDir(targetDir);
  const files = fs.readdirSync(sourceDir);
  let copiedCount = 0;
  let skippedCount = 0;

  for (const file of files) {
    const srcPath = path.join(sourceDir, file);
    const dstPath = path.join(targetDir, file);

    if (fs.existsSync(dstPath)) {
      console.log(`⏭️ Skipping ${file} (already exists)`);
      skippedCount++;
      continue;
    }

    if (fs.statSync(srcPath).isDirectory()) {
      cp(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
    copiedCount++;
  }

  console.log(
    `✅ Copied ${copiedCount} items, skipped ${skippedCount} existing items`,
  );
  return copiedCount;
}

async function main() {
  // Get commit/tag from command line argument
  const commitOrTag = process.argv[2];

  if (!commitOrTag) {
    console.error("❌ Please provide a commit or tag as the first argument");
    console.error(
      "Usage: tsx scripts/build-aztec-standards.ts <commit-or-tag>",
    );
    process.exit(1);
  }

  try {
    let sandboxManager: SandboxManager | null = null;

    // 1) Temp clone and install dev deps - ensure temp dir is within user home
    const userHome = os.homedir();
    const tmp = fs.mkdtempSync(path.join(userHome, ".aztec-build-"));
    const repoDir = path.join(tmp, "repo");

    try {
      console.log(
        `\n🔨 Building aztec-standards from ${REPO} @ ${commitOrTag}`,
      );
      console.log(` Using temp directory: ${tmp}`);
      run(`git clone ${REPO} "${repoDir}" --quiet`);
      run(`git -C "${repoDir}" checkout ${commitOrTag} --quiet`);

      // Install dependencies using detected package manager
      if (!installDependencies(repoDir)) {
        console.warn(
          "⚠️ Primary package manager install failed, trying npm as fallback",
        );
        run(`cd "${repoDir}" && npm install --no-audit --no-fund`);
      }

      // 2) Determine Aztec version (if present) and whether to run codegen
      const pkgJson = readJSON<{
        scripts?: Record<string, string>;
        config?: any;
      }>(path.join(repoDir, "package.json"));
      const aztecVersion: string = pkgJson?.config?.aztecVersion || "";

      // Check if aztec CLI is available
      let hasAztec = which("aztec");
      if (!hasAztec) {
        console.log("🔧 Installing Aztec CLI...");
        const azScript = path.join(tmp, "install-aztec.sh");
        fs.writeFileSync(
          azScript,
          'curl -s https://install.aztec.network > /tmp/az.sh && bash /tmp/az.sh <<< yes "yes"\n',
        );
        run(`bash -lc "bash ${azScript}"`);
        // ensure PATH includes aztec bin
        const homeBin = path.join(os.homedir(), ".aztec", "bin");
        process.env.PATH = `${homeBin}${path.delimiter}${process.env.PATH}`;
        hasAztec = which("aztec");
      }

      if (!hasAztec) {
        console.warn(
          "⚠️ aztec CLI not found and could not install it, skipping codegen",
        );
        return;
      }

      if (aztecVersion) {
        console.log(` Setting Aztec version to ${aztecVersion}`);
        tryRun(`bash -lc "VERSION=${aztecVersion} aztec-up"`);
      }

      // 3) Compile sources if repo exposes a compile script
      if (pkgJson?.scripts?.compile) {
        if (!runWithPackageManager(repoDir, "compile")) {
          throw new Error(
            `Failed to compile with detected package manager: ${detectPackageManager(repoDir)}`,
          );
        }
      }

      // 4) Codegen - now with sandbox support
      ensureDir(path.join(repoDir, "artifacts"));
      ensureDir(path.join(repoDir, "src", "artifacts"));

      // Ensure sandbox is running for codegen
      sandboxManager = await ensureSandboxForCodegen();

      try {
        if (!runCodegen(repoDir)) {
          throw new Error("All codegen approaches failed");
        }
      } catch (error) {
        console.error("❌ Codegen failed:", error);
        throw error;
      }

      // 5) Compile TS artifacts → dist (if any TS in artifacts/)
      ensureDir(path.join(repoDir, "dist"));
      const artifactsDir = path.join(repoDir, "artifacts");
      const hasTsArtifacts =
        fs.existsSync(artifactsDir) &&
        fs.readdirSync(artifactsDir).some((f) => f.endsWith(".ts"));

      if (hasTsArtifacts) {
        // prefer local tsc if present; otherwise use npx typescript
        const tscCmd = which("tsc") ? "tsc" : "npx -y typescript tsc";
        run(
          `cd "${repoDir}" && ${tscCmd} artifacts/*.ts --outDir dist/ --skipLibCheck --target es2020 --module nodenext --moduleResolution nodenext --resolveJsonModule --declaration`,
        );
      } else {
        console.log(
          "ℹ️ No TS artifacts found under artifacts/ (skipping tsc on artifacts/*.ts).",
        );
      }

      // 6) Copy artifacts to src/artifacts (without overwriting)
      const targetArtifactsDir = path.join(process.cwd(), "src", "artifacts");
      console.log(`\n📁 Copying artifacts to: ${targetArtifactsDir}`);
      copyFilesWithoutOverwrite(
        path.join(repoDir, "src", "artifacts"),
        targetArtifactsDir,
      );

      // 7) Copy target to ./target (without overwriting)
      const targetTargetDir = path.join(process.cwd(), "target");
      console.log(`\n📁 Copying target to: ${targetTargetDir}`);
      copyFilesWithoutOverwrite(path.join(repoDir, "target"), targetTargetDir);

      console.log(
        "\n✅ aztec-standards artifacts and target built and stored successfully.",
      );
    } catch (err: any) {
      console.error("\n❌ Build script failed:", err?.message || err);
      process.exit(1);
    } finally {
      // Clean up sandbox if we started it
      if (sandboxManager) {
        try {
          console.log("🛑 Stopping sandbox...");
          await sandboxManager.stop();
          console.log("✅ Sandbox stopped");
        } catch (error) {
          console.warn("⚠️ Error stopping sandbox:", error);
        }
      }

      // cleanup temp directory
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  } catch (err: any) {
    console.error("\n❌ Build script failed:", err?.message || err);
    process.exit(1);
  }
}

main();
// checkExistingSandbox()
