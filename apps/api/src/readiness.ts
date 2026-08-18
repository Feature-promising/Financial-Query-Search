import type { FastifyInstance, FastifyReply } from "fastify";

export interface ReadinessProbe {
  check(): Promise<void>;
}

interface RequestWithId { id: string; }

/** Registers a dependency-aware readiness endpoint distinct from process liveness. */
export function registerReadinessRoute(app: FastifyInstance, probe?: ReadinessProbe): void {
  app.get("/ready", async (request, reply) => {
    try {
      await probe?.check();
      return { status: "ready", service: "interactive-research-agent" };
    } catch (error) {
      app.log.error({ errorType: error instanceof Error ? error.name : "unknown", requestId: request.id }, "readiness check failed");
      return sendUnavailable(reply, request);
    }
  });
}

function sendUnavailable(reply: FastifyReply, request: RequestWithId): FastifyReply {
  return reply.code(503).send({ code: "UNAVAILABLE", message: "service is not ready", requestId: request.id });
}
