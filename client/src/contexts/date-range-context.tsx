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

// Helper to get default date range (start of month to today)
export function getDefaultDateRange(): DateRange {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(1); // First day of current month
  
  return {
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0],
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
