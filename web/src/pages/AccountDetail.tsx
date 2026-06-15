import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowLeft, RefreshCw, Trash2, Copy, Loader2, KeyRound, Info,
  Activity, Zap, CheckCircle2, XCircle, BarChart3, Globe, Clock,
  ArrowLeftRight, Flame, AlertTriangle, HelpCircle,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ResponsiveContainer, PieChart, Pie, Cell, AreaChart, Area,
} from 'recharts';
import { useParams, useNavigate } from 'react-router-dom';
import { api, accountDisplayName } from '@/api';
import type { Account, AccountStats, ModelInfo, RequestLog } from '@/api';
import SvgClaudeCode from '@/components/ClaudeCodeIcon';
import SvgCodex from '@/components/CodexIcon';
import { StatisticCard } from '@/components/statistic-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Separator } from '@/components/ui/separator';
import { chartColor } from '@/lib/chart';

// Sentinel value for the "unset default model" dropdown option. Radix Select
// disallows empty-string item values, so unset is represented by this sentinel
// and mapped back to '' in handleModelChange. (C2/F4)
const NONE_MODEL = '__none__';

const isClaudeModel = (model?: string) => model === 'Claude-Opus-4.7';

const PIE_COLORS = ['#00b578', '#36cfc9', '#73d13d', '#95de64', '#1890ff', '#13c2c2', '#eb2f96', '#fa8c16'];

const latencyTone = (ms: number) => {
  if (ms < 500) return 'text-green-600 dark:text-green-500';
  if (ms < 1500) return 'text-yellow-600 dark:text-yellow-500';
  return 'text-red-600 dark:text-red-500';
};

const fmtTokens = (n: number) => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
};

const StatusBadge = ({ code }: { code: number }) => {
  if (code >= 200 && code < 300) return <Badge className="bg-green-600 text-white hover:bg-green-600">{code}</Badge>;
  if (code >= 400 && code < 500) return <Badge className="bg-yellow-500 text-white hover:bg-yellow-500">{code}</Badge>;
  return <Badge variant="destructive">{code}</Badge>;
};

