import { config } from "@/config";
import { setStockVenue } from "@/services/stockVenue";
import { setStockCatalogueOverride } from "@/services/stocks";
import { createDemoVenue, demoStocks } from "@/services/venues/demo";
import { createZeroExVenue } from "@/services/venues/zeroEx";
import { createPrivyTradeSigner } from "@/services/privyTradeSigner";
import { prismaTradeStore } from "@/services/venues/prismaTradeStore";
import { createLogger } from "@/utils/logger";

const logger = createLogger("stock-venue-setup");

/**
 * Register the configured trading venue, if there is a complete configuration for
 * one. Anything missing leaves stocks switched off, and says why. Never throws: a
 * misconfigured venue must not stop the rest of the app from starting.
 */
export function registerConfiguredVenue(): boolean {
  const v = (config as any).stocks?.venue ?? {};
  if (!v.kind) {
    logger.info("No stock venue configured; buying and selling stocks stays off");
    return false;
  }
  if (v.kind === "demo") {
    // A pretend market for demos: nothing is traded on any chain.
    setStockVenue(createDemoVenue());
    setStockCatalogueOverride((now) => demoStocks(now));
    logger.warn("DEMO stock venue registered: trades are simulated, no real money moves");
    return true;
  }
  if (v.kind !== "0x") {
    logger.error("Unknown STOCKS_VENUE; stocks stay off", { kind: v.kind });
    return false;
  }
  const missing = [
    !v.zeroExApiKey && "STOCKS_0X_API_KEY",
    !(v.zeroExAllowedTargets?.length) && "STOCKS_0X_ALLOWED_TARGETS",
    !config.privy.enabled && "the Privy treasury wallet (PRIVY_*)",
    !config.treasury.address && "TREASURY_ADDRESS",
  ].filter(Boolean);
  if (missing.length) {
    logger.error("0x venue is not fully configured; stocks stay off", { missing });
    return false;
  }
  try {
    setStockVenue(
      createZeroExVenue({
        apiKey: v.zeroExApiKey,
        baseUrl: v.zeroExBaseUrl,
        treasury: config.treasury.address,
        usdc: config.treasury.tokenContract,
        allowedTargets: v.zeroExAllowedTargets,
        slippageBps: config.stocks.maxSlippageBps,
        maxBuyUsdcUnits: BigInt(Math.round(config.stocks.maxOrderUsd * 1.05 * 10 ** config.treasury.tokenDecimals)),
        signer: createPrivyTradeSigner({ allowedTargets: v.zeroExAllowedTargets }),
        store: prismaTradeStore,
      })
    );
    logger.info("0x stock venue registered");
    return true;
  } catch (error: any) {
    logger.error("Could not set up the 0x venue; stocks stay off", { error: error?.message });
    return false;
  }
}
