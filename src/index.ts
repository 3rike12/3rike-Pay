import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { config } from "./config";
import { logger } from "./utils/logger";
import webhooksRouter from "./routes/webhooks";
import notifyRouter from "./routes/notify";

const app = express();

// ============================================
// Middleware
// ============================================
app.use(helmet());
app.use(cors());
app.use(morgan("combined"));

// Parse JSON for most routes
app.use(express.json({ limit: "10mb" }));

// Raw body for AutoRamp webhook signature verification
app.use("/webhook/autoramp", express.raw({ type: "application/json" }));

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
// Routes
// ============================================
app.use("/webhook", webhooksRouter);
app.use("/webhook/notify", notifyRouter);

// ============================================
// 404 handler
// ============================================
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
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
