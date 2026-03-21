import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
const deployReady = process.argv.includes("--deploy-ready");

const requiredPaths = [
  "apps/web/package.json",
  "apps/api/package.json",
  "packages/shared/package.json",
  "packages/types/package.json",
  ".planning/config.json",
  ".autopilot/config.json",
  ".planning/PROJECT.md",
  ".planning/ROADMAP.md",
  "dev/task.json",
  "dev/progress.txt",
  "README.md"
];

const missing = requiredPaths.filter((relativePath) => !existsSync(path.join(root, relativePath)));

const issues = [];

function parseJson(relativePath) {
  try {
    const file = readFileSync(path.join(root, relativePath), "utf8");
    return JSON.parse(file);
  } catch (error) {
    issues.push(`Invalid JSON: ${relativePath} (${error.message})`);
    return null;
  }
}

const config = parseJson(".planning/config.json");
const taskFile = parseJson("dev/task.json");

if (config && typeof config.workflow !== "object") {
  issues.push("Missing workflow section in .planning/config.json");
}

if (taskFile && !Array.isArray(taskFile.tasks)) {
  issues.push("dev/task.json must contain a tasks array");
}

if (missing.length > 0) {
  for (const entry of missing) {
    issues.push(`Missing required path: ${entry}`);
  }
}

// --- Optional module checks ---
if (config?.optional_modules?.payment?.enabled) {
  const envPath = path.join(root, ".env.local");
  const envPathAlt = path.join(root, ".env");
  let envContent = "";
  if (existsSync(envPath)) {
    envContent = readFileSync(envPath, "utf8");
  } else if (existsSync(envPathAlt)) {
    envContent = readFileSync(envPathAlt, "utf8");
  }

  if (!envContent) {
    issues.push("Payment module enabled but no .env.local or .env file found. See .ai/recipes/payment-integration-guide.md");
  } else {
    const requiredKeys = ["PAYMENT_API_KEY", "PAYMENT_WEBHOOK_SECRET"];
    for (const key of requiredKeys) {
      // Match KEY=value where value is not empty
      const pattern = new RegExp(`^${key}=.+`, "m");
      if (!pattern.test(envContent)) {
        issues.push(`Payment module enabled but ${key} is missing or empty in .env`);
      }
    }
  }
}

if (issues.length > 0) {
  console.error("Health check failed:");
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

const taskCount = Array.isArray(taskFile?.tasks) ? taskFile.tasks.length : 0;

console.log("Health check passed.");
console.log(`Required paths: ${requiredPaths.length}`);
console.log(`Tasks tracked: ${taskCount}`);

// ===================================================================
// DEPLOY READY MODE
// ===================================================================

if (!deployReady) {
  process.exit(0);
}

console.log("\n--- Deployment Readiness Checks ---\n");

const deployResults = [];
let blockingFailures = 0;

function pass(description) {
  deployResults.push({ status: "PASS", description });
  console.log(`✅ PASS: ${description}`);
}

function warn(description) {
  deployResults.push({ status: "WARN", description });
  console.log(`⚠️  WARN: ${description}`);
}

function fail(description) {
  deployResults.push({ status: "FAIL", description });
  console.log(`❌ FAIL: ${description}`);
  blockingFailures++;
}

// ===================================================================
// 1. Production Environment Variables
// ===================================================================

const envProdPath = path.join(root, ".env.production");
const envProdAltPath = path.join(root, ".env.prod");
let envProdContent = null;
let envProdFile = null;

if (existsSync(envProdPath)) {
  envProdContent = readFileSync(envProdPath, "utf8");
  envProdFile = ".env.production";
} else if (existsSync(envProdAltPath)) {
  envProdContent = readFileSync(envProdAltPath, "utf8");
  envProdFile = ".env.prod";
}

if (envProdContent !== null) {
  pass(`Production env file found: ${envProdFile}`);

  // Check for placeholder values
  const placeholderPattern = /(?:xxx|changeme|TODO|your[-_]?key[-_]?here)/i;
  const lines = envProdContent.split(/\r?\n/);
  const placeholderLines = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return false;
    return placeholderPattern.test(trimmed);
  });

  if (placeholderLines.length > 0) {
    fail(`Placeholder values found in ${envProdFile}: ${placeholderLines.map((l) => l.split("=")[0]).join(", ")}`);
  } else {
    pass(`No placeholder values in ${envProdFile}`);
  }

  // Check required production vars
  const requiredProdVars = ["NODE_ENV"];
  // Add DATABASE_URL if any db-related key is already in the env
  if (/DATABASE_URL|DB_HOST|DB_NAME/i.test(envProdContent)) {
    requiredProdVars.push("DATABASE_URL");
  }

  for (const key of requiredProdVars) {
    const pattern = new RegExp(`^${key}=.+`, "m");
    if (pattern.test(envProdContent)) {
      pass(`Production var present: ${key}`);
    } else {
      fail(`Missing required production var: ${key}`);
    }
  }
} else {
  warn("No .env.production or .env.prod file found — required for production deployment");
}

// ===================================================================
// 2. Secrets in Source Code
// ===================================================================

