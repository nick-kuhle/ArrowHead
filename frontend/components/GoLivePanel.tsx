"use client";

import {useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode} from "react";
import {createPublicClient, createWalletClient, custom, encodeAbiParameters, formatEther, http, isAddress, parseEther, type Address} from "viem";
import {base, mainnet} from "viem/chains";
import {onChainChange, readActiveChain, withChain} from "@/lib/chain";
import {explorerName} from "@/lib/explorer";
import {useWallet} from "@/lib/wallet";
import EXECUTOR_ABI from "@/lib/MevExecutor.abi.json";
import executorCreationHex from "@/lib/MevExecutor.creation.hex";
import type {ConfigResponse, StatusResponse} from "@/lib/types";

const WETH_ABI = [
  {type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: []},
  {type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{name: "to", type: "address"}, {name: "value", type: "uint256"}], outputs: [{type: "bool"}]},
] as const;
const CHAIN_IDS: Record<string, number> = {ethereum: 1, mainnet: 1, base: 8453};
const CHAIN_LABELS: Record<string, string> = {ethereum: "Ethereum mainnet", mainnet: "Ethereum mainnet", base: "Base"};
const WETH_BY_CHAIN: Record<string, Address> = {
  ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  mainnet: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  base: "0x4200000000000000000000000000000000000006",
};
const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as Address;
const GAS_THRESHOLD_WEI = parseEther("0.005");
const STORAGE_EXECUTOR = "arrowhead.executor";

function chainKey(slug: string | null) { return (slug || "ethereum").toLowerCase(); }
function keyFor(baseKey: string, slug: string) { return `${baseKey}.${slug}`; }
function storageGet(key: string): string | null { try { return window.localStorage.getItem(key); } catch { return null; } }
function storageSet(key: string, value: string) { try { window.localStorage.setItem(key, value); } catch { /* visible in this session */ } }
function asHex(raw: string): `0x${string}` { return `0x${raw.trim().replace(/^0x/, "")}` as `0x${string}`; }
function deployData(slug: string): `0x${string}` {
  const weth = WETH_BY_CHAIN[slug] ?? WETH_BY_CHAIN.ethereum;
  const args = encodeAbiParameters([{type: "address"}, {type: "address"}], [BALANCER_VAULT, weth]);
  return `${asHex(executorCreationHex)}${args.slice(2)}` as `0x${string}`;
}
function safeWei(eth: string): bigint | null { try { return !eth.trim() || Number(eth) < 0 ? null : parseEther(eth.trim()); } catch { return null; } }
function errText(error: unknown) { return (error instanceof Error ? error.message : String(error)).split("\n")[0]; }
function shorten(value: string | null | undefined) { return value && value.length > 14 ? `${value.slice(0, 10)}…${value.slice(-4)}` : value || "—"; }

interface PreflightResponse { rpc: boolean; relay: boolean; qualification: unknown; demo?: boolean; }
interface ContractCheck { codeBytes: number | null; owner: string | null; weth: string | null; searcherAllowed: boolean | null; error: string | null; }
const emptyCheck: ContractCheck = {codeBytes: null, owner: null, weth: null, searcherAllowed: null, error: null};

