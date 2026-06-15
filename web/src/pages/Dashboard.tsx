import * as React from "react"
import { useEffect, useState } from "react"
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  AreaChart, Area,
} from "recharts"
import {
  Zap, CheckCircle2, XCircle, Users, Activity, ArrowLeftRight,
  LayoutDashboard, Flame, TrendingUp, Loader2,
} from "lucide-react"
import { api, accountDisplayName } from "@/api"
import type { Stats, Account } from "@/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { StatisticCard } from "@/components/statistic-card"
import { chartColor } from "@/lib/chart"
import { toast } from "sonner"

const fmt = (n: number) => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K"
  return n.toLocaleString()
}

const fmtLatency = (ms: number) => {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const remainS = s % 60
  return `${m}m${remainS > 0 ? ` ${remainS}s` : ""}`
}

// recharts Tooltip label/value formatters expect to return a tuple-like.
const formatRequests = (v: unknown): [string, string] => [Number(v).toLocaleString(), "请求数"]
const formatTokens = (v: unknown): [string, string] => [fmt(Number(v)), "Token 用量"]

const Dashboard: React.FC = () => {
  const [stats, setStats] = useState<Stats | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)

  const fetchData = async () => {
    setLoading(true)
    try {
      const [statsData, accountsData] = await Promise.all([
        api.getStats(),
        api.listAccounts(),
      ])
      setStats(statsData)
      setAccounts(accountsData)
    } catch (e) {
      console.error(e)
      toast.error("无法加载统计数据")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="size-8 animate-spin text-primary" />
      </div>
    )
  }
  if (!stats) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
        <span className="text-sm">无法加载统计数据</span>
      </div>
    )
  }

  const successRate = stats.total_requests > 0
    ? Math.round((stats.success_count / stats.total_requests) * 100) : 100
  const errorRate = stats.total_requests > 0
    ? Math.round((stats.error_count / stats.total_requests) * 100) : 0
  const streamRate = stats.total_requests > 0
    ? Math.round((stats.stream_count / stats.total_requests) * 100) : 0
  const totalTokens = stats.total_input_tokens + stats.total_output_tokens
  const allTimeTokens = (stats.all_time?.total_input_tokens ?? 0) + (stats.all_time?.total_output_tokens ?? 0)
  const avgTokensPerReq = stats.total_requests > 0
    ? Math.round(totalTokens / stats.total_requests) : 0
  const avgLatency = Math.round(stats.avg_latency_ms)

  const latencyColor =
    avgLatency < 5000 ? "text-emerald-600"
      : avgLatency < 15000 ? "text-amber-500"
        : "text-red-500"
  const successColor =
    successRate >= 95 ? "text-emerald-600"
      : successRate >= 80 ? "text-amber-500"
        : "text-red-500"

  const modelData = stats.by_model.map((m) => ({
    name: m.model, value: m.count,
    pct: stats.total_requests > 0 ? Math.round((m.count / stats.total_requests) * 100) : 0,
  }))

  const accountData = stats.by_account.map((a) => ({
    name: accountDisplayName(a), value: a.count,
    pct: stats.total_requests > 0 ? Math.round((a.count / stats.total_requests) * 100) : 0,
  }))

  // Build hourly chart data — fill gaps with zeros
  // Key format matches backend strftime('%m-%d %H') to avoid cross-day hour merging
  const hourlyMap = new Map<string, { count: number; tokens: number; errors: number }>()
  for (const h of stats.hourly ?? []) {
    hourlyMap.set(h.hour, { count: h.count, tokens: h.input_tokens + h.output_tokens, errors: h.errors })
  }
  const now = new Date()
  const hourlyChartData: { hour: string; label: string; requests: number; tokens: number; errors: number }[] = []
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600000)
    const key = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}`
    const label = `${String(d.getHours()).padStart(2, "0")}:00`
    const entry = hourlyMap.get(key)
    hourlyChartData.push({
      hour: key,
      label,
      requests: entry?.count ?? 0,
      tokens: entry?.tokens ?? 0,
      errors: entry?.errors ?? 0,
    })
  }

  const noRequests = stats.total_requests === 0 && (stats.all_time?.total_requests ?? 0) === 0

  return (
    <div className="space-y-4">
      {/* Banner */}
      <Card className="gap-0 overflow-hidden border-0 bg-gradient-to-br from-emerald-600 to-emerald-700 py-0">
        <CardContent className="px-5 py-4 sm:px-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-[13px] text-white/85">
                JoyCode API 代理服务 · 数据概览
              </p>
              <h3 className="mt-1 text-2xl font-bold text-white">
                系统运行状态
              </h3>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <StatisticCard
                label="今日请求"
                value={<span className="text-white">{stats.total_requests.toLocaleString()}</span>}
                className="border-0 bg-white/10 py-2 text-white"
              />
              <StatisticCard
                label="今日 Token"
                value={<span className="text-white">{fmt(totalTokens)}</span>}
                className="border-0 bg-white/10 py-2"
              />
              <StatisticCard
                label="累计请求"
                value={<span className="text-white">{(stats.all_time?.total_requests ?? 0).toLocaleString()}</span>}
                className="border-0 bg-white/10 py-2"
              />
              <StatisticCard
                label="累计 Token"
                value={<span className="text-white">{fmt(allTimeTokens)}</span>}
                className="border-0 bg-white/10 py-2"
              />
              <StatisticCard
                label="账号数"
                value={<span className="text-white">{stats.accounts_count}</span>}
                className="border-0 bg-white/10 py-2"
              />
              <StatisticCard
                label="成功率"
                value={<span className="text-white">{successRate}%</span>}
                className="border-0 bg-white/10 py-2"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 24h 时序图表 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="py-4">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <Activity className="size-4" /> 24 小时请求趋势
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={hourlyChartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={2} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: unknown) => formatRequests(v)} />
                  <Area type="monotone" dataKey="requests" name="requests" stroke={chartColor(0)} fill={chartColor(0)} fillOpacity={0.15} strokeWidth={2} />
                  <Area type="monotone" dataKey="errors" name="errors" stroke={chartColor(4)} fill={chartColor(4)} fillOpacity={0.1} strokeWidth={1.5} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="py-4">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <Flame className="size-4" /> 24 小时 Token 消耗趋势
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={hourlyChartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={2} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => fmt(v)} />
                  <Tooltip formatter={(v: unknown) => formatTokens(v)} />
                  <Area type="monotone" dataKey="tokens" stroke={chartColor(1)} fill={chartColor(1)} fillOpacity={0.15} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 统计面板：今日 + 累计 */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {/* 请求统计 */}
        <Card className="py-4">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <Activity className="size-4" /> 请求统计
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <StatisticCard label="今日请求" value={<span className="text-emerald-600">{stats.total_requests.toLocaleString()}</span>} />
              <StatisticCard label="累计请求" value={(stats.all_time?.total_requests ?? 0).toLocaleString()} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <StatisticCard
                label="今日成功"
                value={<span className="text-emerald-600">{stats.success_count.toLocaleString()}</span>}
                icon={<CheckCircle2 className="size-4 text-emerald-600" />}
                sub={<span>占比 {successRate}%</span>}
              />
              <StatisticCard
                label="今日失败"
                value={<span className={stats.error_count > 0 ? "text-red-500" : "text-emerald-600"}>{stats.error_count.toLocaleString()}</span>}
                icon={<XCircle className={`size-4 ${stats.error_count > 0 ? "text-red-500" : "text-emerald-600"}`} />}
                sub={<span>占比 {errorRate}%</span>}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2">
              <div className="flex items-center gap-1.5 text-sm">
                <ArrowLeftRight className="size-4 text-muted-foreground" />
                <span className="text-muted-foreground">流式请求</span>
                <span className="font-semibold tabular-nums">{stats.stream_count.toLocaleString()}</span>
              </div>
              <Badge variant="secondary">{streamRate}%</Badge>
            </div>
          </CardContent>
        </Card>

        {/* Token 消费 */}
        <Card className="py-4">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <Flame className="size-4" /> Token 消费
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <StatisticCard label="今日 Token" value={<span className="text-emerald-600">{fmt(totalTokens)}</span>} />
              <StatisticCard label="累计 Token" value={fmt(allTimeTokens)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <StatisticCard label="今日输入" value={fmt(stats.total_input_tokens)} />
              <StatisticCard label="今日输出" value={fmt(stats.total_output_tokens)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <StatisticCard label="平均每请求" value={`${avgTokensPerReq.toLocaleString()}`} sub="tokens" />
              <StatisticCard
                label="输入/输出比"
                value={stats.total_output_tokens > 0 ? (stats.total_input_tokens / stats.total_output_tokens).toFixed(1) : "-"}
                sub={stats.total_output_tokens > 0 ? ":1" : undefined}
              />
            </div>
          </CardContent>
        </Card>

        {/* 响应质量 */}
        <Card className="py-4">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <LayoutDashboard className="size-4" /> 响应质量
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <StatisticCard
                label="平均延迟"
                value={<span className={latencyColor}>{fmtLatency(avgLatency)}</span>}
                icon={<Zap className={`size-4 ${latencyColor}`} />}
              />
              <StatisticCard
                label="成功率"
                value={<span className={successColor}>{successRate}%</span>}
                icon={<CheckCircle2 className={`size-4 ${successColor}`} />}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <StatisticCard
                label="流式占比"
                value={`${streamRate}%`}
                icon={<ArrowLeftRight className="size-4 text-muted-foreground" />}
              />
              <StatisticCard
                label="配置账号"
                value={stats.accounts_count}
                icon={<Users className="size-4 text-muted-foreground" />}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <StatisticCard
                label="使用模型"
                value={stats.by_model.length}
                icon={<TrendingUp className="size-4 text-muted-foreground" />}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 图表面板：模型 / 账号分布 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 模型使用分布 */}
        <Card className="py-4">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <TrendingUp className="size-4" /> 模型使用分布
            </CardTitle>
          </CardHeader>
          <CardContent>
            {modelData.length > 0 ? (
              <div className="flex flex-col gap-4 md:flex-row">
                <div className="h-56 w-full md:flex-1">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={modelData} layout="vertical" margin={{ left: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" tick={{ fontSize: 11 }} />
                      <YAxis dataKey="name" type="category" width={110} tick={{ fontSize: 11 }} />
                      <Tooltip formatter={(v: unknown) => formatRequests(v)} />
                      <Bar dataKey="value" name="请求数" fill={chartColor(0)} radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="w-full space-y-1 md:w-44">
                  {modelData.map((m, i) => (
                    <div key={m.name} className="flex items-center justify-between border-b border-border/60 py-1.5 last:border-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="size-2 shrink-0 rounded-full" style={{ background: chartColor(i) }} />
                        <span className="truncate text-xs">{m.name}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <span className="text-xs font-medium tabular-nums">{m.value.toLocaleString()}</span>
                        <span className="text-[11px] text-muted-foreground">{m.pct}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">暂无数据</div>
            )}
          </CardContent>
        </Card>

        {/* 账号请求分布 */}
        <Card className="py-4">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <Users className="size-4" /> 账号请求分布
            </CardTitle>
          </CardHeader>
          <CardContent>
            {accountData.length > 0 ? (
              <div className="flex flex-col gap-4 md:flex-row">
                <div className="h-56 w-full md:flex-1">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={accountData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip formatter={(v: unknown) => formatRequests(v)} />
                      <Bar dataKey="value" name="请求数" fill={chartColor(0)} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="w-full space-y-1 md:w-44">
                  {accountData.map((a, i) => (
                    <div key={a.name} className="flex items-center justify-between border-b border-border/60 py-1.5 last:border-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="size-2 shrink-0 rounded-full" style={{ background: chartColor(i) }} />
                        <span className="truncate text-xs">{a.name}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <span className="text-xs font-medium tabular-nums">{a.value.toLocaleString()}</span>
                        <span className="text-[11px] text-muted-foreground">{a.pct}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">暂无数据</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 账号概览表 */}
      {accounts.length > 0 && (
        <Card className="py-4">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-1.5 text-sm">
                <Users className="size-4" /> 账号概览
              </CardTitle>
              <Badge variant="secondary">{accounts.length} 个账号</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>账号</TableHead>
                    <TableHead className="hidden md:table-cell">默认模型</TableHead>
                    <TableHead>请求量</TableHead>
                    <TableHead className="hidden md:table-cell">状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.map((record) => {
                    const found = stats.by_account.find((a) => a.user_id === record.user_id)
                    return (
                      <TableRow key={record.user_id}>
                        <TableCell className="font-semibold">{accountDisplayName(record)}</TableCell>
                        <TableCell className="hidden md:table-cell">
                          {record.default_model
                            ? <Badge variant="outline">{record.default_model}</Badge>
                            : <span className="text-muted-foreground">-</span>}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {found ? found.count.toLocaleString() : <span className="text-muted-foreground">0</span>}
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <Badge className="bg-emerald-600">在线</Badge>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 空状态 */}
      {noRequests && (
        <Card className="py-10">
          <CardContent className="flex flex-col items-center justify-center gap-2 text-center">
            <span className="text-sm font-medium">暂无请求数据</span>
            <span className="text-xs text-muted-foreground">
              配置好账号后，使用 Claude Code 或 Codex 连接到本代理即可看到统计数据
            </span>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

export default Dashboard
