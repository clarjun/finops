/**
 * AWS cross-account connection wizard.
 *
 * Replaces the access-key form for AWS. The order of the steps is forced by the
 * protocol, not by preference: the customer cannot write a trust policy until
 * they have the External ID, and cannot give us a role ARN until the role
 * exists. So the connection is created first (minting the External ID), the role
 * ARN arrives second, and validation is a separate explicit act.
 *
 * The External ID is displayed exactly once, on the screen that creates it. No
 * endpoint can read it back, so the copy button matters.
 */
import { useState } from 'react';
import {
  Check, Copy, Loader2, ShieldCheck, AlertTriangle, ExternalLink, KeyRound,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';

interface Props {
  onConnected: () => void;
  onCancel: () => void;
}

interface CreatedConnection {
  id: number;
  externalId: string;
  cloudwisePrincipal: string | null;
}

interface ValidationResult {
  status: string;
  account: string;
  role: string;
  authentication: string;
  permissions: string;
  capabilities: { read: boolean; remediate: boolean; deploy: boolean };
}

const STEPS = ['Account', 'External ID', 'Create role', 'Role ARN', 'Validate'] as const;

/** Shown when the deployment has not configured its own principal ARN yet. */
const PRINCIPAL_PLACEHOLDER = '<your Cloudwise principal ARN — ask your administrator>';

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is blocked in some browsers over plain http; the value is
      // still selectable on screen, so say that rather than failing silently.
      toast({ title: 'Could not copy', description: 'Select the value and copy it manually.' });
    }
  };

  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex gap-2">
        <code className="flex-1 rounded-md border bg-muted px-3 py-2 text-xs break-all font-mono">
          {value}
        </code>
        <Button type="button" variant="outline" size="icon" onClick={copy} title="Copy">
          {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}

