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
    subscriptionId: string,
    startDate?: Date,
    endDate?: Date
  ): Promise<schema.CostHistory[]> {
    const conditions = [eq(schema.costHistory.subscriptionId, subscriptionId)];
    
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
  
  async getLatestCostData(subscriptionId: string, days: number = 30): Promise<schema.CostHistory[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    return this.getCostHistory(subscriptionId, startDate);
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
  
  async getLatestForecasts(subscriptionId: string, limit: number = 90): Promise<schema.ForecastData[]> {
    return await db.select()
      .from(schema.forecastData)
      .where(eq(schema.forecastData.subscriptionId, subscriptionId))
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
  
  async getActiveRecommendations(subscriptionId?: string): Promise<schema.OptimizationRecommendation[]> {
    const conditions = [eq(schema.optimizationRecommendations.status, 'active')];
    
    if (subscriptionId) {
      conditions.push(eq(schema.optimizationRecommendations.subscriptionId, subscriptionId));
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
}

// Export singleton instance
export const storage = new DbStorage();
