import { Cloud, CloudCog, Database } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";

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
    color: 'text-purple-600 dark:text-purple-400',
    bgColor: 'bg-purple-50 dark:bg-purple-950/30',
  },
  azure: {
    label: 'Microsoft Azure',
    icon: Cloud,
    color: 'text-blue-600 dark:text-blue-400',
    bgColor: 'bg-blue-50 dark:bg-blue-950/30',
  },
  aws: {
    label: 'Amazon AWS',
    icon: Database,
    color: 'text-orange-600 dark:text-orange-400',
    bgColor: 'bg-orange-50 dark:bg-orange-950/30',
  },
  gcp: {
    label: 'Google Cloud',
    icon: CloudCog,
    color: 'text-green-600 dark:text-green-400',
    bgColor: 'bg-green-50 dark:bg-green-950/30',
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
                  <Icon className={`h-4 w-4 ${config.color}`} />
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
            className={!isActive ? config.bgColor : ""}
            data-testid={`button-provider-${provider}`}
          >
            <Icon className={`h-4 w-4 mr-2 ${isActive ? 'text-primary-foreground' : config.color}`} />
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
