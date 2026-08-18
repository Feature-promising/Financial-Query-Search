import { readFile } from "node:fs/promises";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
for (const required of [
  "pnpm install --frozen-lockfile",
  "pnpm check:container",
  "pnpm check:runtime-profiles",
  "pnpm eval:golden",
  "container-images:",
  "docker build --target api",
  "docker build --target worker",
  "docker build --target web",
  "postgres-integration:",
  "pnpm --filter @research/worker migrate",
]) {
  if (!workflow.includes(required)) throw new Error(`CI workflow is missing required release control: ${required}`);
}

console.log("CI release contract validated");
