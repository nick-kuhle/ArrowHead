"use client";

import {useCallback, useEffect, useRef, useState} from "react";
import {Button, Card, EmptyState, Field, Icon, Pill, Stat, Toggle} from "./ui";
import {ago, shortHash} from "@/lib/format";
import {withChain} from "@/lib/chain";
import {addressUrl} from "@/lib/explorer";

/* ────────────────────────────────────────────────────────────────────────
   CoW Protocol operations panel.

   Talks to the bot through the server-side bridge (`/api/bot/cow*`) so the
   mutating endpoints carry the bot's auth token without it ever reaching the
   browser. Polled on a light loop; mutations re-read immediately.

   Wire shapes (see bot/crates/mev-bot/src/api.rs):

     GET  /api/cow          → {enabled, error, pollCount, lastOkMs, snapshotAgeMs,
                               snapshot:{orderCount, orders:[{owner, sellToken,
                               buyToken, sellAmount, remainingSellAmount,
                               buyAmount, minimumBuyAmount, partiallyFillable}]},
                               trader:{enabled, baseUrl, owner, settlement,
                               vaultRelayer, open, places, cancels, fills,
                               lastPlaceAtMs, lastActionError, lastActionErrorAtMs}}
     GET  /api/cow/orders   → {enabled, owner, places, cancels, fills, open,
                               history:[{uid, chainId, sellToken, buyToken,
                               sellAmount, buyAmount, feeAmount, validTo, kind,
                               partiallyFillable, receiver, appData, quoteId,
                               status, executedSellAmount, executedBuyAmount,
                               executedFeeAmount, invalidated, reason, placedBy,
                               createdAtMs, updatedAtMs, filledAtMs}]}
     POST /api/cow/order    → {sellToken, buyToken, kind, sellAmount, buyAmount,
                               feeAmount?, validTo?, partiallyFillable?, fullAppData?}
     POST /api/cow/cancel   → {uid}
   ──────────────────────────────────────────────────────────────────────── */

interface CowTrader {
  enabled?: boolean;
  error?: string | null;
  baseUrl?: string;
  owner?: string;
  settlement?: string;
  vaultRelayer?: string;
  open?: number;
  places?: number;
  cancels?: number;
  fills?: number;
  lastPlaceAtMs?: number;
  lastActionError?: string | null;
  lastActionErrorAtMs?: number;
}

interface BookOrder {
  uid?: string;
  owner?: string;
  sellToken?: string;
  buyToken?: string;
  sellAmount?: string;
  remainingSellAmount?: string;
  buyAmount?: string;
  minimumBuyAmount?: string;
  partiallyFillable?: boolean;
}

interface CowState {
  ok: boolean;
  enabled: boolean;
  error?: string | null;
  pollCount?: number;
  lastOkMs?: number;
  snapshotAgeMs?: number;
  snapshot?: {orderCount?: number; orders?: BookOrder[]; baseUrl?: string; fetchedAtMs?: number};
  trader?: CowTrader;
}

interface OrderHistoryRow {
  uid: string;
  chainId?: number;
  sellToken?: string;
  buyToken?: string;
  sellAmount?: string;
  buyAmount?: string;
  feeAmount?: string;
  validTo?: number;
  kind?: string;
  status?: string;
  executedSellAmount?: string;
  executedBuyAmount?: string;
  invalidated?: boolean;
  reason?: string;
  placedBy?: string;
  createdAtMs?: number;
  filledAtMs?: number;
}

interface OrdersState {
  ok?: boolean;
  enabled?: boolean;
  owner?: string;
  places?: number;
  cancels?: number;
  fills?: number;
  open?: number;
  lastActionError?: string | null;
  lastActionErrorAtMs?: number;
  history?: OrderHistoryRow[];
}

const POLL_MS = 5000;
const TOKEN_RE = /^0x[0-9a-fA-F]{40}$/;
const AMT_RE = /^\d+$/;

