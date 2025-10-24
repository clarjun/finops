import { Cloud, CloudCog, Database } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";

// Use 'all' for UI filtering, or specific provider from schema
export type CloudProvider = 'all' | 'azure' | 'aws' | 'gcp';

interface ProviderSelectorProps {
  value: CloudProvider;
  onChange: (provider: CloudProvider) => void;
  showAllOption?: boolean;
}

const providerConfig = {
  all: {
    label: 'All Providers',
    icon: CloudCog,
    colorClass: 'text-purple-600 dark:text-purple-400',
  },
  azure: {
    label: 'Microsoft Azure',
    icon: Cloud,
    colorClass: 'text-primary',
  },
  aws: {
    label: 'Amazon AWS',
    icon: Database,
    colorClass: 'text-orange-600 dark:text-orange-400',
  },
  gcp: {
    label: 'Google Cloud',
    icon: CloudCog,
    colorClass: 'text-green-600 dark:text-green-400',
  },
};

export function ProviderSelector({ value, onChange, showAllOption = true }: ProviderSelectorProps) {
  const providers: CloudProvider[] = showAllOption 
    ? ['all', 'azure', 'aws', 'gcp']
    : ['azure', 'aws', 'gcp'];

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-foreground/70">Provider:</span>
      <Select value={value} onValueChange={(v) => onChange(v as CloudProvider)}>
        <SelectTrigger className="w-[200px]" data-testid="select-provider">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {providers.map((provider) => {
            const config = providerConfig[provider];
            const Icon = config.icon;
            return (
              <SelectItem key={provider} value={provider} data-testid={`option-provider-${provider}`}>
                <div className="flex items-center gap-2">
                  <Icon className={`h-4 w-4 ${config.colorClass}`} />
                  <span>{config.label}</span>
                </div>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

export function ProviderBadges({ value, onChange }: ProviderSelectorProps) {
  const providers: CloudProvider[] = ['all', 'azure', 'aws', 'gcp'];

  return (
    <div className="flex flex-wrap gap-2">
      {providers.map((provider) => {
        const config = providerConfig[provider];
        const Icon = config.icon;
        const isActive = value === provider;

        return (
          <Button
            key={provider}
            variant={isActive ? "default" : "outline"}
            size="sm"
            onClick={() => onChange(provider)}
            data-testid={`button-provider-${provider}`}
          >
            <Icon className={`h-4 w-4 mr-2 ${isActive ? 'text-primary-foreground' : config.colorClass}`} />
            {config.label}
          </Button>
        );
      })}
    </div>
  );
}

export function getProviderConfig(provider: CloudProvider) {
  return providerConfig[provider];
}
