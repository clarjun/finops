/**
 * Keeps one broken report section from unmounting the whole page.
 *
 * Every section on the Reports page takes an `any`-typed payload and reads
 * numbers straight out of it (`overview.budgetUtilization.toFixed(0)`). When one
 * field is missing, React unwinds the entire tree and the user gets a blank
 * screen with the error only in the console — an unreadable failure for a
 * missing percentage on one card out of eleven.
 *
 * The real fix for any given instance is the missing field (or a proper type on
 * the payload). This is the containment layer underneath that: a section that
 * throws degrades to a labelled message, and the other ten still render.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

interface Props {
  /** Section name, shown to the user and logged, so the culprit is identifiable. */
  name: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class SectionBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Named, so the console says which section failed rather than only which
    // component — several sections render the same card types.
    console.error(`[Reports] Section "${this.props.name}" failed to render:`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <Card className="border-l-4 border-l-amber-500">
        <CardContent className="flex items-start gap-3 py-6">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="space-y-1">
            <p className="text-sm font-medium">{this.props.name} could not be displayed</p>
            {/* The message, not a generic apology: it is usually enough to
                identify the missing field without opening the console. */}
            <p className="text-xs text-muted-foreground">{this.state.error.message}</p>
            <p className="text-xs text-muted-foreground">
              The rest of this report is unaffected.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }
}
