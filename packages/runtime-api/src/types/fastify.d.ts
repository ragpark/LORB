import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the observability hook on every request; propagated to responses and logs. */
    correlationId: string;
    /** Wall-clock start, used for the duration metric. */
    startedAt: number;
  }
}
