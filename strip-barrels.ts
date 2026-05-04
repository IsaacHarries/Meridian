// One-off ts-morph script: strips a barrel module by rewriting every
// consumer's import block to point straight at the file that defines each
// imported symbol.
//
// Run with: npx tsx /tmp/strip-barrels.ts
//
// Pass mode: "frontend" or "sidecar". In frontend mode the script uses the
// repo-root tsconfig and rewrites `@/lib/...` aliased imports. In sidecar
// mode it uses src-sidecar/tsconfig.json and rewrites relative `./*.js`
// imports (re-emitting the `.js` extension that the sidecar uses).

import * as path from "node:path";
import { Project, type ImportDeclaration, type SourceFile, ts } from "ts-morph";

interface BarrelJob {
  /** Absolute path to the barrel file. */
  barrelFile: string;
  /**
   * Module specifiers a consumer might use to refer to the barrel.
   * E.g. ["@/lib/tauri"] for the frontend, or
   * ["./pipeline.js", "../pipeline.js"] for the sidecar.
   */
  matchSpecifiers: (decl: ImportDeclaration, consumer: SourceFile) => boolean;
  /**
   * Given the absolute path of the file that actually declares an imported
   * symbol, return the module specifier the consumer should use.
   */
  toModuleSpecifier: (declFile: string, consumer: SourceFile) => string;
  /**
   * Whether to skip a consumer based on its file path (e.g. don't rewrite
   * sibling files inside the barrel's own directory).
   */
  skipConsumer?: (file: string) => boolean;
}

interface RunArgs {
  tsconfig: string;
  jobs: BarrelJob[];
}

function aliasFromAbsolute(absPath: string, repoRoot: string): string {
  // Frontend uses `@/` alias for `src/`. Strip extension.
  const rel = path.relative(path.join(repoRoot, "src"), absPath).replace(/\\/g, "/");
  const noExt = rel.replace(/\.tsx?$/, "");
  return `@/${noExt}`;
}

function relativeJsSpec(declFile: string, consumer: SourceFile): string {
  const fromDir = path.dirname(consumer.getFilePath());
  let rel = path.relative(fromDir, declFile).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  // Convert .ts/.tsx → .js (sidecar uses ESM .js extensions in TS source)
  rel = rel.replace(/\.tsx?$/, ".js");
  return rel;
}

interface NamedSpec {
  name: string;
  alias?: string;
  isType: boolean;
}

function processConsumer(
  sf: SourceFile,
  jobs: BarrelJob[],
): boolean {
  let changed = false;
  for (const decl of [...sf.getImportDeclarations()]) {
    const matchedJob = jobs.find((j) => j.matchSpecifiers(decl, sf));
    if (!matchedJob) continue;
    // Skip if this consumer is a sibling of the matched barrel.
    if (matchedJob.skipConsumer?.(sf.getFilePath())) continue;

    // Group imports by destination module specifier.
    const buckets = new Map<string, NamedSpec[]>();
    let hadResolutionFailure = false;
    let allTypeOnlyImport = decl.isTypeOnly();

    const keptInBarrel: NamedSpec[] = [];

    for (const named of decl.getNamedImports()) {
      // Resolve the symbol to its declaration file. Use the *aliased* symbol
      // so we follow re-export chains down to the original source.
      const nameNode = named.getNameNode();
      const sym = nameNode.getSymbol();
      const aliased = sym?.getAliasedSymbol() ?? sym;
      const decls = aliased?.getDeclarations() ?? [];

      const aliasNode = named.getAliasNode();
      const namedSpec: NamedSpec = {
        name: named.getName(),
        alias: aliasNode?.getText(),
        isType: named.isTypeOnly() || allTypeOnlyImport,
      };

      // Pick the first non-barrel declaration if the symbol is re-exported.
      let realFile: string | undefined;
      let definedInBarrel = false;
      for (const d of decls) {
        const f = d.getSourceFile().getFilePath();
        if (f === matchedJob.barrelFile) {
          definedInBarrel = true;
          continue;
        }
        realFile = f;
        break;
      }

      if (!realFile && definedInBarrel) {
        // Symbol is defined in the barrel itself — keep this import as-is.
        keptInBarrel.push(namedSpec);
        continue;
      }

      if (!realFile) {
        console.warn(
          `[strip-barrels] could not resolve symbol "${named.getName()}" in ${sf.getFilePath()}`,
        );
        hadResolutionFailure = true;
        continue;
      }

      const moduleSpec = matchedJob.toModuleSpecifier(realFile, sf);
      const list = buckets.get(moduleSpec) ?? [];
      list.push(namedSpec);
      buckets.set(moduleSpec, list);
    }

    if (hadResolutionFailure) {
      console.error(
        `[strip-barrels] aborting rewrite for ${sf.getFilePath()} due to unresolved symbols`,
      );
      continue;
    }

    if (decl.getNamespaceImport() || decl.getDefaultImport()) {
      console.error(
        `[strip-barrels] unsupported namespace/default import in ${sf.getFilePath()}`,
      );
      continue;
    }

    // Remove the barrel import and add new ones grouped by destination.
    const originalSpec = decl.getModuleSpecifierValue();
    decl.remove();
    for (const [mod, names] of buckets) {
      sf.addImportDeclaration({
        moduleSpecifier: mod,
        namedImports: names.map((n) => ({
          name: n.name,
          alias: n.alias,
          isTypeOnly: n.isType,
        })),
      });
    }
    if (keptInBarrel.length > 0 && originalSpec) {
      sf.addImportDeclaration({
        moduleSpecifier: originalSpec,
        namedImports: keptInBarrel.map((n) => ({
          name: n.name,
          alias: n.alias,
          isTypeOnly: n.isType,
        })),
      });
    }
    changed = true;
  }
  if (changed) {
    sf.organizeImports();
  }
  return changed;
}

