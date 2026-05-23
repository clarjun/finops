import { db } from './db';
import { eq, and, gte, lte, desc } from 'drizzle-orm';
import * as schema from '@shared/schema';
import { encrypt, decrypt, encryptAzureConfig, decryptAzureConfig } from './encryption';

// Database Storage Layer - replaces in-memory storage with PostgreSQL persistence
export class DbStorage {
  
  // ==================== AZURE ACCOUNTS ====================
  
  async createAzureAccount(account: schema.InsertAzureAccount): Promise<schema.AzureAccount> {
    // Encrypt sensitive fields before storage
    const encryptedAccount = encryptAzureConfig(account);
    
    const [created] = await db.insert(schema.azureAccounts)
      .values(encryptedAccount)
      .returning();
    
    // Return decrypted version
    return decryptAzureConfig(created);
  }
  
  async getAzureAccount(id: number): Promise<schema.AzureAccount | undefined> {
    const account = await db.query.azureAccounts.findFirst({
      where: eq(schema.azureAccounts.id, id),
    });
    
    if (!account) return undefined;
    return decryptAzureConfig(account);
  }
  
  async getAllAzureAccounts(): Promise<schema.AzureAccount[]> {
    const accounts = await db.select().from(schema.azureAccounts);
    return accounts.map(decryptAzureConfig);
  }
  
  async getActiveAzureAccounts(): Promise<schema.AzureAccount[]> {
    const accounts = await db.select()
      .from(schema.azureAccounts)
      .where(eq(schema.azureAccounts.isActive, 1));
    
    return accounts.map(decryptAzureConfig);
  }
  
  async updateAzureAccount(id: number, updates: Partial<schema.InsertAzureAccount>): Promise<schema.AzureAccount | undefined> {
    // Encrypt sensitive fields if present
    const encryptedUpdates = updates.tenantId || updates.clientId || updates.clientSecret
      ? encryptAzureConfig(updates)
      : updates;
    
    const [updated] = await db.update(schema.azureAccounts)
      .set({ ...encryptedUpdates, updatedAt: new Date() })
      .where(eq(schema.azureAccounts.id, id))
      .returning();
    
    if (!updated) return undefined;
    return decryptAzureConfig(updated);
  }
  
  async deleteAzureAccount(id: number): Promise<boolean> {
    const result = await db.delete(schema.azureAccounts)
      .where(eq(schema.azureAccounts.id, id));
    
    return result.rowCount ? result.rowCount > 0 : false;
  }
  
  // ==================== COST HISTORY ====================
  
  async saveCostHistory(records: schema.InsertCostHistory[]): Promise<void> {
    if (records.length === 0) return;
    
    // Batch insert for performance
    await db.insert(schema.costHistory)
      .values(records)
      .onConflictDoNothing(); // Avoid duplicate entries
  }
  
  async getCostHistory(
    accountId: string,
    startDate?: Date,
    endDate?: Date,
    provider?: schema.CloudProvider
  ): Promise<schema.CostHistory[]> {
    const conditions = [eq(schema.costHistory.accountId, accountId)];
    
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
    const conditions = [];
    
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
    
    if (conditions.length === 0) {
      // No filters - return all
      return await db.select()
        .from(schema.costHistory)
        .orderBy(desc(schema.costHistory.date));
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
      .values(rule)
      .returning();
    
    return created;
  }
  
  async getAlertRule(id: number): Promise<schema.AlertRule | undefined> {
    return await db.query.alertRules.findFirst({
      where: eq(schema.alertRules.id, id),
    });
  }
  
  async getAllAlertRules(): Promise<schema.AlertRule[]> {
    return await db.select().from(schema.alertRules);
  }
  
  async getEnabledAlertRules(): Promise<schema.AlertRule[]> {
    return await db.select()
      .from(schema.alertRules)
      .where(eq(schema.alertRules.isEnabled, 1));
  }
  
  async updateAlertRule(id: number, updates: Partial<schema.InsertAlertRule>): Promise<schema.AlertRule | undefined> {
    const [updated] = await db.update(schema.alertRules)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(schema.alertRules.id, id))
      .returning();
    
    return updated;
  }
  