function compactAmount(amount?: string): string {
  if (!amount) return "—";
  const n = amount.replace(/^0+(?=\d)/, "");
  if (n.length <= 12) return Number(n).toLocaleString("en-US");
  return `${n.slice(0, 9)}…${n.slice(-4)}`;
}

function statusTone(status: string | undefined): "pos" | "neg" | "warn" | "accent" | "info" | "neutral" {
  switch (status) {
    case "open":
    case "pending":
      return "accent";
    case "filled":
      return "pos";
    case "cancelled":
    case "expired":
    case "invalidated":
      return "neutral";
    case "failed":
    case "unfillable":
      return "neg";
    default:
      return "info";
  }
}

export default function CowPanel({chainId, chainSlug = null}: {chainId?: number; chainSlug?: string | null}) {
  const [cow, setCow] = useState<CowState | null>(null);
  const [orders, setOrders] = useState<OrdersState | null>(null);
  const [down, setDown] = useState(false);

  const [form, setForm] = useState({
    sellToken: "",
    buyToken: "",
    kind: "sell",
    sellAmount: "",
    buyAmount: "",
    feeAmount: "",
    validToMin: "",
    partiallyFillable: false,
  });
  const [placing, setPlacing] = useState(false);
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [msg, setMsg] = useState<{tone: "success" | "danger" | "warn"; text: string} | null>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const get = async <T,>(p: string, fallback: T): Promise<T> => {
      try {
        const r = await fetch(withChain(`/api/bot/${p}`, chainSlug), {cache: "no-store"});
        if (!r.ok) return fallback;
        return (await r.json()) as T;
      } catch {
        return fallback;
      }
    };
    const [c, o] = await Promise.all([
      get<CowState | null>("/api/cow", null),
      get<OrdersState | null>("/api/cow/orders", null),
    ]);
    setDown(c === null && o === null);
    if (c) setCow((prev) => keepIfSame(prev, c));
    if (o) setOrders((prev) => keepIfSame(prev, o));
  }, [chainSlug]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const flash = (tone: "success" | "danger" | "warn", text: string): void => {
    if (msgTimer.current) clearTimeout(msgTimer.current);
    setMsg({tone, text});
    msgTimer.current = setTimeout(() => setMsg(null), 8000);
  };

  const place = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setMsg(null);
    const sellToken = form.sellToken.trim();
    const buyToken = form.buyToken.trim();
    const kind = form.kind === "buy" ? "buy" : "sell";
    if (!TOKEN_RE.test(sellToken) || !TOKEN_RE.test(buyToken)) {
      flash("danger", "Both tokens must be 0x… addresses (40 hex chars).");
      return;
    }
    if (sellToken.toLowerCase() === buyToken.toLowerCase()) {
      flash("danger", "sellToken and buyToken must differ.");
      return;
    }
    if (!AMT_RE.test(form.sellAmount) || !AMT_RE.test(form.buyAmount)) {
      flash("danger", "sellAmount and buyAmount must be positive integers (raw token units).");
      return;
    }
    const body: Record<string, unknown> = {
      sellToken,
      buyToken,
      kind,
      sellAmount: form.sellAmount,
      buyAmount: form.buyAmount,
      partiallyFillable: form.partiallyFillable,
    };
    if (form.feeAmount) body.feeAmount = form.feeAmount.trim();
    if (form.validToMin && Number(form.validToMin) > 0) {
      body.validTo = Math.floor(Date.now() / 1000) + Math.round(Number(form.validToMin) * 60);
    }
    setPlacing(true);
    try {
      const r = await fetch(withChain("/api/bot/cow/order", chainSlug), {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(body),
      });
      const data = (await r.json().catch(() => ({}))) as {uid?: string; status?: string; error?: string};
      if (!r.ok || !data.uid) {
        flash("danger", `Place failed${data.error ? `: ${data.error}` : ` (HTTP ${r.status})`}`);
      } else {
        flash("success", `Order placed · ${shortHash(data.uid, 8)}${data.status ? ` · ${data.status}` : ""}`);
        setForm((f) => ({...f, feeAmount: "", validToMin: ""}));
      }
    } catch {
      flash("danger", "Place failed — network error.");
    } finally {
      setPlacing(false);
      load();
    }
  };

  const cancel = async (uid: string): Promise<void> => {
    setBusyUid(uid);
    try {
      const r = await fetch(withChain("/api/bot/cow/cancel", chainSlug), {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({uid}),
      });
      const data = (await r.json().catch(() => ({}))) as {ok?: boolean; error?: string};
      if (!r.ok || data.ok !== true) {
        flash("danger", `Cancel failed${data.error ? `: ${data.error}` : ` (HTTP ${r.status})`}`);
      } else {
        flash("success", `Cancelled ${shortHash(uid, 8)} — solver order invalidated.`);
      }
    } catch {
      flash("danger", "Cancel failed — network error.");
    } finally {
      setBusyUid(null);
      load();
    }
  };

  const trader: CowTrader | undefined = cow?.trader;
  const trailerDisabled = Boolean(cow) && Boolean(cow?.ok) && Boolean(cow?.enabled) && trader?.enabled !== true;
  const feedDisabled = Boolean(cow) && Boolean(cow?.ok) && cow?.enabled !== true;
  const openRows = (orders?.history ?? []).filter((r) => r.status === "open");
  const snapshot = cow?.snapshot;
  const feedLabel = snapshot?.baseUrl ? snapshot.baseUrl.replace(/^https?:\/\//, "") : "—";

  return (
    <div className="grid gap-3" data-testid="cow-panel">
      {down && (
        <div className="rounded-xl border border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-3 text-[13px] text-[var(--danger)]" role="status">
          CoW endpoints unreachable — the bot is offline (HTTP 503 from the proxy). Nothing below is invented while it is down.
        </div>
      )}
      {(trailerDisabled || feedDisabled) && !down && (
        <div className="rounded-xl border border-[var(--warn)] bg-[var(--warn-soft)] px-4 py-3 text-[13px] text-[var(--warn)]" role="status">
          {feedDisabled ? "CoW orderbook feed disabled — set COW_ORDERBOOK_ENABLED=true on the bot. " : ""}
          {trailerDisabled ? "CoW order placement disabled — set COW_TRADER_ENABLED=true on the bot." : ""}
        </div>
      )}

      {msg && (
        <div
          className="rounded-xl border px-4 py-3 text-[13px] font-medium"
          style={{borderColor: `var(--${msg.tone})`, background: `var(--${msg.tone}-soft)`, color: `var(--${msg.tone})`}}
          role="status"
        >
          {msg.text}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="open orders" value={trailerDisabled ? "—" : String(orders?.open ?? openRows.length ?? 0)} icon="swap" />
        <Stat label="placed" value={trailerDisabled ? "—" : String(trader?.places ?? 0)} tone="accent" />
        <Stat label="filled" value={trailerDisabled ? "—" : String(trader?.fills ?? 0)} tone="pos" />
        <Stat label="cancelled" value={trailerDisabled ? "—" : String(trader?.cancels ?? 0)} />
        <Stat label="last action" value={trader?.lastPlaceAtMs ? ago(trader.lastPlaceAtMs) : "—"} />
        <Stat
          label="solver"
          value={trader?.owner ? shortHash(trader.owner, 6) : "—"}
          sub={trader?.baseUrl ? trader.baseUrl.replace(/^https?:\/\//, "") : undefined}
          live={!trailerDisabled && Boolean(trader?.owner)}
        />
      </div>

      {trader?.lastActionError ? (
        <div className="rounded-xl border border-[var(--warn)] bg-[var(--warn-soft)] px-4 py-2.5 text-[12.5px]" style={{color: "var(--warn)"}}>
          last action error{trader.lastActionErrorAtMs ? ` (${ago(trader.lastActionErrorAtMs)})` : ""}: {String(trader.lastActionError)}
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="min-w-0">
          <div className="panel-head !border-0 px-4 pt-4 pb-2">my orders</div>
          <div className="max-h-[460px] overflow-y-auto px-2 pb-2">
            <table className="grid mt-1">
              <thead>
                <tr>
                  <th>uid</th>
                  <th>pair</th>
                  <th>kind</th>
                  <th style={{textAlign: "right"}}>sell</th>
                  <th style={{textAlign: "right"}}>buy</th>
                  <th>status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(orders?.history ?? []).map((r) => {
                  const isOpen = r.status === "open";
                  return (
                    <tr key={r.uid}>
                      <td className="mono muted">{shortHash(r.uid, 8)}</td>
                      <td className="mono">
                        {shortHash(r.sellToken ?? "", 3)}→{shortHash(r.buyToken ?? "", 3)}
                      </td>
                      <td>{r.kind ?? "—"}</td>
                      <td style={{textAlign: "right"}} title={r.sellAmount}>{compactAmount(r.sellAmount)}</td>
                      <td style={{textAlign: "right"}} title={r.buyAmount}>{compactAmount(r.buyAmount)}</td>
                      <td>
                        <Pill tone={statusTone(r.status)} soft>{r.status ?? "—"}</Pill>
                      </td>
                      <td style={{textAlign: "right"}}>
                        {isOpen ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            tone="danger"
                            disabled={busyUid === r.uid}
                            onClick={() => cancel(r.uid)}
                            title="invalidate this order on the solver (vault relayer bails out)"
                          >
                            {busyUid === r.uid ? <Icon name="refresh" size={12} className="animate-spin" /> : "cancel"}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
                {!orders?.history?.length && (
                  <tr>
                    <td colSpan={7} className="text-center py-8 text-[var(--muted)]">
                      no orders placed yet — use the form to place your first CoW order
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="min-w-0">
          <div className="panel-head !border-0 px-4 pt-4 pb-2">place order</div>
          <form onSubmit={place} className="grid grid-cols-1 gap-3 px-4 pb-4 sm:grid-cols-2">
            <Field label="sell token" hint="address of the token you sell">
              <input className="ah-input mono" placeholder="0x…" value={form.sellToken} onChange={(e) => setForm({...form, sellToken: e.target.value})} spellCheck={false} />
            </Field>
            <Field label="buy token" hint="address of the token you buy">
              <input className="ah-input mono" placeholder="0x…" value={form.buyToken} onChange={(e) => setForm({...form, buyToken: e.target.value})} spellCheck={false} />
            </Field>
            <Field label="kind">
              <select className="ah-input" value={form.kind} onChange={(e) => setForm({...form, kind: e.target.value})}>
                <option value="sell">sell — exact sell amount</option>
                <option value="buy">buy — exact buy amount</option>
              </select>
            </Field>
            <div className="flex items-end justify-between gap-2 sm:col-span-2">
              <Toggle checked={form.partiallyFillable} onChange={(v) => setForm({...form, partiallyFillable: v})} label="partially fillable" tone="success" />
              <Toggle checked={Boolean(form.feeAmount)} onChange={(v) => !v && setForm({...form, feeAmount: ""})} label="override fee" />
            </div>
            <Field label="sell amount" hint="raw units (incl. decimals)">
              <input className="ah-input mono" placeholder="1000000000000000000" value={form.sellAmount} onChange={(e) => setForm({...form, sellAmount: e.target.value})} spellCheck={false} />
            </Field>
            <Field label="buy amount" hint="raw units (incl. decimals)">
              <input className="ah-input mono" placeholder="2000000000000000000" value={form.buyAmount} onChange={(e) => setForm({...form, buyAmount: e.target.value})} spellCheck={false} />
            </Field>
            {form.feeAmount ? (
              <Field label="fee amount" hint="optional override — omit to quote">
                <input className="ah-input mono" placeholder="raw units" value={form.feeAmount} onChange={(e) => setForm({...form, feeAmount: e.target.value})} spellCheck={false} />
              </Field>
            ) : null}
            <Field label="valid for (minutes)" hint="empty = bot default cap (COW_TRADER_MAX_VALIDITY_SECS)">
              <input className="ah-input mono" type="number" min="1" placeholder="e.g. 30" value={form.validToMin} onChange={(e) => setForm({...form, validToMin: e.target.value})} />
            </Field>
            <div className="sm:col-span-2">
              <Button type="submit" variant="primary" size="md" disabled={placing} className="w-full sm:w-auto">
                {placing ? <Icon name="refresh" size={14} className="animate-spin" /> : <Icon name="send" size={14} />}
                {placing ? "quoting + signing…" : "Quote, sign & place"}
              </Button>
              <span className="ml-2 text-[11.5px] text-[var(--muted)]">signed EIP-712 · verified uid · POSTed to the CoW Order Book API</span>
            </div>
          </form>
        </Card>
      </div>

      <Card>
        <div className="panel-head !border-0 font-semibold text-[13px]">
          <span>orderbook feed</span>
          <span className="muted">
            {feedLabel} · {snapshot ? `${snapshot.orderCount ?? 0} orders` : "—"}
            {cow?.snapshotAgeMs != null ? ` · ${ago(Date.now() - cow.snapshotAgeMs)} ago` : ""}
          </span>
        </div>
        {snapshot?.orders?.length ? (
          <div className="max-h-[320px] overflow-y-auto">
            <table className="grid">
              <thead>
                <tr>
                  <th>owner</th>
                  <th style={{textAlign: "right"}}>sell amount</th>
                  <th style={{textAlign: "right"}}>remaining</th>
                  <th style={{textAlign: "right"}}>buy amount</th>
                  <th>fillable</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.orders.map((o, i) => (
                  <tr key={o.uid ?? i}>
                    <td className="mono">{shortHash(o.owner ?? "", 6)}</td>
                    <td style={{textAlign: "right"}} title={o.sellAmount}>{compactAmount(o.sellAmount)}</td>
                    <td style={{textAlign: "right"}} title={o.remainingSellAmount}>
                      <span className={o.remainingSellAmount && o.sellAmount && BigInt(o.remainingSellAmount) < BigInt(o.sellAmount) ? "text-[var(--warn)]" : undefined}>
                        {compactAmount(o.remainingSellAmount)}
                      </span>
                    </td>
                    <td style={{textAlign: "right"}} title={o.buyAmount}>{compactAmount(o.buyAmount)}</td>
                    <td>
                      <Pill tone={o.partiallyFillable ? "accent" : "neutral"} soft>{o.partiallyFillable ? "partial" : "fill-or-kill"}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>
            {feedDisabled ? "feed disabled on this chain" : "orderbook empty — no open CoW orders on the book right now"}
          </EmptyState>
        )}
        <div className="flex flex-wrap items-center gap-4 border-t border-[var(--line-soft)] px-4 py-2 text-[11.5px] text-[var(--muted)]">
          {trader?.settlement ? (
            <span className="truncate">
              settlement{" "}
              <a className="mono" href={addressUrl(chainId, trader.settlement) ?? undefined} target="_blank" rel="noreferrer" title={trader.settlement}>
                {shortHash(trader.settlement, 6)}
              </a>
            </span>
          ) : null}
          {trader?.vaultRelayer ? (
            <span className="truncate">
              vault relayer{" "}
              <a className="mono" href={addressUrl(chainId, trader.vaultRelayer) ?? undefined} target="_blank" rel="noreferrer" title={trader.vaultRelayer}>
                {shortHash(trader.vaultRelayer, 6)}
              </a>
            </span>
          ) : null}
          <span className="truncate">{cow?.error ? String(cow.error) : `feed ok · ${cow?.pollCount ?? 0} polls`}</span>
        </div>
      </Card>
    </div>
  );
}

function keepIfSame<T>(prev: T, next: T): T {
  try {
    return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
  } catch {
    return next;
  }
}