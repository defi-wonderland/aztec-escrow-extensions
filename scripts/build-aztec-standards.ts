/* eslint-disable no-console */
// Run with: tsx scripts/build-aztec-standards.ts
// This script builds @defi-wonderland/aztec-standards from the repository and reference
// specified in package.json dependencies

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createPXEClient, waitForPXE } from '@aztec/aztec.js';
import { startSandbox, SandboxManager } from './start-sandbox.js';

const require = createRequire(import.meta.url);

const PKG = '@defi-wonderland/aztec-standards';

function run(cmd: string, opts: Record<string, any> = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}
function tryRun(cmd: string, opts: Record<string, any> = {}) {
  try {
    execSync(cmd, { stdio: 'inherit', ...opts });
    return true;
  } catch {
    return false;
  }
}
function which(bin: string) {
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'pipe' });
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
function pkgDir(pkgName: string) {
  const pkgJson = require.resolve(`${pkgName}/package.json`);
  return path.dirname(pkgJson);
}

function readJSON<T = any>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Extract repository URL and reference from package.json dependency
 */
function extractRepoInfo(): { repo: string; ref: string } {
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  const packageJson = readJSON<{ dependencies?: Record<string, string> }>(packageJsonPath);
  
  if (!packageJson?.dependencies?.[PKG]) {
    throw new Error(`Could not find ${PKG} in package.json dependencies`);
  }
  
  const dependencySpec = packageJson.dependencies[PKG];
  console.log(`🔍 Found dependency spec: ${dependencySpec}`);
  
  // Parse github:owner/repo#ref format
  if (dependencySpec.startsWith('github:')) {
    const withoutGithub = dependencySpec.substring(7); // Remove 'github:'
    const [repoWithRef, ...rest] = withoutGithub.split('#');
    
    if (rest.length === 0) {
      throw new Error(`Invalid github dependency format: ${dependencySpec}. Expected github:owner/repo#ref`);
    }
    
    const ref = rest.join('#'); // In case ref contains # characters
    const repo = `https://github.com/${repoWithRef}.git`;
    
    console.log(`🔍 Extracted repo: ${repo}`);
    console.log(`🔍 Extracted ref: ${ref}`);
    
    return { repo, ref };
  }
  
  throw new Error(`Unsupported dependency format: ${dependencySpec}. Only github:owner/repo#ref is supported.`);
}

/**
 * Check if a sandbox is already running and responsive
 */
async function checkExistingSandbox(): Promise<boolean> {
  try {
    console.log('🔍 Checking for existing sandbox...');
    const pxe = createPXEClient('http://localhost:8080');
    await waitForPXE(pxe, 5000); // 5 second timeout
    console.log('✅ Found existing responsive sandbox');
    return true;
  } catch {
    console.log('ℹ️ No existing sandbox found or not responsive');
    return false;
  }
}

/**
 * Ensure sandbox is running for codegen
 */
async function ensureSandboxForCodegen(): Promise<SandboxManager | null> {
  // Check if sandbox is already running
  const hasExistingSandbox = await checkExistingSandbox();
  if (hasExistingSandbox) {
    console.log('✅ Using existing sandbox');
    return null; // No manager to clean up
  }

  // Start our own sandbox
  console.log('🚀 Starting sandbox for build process...');
  const sandboxManager = await startSandbox({ verbose: false });
  console.log('✅ Sandbox started for build process');
  return sandboxManager;
}

/**
 * Detect the actual Yarn version being used by the system
 */
function detectSystemYarnVersion(): 'v1' | 'v4' {
  try {
    const result = spawnSync('yarn', ['--version'], { stdio: 'pipe' });
    if (result.status === 0) {
      const version = result.stdout.toString().trim();
      console.log(`🔍 System Yarn version: ${version}`);
      
      // Check if it's v4+ (4.0.0 or higher)
      const versionParts = version.split('.');
      const major = parseInt(versionParts[0], 10);
      
      if (major >= 4) {
        console.log('📦 System is using Yarn v4+');
        return 'v4';
      } else {
        console.log('📦 System is using Yarn v1');
        return 'v1';
      }
    }
  } catch (error) {
    console.log('⚠️ Could not detect Yarn version, defaulting to v1');
  }
  
  return 'v1';
}

