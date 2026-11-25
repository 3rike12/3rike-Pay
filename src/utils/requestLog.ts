import type { IncomingMessage, ServerResponse } from "http";

/**
 * Whether to leave a request out of the access log.
 *
 * The container's health check calls /health every few seconds, forever. Logging each success buries the lines
 * that matter. A FAILING health check is still logged, because that is exactly what you would want to see.
 */
export function skipFromAccessLog(req: Pick<IncomingMessage, "url">, res: Pick<ServerResponse, "statusCode">): boolean {
  const path = (req.url ?? "").split("?")[0];
  return path === "/health" && res.statusCode < 400;
}
