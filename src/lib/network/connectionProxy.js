import { getProxyPoolById } from "@/models";
import { getSettings } from "@/lib/localDb";

// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// ─── Proxy pool rotation state (in-memory) ─────────────────────────
const rotateState = new Map(); // providerId → { index }

/**
 * Pick one proxy pool ID from a list based on strategy.
 * round-robin: cycle sequentially (in-memory, resets on restart)
 * random:      uniform random pick
 * none/single: return first entry
 */
export function pickProxyPoolId(poolIds, strategy, providerId) {
  if (!poolIds || poolIds.length === 0) return null;
  if (poolIds.length === 1) return poolIds[0];

  if (strategy === "round-robin") {
    const state = rotateState.get(providerId) || { index: -1 };
    state.index = (state.index + 1) % poolIds.length;
    rotateState.set(providerId, state);
    return poolIds[state.index];
  }

  if (strategy === "random") {
    return poolIds[Math.floor(Math.random() * poolIds.length)];
  }

  return poolIds[0]; // "none" or unknown
}

/**
 * Normalize legacy proxy configuration.
 */
function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;
  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl
  );
  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

/**
 * Normalize vercel relay configuration.
 */
function normalizeVercelRelay(providerSpecificData = {}) {
  const vercelRelayUrl = normalizeString(
    providerSpecificData?.vercelRelayUrl
  );

  return { vercelRelayUrl };
}

/**
 * Normalize proxy pool configuration.
 */
export function normalizeProxyPoolConfig(providerSpecificData = {}) {
  const proxyPoolId = normalizeString(providerSpecificData?.proxyPoolId);

  return { proxyPoolId };
}

/**
 * Resolve proxy configuration for the connection.
 * Supports:
 *   1. Proxy Pool (by ID) → poolId & pool data
 *   2. Legacy connection-level proxy → URL based
 *   3. Vercel relay → special URL
 *
 * @param {object} providerSpecificData
 * @returns {object} { source, proxyPoolId, proxyPool, connectionProxyEnabled, connectionProxyUrl, connectionNoProxy, vercelRelayUrl, strictProxy }
 */
export async function resolveConnectionProxyConfig(providerSpecificData = {}) {
  try {
    // ── 1. Proxy Pool ────────────────────────────────────────────
    const proxyPoolId = normalizeString(providerSpecificData?.proxyPoolId);
    if (proxyPoolId && proxyPoolId !== "__none__") {
      const proxyPool = await getProxyPoolById(proxyPoolId);
      if (proxyPool && proxyPool.isActive) {
        const proxyUrl = normalizeString(proxyPool.proxyUrl);
        if (proxyUrl) {
          const noProxy = normalizeString(proxyPool.noProxy);
          const strictProxy = proxyPool.strictProxy === true;

          if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno") {
            return {
              source: proxyPool.type,
              proxyPoolId,
              proxyPool,
              connectionProxyEnabled: false,
              connectionProxyUrl: "",
              connectionNoProxy: noProxy,
              vercelRelayUrl: proxyUrl,
              strictProxy,
            };
          }

          return {
            source: "pool-proxy",
            proxyPoolId,
            proxyPool,
            connectionProxyEnabled: true,
            connectionProxyUrl: proxyUrl,
            connectionNoProxy: noProxy,
            vercelRelayUrl: "",
            strictProxy,
          };
        }
      }
    }

    // ── 2. Vercel Relay ──────────────────────────────────────────
    const { vercelRelayUrl } = normalizeVercelRelay(providerSpecificData);
    if (vercelRelayUrl) {
      return {
        source: "vercel-relay",
        proxyPoolId: null,
        proxyPool: null,
        connectionProxyEnabled: false,
        connectionProxyUrl: "",
        connectionNoProxy: "",
        vercelRelayUrl,
        strictProxy: false,
      };
    }

    // ── 3. Legacy connection-level proxy ─────────────────────────
    const legacy = normalizeLegacyProxy(providerSpecificData);
    if (legacy.connectionProxyEnabled && legacy.connectionProxyUrl) {
      return {
        source: "legacy-proxy",
        proxyPoolId: null,
        proxyPool: null,
        connectionProxyEnabled: legacy.connectionProxyEnabled,
        connectionProxyUrl: legacy.connectionProxyUrl,
        connectionNoProxy: legacy.connectionNoProxy,
        vercelRelayUrl: "",
        strictProxy: false,
      };
    }

    return {
      source: "none",
      proxyPoolId: null,
      proxyPool: null,
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      vercelRelayUrl: "",
      strictProxy: false,
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error
    );

    return {
      source: "error",

      proxyPoolId: null,
      proxyPool: null,

      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",

      strictProxy: false,
    };
  }
}

