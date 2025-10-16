import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send, Sparkles, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface AiQueryInterfaceProps {
  onQuery: (query: string) => Promise<{ answer: string; data?: any; success: boolean }>;
}

const EXAMPLE_QUERIES = [
  "What is my top cost driver?",
  "Show me spending anomalies",
  "Which services cost the most?",
  "Compare costs by subscription",
  "What's the trend this month?",
];

export function AiQueryInterface({ onQuery }: AiQueryInterfaceProps) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [responses, setResponses] = useState<Array<{ query: string; answer: string; success: boolean }>>([]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim() || loading) return;

    const currentQuery = query;
    setQuery("");
    setLoading(true);

    try {
      const result = await onQuery(currentQuery);
      const answerText = result?.answer || "No answer received from AI";
      setResponses((prev) => [
        { query: currentQuery, answer: answerText, success: result?.success ?? false },
        ...prev,
      ]);
    } catch (error) {
      setResponses((prev) => [
        { query: currentQuery, answer: "An error occurred while processing your query.", success: false },
        ...prev,
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleExampleClick = (exampleQuery: string) => {
    setQuery(exampleQuery);
  };

  return (
    <div className="space-y-6">
      <div className="relative">
        <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-chart-2/5">
          <CardContent className="p-8">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                <Sparkles className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h2 className="text-2xl font-bold tracking-tight">AI-Powered Analysis</h2>
                <p className="text-sm text-muted-foreground">
                  Ask questions about your Azure spending in natural language
                </p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="mt-6">
              <div className="flex gap-2">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Ask about your Azure spending... (e.g., 'What is my top cost driver?')"
                  className="flex-1 h-14 text-base bg-background/50 backdrop-blur-sm"
                  disabled={loading}
                  data-testid="input-ai-query"
                />
                <Button
                  type="submit"
                  size="lg"
                  className="h-14 px-6"
                  disabled={loading || !query.trim()}
                  data-testid="button-submit-query"
                >
                  {loading ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Send className="h-5 w-5" />
                  )}
                </Button>
              </div>
            </form>

            <div className="flex flex-wrap gap-2 mt-4">
              <p className="text-xs text-muted-foreground w-full mb-1">Try asking:</p>
              {EXAMPLE_QUERIES.map((example, index) => (
                <Badge
                  key={index}
                  variant="secondary"
                  className="cursor-pointer hover-elevate active-elevate-2"
                  onClick={() => handleExampleClick(example)}
                  data-testid={`example-query-${index}`}
                >
                  {example}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4" data-testid="list-ai-responses">
        {responses.map((response, index) => (
          <Card key={index} className={response.success ? "border-l-4 border-l-primary" : "border-l-4 border-l-destructive"}>
            <CardContent className="p-6">
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">Your question:</p>
                  <p className="font-medium" data-testid={`text-query-${index}`}>{response.query}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-1">AI Analysis:</p>
                  <Alert className={response.success ? "bg-primary/5 border-primary/20" : "bg-destructive/5 border-destructive/20"}>
                    <AlertDescription className="text-base leading-relaxed whitespace-pre-wrap" data-testid={`text-answer-${index}`}>
                      {response.answer}
                    </AlertDescription>
                  </Alert>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
