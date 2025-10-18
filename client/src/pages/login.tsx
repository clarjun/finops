import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Building2, Shield, TrendingUp, Cloud, AlertTriangle } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";

export default function Login() {
  const { isConfigured, isLoading } = useAuth();

  const handleLogin = () => {
    // Directly navigate to the login endpoint
    // The server will handle the redirect to Azure AD
    window.location.href = '/auth/login';
  };

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <div className="h-12 w-12 mx-auto mb-4 border-4 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-white to-cyan-50 dark:from-background dark:via-background dark:to-background p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-cyan-600 shadow-lg">
              <TrendingUp className="h-8 w-8 text-white" />
            </div>
          </div>
          <h1 className="text-3xl font-bold tracking-tight mb-2">
            Azure Cost Analysis
          </h1>
          <p className="text-muted-foreground">
            AI-powered insights for your cloud spending
          </p>
        </div>

        <Card className="shadow-xl border-2">
          <CardHeader className="space-y-1 pb-4">
            <CardTitle className="text-2xl text-center">Welcome Back</CardTitle>
            <CardDescription className="text-center">
              Sign in with your Microsoft account to continue
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {!isConfigured && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Configuration Required</AlertTitle>
                <AlertDescription>
                  Azure AD authentication is not configured. Please set up Azure AD credentials in the environment variables.
                  See AZURE_AD_SETUP.md for instructions.
                </AlertDescription>
              </Alert>
            )}

            <Button
              onClick={handleLogin}
              size="lg"
              className="w-full bg-[#0078d4] hover:bg-[#106ebe] text-white"
              data-testid="button-azure-login"
              disabled={!isConfigured}
            >
              <Cloud className="mr-2 h-5 w-5" />
              {isConfigured ? 'Sign in with Microsoft' : 'Authentication Not Configured'}
            </Button>

            <div className="space-y-4 pt-4 border-t">
              <div className="flex items-start gap-3 text-sm">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/20">
                  <Shield className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <p className="font-medium">Secure Authentication</p>
                  <p className="text-muted-foreground">
                    OAuth 2.0 with Azure Active Directory
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3 text-sm">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-100 dark:bg-green-900/20">
                  <Building2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                </div>
                <div>
                  <p className="font-medium">Enterprise Ready</p>
                  <p className="text-muted-foreground">
                    Single Sign-On for your organization
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground mt-6">
          By signing in, you agree to our Terms of Service and Privacy Policy
        </p>
      </div>
    </div>
  );
}
