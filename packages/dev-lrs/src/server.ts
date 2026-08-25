/**
 * HTTP front for the development learning record store. Speaks enough of the xAPI statements
 * resource for the forwarder to talk to it exactly as it talks to a real one.
 */
import Fastify from "fastify";
import { receiveStatement, storedStatements } from "./receiver.js";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok" }));

app.put("/statements", async (req, reply) => {
  const statementId = (req.query as { statementId?: string })?.statementId;
  const result = await receiveStatement(req.body, statementId);
  return reply.code(result.statusCode).send();
});

app.post("/statements", async (req, reply) => {
  const result = await receiveStatement(req.body);
  return reply.code(result.statusCode === 204 ? 200 : result.statusCode).send();
});

app.get("/statements", async () => ({ statements: storedStatements() }));

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? process.env.LRS_PORT ?? 5000) });
