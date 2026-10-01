import { Router, Request, Response } from "express";
import { createLogger } from "@/utils/logger";
import { decryptFlowRequest, encryptFlowResponse, screen } from "@/utils/flowCrypto";

export interface FlowContext {
  userId: string;
  /** Screen Meta says it is on; may be a screen id we do not recognise. */
  screen: string;
  data: any;
  payload: any;
}

export type FlowResult = { screen: string; data?: Record<string, unknown> };

export interface FlowDefinition {
  /** Logger scope, e.g. "business-flow". */
  name: string;
  /** Screen used for INIT and for anything we cannot place. */
  firstScreen: string;
  /** Returned when flow_token is missing or "unused". */
  expiredMessage?: string;
  /** data_exchange handlers keyed by screen id. */
  screens: Record<string, (ctx: FlowContext) => Promise<FlowResult>>;
  /** Used for data_exchange on a screen id not listed above. */
  fallback?: (ctx: FlowContext) => Promise<FlowResult>;
  /** Extra fields logged when a request cannot be decrypted. */
  onDecryptFailure?: Record<string, unknown>;
}

/**
 * One place for the parts every WhatsApp Flow endpoint repeats: decrypt,
 * ping, flow_token check, INIT, data_exchange dispatch, encrypt, and the
 * error paths. Flows differ only in their screens — so they only supply
 * those.
 */
export function createFlowRouter(definition: FlowDefinition): Router {
  const logger = createLogger(definition.name);
  const router = Router();

  const send = (res: Response, aesKey: Buffer, iv: Buffer, result: unknown) =>
    res.send(encryptFlowResponse(result, aesKey, iv));

  router.post("/", async (req: Request, res: Response) => {
    let aesKey: Buffer;
    let iv: Buffer;
    let payload: any;

    try {
      const decoded = decryptFlowRequest(req.body);
      payload = decoded.decrypted;
      aesKey = decoded.aesKey;
      iv = decoded.iv;
    } catch (error: any) {
      // Meta pings the endpoint unencrypted to verify it is reachable; that
      // arrives with no payload keys at all. Log the shape so a real Flow
      // request that failed to decrypt is distinguishable from that ping.
      const body = req.body || {};
      logger.error("Flow request decryption failed", {
        error: error.message,
        bodyKeys: Object.keys(body),
        encryptedPayload: Boolean(body.encrypted_flow_data),
        encryptedAesKey: Boolean(body.encrypted_aes_key),
        userAgent: req.get("user-agent"),
        ...(definition.onDecryptFailure || {}),
      });
      return res.status(421).send();
    }

    const { action, screen: currentScreen, data, flow_token } = payload;
    logger.info("Flow request decoded", {
      action,
      screen: currentScreen,
      flow_token: flow_token ? "set" : "missing",
    });

    try {
      const clientError = payload?.data?.error_message || payload?.error_message;
      if (clientError) {
        logger.warn("Flow client error", { error: clientError });
        return send(res, aesKey, iv, { data: { acknowledged: true } });
      }

      if (action === "ping") {
        return send(res, aesKey, iv, { data: { status: "active" } });
      }

      const userId = String(flow_token || "");
      if (!userId || userId === "unused") {
        return send(
          res,
          aesKey,
          iv,
          screen(definition.firstScreen, {
            error_message: definition.expiredMessage || "Session expired. Please restart.",
          })
        );
      }

      const ctx: FlowContext = {
        userId,
        screen: String(currentScreen || definition.firstScreen),
        data: data || {},
        payload,
      };

      if (action === "INIT") {
        return send(res, aesKey, iv, screen(definition.firstScreen, { error_message: "" }));
      }

      if (action === "data_exchange") {
        const handler =
          definition.screens[ctx.screen] ||
          definition.fallback ||
          (async () => screen(definition.firstScreen, { error_message: "" }));
        return send(res, aesKey, iv, await handler(ctx));
      }

      if (action === "complete") {
        return send(res, aesKey, iv, screen(ctx.screen));
      }

      return send(res, aesKey, iv, screen(definition.firstScreen, { error_message: "" }));
    } catch (error: any) {
      logger.error("Flow request failed", {
        action,
        screen: currentScreen,
        error: error.message,
        stack: error.stack,
      });
      return send(
        res,
        aesKey,
        iv,
        screen(definition.firstScreen, { error_message: "Something went wrong. Try again." })
      );
    }
  });

  return router;
}
