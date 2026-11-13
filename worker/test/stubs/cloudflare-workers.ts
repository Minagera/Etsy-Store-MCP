// Node stand-in for the workerd-only "cloudflare:workers" module. The OAuth
// library only uses WorkerEntrypoint for an instanceof check.
export class WorkerEntrypoint {
  constructor(public ctx: unknown, public env: unknown) {}
}