  async deleteAlertRule(id: number): Promise<boolean> {
    const result = await db.delete(schema.alertRules)
      .where(eq(schema.alertRules.id, id));
    
    return result.rowCount ? result.rowCount > 0 : false;
  }
  
  // ==================== REPORT SCHEDULES ====================
  
  async createReportSchedule(schedule: schema.InsertReportSchedule): Promise<schema.ReportSchedule> {
    const [created] = await db.insert(schema.reportSchedules)
      .values(schedule)
      .returning();
    
    return created;
  }
  
  async getReportSchedule(id: number): Promise<schema.ReportSchedule | undefined> {
    return await db.query.reportSchedules.findFirst({
      where: eq(schema.reportSchedules.id, id),
    });
  }
  
  async getAllReportSchedules(): Promise<schema.ReportSchedule[]> {
    return await db.select().from(schema.reportSchedules);
  }
  
  async getEnabledReportSchedules(): Promise<schema.ReportSchedule[]> {
    return await db.select()
      .from(schema.reportSchedules)
      .where(eq(schema.reportSchedules.isEnabled, 1));
  }
  
  async getDueReportSchedules(): Promise<schema.ReportSchedule[]> {
    return await db.select()
      .from(schema.reportSchedules)
      .where(
        and(
          eq(schema.reportSchedules.isEnabled, 1),
          lte(schema.reportSchedules.nextRunAt, new Date())
        )
      );
  }
  
  async updateReportSchedule(id: number, updates: Partial<schema.InsertReportSchedule>): Promise<schema.ReportSchedule | undefined> {
    const [updated] = await db.update(schema.reportSchedules)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(schema.reportSchedules.id, id))
      .returning();
    
