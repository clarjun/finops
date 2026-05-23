import type { Express } from "express";
import { createServer, type Server } from "http";
import { readFileSync } from "fs";
import { join } from "path";
import { eq, and, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { azureCostResponseSchema, aiQueryRequestSchema, azureConfigSchema, type AzureConfig, azureAccounts, costHistory, insertCostHistorySchema, forecastData } from "@shared/schema";
import * as schema from "@shared/schema";
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
import { 
  generateMultiCloudSampleData, 
  getSampleDataByProvider 
} from "./utils/sample-data-generator";
import { checkBudgetAlerts } from "./utils/budget-alert-checker-new";
import type { CloudProvider } from "@shared/schema";
import { fetchAWSCostData, isAWSConfigured } from "./aws-client";
import { fetchGCPCostData, isGCPConfigured } from "./gcp-client";

// Multi-cloud sample data cache
let multiCloudSampleData: ReturnType<typeof generateMultiCloudSampleData> | null = null;
let cachedCostData: any = null; // Legacy Azure-only cache
let azureClient: AzureCostManagementClient | null = null;
let currentAzureAccountId: number | null = null;
let autoRefreshInterval: NodeJS.Timeout | null = null;

function loadSampleData() {
  // Legacy function for Azure-only data (backward compatibility)
  if (!cachedCostData) {
    const samplePath = join(process.cwd(), "attached_assets", "azure_1760597470327.json");
    const sampleData = JSON.parse(readFileSync(samplePath, "utf-8"));
    cachedCostData = processAzureCostData(sampleData);
  }
  return cachedCostData;
}

function loadMultiCloudSampleData() {
  if (!multiCloudSampleData) {
    console.log('Generating multi-cloud sample data (AWS, GCP, Azure)...');
    multiCloudSampleData = generateMultiCloudSampleData(30);
    console.log('Sample data generated:', {
      aws: multiCloudSampleData.awsData.length + ' records',
      gcp: multiCloudSampleData.gcpData.length + ' records',
      azure: multiCloudSampleData.azureData.length + ' records',
      total: multiCloudSampleData.allCostData.length + ' records'
    });
  }
  return multiCloudSampleData;
}

// Save cost data to historical database for ML training
async function saveCostDataToHistory(azureResponse: any, subscriptionId: string) {
  try {
    const rows = azureResponse.properties.rows;
    
    // Map Azure response rows to cost history records (multi-cloud format)
    // Row format: [PreTaxCost, UsageDate, SubscriptionName, ResourceGroup, ServiceName, Currency]
    const costRecords = rows.map((row: any) => ({
      provider: 'azure' as const,
      date: new Date(String(row[1]).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')),
      accountId: subscriptionId, // Azure subscription ID
      accountName: row[2] || 'unknown',
      resourceGroup: row[3] || 'unknown',
      serviceName: row[4] || 'unknown',
      region: undefined,
      cost: String(row[0]),
      currency: row[5] || 'USD',
      tags: null,
      metadata: null,
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
            eq(costHistory.accountId, subscriptionId),
            eq(costHistory.provider, 'azure'),
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

async function fetchRealAWSData(startDate?: Date, endDate?: Date): Promise<{ success: boolean; data: any[]; error?: string }> {
  try {
    const end = endDate || new Date();
    const start = startDate || (() => { const d = new Date(); d.setDate(1); return d; })();

    const awsData = await fetchAWSCostData(
      start.toISOString().split('T')[0],
      end.toISOString().split('T')[0]
    );
    
    const transformedData = awsData.map(record => ({
      provider: 'aws' as const,
      accountId: 'real-aws-account',
      accountName: 'AWS Account',
      date: record.date,
      serviceName: record.service,
      region: record.region || 'us-east-1', // Default to us-east-1 since SERVICE grouping doesn't include region
      cost: record.cost,
      currency: 'USD',
      tags: record.tags || {},
      metadata: {
        source: 'aws-cost-explorer',
        fetchedAt: new Date().toISOString()
      }
    }));
    
    return { success: true, data: transformedData };
  } catch (error: any) {
    console.error('Error fetching real AWS data:', error);
    return { success: false, data: [], error: error.message || 'Failed to fetch AWS data' };
  }
}

async function fetchRealGCPData(): Promise<{ success: boolean; data: any[]; error?: string }> {
  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);
    
    const gcpData = await fetchGCPCostData(
      startDate.toISOString().split('T')[0],
      endDate.toISOString().split('T')[0]
    );
    
    const transformedData = gcpData.map(record => ({
      provider: 'gcp' as const,
      accountId: process.env.GCP_PROJECT_ID || 'real-gcp-project',
      accountName: 'GCP Project',
      date: record.date,
      serviceName: record.service,
      region: record.region || 'us-central1',
      cost: record.cost,
      currency: 'USD',
      tags: record.tags || {},
      metadata: {
        source: 'gcp-bigquery-billing',
        fetchedAt: new Date().toISOString()
      }
    }));
    
    return { success: true, data: transformedData };
  } catch (error: any) {
    console.error('Error fetching real GCP data:', error);
    return { success: false, data: [], error: error.message || 'Failed to fetch GCP data' };
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Check cloud provider configuration status on startup (informational only, will re-check on each request)
  const initialAwsCheck = await isAWSConfigured();
  const initialGcpCheck = await isGCPConfigured();
  console.log(`AWS Cost Explorer: ${initialAwsCheck ? 'CONFIGURED Ô£ô' : 'Not configured - using sample data'}`);
  console.log(`GCP BigQuery Billing: ${initialGcpCheck ? 'CONFIGURED Ô£ô' : 'Not configured - using sample data'}`);

  // Get processed cost data with optional provider filtering
  app.get("/api/cost-data", async (req, res) => {
    try {
      const provider = (req.query.provider as CloudProvider | 'all') || 'all';

      // Parse date range — default to month-to-date
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : new Date();
      const startDate = req.query.startDate
        ? new Date(req.query.startDate as string)
        : new Date(endDate.getFullYear(), endDate.getMonth(), 1);

      const { fetchLiveCosts } = await import('./utils/live-cost-fetcher');
      const { processMultiCloudCosts } = await import('./utils/multi-cloud-processor');
      const { isAzureConfigured } = await import('./azure-client');

      const awsConfigured = await isAWSConfigured();
      const gcpConfigured = await isGCPConfigured();
      const azureConfigured = await isAzureConfigured();

      // Determine which providers to fetch real data for
      const realProviders: CloudProvider[] = [];
      if (provider === 'aws' || provider === 'all') { if (awsConfigured) realProviders.push('aws'); }
      if (provider === 'gcp' || provider === 'all') { if (gcpConfigured) realProviders.push('gcp'); }
      if (provider === 'azure' || provider === 'all') { if (azureConfigured) realProviders.push('azure'); }

      let processedData;
      let dataSource = 'not-configured';

      if (realProviders.length > 0) {
        const providersToFetch = provider === 'all' ? realProviders : [provider as CloudProvider];
        const records = await fetchLiveCosts(startDate, endDate, providersToFetch);
        console.log(`[/api/cost-data] Fetched ${records.length} real records for ${providersToFetch.join(',')} (${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]})`);
        processedData = processMultiCloudCosts(records);
        dataSource = `real-${providersToFetch.join('-')}`;
      } else {
        processedData = {
          totalCost: 0, avgDailyCost: 0, topService: { name: 'N/A', cost: 0 },
          serviceCount: 0, dailyTrends: [], serviceBreakdown: [],
          subscriptionBreakdown: [], subscriptions: [], services: [],
          peakDay: { date: '', cost: 0 }
        };
      }

      res.json({
        ...processedData,
        _metadata: {
          dataSource,
          awsConfigured,
          gcpConfigured,
          azureConfigured,
          startDate: startDate.toISOString().split('T')[0],
          endDate: endDate.toISOString().split('T')[0],
          timestamp: new Date().toISOString(),
        }
      });
    } catch (error) {
      console.error('Error loading cost data:', error);
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
  app.get("/api/anomalies", async (req, res) => {
    try {
      const provider = (req.query.provider as string) || 'all';
      console.log(`Anomaly detection requested for provider: ${provider}`);
      
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : new Date();
      const startDate = req.query.startDate
        ? new Date(req.query.startDate as string)
        : new Date(endDate.getFullYear(), endDate.getMonth(), 1);

      const { fetchLiveCosts } = await import('./utils/live-cost-fetcher');
      const { processMultiCloudCosts } = await import('./utils/multi-cloud-processor');

      const providersToFetch: CloudProvider[] = provider === 'all'
        ? ['aws', 'gcp', 'azure']
        : [provider as CloudProvider];

      const records = await fetchLiveCosts(startDate, endDate, providersToFetch);
      console.log(`[Anomalies] ${records.length} records for ${provider}`);
      const processedData = processMultiCloudCosts(records as any);

      const { detectAnomaliesTS } = await import('./utils/anomaly-detector');
      const anomalyResult = detectAnomaliesTS(processedData);
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
      
      // Detect which cloud provider(s) the user is asking about
      const queryLower = query.toLowerCase();
      let detectedProvider: CloudProvider | 'all' = 'all';
      let providerName = 'multi-cloud';
      
      // Check for multiple providers (comparison queries)
      const hasAws = queryLower.includes('aws') || queryLower.includes('amazon');
      const hasGcp = queryLower.includes('gcp') || queryLower.includes('google');
      const hasAzure = queryLower.includes('azure') || queryLower.includes('microsoft');
      const providerCount = [hasAws, hasGcp, hasAzure].filter(Boolean).length;
      
      // Only use multi-cloud when multiple providers are explicitly mentioned
      // Don't trigger on single-provider comparisons like "compare AWS costs month over month"
      if (providerCount > 1) {
        detectedProvider = 'all';
        providerName = 'multi-cloud';
        console.log(`AI query detected multi-cloud comparison from query: "${query}"`);
      } else if (hasAws) {
        detectedProvider = 'aws';
        providerName = 'AWS';
        console.log(`AI query detected provider: aws from query: "${query}"`);
      } else if (hasGcp) {
        detectedProvider = 'gcp';
        providerName = 'GCP';
        console.log(`AI query detected provider: gcp from query: "${query}"`);
      } else if (hasAzure) {
        detectedProvider = 'azure';
        providerName = 'Azure';
        console.log(`AI query detected provider: azure from query: "${query}"`);
      } else {
        console.log(`AI query - no specific provider detected, using multi-cloud data from query: "${query}"`);
      }
      
      const endDate2 = new Date();
      const startDate2 = new Date(endDate2.getFullYear(), endDate2.getMonth(), 1);
      const { fetchLiveCosts: fetchLiveCosts2 } = await import('./utils/live-cost-fetcher');
      const { processMultiCloudCosts: processMultiCloudCosts2 } = await import('./utils/multi-cloud-processor');

      const analyzeProviders: CloudProvider[] = detectedProvider === 'all'
        ? ['aws', 'gcp', 'azure']
        : [detectedProvider as CloudProvider];

      const analyzeRecords = await fetchLiveCosts2(startDate2, endDate2, analyzeProviders);
      let costData = processMultiCloudCosts2(analyzeRecords as any);
      console.log(`[AI Analyze] ${analyzeRecords.length} records for ${detectedProvider}`);

      // Get anomaly data for comprehensive analysis
      let anomalyData: any = null;
      try {
        const { detectAnomaliesTS } = await import('./utils/anomaly-detector');
        anomalyData = detectAnomaliesTS(costData);
      } catch {
        // Continue without anomaly data if detection fails
      }

      // Prepare comprehensive context for AI with dynamic provider reference
      const context = `You are an AI assistant analyzing ${providerName} cloud spending data. Answer questions clearly and concisely based on the data provided.

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
        max_completion_tokens: 2000,
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
        // Check comparison queries FIRST (before service/cost) to avoid false matches
        if (query.toLowerCase().includes('compare') || 
           query.toLowerCase().includes('between') || 
           query.toLowerCase().includes('vs') || 
           query.toLowerCase().includes('versus')) {
          console.log('Taking comparison fallback branch');
          // Fallback for comparison queries
          if (detectedProvider === 'all') {
            // Multi-cloud comparison
            answer = `${providerName} Cost Summary:\n\n` +
              `Total Spending: $${costData.totalCost.toFixed(2)}\n` +
              `Average Daily Cost: $${costData.avgDailyCost.toFixed(2)}\n\n` +
              `Top Services:\n` +
              costData.serviceBreakdown.slice(0, 5).map((s: any) => 
                `- ${s.name}: $${s.cost.toFixed(2)} (${s.percentage.toFixed(1)}%)`
              ).join('\n');
          } else {
            // Single provider temporal comparison
            const recentTrends = costData.dailyTrends.slice(-7);
            const avgRecent = recentTrends.reduce((sum: number, d: any) => sum + d.cost, 0) / recentTrends.length;
            answer = `${providerName} Cost Overview:\n\n` +
              `Total Cost: $${costData.totalCost.toFixed(2)}\n` +
              `Recent 7-day average: $${avgRecent.toFixed(2)}\n` +
              `Peak day: ${costData.peakDay.date} ($${costData.peakDay.cost.toFixed(2)})\n\n` +
              `Top service: ${costData.topService.name} at $${costData.topService.cost.toFixed(2)}`;
          }
        } else if (query.toLowerCase().includes('anomal')) {
          console.log('Taking anomaly fallback branch');
          if (anomalyData?.anomalies?.length > 0) {
            answer = `I detected ${anomalyData.anomalies.length} spending anomalies:\n\n` +
              anomalyData.anomalies.slice(0, 5).map((a: any) => 
                `ÔÇó ${a.date}: $${a.cost.toFixed(2)} - ${a.description} (${a.severity} severity)`
              ).join('\n') +
              (anomalyData.insights?.length > 0 ? `\n\nKey insights:\n${anomalyData.insights.slice(0, 3).map((i: any) => `ÔÇó ${i}`).join('\n')}` : '');
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
        } else if (query.toLowerCase().includes('top') || query.toLowerCase().includes('driver')) {
          console.log('Taking top driver fallback branch');
          // Fallback for top cost driver queries
          const topServicePercentage = ((costData.topService.cost / costData.totalCost) * 100).toFixed(1);
          answer = `Your top cost driver is ${costData.topService.name} at $${costData.topService.cost.toFixed(2)}, ` +
            `which represents ${topServicePercentage}% of your total ${providerName} spending.`;
        } else if (query.toLowerCase().includes('service') || query.toLowerCase().includes('cost')) {
          console.log('Taking service/cost fallback branch');
          // Fallback for service/cost queries
          const topServicePercentage = ((costData.topService.cost / costData.totalCost) * 100).toFixed(1);
          answer = `Top services by cost:\n` +
            costData.serviceBreakdown.slice(0, 8).map((s: any) => 
              `- ${s.name}: $${s.cost.toFixed(2)} (${s.percentage.toFixed(1)}%)`
            ).join('\n') +
            `\n\nNote: ${costData.topService.name} accounts for ${topServicePercentage}% of your total spending.`;
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
      const { forecastDays = 30, provider } = req.body;
      const cloudProvider = (provider as CloudProvider | 'all' | undefined) || 'all';
      
      let costData;
      
      // Check if we have real Azure data and it's requested
      const hasRealAzureData = cachedCostData !== null;
      const needsAzureData = cloudProvider === 'azure' || cloudProvider === 'all';
      
      if (hasRealAzureData && needsAzureData && cloudProvider === 'azure') {
        // Use real Azure data when available and specifically requested
        costData = cachedCostData;
      } else if (hasRealAzureData && needsAzureData && cloudProvider === 'all') {
        // For 'all' provider with real Azure data, use legacy behavior for backward compatibility
        costData = cachedCostData;
      } else {
        // Use multi-cloud sample data for AWS, GCP, or when Azure data isn't available
        const sampleData = loadMultiCloudSampleData();
        
        switch (cloudProvider) {
          case 'aws':
            costData = sampleData.awsOnly;
            break;
          case 'gcp':
            costData = sampleData.gcpOnly;
            break;
          case 'azure':
            costData = sampleData.azureOnly;
            break;
          case 'all':
          default:
            costData = sampleData.allProviders;
        }
      }
      
      // Run Python forecasting script
      const forecastResult = await runPythonScript("cost_forecasting.py", {
        forecastDays,
        costData,
      });
      
      // If Python script failed, return error
      if (!forecastResult.success) {
        return res.status(400).json(forecastResult);
      }
      
      // Transform Python output to match frontend expectations
      const transformedResult = {
        success: true,
        forecasts: (forecastResult.forecasts || []).map((f: any) => ({
          date: f.date,
          predictedCost: f.cost,
          confidenceInterval: {
            lower: f.lowerBound || 0,
            upper: f.upperBound || 0,
          },
        })),
        summary: {
          historicalAverage: forecastResult.metrics?.historical_avg || 0,
          forecastAverage: forecastResult.metrics?.forecast_avg || 0,
          totalForecastedCost: (forecastResult.forecasts || []).reduce((sum: number, f: any) => sum + (f.cost || 0), 0),
          changePercentage: forecastResult.metrics?.historical_avg 
            ? ((forecastResult.metrics.forecast_avg - forecastResult.metrics.historical_avg) / forecastResult.metrics.historical_avg) * 100
            : 0,
        },
        recommendations: forecastResult.recommendations || [],
        modelMetrics: {
          mape: forecastResult.metrics?.mape || 0,
          accuracy: forecastResult.metrics?.mape ? (100 - forecastResult.metrics.mape) : 0,
        },
        dataPoints: costData?.dailyTrends?.length || 0,
      };
      
      // Save forecast to database if successful and we have Azure account
      if (transformedResult.forecasts && 
          Array.isArray(transformedResult.forecasts) && 
          transformedResult.forecasts.length > 0 && 
          currentAzureAccountId) {
        try {
          // Validate forecast data before persisting
          const validForecasts = transformedResult.forecasts.filter((f: any) => 
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
                provider: 'azure' as const,
                accountId: account.subscriptionId,
                serviceName: null,
                forecastDate: new Date(f.date),
                predictedCost: String(f.predictedCost),
                confidenceInterval: f.confidenceInterval,
                modelVersion: 'ridge_v1',
                modelType: 'ridge',
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
      
      res.json(transformedResult);
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
        ? await query.where(and(
            eq(forecastData.accountId, String(subscriptionId)),
            eq(forecastData.provider, 'azure')
          ))
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
      // Convert boolean to integer for isEnabled (1 = enabled, 0 = disabled)
      const isEnabled = req.body.isEnabled !== undefined ? req.body.isEnabled : (req.body.enabled !== undefined ? req.body.enabled : true);
      const isEnabledInt = typeof isEnabled === 'boolean' ? (isEnabled ? 1 : 0) : isEnabled;
      
      // Map API fields to database schema (multi-cloud compatible)
      const ruleData: schema.InsertAlertRule = {
        ruleName: req.body.name || req.body.ruleName,
        provider: req.body.provider,
        accountId: req.body.accountId || req.body.subscriptionId, // Support legacy subscriptionId field
        serviceName: req.body.serviceName,
        thresholdAmount: String(req.body.condition?.value || req.body.thresholdAmount || 0),
        thresholdType: req.body.type === 'threshold' ? 'daily' : (req.body.thresholdType || 'daily'),
        comparisonOperator: req.body.condition?.operator === '>' ? 'gt' : (req.body.comparisonOperator || 'gt'),
        emailRecipients: Array.isArray(req.body.emails) ? req.body.emails.join(',') : (req.body.emailRecipients || ''),
        isEnabled: isEnabledInt,
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
      
      // Convert boolean to integer for isEnabled if present
      const updates = { ...req.body };
      if ('isEnabled' in updates && typeof updates.isEnabled === 'boolean') {
        updates.isEnabled = updates.isEnabled ? 1 : 0;
      }
      
      const rule = await storage.updateAlertRule(id, updates);
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
  
  // ==================== FINOPS REPORT ====================

  app.get("/api/reports/finops", async (req, res) => {
    try {
      const { provider = 'aws' } = req.query;

      if (provider !== 'aws' && provider !== 'azure' && provider !== 'gcp') {
        return res.status(400).json({ success: false, error: 'Invalid provider. Must be aws, azure, or gcp' });
      }

      let startDate: Date;
      let endDate: Date;

      if (req.query.startDate && req.query.endDate) {
        startDate = new Date(req.query.startDate as string);
        endDate = new Date(req.query.endDate as string);
      } else {
        endDate = new Date();
        startDate = new Date();
        startDate.setDate(1);
      }

      const startDateStr = startDate.toISOString().split('T')[0];
      const endDateStr = endDate.toISOString().split('T')[0];
      const cacheKey = `finops-report:${provider}:${startDateStr}:${endDateStr}`;

      const { persistentCache } = await import('./utils/persistent-cache');

      // Only trigger background refresh if data is older than this threshold
      const REFRESH_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

      const shouldRefresh = (fetchedAtMs: number) =>
        Date.now() - fetchedAtMs > REFRESH_THRESHOLD_MS;

      // Fetches fresh data from APIs, saves to memory cache + DB
      async function fetchAndRefresh(): Promise<any> {
        console.log(`[FinOps Report] Fetching fresh data from APIs for ${provider} (${startDateStr} to ${endDateStr})`);
        const { generateFinOpsReport } = await import('./reports/report-engine');
        const { fetchLiveCosts } = await import('./utils/live-cost-fetcher');
        const { fetchExpensiveResources } = await import('./reports/expensive-resources-fetcher');

        const sixMonthsAgo = new Date(startDate);
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);

        const accounts = await storage.getAllCloudAccounts();
        const account = accounts.find((acc: any) => acc.provider === provider);
        const accountId = account?.accountId;

        const [currentPeriodRecords, historicalRecords, expensiveResourcesList] = await Promise.all([
          fetchLiveCosts(startDate, endDate, [provider as 'aws' | 'azure' | 'gcp']),
          fetchLiveCosts(sixMonthsAgo, endDate, [provider as 'aws' | 'azure' | 'gcp']),
          fetchExpensiveResources(provider as 'aws' | 'azure' | 'gcp', startDateStr, endDateStr, 10),
        ]);

        const formattedCurrent = currentPeriodRecords.map(d => ({ date: d.date, service: d.serviceName, cost: d.cost }));
        const formattedHistorical = historicalRecords.map(d => ({ date: d.date, service: d.serviceName, cost: d.cost }));

        const serviceAggregation: Record<string, number> = {};
        for (const record of formattedCurrent) {
          serviceAggregation[record.service] = (serviceAggregation[record.service] || 0) + record.cost;
        }
        const resourceCosts = Object.entries(serviceAggregation).map(([service, cost]) => ({
          resourceId: `${service}-aggregate`, service, cost, resourceName: service, region: 'us-east-1', owner: 'Unknown',
        }));

        const uniqueData = Array.from(
          new Map([...formattedCurrent, ...formattedHistorical].map(item => [`${item.date}-${item.service}`, item])).values()
        );

        const report = await generateFinOpsReport(
          provider as 'aws' | 'azure' | 'gcp',
          uniqueData,
          resourceCosts,
          { startDate, endDate },
          expensiveResourcesList,
          accountId
        );

        // Save to memory cache (1 hour TTL)
        persistentCache.set(cacheKey, report, 60 * 60 * 1000);

        // Save to DB — survives server restarts, works even after days without visits
        await storage.upsertReportCache({
          cacheKey,
          provider: provider as string,
          startDate: startDateStr,
          endDate: endDateStr,
          reportData: report,
          fetchedAt: new Date(),
        });

        console.log(`[FinOps Report] Report refreshed and saved to DB`);
        return report;
      }

      // 1. Memory cache — fastest path
      const memCached = persistentCache.get(cacheKey);
      if (memCached) {
        const cachedAt = persistentCache.getTimestamp(cacheKey) ?? 0;
        if (shouldRefresh(cachedAt)) {
          console.log(`[FinOps Report] Memory cache hit (stale ${Math.round((Date.now() - cachedAt) / 60000)}min) — triggering background refresh`);
          setImmediate(() => fetchAndRefresh().catch(err => console.error('[FinOps Report] Background refresh error:', err)));
        } else {
          console.log(`[FinOps Report] Memory cache hit (fresh ${Math.round((Date.now() - cachedAt) / 60000)}min) — skipping refresh`);
        }
        return res.json({ success: true, report: memCached, cached: true, source: 'memory' });
      }

      // 2. DB cache — works after restarts or days without visits
      const dbCached = await storage.getReportCache(cacheKey);
      if (dbCached) {
        persistentCache.set(cacheKey, dbCached.reportData, 60 * 60 * 1000);
        const fetchedAtMs = dbCached.fetchedAt ? new Date(dbCached.fetchedAt).getTime() : 0;
        if (shouldRefresh(fetchedAtMs)) {
          console.log(`[FinOps Report] DB cache hit (stale ${Math.round((Date.now() - fetchedAtMs) / 60000)}min) — triggering background refresh`);
          setImmediate(() => fetchAndRefresh().catch(err => console.error('[FinOps Report] Background refresh error:', err)));
        } else {
          console.log(`[FinOps Report] DB cache hit (fresh ${Math.round((Date.now() - fetchedAtMs) / 60000)}min) — skipping refresh`);
        }
        return res.json({ success: true, report: dbCached.reportData, cached: true, source: 'db' });
      }

      // 3. No cache — tell frontend to use the stream endpoint instead
      console.log(`[FinOps Report] No cache — client should use /stream`);
      res.json({ success: true, report: null, cached: false, source: 'none' });

    } catch (error: any) {
      console.error("[FinOps Report] Error:", error);
      res.status(500).json({ success: false, error: error.message || "Failed to generate FinOps report" });
    }
  });

  // ==================== FINOPS REPORT STREAMING (SSE) ====================
  // Streams each report section as it completes — no waiting for full report

  app.get("/api/reports/finops/stream", async (req, res) => {
    const { provider = 'aws' } = req.query;

    if (provider !== 'aws' && provider !== 'azure' && provider !== 'gcp') {
      return res.status(400).json({ error: 'Invalid provider' });
    }

    let startDate: Date;
    let endDate: Date;
    if (req.query.startDate && req.query.endDate) {
      startDate = new Date(req.query.startDate as string);
      endDate = new Date(req.query.endDate as string);
    } else {
      endDate = new Date();
      startDate = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
    }

    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (section: string, data: any) => {
      res.write(`data: ${JSON.stringify({ section, data })}\n\n`);
    };

    const sendError = (section: string, error: string) => {
      res.write(`data: ${JSON.stringify({ section, error })}\n\n`);
    };

    try {
      const { fetchLiveCosts } = await import('./utils/live-cost-fetcher');
      const { fetchExpensiveResources } = await import('./reports/expensive-resources-fetcher');

      // ── Step 1: Fetch data (the slow part) ──────────────────────────────
      send('status', { message: 'Fetching cost data from AWS...', step: 1, total: 11 });

      const sixMonthsAgo = new Date(startDate);
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);

      const accounts = await storage.getAllCloudAccounts();
      const account = accounts.find((acc: any) => acc.provider === provider);
      const accountId = account?.accountId;

      // Fetch current period + historical + expensive resources in parallel
      const [currentPeriodRecords, historicalRecords, expensiveResourcesList] = await Promise.all([
        fetchLiveCosts(startDate, endDate, [provider as 'aws' | 'azure' | 'gcp']),
        fetchLiveCosts(sixMonthsAgo, endDate, [provider as 'aws' | 'azure' | 'gcp']),
        fetchExpensiveResources(provider as 'aws' | 'azure' | 'gcp', startDateStr, endDateStr, 10),
      ]);

      send('status', { message: 'Data fetched. Computing sections...', step: 2, total: 11 });

      const formattedCurrent = currentPeriodRecords.map(d => ({ date: d.date, service: d.serviceName, cost: d.cost }));
      const formattedHistorical = historicalRecords.map(d => ({ date: d.date, service: d.serviceName, cost: d.cost }));

      const serviceAggregation: Record<string, number> = {};
      for (const r of formattedCurrent) {
        serviceAggregation[r.service] = (serviceAggregation[r.service] || 0) + r.cost;
      }
      const resourceCosts = Object.entries(serviceAggregation).map(([service, cost]) => ({
        resourceId: `${service}-aggregate`, service, cost, resourceName: service, region: 'us-east-1', owner: 'Unknown',
      }));

      const uniqueData = Array.from(
        new Map([...formattedCurrent, ...formattedHistorical].map(item => [`${item.date}-${item.service}`, item])).values()
      );

      // ── Step 2-11: Run each section and stream as it completes ───────────
      const now = endDate;
      const periodStart = startDate;
      const periodStartStr = periodStart.toISOString().split('T')[0];
      const periodEndStr = now.toISOString().split('T')[0];

      const currentMonthData = uniqueData.filter(d => d.date >= periodStartStr && d.date <= periodEndStr);
      const previousMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const previousMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
      const previousMonthData = uniqueData.filter(d =>
        d.date >= previousMonthStart.toISOString().split('T')[0] &&
        d.date <= previousMonthEnd.toISOString().split('T')[0]
      );

      // Section: topCostDrivers
      let _topCostDrivers: any = [];
      try {
        send('status', { message: 'Analyzing top cost drivers...', step: 3, total: 11 });
        const { analyzeTopCostDrivers } = await import('./reports/cost-trend-analyzer');
        _topCostDrivers = analyzeTopCostDrivers(currentMonthData, previousMonthData, 5);
        send('topCostDrivers', _topCostDrivers);
      } catch (e: any) { sendError('topCostDrivers', e.message); }

      // Section: wasteDetection (needed for spendOverview)
      let wasteDetection: any = { potentialSaving: 0, idleResources: [], rightsizingOpportunities: [] };
      try {
        send('status', { message: 'Detecting waste...', step: 4, total: 11 });
        const { detectWaste } = await import('./reports/waste-detector');
        wasteDetection = await detectWaste(provider as any, resourceCosts);
        send('wasteDetection', wasteDetection);
      } catch (e: any) { sendError('wasteDetection', e.message); }

      // Section: spendOverview
      let _spendOverview: any = null;
      try {
        send('status', { message: 'Calculating spend overview...', step: 5, total: 11 });
        const { calculateSpendOverview } = await import('./reports/spend-calculator');
        _spendOverview = await calculateSpendOverview(
          provider as any,
          currentMonthData.map(d => ({ date: d.date, cost: d.cost })),
          wasteDetection.potentialSaving,
          { startDate: periodStart, endDate: now }
        );
        send('spendOverview', _spendOverview);
      } catch (e: any) { sendError('spendOverview', e.message); }

      // Section: expensiveResources — use API result if available, else fall back to service aggregation
      const _expensiveResources = expensiveResourcesList.length > 0
        ? expensiveResourcesList
        : resourceCosts
            .sort((a, b) => b.cost - a.cost)
            .slice(0, 10)
            .map(r => ({
              resourceId: r.resourceId,
              resourceName: r.resourceName,
              service: r.service,
              cost: r.cost,
              region: r.region,
              owner: r.owner,
            }));
      send('expensiveResources', _expensiveResources);

      // Section: costTrend
      let _costTrend: any = [];
      try {
        send('status', { message: 'Analyzing cost trend...', step: 6, total: 11 });
        const { analyzeCostTrend } = await import('./reports/cost-trend-analyzer');
        _costTrend = await analyzeCostTrend(uniqueData, 6);
        send('costTrend', _costTrend);
      } catch (e: any) { sendError('costTrend', e.message); }

      // Section: anomalies
      let _anomalies: any = [];
      try {
        send('status', { message: 'Detecting anomalies...', step: 7, total: 11 });
        const { detectAnomalies } = await import('./reports/anomaly-detector');
        const thirtyDaysAgo = new Date(now);
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const last30 = uniqueData.filter(d => d.date >= thirtyDaysAgo.toISOString().split('T')[0]);
        _anomalies = detectAnomalies(last30, 30);
        send('anomalies', _anomalies);
      } catch (e: any) { sendError('anomalies', e.message); }

      // Section: utilizationData + optimizationOpportunities
      let _utilizationData: any = [];
      let _optimizationOpportunities: any = [];
      try {
        send('status', { message: 'Calculating optimization opportunities...', step: 8, total: 11 });
        const { getResourceUtilization } = await import('./reports/waste-detector');
        const { calculateOptimizationOpportunities } = await import('./reports/optimization-calculator');
        _utilizationData = await getResourceUtilization(provider as any, resourceCosts);
        send('utilizationData', _utilizationData);
        const totalCost = currentMonthData.reduce((s, d) => s + d.cost, 0);
        const storageCost = currentMonthData.filter(d => d.service.toLowerCase().includes('storage') || d.service.toLowerCase().includes('s3')).reduce((s, d) => s + d.cost, 0);
        _optimizationOpportunities = calculateOptimizationOpportunities(
          wasteDetection,
          { onDemandPercent: 70, onDemandCost: totalCost * 0.7 },
          { totalStorageCost: storageCost, tieringOpportunity: storageCost * 0.2 }
        );
        send('optimizationOpportunities', _optimizationOpportunities);
      } catch (e: any) { sendError('optimizationOpportunities', e.message); }

      // Section: departmentAllocation + heatmapData
      let _departmentAllocation: any = [];
      let _heatmapData: any = [];
      try {
        send('status', { message: 'Allocating costs by department...', step: 9, total: 11 });
        const { allocateCostsByDepartment, generateHeatmapData } = await import('./reports/department-allocator');
        const serviceCostMap = new Map<string, number>();
        for (const r of currentMonthData) serviceCostMap.set(r.service, (serviceCostMap.get(r.service) || 0) + r.cost);
        const aggregatedServiceCosts = Array.from(serviceCostMap.entries()).map(([service, cost]) => ({ service, cost }));
        const deptResult = await allocateCostsByDepartment(provider as any, aggregatedServiceCosts);
        _departmentAllocation = deptResult.allocations;
        _heatmapData = generateHeatmapData(deptResult.fullServiceData);
        send('departmentAllocation', _departmentAllocation);
        send('heatmapData', _heatmapData);
      } catch (e: any) { sendError('departmentAllocation', e.message); }

      // Section: aiSpendAnalysis
      let _aiSpendAnalysis: any = { totalAISpend: 0, aiServices: [], aiPercentageOfTotal: 0, topAIService: 'None', monthOverMonthChange: 0 };
      try {
        send('status', { message: 'Analyzing AI service costs...', step: 10, total: 11 });
        const { analyzeAICosts } = await import('./reports/ai-cost-analyzer');
        _aiSpendAnalysis = accountId
          ? await analyzeAICosts(provider as any, accountId, periodStartStr, periodEndStr)
          : { totalAISpend: 0, aiServices: [], aiPercentageOfTotal: 0, topAIService: 'None', monthOverMonthChange: 0 };
        send('aiSpendAnalysis', _aiSpendAnalysis);
      } catch (e: any) { sendError('aiSpendAnalysis', e.message); }

      // Assemble full report from already-computed sections and save to cache+DB
      // Do this BEFORE sending 'done' so next visit is instant — no re-running anything
      send('status', { message: 'Saving to cache...', step: 11, total: 11 });
      try {
        const { persistentCache } = await import('./utils/persistent-cache');
        const cacheKey = `finops-report:${provider}:${startDateStr}:${endDateStr}`;
        const builtReport = {
          provider,
          generatedAt: new Date().toISOString(),
          dateRange: { start: periodStartStr, end: periodEndStr },
          spendOverview: _spendOverview,
          topCostDrivers: _topCostDrivers,
          expensiveResources: _expensiveResources,
          costTrend: _costTrend,
          anomalies: _anomalies,
          wasteDetection: wasteDetection,
          utilizationData: _utilizationData,
          optimizationOpportunities: _optimizationOpportunities,
          departmentAllocation: _departmentAllocation,
          heatmapData: _heatmapData,
          aiSpendAnalysis: _aiSpendAnalysis,
        };
        persistentCache.set(cacheKey, builtReport, 60 * 60 * 1000);
        await storage.upsertReportCache({
          cacheKey, provider: provider as string,
          startDate: startDateStr, endDate: endDateStr,
          reportData: builtReport, fetchedAt: new Date(),
        });
        console.log(`[FinOps Stream] Report saved to cache+DB`);
      } catch (e: any) {
        console.error('[FinOps Stream] Failed to save to cache:', e.message);
      }

      send('done', { message: 'Report complete' });
    } catch (error: any) {
      send('error', { message: error.message || 'Failed to generate report' });
    } finally {
      res.end();
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
      const { detectAnomaliesTS: detectAnomaliesForExport } = await import('./utils/anomaly-detector');
      const anomalyResult = detectAnomaliesForExport(costData);

      if (!anomalyResult.anomalies) {
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
      const { detectAnomaliesTS: detectAnomaliesForReport } = await import('./utils/anomaly-detector');
      const anomalyResult = detectAnomaliesForReport(costData);
      const anomalies = anomalyResult.anomalies || [];
      
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

  // ==================== MULTI-CLOUD ENDPOINTS ====================
  
  // Get all cloud accounts
  app.get("/api/cloud-accounts", async (req, res) => {
    try {
      const { provider } = req.query;
      const accounts = await storage.getAllCloudAccounts(provider as schema.CloudProvider);
      
      // Never return sensitive credentials to client
      const safeAccounts = accounts.map(acc => ({
        id: acc.id,
        provider: acc.provider,
        accountName: acc.accountName,
        accountId: acc.accountId,
        isActive: acc.isActive,
        lastSyncAt: acc.lastSyncAt,
        createdAt: acc.createdAt,
        // credentials are intentionally omitted
      }));
      
      res.json({ success: true, accounts: safeAccounts });
    } catch (error) {
      console.error("Error fetching cloud accounts:", error);
      res.status(500).json({ success: false, error: "Failed to fetch cloud accounts" });
    }
  });
  
  // Create cloud account
  app.post("/api/cloud-accounts", async (req, res) => {
    try {
      const accountData: schema.InsertCloudAccount = {
        provider: req.body.provider,
        accountName: req.body.accountName,
        accountId: req.body.accountId,
        credentials: req.body.credentials,
        refreshInterval: req.body.refreshInterval || 86400,
        isActive: req.body.isActive !== undefined ? req.body.isActive : true,
      };
      
      const account = await storage.createCloudAccount(accountData);
      
      res.json({
        success: true,
        account: {
          id: account.id,
          provider: account.provider,
          accountName: account.accountName,
          accountId: account.accountId,
          isActive: account.isActive,
        }
      });
    } catch (error) {
      console.error("Error creating cloud account:", error);
      res.status(400).json({ success: false, error: "Failed to create cloud account" });
    }
  });
  
  // Update cloud account
  app.patch("/api/cloud-accounts/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const account = await storage.updateCloudAccount(id, req.body);
      
      if (!account) {
        return res.status(404).json({ success: false, error: "Cloud account not found" });
      }
      
      res.json({
        success: true,
        account: {
          id: account.id,
          provider: account.provider,
          accountName: account.accountName,
          accountId: account.accountId,
          isActive: account.isActive,
        }
      });
    } catch (error) {
      console.error("Error updating cloud account:", error);
      res.status(400).json({ success: false, error: "Failed to update cloud account" });
    }
  });
  
  // Delete cloud account
  app.delete("/api/cloud-accounts/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const success = await storage.deleteCloudAccount(id);
      
      if (!success) {
        return res.status(404).json({ success: false, error: "Cloud account not found" });
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting cloud account:", error);
      res.status(500).json({ success: false, error: "Failed to delete cloud account" });
    }
  });
  
  // ==================== BUDGET MANAGEMENT ====================
  
  // Get all budgets
  app.get("/api/budgets", async (req, res) => {
    try {
      const { provider } = req.query;
      const budgets = await storage.getAllBudgets(provider as schema.CloudProvider);
      res.json({ success: true, budgets });
    } catch (error) {
      console.error("Error fetching budgets:", error);
      res.status(500).json({ success: false, error: "Failed to fetch budgets" });
    }
  });
  
  // Create budget
  app.post("/api/budgets", async (req, res) => {
    try {
      const budgetData: schema.InsertBudget = {
        budgetName: req.body.budgetName || req.body.name,
        provider: req.body.provider,
        accountId: req.body.accountId,
        serviceName: req.body.serviceName,
        amount: String(req.body.amount),
        period: req.body.period || 'monthly',
        startDate: new Date(req.body.startDate || Date.now()),
        endDate: req.body.endDate ? new Date(req.body.endDate) : undefined,
        alertThresholds: req.body.alertThresholds || { 50: true, 75: true, 90: true, 100: true },
        isActive: req.body.isActive !== undefined ? req.body.isActive : true,
      };
      
      const budget = await storage.createBudget(budgetData);
      res.json({ success: true, budget });
    } catch (error) {
      console.error("Error creating budget:", error);
      res.status(400).json({ success: false, error: "Failed to create budget" });
    }
  });
  
  // Update budget
  app.patch("/api/budgets/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      
      // Ensure dates are properly formatted, preserving explicit null values
      const updates: any = { ...req.body };
      
      if ('startDate' in req.body) {
        updates.startDate = req.body.startDate ? new Date(req.body.startDate) : undefined;
      }
      
      if ('endDate' in req.body) {
        // Preserve explicit null to allow clearing the end date
        updates.endDate = req.body.endDate === null ? null : 
                         req.body.endDate ? new Date(req.body.endDate) : undefined;
      }
      
      const budget = await storage.updateBudget(id, updates);
      
      if (!budget) {
        return res.status(404).json({ success: false, error: "Budget not found" });
      }
      
      res.json({ success: true, budget });
    } catch (error) {
      console.error("Error updating budget:", error);
      res.status(400).json({ success: false, error: "Failed to update budget" });
    }
  });
  
  // Delete budget
  app.delete("/api/budgets/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const success = await storage.deleteBudget(id);
      
      if (!success) {
        return res.status(404).json({ success: false, error: "Budget not found" });
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting budget:", error);
      res.status(500).json({ success: false, error: "Failed to delete budget" });
    }
  });
  
  // Check budget alerts (manual trigger)
  app.post("/api/budgets/check-alerts", async (_req, res) => {
    try {
      const results = await checkBudgetAlerts();
      res.json({ 
        success: true, 
        ...results,
        message: `Checked ${results.checked} budgets, sent ${results.alerted} alerts`
      });
    } catch (error) {
      console.error("Error checking budget alerts:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to check budget alerts",
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
  
  // Get current spending for a specific budget
  app.get("/api/budgets/:id/spending", async (req, res) => {
    try {
      const budgetId = Number(req.params.id);
      const budget = await storage.getBudget(budgetId);
      
      if (!budget) {
        return res.status(404).json({ success: false, error: "Budget not found" });
      }
      
      // Get current month start/end dates
      const now = new Date();
      const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const currentMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
      
      // Fetch cost data based on budget filters
      const sampleData = loadMultiCloudSampleData();
      const awsConfigured = await isAWSConfigured();
      let costData;
      
      // Determine which provider's data to use
      if (budget.provider === 'aws') {
        if (awsConfigured) {
          const awsResult = await fetchRealAWSData();
          if (awsResult?.success && awsResult.data.length > 0) {
            const { processMultiCloudCosts } = await import('./utils/multi-cloud-processor');
            costData = processMultiCloudCosts(awsResult.data);
          } else {
            costData = sampleData.awsOnly;
          }
        } else {
          costData = sampleData.awsOnly;
        }
      } else if (budget.provider === 'gcp') {
        costData = sampleData.gcpOnly;
      } else if (budget.provider === 'azure') {
        costData = sampleData.azureOnly;
      } else {
        // No provider specified - use all data
        if (awsConfigured) {
          const awsResult = await fetchRealAWSData();
          if (awsResult?.success && awsResult.data.length > 0) {
            const { processMultiCloudCosts } = await import('./utils/multi-cloud-processor');
            const allData = [
              ...awsResult.data,
              ...sampleData.gcpData,
              ...sampleData.azureData
            ];
            costData = processMultiCloudCosts(allData);
          } else {
            costData = sampleData.allProviders;
          }
        } else {
          costData = sampleData.allProviders;
        }
      }
      
      // Filter by current month
      const currentMonthTrends = costData.dailyTrends.filter((day: any) => {
        const dayDate = new Date(day.date);
        return dayDate >= currentMonthStart && dayDate <= currentMonthEnd;
      });
      
      // Calculate spending based on service filter
      let currentSpending = 0;
      
      if (budget.serviceName) {
        // Filter by specific service
        const serviceName = budget.serviceName; // TypeScript narrowing
        currentSpending = currentMonthTrends.reduce((sum: number, day: any) => {
          const serviceCost = day.services[serviceName] || 0;
          return sum + serviceCost;
        }, 0);
      } else {
        // Total spending (all services)
        currentSpending = currentMonthTrends.reduce((sum: number, day: any) => {
          return sum + day.cost;
        }, 0);
      }
      
      res.json({
        success: true,
        currentSpending,
        budgetAmount: parseFloat(budget.amount),
        percentage: (currentSpending / parseFloat(budget.amount)) * 100,
        period: 'current_month',
        monthStart: currentMonthStart.toISOString(),
        monthEnd: currentMonthEnd.toISOString(),
      });
    } catch (error) {
      console.error("Error calculating budget spending:", error);
      res.status(500).json({ success: false, error: "Failed to calculate budget spending" });
    }
  });
  
  // Get available services for a cloud provider
  app.get("/api/services", async (req, res) => {
    try {
      const { provider } = req.query;
      
      if (!provider || !['aws', 'gcp', 'azure'].includes(provider as string)) {
        return res.status(400).json({ 
          success: false, 
          error: "Valid provider parameter required (aws, gcp, or azure)" 
        });
      }
      
      // Load cost data to extract service names
      const sampleData = loadMultiCloudSampleData();
      const awsConfigured = await isAWSConfigured();
      let costData;
      
      if (provider === 'aws') {
        if (awsConfigured) {
          const awsResult = await fetchRealAWSData();
          if (awsResult?.success && awsResult.data.length > 0) {
            const { processMultiCloudCosts } = await import('./utils/multi-cloud-processor');
            costData = processMultiCloudCosts(awsResult.data);
          } else {
            costData = sampleData.awsOnly;
          }
        } else {
          costData = sampleData.awsOnly;
        }
      } else if (provider === 'gcp') {
        costData = sampleData.gcpOnly;
      } else {
        costData = sampleData.azureOnly;
      }
      
      // Extract unique service names from service breakdown
      const services = costData.serviceBreakdown.map((service: any) => ({
        name: service.name,
        cost: service.cost,
        percentage: service.percentage,
      }));
      
      res.json({ 
        success: true, 
        services,
        provider 
      });
    } catch (error) {
      console.error("Error fetching services:", error);
      res.status(500).json({ success: false, error: "Failed to fetch services" });
    }
  });
  
  // ==================== MULTI-CLOUD COST DATA ====================
  
  // Get multi-cloud cost data with sample data for AWS/GCP
  app.get("/api/multi-cloud/costs", async (req, res) => {
    try {
      const { provider, startDate, endDate } = req.query;
      
      // Import multi-cloud utilities
      const { fetchAwsCosts } = await import('./utils/aws-cost-client');
      const { fetchGcpCosts } = await import('./utils/gcp-cost-client');
      const { 
        processMultiCloudCosts, 
        normalizeAwsCosts, 
        normalizeGcpCosts,
        normalizeAzureCosts 
      } = await import('./utils/multi-cloud-processor');
      
      const allCostData = [];
      
      // Generate sample AWS data
      if (!provider || provider === 'aws') {
        try {
          const awsData = await fetchAwsCosts({
            accessKeyId: 'mock',
            secretAccessKey: 'mock',
            region: 'us-east-1',
            startDate: startDate as string || '2025-01-01',
            endDate: endDate as string || '2025-01-31',
          });
          allCostData.push(...normalizeAwsCosts(awsData));
        } catch (error) {
          console.warn('AWS cost fetch failed, using sample data');
        }
      }
      
      // Generate sample GCP data
      if (!provider || provider === 'gcp') {
        try {
          const gcpData = await fetchGcpCosts({
            projectId: 'sample-project',
            clientEmail: 'mock@example.com',
            privateKey: 'mock',
            startDate: startDate as string || '2025-01-01',
            endDate: endDate as string || '2025-01-31',
          });
          allCostData.push(...normalizeGcpCosts(gcpData));
        } catch (error) {
          console.warn('GCP cost fetch failed, using sample data');
        }
      }
      
      // Add Azure data if available
      if ((!provider || provider === 'azure') && cachedCostData) {
        // Convert Azure processed data to unified format
        // This is a simplified conversion - in production would query from costHistory
        const azureUnified = cachedCostData.dailyTrends.flatMap((day: any) =>
          Object.entries(day.services).map(([serviceName, cost]) => ({
            provider: 'azure' as schema.CloudProvider,
            accountId: 'azure-subscription',
            accountName: 'Azure Subscription',
            date: day.date,
            serviceName,
            region: undefined,
            cost: cost as number,
            currency: 'USD',
            tags: {},
            metadata: {},
          }))
        );
        allCostData.push(...azureUnified);
      }
      
      // Process and return unified data
      const processedData = processMultiCloudCosts(allCostData, provider as schema.CloudProvider);
      
      res.json({
        success: true,
        data: processedData,
        provider: provider || 'all',
        dateRange: {
          start: startDate || '2025-01-01',
          end: endDate || '2025-01-31',
        }
      });
    } catch (error) {
      console.error("Error fetching multi-cloud costs:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to fetch multi-cloud costs",
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
  
  // Multi-cloud comparison
  app.get("/api/multi-cloud/comparison", async (req, res) => {
    try {
      const { period = 'monthly' } = req.query;
      
      const { fetchAwsCosts } = await import('./utils/aws-cost-client');
      const { fetchGcpCosts } = await import('./utils/gcp-cost-client');
      const { 
        normalizeAwsCosts, 
        normalizeGcpCosts,
        calculateMultiCloudComparison 
      } = await import('./utils/multi-cloud-processor');
      
      const allCostData = [];
      
      // Fetch all providers
      const awsData = await fetchAwsCosts({
        accessKeyId: 'mock',
        secretAccessKey: 'mock',
        region: 'us-east-1',
        startDate: '2025-01-01',
        endDate: '2025-01-31',
      });
      allCostData.push(...normalizeAwsCosts(awsData));
      
      const gcpData = await fetchGcpCosts({
        projectId: 'sample-project',
        clientEmail: 'mock@example.com',
        privateKey: 'mock',
        startDate: '2025-01-01',
        endDate: '2025-01-31',
      });
      allCostData.push(...normalizeGcpCosts(gcpData));
      
      // Add Azure if available
      if (cachedCostData) {
        const azureUnified = cachedCostData.dailyTrends.flatMap((day: any) =>
          Object.entries(day.services).map(([serviceName, cost]) => ({
            provider: 'azure' as schema.CloudProvider,
            accountId: 'azure-subscription',
            accountName: 'Azure Subscription',
            date: day.date,
            serviceName,
            cost: cost as number,
            currency: 'USD',
            tags: {},
          }))
        );
        allCostData.push(...azureUnified);
      }
      
      const comparison = calculateMultiCloudComparison(allCostData);
      
      res.json({
        success: true,
        comparison,
        period,
      });
    } catch (error) {
      console.error("Error calculating multi-cloud comparison:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to calculate multi-cloud comparison" 
      });
    }
  });
  
  // ==================== RESOURCE INVENTORY ====================
  
  // Get resource inventory
  app.get("/api/resources", async (req, res) => {
    try {
      const { provider, state } = req.query;
      const resources = await storage.getResourceInventory(
        provider as schema.CloudProvider,
        state as string
      );
      res.json({ success: true, resources });
    } catch (error) {
      console.error("Error fetching resource inventory:", error);
      res.status(500).json({ success: false, error: "Failed to fetch resource inventory" });
    }
  });
  
  // Get idle resources
  app.get("/api/resources/idle", async (req, res) => {
    try {
      const { provider } = req.query;
      const resources = await storage.getIdleResources(provider as schema.CloudProvider);
      res.json({ success: true, resources });
    } catch (error) {
      console.error("Error fetching idle resources:", error);
      res.status(500).json({ success: false, error: "Failed to fetch idle resources" });
    }
  });
  
  // ==================== TAG ANALYSIS ====================
  
  // Get tag analysis
  app.get("/api/tags/allocation", async (req, res) => {
    try {
      const { provider, period } = req.query;
      const analysis = await storage.getTagAnalysis(
        provider as schema.CloudProvider,
        period as string
      );
      res.json({ success: true, analysis });
    } catch (error) {
      console.error("Error fetching tag analysis:", error);
      res.status(500).json({ success: false, error: "Failed to fetch tag analysis" });
    }
  });
  
  // ==================== SAVINGS PLANS ====================
  
  // Get savings plans
  app.get("/api/savings/plans", async (req, res) => {
    try {
      const { provider, status } = req.query;
      const plans = await storage.getSavingsPlans(
        provider as schema.CloudProvider,
        status as string
      );
      res.json({ success: true, plans });
    } catch (error) {
      console.error("Error fetching savings plans:", error);
      res.status(500).json({ success: false, error: "Failed to fetch savings plans" });
    }
  });
  
  // ==================== OPTIMIZATION RECOMMENDATIONS ====================
  
  // Get optimization recommendations
  app.get("/api/optimization/recommendations", async (req, res) => {
    try {
      const { provider, accountId } = req.query;
      // Validate provider - treat missing/invalid as "all providers" (undefined)
      const validProvider = (provider && ['aws', 'gcp', 'azure'].includes(provider as string)) 
        ? (provider as schema.CloudProvider) 
        : undefined;
      
      const recommendations = await storage.getActiveRecommendations(
        accountId as string,
        validProvider
      );
      res.json({ success: true, recommendations });
    } catch (error) {
      console.error("Error fetching recommendations:", error);
      res.status(500).json({ success: false, error: "Failed to fetch recommendations" });
    }
  });
  
  // Update recommendation status
  app.patch("/api/optimization/recommendations/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updates = req.body;
      const updated = await storage.updateOptimizationRecommendation(id, updates);
      res.json({ success: true, recommendation: updated });
    } catch (error) {
      console.error("Error updating recommendation:", error);
      res.status(500).json({ success: false, error: "Failed to update recommendation" });
    }
  });
  
  // ==================== ANOMALY EVENTS ====================
  
  // Get anomaly events
  app.get("/api/anomalies/events", async (req, res) => {
    try {
      const { provider, status } = req.query;
      const events = await storage.getAnomalyEvents(
        provider as schema.CloudProvider,
        status as string
      );
      res.json({ success: true, events });
    } catch (error) {
      console.error("Error fetching anomaly events:", error);
      res.status(500).json({ success: false, error: "Failed to fetch anomaly events" });
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

  // ==================== AGENTIC AI ENDPOINTS ====================
  
  // Import AI Agent Planner, Action Executor, and Self-Correction Engine
  const { aiAgentPlanner } = await import('./ai-agent-planner');
  const { aiActionExecutor } = await import('./ai-action-executor');
  const { aiSelfCorrection } = await import('./ai-self-correction');

  // Zod validation schemas for agent endpoints
  const createPlanSchema = z.object({
    goal: z.string().min(1, "Goal is required"),
    provider: z.enum(['aws', 'gcp', 'azure', 'all']).optional(),
    includeContext: z.boolean().optional(),
  });

  const approveActionSchema = z.object({
    approvedBy: z.string().min(1, "Approver name is required"),
  });

  const rejectActionSchema = z.object({
    reason: z.string().min(1, "Rejection reason is required"),
  });

  const submitFeedbackSchema = z.object({
    outcome: z.enum(['success', 'partial', 'failed', 'rolled_back']),
    actualSavings: z.number().optional(),
    userSatisfaction: z.number().min(1).max(5).optional(),
    notes: z.string().optional(),
  });

  // POST /api/agent/plan - Generate an optimization plan
  app.post("/api/agent/plan", async (req, res) => {
    try {
      // Validate request body
      const validation = createPlanSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ 
          error: "Invalid request", 
          details: validation.error.errors 
        });
      }

      const { goal, provider, includeContext } = validation.data;

      // Gather context if requested
      let context: any = { goal, provider };

      if (includeContext) {
        const providerFilter = provider || 'all';

        // Get current cost data
        const sampleData = loadMultiCloudSampleData();
        const filteredData = providerFilter === 'all' 
          ? sampleData.allCostData 
          : sampleData[`${providerFilter}Data` as keyof typeof sampleData] as any[];

        context.currentCostData = {
          totalCost: filteredData.reduce((sum: number, d: any) => sum + d.cost, 0),
          avgDailyCost: filteredData.reduce((sum: number, d: any) => sum + d.cost, 0) / 30,
          serviceCount: new Set(filteredData.map((d: any) => d.serviceName)).size,
          topService: {
            name: filteredData[0]?.serviceName || 'Unknown',
            cost: filteredData[0]?.cost || 0
          },
          serviceBreakdown: Object.entries(
            filteredData.reduce((acc: any, d: any) => {
              acc[d.serviceName] = (acc[d.serviceName] || 0) + d.cost;
              return acc;
            }, {})
          ).map(([name, cost]) => ({ name, cost })).slice(0, 5)
        };

        // Fetch real AWS resource inventory if provider is AWS or all
        if (providerFilter === 'aws' || providerFilter === 'all') {
          try {
            const { getAWSResourceInventory } = await import('./aws-resource-inventory');
            const awsInventory = await getAWSResourceInventory();
            
            if (awsInventory.hasErrors) {
              console.warn('[Agent Planner] AWS resource inventory has errors:', awsInventory.errors);
              context.awsInventoryErrors = awsInventory.errors;
              context.awsInventoryWarning = `ÔÜá´©Å Some AWS resources could not be fetched: ${awsInventory.errors?.map(e => e.resourceType).join(', ')}. Recommendations may be incomplete.`;
            }
            
            console.log('[Agent Planner] Including real AWS resource inventory in context');
            context.awsResources = awsInventory;
          } catch (error) {
            console.error('[Agent Planner] Error fetching AWS resources:', error);
            context.awsResources = null;
            context.awsInventoryWarning = 'ÔÜá´©Å Could not fetch AWS resource inventory. Recommendations will be based on cost data only.';
          }
        }

        // Fetch real Azure resource inventory if provider is Azure or all
        if (providerFilter === 'azure' || providerFilter === 'all') {
          try {
            const { fetchAzureResourceInventory } = await import('./azure-resource-inventory');
            const azureInventory = await fetchAzureResourceInventory();
            
            if (azureInventory.hasErrors) {
              console.warn('[Agent Planner] Azure resource inventory has errors:', azureInventory.errors);
              context.azureInventoryErrors = azureInventory.errors;
              context.azureInventoryWarning = `ÔÜá´©Å Some Azure resources could not be fetched: ${azureInventory.errors?.map(e => e.service).join(', ')}. Recommendations may be incomplete.`;
            }
            
            console.log('[Agent Planner] Including real Azure resource inventory in context');
            context.azureResources = azureInventory;
          } catch (error) {
            console.error('[Agent Planner] Error fetching Azure resources:', error);
            context.azureResources = null;
            context.azureInventoryWarning = 'ÔÜá´©Å Could not fetch Azure resource inventory. Recommendations will be based on cost data only.';
          }
        }

        // Fetch real GCP resource inventory if provider is GCP or all
        if (providerFilter === 'gcp' || providerFilter === 'all') {
          try {
            const { fetchGCPResourceInventory } = await import('./gcp-resource-inventory');
            const gcpInventory = await fetchGCPResourceInventory();
            
            if (gcpInventory.hasErrors) {
              console.warn('[Agent Planner] GCP resource inventory has errors:', gcpInventory.errors);
              context.gcpInventoryErrors = gcpInventory.errors;
              context.gcpInventoryWarning = `ÔÜá´©Å Some GCP resources could not be fetched: ${gcpInventory.errors?.map(e => e.service).join(', ')}. Recommendations may be incomplete.`;
            }
            
            console.log('[Agent Planner] Including real GCP resource inventory in context');
            context.gcpResources = gcpInventory;
          } catch (error) {
            console.error('[Agent Planner] Error fetching GCP resources:', error);
            context.gcpResources = null;
            context.gcpInventoryWarning = 'ÔÜá´©Å Could not fetch GCP resource inventory. Recommendations will be based on cost data only.';
          }
        }

        // Get recent anomalies (with defensive error handling)
        try {
          const anomalies = await storage.getAnomalyEvents(providerFilter === 'all' ? undefined : providerFilter as CloudProvider);
          context.anomalies = anomalies.slice(0, 3);
        } catch (error) {
          console.log('Could not fetch anomalies (table may not exist yet):', error);
          context.anomalies = [];
        }

        // Get existing recommendations (with defensive error handling)
        try {
          const recommendations = await storage.getActiveRecommendations(undefined, providerFilter === 'all' ? undefined : providerFilter as CloudProvider);
          context.recommendations = recommendations.slice(0, 5);
        } catch (error) {
          console.log('Could not fetch recommendations (table may not exist yet):', error);
          context.recommendations = [];
        }
      }

      // Generate the plan
      const plan = await aiAgentPlanner.generateOptimizationPlan(context);

      res.json(plan);
    } catch (error: any) {
      console.error("Error generating optimization plan:", error);
      res.status(500).json({ error: error.message || "Failed to generate optimization plan" });
    }
  });

  // GET /api/agent/plans - List all optimization plans
  app.get("/api/agent/plans", async (req, res) => {
    try {
      const { status, provider } = req.query;

      let query = db.select().from(schema.optimizationPlans);

      if (status) {
        query = query.where(eq(schema.optimizationPlans.status, status as string)) as any;
      }

      if (provider) {
        query = query.where(eq(schema.optimizationPlans.provider, provider as string)) as any;
      }

      const plans = await query.orderBy(schema.optimizationPlans.createdAt);
      res.json(plans);
    } catch (error: any) {
      console.error("Error fetching plans:", error);
      res.status(500).json({ error: error.message || "Failed to fetch plans" });
    }
  });

  // GET /api/agent/plans/:id - Get specific plan with actions
  app.get("/api/agent/plans/:id", async (req, res) => {
    try {
      const planId = parseInt(req.params.id);

      const plan = await db.select().from(schema.optimizationPlans).where(eq(schema.optimizationPlans.id, planId)).limit(1);

      if (plan.length === 0) {
        return res.status(404).json({ error: "Plan not found" });
      }

      const actions = await db.select().from(schema.optimizationActions).where(eq(schema.optimizationActions.planId, planId));

      res.json({
        ...plan[0],
        actions
      });
    } catch (error: any) {
      console.error("Error fetching plan:", error);
      res.status(500).json({ error: error.message || "Failed to fetch plan" });
    }
  });

  // DELETE /api/agent/plans/:id - Delete a plan and its associated actions
  app.delete("/api/agent/plans/:id", async (req, res) => {
    try {
      const planId = parseInt(req.params.id);

      // Check if plan exists
      const plan = await db.select().from(schema.optimizationPlans).where(eq(schema.optimizationPlans.id, planId)).limit(1);

      if (plan.length === 0) {
        return res.status(404).json({ error: "Plan not found" });
      }

      // Delete associated actions first
      await db.delete(schema.optimizationActions).where(eq(schema.optimizationActions.planId, planId));

      // Delete the plan
      await db.delete(schema.optimizationPlans).where(eq(schema.optimizationPlans.id, planId));

      res.json({ success: true, message: "Plan and associated actions deleted successfully" });
    } catch (error: any) {
      console.error("Error deleting plan:", error);
      res.status(500).json({ error: error.message || "Failed to delete plan" });
    }
  });

  // PATCH /api/agent/plans/reorder - Update positions of multiple plans
  app.patch("/api/agent/plans/reorder", async (req, res) => {
    try {
      const { planIds } = req.body;

      if (!Array.isArray(planIds) || planIds.length === 0) {
        return res.status(400).json({ error: "Invalid request: planIds must be a non-empty array" });
      }

      // Update position for each plan
      for (let i = 0; i < planIds.length; i++) {
        await db.update(schema.optimizationPlans)
          .set({ position: i })
          .where(eq(schema.optimizationPlans.id, planIds[i]));
      }

      res.json({ success: true, message: "Plan positions updated successfully" });
    } catch (error: any) {
      console.error("Error reordering plans:", error);
      res.status(500).json({ error: error.message || "Failed to reorder plans" });
    }
  });

  // GET /api/agent/actions - List all optimization actions
  app.get("/api/agent/actions", async (req, res) => {
    try {
      const { status, provider, planId } = req.query;

      let query = db.select().from(schema.optimizationActions);

      if (status) {
        query = query.where(eq(schema.optimizationActions.status, status as string)) as any;
      }

      if (provider) {
        query = query.where(eq(schema.optimizationActions.provider, provider as string)) as any;
      }

      if (planId) {
        query = query.where(eq(schema.optimizationActions.planId, parseInt(planId as string))) as any;
      }

      const actions = await query.orderBy(schema.optimizationActions.createdAt);
      res.json(actions);
    } catch (error: any) {
      console.error("Error fetching actions:", error);
      res.status(500).json({ error: error.message || "Failed to fetch actions" });
    }
  });

  // POST /api/agent/actions/:id/approve - Approve an action
  app.post("/api/agent/actions/:id/approve", async (req, res) => {
    try {
      // Validate request body
      const validation = approveActionSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ 
          error: "Invalid request", 
          details: validation.error.errors 
        });
      }

      const actionId = parseInt(req.params.id);
      const { approvedBy } = validation.data;

      const result = await db.update(schema.optimizationActions)
        .set({
          status: 'approved',
          approvedAt: new Date(),
          approvedBy: approvedBy || 'user'
        })
        .where(eq(schema.optimizationActions.id, actionId))
        .returning();

      if (result.length === 0) {
        return res.status(404).json({ error: "Action not found" });
      }

      res.json(result[0]);
    } catch (error: any) {
      console.error("Error approving action:", error);
      res.status(500).json({ error: error.message || "Failed to approve action" });
    }
  });

  // POST /api/agent/actions/:id/reject - Reject an action
  app.post("/api/agent/actions/:id/reject", async (req, res) => {
    try {
      // Validate request body
      const validation = rejectActionSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ 
          error: "Invalid request", 
          details: validation.error.errors 
        });
      }

      const actionId = parseInt(req.params.id);
      const { reason } = validation.data;

      const result = await db.update(schema.optimizationActions)
        .set({
          status: 'rejected',
          executionError: reason || 'Rejected by user'
        })
        .where(eq(schema.optimizationActions.id, actionId))
        .returning();

      if (result.length === 0) {
        return res.status(404).json({ error: "Action not found" });
      }

      res.json(result[0]);
    } catch (error: any) {
      console.error("Error rejecting action:", error);
      res.status(500).json({ error: error.message || "Failed to reject action" });
    }
  });

  // GET /api/agent/config - Get agent configuration
  app.get("/api/agent/config", async (req, res) => {
    try {
      const config = await db.select().from(schema.agentConfig).limit(1);
      
      if (config.length === 0) {
        return res.status(404).json({ error: "Agent configuration not found" });
      }

      res.json(config[0]);
    } catch (error: any) {
      console.error("Error fetching agent config:", error);
      res.status(500).json({ error: error.message || "Failed to fetch agent config" });
    }
  });

  // PUT /api/agent/config - Update agent configuration
  app.put("/api/agent/config", async (req, res) => {
    try {
      const updates = req.body;

      const config = await db.select().from(schema.agentConfig).limit(1);
      
      if (config.length === 0) {
        return res.status(404).json({ error: "Agent configuration not found" });
      }

      const result = await db.update(schema.agentConfig)
        .set({
          ...updates,
          updatedAt: new Date()
        })
        .where(eq(schema.agentConfig.id, config[0].id))
        .returning();

      res.json(result[0]);
    } catch (error: any) {
      console.error("Error updating agent config:", error);
      res.status(500).json({ error: error.message || "Failed to update agent config" });
    }
  });

  // POST /api/agent/actions/:id/execute - Execute a single action
  app.post("/api/agent/actions/:id/execute", async (req, res) => {
    try {
      const actionId = parseInt(req.params.id);
      const result = await aiActionExecutor.executeAction(actionId);
      res.json(result);
    } catch (error: any) {
      console.error("Error executing action:", error);
      res.status(500).json({ error: error.message || "Failed to execute action" });
    }
  });

  // POST /api/agent/plans/:id/execute - Execute all approved actions in a plan
  app.post("/api/agent/plans/:id/execute", async (req, res) => {
    try {
      const planId = parseInt(req.params.id);
      const result = await aiActionExecutor.executePlan(planId);
      res.json(result);
    } catch (error: any) {
      console.error("Error executing plan:", error);
      res.status(500).json({ error: error.message || "Failed to execute plan" });
    }
  });

  // POST /api/agent/actions/:id/rollback - Rollback a completed action
  app.post("/api/agent/actions/:id/rollback", async (req, res) => {
    try {
      const actionId = parseInt(req.params.id);
      const result = await aiActionExecutor.rollbackAction(actionId);
      res.json(result);
    } catch (error: any) {
      console.error("Error rolling back action:", error);
      res.status(500).json({ error: error.message || "Failed to rollback action" });
    }
  });

  // POST /api/agent/actions/:id/analyze-failure - Analyze why an action failed
  app.post("/api/agent/actions/:id/analyze-failure", async (req, res) => {
    try {
      const actionId = parseInt(req.params.id);
      const analysis = await aiSelfCorrection.analyzeFailure(actionId);
      res.json(analysis);
    } catch (error: any) {
      console.error("Error analyzing failure:", error);
      res.status(500).json({ error: error.message || "Failed to analyze failure" });
    }
  });

  // POST /api/agent/actions/:id/retry - Retry failed action with alternative strategy
  app.post("/api/agent/actions/:id/retry", async (req, res) => {
    try {
      const actionId = parseInt(req.params.id);
      const result = await aiSelfCorrection.retryWithCorrection(actionId);
      res.json(result);
    } catch (error: any) {
      console.error("Error retrying action:", error);
      res.status(500).json({ error: error.message || "Failed to retry action" });
    }
  });

  // POST /api/agent/auto-correct - Run auto-correction on all failed actions
  app.post("/api/agent/auto-correct", async (req, res) => {
    try {
      const result = await aiSelfCorrection.autoCorrectFailedActions();
      res.json(result);
    } catch (error: any) {
      console.error("Error running auto-correction:", error);
      res.status(500).json({ error: error.message || "Failed to run auto-correction" });
    }
  });

  // DELETE /api/agent/actions/:id - Delete an optimization action
  app.delete("/api/agent/actions/:id", async (req, res) => {
    try {
      const actionId = parseInt(req.params.id);
      
      // Get the action first to retrieve planId
      const [action] = await db.select()
        .from(schema.optimizationActions)
        .where(eq(schema.optimizationActions.id, actionId))
        .limit(1);
      
      if (!action) {
        return res.status(404).json({ error: "Action not found" });
      }

      // Delete the action
      await db.delete(schema.optimizationActions)
        .where(eq(schema.optimizationActions.id, actionId));

      // Update the plan's total steps and completed steps
      const planId = action.planId;
      if (planId) {
        const planActions = await db.select()
          .from(schema.optimizationActions)
          .where(eq(schema.optimizationActions.planId, planId));
        
        const completedCount = planActions.filter((a: any) => a.status === 'completed').length;
        
        await db.update(schema.optimizationPlans)
          .set({
            totalSteps: planActions.length,
            completedSteps: completedCount,
          })
          .where(eq(schema.optimizationPlans.id, planId));
      }

      res.json({ success: true, deletedAction: action });
    } catch (error: any) {
      console.error("Error deleting action:", error);
      res.status(500).json({ error: error.message || "Failed to delete action" });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
