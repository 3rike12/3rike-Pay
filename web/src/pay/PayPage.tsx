import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnect, useConnection, useDisconnect, useSendTransaction, useSwitchChain } from "wagmi";

type Token = { symbol: string; chain: string; label: string };
type PayData = {
  reference: string; merchant: string; amount: number; currency: string; status: string;
  expiresAt?: string; items?: Array<{ name: string; qty: number; unitPrice: number }>;
  merchantInfo?: Record<string, string>; issuedAt?: string; tokens?: Token[]; enabled: boolean;
  network: string; walletChainIds?: number[]; quote?: any; receipt?: any;
};

const chainIds: Record<string, number> = {
  eth: 1, base: 8453, op: 10, pol: 137, arb: 42161, avax: 43114, gnosis: 100,
  "base-sepolia": 84532, "arb-sepolia": 421614, "ethereum-sepolia": 11155111, bsc: 97, aurora: 1313161555,
};
const chainNames: Record<string, string> = { eth: "Ethereum", base: "Base", op: "Optimism", pol: "Polygon", arb: "Arbitrum", avax: "Avalanche", gnosis: "Gnosis", stellar: "Stellar" };
const stellarAddress = /^G[A-Z2-7]{55}$/;
const tidepoolChainIds: Record<string, number> = { eth: 11155111, base: 84532, arb: 421614, bsc: 97, aurora: 1313161555 };
const tokenNames: Record<string, string> = { USDC: "USD Coin", USDT: "Tether USD", ETH: "Ether", XLM: "Stellar Lumens" };
const priorities = ["base", "arb", "op", "eth", "pol", "avax", "gnosis", "stellar"];
const api = (ref: string) => `${(window as any).PAY_CONFIG?.apiBase || ""}/api/pay/${encodeURIComponent(ref)}`;
const money = (amount: number, currency: string) => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(amount); }
  catch { return `${currency} ${Number(amount).toLocaleString()}`; }
};
const ordered = (items: string[], priority: string[]) => [...items].sort((a, b) => (priority.indexOf(a) < 0 ? 99 : priority.indexOf(a)) - (priority.indexOf(b) < 0 ? 99 : priority.indexOf(b)));
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

