import type { Express } from "express";
import { createServer, type Server } from "http";
import { readFileSync } from "fs";
import { join } from "path";
import { eq, and, gte, lte } from "drizzle-orm";
import { azureCostResponseSchema, aiQueryRequestSchema, azureConfigSchema, type AzureConfig, azureAccounts, costHistory, insertCostHistorySchema, forecastData } from "@shared/schema";
import { processAzureCostData } from "./utils/process-cost-data";
import { runPythonScript } from "./utils/python-runner";
import { openai } from "./openai-client";
import { AzureCostManagementClient } from "./azure-client";
import { db } from "./db";
import { storage } from "./storage";
import { 
  generateCostHistoryCSV, 
  generateServiceBreakdownCSV, 
  generateAnomaliesCSV, 
  generateForecastCSV,
  generateComprehensiveReportCSV 
} from "./utils/csv-generator";

// Load sample Azure cost data for initial display
let cachedCostData: any = null;
let azureClient: AzureCostManagementClient | null = null;
let currentAzureAccountId: number | null = null;
let autoRefreshInterval: NodeJS.Timeout | null = null;

function loadSampleData() {
  if (!cachedCostData) {
    const samplePath = join(process.cwd(), "attached_assets", "azure_1760597470327.json");
    const sampleData = JSON.parse(readFileSync(samplePath, "utf-8"));
    cachedCostData = processAzureCostData(sampleData);
  }
  return cachedCostData;
}