export default function GoLivePanel({executor: runtimeExecutor, armed: runtimeArmed, chainId: botChainId}: {executor?: string; armed?: boolean; chainId?: number}) {
  const wallet = useWallet();
  const [slug, setSlug] = useState(() => chainKey(readActiveChain()));
  const expectedChainId = botChainId ?? CHAIN_IDS[slug] ?? 1;
  const label = CHAIN_LABELS[slug] ?? slug;
  const weth = WETH_BY_CHAIN[slug] ?? WETH_BY_CHAIN.ethereum;
  const publicClient = useMemo(() => createPublicClient({chain: slug === "base" ? base : mainnet, transport: http(withChain("/api/eth", slug))}), [slug]);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [botConfig, setBotConfig] = useState<ConfigResponse | null>(null);
  const [executorAddress, setExecutorAddress] = useState("");
  const [executorCheck, setExecutorCheck] = useState<ContractCheck>(emptyCheck);
  const [searcherInput, setSearcherInput] = useState("");
  const [fundAmount, setFundAmount] = useState("0.10");
  const [soakHours, setSoakHours] = useState("0");
  const [preflight, setPreflight] = useState({rpc: false, bot: false, relay: false, qualification: false});
  const [deploying, setDeploying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{tone: "info" | "good" | "bad" | "warn"; text: string} | null>(null);

  useEffect(() => onChainChange((next) => setSlug(chainKey(next))), []);
  const load = useCallback(async () => {
    const get = async <T,>(path: string): Promise<T | null> => { try { const response = await fetch(withChain(`/api/bot/${path}`, slug), {cache: "no-store"}); return response.ok ? await response.json() as T : null; } catch { return null; } };
    const [s, c, pf] = await Promise.all([get<StatusResponse>("status"), get<ConfigResponse>("config"), get<PreflightResponse>("preflight")]);
    if (s) { setStatus(s); if (s.qualification) setSoakHours(String(s.qualification.requiredHours)); }
    if (c) { setBotConfig(c); if (c.searcher) setSearcherInput(c.searcher); }
    if (pf) setPreflight({rpc: Boolean(pf.rpc), bot: !pf.demo, relay: Boolean(pf.relay), qualification: Boolean(pf.qualification)});
    else if (s) setPreflight((old) => ({...old, bot: !s.demo, qualification: Boolean(s.qualification)}));
  }, [slug]);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 10_000); return () => clearInterval(timer); }, [load]);
  useEffect(() => { const saved = storageGet(keyFor(STORAGE_EXECUTOR, slug)); setExecutorAddress(saved && isAddress(saved) ? saved : ""); setExecutorCheck(emptyCheck); }, [slug]);

  const executorTarget = executorAddress.trim();
  const configuredSearcher = searcherInput.trim();
  const walletReady = Boolean(wallet.address && wallet.chainId === expectedChainId);
  const gasReady = Boolean(walletReady && BigInt(wallet.balanceWei ?? 0n) >= GAS_THRESHOLD_WEI);
  const searcherSeparated = Boolean(wallet.address && isAddress(configuredSearcher) && configuredSearcher.toLowerCase() !== wallet.address.toLowerCase());
  const executorReady = executorCheck.codeBytes !== null && executorCheck.codeBytes > 0 && !executorCheck.error;
  const preflightReady = preflight.rpc && preflight.bot && preflight.relay && preflight.qualification;

  const verifyExecutor = useCallback(async (target: string) => {
    if (!isAddress(target)) return;
    try {
      const code = await publicClient.getCode({address: target as Address});
      if (!code || code === "0x") throw new Error("no contract bytecode at this address");
      const owner = await publicClient.readContract({address: target as Address, abi: EXECUTOR_ABI, functionName: "owner"});
      const wethOnChain = await publicClient.readContract({address: target as Address, abi: EXECUTOR_ABI, functionName: "WETH"}).catch(() => null);
      const allowed = isAddress(configuredSearcher) ? await publicClient.readContract({address: target as Address, abi: EXECUTOR_ABI, functionName: "searchers", args: [configuredSearcher as Address]}).catch(() => null) : null;
      if (wethOnChain && String(wethOnChain).toLowerCase() !== weth.toLowerCase()) throw new Error(`WETH mismatch: contract uses ${String(wethOnChain)}, expected ${weth}`);
      setExecutorCheck({codeBytes: Math.max(0, Math.floor((code.length - 2) / 2)), owner: String(owner), weth: wethOnChain ? String(wethOnChain) : null, searcherAllowed: allowed === null ? null : Boolean(allowed), error: null});
    } catch (error) { setExecutorCheck({...emptyCheck, error: errText(error)}); }
  }, [configuredSearcher, publicClient, weth]);
  useEffect(() => { if (isAddress(executorTarget)) void verifyExecutor(executorTarget); }, [executorTarget, verifyExecutor]);

  const updatePreflight = useCallback(async () => {
    try { const chain = await publicClient.getChainId(); await publicClient.getBlockNumber(); setPreflight((old) => ({...old, rpc: chain === expectedChainId})); } catch { setPreflight((old) => ({...old, rpc: false})); }
    try { const response = await fetch(withChain("/api/bot/preflight", slug), {cache: "no-store"}); const check = await response.json() as PreflightResponse; if (response.ok && !check.demo) setPreflight((old) => ({...old, bot: true, relay: Boolean(check.relay), qualification: Boolean(check.qualification)})); } catch { setPreflight((old) => ({...old, bot: false})); }
  }, [expectedChainId, publicClient, slug]);
  useEffect(() => { void updatePreflight(); }, [updatePreflight]);

  const deployExecutor = useCallback(async () => {
    if (!wallet.address || !wallet.eip1193 || wallet.chainId !== expectedChainId) { setMessage({tone: "bad", text: `Connect the operator wallet to ${label} first.`}); return; }
    setDeploying(true); setMessage({tone: "info", text: "Confirm MevExecutor deployment in your wallet…"});
    try { const client = createWalletClient({transport: custom(wallet.eip1193)}); const hash = await client.sendTransaction({account: wallet.address as Address, data: deployData(slug), chain: null}); const receipt = await publicClient.waitForTransactionReceipt({hash}); if (!receipt.contractAddress) throw new Error("receipt did not contain a contract address"); setExecutorAddress(receipt.contractAddress); storageSet(keyFor(STORAGE_EXECUTOR, slug), receipt.contractAddress); setMessage({tone: "good", text: `MevExecutor deployed at ${receipt.contractAddress}.`}); } catch (error) { setMessage({tone: "bad", text: `Executor deployment failed: ${errText(error)}`}); } finally { setDeploying(false); }
  }, [expectedChainId, label, publicClient, slug, wallet.address, wallet.chainId, wallet.eip1193]);

  const fundExecutor = useCallback(async (wrap: boolean) => {
    const amount = safeWei(fundAmount);
    if (!amount || !isAddress(executorTarget) || !wallet.address || !wallet.eip1193) { setMessage({tone: "bad", text: "Choose a deployed executor and a valid ETH amount."}); return; }
    setBusy(true);
    try { const client = createWalletClient({transport: custom(wallet.eip1193)}); if (wrap) { const wrapHash = await client.writeContract({account: wallet.address as Address, address: weth, abi: WETH_ABI, functionName: "deposit", value: amount, chain: null}); await publicClient.waitForTransactionReceipt({hash: wrapHash}); const hash = await client.writeContract({account: wallet.address as Address, address: weth, abi: WETH_ABI, functionName: "transfer", args: [executorTarget as Address, amount], chain: null}); await publicClient.waitForTransactionReceipt({hash}); } else { const hash = await client.sendTransaction({account: wallet.address as Address, to: executorTarget as Address, value: amount, chain: null}); await publicClient.waitForTransactionReceipt({hash}); } setMessage({tone: "good", text: `${wrap ? "WETH" : "ETH"} funding confirmed.`}); } catch (error) { setMessage({tone: "bad", text: `Funding failed: ${errText(error)}`}); } finally { setBusy(false); }
  }, [executorTarget, fundAmount, publicClient, wallet.address, wallet.eip1193, weth]);

  const setSoak = useCallback(async () => { const hours = Number(soakHours); if (!Number.isInteger(hours) || !Number.isFinite(hours) || hours < 0 || hours > 8760) { setMessage({tone: "bad", text: "Soak threshold must be an integer from 0 to 8760 hours."}); return; } setBusy(true); try { const response = await fetch(withChain("/api/bot/qualification", slug), {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({requiredHours: hours})}); const data = await response.json() as {ok?: boolean; error?: string; demo?: boolean}; if (!response.ok || !data.ok || data.demo) throw new Error(data.error || "bot rejected the soak threshold"); const label = hours === 0 ? "express mode — no soak, no shadow probation; live candidates run on the risk budget" : `soak threshold set to ${hours} hour${hours === 1 ? "" : "s"}`; setMessage({tone: "good", text: label + "."}); void load(); } catch (error) { setMessage({tone: "bad", text: `Soak update failed: ${errText(error)}`}); } finally { setBusy(false); } }, [load, slug, soakHours]);
  const armAtomic = useCallback(async () => { if (!preflightReady || !status?.liveArmed) { setMessage({tone: "bad", text: "Atomic live mode is not boot-armed or preflight is incomplete."}); return; } if (!window.confirm("Enable the atomic engine runtime LIVE mode?")) return; setBusy(true); try { const response = await fetch(withChain("/api/bot/mode", slug), {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({live: true})}); const data = await response.json() as {ok?: boolean; error?: string; demo?: boolean}; if (!response.ok || !data.ok || data.demo) throw new Error(data.error || "bot refused live mode"); setMessage({tone: "warn", text: "Atomic runtime mode is LIVE. Submission remains gated by risk and qualification."}); void load(); } catch (error) { setMessage({tone: "bad", text: `Atomic live switch failed: ${errText(error)}`}); } finally { setBusy(false); } }, [load, preflightReady, slug, status?.liveArmed]);
  const copy = async (text: string, labelText: string) => { try { await navigator.clipboard.writeText(text); setMessage({tone: "good", text: `${labelText} copied.`}); } catch { setMessage({tone: "bad", text: "Clipboard access was denied."}); } };
  const cliRpc = expectedChainId === 8453 ? "$BASE_HTTP_URL" : "$ETH_HTTP_URL";
  const executorCli = `cd contracts\nforge script script/Deploy.s.sol --rpc-url ${cliRpc} --broadcast --verify`;
  const envSnippet = `EXECUTOR_ADDRESS=${executorTarget || "<executor>"}\nSEARCHER_ADDRESS=${configuredSearcher || "<atomic-searcher>"}`;
  const dynamicBotStatus = status?.qualification;
  const doneCount = [walletReady, gasReady, executorReady, preflightReady].filter(Boolean).length;

  return <div style={{display: "grid", gap: 10}}>
    <div style={{display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap"}}><strong>Production Go-Live Wizard · {label}</strong><span className="muted">{doneCount}/4 cards ready</span></div>
    {message && <div style={{...noticeStyle, color: toneColor(message.tone), borderColor: toneColor(message.tone)}} role="status">{message.text}<button onClick={() => setMessage(null)} style={dismiss}>×</button></div>}
    <WizardCard number="1" title={`Network & wallet · ${label}`} state={walletReady ? "done" : "todo"}><div style={rowStyle}><code>{shorten(wallet.address)}</code>{wallet.address ? <span className={wallet.chainId === expectedChainId ? "good" : "warn"}>{wallet.chainId === expectedChainId ? `chain ${expectedChainId} ✓` : `wallet chain ${wallet.chainId} · need ${expectedChainId}`}</span> : <button style={buttonStyle} onClick={() => void wallet.connect()}>connect wallet</button>}</div></WizardCard>
    <WizardCard number="2" title="EOA & searcher-key verification" state={gasReady && Boolean(configuredSearcher) ? "done" : walletReady ? "todo" : "locked"}><div style={rowStyle}><span className="muted">owner/deployer</span><code>{shorten(wallet.address)}</code><span className={gasReady ? "good" : "warn"}>{formatEther(BigInt(wallet.balanceWei ?? 0n)).slice(0, 8)} ETH</span><span className="muted">atomic searcher</span><input value={searcherInput} onChange={(e) => setSearcherInput(e.target.value)} placeholder="SEARCHER_ADDRESS" style={inputStyle}/><span className={searcherSeparated ? "good" : "warn"}>{searcherSeparated ? "separate ✓" : "verify separation"}</span></div></WizardCard>
    <WizardCard number="3" title="Deploy & verify MevExecutor" state={executorReady ? "done" : gasReady ? "todo" : "locked"}><div style={{display: "grid", gap: 8}}><div style={rowStyle}><input value={executorAddress} onChange={(e) => setExecutorAddress(e.target.value)} placeholder="0x executor address" style={inputStyle}/><button style={buttonStyle} disabled={!gasReady || deploying} onClick={() => void deployExecutor()}>{deploying ? "deploying…" : "deploy / verify"}</button><span className={executorReady ? "good" : "muted"}>{executorCheck.error || (executorCheck.codeBytes !== null ? `${executorCheck.codeBytes.toLocaleString()} bytes` : "not checked")}</span></div><div style={rowStyle}><button style={buttonStyle} onClick={() => void copy(executorCli, "MevExecutor forge command")}>copy executor CLI</button><button style={buttonStyle} onClick={() => void copy(envSnippet, "executor env lines")}>copy env lines</button></div><pre style={preStyle}>{executorCli}</pre><div className="muted" style={{fontSize: 10}}>Executor owner {shorten(executorCheck.owner)} · searcher {executorCheck.searcherAllowed ? "allowlisted ✓" : executorCheck.searcherAllowed === null ? "not checked" : "not allowlisted"} · WETH {shorten(weth)}</div></div></WizardCard>
    <WizardCard number="4" title="Funding & pre-flight" state={preflightReady ? "done" : "todo"}><div style={{display: "grid", gap: 8}}><div style={rowStyle}><input value={fundAmount} onChange={(e) => setFundAmount(e.target.value)} style={smallInput}/><span className="muted">ETH</span><button style={buttonStyle} disabled={busy || !walletReady} onClick={() => void fundExecutor(true)}>wrap + transfer WETH</button><button style={buttonStyle} disabled={busy || !walletReady} onClick={() => void fundExecutor(false)}>send native ETH</button></div><div style={rowStyle}><Check label="RPC" ok={preflight.rpc}/><Check label="bot API" ok={preflight.bot}/><Check label={expectedChainId === 8453 ? "Base feed" : "relay data"} ok={preflight.relay}/><Check label="qualification" ok={preflight.qualification}/><button style={buttonStyle} onClick={() => {void updatePreflight(); void load();}}>refresh</button></div><div style={rowStyle}><span className="muted">qualification soak</span><input type="number" min="0" max="8760" step="1" value={soakHours} onChange={(e) => setSoakHours(e.target.value)} style={smallInput}/><span className="muted">hours · 0 = express (no soak) · evidence {dynamicBotStatus?.elapsedHours ?? 0}h</span><button style={buttonStyle} disabled={busy || !preflight.bot} onClick={() => void setSoak()}>apply threshold</button></div><button style={{...buttonStyle, borderColor: "var(--amber)", color: "var(--amber)"}} disabled={busy || !preflightReady} onClick={() => void armAtomic()}>confirm & enable atomic runtime LIVE</button></div></WizardCard>
    <div className="muted" style={{fontSize: 10}}>Runtime executor: <code>{shorten(runtimeExecutor)}</code> · runtime atomic mode: <code>{runtimeArmed ? "armed" : "simulation"}</code> · {explorerName(expectedChainId)} links appear after verification.</div>
  </div>;
}

function WizardCard({number, title, state, children}: {number: string; title: string; state: "done" | "todo" | "locked"; children: ReactNode}) { const color = state === "done" ? "var(--green)" : state === "locked" ? "var(--muted)" : "var(--cyan)"; return <section style={{border: "1px solid var(--line)", borderRadius: 5, padding: "10px 12px", background: state === "locked" ? "transparent" : "var(--panel-2)", opacity: state === "locked" ? 0.58 : 1}}><div style={{display: "flex", gap: 8, alignItems: "center", marginBottom: 8}}><span style={{color, fontWeight: 800}}>{state === "done" ? "✓" : number}</span><strong style={{fontSize: 12}}>{title}</strong><span className="muted" style={{marginLeft: "auto", fontSize: 10}}>{state}</span></div>{children}</section>; }
function Check({label, ok}: {label: string; ok: boolean}) { return <span className={ok ? "good" : "warn"} style={{fontSize: 11}}>{label}: {ok ? "ok" : "pending"}</span>; }
const toneColor = (tone: "info" | "good" | "bad" | "warn") => tone === "good" ? "var(--green)" : tone === "bad" ? "var(--red)" : tone === "warn" ? "var(--amber)" : "var(--cyan)";
const rowStyle: CSSProperties = {display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap"};
const buttonStyle: CSSProperties = {background: "var(--panel-2)", border: "1px solid var(--line)", borderRadius: 4, color: "var(--text)", padding: "4px 9px", cursor: "pointer", fontFamily: "inherit", fontSize: 11};
const inputStyle: CSSProperties = {...buttonStyle, background: "var(--panel)", minWidth: 220, flex: "1 1 220px"};
const smallInput: CSSProperties = {...inputStyle, minWidth: 72, width: 100, flex: "0 0 auto"};
const preStyle: CSSProperties = {background: "var(--panel)", color: "var(--cyan)", border: "1px solid var(--line)", borderRadius: 4, padding: 8, margin: 0, overflowX: "auto", fontSize: 10};
const noticeStyle: CSSProperties = {padding: "7px 10px", border: "1px solid", borderRadius: 4, fontSize: 11};
const dismiss: CSSProperties = {float: "right", marginLeft: 12, background: "transparent", border: 0, color: "inherit", cursor: "pointer"};
