import { db } from './db';
import { eq, and, gte, lte, desc } from 'drizzle-orm';
import * as schema from '@shared/schema';
import { encrypt, decrypt, encryptAzureConfig, decryptAzureConfig } from './encryption';
import { currentOrgId } from './tenant-context';

/**
 * Tenant-scoped persistence layer.
 *
 * Every method here reads the active tenant from the ambient context and pins
 * its query to it — callers never pass an organizationId and therefore cannot
 * forget to. currentOrgId() throws when there is no context, so a query issued
 * from outside a request or a runAsSystem() block fails loudly instead of
 * quietly reading across all tenants.
 *
 * Writes stamp the tenant; reads and updates filter on it. An update or delete
 * that targets an id belonging to another tenant matches zero rows and returns
 * undefined, which is exactly the "not found" the caller should see.
 *
 * Methods that are deliberately global are grouped at the bottom under
 * PLATFORM and named so that it is obvious at the call site.
 */
export class DbStorage {

  // ==================== AZURE ACCOUNTS ====================

  async createAzureAccount(account: schema.InsertAzureAccount): Promise<schema.AzureAccount> {
    const encryptedAccount = encryptAzureConfig(account);

    const [created] = await db.insert(schema.azureAccounts)
      .values({ ...encryptedAccount, organizationId: currentOrgId() })
      .returning();

    return decryptAzureConfig(created);
  }

  async getAzureAccount(id: number): Promise<schema.AzureAccount | undefined> {
    const [account] = await db.select().from(schema.azureAccounts)
      .where(and(
        eq(schema.azureAccounts.id, id),
        eq(schema.azureAccounts.organizationId, currentOrgId()),
      ));

    if (!account) return undefined;
    return decryptAzureConfig(account);
  }

  async getAllAzureAccounts(): Promise<schema.AzureAccount[]> {
    const accounts = await db.select().from(schema.azureAccounts)
      .where(eq(schema.azureAccounts.organizationId, currentOrgId()));
    return accounts.map(decryptAzureConfig);
  }

  async getActiveAzureAccounts(): Promise<schema.AzureAccount[]> {
    const accounts = await db.select()
      .from(schema.azureAccounts)
      .where(and(
        eq(schema.azureAccounts.isActive, 1),
        eq(schema.azureAccounts.organizationId, currentOrgId()),
      ));

    return accounts.map(decryptAzureConfig);
  }

  async updateAzureAccount(id: number, updates: Partial<schema.InsertAzureAccount>): Promise<schema.AzureAccount | undefined> {
    const encryptedUpdates = updates.tenantId || updates.clientId || updates.clientSecret
      ? encryptAzureConfig(updates)
      : updates;

    // organizationId is never updatable — a row cannot change tenant.
    const { organizationId: _ignored, ...safeUpdates } = encryptedUpdates as Record<string, unknown>;

    const [updated] = await db.update(schema.azureAccounts)
      .set({ ...safeUpdates, updatedAt: new Date() })
      .where(and(
        eq(schema.azureAccounts.id, id),
        eq(schema.azureAccounts.organizationId, currentOrgId()),
      ))
      .returning();

    if (!updated) return undefined;
    return decryptAzureConfig(updated);
  }

  async deleteAzureAccount(id: number): Promise<boolean> {
    const result = await db.delete(schema.azureAccounts)
      .where(and(
        eq(schema.azureAccounts.id, id),
        eq(schema.azureAccounts.organizationId, currentOrgId()),
      ));

    return result.rowCount ? result.rowCount > 0 : false;
  }

  // ==================== COST HISTORY ====================

  async saveCostHistory(records: schema.InsertCostHistory[]): Promise<void> {
    if (records.length === 0) return;

    const orgId = currentOrgId();
    await db.insert(schema.costHistory)
      .values(records.map(r => ({ ...r, organizationId: orgId })))
      .onConflictDoNothing();
  }

  async getCostHistory(
    accountId: string,
    startDate?: Date,
    endDate?: Date,
    provider?: schema.CloudProvider
  ): Promise<schema.CostHistory[]> {
    const conditions = [
      eq(schema.costHistory.organizationId, currentOrgId()),
      eq(schema.costHistory.accountId, accountId),
    ];

    if (provider) {
      conditions.push(eq(schema.costHistory.provider, provider));
    }
    if (startDate) {
      conditions.push(gte(schema.costHistory.date, startDate));
    }
    if (endDate) {
      conditions.push(lte(schema.costHistory.date, endDate));
    }

    return await db.select()
      .from(schema.costHistory)
      .where(and(...conditions))
      .orderBy(desc(schema.costHistory.date));
  }