/**
 * Detect the preferred package manager for a repository
 */
function detectPackageManager(repoDir: string): string {
  const pkgJson = readJSON<{ packageManager?: string }>(path.join(repoDir, 'package.json'));
  
  if (pkgJson?.packageManager) {
    // Extract package manager from packageManager field (e.g., "yarn@1.22.22" -> "yarn")
    const pm = pkgJson.packageManager.split('@')[0];
    console.log(`📦 Detected package manager from package.json: ${pm}`);
    return pm;
  }
  
  // Check for lockfiles
  if (fs.existsSync(path.join(repoDir, 'yarn.lock'))) {
    console.log('📦 Detected package manager from lockfile: yarn');
    return 'yarn';
  }
  if (fs.existsSync(path.join(repoDir, 'pnpm-lock.yaml'))) {
    console.log('📦 Detected package manager from lockfile: pnpm');
    return 'pnpm';
  }
  if (fs.existsSync(path.join(repoDir, 'package-lock.json'))) {
    console.log('📦 Detected package manager from lockfile: npm');
    return 'npm';
  }
  
  // Default to npm
  console.log('📦 No package manager detected, defaulting to npm');
  return 'npm';
}

/**
 * Run a command with the appropriate package manager
 */
function runWithPackageManager(repoDir: string, command: string): boolean {
  const pm = detectPackageManager(repoDir);
  
  switch (pm) {
    case 'yarn':
      const systemYarnVersion = detectSystemYarnVersion();
      console.log(`🔧 Running yarn command with system version: ${systemYarnVersion}`);
      
      if (systemYarnVersion === 'v4') {
        // For Yarn v4, we need to be more careful about workspace context
        // Try running the command directly first
        if (tryRun(`cd "${repoDir}" && yarn ${command}`)) {
          return true;
        }
        
        // If that fails, try with --ignore-workspace-root-check
        console.log('⚠️ Direct yarn command failed, trying with workspace flags');
        return tryRun(`cd "${repoDir}" && yarn ${command} --ignore-workspace-root-check`);
      } else {
        // Yarn v1
        return tryRun(`cd "${repoDir}" && yarn ${command}`);
      }
    case 'pnpm':
      return tryRun(`cd "${repoDir}" && pnpm ${command}`);
    case 'npm':
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
    case 'yarn':
      const systemYarnVersion = detectSystemYarnVersion();
      console.log(`📦 Installing with system Yarn ${systemYarnVersion}`);
      
      if (systemYarnVersion === 'v4') {
        // Yarn v4+ doesn't support --no-audit, --no-fund
        return tryRun(`cd "${repoDir}" && yarn install`);
      } else {
        // Yarn v1
        return tryRun(`cd "${repoDir}" && yarn install --no-audit --no-fund`);
      }
    case 'pnpm':
      return tryRun(`cd "${repoDir}" && pnpm install --no-audit --no-fund`);
    case 'npm':
    default:
      return tryRun(`cd "${repoDir}" && npm install --no-audit --no-fund`);
  }
}

/**
 * Run aztec codegen with proper sandbox configuration
 */
