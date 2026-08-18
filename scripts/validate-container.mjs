import { readFile } from "node:fs/promises";

const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
for (const value of [
  "pnpm-lock.yaml",
  "RUN pnpm install --frozen-lockfile",
  "ARG NEXT_PUBLIC_OIDC_AUTHORITY",
  "ARG NEXT_PUBLIC_OIDC_CLIENT_ID",
  "RUN pnpm --filter @research/api deploy --prod /runtime",
  "RUN pnpm --filter @research/worker deploy --prod /runtime",
  "COPY --chown=node:node --from=base /app/apps/web/.next/standalone ./",
  "CMD [\"node\", \"apps/web/server.js\"]"
]) {
  if (!dockerfile.includes(value)) throw new Error(`Dockerfile is missing production build control: ${value}`);
}
if (dockerfile.includes("pnpm install --no-frozen-lockfile")) throw new Error("Dockerfile must not resolve unlocked dependencies during image build");
if (dockerfile.includes("COPY --from=base /app /app")) throw new Error("runtime images must not copy the full build workspace");
for (const stage of ["api", "worker", "web"]) {
  const stageStart = dockerfile.indexOf(`FROM node:22-alpine AS ${stage}`);
  const nextStage = dockerfile.indexOf("FROM node:22-alpine AS", stageStart + 1);
  const definition = dockerfile.slice(stageStart, nextStage === -1 ? undefined : nextStage);
  if (stageStart < 0 || !definition.includes("USER node")) throw new Error(`${stage} runtime image must run as the non-root node user`);
}

for (const relativePath of [
  "apps/api/package.json",
  "apps/worker/package.json",
  "packages/agent-runtime/package.json",
  "packages/auth/package.json",
  "packages/config/package.json",
  "packages/contracts/package.json",
  "packages/conversation/package.json",
  "packages/db/package.json",
  "packages/knowledge/package.json",
  "packages/live-events/package.json",
  "packages/memory/package.json",
  "packages/models/package.json",
  "packages/observability/package.json",
  "packages/platform-events/package.json",
  "packages/queue/package.json",
  "packages/reports/package.json",
  "packages/runs/package.json",
  "packages/tools/package.json"
]) {
  const manifest = JSON.parse(await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"));
  if (!Array.isArray(manifest.files) || !manifest.files.includes("dist")) {
    throw new Error(`${relativePath} must package compiled runtime files explicitly`);
  }
}

console.log("Container build contract validated");
