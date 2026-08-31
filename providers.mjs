import { createPlan, daysSince, validatePlan } from "./organizer-core.mjs";

export const MAX_PROVIDER_REQUEST_BYTES = 512 * 1024;
export const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

const disclosure = Object.freeze({
  title: true,
  hostname: true,
  hierarchyNames: true,
  tabState: true,
  coarseLastAccessed: true,
  fullUrl: false,
  pageContent: false,
  localHostnames: false,
});

const systemPrompt = `Return exactly one JSON object with "operations" and optional "explanation".
Operations must use exactly one of these shapes and no extra fields:
{"id":"...","type":"create_folder","folderRef":"...","name":"...","spaceId":"...","parentFolderId":null}
{"id":"...","type":"rename_folder","folderId":"...","name":"..."}
{"id":"...","type":"move_tabs","tabIds":["..."],"targetSpaceId":"...","targetFolderId":null}
{"id":"...","type":"set_pinned","tabIds":["..."],"pinned":true}
Use only the supplied IDs and give every operation a unique string id.
Never close tabs, invent IDs, change settings, or claim capabilities.`;

function providerError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some(octet => octet > 255)) return false;
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isLocalHostname(hostname) {
  return isLoopback(hostname) || isPrivateIpv4(hostname) || hostname.endsWith(".local");
}

export function normalizeProviderConfig(config = {}) {
  const mode = config.mode || "none";
  if (!["none", "ollama", "openai-compatible"].includes(mode)) {
    throw providerError("PROVIDER_OUTPUT_INVALID", "Unknown provider mode");
  }
  if (mode === "none") return { mode, origin: null, model: "", lanHttp: false };

  let url;
  try {
    url = new URL(config.origin || (mode === "ollama" ? "http://127.0.0.1:11434" : ""));
  } catch {
    throw providerError("PROVIDER_UNREACHABLE", "Provider URL is invalid");
  }
  if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) {
    throw providerError("PROVIDER_UNREACHABLE", "Provider URL must be HTTP(S) without credentials");
  }
  const lanHttp =
    url.protocol === "http:" &&
    (isPrivateIpv4(url.hostname) || url.hostname.endsWith(".local"));
  if (url.protocol === "http:" && !isLoopback(url.hostname) && !lanHttp) {
    throw providerError("PROVIDER_UNREACHABLE", "Public providers require HTTPS");
  }
  const model = String(config.model || "").trim();
  if (!model || model.length > 200) {
    throw providerError("PROVIDER_OUTPUT_INVALID", "Provider model is required");
  }
  return { mode, origin: url.origin, model, lanHttp };
}

export function createProviderProjection(snapshot) {
  const spaces = snapshot.spaces.map(space => ({ id: space.id, name: space.name }));
  const folders = snapshot.folders.map(folder => ({
    id: folder.id,
    name: folder.name,
    spaceId: folder.spaceId,
    parentFolderId: folder.parentFolderId,
  }));
  const tabs = snapshot.tabs.map(tab => {
    const age = daysSince(tab.lastAccessedAt, snapshot.capturedAt);
    return {
      id: tab.id,
      title: tab.title,
      hostname: isLocalHostname(tab.hostname) ? "" : tab.hostname,
      spaceId: tab.spaceId,
      folderId: tab.folderId,
      pinned: tab.pinned,
      essential: tab.essential,
      lastAccessedDays:
        age === null ? null : age >= 180 ? 180 : age >= 90 ? 90 : age >= 30 ? 30 : 0,
    };
  });
  return { schemaVersion: 1, spaces, folders, tabs };
}

export function providerConsentKey(config) {
  const normalized = normalizeProviderConfig(config);
  return `${normalized.mode}|${normalized.origin}|${JSON.stringify(disclosure)}`;
}

export function prepareProviderRequest(config, snapshot, prompt) {
  const normalized = normalizeProviderConfig(config);
  if (normalized.mode === "none") {
    return { mode: "none", consentKey: "none", preview: { mode: "none" } };
  }
  const cleanPrompt = String(prompt || "").trim();
  if (!cleanPrompt) throw providerError("PROVIDER_OUTPUT_INVALID", "Planning request is required");
  const projection = createProviderProjection(snapshot);
  const userContent = JSON.stringify({ request: cleanPrompt, snapshot: projection });
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
  const body =
    normalized.mode === "ollama"
      ? { model: normalized.model, stream: false, format: "json", messages }
      : {
          model: normalized.model,
          messages,
          response_format: { type: "json_object" },
        };
  const serializedBody = JSON.stringify(body);
  if (new TextEncoder().encode(serializedBody).byteLength > MAX_PROVIDER_REQUEST_BYTES) {
    throw providerError("PROVIDER_RESPONSE_TOO_LARGE", "Provider request exceeds 512 KB");
  }
  const path = normalized.mode === "ollama" ? "/api/chat" : "/v1/chat/completions";
  const url = new URL(path, normalized.origin).href;
  return {
    ...normalized,
    url,
    body,
    serializedBody,
    snapshot,
    prompt: cleanPrompt,
    consentKey: providerConsentKey(normalized),
    preview: { url, body },
  };
}