const secretPattern = /['"]\s*\w*(?:key|secret|password|token|api.?key)['"]\s*[:=]\s*['"][^'"]{8,}/i;

// Source directories to scan
const sourceDirs = ["src", "apps", "packages"].filter((d) => existsSync(path.join(root, d)));

let secretsFound = false;

for (const dir of sourceDirs) {
  try {
    // Use a platform-compatible grep approach via Node
    const absoluteDir = path.join(root, dir);
    const grepCmd = process.platform === "win32"
      ? `findstr /s /r /i /c:"key.*=.*'" /c:"secret.*=.*'" /c:"password.*=.*'" /c:"token.*=.*'" "${absoluteDir}\\*.ts" "${absoluteDir}\\*.tsx" "${absoluteDir}\\*.js" "${absoluteDir}\\*.mjs" 2>nul`
      : `grep -rE --include="*.ts" --include="*.tsx" --include="*.js" --include="*.mjs" --exclude-dir=node_modules --exclude="*.test.*" --exclude="*.spec.*" -l '["'"'"'][^"'"'"']*(?:key|secret|password|token)[^"'"'"']*["'"'"']\\s*[:=]\\s*["'"'"'][^"'"'"']{8,}' "${absoluteDir}" 2>/dev/null`;

    // Instead of complex shell commands, scan files directly in Node
    const { readdirSync, statSync } = await import("node:fs");

    function walkDir(dirPath, fileList = []) {
      let entries;
      try {
        entries = readdirSync(dirPath);
      } catch {
        return fileList;
      }
      for (const entry of entries) {
        if (entry === "node_modules" || entry === ".git") continue;
        const fullPath = path.join(dirPath, entry);
        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          walkDir(fullPath, fileList);
        } else if (/\.(ts|tsx|js|mjs|jsx)$/.test(entry) && !/\.(test|spec)\.\w+$/.test(entry)) {
          fileList.push(fullPath);
        }
      }
      return fileList;
    }

    const files = walkDir(absoluteDir);

    for (const file of files) {
      // Skip env files
      if (path.basename(file).startsWith(".env")) continue;

      let content;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }

      if (secretPattern.test(content)) {
        fail(`Possible hardcoded secret in: ${path.relative(root, file)}`);
        secretsFound = true;
      }
    }
  } catch {
    warn(`Could not scan ${dir}/ for secrets`);
  }
}

if (!secretsFound) {
  pass("No hardcoded secrets detected in source files");
}

// Check .gitignore covers sensitive files
const gitignorePath = path.join(root, ".gitignore");
if (existsSync(gitignorePath)) {
  const gitignoreContent = readFileSync(gitignorePath, "utf8");
  const requiredIgnores = [".env", ".env.local", ".env.production", "*.pem", "*.key"];
  const missingIgnores = requiredIgnores.filter((pattern) => !gitignoreContent.includes(pattern));

  if (missingIgnores.length === 0) {
    pass(".gitignore covers all sensitive file patterns");
  } else {
    fail(`.gitignore missing patterns: ${missingIgnores.join(", ")}`);
  }
} else {
  fail(".gitignore file not found");
}

// ===================================================================
// 3. Build Verification
// ===================================================================

const hasPnpm = existsSync(path.join(root, "pnpm-workspace.yaml")) || existsSync(path.join(root, "pnpm-lock.yaml"));
const buildCmd = hasPnpm ? "pnpm build" : "npm run build";

console.log(`\nRunning build: ${buildCmd} ...`);
let buildExitCode = 0;
try {
  execSync(buildCmd, { cwd: root, stdio: "pipe" });
} catch (err) {
  buildExitCode = err.status ?? 1;
}

if (buildExitCode === 0) {
  pass(`Build succeeded (${buildCmd})`);
} else {
  fail(`Build failed with exit code ${buildExitCode} (${buildCmd})`);
}

// Verify build output directory exists
const buildOutputDirs = ["dist", "build", ".next", "out"];
const existingOutputDirs = buildOutputDirs.filter((d) => existsSync(path.join(root, d)));

// Also check in apps/ subdirectories
const appsDir = path.join(root, "apps");
if (existsSync(appsDir)) {
  const { readdirSync } = await import("node:fs");
  try {
    const appDirs = readdirSync(appsDir);
    for (const app of appDirs) {
      for (const outDir of buildOutputDirs) {
        if (existsSync(path.join(appsDir, app, outDir))) {
          existingOutputDirs.push(`apps/${app}/${outDir}`);
        }
      }
    }
  } catch {
    // ignore
  }
}

if (existingOutputDirs.length > 0) {
  pass(`Build output directories found: ${existingOutputDirs.join(", ")}`);
} else if (buildExitCode === 0) {
  warn("Build succeeded but no standard output directory found (dist/, build/, .next/, out/)");
} else {
  warn("No build output directories found — build may not have run successfully");
}

// ===================================================================
// 4. Package.json Checks
// ===================================================================

