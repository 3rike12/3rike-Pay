import type { IncomingMessage, ServerResponse } from "http";
import { redactPhone } from "@/utils/helpers";

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

/**
 * What to log about a message a person sent. By default NOT what they typed: people write amounts, names and
 * questions about their money, and logs outlive the conversation. We keep who (last four digits), where they are
 * in a flow, which button they tapped (an id we chose, not their words) and how long the message was. Set
 * LOG_MESSAGE_TEXT=true to include the text (still redacted in sensitive steps) while debugging.
 */
export function incomingMessageFields(i: {
  phone: string;
  state: string;
  text: string;
  action?: string;
  includeText: boolean;
  redactText: (state: string, text: string) => string;
}): Record<string, unknown> {
  return {
    phone: redactPhone(i.phone),
    state: i.state,
    ...(i.action ? { action: i.action } : {}),
    chars: i.text.trim().length,
    ...(i.includeText ? { text: i.redactText(i.state, i.text) } : {}),
  };
}