  async queryCostHistory(filters: {
    provider?: string;
    accountId?: string;
    serviceName?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<schema.CostHistory[]> {
    // The tenant predicate is unconditional; the rest are optional. Previously
    // an empty filter set returned every row in the table.
    const conditions = [eq(schema.costHistory.organizationId, currentOrgId())];

    if (filters.provider) {
      conditions.push(eq(schema.costHistory.provider, filters.provider));
    }
    if (filters.accountId) {
      conditions.push(eq(schema.costHistory.accountId, filters.accountId));
    }
    if (filters.serviceName) {
      conditions.push(eq(schema.costHistory.serviceName, filters.serviceName));
    }
    if (filters.startDate) {
      conditions.push(gte(schema.costHistory.date, filters.startDate));
    }
    if (filters.endDate) {
      conditions.push(lte(schema.costHistory.date, filters.endDate));
    }

    return await db.select()
      .from(schema.costHistory)
      .where(and(...conditions))
      .orderBy(desc(schema.costHistory.date));
  }

  async getLatestCostData(accountId: string, days: number = 30, provider?: schema.CloudProvider): Promise<schema.CostHistory[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return this.getCostHistory(accountId, startDate, undefined, provider);
  }

  // ==================== ALERT RULES ====================

  async createAlertRule(rule: schema.InsertAlertRule): Promise<schema.AlertRule> {
    const [created] = await db.insert(schema.alertRules)
      .values({ ...rule, organizationId: currentOrgId() })
      .returning();

    return created;
  }

  async getAlertRule(id: number): Promise<schema.AlertRule | undefined> {
    const [rule] = await db.select().from(schema.alertRules)
      .where(and(
        eq(schema.alertRules.id, id),
        eq(schema.alertRules.organizationId, currentOrgId()),
      ));
    return rule;
  }

  async getAllAlertRules(): Promise<schema.AlertRule[]> {
    return await db.select().from(schema.alertRules)
      .where(eq(schema.alertRules.organizationId, currentOrgId()));
  }

  async getEnabledAlertRules(): Promise<schema.AlertRule[]> {
    return await db.select()
      .from(schema.alertRules)
      .where(and(
        eq(schema.alertRules.isEnabled, 1),
        eq(schema.alertRules.organizationId, currentOrgId()),
      ));
  }

  async updateAlertRule(id: number, updates: Partial<schema.InsertAlertRule>): Promise<schema.AlertRule | undefined> {
    const { organizationId: _ignored, ...safeUpdates } = updates as Record<string, unknown>;

    const [updated] = await db.update(schema.alertRules)
      .set({ ...safeUpdates, updatedAt: new Date() })
      .where(and(
        eq(schema.alertRules.id, id),
        eq(schema.alertRules.organizationId, currentOrgId()),
      ))
      .returning();

    return updated;
  }

  async deleteAlertRule(id: number): Promise<boolean> {
    const result = await db.delete(schema.alertRules)
      .where(and(
        eq(schema.alertRules.id, id),
        eq(schema.alertRules.organizationId, currentOrgId()),
      ));

    return result.rowCount ? result.rowCount > 0 : false;
  }

  // ==================== REPORT SCHEDULES ====================

  async createReportSchedule(schedule: schema.InsertReportSchedule): Promise<schema.ReportSchedule> {
    const [created] = await db.insert(schema.reportSchedules)
      .values({ ...schedule, organizationId: currentOrgId() })
      .returning();

    return created;
  }

  async getReportSchedule(id: number): Promise<schema.ReportSchedule | undefined> {
    const [row] = await db.select().from(schema.reportSchedules)
      .where(and(
        eq(schema.reportSchedules.id, id),
        eq(schema.reportSchedules.organizationId, currentOrgId()),
      ));
    return row;
  }

  async getAllReportSchedules(): Promise<schema.ReportSchedule[]> {
    return await db.select().from(schema.reportSchedules)
      .where(eq(schema.reportSchedules.organizationId, currentOrgId()));
  }

  async getEnabledReportSchedules(): Promise<schema.ReportSchedule[]> {
    return await db.select()
      .from(schema.reportSchedules)
      .where(and(
        eq(schema.reportSchedules.isEnabled, 1),
        eq(schema.reportSchedules.organizationId, currentOrgId()),
      ));
  }

  async getDueReportSchedules(): Promise<schema.ReportSchedule[]> {
    return await db.select()
      .from(schema.reportSchedules)
      .where(
        and(
          eq(schema.reportSchedules.organizationId, currentOrgId()),
          eq(schema.reportSchedules.isEnabled, 1),
          lte(schema.reportSchedules.nextRunAt, new Date())
        )
      );
  }

  async updateReportSchedule(id: number, updates: Partial<schema.InsertReportSchedule>): Promise<schema.ReportSchedule | undefined> {
    const { organizationId: _ignored, ...safeUpdates } = updates as Record<string, unknown>;

    const [updated] = await db.update(schema.reportSchedules)
      .set({ ...safeUpdates, updatedAt: new Date() })
      .where(and(
        eq(schema.reportSchedules.id, id),
        eq(schema.reportSchedules.organizationId, currentOrgId()),
      ))
      .returning();

    return updated;
  }

  async deleteReportSchedule(id: number): Promise<boolean> {
    const result = await db.delete(schema.reportSchedules)
      .where(and(
        eq(schema.reportSchedules.id, id),
        eq(schema.reportSchedules.organizationId, currentOrgId()),
      ));

    return result.rowCount ? result.rowCount > 0 : false;
  }

  // ==================== FORECAST DATA ====================

  async saveForecastData(forecasts: schema.InsertForecastData[]): Promise<void> {
    if (forecasts.length === 0) return;

    const orgId = currentOrgId();
    await db.insert(schema.forecastData)
      .values(forecasts.map(f => ({ ...f, organizationId: orgId })))
      .onConflictDoNothing();
  }

  async getLatestForecasts(accountId: string, limit: number = 90, provider?: schema.CloudProvider): Promise<schema.ForecastData[]> {
    const conditions = [
      eq(schema.forecastData.organizationId, currentOrgId()),
      eq(schema.forecastData.accountId, accountId),
    ];

    if (provider) {
      conditions.push(eq(schema.forecastData.provider, provider));
    }

    return await db.select()
      .from(schema.forecastData)
      .where(and(...conditions))
      .orderBy(desc(schema.forecastData.forecastDate))
      .limit(limit);
  }

  // ==================== OPTIMIZATION RECOMMENDATIONS ====================

  async createOptimizationRecommendation(
    recommendation: schema.InsertOptimizationRecommendation
  ): Promise<schema.OptimizationRecommendation> {
    const [created] = await db.insert(schema.optimizationRecommendations)
      .values({ ...recommendation, organizationId: currentOrgId() })
      .returning();

    return created;
  }

  async getActiveRecommendations(accountId?: string, provider?: schema.CloudProvider): Promise<schema.OptimizationRecommendation[]> {
    const conditions = [
      eq(schema.optimizationRecommendations.organizationId, currentOrgId()),
      eq(schema.optimizationRecommendations.status, 'active'),
    ];

    if (accountId) {
      conditions.push(eq(schema.optimizationRecommendations.accountId, accountId));
    }
    if (provider) {
      conditions.push(eq(schema.optimizationRecommendations.provider, provider));
    }

    return await db.select()
      .from(schema.optimizationRecommendations)
      .where(and(...conditions))
      .orderBy(desc(schema.optimizationRecommendations.potentialSavings));
  }

  async updateOptimizationRecommendation(
    id: number,
    updates: Partial<schema.InsertOptimizationRecommendation>
  ): Promise<schema.OptimizationRecommendation | undefined> {
    const { organizationId: _ignored, ...safeUpdates } = updates as Record<string, unknown>;

    const [updated] = await db.update(schema.optimizationRecommendations)
      .set({ ...safeUpdates, updatedAt: new Date() })
      .where(and(
        eq(schema.optimizationRecommendations.id, id),
        eq(schema.optimizationRecommendations.organizationId, currentOrgId()),
      ))
      .returning();

    return updated;
  }

  // Remove existing 'active' recommendations so a regeneration replaces them
  // instead of appending duplicates. User-actioned ones (implemented/dismissed)
  // are not 'active', so they are preserved.
  async clearActiveRecommendations(provider?: schema.CloudProvider): Promise<number> {
    const conditions = [
      eq(schema.optimizationRecommendations.organizationId, currentOrgId()),
      eq(schema.optimizationRecommendations.status, 'active'),
    ];
    if (provider) {
      conditions.push(eq(schema.optimizationRecommendations.provider, provider));
    }
    const deleted = await db.delete(schema.optimizationRecommendations)
      .where(and(...conditions))
      .returning({ id: schema.optimizationRecommendations.id });
    return deleted.length;
  }

  // ==================== MULTI-CLOUD ACCOUNTS ====================

  async createCloudAccount(account: schema.InsertCloudAccount): Promise<schema.CloudAccount> {
    const orgId = currentOrgId();
    console.log(`[Storage] Creating ${account.provider} cloud account for org ${orgId}`);

    // Credentials are encrypted at rest; the plaintext never reaches the column.
    const encryptedCredentials = encrypt(JSON.stringify(account.credentials));

    const [created] = await db.insert(schema.cloudAccounts)
      .values({ ...account, organizationId: orgId, credentials: encryptedCredentials as any })
      .returning();

    console.log(`[Storage] Cloud account created with ID: ${created.id}`);

    return created;
  }

  async getCloudAccount(id: number): Promise<schema.CloudAccount | undefined> {
    const [account] = await db.select().from(schema.cloudAccounts)
      .where(and(
        eq(schema.cloudAccounts.id, id),
        eq(schema.cloudAccounts.organizationId, currentOrgId()),
      ));

    if (!account) return undefined;

    const decryptedCredentials = decrypt(account.credentials as string);
    return { ...account, credentials: JSON.parse(decryptedCredentials) };
  }

  async getAllCloudAccounts(provider?: schema.CloudProvider): Promise<schema.CloudAccount[]> {
    const conditions = [eq(schema.cloudAccounts.organizationId, currentOrgId())];

    if (provider) {
      conditions.push(eq(schema.cloudAccounts.provider, provider));
    }

    const accounts = await db.select().from(schema.cloudAccounts).where(and(...conditions));

    return accounts.map(account => ({
      ...account,
      credentials: JSON.parse(decrypt(account.credentials as string))
    }));
  }

  async getActiveCloudAccounts(provider?: schema.CloudProvider): Promise<schema.CloudAccount[]> {
    const conditions = [
      eq(schema.cloudAccounts.organizationId, currentOrgId()),
      eq(schema.cloudAccounts.isActive, true),
    ];

    if (provider) {
      conditions.push(eq(schema.cloudAccounts.provider, provider));
    }

    const accounts = await db.select()
      .from(schema.cloudAccounts)
      .where(and(...conditions));

    return accounts.map(account => ({
      ...account,
      credentials: JSON.parse(decrypt(account.credentials as string))
    }));
  }

  async updateCloudAccount(id: number, updates: Partial<schema.InsertCloudAccount>): Promise<schema.CloudAccount | undefined> {
    const { organizationId: _ignored, ...rest } = updates as Record<string, unknown>;

    const processedUpdates = updates.credentials
      ? { ...rest, credentials: encrypt(JSON.stringify(updates.credentials)) as any }
      : rest;

    const [updated] = await db.update(schema.cloudAccounts)
      .set({ ...processedUpdates, updatedAt: new Date() })
      .where(and(
        eq(schema.cloudAccounts.id, id),
        eq(schema.cloudAccounts.organizationId, currentOrgId()),
      ))
      .returning();

    if (!updated) return undefined;

    return {
      ...updated,
      credentials: JSON.parse(decrypt(updated.credentials as string))
    };
  }

  async deleteCloudAccount(id: number): Promise<boolean> {
    const result = await db.delete(schema.cloudAccounts)
      .where(and(
        eq(schema.cloudAccounts.id, id),
        eq(schema.cloudAccounts.organizationId, currentOrgId()),
      ));

    return result.rowCount ? result.rowCount > 0 : false;
  }

  // ==================== BUDGETS ====================

  async createBudget(budget: schema.InsertBudget): Promise<schema.Budget> {
    const [created] = await db.insert(schema.budgets)
      .values({ ...budget, organizationId: currentOrgId() })
      .returning();

    return created;
  }

  async getBudget(id: number): Promise<schema.Budget | undefined> {
    const [row] = await db.select().from(schema.budgets)
      .where(and(
        eq(schema.budgets.id, id),
        eq(schema.budgets.organizationId, currentOrgId()),
      ));
    return row;
  }

  async getAllBudgets(provider?: schema.CloudProvider): Promise<schema.Budget[]> {
    const conditions = [eq(schema.budgets.organizationId, currentOrgId())];

    if (provider) {
      conditions.push(eq(schema.budgets.provider, provider));
    }

    return await db.select().from(schema.budgets).where(and(...conditions));
  }

  async getActiveBudgets(provider?: schema.CloudProvider): Promise<schema.Budget[]> {
    const conditions = [
      eq(schema.budgets.organizationId, currentOrgId()),
      eq(schema.budgets.isActive, true),
    ];

    if (provider) {
      conditions.push(eq(schema.budgets.provider, provider));
    }

    return await db.select()
      .from(schema.budgets)
      .where(and(...conditions));
  }

  async updateBudget(id: number, updates: Partial<schema.InsertBudget>): Promise<schema.Budget | undefined> {
    const { organizationId: _ignored, ...safeUpdates } = updates as Record<string, unknown>;

    const [updated] = await db.update(schema.budgets)
      .set({ ...safeUpdates, updatedAt: new Date() })
      .where(and(
        eq(schema.budgets.id, id),
        eq(schema.budgets.organizationId, currentOrgId()),
      ))
      .returning();

    return updated;
  }

  async deleteBudget(id: number): Promise<boolean> {
    const result = await db.delete(schema.budgets)
      .where(and(
        eq(schema.budgets.id, id),
        eq(schema.budgets.organizationId, currentOrgId()),
      ));

    return result.rowCount ? result.rowCount > 0 : false;
  }

  // ==================== RESOURCE INVENTORY ====================

  async createResourceInventory(resource: schema.InsertResourceInventory): Promise<schema.ResourceInventory> {
    const [created] = await db.insert(schema.resourceInventory)
      .values({ ...resource, organizationId: currentOrgId() })
      .returning();

    return created;
  }

  async getResourceInventory(provider?: schema.CloudProvider, state?: string): Promise<schema.ResourceInventory[]> {
    const conditions = [eq(schema.resourceInventory.organizationId, currentOrgId())];

    if (provider) {
      conditions.push(eq(schema.resourceInventory.provider, provider));
    }
    if (state) {
      conditions.push(eq(schema.resourceInventory.state, state));
    }

    return await db.select()
      .from(schema.resourceInventory)
      .where(and(...conditions))
      .orderBy(desc(schema.resourceInventory.lastSeenAt));
  }

  async getIdleResources(provider?: schema.CloudProvider): Promise<schema.ResourceInventory[]> {
    const conditions = [
      eq(schema.resourceInventory.organizationId, currentOrgId()),
      eq(schema.resourceInventory.state, 'idle'),
    ];

    if (provider) {
      conditions.push(eq(schema.resourceInventory.provider, provider));
    }

    return await db.select()
      .from(schema.resourceInventory)
      .where(and(...conditions));
  }

  // ==================== TAG ANALYSIS ====================

  async createTagAnalysis(analysis: schema.InsertTagAnalysis): Promise<schema.TagAnalysis> {
    const [created] = await db.insert(schema.tagAnalysis)
      .values({ ...analysis, organizationId: currentOrgId() })
      .returning();

    return created;
  }

  async getTagAnalysis(provider?: schema.CloudProvider, period?: string): Promise<schema.TagAnalysis[]> {
    const conditions = [eq(schema.tagAnalysis.organizationId, currentOrgId())];

    if (provider) {
      conditions.push(eq(schema.tagAnalysis.provider, provider));
    }
    if (period) {
      conditions.push(eq(schema.tagAnalysis.period, period));
    }

    return await db.select()
      .from(schema.tagAnalysis)
      .where(and(...conditions))
      .orderBy(desc(schema.tagAnalysis.periodDate));
  }

  // ==================== SAVINGS PLANS ====================

  async createSavingsPlan(plan: schema.InsertSavingsPlan): Promise<schema.SavingsPlan> {
    const [created] = await db.insert(schema.savingsPlans)
      .values({ ...plan, organizationId: currentOrgId() })
      .returning();

    return created;
  }

  async getSavingsPlans(provider?: schema.CloudProvider, status?: string): Promise<schema.SavingsPlan[]> {
    const conditions = [eq(schema.savingsPlans.organizationId, currentOrgId())];

    if (provider) {
      conditions.push(eq(schema.savingsPlans.provider, provider));
    }
    if (status) {
      conditions.push(eq(schema.savingsPlans.status, status));
    }

    return await db.select()
      .from(schema.savingsPlans)
      .where(and(...conditions))
      .orderBy(desc(schema.savingsPlans.createdAt));
  }

  // ==================== ANOMALY EVENTS ====================

  async createAnomalyEvent(anomaly: schema.InsertAnomalyEvent): Promise<schema.AnomalyEvent> {
    const [created] = await db.insert(schema.anomalyEvents)
      .values({ ...anomaly, organizationId: currentOrgId() })
      .returning();

    return created;
  }

  async getAnomalyEvents(provider?: schema.CloudProvider, status?: string): Promise<schema.AnomalyEvent[]> {
    const conditions = [eq(schema.anomalyEvents.organizationId, currentOrgId())];

    if (provider) {
      conditions.push(eq(schema.anomalyEvents.provider, provider));
    }
    if (status) {
      conditions.push(eq(schema.anomalyEvents.status, status));
    }

    return await db.select()
      .from(schema.anomalyEvents)
      .where(and(...conditions))
      .orderBy(desc(schema.anomalyEvents.detectedAt));
  }

  async updateAnomalyEvent(id: number, updates: Partial<schema.InsertAnomalyEvent>): Promise<schema.AnomalyEvent | undefined> {
    const { organizationId: _ignored, ...safeUpdates } = updates as Record<string, unknown>;

    const [updated] = await db.update(schema.anomalyEvents)
      .set(safeUpdates)
      .where(and(
        eq(schema.anomalyEvents.id, id),
        eq(schema.anomalyEvents.organizationId, currentOrgId()),
      ))
      .returning();

    return updated;
  }

  // ==================== REPORT CACHE ====================

  async getReportCache(cacheKey: string): Promise<schema.ReportCache | undefined> {
    const [row] = await db.select().from(schema.reportCache)
      .where(and(
        eq(schema.reportCache.cacheKey, cacheKey),
        eq(schema.reportCache.organizationId, currentOrgId()),
      ));
    return row;
  }

  async upsertReportCache(entry: schema.InsertReportCache): Promise<void> {
    await db.insert(schema.reportCache)
      .values({ ...entry, organizationId: currentOrgId() })
      // Conflict target matches idx_report_cache_org_key — cache keys collide
      // across tenants (same provider, same dates), so the tenant is part of the
      // key or one customer's report would overwrite another's.
      .onConflictDoUpdate({
        target: [schema.reportCache.organizationId, schema.reportCache.cacheKey],
        set: {
          reportData: entry.reportData,
          fetchedAt: new Date(),
          updatedAt: new Date(),
        },
      });
  }

  // ==================== AUDIT LOG ====================

  async getAuditLogs(options: { limit?: number; offset?: number; action?: string } = {}): Promise<schema.AuditLog[]> {
    const conditions = [eq(schema.auditLogs.organizationId, currentOrgId())];
    if (options.action) {
      conditions.push(eq(schema.auditLogs.action, options.action));
    }

    return await db.select()
      .from(schema.auditLogs)
      .where(and(...conditions))
      .orderBy(desc(schema.auditLogs.createdAt))
      .limit(Math.min(options.limit ?? 100, 500))
      .offset(options.offset ?? 0);
  }

  // ==================== PLATFORM (cross-tenant, no tenant context) ====================

  /**
   * Every active tenant. Used by schedulers to iterate organizations and run
   * their work inside runAsSystem(org.id, ...). This is the only intended way to
   * touch more than one tenant.
   */
  async listActiveOrganizations(): Promise<schema.Organization[]> {
    return await db.select()
      .from(schema.organizations)
      .where(eq(schema.organizations.status, 'active'))
      .orderBy(schema.organizations.id);
  }

  async getOrganization(id: number): Promise<schema.Organization | undefined> {
    const [org] = await db.select().from(schema.organizations)
      .where(eq(schema.organizations.id, id));
    return org;
  }
}

// Export singleton instance
export const storage = new DbStorage();
