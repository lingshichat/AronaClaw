#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  try {
    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex < 1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const val = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    // Ignore missing .env.local.
  }
}

function loadGatewayDefaults() {
  const defaults = {
    url: "ws://100.68.146.126:18789",
    origin: "https://openclaw.lingshichat.top",
    password: "",
    token: ""
  };

  try {
    const raw = fs.readFileSync("/root/.openclaw/openclaw.json", "utf8");
    const config = JSON.parse(raw);
    const remoteUrl = config?.gateway?.remote?.url;
    if (typeof remoteUrl === "string" && remoteUrl.trim()) defaults.url = remoteUrl.trim();

    const allowedOrigin = config?.gateway?.controlUi?.allowedOrigins?.[0];
    if (typeof allowedOrigin === "string" && allowedOrigin.trim()) defaults.origin = allowedOrigin.trim();

    const password = config?.gateway?.auth?.password;
    const token = config?.gateway?.auth?.token;
    defaults.password = typeof password === "string" ? password : "";
    defaults.token = typeof token === "string" ? token : "";
  } catch {
    // Keep hardcoded defaults when local config is not available.
  }

  return defaults;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const body = raw.slice(2);
    const eqIndex = body.indexOf("=");
    if (eqIndex !== -1) {
      const key = body.slice(0, eqIndex);
      const value = body.slice(eqIndex + 1);
      args[key] = value;
      continue;
    }

    const key = body;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "Gateway chat/session probe (OpenClaw v3 frame style)",
      "",
      "Usage:",
      "  node scripts/gateway-probe.mjs [options]",
      "",
      "Options:",
      "  --url <ws-url>                Override gateway URL",
      "  --origin <origin>             Override gateway origin",
      "  --password <password>         Override gateway password",
      "  --token <token>               Override gateway token",
      "  --unsafe                      Allow mutating probes (send/create/delete)",
      "  --requestTimeoutMs <ms>       Request timeout (default: 15000)",
      "  --connectTimeoutMs <ms>       Connect timeout (default: 15000)",
      "  --eventDrainMs <ms>           Wait after probes to capture events (default: 1200)",
      "  --out <path>                  Save JSON report to file",
      "  --markdown <path>             Save markdown report to file",
      "  --help                        Show this help text",
      "",
      "Examples:",
      "  node scripts/gateway-probe.mjs",
      "  node scripts/gateway-probe.mjs --unsafe --out docs/gateway-chat-probe.json --markdown docs/gateway-chat-probe-report.md"
    ].join("\n") + "\n"
  );
}

function cleanObject(value) {
  if (Array.isArray(value)) return value.map((item) => cleanObject(item));
  if (!value || typeof value !== "object") return value;

  const next = {};
  for (const [key, val] of Object.entries(value)) {
    if (val === undefined) continue;
    next[key] = cleanObject(val);
  }
  return next;
}

