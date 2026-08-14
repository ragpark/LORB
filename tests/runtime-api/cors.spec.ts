import { afterEach, describe, expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";

const hostedConsumerOrigin = "https://lorb-production-consumer.up.railway.app";
const originalOrigins = process.env.ALLOWED_CONSUMER_ORIGINS;

afterEach(() => {
  if (originalOrigins === undefined) delete process.env.ALLOWED_CONSUMER_ORIGINS;
  else process.env.ALLOWED_CONSUMER_ORIGINS = originalOrigins;
});

describe("Runtime API CORS", () => {
  it("allows preflight requests from the hosted consumer by default", async () => {
    delete process.env.ALLOWED_CONSUMER_ORIGINS;
    const { app } = await buildRuntime();

    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/runtime/repositories",
      headers: {
        origin: hostedConsumerOrigin,
        "access-control-request-method": "GET",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(hostedConsumerOrigin);
    await app.close();
  });

  it("uses a trimmed explicit allow-list and still rejects other origins", async () => {
    process.env.ALLOWED_CONSUMER_ORIGINS = " https://consumer.example , https://second.example ";
    const { app } = await buildRuntime();

    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/runtime/repositories",
      headers: { origin: "https://consumer.example", "access-control-request-method": "GET" },
    });
    const rejected = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/runtime/repositories",
      headers: { origin: hostedConsumerOrigin, "access-control-request-method": "GET" },
    });

    expect(allowed.headers["access-control-allow-origin"]).toBe("https://consumer.example");
    expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });
});