/**
 * Resolve a single proxy pool by ID into a simplified config object.
 * Returns null if pool not found or inactive.
 */
async function resolveSinglePoolConfig(poolId) {
  const id = normalizeString(poolId);
  if (!id || id === "__none__") return null;

  const proxyPool = await getProxyPoolById(id);
  if (!proxyPool || !proxyPool.isActive) return null;

  const proxyUrl = normalizeString(proxyPool.proxyUrl);
  if (!proxyUrl) return null;

  const noProxy = normalizeString(proxyPool.noProxy);
  const strictProxy = proxyPool.strictProxy === true;

  if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno") {
    return {
      poolId: id,
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: noProxy,
      vercelRelayUrl: proxyUrl,
      strictProxy,
    };
  }

  return {
    poolId: id,
    connectionProxyEnabled: true,
    connectionProxyUrl: proxyUrl,
    connectionNoProxy: noProxy,
    vercelRelayUrl: "",
    strictProxy,
  };
}

/**
 * Resolve proxy pool chain with fallback support.
 *
 * Reads from two sources (checked in order):
 *   1. providerSpecificData (connection-level):
 *      - proxyPoolId            : primary proxy pool ID
 *      - proxyPoolFallbackIds   : fallback pool IDs (comma-separated string, or array)
 *   2. settings providerStrategies (noAuth providers, e.g. OpenCode Free):
 *      - accessed via providerId parameter
 *
 * @param {object}   providerSpecificData - Connection-level provider config
 * @param {string}   [providerId]         - Optional provider ID for settings-based fallback
 * @returns {Array<object>} Ordered array of proxy config objects (empty = no proxy)
 */
export async function resolveProxyPoolChain(providerSpecificData = {}, providerId) {
  const poolIds = [];
  const seen = new Set();

  // Helper: extract pool IDs from a data source
  function extractPoolIds(source) {
    if (!source) return;
    const primaryId = normalizeString(source.proxyPoolId);
    if (primaryId && primaryId !== "__none__" && !seen.has(primaryId)) {
      poolIds.push(primaryId);
      seen.add(primaryId);
    }

    const fallbackRaw = source.proxyPoolFallbackIds;
    if (Array.isArray(fallbackRaw)) {
      for (const id of fallbackRaw) {
        const tid = normalizeString(id);
        if (tid && tid !== "__none__" && !seen.has(tid)) {
          poolIds.push(tid);
          seen.add(tid);
        }
      }
    } else if (typeof fallbackRaw === "string") {
      for (const id of fallbackRaw.split(",")) {
        const tid = normalizeString(id);
        if (tid && tid !== "__none__" && !seen.has(tid)) {
          poolIds.push(tid);
          seen.add(tid);
        }
      }
    }
  }

  // 1. Try connection-level providerSpecificData
  extractPoolIds(providerSpecificData);

  // 2. If no pools found from connection-level data and providerId is given,
  //    try settings-based providerStrategies (used by noAuth providers like OpenCode Free)
  if (poolIds.length === 0 && providerId) {
    try {
      const settings = await getSettings();
      const strategy = settings?.providerStrategies?.[providerId];
      if (strategy) {
        extractPoolIds(strategy);
      }
    } catch (e) {
      console.error(`[resolveProxyPoolChain] Failed to read settings for ${providerId}:`, e);
    }
  }

  // Resolve each pool
  const chain = [];
  for (const id of poolIds) {
    const config = await resolveSinglePoolConfig(id);
    if (config) chain.push(config);
  }

  return chain;
}