async function run({ tsconfig, jobs }: RunArgs): Promise<void> {
  const project = new Project({
    tsConfigFilePath: tsconfig,
    skipAddingFilesFromTsConfig: false,
  });
  let touched = 0;
  for (const sf of project.getSourceFiles()) {
    const fp = sf.getFilePath();
    // Skip barrel files themselves; per-job skipConsumer is applied per-job
    // inside processConsumer (so a file that's a sibling for one barrel can
    // still be a consumer of another).
    if (jobs.some((j) => j.barrelFile === fp)) continue;
    if (processConsumer(sf, jobs)) {
      touched++;
    }
  }
  await project.save();
  console.log(`[strip-barrels] touched ${touched} files`);
}

// ── Job builders ─────────────────────────────────────────────────────────────

const REPO_ROOT = "/Users/isaac/REPOS/Meridian";

function frontendBarrel(specifier: string, barrelAbs: string, _siblingDir?: string): BarrelJob {
  // We DO rewrite sibling files in the barrel's target directory — they are
  // a perfectly fine consumer of the barrel and after the rewrite they'll
  // import from the right submodule directly. We just exclude the barrel
  // file itself so we don't try to rewrite its `export *` statements.
  void _siblingDir;
  return {
    barrelFile: barrelAbs,
    matchSpecifiers: (decl, consumer) => {
      // Match both the @-aliased form and any relative form (e.g. ./tauri,
      // ../mockData) that resolves to the same barrel file.
      const spec = decl.getModuleSpecifierValue();
      if (!spec) return false;
      if (spec === specifier) return true;
      if (spec.startsWith(".")) {
        const fromDir = path.dirname(consumer.getFilePath());
        const candidates = [
          path.resolve(fromDir, spec + ".ts"),
          path.resolve(fromDir, spec + ".tsx"),
          path.resolve(fromDir, spec),
        ];
        return candidates.includes(barrelAbs);
      }
      return false;
    },
    toModuleSpecifier: (declFile) => aliasFromAbsolute(declFile, REPO_ROOT),
  };
}

function sidecarBarrel(barrelAbs: string, siblingDir?: string): BarrelJob {
  return {
    barrelFile: barrelAbs,
    matchSpecifiers: (decl, consumer) => {
      const spec = decl.getModuleSpecifierValue();
      if (!spec) return false;
      if (!spec.startsWith(".")) return false;
      // Resolve specifier to absolute path (handle .js → .ts extension)
      const fromDir = path.dirname(consumer.getFilePath());
      const resolved = path.resolve(fromDir, spec.replace(/\.js$/, ".ts"));
      return resolved === barrelAbs;
    },
    toModuleSpecifier: (declFile, consumer) => relativeJsSpec(declFile, consumer),
    skipConsumer: siblingDir
      ? (f) => f.startsWith(siblingDir + "/") || f === barrelAbs
      : undefined,
  };
}

async function main() {
  const MODE = process.argv[2];

  if (MODE === "frontend") {
  const jobs: BarrelJob[] = [
    frontendBarrel(
      "@/lib/tauri",
      `${REPO_ROOT}/src/lib/tauri.ts`,
      `${REPO_ROOT}/src/lib/tauri`,
    ),
    frontendBarrel(
      "@/lib/backgrounds",
      `${REPO_ROOT}/src/lib/backgrounds.tsx`,
      `${REPO_ROOT}/src/lib/backgrounds`,
    ),
    frontendBarrel(
      "@/lib/mockData",
      `${REPO_ROOT}/src/lib/mockData.ts`,
      `${REPO_ROOT}/src/lib/mockData`,
    ),
    frontendBarrel(
      "@/lib/spaceEffects",
      `${REPO_ROOT}/src/lib/spaceEffects.tsx`,
      `${REPO_ROOT}/src/lib/spaceEffects`,
    ),
    frontendBarrel(
      "@/stores/implementTicketStore",
      `${REPO_ROOT}/src/stores/implementTicketStore.ts`,
      `${REPO_ROOT}/src/stores/implementTicket`,
    ),
    frontendBarrel(
      "@/stores/prReviewStore",
      `${REPO_ROOT}/src/stores/prReviewStore.ts`,
      `${REPO_ROOT}/src/stores/prReview`,
    ),
    frontendBarrel(
      "@/stores/meetingsStore",
      `${REPO_ROOT}/src/stores/meetingsStore.ts`,
      `${REPO_ROOT}/src/stores/meetings`,
    ),
  ];
  await run({ tsconfig: `${REPO_ROOT}/tsconfig.json`, jobs });
} else if (MODE === "sidecar") {
  const jobs: BarrelJob[] = [
    sidecarBarrel(
      `${REPO_ROOT}/src-sidecar/src/workflows/registry.ts`,
      `${REPO_ROOT}/src-sidecar/src/workflows/registry`,
    ),
    sidecarBarrel(
      `${REPO_ROOT}/src-sidecar/src/workflows/pipeline.ts`,
      `${REPO_ROOT}/src-sidecar/src/workflows/pipeline`,
    ),
    sidecarBarrel(
      `${REPO_ROOT}/src-sidecar/src/workflows/orchestrator.ts`,
      `${REPO_ROOT}/src-sidecar/src/workflows/orchestrator`,
    ),
  ];
  await run({ tsconfig: `${REPO_ROOT}/src-sidecar/tsconfig.json`, jobs });
  } else {
    console.error("Usage: tsx /tmp/strip-barrels.ts {frontend|sidecar}");
    process.exit(2);
  }
}

void ts;
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
