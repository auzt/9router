"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import Card from "./Card";
import Select from "./Select";
import Badge from "./Badge";

const NONE_PROXY_POOL_VALUE = "__none__";
const STRATEGIES = [
  { value: "none", label: "None (single pool)" },
  { value: "round-robin", label: "Round-robin" },
  { value: "random", label: "Random" },
];

export default function NoAuthProxyCard({ providerId }) {
  const [proxyPools, setProxyPools] = useState([]);
  const [proxyPoolId, setProxyPoolId] = useState(NONE_PROXY_POOL_VALUE);
  const [fallbackPoolIds, setFallbackPoolIds] = useState([]);
  const [proxyRetryCount, setProxyRetryCount] = useState(3);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }).then((r) => r.ok ? r.json() : { proxyPools: [] }),
      fetch("/api/settings", { cache: "no-store" }).then((r) => r.ok ? r.json() : {}),
    ]).then(([poolData, settingsData]) => {
      if (cancelled) return;
      setProxyPools(poolData.proxyPools || []);
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      setProxyPoolId(override.proxyPoolId || NONE_PROXY_POOL_VALUE);
      setFallbackPoolIds(Array.isArray(override.proxyPoolFallbackIds) ? override.proxyPoolFallbackIds : []);
      setProxyRetryCount(override.proxyRetryCount != null ? Number(override.proxyRetryCount) : 3);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  const handleChange = async (newPrimary) => {
    const cleanFallbacks = newPrimary !== NONE_PROXY_POOL_VALUE
      ? fallbackPoolIds.filter(id => id !== newPrimary)
      : fallbackPoolIds;
    await saveConfig(newPrimary, cleanFallbacks, proxyRetryCount);
  };

  const handleToggleFallback = async (poolId) => {
    const newFallbacks = fallbackPoolIds.includes(poolId)
      ? fallbackPoolIds.filter(id => id !== poolId)
      : [...fallbackPoolIds, poolId];
    await saveConfig(proxyPoolId, newFallbacks, proxyRetryCount);
  };

  const handleRetryChange = async (value) => {
    const count = Math.max(1, Math.min(10, Number(value) || 3));
    setProxyRetryCount(count);
    await saveConfig(proxyPoolId, fallbackPoolIds, count);
  };

  const saveConfig = async (primary, fallbacks, retryCount) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}) };

      if (primary === NONE_PROXY_POOL_VALUE) delete override.proxyPoolId;
      else override.proxyPoolId = primary;

      if (fallbacks.length > 0) override.proxyPoolFallbackIds = fallbacks;
      else delete override.proxyPoolFallbackIds;

      if (retryCount !== 3) override.proxyRetryCount = retryCount;
      else delete override.proxyRetryCount;

      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;

      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });

      setProxyPoolId(primary);
      setFallbackPoolIds(fallbacks);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.log("Save proxy config error:", e);
    } finally {
      setSaving(false);
    }
  }, [providerId]);

  const handlePoolChange = (newPoolId) => {
    setProxyPoolId(newPoolId);
    save(newPoolId, rotateStrategy);
  };

  const fallbackEligiblePools = (proxyPools || []).filter(p => p.id !== proxyPoolId);

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-green-500/10 text-green-500">
          <span className="material-symbols-outlined text-[20px]">lock_open</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">No authentication required</p>
          <p className="text-xs text-text-muted">This provider is ready to use. Optionally route requests through a proxy pool to bypass IP-based limits.</p>
        </div>
        {savedFlash && <Badge variant="success" size="sm">Saved</Badge>}
      </div>

      <div className="mb-4">
        <Select
          label="Primary Proxy Pool"
          value={proxyPoolId}
          onChange={(e) => handleChange(e.target.value)}
          disabled={saving}
          options={[
            { value: NONE_PROXY_POOL_VALUE, label: "None (direct)" },
            ...proxyPools.map((pool) => ({ value: pool.id, label: pool.name })),
          ]}
        />
      </div>

      {proxyPoolId !== NONE_PROXY_POOL_VALUE && fallbackEligiblePools.length > 0 && (
        <div>
          <label className="text-xs text-text-muted mb-1.5 block">
            Fallback Pools <span className="text-text-muted/60">(tried on rate limit)</span>
          </label>
          <div className="flex flex-col gap-1 mb-3">
            {fallbackEligiblePools.map((pool) => (
              <label
                key={pool.id}
                className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                  fallbackPoolIds.includes(pool.id)
                    ? "bg-primary/10 border border-primary/30"
                    : "hover:bg-black/5 dark:hover:bg-white/5 border border-transparent"
                }`}
              >
                <input
                  type="checkbox"
                  checked={fallbackPoolIds.includes(pool.id)}
                  onChange={() => handleToggleFallback(pool.id)}
                  className="accent-primary"
                  disabled={saving}
                />
                <div className="flex-1 min-w-0">
                  <span className="text-sm truncate block">{pool.name}</span>
                  {pool.proxyUrl && (
                    <code className="text-[10px] font-mono text-text-muted truncate block">
                      {(() => {
                        try { const p = new URL(pool.proxyUrl); return `${p.protocol}//${p.hostname}${p.port ? `:${p.port}` : ""}`; }
                        catch { return pool.proxyUrl; }
                      })()}
                    </code>
                  )}
                </div>
                {pool.isActive === false && <Badge variant="error" size="xs">inactive</Badge>}
              </label>
            ))}
          </div>
        </div>
      )}

      {proxyPoolId !== NONE_PROXY_POOL_VALUE && (
        <div>
          <label className="text-xs text-text-muted mb-1.5 block">
            Max Retry Count <span className="text-text-muted/60">(1-10, default 3)</span>
          </label>
          <input
            type="number"
            min={1}
            max={10}
            value={proxyRetryCount}
            onChange={(e) => {
              const v = e.target.value;
              setProxyRetryCount(Math.max(1, Math.min(10, Number(v) || 3)));
            }}
            onBlur={() => handleRetryChange(proxyRetryCount)}
            className="w-24 px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
            disabled={saving}
          />
          <p className="text-[11px] text-text-muted mt-1">
            ⚡ {proxyRetryCount} attempt{proxyRetryCount > 1 ? "s" : ""} per request. Backoff: 2s, 4s, max 15s.
          </p>
        </div>
      )}
    </Card>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
