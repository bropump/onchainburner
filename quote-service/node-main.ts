/** Node-only entry retained for local fork tests until the Worker release is proven. */
import { defaultLogSink, main, sanitizeForTransport } from "./server";

void main().catch((error) => {
  defaultLogSink({
    ts: new Date().toISOString(),
    level: "fatal",
    event: "startup-failed",
    detail: sanitizeForTransport(
      error instanceof Error ? error.message : String(error)
    ),
  });
  process.exit(1);
});
