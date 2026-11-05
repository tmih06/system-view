import type { DiagramSpec } from "../src/diagram/types";
import festival from "../diagram/club.json";
import clubManual from "../diagram/club.manual.json";

const platform: DiagramSpec = {
  title: "Web platform",
  direction: "right",
  groups: [
    { id: "edge", label: "Cloudflare", tone: "warm" },
    { id: "app", label: "Application", tone: "cool" },
    { id: "external", label: "External services", tone: "neutral" },
  ],
  nodes: [
    { id: "visitors", label: "Visitors", subtitle: "web browser", shape: "terminal" },
    { id: "dns", label: "DNS / Proxy", subtitle: "WAF · Access", icon: "cloudflare", group: "edge" },
    { id: "api", label: "API", subtitle: "Hono · TypeScript", icon: "hono", group: "app" },
    { id: "db", label: "PostgreSQL", subtitle: "application data", icon: "postgresql", group: "app" },
    { id: "cache", label: "Redis", subtitle: "sessions · cache", icon: "redis", group: "app" },
    { id: "email", label: "Email", subtitle: "transactional mail", icon: "resend", group: "external" },
  ],
  edges: [
    { from: "visitors", to: "dns", label: "HTTPS", kind: "primary" },
    { from: "dns", to: "api", label: "HTTPS", kind: "primary" },
    { from: "api", to: "db", label: "SQL" },
    { from: "api", to: "cache", label: "session" },
    { from: "api", to: "email", label: "send", kind: "async" },
  ],
  flow: ["visitors", "dns", "api", "db"],
};

const request: DiagramSpec = {
  title: "Request lifecycle",
  direction: "down",
  nodes: [
    { id: "start", label: "Incoming request", shape: "terminal" },
    { id: "validate", label: "Validate request", subtitle: "schema + authentication" },
    { id: "valid", label: "Valid?", shape: "decision" },
    { id: "reject", label: "Return 400 / 401", subtitle: "explain the error", shape: "terminal" },
    { id: "process", label: "Process request", subtitle: "apply business rules" },
    { id: "save", label: "Persist result", icon: "postgresql", subtitle: "single transaction" },
    { id: "finish", label: "Return response", shape: "terminal" },
  ],
  edges: [
    { from: "start", to: "validate", kind: "primary" },
    { from: "validate", to: "valid", kind: "primary" },
    { from: "valid", to: "reject", label: "no", fromSide: "east", toSide: "north" },
    { from: "valid", to: "process", label: "yes", kind: "primary", fromSide: "south", toSide: "north" },
    { from: "process", to: "save", kind: "primary" },
    { from: "save", to: "finish", kind: "primary" },
  ],
  flow: ["start", "validate", "valid", "process", "save", "finish"],
};

export const examples = [
  // Manual mode reproduces the traced reference exactly: same panels, card
  // positions and connector bends as out/club-editable.svg.
  { id: "club", name: "Club architecture", description: "Traced · 35 nodes · manual layout", spec: clubManual as DiagramSpec },
  { id: "platform", name: "Web platform", description: "Groups, icons & integrations", spec: platform },
  { id: "request", name: "Request lifecycle", description: "Decisions & branching flows", spec: request },
  { id: "festival", name: "Festival (auto)", description: "Same topology · automatic layout", spec: festival as DiagramSpec },
] as const;

export function scriptFor(index: number) {
  const fields = Object.entries(examples[index].spec).map(([key, value]) => {
    // One node/edge per line keeps the examples readable beside their diagram.
    if (Array.isArray(value) && value.length && typeof value[0] === "object") {
      return `  "${key}": [\n${value.map((entry) => `    ${JSON.stringify(entry)}`).join(",\n")}\n  ]`;
    }
    return `  "${key}": ${JSON.stringify(value)}`;
  });
  return `{\n${fields.join(",\n")}\n}`;
}