    return updated;
  }
  
  async deleteReportSchedule(id: number): Promise<boolean> {
    const result = await db.delete(schema.reportSchedules)
      .where(eq(schema.reportSchedules.id, id));
    
    return result.rowCount ? result.rowCount > 0 : false;
  }
  
  // ==================== FORECAST DATA ====================
  
  async saveForecastData(forecasts: schema.InsertForecastData[]): Promise<void> {
    if (forecasts.length === 0) return;
    
    await db.insert(schema.forecastData)
      .values(forecasts)
      .onConflictDoNothing();
  }
  
  async getLatestForecasts(accountId: string, limit: number = 90, provider?: schema.CloudProvider): Promise<schema.ForecastData[]> {
    const conditions = [eq(schema.forecastData.accountId, accountId)];
    
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
      .values(recommendation)
      .returning();
    
    return created;
  }
  
  async getActiveRecommendations(accountId?: string, provider?: schema.CloudProvider): Promise<schema.OptimizationRecommendation[]> {
    const conditions = [eq(schema.optimizationRecommendations.status, 'active')];
    
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
    const [updated] = await db.update(schema.optimizationRecommendations)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(schema.optimizationRecommendations.id, id))
      .returning();
    
    return updated;
  }
  
  // ==================== MULTI-CLOUD ACCOUNTS ====================
  
  async createCloudAccount(account: schema.InsertCloudAccount): Promise<schema.CloudAccount> {
    console.log(`[Storage] Creating cloud account for provider: ${account.provider}`);
    console.log(`[Storage] Credentials before encryption:`, Object.keys(account.credentials || {}));
    
    // Encrypt credentials before storage
    const credentialsJson = JSON.stringify(account.credentials);
    const encryptedCredentials = encrypt(credentialsJson);
    
    console.log(`[Storage] Credentials encrypted, length: ${encryptedCredentials.length}`);
    
    const [created] = await db.insert(schema.cloudAccounts)
      .values({ ...account, credentials: encryptedCredentials as any })
      .returning();
    
    console.log(`[Storage] Cloud account created with ID: ${created.id}`);
    
    return created;
  }
  
  async getCloudAccount(id: number): Promise<schema.CloudAccount | undefined> {
    const account = await db.query.cloudAccounts.findFirst({
      where: eq(schema.cloudAccounts.id, id),
    });
    
    if (!account) return undefined;
    
    // Decrypt credentials
    const decryptedCredentials = decrypt(account.credentials as string);
    return { ...account, credentials: JSON.parse(decryptedCredentials) };
  }
  
  async getAllCloudAccounts(provider?: schema.CloudProvider): Promise<schema.CloudAccount[]> {
    const query = db.select().from(schema.cloudAccounts);
    
    const accounts = provider
      ? await query.where(eq(schema.cloudAccounts.provider, provider))
      : await query;
    
    // Decrypt credentials
    return accounts.map(account => ({
      ...account,
      credentials: JSON.parse(decrypt(account.credentials as string))
    }));
  }
  
  async getActiveCloudAccounts(provider?: schema.CloudProvider): Promise<schema.CloudAccount[]> {
    const conditions = [eq(schema.cloudAccounts.isActive, true)];
    
    if (provider) {
      conditions.push(eq(schema.cloudAccounts.provider, provider));
    }
    
    const accounts = await db.select()
      .from(schema.cloudAccounts)
      .where(and(...conditions));
    
    // Decrypt credentials
    return accounts.map(account => ({
      ...account,
      credentials: JSON.parse(decrypt(account.credentials as string))
    }));
  }
  
  async updateCloudAccount(id: number, updates: Partial<schema.InsertCloudAccount>): Promise<schema.CloudAccount | undefined> {
    // Encrypt credentials if provided
    const processedUpdates = updates.credentials
      ? { ...updates, credentials: encrypt(JSON.stringify(updates.credentials)) as any }
      : updates;
    
    const [updated] = await db.update(schema.cloudAccounts)
      .set({ ...processedUpdates, updatedAt: new Date() })
      .where(eq(schema.cloudAccounts.id, id))
      .returning();
    
    if (!updated) return undefined;
    
    // Decrypt credentials
    return {
      ...updated,
      credentials: JSON.parse(decrypt(updated.credentials as string))
    };
  }
  
  async deleteCloudAccount(id: number): Promise<boolean> {
    const result = await db.delete(schema.cloudAccounts)
      .where(eq(schema.cloudAccounts.id, id));
    
    return result.rowCount ? result.rowCount > 0 : false;
  }
  
  // ==================== BUDGETS ====================
  
  async createBudget(budget: schema.InsertBudget): Promise<schema.Budget> {
    const [created] = await db.insert(schema.budgets)
      .values(budget)
      .returning();
    
    return created;
  }
  
  async getBudget(id: number): Promise<schema.Budget | undefined> {
    return await db.query.budgets.findFirst({
      where: eq(schema.budgets.id, id),
    });
  }
  
  async getAllBudgets(provider?: schema.CloudProvider): Promise<schema.Budget[]> {
    if (!provider) {
      return await db.select().from(schema.budgets);
    }
    
    return await db.select()
      .from(schema.budgets)
      .where(eq(schema.budgets.provider, provider));
  }
  
  async getActiveBudgets(provider?: schema.CloudProvider): Promise<schema.Budget[]> {
    const conditions = [eq(schema.budgets.isActive, true)];
    
    if (provider) {
      conditions.push(eq(schema.budgets.provider, provider));
    }
    
    return await db.select()
      .from(schema.budgets)
      .where(and(...conditions));
  }
  
  async updateBudget(id: number, updates: Partial<schema.InsertBudget>): Promise<schema.Budget | undefined> {
    const [updated] = await db.update(schema.budgets)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(schema.budgets.id, id))
      .returning();
    
    return updated;
  }
  
  async deleteBudget(id: number): Promise<boolean> {
    const result = await db.delete(schema.budgets)
      .where(eq(schema.budgets.id, id));
    
    return result.rowCount ? result.rowCount > 0 : false;
  }
  
  // ==================== RESOURCE INVENTORY ====================
  
  async createResourceInventory(resource: schema.InsertResourceInventory): Promise<schema.ResourceInventory> {
    const [created] = await db.insert(schema.resourceInventory)
      .values(resource)
      .returning();
    
    return created;
  }
  
  async getResourceInventory(provider?: schema.CloudProvider, state?: string): Promise<schema.ResourceInventory[]> {
    const conditions = [];
    
    if (provider) {
      conditions.push(eq(schema.resourceInventory.provider, provider));
    }
    if (state) {
      conditions.push(eq(schema.resourceInventory.state, state));
    }
    
    return await db.select()
      .from(schema.resourceInventory)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.resourceInventory.lastSeenAt));
  }
  
  async getIdleResources(provider?: schema.CloudProvider): Promise<schema.ResourceInventory[]> {
    const conditions = [eq(schema.resourceInventory.state, 'idle')];
    
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
      .values(analysis)
      .returning();
    
    return created;
  }
  
  async getTagAnalysis(provider?: schema.CloudProvider, period?: string): Promise<schema.TagAnalysis[]> {
    const conditions = [];
    
    if (provider) {
      conditions.push(eq(schema.tagAnalysis.provider, provider));
    }
    if (period) {
      conditions.push(eq(schema.tagAnalysis.period, period));
    }
    
    return await db.select()
      .from(schema.tagAnalysis)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.tagAnalysis.periodDate));
  }
  
  // ==================== SAVINGS PLANS ====================
  
  async createSavingsPlan(plan: schema.InsertSavingsPlan): Promise<schema.SavingsPlan> {
    const [created] = await db.insert(schema.savingsPlans)
      .values(plan)
      .returning();
    
    return created;
  }
  
  async getSavingsPlans(provider?: schema.CloudProvider, status?: string): Promise<schema.SavingsPlan[]> {
    const conditions = [];
    
    if (provider) {
      conditions.push(eq(schema.savingsPlans.provider, provider));
    }
    if (status) {
      conditions.push(eq(schema.savingsPlans.status, status));
    }
    
    return await db.select()
      .from(schema.savingsPlans)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.savingsPlans.createdAt));
  }
  
  // ==================== ANOMALY EVENTS ====================
  
  async createAnomalyEvent(anomaly: schema.InsertAnomalyEvent): Promise<schema.AnomalyEvent> {
    const [created] = await db.insert(schema.anomalyEvents)
      .values(anomaly)
      .returning();
    
    return created;
  }
  
  async getAnomalyEvents(provider?: schema.CloudProvider, status?: string): Promise<schema.AnomalyEvent[]> {
    const conditions = [];
    
    if (provider) {
      conditions.push(eq(schema.anomalyEvents.provider, provider));
    }
    if (status) {
      conditions.push(eq(schema.anomalyEvents.status, status));
    }
    
    return await db.select()
      .from(schema.anomalyEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.anomalyEvents.detectedAt));
  }
  
  async updateAnomalyEvent(id: number, updates: Partial<schema.InsertAnomalyEvent>): Promise<schema.AnomalyEvent | undefined> {
    const [updated] = await db.update(schema.anomalyEvents)
      .set(updates)
      .where(eq(schema.anomalyEvents.id, id))
      .returning();
    
    return updated;
  }

  // ==================== REPORT CACHE ====================

  async getReportCache(cacheKey: string): Promise<schema.ReportCache | undefined> {
    return await db.query.reportCache.findFirst({
      where: eq(schema.reportCache.cacheKey, cacheKey),
    });
  }

  async upsertReportCache(entry: schema.InsertReportCache): Promise<void> {
    await db.insert(schema.reportCache)
      .values(entry)
      .onConflictDoUpdate({
        target: schema.reportCache.cacheKey,
        set: {
          reportData: entry.reportData,
          fetchedAt: new Date(),
          updatedAt: new Date(),
        },
      });
  }
}

// Export singleton instance
export const storage = new DbStorage();
