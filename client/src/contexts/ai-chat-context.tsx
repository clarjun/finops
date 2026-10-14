/**
 * AI Chat Context
 *
 * Holds the AI Query conversation (input text, in-flight loading, and the
 * response history) ABOVE the router, so it survives route changes.
 *
 * Previously this state lived in useState inside the AiQueryInterface component.
 * Navigating to another sidebar page unmounted that component mid-request, which
 * threw away the loading state and the answer — the in-flight generation was
 * effectively lost, and returning to the page showed an empty screen. Lifting it
 * here keeps the request alive and the thread intact regardless of navigation.
 */

import { createContext, useCallback, useContext, useState, ReactNode } from "react";
import { ApiError } from "@/lib/api";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { AiQueryResponse, AiTurn } from "@shared/schema";

export type CloudScope = "all" | "aws" | "azure" | "gcp";

export interface AiChatEntry {
  query: string;
  answer: string;
  success: boolean;
  provider: CloudScope; // which cloud scope this question was asked against
}

interface AiChatContextValue {
  input: string;
  setInput: (value: string) => void;
  loading: boolean;
  responses: AiChatEntry[];
  provider: CloudScope;
  setProvider: (provider: CloudScope) => void;
  submitQuery: () => Promise<void>;
}

const AiChatContext = createContext<AiChatContextValue | undefined>(undefined);

export function AiChatProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [responses, setResponses] = useState<AiChatEntry[]>([]);
  const [provider, setProvider] = useState<CloudScope>("all");

  const submitQuery = useCallback(async () => {
    const currentQuery = input.trim();
    if (!currentQuery || loading) return;

    setLoading(true);

    // Capture the scope now, so the history entry reflects the provider this
    // question was actually asked against — even if the user changes the
    // selector while the answer is still generating.
    const askedProvider = provider;

    // Send the last few exchanges so follow-ups ("yes", "break that down") have
    // context. `responses` is newest-first, so reverse to oldest-first — the
    // order the model reads the thread in.
    const history: AiTurn[] = responses
      .slice(0, 4)
      .reverse()
      .flatMap((r) => [
        { role: "user" as const, content: r.query },
        { role: "assistant" as const, content: r.answer },
      ]);

    try {
      const result = await apiRequest<AiQueryResponse>("POST", "/api/analyze", {
        query: currentQuery,
        history,
        provider,
      });
      const answerText = result?.answer || "No answer received from AI";
      setResponses((prev) => [
        { query: currentQuery, answer: answerText, success: result?.success ?? false, provider: askedProvider },
        ...prev,
      ]);
      // Clear the input only on success, so a failed query stays put for a retry.
      setInput("");
    } catch (error) {
      // The server classifies its own failures, so say which one happened.
      // "Please try again" on a rejected API key sent users in a loop that
      // could never succeed and made a configuration fault look like flakiness.
      const api = error instanceof ApiError ? error : null;
      const message = api?.message ?? "Something went wrong while analyzing your query.";
      const canRetry = api?.retryable ?? true;

      toast({
        title: canRetry ? "Query failed" : "AI analysis unavailable",
        description: message,
        variant: "destructive",
      });
      setResponses((prev) => [
        { query: currentQuery, answer: message, success: false, provider: askedProvider },
        ...prev,
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, responses, provider, toast]);

  return (
    <AiChatContext.Provider value={{ input, setInput, loading, responses, provider, setProvider, submitQuery }}>
      {children}
    </AiChatContext.Provider>
  );
}

export function useAiChat() {
  const context = useContext(AiChatContext);
  if (context === undefined) {
    throw new Error("useAiChat must be used within an AiChatProvider");
  }
  return context;
}
