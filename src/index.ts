import express from "express";
import path from "path";
import fs from "fs";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { config } from "@/config";
import { createLogger } from "@/utils/logger";

const logger = createLogger("server");
import webhooksRouter from "@/api/webhooks";
import notifyRouter from "@/api/notify";
import flowRouter from "@/api/flow";
import transferFlowRouter from "@/api/transferFlow";
import revalidationFlowRouter from "@/api/revalidationFlow";
import { generalLimiter, transferPinLimiter } from "@/api/middleware/rateLimit";

const app = express();

// Requests reach us through a proxy (ngrok in dev, whatever terminates TLS in
// prod), which sets X-Forwarded-For. Without this express-rate-limit refuses to
// key off that header and throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every
// request - including Meta's webhook deliveries. One hop is all we trust, so a
// client can't spoof its way around the limiter by forging the header.
app.set("trust proxy", 1);

// ============================================
// Middleware
// ============================================
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(cors());
app.use(morgan("combined"));
app.use(generalLimiter);

// Raw body for AutoRamp webhook signature verification.
// MUST be registered before express.json() - the first body parser to run wins,
// and the HMAC is computed over the exact bytes AutoRamp sent.
app.use("/webhook/autoramp", express.raw({ type: "application/json" }));

// Parse JSON
app.use(express.json({ limit: "10mb" }));

// ============================================
// Health check
// ============================================
app.get("/health", (_req: express.Request, res: express.Response) => {
  res.json({
    status: "ok",
    service: config.app.name,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ============================================
// API Routes
// ============================================
app.use("/webhook", webhooksRouter);
app.use("/webhook/notify", notifyRouter);
app.use("/webhook/flow/kyc", flowRouter);
app.use("/webhook/flow/transfer", transferPinLimiter, transferFlowRouter);
app.use("/webhook/flow/revalidation", revalidationFlowRouter);

// ============================================
// Serve React frontend (built output)
// ============================================
const webDist = path.join(__dirname, "../web/dist");
const webIndex = path.join(webDist, "index.html");
const hasFrontend = fs.existsSync(webIndex);

if (hasFrontend) {
  app.use(express.static(webDist));

  // SPA fallback - serve index.html for all non-API routes
  app.get("*", (req: express.Request, res: express.Response) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/webhook/") || req.path === "/health") {
      return res.status(404).json({ error: "Not found" });
    }
    res.sendFile(webIndex);
  });
} else {
  // No frontend built yet - return a graceful landing response instead of
  // crashing on requests to the root URL (e.g. Render's uptime check).
  app.get("*", (req: express.Request, res: express.Response) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/webhook/") || req.path === "/health") {
      return res.status(404).json({ error: "Not found" });
    }
    res.json({
      service: config.app.name,
      status: "running",
      message: "Frontend not built. API is available under /api and /webhook.",
    });
  });
}

// ============================================
// Error handler
// ============================================
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error("Unhandled error", { error: err.message, stack: err.stack });
  res.status(500).json({ error: "Internal server error" });
});

// ============================================
// Start server
// ============================================
async function main() {
  logger.info(`Starting ${config.app.name}...`);

  app.listen(config.port, () => {
    logger.info(`${config.app.name} running on port ${config.port}`);
    logger.info(`KYC page: http://localhost:${config.port}/kyc`);
    logger.info(`WhatsApp webhook: ${config.webhook.path}`);
    logger.info(`AutoRamp webhook: /webhook/autoramp`);
    logger.info(`Notify webhook: /webhook/notify`);
    logger.info(`Health check: /health`);
  });
}

main().catch((err) => {
  logger.error("Failed to start server", { error: err.message });
  process.exit(1);
});