const formatTime = (t: string) => {
  if (!t) return '-';
  const d = new Date(t + (t.includes('Z') || t.includes('+') ? '' : 'Z'));
  if (isNaN(d.getTime())) return t;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const formatLatency = (ms: number) => {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  const remainMs = ms % 1000;
  if (s < 60) return `${s}s${remainMs > 0 ? ` ${remainMs}ms` : ''}`;
  const m = Math.floor(s / 60);
  const remainS = s % 60;
  return `${m}m${remainS > 0 ? ` ${remainS}s` : ''}`;
};

const getBaseURL = () => `${window.location.protocol}//${window.location.host}`;

const buildClaudeCodeCmd = (apiKey: string, model = 'GLM-5.1') => [
  `API_TIMEOUT_MS=6000000 \\`,
  `CLAUDE_CODE_MAX_RETRIES=3 \\`,
  `NODE_TLS_REJECT_UNAUTHORIZED=0 \\`,
  `ANTHROPIC_BASE_URL=${getBaseURL()} \\`,
  `ANTHROPIC_API_KEY="${apiKey}" \\`,
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS=6553655 \\`,
  `ANTHROPIC_MODEL=${model} \\`,
  `claude --dangerously-skip-permissions`,
].join('\n');

const buildCodexCmd = (apiKey: string, model = 'GLM-5.1') => [
  `OPENAI_BASE_URL=${getBaseURL()}/v1 \\`,
  `OPENAI_API_KEY="${apiKey}" \\`,
  `OPENAI_MODEL=${model} \\`,
  `codex`,
].join('\n');

const copyCmd = async (text: string, label: string) => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    toast.success(`${label} 命令已复制到剪贴板`);
  } catch {
    toast.error('复制失败');
  }
};

const AccountDetail: React.FC = () => {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const [account, setAccount] = useState<Account | null>(null);
  const [stats, setStats] = useState<AccountStats | null>(null);
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [modelLoading, setModelLoading] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [logFilter, setLogFilter] = useState<string>('all');
  const [activeSessions, setActiveSessions] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const decodedKey = userId ? decodeURIComponent(userId) : '';

  const fetchData = async () => {
    setLoading(true);
    try {
      const [accounts, statsData, logsData] = await Promise.all([
        api.listAccounts(),
        api.getAccountStats(decodedKey),
        api.getAccountLogs(decodedKey, 500),
      ]);
      const acc = accounts.find((a) => a.user_id === decodedKey);
      setAccount(acc || null);
      setStats(statsData);
      setLogs(logsData.logs || []);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchModels = async () => {
    setModelLoading(true);
    try {
      const data = await api.listModels();
      setModels(data);
    } catch {
      // leave empty on error; dropdown just shows nothing until retry
    } finally {
      setModelLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, [decodedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fetchModels(); }, [decodedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // active_sessions is always 0 on the edge port (no in-memory session tracker), so
  // there is nothing to poll — the previous 5s listAccounts() poll was wasteful and
  // non-functional. activeSessions stays 0; the badge shows 无活跃会话. (P3)

  const handleModelChange = async (newModel: string) => {
    setSavingModel(true);
    try {
      const real = newModel === NONE_MODEL ? '' : newModel;
      await api.updateAccountModel(decodedKey, real);
      toast.success(`默认模型已更新为「${real || '未设置'}」`);
      fetchData();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '更新失败');
    } finally {
      setSavingModel(false);
    }
  };

  const handleRenew = async () => {
    setRenewing(true);
    try {
      await api.renewToken(decodedKey);
      toast.success('API Token 已更新');
      fetchData();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '更新失败');
    } finally {
      setRenewing(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.removeAccount(decodedKey);
      toast.success(`账号「${accountDisplayName(account!)}」已删除`);
      navigate('/accounts');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '删除账号失败');
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="grid place-items-center py-24">
        <Loader2 className="size-8 animate-spin text-primary" />
      </div>
    );
  }
  if (!account) {
    return <div className="py-24 text-center text-muted-foreground">账号不存在</div>;
  }

  // Model options come from the admin-configured selectable list (/api/models).
  // Defensive union: if the account's saved default_model isn't in the list, still
  // show it (so the Select isn't blank and the value is re-selectable). NONE_MODEL
  // is the unset sentinel. (C2/F4)
  const configured = models.map((m) => ({ label: m.name || m.id, value: m.id }));
  const savedExtra =
    account.default_model && !configured.some((o) => o.value === account.default_model)
      ? [{ label: account.default_model, value: account.default_model }]
      : [];
  const allModelOptions = [{ label: '未设置', value: NONE_MODEL }, ...configured, ...savedExtra];

  const filteredLogs = logFilter === 'all'
    ? logs
    : logFilter === 'errors'
      ? logs.filter((l) => l.status_code >= 400)
      : logs.filter((l) => l.stream);

  const endpointData = stats?.by_endpoint.map((e) => ({
    name: e.endpoint.replace('/v1/', ''),
    value: e.count,
  })) || [];

  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedLogs = filteredLogs.slice((safePage - 1) * pageSize, safePage * pageSize);

  const toggleRow = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex flex-col gap-3 border-b pb-4 lg:flex-row lg:items-center">
          <Button variant="ghost" size="icon" onClick={() => navigate('/accounts')} className="self-start lg:self-auto">
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight">{accountDisplayName(account)}</h2>
              {account.is_default && <Badge>默认</Badge>}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {account.user_id} · 创建于 {account.created_at?.slice(0, 10) || '-'}
            </p>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Token:</span>
              <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] break-all">{account.api_token}</code>
            </div>
            <div className="mt-1.5">
              {activeSessions > 0 ? (
                <Badge className="bg-blue-500 text-white hover:bg-blue-500">
                  <span className="size-1.5 rounded-full bg-white/90 animate-pulse" />
                  {activeSessions} 个活跃会话
                </Badge>
              ) : (
                <Badge variant="secondary">无活跃会话</Badge>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span><HelpCircle className="size-4 cursor-help text-muted-foreground" /></span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-left">
                此模型的用途仅限生成下方的快速启动命令。实际请求中的模型由客户端指定（如 ANTHROPIC_MODEL 环境变量），始终优先于本设置。模型列表来自 Settings「可选模型」配置。
              </TooltipContent>
            </Tooltip>
            <Select
              value={account.default_model || NONE_MODEL}
              onValueChange={handleModelChange}
              disabled={savingModel || modelLoading}
            >
              <SelectTrigger size="sm" className="w-full lg:w-56">
                {modelLoading ? (
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> 加载模型…
                  </span>
                ) : (
                  <SelectValue placeholder="默认模型" />
                )}
              </SelectTrigger>
              <SelectContent>
                {allModelOptions.map((m) => (
                  <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isClaudeModel(account.default_model) && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span><Info className="size-4 text-yellow-500" /></span>
                </TooltipTrigger>
                <TooltipContent>Claude 模型需要本机登录 JoyCode IDE</TooltipContent>
              </Tooltip>
            )}
            <Button variant="outline" size="sm" onClick={handleRenew} disabled={renewing}>
              {renewing ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
              重置 Token
            </Button>
            <Button variant="outline" size="sm" onClick={() => { fetchData(); fetchModels(); }}>
              <RefreshCw className="size-4" />
              刷新
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm" disabled={deleting}>
                  {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  删除
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确定要删除账号「{accountDisplayName(account)}」吗？</AlertDialogTitle>
                  <AlertDialogDescription>删除后使用该密钥的客户端将无法访问</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={handleDelete}
                    disabled={deleting}
                  >
                    {deleting && <Loader2 className="size-4 animate-spin" />}
                    删除
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        {/* Claude warning */}
        {isClaudeModel(account.default_model) && (
          <div className="flex items-start gap-3 rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <div className="font-medium">Claude 模型需要 JoyCode IDE 登录态</div>
              <div className="mt-0.5 text-xs opacity-90">请确保本机 JoyCode IDE 已登录，否则 Claude 模型无法使用。</div>
            </div>
          </div>
        )}

        {/* Quick start commands */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm">快速启动命令</CardTitle>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground cursor-help">
                    <Info className="size-3" /> 模型优先级说明
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-left">
                  模型优先级：客户端指定的模型（如启动命令中的 ANTHROPIC_MODEL）始终优先。上方设置的「默认模型」仅用于生成这些命令中的模型参数。如果你手动修改了启动命令中的模型，以你手动指定的为准。
                </TooltipContent>
              </Tooltip>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-md bg-[#f6f5f0] p-3 dark:bg-muted/40">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <SvgClaudeCode />
                    <span className="text-sm font-semibold">Claude Code</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => copyCmd(buildClaudeCodeCmd(account.api_token, account.default_model || undefined), 'Claude Code')}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </div>
                <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap break-all text-foreground">
{buildClaudeCodeCmd(account.api_token, account.default_model || undefined)}
                </pre>
              </div>
              <div className="rounded-md bg-[#f0faf5] p-3 dark:bg-muted/40">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <SvgCodex />
                    <span className="text-sm font-semibold">Codex</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => copyCmd(buildCodexCmd(account.api_token, account.default_model || undefined), 'Codex')}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </div>
                <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap break-all text-foreground">
{buildCodexCmd(account.api_token, account.default_model || undefined)}
                </pre>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Live session status */}
        <div className={`flex flex-wrap items-center gap-3 rounded-lg border p-3 ${activeSessions > 0 ? 'border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-950/30' : 'bg-muted/40'}`}>
          <span className={`size-2 rounded-full ${activeSessions > 0 ? 'bg-blue-500 animate-pulse' : 'bg-muted-foreground'}`} />
          <span className="text-sm font-semibold">实时状态</span>
          <span className="text-sm">
            当前有 <span className={`text-base font-bold ${activeSessions > 0 ? 'text-blue-500' : ''}`}>{activeSessions}</span> 个活跃连接
          </span>
          {activeSessions > 0 && <Badge className="bg-blue-500 text-white hover:bg-blue-500">请求处理中</Badge>}
          <span className="ml-auto text-[11px] text-muted-foreground">每 5 秒自动刷新</span>
        </div>

        {/* Stats panels */}
        {stats && (
          <div className="grid gap-3 md:grid-cols-2">
            {/* Request stats */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Activity className="size-4" /> 请求统计
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <StatisticCard
                    label="今日请求"
                    value={stats.total_requests}
                    icon={<Activity className="size-4" />}
                    className="text-green-600 [&_.text-2xl]:text-green-600"
                  />
                  <StatisticCard label="累计请求" value={stats.all_time?.total_requests ?? 0} />
                  <StatisticCard
                    label="今日成功"
                    value={stats.success_count}
                    sub={`占比 ${stats.total_requests > 0 ? Math.round((stats.success_count / stats.total_requests) * 100) : 100}%`}
                    icon={<CheckCircle2 className="size-4 text-green-500" />}
                  />
                  <StatisticCard
                    label="今日失败"
                    value={stats.error_count}
                    sub={`占比 ${stats.total_requests > 0 ? Math.round((stats.error_count / stats.total_requests) * 100) : 0}%`}
                    icon={<XCircle className={`size-4 ${stats.error_count > 0 ? 'text-red-500' : 'text-green-500'}`} />}
                  />
                </div>
                <Separator className="my-3" />
                <div className="grid grid-cols-2 gap-3">
                  <StatisticCard
                    label="流式请求"
                    value={stats.stream_count}
                    sub={<Badge className="mt-0.5 bg-blue-500 text-white hover:bg-blue-500">{stats.total_requests > 0 ? Math.round((stats.stream_count / stats.total_requests) * 100) : 0}%</Badge>}
                    icon={<ArrowLeftRight className="size-4" />}
                  />
                  <StatisticCard
                    label="平均延迟"
                    value={Math.round(stats.avg_latency_ms)}
                    sub="ms"
                    icon={<Zap className={`size-4 ${stats.avg_latency_ms < 500 ? 'text-green-500' : stats.avg_latency_ms < 1500 ? 'text-yellow-500' : 'text-red-500'}`} />}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Token consumption */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Flame className="size-4" /> Token 消费
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <StatisticCard
                    label="今日 Token"
                    value={fmtTokens(stats.total_input_tokens + stats.total_output_tokens)}
                    className="[&_.text-2xl]:text-green-600"
                  />
                  <StatisticCard
                    label="累计 Token"
                    value={fmtTokens((stats.all_time?.total_input_tokens ?? 0) + (stats.all_time?.total_output_tokens ?? 0))}
                  />
                  <StatisticCard label="今日输入" value={fmtTokens(stats.total_input_tokens)} />
                  <StatisticCard label="今日输出" value={fmtTokens(stats.total_output_tokens)} />
                </div>
                <Separator className="my-3" />
                <div className="grid grid-cols-2 gap-3">
                  <StatisticCard
                    label="平均每请求"
                    value={stats.total_requests > 0 ? fmtTokens(Math.round((stats.total_input_tokens + stats.total_output_tokens) / stats.total_requests)) : '-'}
                    sub={stats.total_requests > 0 ? 'tokens' : undefined}
                  />
                  <StatisticCard
                    label="输入/输出比"
                    value={stats.total_output_tokens > 0 ? (stats.total_input_tokens / stats.total_output_tokens).toFixed(1) : '-'}
                    sub={stats.total_output_tokens > 0 ? ':1' : undefined}
                  />
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Hourly trend charts */}
        {stats && stats.hourly && stats.hourly.length > 0 && (() => {
          const hMap = new Map<string, { count: number; input_tokens: number; output_tokens: number; errors: number }>();
          for (const h of stats.hourly) {
            hMap.set(h.hour, h);
          }
          const now = new Date();
          const hourlyChartData: { label: string; count: number; input_tokens: number; output_tokens: number; errors: number }[] = [];
          for (let i = 23; i >= 0; i--) {
            const d = new Date(now.getTime() - i * 3600000);
            const key = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}`;
            const entry = hMap.get(key);
            hourlyChartData.push({
              label: `${String(d.getHours()).padStart(2, '0')}:00`,
              count: entry?.count ?? 0,
              input_tokens: entry?.input_tokens ?? 0,
              output_tokens: entry?.output_tokens ?? 0,
              errors: entry?.errors ?? 0,
            });
          }
          return (
            <div className="grid gap-3 lg:grid-cols-2">
              <Card>
                <CardHeader><CardTitle className="text-sm">24 小时请求趋势</CardTitle></CardHeader>
                <CardContent>
                  <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={hourlyChartData} margin={{ left: -10 }}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={2} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <RTooltip />
                        <Area type="monotone" dataKey="count" name="请求数" stroke={chartColor(0)} fill={chartColor(0)} fillOpacity={0.15} />
                        <Area type="monotone" dataKey="errors" name="错误数" stroke={chartColor(4)} fill={chartColor(4)} fillOpacity={0.15} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle className="text-sm">24 小时 Token 消耗趋势</CardTitle></CardHeader>
                <CardContent>
                  <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={hourlyChartData} margin={{ left: -10 }}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={2} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <RTooltip />
                        <Area type="monotone" dataKey="input_tokens" name="输入 Token" stroke={chartColor(3)} fill={chartColor(3)} fillOpacity={0.15} />
                        <Area type="monotone" dataKey="output_tokens" name="输出 Token" stroke={chartColor(2)} fill={chartColor(2)} fillOpacity={0.15} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </div>
          );
        })()}

        {/* Charts row */}
        {stats && (stats.by_model.length > 0 || endpointData.length > 0) && (
          <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
            {stats.by_model.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Flame className="size-4" /> 模型使用分布
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={stats.by_model} layout="vertical" margin={{ left: 10 }}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis type="number" />
                        <YAxis dataKey="model" type="category" width={100} tick={{ fontSize: 11 }} />
                        <RTooltip />
                        <Bar dataKey="count" name="请求数" fill={chartColor(0)} radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            )}
            {endpointData.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Globe className="size-4" /> 端点调用分布
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={endpointData}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          outerRadius={70}
                          label={({ name, percent }: { name?: string; percent?: number }) => `${name || ''} ${((percent || 0) * 100).toFixed(0)}%`}
                          labelLine={{ strokeWidth: 1 }}
                        >
                          {endpointData.map((_, i) => (
                            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                          ))}
                        </Pie>
                        <RTooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* Request logs */}
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Clock className="size-4" /> 请求日志
                <Badge variant="secondary">{logs.length} 条</Badge>
              </CardTitle>
              <Tabs value={logFilter} onValueChange={(v) => { setLogFilter(v); setPage(1); }}>
                <TabsList>
                  <TabsTrigger value="all">全部</TabsTrigger>
                  <TabsTrigger value="stream">流式</TabsTrigger>
                  <TabsTrigger value="errors">错误</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </CardHeader>
          <CardContent>
            {filteredLogs.length === 0 ? (
              <div className="py-16 text-center text-sm text-muted-foreground">暂无请求记录</div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <div className="min-w-[900px]">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[170px]">时间</TableHead>
                          <TableHead className="w-[200px]">端点</TableHead>
                          <TableHead className="w-[140px]">模型</TableHead>
                          <TableHead className="w-[60px]">流式</TableHead>
                          <TableHead className="w-[70px]">状态</TableHead>
                          <TableHead className="w-[80px]">输入</TableHead>
                          <TableHead className="w-[80px]">输出</TableHead>
                          <TableHead className="w-[100px]">延迟</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pagedLogs.map((record) => {
                          const key = String(record.id);
                          const isOpen = expanded.has(key);
                          return (
                            <React.Fragment key={key}>
                              <TableRow
                                className="cursor-pointer"
                                onClick={() => toggleRow(key)}
                                data-state={isOpen ? 'selected' : undefined}
                              >
                                <TableCell className="font-mono text-xs">{formatTime(record.created_at)}</TableCell>
                                <TableCell><code className="rounded bg-muted px-1 py-0.5 text-xs">{record.endpoint}</code></TableCell>
                                <TableCell className="max-w-[140px] truncate text-xs">{record.model || <span className="text-muted-foreground">-</span>}</TableCell>
                                <TableCell>
                                  <span className={`inline-block size-2 rounded-full ${record.stream ? 'bg-blue-500' : 'bg-muted-foreground'}`} />
                                </TableCell>
                                <TableCell><StatusBadge code={record.status_code} /></TableCell>
                                <TableCell className="font-mono text-xs">{record.input_tokens > 0 ? fmtTokens(record.input_tokens) : '-'}</TableCell>
                                <TableCell className="font-mono text-xs">{record.output_tokens > 0 ? fmtTokens(record.output_tokens) : '-'}</TableCell>
                                <TableCell className={`font-mono text-xs font-medium ${latencyTone(record.latency_ms)}`}>{formatLatency(record.latency_ms)}</TableCell>
                              </TableRow>
                              {isOpen && (
                                <TableRow data-state="selected">
                                  <TableCell colSpan={8} className="bg-muted/40">
                                    <div className="px-1 pb-2 pt-1">
                                      {record.status_code >= 400 && (
                                        <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950/30">
                                          <div className="mb-1.5 block font-semibold text-red-700 dark:text-red-300">
                                            <BarChart3 className="mr-1 inline size-3.5" />错误详情
                                          </div>
                                          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-red-700 dark:text-red-300">
{record.error_message || `HTTP ${record.status_code}`}
                                          </pre>
                                        </div>
                                      )}
                                      <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2 text-xs">
                                        <span className="text-muted-foreground">请求 ID</span>
                                        <code className="rounded bg-muted px-1 py-0.5">{record.id}</code>
                                        <span className="text-muted-foreground">时间</span>
                                        <span>{formatTime(record.created_at)}</span>
                                        <span className="text-muted-foreground">端点</span>
                                        <code className="rounded bg-muted px-1 py-0.5">{record.endpoint}</code>
                                        <span className="text-muted-foreground">模型</span>
                                        <span>{record.model || '-'}</span>
                                        <span className="text-muted-foreground">流式</span>
                                        <span>{record.stream ? '是' : '否'}</span>
                                        <span className="text-muted-foreground">状态</span>
                                        <span>{record.status_code}</span>
                                        <span className="text-muted-foreground">输入 / 输出 Token</span>
                                        <span>{record.input_tokens || 0} / {record.output_tokens || 0}</span>
                                        <span className="text-muted-foreground">延迟</span>
                                        <span>{formatLatency(record.latency_ms)}</span>
                                      </div>
                                    </div>
                                  </TableCell>
                                </TableRow>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </div>

                {/* Pagination */}
                <div className="flex flex-col items-center gap-2 pt-4 sm:flex-row sm:justify-between">
                  <span className="text-xs text-muted-foreground">共 {filteredLogs.length} 条</span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={safePage <= 1}
                    >
                      上一页
                    </Button>
                    <span className="text-xs tabular-nums">{safePage} / {totalPages}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={safePage >= totalPages}
                    >
                      下一页
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
};

export default AccountDetail;
