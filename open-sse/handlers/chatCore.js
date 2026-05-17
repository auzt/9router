import { detectFormat, getTargetFormat } from "../services/provider.js";
import { translateRequest } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { COLORS } from "../utils/stream.js";
import { createStreamController } from "../utils/streamHandler.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { createRequestLogger } from "../utils/requestLogger.js";
import { getModelTargetFormat, getModelStrip, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { handleBypassRequest } from "../utils/bypassHandler.js";
import { trackPendingRequest, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { getExecutor } from "../executors/index.js";
import { buildRequestDetail, extractRequestConfig } from "./chatCore/requestDetail.js";
import { handleForcedSSEToJson } from "./chatCore/sseToJsonHandler.js";
import { handleNonStreamingResponse } from "./chatCore/nonStreamingHandler.js";
import { handleStreamingResponse, buildOnStreamComplete } from "./chatCore/streamingHandler.js";
import { detectClientTool, isNativePassthrough } from "../utils/clientDetector.js";
import { dedupeTools } from "../utils/toolDeduper.js";
import { injectCaveman } from "../rtk/caveman.js";
import { compressMessages, formatRtkLog } from "../rtk/index.js";
import { resolveProxyPoolChain } from "@/lib/network/connectionProxy.js";

/**
 * Core chat handler - shared between SSE and Worker
 * @param {object} options.body - Request body
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {string} options.sourceFormatOverride - Override detected source format (e.g. "openai-responses")
 */
export async function handleChatCore({ body, modelInfo, credentials, log, onCredentialsRefreshed, onRequestSuccess, onDisconnect, clientRawRequest, connectionId, userAgent, apiKey, ccFilterNaming, rtkEnabled, cavemanEnabled, cavemanLevel, sourceFormatOverride, providerThinking }) {
  const { provider, model } = modelInfo;
  const requestStartTime = Date.now();

  const sourceFormat = sourceFormatOverride || detectFormat(body);

  // Check for bypass patterns (warmup, skip, cc naming)
  const bypassResponse = handleBypassRequest(body, model, userAgent, ccFilterNaming);
  if (bypassResponse) return bypassResponse;

  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const modelTargetFormat = getModelTargetFormat(alias, model);
  const targetFormat = modelTargetFormat || getTargetFormat(provider);
  const stripList = getModelStrip(alias, model);

  // Inject provider-level thinking config override (only if client hasn't set)
  // on/off → extended type (body.thinking), none/low/medium/high → effort type (body.reasoning_effort)
  if (providerThinking?.mode && providerThinking.mode !== "auto") {
    const mode = providerThinking.mode;
    if (mode === "on" && !body.thinking) {
      console.log("Injecting provider-level thinking config override: on");
      body = { ...body, thinking: { type: "enabled", budget_tokens: 10000 } };
    } else if (mode === "off" && !body.thinking) {
      body = { ...body, thinking: { type: "disabled" } };
    } else if (!body.reasoning_effort) {
      body = { ...body, reasoning_effort: mode };
    }
  }

  const clientRequestedStreaming = body.stream === true || sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI;
  const providerRequiresStreaming = provider === "openai" || provider === "codex" || provider === "commandcode";
  let stream = providerRequiresStreaming ? true : (body.stream !== false);

  // DeepSeek-TUI: interactive TUI panel sends stream:true and needs SSE.
  // Non-interactive mode (-p flag) sends without stream and can't parse SSE.
  // Only force non-streaming when client didn't explicitly request it.
  const detectedTool = detectClientTool(clientRawRequest?.headers || {}, body);
  if (detectedTool === "deepseek-tui" && body.stream !== true) stream = false;

  // Check client Accept header preference for non-streaming requests
  // This fixes AI SDK compatibility where clients send Accept: application/json
  const acceptHeader = clientRawRequest?.headers?.accept || "";
  const clientPrefersJson = acceptHeader.includes("application/json");
  const clientPrefersSSE = acceptHeader.includes("text/event-stream");
  if (clientPrefersJson && !clientPrefersSSE && body.stream !== true) {
    stream = false;
  }

  const reqLogger = await createRequestLogger(sourceFormat, targetFormat, model);
  if (clientRawRequest) reqLogger.logClientRawRequest(clientRawRequest.endpoint, clientRawRequest.body, clientRawRequest.headers);
  reqLogger.logRawRequest(body);
  log?.debug?.("FORMAT", `${sourceFormat} → ${targetFormat} | stream=${stream}`);

  // Native passthrough: CLI tool and provider are the same ecosystem
  // Skip all translation/normalization — only model and Bearer are swapped
  const clientTool = detectClientTool(clientRawRequest?.headers || {}, body);
  const passthrough = isNativePassthrough(clientTool, provider);

  let translatedBody;
  let toolNameMap;
  if (passthrough) {
    log?.debug?.("PASSTHROUGH", `${clientTool} → ${provider} | native lossless`);
    translatedBody = { ...body, model };
  } else {
    translatedBody = translateRequest(sourceFormat, targetFormat, model, body, stream, credentials, provider, reqLogger, stripList, connectionId, clientTool);
    if (!translatedBody) {
      trackPendingRequest(model, provider, connectionId, false, true);
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Failed to translate request for ${sourceFormat} → ${targetFormat}`);
    }
    toolNameMap = translatedBody._toolNameMap;
    delete translatedBody._toolNameMap;
    translatedBody.model = model;
  }

  // Dedupe duplicate built-in tools when equivalent MCP tools are present (Claude clients only).
  if (clientTool === "claude" && Array.isArray(translatedBody.tools)) {
    const { tools: deduped, stripped } = dedupeTools(translatedBody.tools);
    if (stripped.length > 0) {
      translatedBody.tools = deduped;
      log?.debug?.("TOOLDEDUP", `stripped ${stripped.length}: ${stripped.slice(0, 3).join(", ")}${stripped.length > 3 ? "..." : ""}`);
    }
  }

  // Token savers: applied at the final body just before dispatch
  // Covers both passthrough (source shape) and translated (target shape) flows
  const finalFormat = passthrough ? sourceFormat : targetFormat;

  // RTK: compress tool_result content
  const rtkStats = compressMessages(translatedBody, rtkEnabled);
  const rtkLine = formatRtkLog(rtkStats);
  if (rtkLine) console.log(rtkLine);

  // Caveman: inject terse-style system prompt
  if (cavemanEnabled && cavemanLevel) {
    injectCaveman(translatedBody, finalFormat, cavemanLevel);
    log?.debug?.("CAVEMAN", `${cavemanLevel} | ${finalFormat}`);
  }

  const executor = getExecutor(provider);
  trackPendingRequest(model, provider, connectionId, true);
  appendRequestLog({ model, provider, connectionId, status: "PENDING" }).catch(() => { });

  const msgCount = translatedBody.messages?.length || translatedBody.input?.length || translatedBody.contents?.length || translatedBody.request?.contents?.length || 0;
  log?.debug?.("REQUEST", `${provider.toUpperCase()} | ${model} | ${msgCount} msgs`);

  const streamController = createStreamController({
    onDisconnect: (reason) => {
      trackPendingRequest(model, provider, connectionId, false);
      if (onDisconnect) onDisconnect(reason);
    },
    onError: () => trackPendingRequest(model, provider, connectionId, false),
    log, provider, model
  });

  // ── Proxy Pool Fallback Chain (with circular retry + delay) ──
  // Resolves proxy pools from connection config (providerSpecificData)
  // or settings-based providerStrategies (for noAuth providers like OpenCode Free).
  // Cycles through pools with exponential backoff (2s, 4s, max 15s):
  //   3 pools → pool1 → 2s → pool2 → 4s → pool3
  //   2 pools → pool1 → 2s → pool2 → 4s → pool1
  //   No pools → 1 attempt (legacy proxy or direct)
  // ──────────────────────────────────────────────────────────────
  const proxyChain = await resolveProxyPoolChain(credentials?.providerSpecificData, provider);
  const maxAttempts = proxyChain.length > 0 ? 3 : 1;

  /**
   * Build proxyOptions for a given attempt index.
   * Cycles through the proxy chain with modulo.
   */
  function buildProxyOptionsForAttempt(attemptIdx) {
    if (proxyChain.length > 0) {
      const poolIdx = attemptIdx % proxyChain.length;
      const pc = proxyChain[poolIdx];
      return {
        connectionProxyEnabled: pc.connectionProxyEnabled,
        connectionProxyUrl: pc.connectionProxyUrl || "",
        connectionNoProxy: pc.connectionNoProxy || "",
        vercelRelayUrl: pc.vercelRelayUrl || "",
        _poolId: pc.poolId || "unknown",
        _poolIdx: poolIdx,
      };
    }
    // Legacy fallback (single proxy from providerSpecificData)
    return {
      connectionProxyEnabled: credentials?.providerSpecificData?.connectionProxyEnabled === true,
      connectionProxyUrl: credentials?.providerSpecificData?.connectionProxyUrl || "",
      connectionNoProxy: credentials?.providerSpecificData?.connectionNoProxy || "",
      vercelRelayUrl: credentials?.providerSpecificData?.vercelRelayUrl || "",
      _poolId: "none",
      _poolIdx: -1,
    };
  }

  /** Exponential backoff delay: 2s, 4s, max 15s */
  function backoffDelay(attempt) {
    return Math.min(2000 * Math.pow(2, attempt), 15000);
  }

  function logProxyInfo(opts, attempt, total) {
    const poolId = opts._poolId || "none";
    if (proxyChain.length > 0) {
      log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | attempt ${attempt + 1}/${total} | pool=${poolId}`);
    }

    if (opts.vercelRelayUrl) {
      const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
      log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | vercel-relay=${opts.vercelRelayUrl}`);
    } else if (opts.connectionProxyEnabled && opts.connectionProxyUrl) {
      let maskedProxyUrl = opts.connectionProxyUrl;
      try {
        const parsed = new URL(opts.connectionProxyUrl);
        maskedProxyUrl = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
      } catch { maskedProxyUrl = opts.connectionProxyUrl; }

      const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
      log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | url=${maskedProxyUrl}`);
    }

    if (opts.connectionProxyEnabled && opts.connectionNoProxy) {
      const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
      log?.debug?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | no_proxy=${opts.connectionNoProxy}`);
    }
  }

  let proxyOptions = buildProxyOptionsForAttempt(0);
  let providerResponse, providerUrl, providerHeaders, finalBody;
  let executeError = null;

  logProxyInfo(proxyOptions, 0, maxAttempts);

  // Circular retry loop: max 3 attempts, exponential backoff between retries
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      proxyOptions = buildProxyOptionsForAttempt(attempt);
      logProxyInfo(proxyOptions, attempt, maxAttempts);
    }

    try {
      const result = await executor.execute({ model, body: translatedBody, stream, credentials, signal: streamController.signal, log, proxyOptions });
      providerResponse = result.response;
      providerUrl = result.url;
      providerHeaders = result.headers;
      finalBody = result.transformedBody;
      reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);

      // Rate limited (429) and we have more attempts? Try next pool (circular), with backoff.
      if (providerResponse.status === 429 && attempt < maxAttempts - 1) {
        const poolId = proxyOptions._poolId || "unknown";
        const nextPoolId = buildProxyOptionsForAttempt(attempt + 1)._poolId || "unknown";
        const delayMs = backoffDelay(attempt);
        log?.warn?.("PROXY", `${provider.toUpperCase()} | ${model} | rate limited via pool=${poolId}, waiting ${(delayMs / 1000).toFixed(1)}s then retry ${attempt + 2}/${maxAttempts} | next=${nextPoolId}`);
        executeError = null;
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      // Non-429 response or last attempt — break to normal handling
      executeError = null;
      break;
    } catch (error) {
      if (attempt < maxAttempts - 1 && proxyChain.length > 0) {
        const poolId = proxyOptions._poolId || "unknown";
        const delayMs = backoffDelay(attempt);
        log?.warn?.("PROXY", `${provider.toUpperCase()} | ${model} | pool=${poolId} error: ${error.message}, waiting ${(delayMs / 1000).toFixed(1)}s then retry ${attempt + 2}/${maxAttempts}`);
        executeError = null;
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      // Last attempt or no pools — fall through to error handling
      executeError = error;
      break;
    }
  }

  // Handle execute error (from catch, all attempts exhausted)
  if (executeError) {
    trackPendingRequest(model, provider, connectionId, false, true);
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${executeError.name === "AbortError" ? 499 : HTTP_STATUS.BAD_GATEWAY}` }).catch(() => { });
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: translatedBody || null,
      response: { error: executeError.message || String(executeError), status: executeError.name === "AbortError" ? 499 : 502, thinking: null },
      status: "error"
    })).catch(() => { });

    if (executeError.name === "AbortError") {
      streamController.handleError(executeError);
      return createErrorResult(499, "Request aborted");
    }
    const errMsg = formatProviderError(executeError, provider, model, HTTP_STATUS.BAD_GATEWAY);
    console.log(`${COLORS.red}[ERROR] ${errMsg}${COLORS.reset}`);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  // Handle 401/403 - try token refresh (skip for noAuth providers)
  if (!executor.noAuth && (providerResponse.status === HTTP_STATUS.UNAUTHORIZED || providerResponse.status === HTTP_STATUS.FORBIDDEN)) {
    try {
      const newCredentials = await refreshWithRetry(() => executor.refreshCredentials(credentials, log), 3, log);
      if (newCredentials?.accessToken || newCredentials?.copilotToken) {
        log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed`);
        Object.assign(credentials, newCredentials);
        if (onCredentialsRefreshed) {
          try { await onCredentialsRefreshed(newCredentials); } catch (e) { log?.warn?.("TOKEN", `onCredentialsRefreshed failed: ${e.message}`); }
        }
        try {
          const retryResult = await executor.execute({ model, body: translatedBody, stream, credentials, signal: streamController.signal, log, proxyOptions });
          if (retryResult.response.ok) { providerResponse = retryResult.response; providerUrl = retryResult.url; }
        } catch { log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`); }
      } else {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
      }
    } catch (e) {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh threw: ${e.message}`);
    }
  }

  // Provider returned error
  if (!providerResponse.ok) {
    trackPendingRequest(model, provider, connectionId, false, true);
    const { statusCode, message, resetsAtMs } = await parseUpstreamError(providerResponse, executor);
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${statusCode}` }).catch(() => { });
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      response: { error: message, status: statusCode, thinking: null },
      status: "error"
    })).catch(() => { });

    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    console.log(`${COLORS.red}[ERROR] ${errMsg}${COLORS.reset}`);
    reqLogger.logError(new Error(message), finalBody || translatedBody);
    return createErrorResult(statusCode, errMsg, resetsAtMs);
  }

  const sharedCtx = { provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess };
  const appendLog = (extra) => appendRequestLog({ model, provider, connectionId, ...extra }).catch(() => { });
  const trackDone = () => trackPendingRequest(model, provider, connectionId, false);

  // Provider forced streaming but client wants JSON
  if (!clientRequestedStreaming && providerRequiresStreaming) {
    const result = await handleForcedSSEToJson({ ...sharedCtx, providerResponse, sourceFormat, trackDone, appendLog });
    if (result) { streamController.handleComplete(); return result; }
  }

  // True non-streaming response
  if (!stream) {
    const result = await handleNonStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat, reqLogger, toolNameMap, trackDone, appendLog });
    streamController.handleComplete();
    return result;
  }

  // Streaming response
  const { onStreamComplete } = buildOnStreamComplete({ ...sharedCtx });
  return handleStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, streamController, onStreamComplete });
}

export function isTokenExpiringSoon(expiresAt, bufferMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - Date.now() < bufferMs;
}