function truncateText(value, maxLength = 280) {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...<trimmed ${text.length - maxLength} chars>`;
}

function summarizePayload(payload) {
  let size = 0;
  let preview = "";
  try {
    const text = JSON.stringify(payload);
    size = text.length;
    preview = truncateText(text, 320);
  } catch {
    preview = truncateText(payload, 320);
  }

  const summary = {
    type: Array.isArray(payload) ? "array" : typeof payload,
    size,
    preview,
    topLevelKeys: []
  };

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    summary.topLevelKeys = Object.keys(payload).slice(0, 20);
  }

  return summary;
}

function classifyErrorMessage(message) {
  const text = String(message || "").toLowerCase();
  if (!text) return "unknown";
  if (text.includes("timeout")) return "timeout";
  if (
    text.includes("unknown") ||
    text.includes("not found") ||
    text.includes("unsupported") ||
    text.includes("not implemented")
  ) {
    return "unknown_method_or_resource";
  }
  if (
    text.includes("invalid") ||
    text.includes("missing") ||
    text.includes("required") ||
    text.includes("schema") ||
    text.includes("params")
  ) {
    return "invalid_params_or_schema";
  }
  if (text.includes("auth") || text.includes("forbidden") || text.includes("unauthorized")) {
    return "auth_or_permission";
  }
  return "runtime_error";
}

function extractSessionItems(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.sessions)) return payload.sessions;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.data?.sessions)) return payload.data.sessions;
  if (Array.isArray(payload.data?.items)) return payload.data.items;
  if (Array.isArray(payload)) return payload;
  return [];
}

function extractModelItems(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.models)) return payload.models;
  if (Array.isArray(payload.modelList)) return payload.modelList;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload)) return payload;
  return [];
}

function findStringByKeyCandidates(value, keys) {
  const queue = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;

    if (Array.isArray(current)) {
      for (const item of current) queue.push(item);
      continue;
    }

    for (const key of keys) {
      const candidate = current[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }

    for (const next of Object.values(current)) queue.push(next);
  }

  return "";
}

function redactGatewayConfig(config) {
  return {
    url: config.url,
    origin: config.origin,
    authMode: config.password || config.token ? "enabled" : "none",
    passwordConfigured: Boolean(config.password),
    tokenConfigured: Boolean(config.token)
  };
}

class GatewayProbeSession {
  constructor(config, options) {
    this.config = config;
    this.options = options;
    this.ws = null;
    this.pending = new Map();
    this.connected = false;
    this.closed = false;
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    this.connectTimer = null;
  }

  async connect() {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      this.ws = new WebSocket(this.config.url, { origin: this.config.origin });
      this.ws.on("open", () => this.sendConnect());
      this.ws.on("message", (raw) => this.handleMessage(raw.toString()));
      this.ws.on("error", (error) => this.failConnect(error));
      this.ws.on("close", (code, reason) => {
        const message = `gateway websocket closed (${code}): ${reason.toString() || "no reason"}`;
        this.failConnect(new Error(message));
        this.rejectPending(new Error(message));
        this.connected = false;
      });

      this.connectTimer = setTimeout(() => {
        this.failConnect(new Error(`gateway connect timeout after ${this.options.connectTimeoutMs}ms`));
      }, this.options.connectTimeoutMs);
    });

    return this.connectPromise;
  }

  failConnect(error) {
    if (this.connected || this.closed) return;

    if (this.connectReject) {
      this.connectReject(error instanceof Error ? error : new Error(String(error)));
    }

    this.connectResolve = null;
    this.connectReject = null;
    this.connectPromise = null;

    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  sendConnect() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "openclaw-control-ui",
        version: "probe-0.2",
        platform: process.platform,
        mode: "ui"
      },
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      caps: []
    };

    const auth = {};
    if (this.config.password) auth.password = this.config.password;
    if (this.config.token) auth.token = this.config.token;
    if (Object.keys(auth).length > 0) params.auth = auth;

    this.ws.send(
      JSON.stringify({
        type: "req",
        id: crypto.randomUUID(),
        method: "connect",
        params
      })
    );
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message?.type === "event") {
      if (typeof this.options.onEvent === "function") {
        this.options.onEvent({
          receivedAt: new Date().toISOString(),
          event: message.event || "<unknown>",
          payloadSummary: summarizePayload(message.payload)
        });
      }

      if (message.event === "connect.challenge") {
        this.sendConnect();
      }
      return;
    }

    if (message?.type !== "res") return;

    if (!this.connected && message.ok && message.payload?.type === "hello-ok") {
      this.connected = true;
      if (this.connectTimer) {
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
      }
      if (this.connectResolve) this.connectResolve(message.payload);
      this.connectResolve = null;
      this.connectReject = null;
      this.connectPromise = null;
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);

    if (message.ok) {
      pending.resolve(message.payload);
    } else {
      pending.reject(new Error(message.error?.message || "gateway request failed"));
    }
  }

  request(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.connected) {
      return Promise.reject(new Error("gateway session not connected"));
    }

    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ type: "req", id, method, params }));

      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`gateway request timeout: ${method}`));
      }, this.options.requestTimeoutMs);
    });
  }

  rejectPending(error) {
    for (const [, pending] of this.pending) pending.reject(error);
    this.pending.clear();
  }

  close() {
    this.closed = true;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.rejectPending(new Error("gateway session closed"));
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close();
  }
}

function buildCandidateCases(context) {
  const fakeSessionKey = `probe-missing-${Date.now()}`;
  const sessionKey = context.firstSessionKey || fakeSessionKey;
  const message = `P4-T01A probe ping @ ${new Date().toISOString()}`;
  const label = `arona-probe-${Date.now()}`;
  const model = context.firstModel || undefined;

  return [
    {
      method: "sessions.create",
      params: cleanObject({ label, model }),
      mutating: true,
      note: "candidate"
    },
    {
      method: "sessions.new",
      params: cleanObject({ label: `${label}-new`, model }),
      mutating: true,
      note: "candidate"
    },
    {
      method: "sessions.get",
      params: { key: sessionKey },
      mutating: false,
      note: "candidate"
    },
    {
      method: "sessions.detail",
      params: { key: sessionKey },
      mutating: false,
      note: "candidate"
    },
    {
      method: "sessions.messages",
      params: { key: sessionKey, limit: 20 },
      mutating: false,
      note: "candidate"
    },
    {
      method: "sessions.history",
      params: { key: sessionKey, limit: 20 },
      mutating: false,
      note: "candidate"
    },
    {
      method: "sessions.send",
      params: { key: sessionKey, message },
      mutating: true,
      note: "candidate"
    },
    {
      method: "sessions.preview",
      params: { keys: [sessionKey], limit: 10, maxChars: 300 },
      mutating: false,
      note: "docs-derived"
    },
    {
      method: "sessions.resolve",
      params: { key: sessionKey },
      mutating: false,
      note: "docs-derived"
    },
    {
      method: "sessions.patch",
      params: { key: fakeSessionKey, label },
      mutating: true,
      note: "docs-derived"
    },
    {
      method: "sessions.reset",
      params: { key: fakeSessionKey },
      mutating: true,
      note: "docs-derived"
    },
    {
      method: "sessions.compact",
      params: { key: fakeSessionKey, maxLines: 200 },
      mutating: true,
      note: "docs-derived"
    },
    {
      method: "sessions.usage",
      params: { key: sessionKey, limit: 1 },
      mutating: false,
      note: "docs-derived"
    },
    {
      method: "agent.turn",
      params: { key: sessionKey, message },
      mutating: true,
      note: "candidate"
    },
    {
      method: "agent.turn",
      params: { message, sessionTarget: "isolated" },
      mutating: true,
      note: "candidate-alt"
    },
    {
      method: "chat.send",
      params: { key: sessionKey, message },
      mutating: true,
      note: "candidate"
    },
    {
      method: "chat.send",
      params: { message, sessionTarget: "isolated" },
      mutating: true,
      note: "candidate-alt"
    },
    {
      method: "chat.history",
      params: { sessionKey, limit: 20 },
      mutating: false,
      note: "docs-derived"
    },
    {
      method: "chat.send",
      params: {
        sessionKey: fakeSessionKey,
        message,
        idempotencyKey: crypto.randomUUID()
      },
      mutating: true,
      note: "docs-derived"
    },
    {
      method: "chat.abort",
      params: { sessionKey: fakeSessionKey },
      mutating: true,
      note: "docs-derived"
    },
    {
      method: "chat.inject",
      params: { sessionKey: fakeSessionKey, message },
      mutating: true,
      note: "docs-derived"
    },
    {
      method: "sessions.delete",
      params: { key: fakeSessionKey },
      mutating: true,
      note: "candidate"
    },
    {
      method: "sessions.remove",
      params: { key: fakeSessionKey },
      mutating: true,
      note: "candidate"
    }
  ];
}

function compactEntry(entry, maxPayloadBytes = 500) {
  const next = cleanObject({ ...entry });
  if (!next || typeof next !== "object") return next;
  if (next.payload === undefined) return next;

  const alwaysOmitMethods = new Set(["sessions.preview", "chat.history"]);
  if (alwaysOmitMethods.has(String(next.method || ""))) {
    if (next.payloadSummary && typeof next.payloadSummary === "object") {
      next.payloadSummary.preview = "<omitted-sensitive-preview>";
    }
    delete next.payload;
    next.payloadOmitted = true;
    return next;
  }

  const payloadSize = Number(next.payloadSummary?.size || 0);
  if (payloadSize > maxPayloadBytes) {
    delete next.payload;
    next.payloadOmitted = true;
  }

  return next;
}

async function runCase(session, caseDef, options) {
  if (!options.unsafe && caseDef.mutating) {
    return {
      method: caseDef.method,
      note: caseDef.note,
      mutating: caseDef.mutating,
      params: caseDef.params,
      status: "skipped_safe_mode",
      durationMs: 0
    };
  }

  const started = Date.now();
  try {
    const payload = await session.request(caseDef.method, caseDef.params);
    return {
      method: caseDef.method,
      note: caseDef.note,
      mutating: caseDef.mutating,
      params: caseDef.params,
      status: "ok",
      durationMs: Date.now() - started,
      payloadSummary: summarizePayload(payload),
      payload
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      method: caseDef.method,
      note: caseDef.note,
      mutating: caseDef.mutating,
      params: caseDef.params,
      status: "error",
      durationMs: Date.now() - started,
      error: {
        message,
        kind: classifyErrorMessage(message)
      }
    };
  }
}

function groupEventCounts(events) {
  const counts = {};
  for (const item of events) {
    const key = item.event || "<unknown>";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function escapeMarkdownCode(text) {
  return String(text ?? "").replace(/`/g, "\\`").replace(/\|/g, "\\|");
}

