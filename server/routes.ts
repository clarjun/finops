import type { Express } from "express";
import { createServer, type Server } from "http";
import { readFileSync } from "fs";
import { join } from "path";
import { azureCostResponseSchema, aiQueryRequestSchema } from "@shared/schema";
import { processAzureCostData } from "./utils/process-cost-data";
import { runPythonScript } from "./utils/python-runner";
import { openai } from "./openai-client";

// Load sample Azure cost data for initial display
let cachedCostData: any = null;

function loadSampleData() {
  if (!cachedCostData) {
    const samplePath = join(process.cwd(), "attached_assets", "azure_1760597470327.json");
    const sampleData = JSON.parse(readFileSync(samplePath, "utf-8"));
    cachedCostData = processAzureCostData(sampleData);
  }
  return cachedCostData;
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
      const costData = loadSampleData();

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

  const httpServer = createServer(app);

  return httpServer;
}
