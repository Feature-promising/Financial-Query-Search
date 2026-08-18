import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface LocalEnvironmentOptions {
  /** Injectable for tests; defaults to the process environment. */
  environment?: NodeJS.ProcessEnv;
  /** The application working directory from which `.env` is discovered. */
  cwd?: string;
}

/**
 * Loads a local `.env` file without adding a runtime dependency or changing
 * deployment-owned configuration. The nearest file is searched from the
 * executable working directory upwards, so a workspace root `.env` works when
 * an individual app package is launched directly.
 *
 * Existing environment variables always win. Production processes never read a
 * local file: ECS/CI must supply their approved configuration explicitly.
 */
export function loadLocalEnvironment(options: LocalEnvironmentOptions = {}): void {
  const environment = options.environment ?? process.env;
  if (environment.NODE_ENV === "production") return;

  const path = findLocalEnvironmentFile(options.cwd ?? process.cwd());
  if (!path) return;

  for (const [key, value] of parseLocalEnvironment(readFileSync(path, "utf8"))) {
    if (environment[key] === undefined) environment[key] = value;
  }
}

/** Finds only the closest workspace/developer `.env`, never a system-wide file. */
export function findLocalEnvironmentFile(cwd: string): string | undefined {
  let directory = resolve(cwd);
  while (true) {
    const candidate = resolve(directory, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * Deliberately small dotenv grammar: assignments, optional `export`, quoted
 * values, blank lines and full-line comments. It does not evaluate shell
 * substitutions or expand variables, keeping local configuration inert.
 */
export function parseLocalEnvironment(contents: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`invalid local environment assignment on line ${index + 1}`);
    values.set(match[1]!, parseEnvironmentValue(match[2]!));
  }
  return values;
}

function parseEnvironmentValue(rawValue: string): string {
  const value = rawValue.trim();
  if (!value) return "";
  const quote = value[0];
  if (quote === "\"" || quote === "'") {
    if (value.length < 2 || value.at(-1) !== quote) throw new Error("unterminated quoted local environment value");
    return value.slice(1, -1);
  }
  const commentStart = value.search(/\s#/);
  return (commentStart >= 0 ? value.slice(0, commentStart) : value).trimEnd();
}