// Save cost data to historical database for ML training
async function saveCostDataToHistory(azureResponse: any, subscriptionId: string) {
  try {
    const rows = azureResponse.properties.rows;
    
    // Map Azure response rows to cost history records
    // Row format: [PreTaxCost, UsageDate, SubscriptionName, ResourceGroup, ServiceName, Currency]
    const costRecords = rows.map((row: any) => ({
      date: new Date(String(row[1]).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')),
      subscriptionId: subscriptionId, // Use actual subscription ID from config
      subscriptionName: row[2] || 'unknown',
      resourceGroup: row[3] || 'unknown',
      serviceName: row[4] || 'unknown',
      cost: String(row[0]),
      currency: row[5] || 'USD',
    }));

    // Use upsert to avoid duplicates on repeated refreshes
    // Delete existing records for the same date range and subscription before inserting
    const dates = Array.from(new Set(costRecords.map((r: any) => r.date)));
    if (dates.length > 0) {
      const dateTimes = dates.map((d: unknown) => (d as Date).getTime());
      const minDate = new Date(Math.min(...dateTimes));
      const maxDate = new Date(Math.max(...dateTimes));
      
      await db
        .delete(costHistory)
        .where(
          and(
            eq(costHistory.subscriptionId, subscriptionId),
            gte(costHistory.date, minDate),
            lte(costHistory.date, maxDate)
          )
        );
    }

    // Insert cost records in batches to avoid timeout
    const batchSize = 100;
    for (let i = 0; i < costRecords.length; i += batchSize) {
      const batch = costRecords.slice(i, i + batchSize);
      await db.insert(costHistory).values(batch);
    }
    
    console.log(`Saved ${costRecords.length} cost records to database for subscription ${subscriptionId}`);
  } catch (error) {
    console.error('Error saving cost data to database:', error);
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Get processed cost data
  app.get("/api/cost-data", async (_req, res) => {
    try {
      const processedData = loadSampleData();
      res.json(processedData);
    } catch (error) {
      res.status(500).json({ error: "Failed to process cost data" });
    }
  });

  // Update cost data from Azure response
  app.post("/api/cost-data", async (req, res) => {
    try {
      const validated = azureCostResponseSchema.parse(req.body.azureResponse);
      const processedData = processAzureCostData(validated);
      cachedCostData = processedData;
      res.json(processedData);
    } catch (error) {
      res.status(400).json({ error: "Invalid Azure cost data format" });
    }
  });

  // Detect anomalies using Python ML algorithm
  app.get("/api/anomalies", async (_req, res) => {
    try {
      const costData = loadSampleData();
      const anomalyResult = await runPythonScript("anomaly_detection.py", costData);
      res.json(anomalyResult);
    } catch (error) {
      console.error("Anomaly detection error:", error);
      res.status(500).json({
        anomalies: [],
        insights: ["Anomaly detection is currently unavailable"],
        recommendations: [],
      });
    }
  });

  // AI-powered natural language query analysis
  app.post("/api/analyze", async (req, res) => {
    try {
      const { query } = req.body;
      
      if (!query || typeof query !== 'string') {
        return res.status(400).json({ 
          answer: "Invalid query format", 
          success: false 
        });
      }
      
      // Get cost data from server cache instead of trusting client payload
      const costData = cachedCostData || loadSampleData();

      // Get anomaly data for comprehensive analysis
      let anomalyData: any = null;
      try {
        anomalyData = await runPythonScript("anomaly_detection.py", costData);
      } catch {
        // Continue without anomaly data if detection fails
      }

      // Prepare comprehensive context for AI
      const context = `You are an AI assistant analyzing Azure cloud spending data. Answer questions clearly and concisely based on the data provided.

COST SUMMARY:
- Total Cost: $${costData.totalCost.toFixed(2)}
- Average Daily Cost: $${costData.avgDailyCost.toFixed(2)}
- Top Service: ${costData.topService.name} ($${costData.topService.cost.toFixed(2)})
- Number of Services: ${costData.serviceCount}
- Peak Day: ${costData.peakDay.date} ($${costData.peakDay.cost.toFixed(2)})

TOP 10 SERVICES BY COST:
${costData.serviceBreakdown.slice(0, 10).map((s: any, i: number) => 
  `${i + 1}. ${s.name}: $${s.cost.toFixed(2)} (${s.percentage.toFixed(1)}%)`
).join('\n')}

DAILY COST TRENDS (Last 30 days):
${costData.dailyTrends.map((d: any) => 
  `${d.date}: $${d.cost.toFixed(2)}`
).join('\n')}

${anomalyData?.anomalies?.length > 0 ? `DETECTED SPENDING ANOMALIES:
${anomalyData.anomalies.map((a: any) => 
  `- ${a.date}: $${a.cost.toFixed(2)} (${a.type}, ${a.severity} severity) - ${a.description}`
).join('\n')}

INSIGHTS:
${anomalyData.insights.join('\n')}` : ''}

SUBSCRIPTIONS: ${costData.subscriptions.join(', ')}

When answering:
- For "which services" questions: list the top services from the service breakdown
- For "trend" questions: analyze the daily trends data
- For "anomaly" or "unusual" questions: reference the detected anomalies
- Provide specific numbers and percentages from the data
- Be concise and actionable`;

      // Log context length for debugging
      console.log(`AI Query context length: ${context.length} characters`);
      console.log(`User query: "${query}"`);
      console.log(`Anomaly data available:`, anomalyData?.anomalies?.length || 0, 'anomalies');
      
      // Log first 500 chars of context for debugging
      if (query.toLowerCase().includes('anomal')) {
        console.log('Context preview for anomaly query:',context.substring(0, 500));
      }

      // the newest OpenAI model is "gpt-5" which was released August 7, 2025. do not change this unless explicitly requested by the user
      const completion = await openai.chat.completions.create({
        model: "gpt-5",
        messages: [
          { role: "system", content: context },
          { role: "user", content: query }
        ],
        max_completion_tokens: 500,
      });

      console.log(`OpenAI completion choices:`, completion.choices?.length || 0);
      console.log(`OpenAI response content:`, completion.choices[0]?.message?.content?.substring(0, 100) || "NONE");
      
      if (!completion.choices[0]?.message?.content) {
        console.log('OpenAI response was empty - full completion:', JSON.stringify(completion, null, 2));
      }

      let answer = completion.choices[0]?.message?.content;
      
      // If OpenAI failed to generate an answer, provide data-driven fallback
      if (!answer || answer.trim().length === 0) {
        console.log('OpenAI returned empty response, using data-driven fallback');
        console.log('Query lower:', query.toLowerCase());
        
        // Generate fallback answer based on query type
        if (query.toLowerCase().includes('anomal')) {
          console.log('Taking anomaly fallback branch');
          if (anomalyData?.anomalies?.length > 0) {
            answer = `I detected ${anomalyData.anomalies.length} spending anomalies:\n\n` +
              anomalyData.anomalies.slice(0, 5).map((a: any) => 
                `• ${a.date}: $${a.cost.toFixed(2)} - ${a.description} (${a.severity} severity)`
              ).join('\n') +
              (anomalyData.insights?.length > 0 ? `\n\nKey insights:\n${anomalyData.insights.slice(0, 3).map((i: any) => `• ${i}`).join('\n')}` : '');
          } else {
            answer = 'No significant spending anomalies were detected in your cost data.';
          }
        } else if (query.toLowerCase().includes('trend')) {
          console.log('Taking trend fallback branch');
          const recentTrends = costData.dailyTrends.slice(-7);
          const avgRecent = recentTrends.reduce((sum: number, d: any) => sum + d.cost, 0) / recentTrends.length;
          const earlierAvg = costData.dailyTrends.slice(0, 7).reduce((sum: number, d: any) => sum + d.cost, 0) / 7;
          const change = ((avgRecent - earlierAvg) / earlierAvg) * 100;
          answer = `Recent 7-day average: $${avgRecent.toFixed(2)}\n` +
            `Compared to earlier period: ${change > 0 ? '+' : ''}${change.toFixed(1)}%\n` +
            `Peak day this period: ${costData.peakDay.date} ($${costData.peakDay.cost.toFixed(2)})`;
        } else if (query.toLowerCase().includes('service') || query.toLowerCase().includes('cost')) {
          console.log('Taking service/cost fallback branch');
          // Fallback for service/cost queries
          answer = `Top services by cost:\n` +
            costData.serviceBreakdown.slice(0, 8).map((s: any) => 
              `- ${s.name}: $${s.cost.toFixed(2)} (${s.percentage.toFixed(1)}%)`
            ).join('\n') +
            `\n\nNote: ${costData.topService.name} accounts for ${costData.topService.percentage?.toFixed(1)}% of your total spending.`;
        } else if (query.toLowerCase().includes('top') || query.toLowerCase().includes('driver')) {
          console.log('Taking top driver fallback branch');
          // Fallback for top cost driver queries
          answer = `Your top cost driver is ${costData.topService.name} at $${costData.topService.cost.toFixed(2)}, ` +
            `which represents ${costData.topService.percentage?.toFixed(1)}% of your total Azure spending.`;
        } else {
          console.log('No matching fallback branch - using generic message');
          answer = "I couldn't generate an answer.";
        }
      }

      res.json({
        answer,
        success: true,
      });
    } catch (error) {
      console.error("AI analysis error:", error);
      res.status(500).json({
        answer: "Sorry, I encountered an error while analyzing your query.",
        success: false,
      });
    }
  });

  // Configure Azure Cost Management API integration
  app.post("/api/azure/config", async (req, res) => {
    try {
      const validated = azureConfigSchema.parse(req.body);
      
      // Create Azure client with new config
      azureClient = new AzureCostManagementClient(validated);
      
      // Test the connection
      const isConnected = await azureClient.testConnection();
      
      if (!isConnected) {
        return res.status(401).json({ 
          error: "Failed to authenticate with Azure. Please check your credentials.",
          success: false 
        });
      }
      
      // Save to database with encrypted credentials
      const azureAccount = await storage.createAzureAccount({
        accountName: `Azure ${validated.subscriptionId}`,
        tenantId: validated.tenantId,
        clientId: validated.clientId,
        clientSecret: validated.clientSecret,
        subscriptionId: validated.subscriptionId,
        scope: validated.scope,
        resourceGroupName: validated.resourceGroupName,
        billingAccountId: validated.billingAccountId,
        refreshInterval: validated.refreshInterval,
        isActive: 1,
      });
      
      currentAzureAccountId = azureAccount.id;
      
      // Setup auto-refresh if configured
      if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
      }
      
      if (validated.refreshInterval) {
        autoRefreshInterval = setInterval(async () => {
          try {
            console.log('Auto-refreshing Azure cost data...');
            if (azureClient) {
              const azureData = await azureClient.queryCostData();
              cachedCostData = processAzureCostData(azureData);
              await saveCostDataToHistory(azureData, validated.subscriptionId);
            }
          } catch (error) {
            console.error('Auto-refresh failed:', error);
          }
        }, validated.refreshInterval * 1000);
      }
      
      res.json({ 
        success: true,
        message: "Azure configuration saved successfully and persisted to database",
        accountId: azureAccount.id,
        config: {
          subscriptionId: validated.subscriptionId,
          scope: validated.scope,
          refreshInterval: validated.refreshInterval,
        }
      });
    } catch (error) {
      console.error("Azure config error:", error);
      res.status(400).json({ 
        error: error instanceof Error ? error.message : "Invalid configuration",
        success: false 
      });
    }
  });

  // Get current Azure configuration (without sensitive data)
  app.get("/api/azure/config", async (_req, res) => {
    try {
      // Load active Azure accounts from database
      const accounts = await storage.getActiveAzureAccounts();
      
      if (accounts.length === 0) {
        return res.json({ configured: false });
      }
      
      // Return the first active account (or current if set)
      const account = currentAzureAccountId 
        ? accounts.find(a => a.id === currentAzureAccountId) || accounts[0]
        : accounts[0];
      
      // NEVER return sensitive credentials to the client
      res.json({
        configured: true,
        accountId: account.id,
        accountName: account.accountName,
        subscriptionId: account.subscriptionId,
        scope: account.scope,
        resourceGroupName: account.resourceGroupName,
        billingAccountId: account.billingAccountId,
        refreshInterval: account.refreshInterval,
        // tenantId, clientId, and clientSecret are NEVER sent to client
      });
    } catch (error) {
      console.error("Error loading Azure config:", error);
      res.status(500).json({ configured: false, error: "Failed to load configuration" });
    }
  });

  // Fetch fresh data from Azure API
  app.post("/api/azure/refresh", async (_req, res) => {
    try {
      if (!azureClient || !currentAzureAccountId) {
        return res.status(400).json({ 
          error: "Azure is not configured. Please configure Azure credentials first.",
          success: false 
        });
      }
      
      // Get account details from database for subscription ID
      const account = await storage.getAzureAccount(currentAzureAccountId);
      if (!account) {
        return res.status(400).json({
          error: "Azure account not found",
          success: false
        });
      }
      
      const azureData = await azureClient.queryCostData();
      cachedCostData = processAzureCostData(azureData);
      
      // Save to database for historical analysis and ML training
      await saveCostDataToHistory(azureData, account.subscriptionId);
      
      res.json({
        success: true,
        data: cachedCostData,
      });
    } catch (error) {
      console.error("Azure refresh error:", error);
      res.status(500).json({ 
        error: error instanceof Error ? error.message : "Failed to fetch data from Azure",
        success: false 
      });
    }
  });

  // Test Azure connection
  app.post("/api/azure/test", async (req, res) => {
    try {
      const validated = azureConfigSchema.parse(req.body);
      const testClient = new AzureCostManagementClient(validated);
      const isConnected = await testClient.testConnection();
      
      res.json({ 
        success: isConnected,
        message: isConnected ? "Connection successful" : "Connection failed"
      });
    } catch (error) {
      res.status(400).json({ 
        success: false,
        error: error instanceof Error ? error.message : "Connection test failed"
      });
    }
  });

  // ML-based cost forecasting
  app.post("/api/forecast", async (req, res) => {
    try {
      const { forecastDays = 30 } = req.body;
      const costData = cachedCostData || loadSampleData();
      
      // Run Python forecasting script
      const forecastResult = await runPythonScript("cost_forecasting.py", {
        forecastDays,
        costData,
      });
      
      // If Python script failed, return error
      if (!forecastResult.success) {
        return res.status(400).json(forecastResult);
      }
      
      // Save forecast to database if successful and we have Azure account
      if (forecastResult.forecasts && 
          Array.isArray(forecastResult.forecasts) && 
          forecastResult.forecasts.length > 0 && 
          currentAzureAccountId) {
        try {
          // Validate forecast data before persisting
          const validForecasts = forecastResult.forecasts.filter((f: any) => 
            f.date && 
            typeof f.predictedCost === 'number' && 
            Number.isFinite(f.predictedCost) &&
            f.confidenceInterval?.lower !== undefined && 
            f.confidenceInterval?.upper !== undefined &&
            Number.isFinite(f.confidenceInterval.lower) &&
            Number.isFinite(f.confidenceInterval.upper)
          );
          
          if (validForecasts.length > 0) {
            // Get current Azure account for subscription ID
            const account = await storage.getAzureAccount(currentAzureAccountId);
            if (account) {
              const forecastRecords = validForecasts.map((f: any) => ({
                subscriptionId: account.subscriptionId,
                serviceName: null,
                forecastDate: new Date(f.date),
                predictedCost: String(f.predictedCost),
                confidenceInterval: f.confidenceInterval,
                modelVersion: 'ridge_v1',
              }));
              
              // Save to database
              await db.insert(forecastData).values(forecastRecords);
            }
          }
        } catch (dbError) {
          console.error('Error saving forecast to database:', dbError);
          // Continue even if database save fails
        }
      }
      
      res.json(forecastResult);
    } catch (error) {
      console.error("Forecasting error:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to generate forecast",
        forecasts: [],
        recommendations: [],
      });
    }
  });

  // Get historical forecasts from database
  app.get("/api/forecast/history", async (req, res) => {
    try {
      const { subscriptionId } = req.query;
      
      // Build query with proper where clause handling
      const query = db
        .select()
        .from(forecastData)
        .orderBy(forecastData.createdAt)
        .limit(100);
      
      // Only add where clause if subscriptionId is provided
      const forecasts = subscriptionId 
        ? await query.where(eq(forecastData.subscriptionId, String(subscriptionId)))
        : await query;
      
      res.json({ success: true, forecasts });
    } catch (error) {
      console.error("Error fetching forecast history:", error);
      res.status(500).json({ success: false, forecasts: [], error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // ==================== ALERT RULES MANAGEMENT ====================
  
  // Get all alert rules
  app.get("/api/alerts/rules", async (_req, res) => {
    try {
      const rules = await storage.getAllAlertRules();
      res.json({ success: true, rules });
    } catch (error) {
      console.error("Error fetching alert rules:", error);
      res.status(500).json({ success: false, error: "Failed to fetch alert rules" });
    }
  });
  
  // Create alert rule
  app.post("/api/alerts/rules", async (req, res) => {
    try {
      // Map API fields to database schema
      const ruleData: schema.InsertAlertRule = {
        ruleName: req.body.name || req.body.ruleName,
        subscriptionId: req.body.subscriptionId,
        serviceName: req.body.serviceName,
        thresholdAmount: String(req.body.condition?.value || req.body.thresholdAmount || 0),
        thresholdType: req.body.type === 'threshold' ? 'daily' : (req.body.thresholdType || 'daily'),
        comparisonOperator: req.body.condition?.operator === '>' ? 'gt' : (req.body.comparisonOperator || 'gt'),
        emailRecipients: Array.isArray(req.body.emails) ? req.body.emails.join(',') : (req.body.emailRecipients || ''),
        isEnabled: req.body.enabled !== undefined ? (req.body.enabled ? 1 : 0) : 1,
      };
      
      const rule = await storage.createAlertRule(ruleData);
      res.json({ success: true, rule });
    } catch (error) {
      console.error("Error creating alert rule:", error);
      res.status(400).json({ success: false, error: "Failed to create alert rule" });
    }
  });
  
  // Update alert rule
  app.patch("/api/alerts/rules/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const rule = await storage.updateAlertRule(id, req.body);
      if (!rule) {
        return res.status(404).json({ success: false, error: "Alert rule not found" });
      }
      res.json({ success: true, rule });
    } catch (error) {
      console.error("Error updating alert rule:", error);
      res.status(400).json({ success: false, error: "Failed to update alert rule" });
    }
  });
  
  // Delete alert rule
  app.delete("/api/alerts/rules/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const success = await storage.deleteAlertRule(id);
      if (!success) {
        return res.status(404).json({ success: false, error: "Alert rule not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting alert rule:", error);
      res.status(500).json({ success: false, error: "Failed to delete alert rule" });
    }
  });
  
  // ==================== REPORT SCHEDULES MANAGEMENT ====================
  
  // Get all report schedules
  app.get("/api/reports/schedules", async (_req, res) => {
    try {
      const schedules = await storage.getAllReportSchedules();
      res.json({ success: true, schedules });
    } catch (error) {
      console.error("Error fetching report schedules:", error);
      res.status(500).json({ success: false, error: "Failed to fetch report schedules" });
    }
  });
  
  // Create report schedule
  app.post("/api/reports/schedules", async (req, res) => {
    try {
      // Map API fields to database schema
      const scheduleData: schema.InsertReportSchedule = {
        scheduleName: req.body.name || req.body.scheduleName,
        reportType: req.body.reportType || 'cost_summary',
        frequency: req.body.frequency || 'weekly',
        format: req.body.format || 'csv',
        emailRecipients: Array.isArray(req.body.emails) ? req.body.emails.join(',') : (req.body.emailRecipients || ''),
        subscriptionIds: req.body.subscriptionIds,
        nextRunAt: req.body.nextRun ? new Date(req.body.nextRun) : (req.body.nextRunAt || new Date()),
        isEnabled: req.body.enabled !== undefined ? (req.body.enabled ? 1 : 0) : 1,
      };
      
      const schedule = await storage.createReportSchedule(scheduleData);
      res.json({ success: true, schedule });
    } catch (error) {
      console.error("Error creating report schedule:", error);
      res.status(400).json({ success: false, error: "Failed to create report schedule" });
    }
  });
  
  // Update report schedule
  app.patch("/api/reports/schedules/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const schedule = await storage.updateReportSchedule(id, req.body);
      if (!schedule) {
        return res.status(404).json({ success: false, error: "Report schedule not found" });
      }
      res.json({ success: true, schedule });
    } catch (error) {
      console.error("Error updating report schedule:", error);
      res.status(400).json({ success: false, error: "Failed to update report schedule" });
    }
  });
  
  // Delete report schedule
  app.delete("/api/reports/schedules/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const success = await storage.deleteReportSchedule(id);
      if (!success) {
        return res.status(404).json({ success: false, error: "Report schedule not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting report schedule:", error);
      res.status(500).json({ success: false, error: "Failed to delete report schedule" });
    }
  });
  
  // ==================== CSV EXPORT ENDPOINTS ====================
  
  // Export cost history as CSV
  app.get("/api/export/cost-history", async (_req, res) => {
    try {
      const costData = cachedCostData || loadSampleData();
      const csv = generateCostHistoryCSV(costData);
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="cost-history-${new Date().toISOString().split('T')[0]}.csv"`);
      res.send(csv);
    } catch (error) {
      console.error("Error generating cost history CSV:", error);
      res.status(500).json({ error: "Failed to generate CSV export" });
    }
  });
  
  // Export service breakdown as CSV
  app.get("/api/export/service-breakdown", async (_req, res) => {
    try {
      const costData = cachedCostData || loadSampleData();
      const csv = generateServiceBreakdownCSV(costData);
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="service-breakdown-${new Date().toISOString().split('T')[0]}.csv"`);
      res.send(csv);
    } catch (error) {
      console.error("Error generating service breakdown CSV:", error);
      res.status(500).json({ error: "Failed to generate CSV export" });
    }
  });
  
  // Export anomalies as CSV
  app.get("/api/export/anomalies", async (_req, res) => {
    try {
      const costData = cachedCostData || loadSampleData();
      
      // Run anomaly detection
      const anomalyResult = await runPythonScript("anomaly_detection.py", {
        costData,
      });
      
      if (!anomalyResult.success || !anomalyResult.anomalies) {
        return res.status(400).json({ error: "Failed to detect anomalies" });
      }
      
      const csv = generateAnomaliesCSV(anomalyResult.anomalies);
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="anomalies-${new Date().toISOString().split('T')[0]}.csv"`);
      res.send(csv);
    } catch (error) {
      console.error("Error generating anomalies CSV:", error);
      res.status(500).json({ error: "Failed to generate CSV export" });
    }
  });
  
  // Export forecast as CSV
  app.get("/api/export/forecast", async (req, res) => {
    try {
      const { forecastDays = 30 } = req.query;
      const costData = cachedCostData || loadSampleData();
      
      // Generate forecast
      const forecastResult = await runPythonScript("cost_forecasting.py", {
        forecastDays: Number(forecastDays),
        costData,
      });
      
      if (!forecastResult.success || !forecastResult.forecasts) {
        return res.status(400).json({ error: "Failed to generate forecast" });
      }
      
      const csv = generateForecastCSV(forecastResult.forecasts);
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="forecast-${forecastDays}days-${new Date().toISOString().split('T')[0]}.csv"`);
      res.send(csv);
    } catch (error) {
      console.error("Error generating forecast CSV:", error);
      res.status(500).json({ error: "Failed to generate CSV export" });
    }
  });
  
  // Export comprehensive report as CSV
  app.get("/api/export/comprehensive-report", async (req, res) => {
    try {
      const { forecastDays = 30 } = req.query;
      const costData = cachedCostData || loadSampleData();
      
      // Get anomalies
      const anomalyResult = await runPythonScript("anomaly_detection.py", { costData });
      const anomalies = anomalyResult.success ? anomalyResult.anomalies : [];
      
      // Get forecast
      const forecastResult = await runPythonScript("cost_forecasting.py", {
        forecastDays: Number(forecastDays),
        costData,
      });
      const forecasts = forecastResult.success ? forecastResult.forecasts : [];
      
      const csv = generateComprehensiveReportCSV(costData, anomalies, forecasts);
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="comprehensive-cost-report-${new Date().toISOString().split('T')[0]}.csv"`);
      res.send(csv);
    } catch (error) {
      console.error("Error generating comprehensive report CSV:", error);
      res.status(500).json({ error: "Failed to generate CSV export" });
    }
  });

  // Initialize Azure client from database on startup
  async function initializeAzureClient() {
    try {
      const accounts = await storage.getActiveAzureAccounts();
      
      if (accounts.length > 0) {
        const account = accounts[0]; // Use first active account
        currentAzureAccountId = account.id;
        
        // Create Azure client with decrypted credentials
        azureClient = new AzureCostManagementClient({
          tenantId: account.tenantId,
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          subscriptionId: account.subscriptionId,
          scope: account.scope as any,
          resourceGroupName: account.resourceGroupName || undefined,
          billingAccountId: account.billingAccountId || undefined,
          refreshInterval: account.refreshInterval,
        });
        
        // Setup auto-refresh if configured
        if (account.refreshInterval > 0) {
          autoRefreshInterval = setInterval(async () => {
            try {
              console.log('Auto-refreshing Azure cost data...');
              if (azureClient) {
                const azureData = await azureClient.queryCostData();
                cachedCostData = processAzureCostData(azureData);
                await saveCostDataToHistory(azureData, account.subscriptionId);
              }
            } catch (error) {
              console.error('Auto-refresh failed:', error);
            }
          }, account.refreshInterval * 1000);
        }
        
        console.log(`Loaded Azure account from database: ${account.accountName}`);
      } else {
        console.log('No Azure accounts found in database. Using sample data.');
      }
    } catch (error) {
      console.error('Error initializing Azure client from database:', error);
      console.log('Falling back to sample data.');
    }
  }
  
  // Initialize on startup
  initializeAzureClient();

  const httpServer = createServer(app);

  return httpServer;
}
