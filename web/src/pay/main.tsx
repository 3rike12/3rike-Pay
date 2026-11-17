import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createConfig, http, WagmiProvider } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import { defineChain, type Chain } from "viem";
import PayPage from "./PayPage";
import "@/styles/pay.css";

type PayData = {
  merchant: string; amount: number; currency: string; status: string; enabled: boolean; network: string;
  reference: string;
  walletChainIds?: number[];
  walletConnectProjectId?: string | null;
  [key: string]: any;
};

const networkInfo: Record<number, [string, string, string, string]> = {
  1: ["Ethereum", "ETH", "https://cloudflare-eth.com", "https://etherscan.io"],
  10: ["Optimism", "ETH", "https://mainnet.optimism.io", "https://optimistic.etherscan.io"],
  97: ["BNB Smart Chain Testnet", "tBNB", "https://bsc-testnet-dataseed.bnbchain.org", "https://testnet.bscscan.com"],
  100: ["Gnosis", "xDAI", "https://rpc.gnosischain.com", "https://gnosisscan.io"],
  137: ["Polygon", "POL", "https://polygon-rpc.com", "https://polygonscan.com"],
  8453: ["Base", "ETH", "https://mainnet.base.org", "https://basescan.org"],
  84532: ["Base Sepolia", "ETH", "https://sepolia.base.org", "https://sepolia.basescan.org"],
  42161: ["Arbitrum One", "ETH", "https://arb1.arbitrum.io/rpc", "https://arbiscan.io"],
  421614: ["Arbitrum Sepolia", "ETH", "https://sepolia-rollup.arbitrum.io/rpc", "https://sepolia.arbiscan.io"],
  43114: ["Avalanche", "AVAX", "https://api.avax.network/ext/bc/C/rpc", "https://snowtrace.io"],
  11155111: ["Ethereum Sepolia", "ETH", "https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.etherscan.io"],
  1313161555: ["Aurora Testnet", "ETH", "https://testnet.aurora.dev", "https://explorer.testnet.aurora.dev"],
};

function wagmiConfig(data: PayData) {
  const chainIds = data.walletChainIds?.length ? data.walletChainIds : [8453, 1, 10, 137, 42161, 43114, 100];
  const chains: Chain[] = chainIds.flatMap((id): Chain[] => {
    const info = networkInfo[id];
    if (!info) return [];
    const [name, symbol, rpc, explorer] = info;
    return [defineChain({
      id, name,
      nativeCurrency: { name: symbol, symbol, decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
      blockExplorers: { default: { name: `${name} Explorer`, url: explorer } },
      testnet: [97, 84532, 421614, 11155111, 1313161555].includes(id),
    })];
  });
  if (!chains.length) throw new Error("No supported wallet networks were provided.");
  return createConfig({
    chains: chains as unknown as [Chain, ...Chain[]],
    connectors: [
      injected(),
      ...(data.walletConnectProjectId ? [walletConnect({
        projectId: data.walletConnectProjectId,
        relayUrl: "wss://relay.walletconnect.com",
        showQrModal: true,
        metadata: { name: "3rike Pay", description: "Pay an invoice", url: window.location.origin, icons: [] },
      })] : []),
    ],
    transports: Object.fromEntries(chains.map((chain) => [chain.id, http()])),
    multiInjectedProviderDiscovery: true,
  });
}

function Bootstrap() {
  const [data, setData] = useState<PayData | null>(null);
  const [error, setError] = useState("");
  const queryClient = useMemo(() => new QueryClient(), []);
  useEffect(() => {
    const reference = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
    const apiBase = (window as any).PAY_CONFIG?.apiBase || "";
    fetch(`${apiBase}/api/pay/${encodeURIComponent(reference)}`).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "We couldn't load this invoice. Please try again.");
      setData({ ...body, reference });
      document.title = `Pay ${body.merchant} · 3rike Pay`;
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "We couldn't load this invoice."));
  }, []);

  if (!data) return <main><section className="card"><div className="mname">{error || "Loading invoice…"}</div></section></main>;
  let config;
  try { config = wagmiConfig(data); }
  catch (cause) { return <main><section className="card"><div className="mname">{cause instanceof Error ? cause.message : "Wallet setup failed."}</div></section></main>; }

  return <WagmiProvider config={config}>
    <QueryClientProvider client={queryClient}>
      <PayPage initial={data} />
    </QueryClientProvider>
  </WagmiProvider>;
}

const target = document.getElementById("pay-root");
if (!target) throw new Error("Missing #pay-root element");
createRoot(target).render(<StrictMode><Bootstrap /></StrictMode>);
