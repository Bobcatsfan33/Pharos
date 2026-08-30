import { sha256Hex, type ActionRecord } from "@pharos/core";

export type EvidenceNodeKind =
  | "mandate"
  | "agent_run"
  | "model_call"
  | "tool_call"
  | "policy_verdict"
  | "human_review"
  | "credential_grant"
  | "external_effect"
  | "verification";

export interface EvidenceNode {
  id: string;
  tenantId: string;
  kind: EvidenceNodeKind;
  at: string;
  attributes: Record<string, unknown>;
  digest: string;
}

export interface EvidenceEdge {
  from: string;
  to: string;
  relationship: "caused" | "authorized" | "reviewed" | "executed" | "verified" | "delegated";
}

export interface OTelLikeSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Record<string, string | number | boolean>;
}

export class EvidenceGraph {
  private readonly nodes = new Map<string, EvidenceNode>();
  private readonly edges: EvidenceEdge[] = [];

  addNode(input: Omit<EvidenceNode, "digest">): EvidenceNode {
    if (this.nodes.has(input.id)) throw new Error(`evidence node already exists: ${input.id}`);
    const node = { ...input, digest: sha256Hex(input) };
    this.nodes.set(node.id, node);
    return node;
  }

  addEdge(edge: EvidenceEdge): void {
    const from = this.nodes.get(edge.from);
    const to = this.nodes.get(edge.to);
    if (!from || !to) throw new Error("evidence edges require existing nodes");
    if (from.tenantId !== to.tenantId) throw new Error("cross-tenant evidence edge refused");
    if (Date.parse(from.at) > Date.parse(to.at))
      throw new Error("causal edge cannot point backward in time");
    if (this.pathExists(edge.to, edge.from)) throw new Error("evidence edge would create a cycle");
    this.edges.push(edge);
  }

  private pathExists(from: string, target: string, seen = new Set<string>()): boolean {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return this.edges
      .filter((edge) => edge.from === from)
      .some((edge) => this.pathExists(edge.to, target, seen));
  }

  causalChain(nodeId: string): EvidenceNode[] {
    if (!this.nodes.has(nodeId)) return [];
    const parents = new Map<string, string[]>();
    for (const edge of this.edges)
      parents.set(edge.to, [...(parents.get(edge.to) ?? []), edge.from]);
    const ordered: EvidenceNode[] = [];
    const visit = (id: string) => {
      for (const parent of parents.get(id) ?? []) visit(parent);
      const node = this.nodes.get(id);
      if (node && !ordered.some((item) => item.id === id)) ordered.push(node);
    };
    visit(nodeId);
    return ordered;
  }

  toOpenTelemetry(traceId: string): OTelLikeSpan[] {
    return [...this.nodes.values()].map((node) => {
      const parentId = this.edges.find((edge) => edge.to === node.id)?.from;
      const parent = parentId ? this.nodes.get(parentId) : undefined;
      return {
        name: `pharos.${node.kind}`,
        traceId,
        spanId: node.digest.slice(0, 16),
        ...(parent ? { parentSpanId: parent.digest.slice(0, 16) } : {}),
        attributes: {
          "pharos.evidence.node_id": node.id,
          "pharos.evidence.digest": node.digest,
          "pharos.tenant.id": node.tenantId,
          "gen_ai.operation.name": node.kind === "model_call" ? "chat" : node.kind,
          ...(typeof node.attributes["tool.name"] === "string"
            ? { "gen_ai.tool.name": node.attributes["tool.name"] as string }
            : {}),
        },
      };
    });
  }

  static fromActionRecord(record: ActionRecord): EvidenceGraph {
    const graph = new EvidenceGraph();
    const tenantId = record.content.tenantId;
    const at = record.content.sealedAt;
    const runId = record.content.action.sessionId ?? record.content.action.agentId;
    graph.addNode({
      id: `run:${runId}`,
      tenantId,
      kind: "agent_run",
      at: record.content.action.emittedAt,
      attributes: { agentId: record.content.action.agentId },
    });
    graph.addNode({
      id: `verdict:${record.content.id}`,
      tenantId,
      kind: "policy_verdict",
      at,
      attributes: {
        decision: record.content.verdict.decision,
        recordId: record.content.id,
        contentHash: record.seal.contentHash,
      },
    });
    graph.addEdge({
      from: `run:${runId}`,
      to: `verdict:${record.content.id}`,
      relationship: "authorized",
    });
    return graph;
  }
}
