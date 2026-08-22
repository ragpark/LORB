// STUB — NOT PRODUCTION — BLOCKED BY BLK-02, BLK-03, BLK-07. See STUB.md.
import { buildRoster } from "./app.js";

const app = await buildRoster();
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? process.env.STUB_ROSTER_PORT ?? 4100) });