function runCodegen(repoDir: string): boolean {
  console.log('🔧 Running aztec codegen...');
  
  // Use the correct syntax without invalid options
  const approaches = [
    // Approach 1: Basic codegen (this should work)
    `cd "${repoDir}" && aztec codegen target --outdir artifacts`,
    
    // Approach 2: Codegen with force flag
    `cd "${repoDir}" && aztec codegen target --outdir artifacts --force`,
    
    // Approach 3: Try with src/artifacts (like in GitHub workflows)
    `cd "${repoDir}" && aztec codegen target --outdir src/artifacts`,
    
    // Approach 4: Try with src/artifacts and force flag
    `cd "${repoDir}" && aztec codegen target --outdir src/artifacts --force`,
  ];
  
  for (const approach of approaches) {
    console.log(`🔧 Trying: ${approach}`);
    if (tryRun(approach)) {
      console.log('✅ Codegen completed successfully');
      return true;
    }
    console.log('⚠️ Approach failed, trying next...');
  }
  
  console.error('❌ All codegen approaches failed');
  return false;
}

async function main() {
  // Check if the package exists in dependencies - if not, exit gracefully
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  const packageJson = readJSON<{ dependencies?: Record<string, string> }>(packageJsonPath);
  
  if (!packageJson?.dependencies?.[PKG]) {
    console.log(`ℹ️ ${PKG} not found in dependencies, skipping build`);
    return;
  }

  try {
    // Extract repo info from package.json
    const { repo: REPO, ref: REF } = extractRepoInfo();
    
    let installedPath: string;
    let sandboxManager: SandboxManager | null = null;

    // 1) Locate the installed (unbuilt) package in node_modules
    try {
      installedPath = pkgDir(PKG);
    } catch {
      console.error(`❌ Could not resolve ${PKG}. Is it listed in "dependencies"?`);
      return;
    }

    // 1.5) Check if build artifacts already exist
    const artifactsPath = path.join(installedPath, 'current', 'artifacts');
    const distPath = path.join(installedPath, 'dist');
    const targetPath = path.join(installedPath, 'current', 'target');
    
    const hasArtifacts = fs.existsSync(artifactsPath) && fs.readdirSync(artifactsPath).length > 0;
    const hasDist = fs.existsSync(distPath) && fs.readdirSync(distPath).length > 0;
    const hasTarget = fs.existsSync(targetPath) && fs.readdirSync(targetPath).length > 0;
    
    if (hasArtifacts && hasDist && hasTarget) {
      console.log(`✅ ${PKG} build artifacts already exist, skipping build`);
      return;
    }
    
    console.log(`🔧 ${PKG} build artifacts missing or incomplete, proceeding with build...`);

    // 2) Temp clone and install dev deps - ensure temp dir is within user home
    const userHome = os.homedir();
    const tmp = fs.mkdtempSync(path.join(userHome, '.aztec-build-'));
    const repoDir = path.join(tmp, 'repo');

    try {
      console.log(`\n🔨 Building ${PKG} from ${REPO} @ ${REF}`);
      console.log(`📁 Using temp directory: ${tmp}`);
      run(`git clone ${REPO} "${repoDir}" --quiet`);
      run(`git -C "${repoDir}" checkout ${REF} --quiet`);

      // Install dependencies using detected package manager
      if (!installDependencies(repoDir)) {
        console.warn('⚠️ Primary package manager install failed, trying npm as fallback');
        run(`cd "${repoDir}" && npm install --no-audit --no-fund`);
      }

      // 3) Determine Aztec version (if present) and whether to run codegen
      const pkgJson = readJSON<{ scripts?: Record<string,string>; config?: any }>(path.join(repoDir, 'package.json'));
      const aztecVersion: string = pkgJson?.config?.aztecVersion || '';

      // Check if aztec CLI is available
      let hasAztec = which('aztec');
      if (!hasAztec) {
        console.log('🔧 Installing Aztec CLI...');
        const azScript = path.join(tmp, 'install-aztec.sh');
        fs.writeFileSync(azScript, 'curl -s https://install.aztec.network > /tmp/az.sh && bash /tmp/az.sh <<< yes "yes"\n');
        run(`bash -lc "bash ${azScript}"`);
        // ensure PATH includes aztec bin
        const homeBin = path.join(os.homedir(), '.aztec', 'bin');
        process.env.PATH = `${homeBin}${path.delimiter}${process.env.PATH}`;
        hasAztec = which('aztec');
      }
      
      if (!hasAztec) {
        console.warn('⚠️ aztec CLI not found and could not install it, skipping codegen');
        return;
      }
      
      if (aztecVersion) {
        console.log(`🔧 Setting Aztec version to ${aztecVersion}`);
        tryRun(`bash -lc "VERSION=${aztecVersion} aztec-up"`);
      }

      // 4) Compile sources if repo exposes a compile script
      if (pkgJson?.scripts?.compile) {
        if (!runWithPackageManager(repoDir, 'compile')) {
          throw new Error(`Failed to compile with detected package manager: ${detectPackageManager(repoDir)}`);
        }
      }

      // 5) Codegen - now with sandbox support
      ensureDir(path.join(repoDir, 'artifacts'));
      
      // Ensure sandbox is running for codegen
      sandboxManager = await ensureSandboxForCodegen();
      
      try {
        if (!runCodegen(repoDir)) {
          throw new Error('All codegen approaches failed');
        }
      } catch (error) {
        console.error('❌ Codegen failed:', error);
        throw error;
      }

      // 6) Compile TS artifacts → dist (if any TS in artifacts/)
      ensureDir(path.join(repoDir, 'dist'));
      const artifactsDir = path.join(repoDir, 'artifacts');
      const hasTsArtifacts =
        fs.existsSync(artifactsDir) &&
        fs.readdirSync(artifactsDir).some(f => f.endsWith('.ts'));

      if (hasTsArtifacts) {
        // prefer local tsc if present; otherwise use npx typescript
        const tscCmd = which('tsc') ? 'tsc' : 'npx -y typescript tsc';
        run(
          `cd "${repoDir}" && ${tscCmd} artifacts/*.ts --outDir dist/ --skipLibCheck --target es2020 --module nodenext --moduleResolution nodenext --resolveJsonModule --declaration`
        );
      } else {
        console.log('ℹ️ No TS artifacts found under artifacts/ (skipping tsc on artifacts/*.ts).');
      }

      // 7) Copy outputs into the installed package
      console.log(`\n📁 Copying outputs into installed package:\n   ${installedPath}`);

      // dist/
      cp(path.join(repoDir, 'dist'), path.join(installedPath, 'dist'));

      // target/ (if codegen produced it)
      cp(path.join(repoDir, 'target'), path.join(installedPath, 'current', 'target'));

      // artifacts/ (compiled + sources from codegen)
      if (fs.existsSync(path.join(repoDir, 'artifacts'))) {
        cp(path.join(repoDir, 'artifacts'), path.join(installedPath, 'current', 'artifacts'));
      }

      // deployments.json if present
      if (fs.existsSync(path.join(repoDir, 'src', 'deployments.json'))) {
        cp(path.join(repoDir, 'src', 'deployments.json'), path.join(installedPath, 'current', 'deployments.json'));
      }

      // Nice-to-haves
      for (const f of ['README.md', 'LICENSE']) {
        if (fs.existsSync(path.join(repoDir, f))) {
          cp(path.join(repoDir, f), path.join(installedPath, f));
        }
      }

      console.log('\n✅ @defi-wonderland/aztec-standards built and patched into node_modules successfully.');
    } catch (err: any) {
      console.error('\n❌ Build script failed:', err?.message || err);
      process.exit(1);
    } finally {
      // Clean up sandbox if we started it
      if (sandboxManager) {
        try {
          console.log('🛑 Stopping sandbox...');
          await sandboxManager.stop();
          console.log('✅ Sandbox stopped');
        } catch (error) {
          console.warn('⚠️ Error stopping sandbox:', error);
        }
      }
      
      // cleanup temp directory
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  } catch (err: any) {
    console.error('\n❌ Build script failed:', err?.message || err);
    process.exit(1);
  }
}

main();