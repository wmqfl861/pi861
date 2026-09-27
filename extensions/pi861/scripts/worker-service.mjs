#!/usr/bin/env node
// P2-W production entry for a pi861 RemoteWorker node (R3.13; registry path reserved by P0-T).
//
// Operator command:
//   node extensions/pi861/scripts/worker-service.mjs /absolute/path/to/worker.config.json
// or set PI861_WORKER_CONFIG to that absolute path. The trusted JSON config (identity, capabilities,
// process spec, checks, isolation mode) is documented in src/live/worker-service.ts; identity and
// capabilities are read ONLY from that file, never from requests. SIGTERM/SIGINT and POST /shutdown
// converge in-flight jobs to `unknown` and exit 0.
import { workerServiceMain } from "../src/live/worker-service.ts";

await workerServiceMain();
