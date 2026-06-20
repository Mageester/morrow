import { app } from "./server.js";

const server = app();
await server.listen({ host: "127.0.0.1", port: 4317 });