function methodTable(results) {
  const rows = [
    "| Method | Status | Error Kind | Duration (ms) | Params Preview |",
    "| --- | --- | --- | ---: | --- |"
  ];

  for (const item of results) {
    const paramsPreview = escapeMarkdownCode(truncateText(JSON.stringify(item.params), 120));
    rows.push(
      `| \`${item.method}\` | ${item.status} | ${item.error?.kind || ""} | ${item.durationMs || 0} | \`${paramsPreview}\` |`
    );
  }

  return rows.join("\n");
}

function buildMarkdownReport(report) {
  const lines = [];

  lines.push("# Gateway Chat Protocol Probe Report");
  lines.push("");
  lines.push(`- Generated at: ${report.generatedAt}`);
  lines.push(`- Gateway URL: ${report.gateway.url}`);
  lines.push(`- Gateway origin: ${report.gateway.origin}`);
  lines.push(`- Auth mode: ${report.gateway.authMode}`);
  lines.push(`- Unsafe mode: ${report.options.unsafe ? "enabled" : "disabled"}`);
  lines.push("");

  lines.push("## Handshake");
  lines.push("");
  lines.push(`- Status: ${report.handshake.status}`);
  if (report.handshake.error) lines.push(`- Error: ${report.handshake.error}`);
  if (report.handshake.helloSummary) {
    lines.push(`- hello payload summary: \`${escapeMarkdownCode(JSON.stringify(report.handshake.helloSummary))}\``);
  }
  lines.push("");

  lines.push("## Baseline Context");
  lines.push("");
  lines.push(`- sessions.list status: ${report.baseline.sessionsList.status}`);
  lines.push(`- models.list status: ${report.baseline.modelsList.status}`);
  lines.push(`- Session count: ${report.context.sessionCount}`);
  lines.push(`- First session key: ${report.context.firstSessionKey || "<none>"}`);
  lines.push(`- Model count: ${report.context.modelCount}`);
  lines.push(`- First model: ${report.context.firstModel || "<none>"}`);
  lines.push("");

  lines.push("## Probe Matrix");
  lines.push("");
  lines.push(methodTable(report.results));
  lines.push("");

  lines.push("## Event Frames");
  lines.push("");
  lines.push(`- Total events observed: ${report.events.total}`);
  lines.push(`- Event counts: \`${escapeMarkdownCode(JSON.stringify(report.events.counts))}\``);
  if (report.events.samples.length > 0) {
    lines.push("- Sample events:");
    for (const sample of report.events.samples) {
      lines.push(
        `  - \`${sample.receivedAt}\` event=\`${sample.event}\` keys=${sample.payloadSummary.topLevelKeys.join(",") || "<none>"}`
      );
    }
  }
  lines.push("");

  if (report.cleanup.length > 0) {
    lines.push("## Cleanup Attempts");
    lines.push("");
    for (const entry of report.cleanup) {
      lines.push(
        `- \`${entry.method}\` key=\`${entry.params?.key || ""}\` status=${entry.status}${
          entry.error?.message ? ` error=${entry.error.message}` : ""
        }`
      );
    }
    lines.push("");
  }

  lines.push("## Notes");
  lines.push("");
  lines.push("- This probe reuses server-side frame semantics (`type:req/res/event`) and connect challenge handling.");
  lines.push("- Mutating methods are skipped unless `--unsafe` is provided.");

  return lines.join("\n") + "\n";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  loadEnvLocal();
  const defaults = loadGatewayDefaults();

  const gatewayConfig = {
    url: args.url || process.env.GATEWAY_URL || defaults.url,
    origin: args.origin || process.env.GATEWAY_ORIGIN || defaults.origin,
    password:
      args.password !== undefined
        ? String(args.password)
        : process.env.GATEWAY_PASSWORD !== undefined
          ? process.env.GATEWAY_PASSWORD
          : defaults.password,
    token:
      args.token !== undefined
        ? String(args.token)
        : process.env.GATEWAY_TOKEN !== undefined
          ? process.env.GATEWAY_TOKEN
          : defaults.token
  };

  const options = {
    unsafe: Boolean(args.unsafe),
    requestTimeoutMs: parsePositiveInt(args.requestTimeoutMs, 15000),
    connectTimeoutMs: parsePositiveInt(args.connectTimeoutMs, 15000),
    eventDrainMs: parsePositiveInt(args.eventDrainMs, 1200)
  };

  const outPath = args.out ? path.resolve(process.cwd(), String(args.out)) : "";
  const markdownPath = args.markdown ? path.resolve(process.cwd(), String(args.markdown)) : "";

  const report = {
    generatedAt: new Date().toISOString(),
    gateway: redactGatewayConfig(gatewayConfig),
    options,
    handshake: {
      status: "pending"
    },
    baseline: {
      sessionsList: { status: "not_run" },
      modelsList: { status: "not_run" }
    },
    context: {
      sessionCount: 0,
      firstSessionKey: "",
      modelCount: 0,
      firstModel: ""
    },
    results: [],
    cleanup: [],
    events: {
      total: 0,
      counts: {},
      samples: []
    }
  };

  const events = [];
  const createdSessionKeys = new Set();
  let exitCode = 0;

  const session = new GatewayProbeSession(gatewayConfig, {
    requestTimeoutMs: options.requestTimeoutMs,
    connectTimeoutMs: options.connectTimeoutMs,
    onEvent: (event) => {
      events.push(event);
    }
  });

  try {
    const hello = await session.connect();
    report.handshake.status = "ok";
    report.handshake.helloSummary = summarizePayload(hello);

    const sessionsBaseline = await runCase(
      session,
      {
        method: "sessions.list",
        params: { limit: 20, includeLastMessage: true },
        mutating: false,
        note: "baseline"
      },
      options
    );
    const modelsBaseline = await runCase(
      session,
      {
        method: "models.list",
        params: {},
        mutating: false,
        note: "baseline"
      },
      options
    );

    report.baseline.sessionsList = sessionsBaseline;
    report.baseline.modelsList = modelsBaseline;

    const sessions = sessionsBaseline.status === "ok" ? extractSessionItems(sessionsBaseline.payload) : [];
    const models = modelsBaseline.status === "ok" ? extractModelItems(modelsBaseline.payload) : [];

    report.context.sessionCount = sessions.length;
    report.context.firstSessionKey =
      (typeof sessions[0]?.key === "string" && sessions[0].key) ||
      (typeof sessions[0]?.sessionKey === "string" && sessions[0].sessionKey) ||
      "";

    report.context.modelCount = models.length;
    report.context.firstModel =
      (typeof models[0] === "string" && models[0]) ||
      (typeof models[0]?.name === "string" && models[0].name) ||
      (typeof models[0]?.id === "string" && models[0].id) ||
      "";

    const candidateCases = buildCandidateCases({
      firstSessionKey: report.context.firstSessionKey,
      firstModel: report.context.firstModel
    });

    for (const caseDef of candidateCases) {
      const result = await runCase(session, caseDef, options);
      report.results.push(result);

      if ((caseDef.method === "sessions.create" || caseDef.method === "sessions.new") && result.status === "ok") {
        const created = findStringByKeyCandidates(result.payload, ["key", "sessionKey"]);
        if (created && created !== "main") createdSessionKeys.add(created);
      }
    }

    if (options.unsafe && createdSessionKeys.size > 0) {
      for (const key of createdSessionKeys) {
        for (const method of ["sessions.delete", "sessions.remove"]) {
          const cleanupResult = await runCase(
            session,
            {
              method,
              params: { key },
              mutating: true,
              note: "cleanup"
            },
            options
          );
          report.cleanup.push(cleanupResult);
        }
      }
    }

    if (options.eventDrainMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.eventDrainMs));
    }
  } catch (error) {
    exitCode = 1;
    report.handshake.status = "error";
    report.handshake.error = error instanceof Error ? error.message : String(error);
  } finally {
    session.close();
  }

  report.events.total = events.length;
  report.events.counts = groupEventCounts(events);
  report.events.samples = events.slice(0, 20);

  const normalized = cleanObject({
    ...report,
    baseline: {
      sessionsList: compactEntry(report.baseline.sessionsList),
      modelsList: compactEntry(report.baseline.modelsList)
    },
    results: report.results.map((item) => compactEntry(item)),
    cleanup: report.cleanup.map((item) => compactEntry(item))
  });

  const jsonText = JSON.stringify(normalized, null, 2);
  if (outPath) {
    fs.writeFileSync(outPath, `${jsonText}\n`, "utf8");
  }

  if (markdownPath) {
    fs.writeFileSync(markdownPath, buildMarkdownReport(normalized), "utf8");
  }

  process.stdout.write(`${jsonText}\n`);
  process.exitCode = exitCode;
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
