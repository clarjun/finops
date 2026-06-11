import { useQuery } from "@tanstack/react-query";
import { AiQueryInterface } from "@/components/ai-query-interface";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { ProcessedCostData, AiQueryResponse } from "@shared/schema";

export default function AiQuery() {
  const { toast } = useToast();

  const { data: costData } = useQuery<ProcessedCostData>({
    queryKey: ["/api/cost-data"],
  });

  const handleQuery = async (query: string): Promise<AiQueryResponse> => {
    try {
      // Backend will use server-side cached data for security
      const response = await apiRequest<AiQueryResponse>("POST", "/api/analyze", {
        query,
      });
      return response;
    } catch (error) {
      toast({
        title: "Query failed",
        description: "Failed to process your query. Please try again.",
        variant: "destructive",
      });
      return {
        answer: "Sorry, I couldn't process your query at this time.",
        success: false,
      };
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">AI Query Interface</h1>
        <p className="text-muted-foreground mt-1">
          Ask questions about your cloud spending using natural language
        </p>
      </div>

      <AiQueryInterface onQuery={handleQuery} />
    </div>
  );
}
