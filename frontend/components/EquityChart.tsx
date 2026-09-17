"use client";

import {memo, useMemo} from "react";
import {LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid} from "recharts";
import type {SeriesPoint} from "@/lib/types";

/** Cumulative simulated PnL, in ETH, bucketed by target block. */
function EquityChart({series}: {series: SeriesPoint[]}) {
  // Up to 250 points reduced on every render otherwise — and recharts then
  // re-renders the whole SVG because `data` is a new array identity.
  const data = useMemo(() => {
    let cum = 0n;
    return series.map((p) => {
      cum += BigInt(p.netWei);
      return {block: p.block, eth: Number(cum) / 1e18, blockNet: Number(BigInt(p.netWei)) / 1e18, count: p.count};
    });
  }, [series]);

  const last = data.length ? data[data.length - 1].eth : 0;
  const color = last >= 0 ? "var(--success)" : "var(--danger)";

  if (!data.length) {
    return <div className="muted" style={{padding: 24, textAlign: "center"}}>no simulations yet</div>;
  }

  return (
    <div style={{height: 220, padding: "12px 8px 0 0"}}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{top: 4, right: 12, bottom: 4, left: 4}}>
          <CartesianGrid stroke="var(--line-soft)" vertical={false} />
          <XAxis
            dataKey="block"
            tick={{fill: "var(--muted)", fontSize: 10}}
            tickLine={false}
            axisLine={{stroke: "var(--line)"}}
            minTickGap={40}
          />
          <YAxis
            tick={{fill: "var(--muted)", fontSize: 10}}
            tickLine={false}
            axisLine={false}
            width={58}
            tickFormatter={(v: number) => v.toFixed(3)}
          />
          <Tooltip
            contentStyle={{
              background: "var(--panel)",
              border: "1px solid var(--line)",
              borderRadius: 4,
              fontSize: 11,
              fontFamily: "ui-monospace, monospace",
            }}
            labelStyle={{color: "var(--muted)"}}
            formatter={(value, name) => {
              const numeric = Number(value ?? 0);
              return [
                `${numeric >= 0 ? "+" : ""}${numeric.toFixed(6)} ETH`,
                name === "eth" ? "cumulative" : "block net",
              ];
            }}
          />
          <ReferenceLine y={0} stroke="var(--muted)" strokeDasharray="3 3" />
          <Line type="monotone" dataKey="eth" stroke={color} strokeWidth={1.6} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Memoized: an SVG chart is one of the most expensive things on the page, and
 * its input only changes on the 4s status poll — never on an SSE flush.
 */
export default memo(EquityChart);
