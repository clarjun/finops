import type { Express } from "express";
import { createServer, type Server } from "http";
import { readFileSync } from "fs";
import { join } from "path";
import { eq, and, gte, lte } from "drizzle-orm";
import { azureCostResponseSchema, aiQueryRequestSchema, azureConfigSchema, type AzureConfig, azureAccounts, costHistory, insertCostHistorySchema } from "@shared/schema";
import { processAzureCostData } from "./utils/process-cost-data";
import { runPythonScript } from "./utils/python-runner";
import { openai } from "./openai-client";
import { AzureCostManagementClient } from "./azure-client";
import { db } from "./db";

// Load sample Azure cost data for initial display
let cachedCostData: any = null;
let azureClient: AzureCostManagementClient | null = null;
let azureConfig: AzureConfig | null = null;
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
      const minDate = new Date(Math.min(...dates.map((d: Date) => d.getTime())));
      const maxDate = new Date(Math.max(...dates.map((d: Date) => d.getTime())));
      
      await db
        .delete(costHistory)
        .where(
          and(
            eq(costHistory.subscriptionId, subscriptionId),
            gte(costHistory.date, minDate.toISOString()),
            lte(costHistory.date, maxDate.toISOString())
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

      // Prepare context for AI
      const context = `You are an AI assistant analyzing Azure cloud spending data. 
      
Here is the cost data summary:
- Total Cost: $${costData.totalCost.toFixed(2)}
- Average Daily Cost: $${costData.avgDailyCost.toFixed(2)}
- Top Service: ${costData.topService.name} ($${costData.topService.cost.toFixed(2)})
- Number of Services: ${costData.serviceCount}
- Peak Day: ${costData.peakDay.date} ($${costData.peakDay.cost.toFixed(2)})

Top 10 Services by Cost:
${costData.serviceBreakdown.slice(0, 10).map((s: any, i: number) => 
  `${i + 1}. ${s.name}: $${s.cost.toFixed(2)} (${s.percentage.toFixed(1)}%)`
).join('\n')}

Subscriptions: ${costData.subscriptions.join(', ')}

Please answer the user's question clearly and concisely based on this data.`;

      // the newest OpenAI model is "gpt-5" which was released August 7, 2025. do not change this unless explicitly requested by the user
      const completion = await openai.chat.completions.create({
        model: "gpt-5",
        messages: [
          { role: "system", content: context },
          { role: "user", content: query }
        ],
        max_completion_tokens: 500,
      });

      const answer = completion.choices[0]?.message?.content || "I couldn't generate an answer.";

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
      
      azureConfig = validated;
      
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
            }
          } catch (error) {
            console.error('Auto-refresh failed:', error);
          }
        }, validated.refreshInterval * 1000);
      }
      
      res.json({ 
        success: true,
        message: "Azure configuration saved successfully",
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
    if (!azureConfig) {
      return res.json({ configured: false });
    }
    
    // NEVER return sensitive credentials to the client
    res.json({
      configured: true,
      subscriptionId: azureConfig.subscriptionId,
      scope: azureConfig.scope,
      resourceGroupName: azureConfig.resourceGroupName,
      billingAccountId: azureConfig.billingAccountId,
      refreshInterval: azureConfig.refreshInterval,
      // tenantId, clientId, and clientSecret are NEVER sent to client
    });
  });

  // Fetch fresh data from Azure API
  app.post("/api/azure/refresh", async (_req, res) => {
    try {
      if (!azureClient || !azureConfig) {
        return res.status(400).json({ 
          error: "Azure is not configured. Please configure Azure credentials first.",
          success: false 
        });
      }
      
      const azureData = await azureClient.queryCostData();
      cachedCostData = processAzureCostData(azureData);
      
      // Save to database for historical analysis and ML training
      await saveCostDataToHistory(azureData, azureConfig.subscriptionId);
      
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

  const httpServer = createServer(app);

  return httpServer;
}
