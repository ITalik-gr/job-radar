/**
 * `cloudflare:workers` exists only inside workerd. The OAuth provider imports it for a base
 * class, so tests that load `src/worker.ts` in Node get this stand-in.
 */
export class WorkerEntrypoint {}
