import { describe, expect, it } from "vitest";
import { startOpenTelemetry } from "../src/index.js";

describe("startOpenTelemetry", () => {
  it("does not create an implicit exporter without an endpoint", async () => {
    let started = false;
    const lifecycle = startOpenTelemetry({
      serviceName: "test",
      sdk: { start: () => { started = true; }, shutdown: async () => undefined },
    });

    expect(lifecycle.enabled).toBe(false);
    expect(started).toBe(false);
    await lifecycle.shutdown();
  });

  it("starts and shuts down the supplied SDK for an explicit collector endpoint", async () => {
    let started = false;
    let stopped = false;
    const lifecycle = startOpenTelemetry({
      serviceName: "test",
      tracesEndpoint: "https://collector.internal/v1/traces",
      sdk: { start: () => { started = true; }, shutdown: async () => { stopped = true; } },
    });

    expect(lifecycle.enabled).toBe(true);
    expect(started).toBe(true);
    await lifecycle.shutdown();
    expect(stopped).toBe(true);
  });
});