export function extractOneJsonObject(content) {
  if (typeof content !== "string") {
    if (content && typeof content === "object" && !Array.isArray(content)) return content;
    throw providerError("PROVIDER_OUTPUT_INVALID", "Provider returned no JSON object");
  }
  const trimmed = content.trim();
  let parsedDirectly = false;
  try {
    const direct = JSON.parse(trimmed);
    parsedDirectly = true;
    if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
  } catch {
    // A single fenced or explained JSON object is handled below.
  }
  if (parsedDirectly) {
    throw providerError("PROVIDER_OUTPUT_INVALID", "Provider must return one JSON object");
  }

  const objects = [];
  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth < 0) break;
      if (depth === 0 && start >= 0) objects.push(content.slice(start, index + 1));
    }
  }
  if (depth !== 0 || quoted || objects.length !== 1) {
    throw providerError("PROVIDER_OUTPUT_INVALID", "Provider must return exactly one JSON object");
  }
  try {
    const parsed = JSON.parse(objects[0]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // Report one stable error below without returning provider content.
  }
  throw providerError("PROVIDER_OUTPUT_INVALID", "Provider returned invalid JSON");
}

async function readBoundedJson(response) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw providerError("PROVIDER_RESPONSE_TOO_LARGE", "Provider response exceeds 1 MB");
  }
  let bytes;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw providerError("PROVIDER_RESPONSE_TOO_LARGE", "Provider response exceeds 1 MB");
      }
      chunks.push(value);
    }
    bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
      throw providerError("PROVIDER_RESPONSE_TOO_LARGE", "Provider response exceeds 1 MB");
    }
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw providerError("PROVIDER_OUTPUT_INVALID", "Provider response is not JSON");
  }
}

export async function requestProviderPlan(prepared, options = {}) {
  if (prepared.mode === "none") return { plan: null, explanation: "Provider is disabled." };
  if (!options.approved) {
    throw providerError("PROVIDER_CONSENT_REQUIRED", "Disclosure approval is required");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  try {
    const response = await (options.fetchImpl || fetch)(prepared.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: prepared.serializedBody,
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw providerError("PROVIDER_UNREACHABLE", "Provider redirects are not allowed");
    }
    if (!response.ok) {
      throw providerError("PROVIDER_UNREACHABLE", `Provider returned HTTP ${response.status}`);
    }
    const responseJson = await readBoundedJson(response);
    const content =
      Array.isArray(responseJson.operations)
        ? responseJson
        : responseJson.message?.content ??
          responseJson.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments ??
          responseJson.choices?.[0]?.message?.content;
    const output = extractOneJsonObject(content);
    const allowedFields = ["operations", "explanation"];
    if (
      Object.keys(output).some(key => !allowedFields.includes(key)) ||
      !Array.isArray(output.operations) ||
      (output.explanation !== undefined &&
        (typeof output.explanation !== "string" || output.explanation.length > 2_000))
    ) {
      throw providerError("PROVIDER_OUTPUT_INVALID", "Provider output has an invalid shape");
    }
    const plan = {
      ...createPlan(prepared.snapshot, { source: "ai", prompt: prepared.prompt }),
      operations: output.operations,
    };
    const validation = validatePlan(plan, prepared.snapshot);
    if (!validation.ok) {
      throw providerError(
        "PROVIDER_OUTPUT_INVALID",
        "Provider plan failed local validation",
        validation.errors.map(error => ({ code: error.code, operationId: error.operationId })),
      );
    }
    return { plan: validation.plan, explanation: output.explanation || "" };
  } catch (error) {
    if (error.name === "AbortError") {
      throw providerError("PROVIDER_TIMEOUT", "Provider request timed out");
    }
    if (error.code) throw error;
    throw providerError("PROVIDER_UNREACHABLE", "Provider request failed");
  } finally {
    clearTimeout(timeout);
  }
}
