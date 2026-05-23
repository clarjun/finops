import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Calculator, Sparkles } from "lucide-react";

interface ArchitectureLayer {
  layer: string;
  service: string;
  configuration?: string;
  monthlyCost?: number;
}

interface CostEstimate {
  architecture: ArchitectureLayer[];
  totalCost: number;
  breakdown: {
    compute: number;
    database: number;
    storage: number;
    network: number;
    other: number;
  };
}

export default function CostEstimator() {
  const [requirements, setRequirements] = useState("");
  const [loading, setLoading] = useState(false);
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);

  const examplePlaceholder = `Example: Describe your application requirements

Application: E-commerce platform
Users: 50,000 monthly active users
Traffic: Medium (10k requests/day)
Database: PostgreSQL with 100GB data
Storage: 500GB for product images
Region: us-east-1
Features: User authentication, payment processing, real-time inventory
Availability: High availability required`;

  const handleEstimate = async () => {
    if (!requirements.trim()) {
      setError("Please enter your application requirements");
      return;
    }

    setLoading(true);
    setError(null);
    setEstimate(null);

    try {
      const response = await fetch("/api/cost-estimator/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requirements }),
      });

      if (!response.ok) {
        throw new Error("Failed to generate estimate");
      }

      const data = await response.json();
      setEstimate(data.estimate);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate estimate");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Calculator className="h-8 w-8 text-primary" />
        <div>
          <h1 className="text-3xl font-bold">Cost Estimator</h1>
          <p className="text-muted-foreground">
            AI-powered cloud architecture and cost estimation
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            Describe Your Application
          </CardTitle>
          <CardDescription>
            Tell us about your application requirements, and we'll suggest an optimal architecture with cost estimates
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            placeholder={examplePlaceholder}
            value={requirements}
            onChange={(e) => setRequirements(e.target.value)}
            className="min-h-[200px] font-mono text-sm"
          />
          
          <Button 
            onClick={handleEstimate} 
            disabled={loading || !requirements.trim()}
            className="w-full"
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Generating Architecture & Estimate...
              </>
            ) : (
              <>
                <Calculator className="mr-2 h-4 w-4" />
                Generate Cost Estimate
              </>
            )}
          </Button>

          {error && (
            <div className="p-4 bg-destructive/10 text-destructive rounded-md">
              {error}
            </div>
          )}
        </CardContent>
      </Card>

      {estimate && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Recommended Architecture</CardTitle>
              <CardDescription>
                AI-generated architecture based on your requirements
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {estimate.architecture
                  .filter(layer => (layer.monthlyCost ?? 0) > 0) // Only show services with cost > 0
                  .map((layer, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-4 bg-muted rounded-lg"
                    >
                      <div className="flex-1">
                        <div className="font-semibold text-sm text-muted-foreground">
                          {layer.layer}
                        </div>
                        <div className="font-medium">{layer.service}</div>
                        {layer.configuration && (
                          <div className="text-sm text-muted-foreground mt-1">
                            {layer.configuration}
                          </div>
                        )}
                      </div>
                      {layer.monthlyCost !== undefined && (
                        <div className="text-right">
                          <div className="font-bold text-lg">
                            ${layer.monthlyCost.toFixed(2)}
                          </div>
                          <div className="text-xs text-muted-foreground">per month</div>
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Monthly Cost Estimate</CardTitle>
              <CardDescription>
                Breakdown by service category
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {estimate.breakdown.compute > 0 && (
                  <div className="flex justify-between items-center p-3 bg-gray-800/50 rounded">
                    <span className="font-medium">Compute</span>
                    <span className="font-bold">${estimate.breakdown.compute.toFixed(2)}</span>
                  </div>
                )}
                {estimate.breakdown.database > 0 && (
                  <div className="flex justify-between items-center p-3 bg-gray-800/50 rounded">
                    <span className="font-medium">Database</span>
                    <span className="font-bold">${estimate.breakdown.database.toFixed(2)}</span>
                  </div>
                )}
                {estimate.breakdown.storage > 0 && (
                  <div className="flex justify-between items-center p-3 bg-gray-800/50 rounded">
                    <span className="font-medium">Storage</span>
                    <span className="font-bold">${estimate.breakdown.storage.toFixed(2)}</span>
                  </div>
                )}
                {estimate.breakdown.network > 0 && (
                  <div className="flex justify-between items-center p-3 bg-gray-800/50 rounded">
                    <span className="font-medium">Network & CDN</span>
                    <span className="font-bold">${estimate.breakdown.network.toFixed(2)}</span>
                  </div>
                )}
                {estimate.breakdown.other > 0 && (
                  <div className="flex justify-between items-center p-3 bg-gray-800/50 rounded">
                    <span className="font-medium">Other Services</span>
                    <span className="font-bold">${estimate.breakdown.other.toFixed(2)}</span>
                  </div>
                )}
                
                <div className="flex justify-between items-center p-4 bg-gray-700/50 rounded-lg mt-4">
                  <span className="font-bold text-lg">Total Monthly Cost</span>
                  <span className="font-bold text-2xl text-primary">
                    ${estimate.totalCost.toFixed(2)}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