export default function PayPage({ initial }: { initial: PayData }) {
  const [invoice, setInvoice] = useState(initial);
  const [selection, setSelection] = useState<{ chain: string; symbol: string } | null>(null);
  const [quote, setQuote] = useState<any>(initial.quote?.depositAddress ? initial.quote : null);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [modal, setModal] = useState<"wallet" | "paywith" | null>(null);
  const [showItems, setShowItems] = useState(false);
  const [showMerchant, setShowMerchant] = useState(false);
  const [left, setLeft] = useState(0);
  const [copyLabel, setCopyLabel] = useState("Copy address");
  const [stellarAddr, setStellarAddr] = useState("");
  const [status, setStatus] = useState(initial.status);
  const { address, connector } = useConnection();
  const { connectAsync, connectors, error: connectError } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();

  const tokens = invoice.tokens || [];
  const valid = (chain: string, symbol: string) => tokens.some((token) => token.chain === chain && token.symbol === symbol);
  const chains = useMemo(() => ordered([...new Set(tokens.map((token) => token.chain))], priorities), [tokens]);
  const symbols = useMemo(() => [...new Set(tokens.map((token) => token.symbol))], [tokens]);
  const active = !["paid", "expired", "cancelled", "failed", "refunded"].includes(status);
  const selected = selection || (() => {
    const origin = invoice.quote?.origin;
    if (origin && valid(origin.chain, origin.symbol)) return { chain: origin.chain, symbol: origin.symbol };
    if (invoice.network === "tidepool" && valid("eth", "ETH")) return { chain: "eth", symbol: "ETH" };
    const chain = valid("base", "USDT") ? "base" : chains[0] || "";
    const symbol = valid(chain, "USDT") ? "USDT" : symbols[0] || "";
    return { chain, symbol };
  })();
  const availableConnectors = connectors;
  // Stellar has no browser-wallet flow here: the payer sends from any Stellar wallet or exchange using the address and memo,
  // and gives a Stellar address for refunds. Everyone else uses the connected EVM wallet's address.
  const isStellar = selected.chain === "stellar";
  const refundFor = isStellar ? stellarAddr.trim() || undefined : address;
  const stellarInvalid = isStellar && !!stellarAddr.trim() && !stellarAddress.test(stellarAddr.trim());

  const connectWallet = async (item: (typeof connectors)[number]) => {
    setError("");
    try {
      // Mobile browsers without an injected wallet can still expose Wagmi's
      // generic injected connector. Check it before connect() to avoid a
      // low-level undefined-provider error.
      if (item.type === "injected") {
        const provider = await item.getProvider();
        if (!provider) {
          setError("No wallet is available in this browser. Open this link in your wallet app or choose WalletConnect.");
          return;
        }
      }
      await connectAsync({ connector: item });
      setModal(null);
    } catch (cause: any) {
      console.error("Wagmi wallet connection failed", cause);
      setError(cause?.shortMessage || cause?.message || "Could not connect wallet. Open this link in your wallet app or try WalletConnect.");
    }
  };

  const refreshQuote = useCallback(async (symbol: string, chain: string, refundTo?: string) => {
    if (invoice.network === "tidepool" && !refundTo) { setQuote(null); return; }
    setBusy(true); setError(""); setQuote(null);
    try {
      const response = await fetch(`${api(invoice.reference)}/quote`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, chain, refundTo }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not prepare this payment.");
      setQuote(body.quote);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not prepare this payment."); }
    finally { setBusy(false); }
  }, [invoice.network, invoice.reference]);

  useEffect(() => {
    if (!invoice.enabled || !selected.chain || !selected.symbol || !active) return;
    if (isStellar && (!stellarAddr.trim() || stellarInvalid)) { setQuote(null); return; }
    if (invoice.network === "tidepool" && !isStellar && !address) { setQuote(null); return; }
    if (quote && quote.origin?.chain === selected.chain && quote.origin?.symbol === selected.symbol && (isStellar ? quote.refundTo === refundFor : (quote.refundTo || undefined) === (refundFor || undefined))) return;
    const timer = window.setTimeout(() => {
      void refreshQuote(selected.symbol, selected.chain, refundFor);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [selected.chain, selected.symbol, refundFor, isStellar, stellarAddr, stellarInvalid, address, invoice.enabled, invoice.network, active, quote, refreshQuote]);

  useEffect(() => {
    if (!invoice.expiresAt || !active) return;
    const update = () => setLeft(Math.max(0, Math.floor((new Date(invoice.expiresAt!).getTime() - Date.now()) / 1000)));
    update(); const id = window.setInterval(update, 1000); return () => window.clearInterval(id);
  }, [invoice.expiresAt, active]);

  const poll = useCallback(async () => {
    try {
      const response = await fetch(`${api(invoice.reference)}/status`);
      const result = await response.json();
      if (result.state === "processing") setStatus("processing");
      if (["paid", "refunded", "failed", "expired"].includes(result.state)) {
        setStatus(result.state);
        if (result.state === "paid") {
          const view = await fetch(api(invoice.reference)).then((r) => r.json());
          setInvoice(view);
        }
      }
    } catch { /* next poll retries */ }
  }, [invoice.reference]);

  useEffect(() => {
    if (!locked) return;
    const id = window.setInterval(() => void poll(), 4000);
    return () => window.clearInterval(id);
  }, [locked, poll]);

  const pay = async () => {
    if (!quote?.origin || !address) return;
    setBusy(true); setError(""); setMessage("Confirm in your wallet…");
    const origin = quote.origin;
    const chainId = Number(origin.chainId || (invoice.network === "tidepool" ? tidepoolChainIds[origin.chain] : chainIds[origin.chain]) || chainIds[selected.chain]);
    try {
      await switchChainAsync({ chainId });
      const amount = BigInt(quote.amountIn);
      const hash = await sendTransactionAsync({
        chainId,
        to: origin.tokenAddress || quote.depositAddress,
        value: origin.tokenAddress ? 0n : amount,
        ...(origin.tokenAddress ? { data: `0xa9059cbb${quote.depositAddress.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}` as `0x${string}` } : {}),
      });
      setLocked(true); setMessage("Payment sent. Waiting for confirmation…");
      void fetch(`${api(invoice.reference)}/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ txHash: hash }) });
      void poll();
    } catch (cause: any) {
      setMessage("");
      setError(cause?.code === 4001 || cause?.cause?.code === 4001 ? "You cancelled the payment in your wallet." : cause?.shortMessage || cause?.message || "The wallet could not send the payment.");
    } finally { setBusy(false); }
  };

  const statusStep = status === "paid" ? 3 : status === "processing" ? 2 : 1;
  const displayChain = (chain: string) => invoice.network === "tidepool" && chain === "eth" ? "Ethereum Sepolia" : invoice.network === "tidepool" && chain === "base" ? "Base Sepolia" : invoice.network === "tidepool" && chain === "arb" ? "Arbitrum Sepolia" : chainNames[chain] || chain;
  const isTidepoolNeedsWallet = invoice.network === "tidepool" && !isStellar && !address;
  const amountLabel = quote ? `${quote.amountInFormatted || quote.amountIn} ${quote.origin?.symbol}` : "";
  const merchantInfo = invoice.merchantInfo || {};
  const countryName = merchantInfo.country ? (() => { try { return new Intl.DisplayNames(undefined, { type: "region" }).of(merchantInfo.country.toUpperCase()) || merchantInfo.country; } catch { return merchantInfo.country; } })() : "";

  return <main>
    {status === "refunded" && <div className="banner bad">The swap did not complete and your payment was refunded to the sending address.</div>}
    {status === "expired" && <div className="banner bad">This invoice has expired. Ask the merchant for a new one.</div>}
    {status === "failed" && <div className="banner bad">This payment did not go through.</div>}
    <section className="card hero">
      <div className="merchant-row"><span className="avatar">{invoice.merchant?.trim().charAt(0).toUpperCase() || "·"}</span><div><div className="mname">{invoice.merchant}</div><div className="sub">Invoice{countryName ? ` · ${countryName}` : ""}</div></div>{left > 0 && ["sent", "pending_payment"].includes(status) && <span className={`pill${left <= 300 ? " urgent" : ""}`}>Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span>}</div>
      <div className="amount">{money(invoice.amount, invoice.currency)}</div>
      <div className="toggles">{!!invoice.items?.length && <button className="items-toggle" aria-expanded={showItems} onClick={() => setShowItems(!showItems)}>{invoice.items.length} {invoice.items.length === 1 ? "item" : "items"} {showItems ? "▴" : "▾"}</button>}{Object.values(merchantInfo).some(Boolean) && <button className="items-toggle" aria-expanded={showMerchant} onClick={() => setShowMerchant(!showMerchant)}>Merchant details {showMerchant ? "▴" : "▾"}</button>}</div>
      {showItems && <ul className="items">{invoice.items?.map((item, i) => <li key={i}><span>{item.qty} × {item.name}</span><span>{money(item.qty * item.unitPrice, invoice.currency)}</span></li>)}</ul>}
      {showMerchant && <dl className="items kv">{merchantInfo.name && <div className="r"><dt>Business</dt><dd>{merchantInfo.name}</dd></div>}{merchantInfo.registrationNumber && <div className="r"><dt>Registration no.</dt><dd>{merchantInfo.registrationNumber}</dd></div>}{merchantInfo.phone && <div className="r"><dt>Phone</dt><dd>{merchantInfo.phone}</dd></div>}{merchantInfo.email && <div className="r"><dt>Email</dt><dd>{merchantInfo.email}</dd></div>}{countryName && <div className="r"><dt>Country</dt><dd>{countryName}</dd></div>}</dl>}
    </section>

    {status === "paid" && <section className="card receipt"><div className="check">✓</div><h2>Payment received</h2><p className="rsub">{money(invoice.amount, invoice.currency)} to {invoice.merchant}</p><dl className="rows">{invoice.receipt?.paidWith && <div className="r"><dt>Paid with</dt><dd>{invoice.receipt.paidWith}</dd></div>}{invoice.receipt?.paidAt && <div className="r"><dt>Date</dt><dd>{new Date(invoice.receipt.paidAt).toLocaleString()}</dd></div>}{invoice.receipt?.txUrl && <div className="r"><dt>Transaction</dt><dd><a href={invoice.receipt.txUrl} target="_blank" rel="noreferrer">View on explorer ↗</a></dd></div>}</dl><p className="note">The merchant has been notified.</p></section>}

    {active && <section className="card">
      {!invoice.enabled ? <div className="hint">Crypto payments are not enabled on this server.</div> : !tokens.length ? <div className="hint">Payment options are unavailable right now. Please try again shortly.</div> : <>
        <div className="field-label">Pay with</div><button className="select" onClick={() => setModal("paywith")}><span className="ico">{selected.symbol?.slice(0, 1)}</span><span className="sel-text"><b>{selected.symbol}</b><small>on {displayChain(selected.chain)}</small></span><span className="chev">▼</span></button>
        <div className="you-pay" aria-live="polite">{busy ? <><div className="lbl">Preparing your payment…</div><div className="skeleton w1" /></> : quote ? <><div className="lbl">You pay</div><div className="big">{amountLabel}</div><div className="lbl">on {displayChain(quote.origin?.chain)} · invoice total {money(invoice.amount, invoice.currency)}</div></> : isTidepoolNeedsWallet ? <div className="lbl">Connect your wallet to prepare this payment.</div> : isStellar && !stellarAddr.trim() ? <div className="lbl">Enter your Stellar address below to get the deposit details.</div> : error ? <div className="lbl">We couldn’t prepare this payment.</div> : <div className="lbl">Preparing your payment…</div>}</div>
        {isStellar && <div className="field"><div className="field-label">Your Stellar address (required, a failed payment is refunded here)</div><input className="select" style={{ width: "100%", fontFamily: "monospace" }} placeholder="G…" value={stellarAddr} onChange={(event) => setStellarAddr(event.target.value)} spellCheck={false} autoComplete="off" />{stellarInvalid && <div className="hint">That isn’t a valid Stellar address. It starts with G and is 56 characters.</div>}<div className="hint">Send from this same account. Include the memo shown below, or the payment cannot be matched.</div></div>}
        {error && <div id="error" role="alert">{error}</div>}
        {message && <div className="msg" role="status">{message}</div>}
        {isTidepoolNeedsWallet ? <button className="cta" onClick={() => setModal("wallet")} disabled={!availableConnectors.length}>Connect wallet</button> : quote && !locked && !isStellar && <button className="cta" onClick={() => address ? void pay() : setModal("wallet")} disabled={busy}>{busy ? "Confirm in your wallet…" : address ? `Pay ${amountLabel}` : "Connect wallet"}</button>}
        {address && <div className="wallet-line"><span className="live" />{connector?.name} · {short(address)}<button className="link" onClick={() => void disconnectAsync()}>Disconnect</button></div>}
        {!availableConnectors.length && <div className="hint">No wallet detected. Open this page inside your wallet app or use the deposit details below.</div>}
        {quote && <><ol className="stepper">{["Waiting for payment", "Converting", "Paid"].map((step, i) => <li className={statusStep > i + 1 ? "on" : statusStep === i + 1 ? "now" : ""} key={step}><span className="sdot" />{step}</li>)}</ol><details open={isStellar}><summary>{isStellar ? "Send from your Stellar wallet or an exchange" : "Pay from an exchange or another wallet"}</summary>{quote.qr && <img className="qr" src={quote.qr} alt="Deposit address QR code" />}<span className="lbl2">Send exactly <b>{amountLabel} on {displayChain(quote.origin?.chain)}</b> to</span><div className="addr">{quote.depositAddress}</div><button className="small-btn" onClick={() => navigator.clipboard.writeText(quote.depositAddress).then(() => { setCopyLabel("Copied"); window.setTimeout(() => setCopyLabel("Copy address"), 1500); })}>{copyLabel}</button>{quote.depositMemo && <div><span className="lbl2">Memo (required)</span><div className="addr">{quote.depositMemo}</div></div>}<div className="warn">Only send on the {displayChain(quote.origin?.chain)} network. Sending on another network can lose your funds.</div><div className="muted">{quote.refundTo ? `If the swap fails, your funds return to ${short(quote.refundTo)}.` : "If the swap fails, contact the merchant to arrange a refund."}</div></details></>}
      </>}
    </section>}

    <div id="error" role="alert">{status === "cancelled" ? "This invoice was cancelled." : ""}</div>
    <footer>Payments routed by NEAR Intents · 3rike Pay</footer>

    {modal && <div className="backdrop" role="presentation" onClick={() => setModal(null)}><div className="sheet" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><div className="sheet-head"><h2>{modal === "wallet" ? "Connect a wallet" : "Pay with"}</h2><button className="x" onClick={() => setModal(null)} aria-label="Close">×</button></div>
      {modal === "wallet" ? <div className="list">{error && <div className="msg bad" role="alert">{error}</div>}{availableConnectors.map((item) => <button className="item" key={item.uid} onClick={() => void connectWallet(item)}><span className="wicon" /><span className="t"><b>{item.name}</b><small>{item.type === "walletConnect" ? "Mobile and other wallets" : "Detected in this browser"}</small></span></button>)}{connectError && <div className="msg bad">{connectError.message}</div>}</div> : <><div className="field-label">Network</div><div className="scroll-row">{chains.map((chain) => <button className="net" aria-checked={chain === selected.chain} key={chain} onClick={() => setSelection({ ...selected, chain })}>{displayChain(chain)}</button>)}</div><div className="field-label">Token on {displayChain(selected.chain)}</div><div className="list">{ordered(symbols, ["USDC", "USDT", "ETH"]).map((symbol) => { const ok = valid(selected.chain, symbol); return <button className="item" disabled={!ok} aria-checked={ok && symbol === selected.symbol} key={symbol} onClick={() => { setSelection({ chain: selected.chain, symbol }); setModal(null); }}><span className="ico">{symbol.slice(0, 1)}</span><span className="t"><b>{symbol}</b><small>{ok ? tokenNames[symbol] || symbol : `Not available on ${displayChain(selected.chain)}`}</small></span></button>; })}</div></>}
    </div></div>}
  </main>;
}
