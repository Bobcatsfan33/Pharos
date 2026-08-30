export type EnterpriseKmsProvider = "aws-kms" | "vault-transit" | "azure-key-vault" | "gcp-kms";

export interface DeploymentRegion {
  id: string;
  jurisdiction: string;
  replicas: number;
}

export interface TenantResidency {
  tenantId: string;
  allowedJurisdictions: string[];
  primaryRegion: string;
  replicaRegions: string[];
}

export interface EnterpriseDeploymentPlan {
  regions: DeploymentRegion[];
  tenants: TenantResidency[];
  kms: { provider: EnterpriseKmsProvider; customerManaged: boolean; privateEndpoint: boolean };
  identity: { sso: boolean; scim: boolean };
  recovery: { rpoMinutes: number; rtoMinutes: number };
  airGapped?: boolean;
}

export interface DeploymentValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateEnterpriseDeployment(plan: EnterpriseDeploymentPlan): DeploymentValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const regions = new Map(plan.regions.map((region) => [region.id, region]));
  if (regions.size !== plan.regions.length) errors.push("region identifiers must be unique");
  if (!plan.kms.customerManaged)
    warnings.push("customer-managed keys are recommended for enterprise deployments");
  if (plan.airGapped && !plan.kms.privateEndpoint)
    errors.push("air-gapped deployments require a private KMS endpoint");
  if (!plan.identity.sso) warnings.push("SSO is not enabled");
  if (!plan.identity.scim) warnings.push("SCIM lifecycle management is not enabled");
  if (plan.recovery.rpoMinutes < 0 || plan.recovery.rtoMinutes < 1)
    errors.push("RPO/RTO objectives must be non-negative");

  for (const tenant of plan.tenants) {
    const placements = [tenant.primaryRegion, ...tenant.replicaRegions];
    if (new Set(placements).size !== placements.length)
      errors.push(`${tenant.tenantId}: duplicate region placement`);
    if (tenant.replicaRegions.length === 0)
      warnings.push(`${tenant.tenantId}: no failover replica configured`);
    for (const placement of placements) {
      const region = regions.get(placement);
      if (!region) {
        errors.push(`${tenant.tenantId}: unknown region ${placement}`);
      } else if (!tenant.allowedJurisdictions.includes(region.jurisdiction)) {
        errors.push(`${tenant.tenantId}: ${placement} violates residency policy`);
      }
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function planTenantFailover(
  plan: EnterpriseDeploymentPlan,
  tenantId: string,
  unavailableRegion: string,
): string {
  const validation = validateEnterpriseDeployment(plan);
  if (!validation.valid)
    throw new Error(`invalid deployment plan: ${validation.errors.join("; ")}`);
  const tenant = plan.tenants.find((item) => item.tenantId === tenantId);
  if (!tenant) throw new Error(`unknown tenant: ${tenantId}`);
  if (tenant.primaryRegion !== unavailableRegion) return tenant.primaryRegion;
  const target = tenant.replicaRegions.find((region) => region !== unavailableRegion);
  if (!target) throw new Error(`${tenantId}: no residency-compliant failover region available`);
  return target;
}
