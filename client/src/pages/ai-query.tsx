import { AiQueryInterface } from "@/components/ai-query-interface";

export default function AiQuery() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">AI Query Interface</h1>
        <p className="text-muted-foreground mt-1">
          Ask questions about your cloud spending using natural language
        </p>
      </div>

      <AiQueryInterface />
    </div>
  );
}
