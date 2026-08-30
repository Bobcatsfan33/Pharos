import { sha256Hex, type LiabilityContext, type VerdictRequest } from "@pharos/core";

export interface McpToolDescriptor {
  serverUrl: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  risk: {
    reversibility: "reversible" | "irreversible";
    financialAmount?: number;
    currency?: string;
    dataClasses?: string[];
  };
  requiredScopes: string[];
}

export interface RegisteredMcpTool extends McpToolDescriptor {
  schemaDigest: string;
  version: number;
}

export interface ToolRegistrationResult {
  tool: RegisteredMcpTool;
  drifted: boolean;
  previousDigest: string | null;
}

export class McpToolRegistry {
  private readonly tools = new Map<string, RegisteredMcpTool>();

  register(descriptor: McpToolDescriptor): ToolRegistrationResult {
    const id = `${descriptor.serverUrl}#${descriptor.name}`;
    const schemaDigest = sha256Hex({
      name: descriptor.name,
      inputSchema: descriptor.inputSchema,
      requiredScopes: [...descriptor.requiredScopes].sort(),
      risk: descriptor.risk,
    });
    const previous = this.tools.get(id);
    const drifted = Boolean(previous && previous.schemaDigest !== schemaDigest);
    const tool: RegisteredMcpTool = {
      ...descriptor,
      requiredScopes: [...descriptor.requiredScopes].sort(),
      schemaDigest,
      version: previous ? (drifted ? previous.version + 1 : previous.version) : 1,
    };
    this.tools.set(id, tool);
    return { tool, drifted, previousDigest: previous?.schemaDigest ?? null };
  }

  get(serverUrl: string, name: string): RegisteredMcpTool | null {
    return this.tools.get(`${serverUrl}#${name}`) ?? null;
  }
}

export interface McpInvocation {
  tenantId: string;
  agentId: string;
  sessionId?: string;
  serverUrl: string;
  toolName: string;
  arguments: Record<string, unknown>;
  subject: string;
  delegatedBy?: string[];
}

export function toMcpVerdictRequest(
  invocation: McpInvocation,
  tool: RegisteredMcpTool,
  oversightMode: LiabilityContext["oversightMode"] = "autonomous",
): VerdictRequest {
  if (tool.serverUrl !== invocation.serverUrl || tool.name !== invocation.toolName) {
    throw new Error("MCP invocation does not match registered tool");
  }
  return {
    tenantId: invocation.tenantId,
    action: {
      type: `mcp.${tool.name}`,
      agentId: invocation.agentId,
      sessionId: invocation.sessionId,
      emittedAt: new Date().toISOString(),
      payload: {
        serverUrl: tool.serverUrl,
        toolName: tool.name,
        schemaDigest: tool.schemaDigest,
        arguments: invocation.arguments,
        subject: invocation.subject,
        delegatedBy: invocation.delegatedBy ?? [],
      },
    },
    liability: {
      mandate: null,
      oversightMode,
      blastRadius: {
        financialAmount: tool.risk.financialAmount ?? 0,
        currency: tool.risk.currency ?? "USD",
        reversibility: tool.risk.reversibility,
        notes: tool.risk.dataClasses?.length
          ? `MCP data classes: ${[...tool.risk.dataClasses].sort().join(",")}`
          : undefined,
      },
      modelMetadata: null,
    },
  };
}

export interface ScopedCredential {
  token: string;
  audience: string;
  scopes: string[];
  subject: string;
  expiresAt: string;
  authorizationRecordId: string;
}

export interface CredentialIssuer {
  issue(input: Omit<ScopedCredential, "token">): Promise<string>;
}

/** Issues a fresh audience-bound credential after approval; caller tokens are never forwarded. */
export async function issueMcpCredential(options: {
  tool: RegisteredMcpTool;
  subject: string;
  authorizationRecordId: string;
  approvedScopes: string[];
  issuer: CredentialIssuer;
  ttlSeconds?: number;
  now?: () => number;
}): Promise<ScopedCredential> {
  const approved = new Set(options.approvedScopes);
  if (!options.tool.requiredScopes.every((scope) => approved.has(scope))) {
    throw new Error("approved scopes do not satisfy the registered MCP tool");
  }
  const now = (options.now ?? Date.now)();
  const credential: Omit<ScopedCredential, "token"> = {
    audience: options.tool.serverUrl,
    scopes: [...options.tool.requiredScopes],
    subject: options.subject,
    expiresAt: new Date(now + (options.ttlSeconds ?? 300) * 1000).toISOString(),
    authorizationRecordId: options.authorizationRecordId,
  };
  return { ...credential, token: await options.issuer.issue(credential) };
}
