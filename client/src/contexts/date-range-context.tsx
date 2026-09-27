/**
 * Date Range Context
 * Provides global date range state for the entire application
 */

import { createContext, useContext, useState, ReactNode } from 'react';

interface DateRange {
  startDate: string; // YYYY-MM-DD format
  endDate: string;   // YYYY-MM-DD format
}

interface DateRangeContextType {
  dateRange: DateRange;
  setDateRange: (range: DateRange) => void;
  resetToDefault: () => void;
}

const DateRangeContext = createContext<DateRangeContextType | undefined>(undefined);

/**
 * A YYYY-MM-DD date in the viewer's own calendar.
 *
 * Not `toISOString().split('T')[0]`, which converts to UTC first. That made the
 * default window depend on the time of day the page happened to be opened: at
 * UTC+5:30, loading before 05:30 local pushed "the 1st of the month" back onto
 * the last day of the previous month, so the same report showed different
 * totals in the morning and the afternoon.
 */
const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Helper to get default date range (start of month to today)
export function getDefaultDateRange(): DateRange {
  const now = new Date();
  return {
    startDate: ymd(new Date(now.getFullYear(), now.getMonth(), 1)),
    endDate: ymd(now),
  };
}

export function DateRangeProvider({ children }: { children: ReactNode }) {
  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange());

  const resetToDefault = () => {
    setDateRange(getDefaultDateRange());
  };

  return (
    <DateRangeContext.Provider value={{ dateRange, setDateRange, resetToDefault }}>
      {children}
    </DateRangeContext.Provider>
  );
}

export function useDateRange() {
  const context = useContext(DateRangeContext);
  if (context === undefined) {
    throw new Error('useDateRange must be used within a DateRangeProvider');
  }
  return context;
}
