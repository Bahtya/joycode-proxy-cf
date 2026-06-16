// Account "验证 / 诊断" modal: runs credential + models + upstream chat probe
// diagnostics (POST /api/accounts/<id>/diagnose) and shows per-step results with a
// copy-diagnostic-info button. Shared by the accounts list and the detail page.
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, XCircle, Loader2, Copy, RefreshCw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api, accountDisplayName } from '@/api';
import type { Account, DiagnoseResult, DiagStep } from '@/api';

interface Props {
  account: Account;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}

const STEP_LABELS: Record<string, string> = {
  credential: '凭证验证',
  models: '模型列表',
  chat: 'LLM 端点→上游',
};

/** Compact human-readable line for a step's extra fields (model / count / tokens / ...). */
function stepExtra(s: DiagStep): string {
  const parts: string[] = [];
  if (typeof s.model === 'string' && s.model) parts.push(`模型 ${s.model}`);
  if (typeof s.count === 'number') parts.push(`共 ${s.count} 个`);
  if (Array.isArray(s.sample)) {
    const sample = s.sample.filter((x): x is string => typeof x === 'string').join(', ');
    if (sample) parts.push(sample);
  }
  if (typeof s.prompt_tokens === 'number' || typeof s.completion_tokens === 'number') {
    const pt = typeof s.prompt_tokens === 'number' ? s.prompt_tokens : 0;
    const ct = typeof s.completion_tokens === 'number' ? s.completion_tokens : 0;
    parts.push(`tokens 入${pt}/出${ct}`);
  }
  if (typeof s.finish_reason === 'string' && s.finish_reason) parts.push(`finish=${s.finish_reason}`);
  if (s.code !== undefined) parts.push(`code=${s.code}`);
  if (typeof s.msg === 'string' && s.msg) parts.push(`msg=${s.msg}`);
  return parts.join(' · ');
}

function buildDiagBlob(r: DiagnoseResult): string {
  const mark = (ok: boolean) => (ok ? '✓ 通过' : '✗ 失败');
  const lines = [
    'JoyCode 代理诊断',
    `账号: ${accountDisplayName(r.account)} (${r.account.user_id})`,
    `默认模型: ${r.account.default_model || '(未设置)'}`,
    `时间: ${r.timestamp}`,
    '',
  ];
  r.steps.forEach((s, i) => {
    lines.push(`[${i + 1}] ${s.label}: ${mark(s.ok)} (${s.latency_ms} ms)`);
    const extra = stepExtra(s);
    if (extra) lines.push(`    ${extra}`);
    if (s.detail) lines.push(`    ${s.detail}`);
  });
  return lines.join('\n');
}

export function AccountDiagnoseDialog({ account, open, onOpenChange, onDone }: Props) {
  const [result, setResult] = useState<DiagnoseResult | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setResult(null);
    try {
      setResult(await api.diagnoseAccount(account.user_id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '诊断请求失败');
    } finally {
      setRunning(false);
      onDone?.();
    }
  };

  useEffect(() => {
    if (open) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const copy = async () => {
    if (!result) return;
    const blob = buildDiagBlob(result);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(blob);
      } else {
        const ta = document.createElement('textarea');
        ta.value = blob;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      toast.success('诊断信息已复制');
    } catch {
      toast.error('复制失败');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>账号诊断 — {accountDisplayName(account)}</DialogTitle>
          <DialogDescription>验证凭证、模型列表与上游聊天链路（每项约产生一次上游请求）</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2.5">
          {(['credential', 'models', 'chat'] as const).map((key) => {
            const step = result?.steps.find((s) => s.key === key);
            const extra = step ? stepExtra(step) : '';
            return (
              <div key={key} className="flex items-start gap-2.5 rounded-md border p-2.5">
                <span className="mt-0.5">
                  {!step && running ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  ) : step?.ok ? (
                    <CheckCircle2 className="size-4 text-green-600" />
                  ) : step ? (
                    <XCircle className="size-4 text-red-600" />
                  ) : (
                    <span className="block size-4 rounded-full border border-muted-foreground/30" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{STEP_LABELS[key]}</span>
                    {step && <span className="shrink-0 text-[11px] text-muted-foreground">{step.latency_ms} ms</span>}
                  </div>
                  {extra && <div className="mt-0.5 truncate text-xs text-muted-foreground">{extra}</div>}
                  {step?.detail && (
                    <div className="mt-0.5 break-all text-xs text-red-600 dark:text-red-400">{step.detail}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={copy} disabled={!result || running}>
            <Copy className="size-4" /> 复制诊断信息
          </Button>
          <Button variant="outline" size="sm" onClick={() => void run()} disabled={running}>
            {running ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} 重新验证
          </Button>
          <Button size="sm" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