export function AwsConnectWizard({ onConnected, onCancel }: Props) {
  const { toast } = useToast();

  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);

  const [accountName, setAccountName] = useState('');
  const [accountId, setAccountId] = useState('');
  const [roleArn, setRoleArn] = useState('');
  const [remediationRoleArn, setRemediationRoleArn] = useState('');

  const [created, setCreated] = useState<CreatedConnection | null>(null);
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const principal = created?.cloudwisePrincipal || PRINCIPAL_PLACEHOLDER;

  const trustPolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { AWS: principal },
      Action: 'sts:AssumeRole',
      Condition: { StringEquals: { 'sts:ExternalId': created?.externalId ?? '' } },
    }],
  }, null, 2);

  /** Step 1 -> 2. Creates the connection and mints the External ID. */
  const createConnection = async () => {
    setError(null);

    if (!/^\d{12}$/.test(accountId.trim())) {
      setError('AWS account ID must be exactly 12 digits.');
      return;
    }

    setBusy(true);
    try {
      const res = await fetch('/api/aws/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ accountId: accountId.trim(), accountName: accountName.trim() }),
      });
      const payload = await res.json();

      if (!res.ok) {
        setError(payload.error ?? 'Could not create the connection.');
        return;
      }

      setCreated({
        id: payload.connection.id,
        externalId: payload.externalId,
        cloudwisePrincipal: payload.cloudwisePrincipal,
      });
      setStep(1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Step 4 -> 5. Saves the ARNs, then validates. */
  const saveAndValidate = async () => {
    if (!created) return;
    setError(null);
    setBusy(true);

    try {
      const patch = await fetch(`/api/aws/connections/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          roleArn: roleArn.trim(),
          // Empty means read-only, which is the recommended starting posture —
          // sent as null rather than omitted so clearing it also works.
          remediationRoleArn: remediationRoleArn.trim() || null,
        }),
      });
      const patchPayload = await patch.json();
      if (!patch.ok) {
        setError(patchPayload.error ?? 'Could not save the role ARN.');
        return;
      }

      const res = await fetch(`/api/aws/connections/${created.id}/validate`, {
        method: 'POST',
        credentials: 'include',
      });
      const payload = await res.json();

      if (!res.ok) {
        // The server's messages already name what to fix; showing them verbatim
        // is the point of translating errors server-side.
        setError(payload.error ?? 'Validation failed.');
        return;
      }

      setResult(payload);
      setStep(4);
      toast({ title: 'AWS account connected', description: `Account ${payload.account} verified.` });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Progress */}
      <div className="flex items-center gap-1.5">
        {STEPS.map((label, i) => (
          <div key={label} className="flex flex-1 flex-col gap-1.5">
            <div className={`h-1.5 rounded-full ${i <= step ? 'bg-primary' : 'bg-muted'}`} />
            <span className={`text-[11px] ${i === step ? 'font-medium' : 'text-muted-foreground'}`}>
              {i + 1}. {label}
            </span>
          </div>
        ))}
      </div>

      <div className="flex items-start gap-2 rounded-md border border-green-600/30 bg-green-600/5 p-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
        <p className="text-xs text-muted-foreground">
          Cloudwise uses a <strong>cross-account IAM role</strong>, not access keys. No long-lived
          credential is stored, every session expires within the hour, and you can revoke access at
          any time by deleting the role in your own account.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <p className="text-xs">{error}</p>
        </div>
      )}

      {/* ── Step 1: the account ─────────────────────────────────────────── */}
      {step === 0 && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="aws-name">Account name</Label>
            <Input
              id="aws-name"
              placeholder="e.g. Production AWS"
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="aws-id">AWS account ID</Label>
            <Input
              id="aws-id"
              placeholder="123456789012"
              inputMode="numeric"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value.replace(/\D/g, '').slice(0, 12))}
            />
            <p className="text-xs text-muted-foreground">12 digits, no dashes.</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
            <Button
              onClick={createConnection}
              disabled={busy || accountId.length !== 12 || accountName.trim().length === 0}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Continue
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 2: the External ID ─────────────────────────────────────── */}
      {step === 1 && created && (
        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p className="text-xs">
              <strong>Copy this now.</strong> The External ID is shown once and cannot be retrieved
              again. It protects your role from being assumed by anyone other than Cloudwise.
            </p>
          </div>
          <CopyField label="External ID" value={created.externalId} />
          <CopyField label="Cloudwise principal (for the trust policy)" value={principal} />
          <div className="flex justify-between">
            <Button variant="outline" onClick={onCancel}>Cancel</Button>
            <Button onClick={() => setStep(2)}>I have copied the External ID</Button>
          </div>
        </div>
      )}

      {/* ── Step 3: create the role ─────────────────────────────────────── */}
      {step === 2 && created && (
        <div className="space-y-4">
          <p className="text-sm">
            In your AWS account, create an IAM role (any name — we suggest{' '}
            <code className="text-xs">CloudwiseFinOpsReadOnlyRole</code>) with this trust policy:
          </p>
          <CopyField label="Trust policy" value={trustPolicy} />
          <p className="text-sm">
            Then attach the read-only permissions policy. It grants cost and resource{' '}
            <em>metadata</em> only, and explicitly denies reading object contents, secrets and
            KMS decryption.
          </p>
          <a
            href="/docs/aws-iam-role-setup.md"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            Full setup instructions and policy JSON <ExternalLink className="h-3 w-3" />
          </a>
          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
            <Button onClick={() => setStep(3)}>I have created the role</Button>
          </div>
        </div>
      )}

      {/* ── Step 4: role ARNs ───────────────────────────────────────────── */}
      {step === 3 && created && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="aws-role">Read-only role ARN</Label>
            <Input
              id="aws-role"
              placeholder={`arn:aws:iam::${accountId}:role/CloudwiseFinOpsReadOnlyRole`}
              value={roleArn}
              onChange={(e) => setRoleArn(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="aws-remediation">
              Remediation role ARN <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="aws-remediation"
              placeholder="Leave blank for read-only access"
              value={remediationRoleArn}
              onChange={(e) => setRemediationRoleArn(e.target.value)}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Only needed if you want Cloudwise to act on approved recommendations. Read-only is the
              recommended starting point — you can add this later.
            </p>
          </div>
          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep(2)} disabled={busy}>Back</Button>
            <Button onClick={saveAndValidate} disabled={busy || roleArn.trim().length === 0}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Validate connection
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 5: connected ───────────────────────────────────────────── */}
      {step === 4 && result && (
        <Card className="border-green-600/40">
          <CardContent className="space-y-3 pt-6">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-green-600" />
              <span className="font-medium">AWS account connected</span>
            </div>
            <dl className="space-y-1.5 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Account</dt>
                <dd className="font-mono text-xs">{result.account}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Assumed role</dt>
                <dd className="truncate font-mono text-xs">{result.role}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Authentication</dt>
                <dd>{result.authentication}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Permissions</dt>
                <dd>
                  <Badge variant={result.capabilities.remediate ? 'default' : 'secondary'}>
                    {result.permissions}
                  </Badge>
                </dd>
              </div>
            </dl>
            <div className="flex justify-end pt-2">
              <Button onClick={onConnected}>Done</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
