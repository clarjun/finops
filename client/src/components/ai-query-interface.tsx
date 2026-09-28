import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send, Sparkles, Loader2, Cloud, CloudCog, Database } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAiChat, type CloudScope } from "@/contexts/ai-chat-context";

const EXAMPLE_QUERIES = [
  "What is my top cost driver?",
  "Show me spending anomalies",
  "Which services cost the most?",
  "Compare costs by subscription",
  "What's the trend this month?",
];

// Label + icon per cloud scope, so each answer in the history shows which
// provider it was asked against. Mirrors the selector's icons and colors.
const PROVIDER_META: Record<CloudScope, { label: string; icon: typeof Cloud; iconClass: string }> = {
  all: { label: "All Clouds", icon: CloudCog, iconClass: "text-purple-600 dark:text-purple-400" },
  aws: { label: "AWS", icon: Database, iconClass: "text-orange-600 dark:text-orange-400" },
  gcp: { label: "GCP", icon: CloudCog, iconClass: "text-green-600 dark:text-green-400" },
  azure: { label: "Azure", icon: Cloud, iconClass: "text-primary" },
};

export function AiQueryInterface() {
  // Chat state lives in AiChatProvider (above the router) so an in-flight query
  // and its answer survive navigating to another page and back.
  const { input: query, setInput: setQuery, loading, responses, provider, setProvider, submitQuery } = useAiChat();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void submitQuery();
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
                  Ask questions about your cloud spending in natural language
                </p>
              </div>
            </div>

            {/* Scope the AI's answer to one cloud (or all), mirroring the
                provider selector on the Reports/Dashboard page. */}
            <Tabs value={provider} onValueChange={(value) => setProvider(value as CloudScope)} className="mt-6">
              <TabsList className="grid w-full grid-cols-4" data-testid="tabs-ai-provider-selector">
                <TabsTrigger value="all" data-testid="tab-ai-all" className="gap-2">
                  <CloudCog className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                  All Clouds
                </TabsTrigger>
                <TabsTrigger value="aws" data-testid="tab-ai-aws" className="gap-2">
                  <Database className="h-4 w-4 text-orange-600 dark:text-orange-400" />
                  AWS
                </TabsTrigger>
                <TabsTrigger value="gcp" data-testid="tab-ai-gcp" className="gap-2">
                  <CloudCog className="h-4 w-4 text-green-600 dark:text-green-400" />
                  GCP
                </TabsTrigger>
                <TabsTrigger value="azure" data-testid="tab-ai-azure" className="gap-2">
                  <Cloud className="h-4 w-4 text-primary" />
                  Azure
                </TabsTrigger>
              </TabsList>
            </Tabs>

            <form onSubmit={handleSubmit} className="mt-4">
              <div className="flex gap-2">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Ask about your cloud spending... (e.g., 'What is my top cost driver?')"
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
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <p className="text-sm font-medium text-muted-foreground">Your question:</p>
                    {(() => {
                      const meta = PROVIDER_META[response.provider];
                      const Icon = meta.icon;
                      return (
                        <Badge variant="secondary" className="gap-1" data-testid={`badge-provider-${index}`}>
                          <Icon className={`h-3 w-3 ${meta.iconClass}`} />
                          {meta.label}
                        </Badge>
                      );
                    })()}
                  </div>
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
