/**
 * Date Range Picker Component
 * Allows users to select start and end dates for data filtering using separate calendars
 */

import { useState } from "react";
import { Calendar as CalendarIcon } from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { useDateRange } from "@/contexts/date-range-context";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export function DateRangePicker() {
  const { dateRange, setDateRange, resetToDefault } = useDateRange();
  const [startOpen, setStartOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);

  const handleStartDateSelect = (date: Date | undefined) => {
    if (date) {
      const newStartDate = format(date, 'yyyy-MM-dd');
      // If new start date is after current end date, set end date to start date
      if (newStartDate > dateRange.endDate) {
        setDateRange({
          startDate: newStartDate,
          endDate: newStartDate,
        });
      } else {
        setDateRange({
          startDate: newStartDate,
          endDate: dateRange.endDate,
        });
      }
      setStartOpen(false);
    }
  };

  const handleEndDateSelect = (date: Date | undefined) => {
    if (date) {
      const newEndDate = format(date, 'yyyy-MM-dd');
      // If new end date is before current start date, set start date to end date
      if (newEndDate < dateRange.startDate) {
        setDateRange({
          startDate: newEndDate,
          endDate: newEndDate,
        });
      } else {
        setDateRange({
          startDate: dateRange.startDate,
          endDate: newEndDate,
        });
      }
      setEndOpen(false);
    }
  };

  const handleReset = () => {
    resetToDefault();
  };

  const formatDateForDisplay = (dateStr: string) => {
    const date = new Date(dateStr);
    return format(date, 'MMM dd, yyyy');
  };

  return (
    <div className="flex items-center gap-2">
      {/* Start Date Picker */}
      <Popover open={startOpen} onOpenChange={setStartOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "justify-start text-left font-normal gap-2",
              !dateRange && "text-muted-foreground"
            )}
          >
            <CalendarIcon className="h-4 w-4" />
            <span>{formatDateForDisplay(dateRange.startDate)}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <div className="p-3 space-y-3">
            <div className="space-y-1">
              <h4 className="font-medium text-sm">Start Date</h4>
              <p className="text-xs text-muted-foreground">
                Select the beginning of the date range
              </p>
            </div>
            <Calendar
              mode="single"
              selected={new Date(dateRange.startDate)}
              onSelect={handleStartDateSelect}
              disabled={(date) => date > new Date() || date < new Date("2020-01-01")}
              initialFocus
            />
          </div>
        </PopoverContent>
      </Popover>

      <span className="text-muted-foreground">to</span>

      {/* End Date Picker */}
      <Popover open={endOpen} onOpenChange={setEndOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "justify-start text-left font-normal gap-2",
              !dateRange && "text-muted-foreground"
            )}
          >
            <CalendarIcon className="h-4 w-4" />
            <span>{formatDateForDisplay(dateRange.endDate)}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
          <div className="p-3 space-y-3">
            <div className="space-y-1">
              <h4 className="font-medium text-sm">End Date</h4>
              <p className="text-xs text-muted-foreground">
                Select the end of the date range
              </p>
            </div>
            <Calendar
              mode="single"
              selected={new Date(dateRange.endDate)}
              onSelect={handleEndDateSelect}
              disabled={(date) => date > new Date() || date < new Date("2020-01-01")}
              initialFocus
            />
          </div>
        </PopoverContent>
      </Popover>

      {/* Reset Button */}
      <Button 
        variant="ghost" 
        size="sm" 
        onClick={handleReset}
        className="text-xs"
      >
        Reset
      </Button>
    </div>
  );
}
