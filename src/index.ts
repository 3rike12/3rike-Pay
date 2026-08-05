import express from "express";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { config } from "@/config";
import { logger } from "@/utils/logger";
import webhooksRouter from "@/api/webhooks";
import notifyRouter from "@/api/notify";
import kycRouter from "@/api/kyc";
import { generalLimiter } from "@/api/middleware/rateLimit";

const app = express();

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
app.get("/health", (_req, res) => {
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
app.use("/api/kyc", kycRouter);

// ============================================
// Serve React frontend (built output)
// ============================================
const webDist = path.join(__dirname, "../web/dist");
app.use(express.static(webDist));

// SPA fallback - serve index.html for all non-API routes
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/webhook/") || req.path === "/health") {
    return res.status(404).json({ error: "Not found" });
  }
  res.sendFile(path.join(webDist, "index.html"));
});

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