const rootPkg = (() => {
  try {
    return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
})();

if (rootPkg) {
  // name field
  const placeholderNames = ["my-app", "my-project", "scaffold", "template", "starter", "default", "placeholder"];
  if (!rootPkg.name || placeholderNames.includes(rootPkg.name)) {
    warn(`package.json name field is default/placeholder: "${rootPkg.name ?? ""}"`);
  } else {
    pass(`package.json name: "${rootPkg.name}"`);
  }

  // version field
  if (!rootPkg.version) {
    fail("package.json missing version field");
  } else {
    pass(`package.json version: "${rootPkg.version}"`);
  }

  // private / publishConfig
  if (rootPkg.private === true) {
    pass("package.json has private: true");
  } else if (rootPkg.publishConfig) {
    pass("package.json has publishConfig (intended for publish)");
  } else {
    warn("package.json: neither private:true nor publishConfig — may be accidentally published");
  }

  // Check for file: or link: dependencies
  const allDeps = {
    ...rootPkg.dependencies,
    ...rootPkg.devDependencies,
    ...rootPkg.peerDependencies
  };

  const localDeps = Object.entries(allDeps)
    .filter(([, v]) => typeof v === "string" && (v.startsWith("file:") || v.startsWith("link:")))
    .map(([k]) => k);

  if (localDeps.length > 0) {
    fail(`Local file:/link: dependencies found (won't work in production): ${localDeps.join(", ")}`);
  } else {
    pass("No file:/link: dependencies in root package.json");
  }
} else {
  fail("Could not read root package.json");
}

// ===================================================================
// 5. Legal Pages (if payment module enabled)
// ===================================================================

if (config?.optional_modules?.payment?.enabled) {
  // Check for privacy policy file or route
  const privacyPatterns = [
    "apps/web/src/pages/privacy",
    "apps/web/src/pages/privacy-policy",
    "apps/web/app/privacy",
    "apps/web/app/privacy-policy",
    "apps/web/public/privacy.html",
    "apps/web/public/privacy-policy.html"
  ];

  const tosPatterns = [
    "apps/web/src/pages/terms",
    "apps/web/src/pages/terms-of-service",
    "apps/web/app/terms",
    "apps/web/app/terms-of-service",
    "apps/web/public/terms.html",
    "apps/web/public/terms-of-service.html"
  ];

  const hasPrivacy = privacyPatterns.some((p) =>
    ["", ".tsx", ".ts", ".jsx", ".js", "/page.tsx", "/page.ts", "/index.tsx"].some((ext) =>
      existsSync(path.join(root, p + ext))
    )
  );

  const hasTos = tosPatterns.some((p) =>
    ["", ".tsx", ".ts", ".jsx", ".js", "/page.tsx", "/page.ts", "/index.tsx"].some((ext) =>
      existsSync(path.join(root, p + ext))
    )
  );

  if (hasPrivacy) {
    pass("Privacy policy page/route found");
  } else {
    fail("Payment module enabled but no privacy policy page found");
  }

  if (hasTos) {
    pass("Terms of service page/route found");
  } else {
    fail("Payment module enabled but no terms of service page found");
  }

  // Check for support email in source/config
  const searchDirs = ["src", "apps", "packages"].filter((d) => existsSync(path.join(root, d)));
  const emailPattern = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
  const supportEmailPattern = /support@|help@|contact@/i;
  let supportEmailFound = false;

  for (const dir of searchDirs) {
    try {
      const content = execSync(
        process.platform === "win32"
          ? `findstr /s /r /i "support@\\|help@\\|contact@" "${path.join(root, dir)}\\*.ts" "${path.join(root, dir)}\\*.tsx" 2>nul`
          : `grep -r --include="*.ts" --include="*.tsx" --include="*.json" -l "support@\\|help@\\|contact@" "${path.join(root, dir)}" 2>/dev/null`,
        { encoding: "utf8", stdio: "pipe" }
      ).trim();

      if (content) {
        supportEmailFound = true;
        break;
      }
    } catch {
      // grep returns non-zero when no match found — that's okay
    }
  }

  // Also check config.json for support email
  const configStr = JSON.stringify(config);
  if (!supportEmailFound && supportEmailPattern.test(configStr)) {
    supportEmailFound = true;
  }

  if (supportEmailFound) {
    pass("Support email found in source/config");
  } else {
    warn("Payment module enabled but no support email (support@/help@/contact@) found in source/config");
  }
} else {
  pass("Payment module not enabled — skipping legal page checks");
}

// ===================================================================
// Final Summary
// ===================================================================

console.log("\n--- Deploy Readiness Summary ---\n");
console.log(`Checks run: ${deployResults.length}`);
console.log(`  PASS: ${deployResults.filter((r) => r.status === "PASS").length}`);
console.log(`  WARN: ${deployResults.filter((r) => r.status === "WARN").length}`);
console.log(`  FAIL: ${deployResults.filter((r) => r.status === "FAIL").length}`);

if (blockingFailures === 0) {
  console.log("\nDEPLOY READY ✅");
} else {
  console.log(`\nNOT DEPLOY READY ❌ — ${blockingFailures} blocking issue${blockingFailures === 1 ? "" : "s"}`);
  process.exit(1);
}
