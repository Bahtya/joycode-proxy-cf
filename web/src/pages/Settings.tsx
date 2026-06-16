import * as React from 'react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  Save,
  RotateCcw,
  HelpCircle,
  Settings as SettingsIcon,
  CheckCircle2,
  Lock,
} from 'lucide-react';

import { api, authApi, clearToken } from '../api';
import type { Settings, ModelInfo } from '../api';
import { cn } from '../lib/utils';

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardAction,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

type FieldType = 'input' | 'number' | 'select' | 'switch' | 'models';

interface FieldConfig {
  key: string;
  label: string;
  tooltip: string;
  placeholder: string;
  type: FieldType;
  options?: { label: string; value: string }[];
  suffix?: string;
  readOnly?: boolean;
  tag?: string;
}

const FIELD_GROUPS: { title: string; fields: FieldConfig[] }[] = [
  {
    title: '模型配置',
    fields: [
      {
        key: 'selectable_models',
        label: '可选模型',
        tag: '已生效',
        tooltip: '勾选要在各账号「默认模型」下拉中展示的模型。候选项实时来自上游 JoyCode；可手动追加自定义模型 id。仅影响下拉展示，不影响代理实际可转发的模型',
        placeholder: '',
        type: 'models',
      },
      {
        key: 'default_model',
        label: '默认模型',
        tag: '已生效',
        tooltip: '当客户端未指定模型，且账号未配置默认模型时使用的 JoyCode 模型（可选项即上方「可选模型」配置）',
        placeholder: 'JoyAI-Code',
        type: 'select',
      },
      {
        key: 'default_max_tokens',
        label: '默认最大输出 Token',
        tooltip: '客户端未指定 max_tokens 时的默认值。更大值允许更长回复，但消耗更多配额',
        placeholder: '8192',
        type: 'number',
        tag: '已生效',
      },
    ],
  },
  {
    title: '连接优化',
    fields: [
      {
        key: 'max_retries',
        label: '最大重试次数',
        tooltip: '请求失败时的自动重试次数。网络不稳定时可适当增加',
        placeholder: '3',
        type: 'number',
        tag: '已生效',
      },
      {
        key: 'request_timeout',
        label: '请求超时（秒）',
        tooltip: '与 JoyCode 后端通信的读取超时时间，低于 60 秒会自动调整为 60 秒',
        placeholder: '120',
        type: 'number',
        suffix: '秒',
        tag: '已生效',
      },
      {
        key: 'max_connections',
        label: '最大连接数',
        tooltip: '与 JoyCode 后端的最大并发 HTTP 连接数，修改后 10 秒内自动生效',
        placeholder: '20',
        type: 'number',
        tag: '已生效',
      },
    ],
  },
  {
    title: '日志与监控',
    fields: [
      {
        key: 'enable_request_logging',
        label: '启用请求日志',
        tooltip: '记录每个 API 请求的详细信息（模型、延迟、状态码）。关闭后「数据概览」页面将无数据',
        placeholder: 'true',
        type: 'switch',
        tag: '已生效',
      },
      {
        key: 'log_retention_days',
        label: '日志保留天数',
        tooltip: '聚合统计的保留天数。逐条明细约 7 天后压缩归档为每日汇总；超过此天数的汇总将被定期清理，0 表示永久保留',
        placeholder: '30',
        type: 'number',
        suffix: '天',
        tag: '已生效',
      },
    ],
  },
  {
    title: '区域与显示',
    fields: [
      {
        key: 'tz_offset',
        label: '时区偏移',
        tooltip: '相对 UTC 的小时偏移,默认 8(东八区/UTC+8)。统一影响仪表盘「今日」起算点、24 小时趋势图的小时桶、以及时间戳显示。支持小数(如 5.5)',
        placeholder: '8',
        type: 'number',
        suffix: '小时',
        tag: '已生效',
      },
    ],
  },
];

// Form values can be string, number, or boolean (matching the old AntD form behavior).
type FormValue = string | number | boolean;
type FormValues = Record<string, FormValue>;

const SettingsPage: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [values, setValues] = useState<FormValues>({});

  // Selectable-models editor state (kept out of `values` since it's a list; serialized
  // to a JSON string only on save).
  const [selectableModels, setSelectableModels] = useState<string[]>([]);
  const [upstreamModels, setUpstreamModels] = useState<ModelInfo[]>([]);
  const [modelOptions, setModelOptions] = useState<{ label: string; value: string }[]>([]);
  const [customModel, setCustomModel] = useState('');

  // password-change state
  const [changePwLoading, setChangePwLoading] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);

  const fetchSettings = async () => {
    setLoading(true);
    try {
      const data = await api.getSettings();
      // Normalize: switch fields come back as strings from backend; keep native form.
      const next: FormValues = {};
      for (const f of FIELD_GROUPS.flatMap((g) => g.fields)) {
        if (f.type === 'models') continue; // managed via dedicated list state, not `values`
        const raw = (data as Record<string, unknown>)[f.key];
        if (f.type === 'switch') {
          next[f.key] =
            raw === true || raw === 'true' || raw === 1 || raw === '1';
        } else if (f.type === 'number') {
          next[f.key] =
            raw === undefined || raw === null || raw === ''
              ? ''
              : Number(raw);
        } else {
          next[f.key] = raw === undefined || raw === null ? '' : String(raw);
        }
      }
      setValues(next);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '加载设置失败');
    } finally {
      setLoading(false);
    }
  };

  // Load the effective selectable list (/api/models, seed-included) and the live
  // upstream candidates (/api/upstream-models) for the editor.
  const fetchModelConfig = async () => {
    let eff: ModelInfo[] = [];
    let ups: ModelInfo[] = [];
    try {
      eff = await api.listModels();
    } catch {
      toast.error('模型列表加载失败，可重试'); // (F3)
    }
    try {
      ups = await api.listUpstreamModels();
      setUpstreamModels(ups);
    } catch {
      // upstream candidates optional
    }
    // Enrich the default_model dropdown labels with upstream names (F2): /api/models
    // returns name=id, so prefer the upstream label when available.
    const labelMap = new Map(ups.map((m) => [m.id, m.name || m.id]));
    setSelectableModels(eff.map((m) => m.id));
    setModelOptions(eff.map((m) => ({ label: labelMap.get(m.id) || m.name || m.id, value: m.id })));
  };

  // Refresh both scalar setting values and the model-editor state (used by the banner
  // 刷新 and 恢复当前值 buttons so the editor resets too). (F1)
  const refreshAll = () => {
    void fetchSettings();
    void fetchModelConfig();
    setCustomModel('');
  };

  useEffect(() => {
    void fetchSettings();
    void fetchModelConfig();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      // selectable_models is a JSON string array; other values are scalar.
      const payload = { ...values, selectable_models: JSON.stringify(selectableModels) };
      await api.updateSettings(payload as unknown as Settings);
      toast.success('设置已保存');
      void fetchModelConfig();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '保存设置失败');
    } finally {
      setSaving(false);
    }
  };

  const openChangePassword = () => {
    if (!oldPassword) {
      toast.error('请输入当前密码');
      return;
    }
    if (!newPassword) {
      toast.error('请输入新密码');
      return;
    }
    if (newPassword.length < 6) {
      toast.error('密码长度不能少于 6 位');
      return;
    }
    if (!confirmPassword) {
      toast.error('请确认新密码');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('两次输入的密码不一致');
      return;
    }
    setConfirmDialogOpen(true);
  };

  const doChangePassword = async () => {
    setChangePwLoading(true);
    try {
      await authApi.changePassword(oldPassword, newPassword);
      toast.success('密码修改成功，请重新登录');
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      clearToken();
      setTimeout(() => {
        window.location.href = '/login';
      }, 1000);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '密码修改失败');
    } finally {
      setChangePwLoading(false);
    }
  };

  const renderField = (field: FieldConfig) => {
    const value = values[field.key];

    const labelEl = (
      <div className="flex items-center gap-1.5">
        <span>{field.label}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <HelpCircle className="size-3.5 text-muted-foreground/70" />
          </TooltipTrigger>
          <TooltipContent>{field.tooltip}</TooltipContent>
        </Tooltip>
        {field.tag && (
          <Badge variant="secondary" className="ml-1 gap-1 text-[11px]">
            <CheckCircle2 className="size-3" />
            {field.tag}
          </Badge>
        )}
      </div>
    );

    const control = (() => {
      switch (field.type) {
        case 'number':
          return (
            <div className="relative">
              <Input
                type="number"
                placeholder={field.placeholder}
                disabled={field.readOnly}
                value={value === undefined || value === null ? '' : String(value)}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    [field.key]: e.target.value === '' ? '' : Number(e.target.value),
                  }))
                }
                className={cn(field.suffix && 'pr-10')}
              />
              {field.suffix && (
                <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted-foreground">
                  {field.suffix}
                </span>
              )}
            </div>
          );
        case 'select':
          return (
            <Select
              value={(value as string) ?? ''}
              onValueChange={(val) =>
                setValues((v) => ({ ...v, [field.key]: val }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={field.placeholder} />
              </SelectTrigger>
              <SelectContent>
                {(() => {
                  const base = field.options?.length ? field.options : modelOptions;
                  // Defensive union: keep showing a saved value even if it's no longer
                  // in the option list so the Select isn't blank. (C2)
                  const cur = values[field.key];
                  const extra =
                    typeof cur === 'string' && cur && !base.some((o) => o.value === cur)
                      ? [{ label: cur, value: cur }]
                      : [];
                  return [...base, ...extra].map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ));
                })()}
              </SelectContent>
            </Select>
          );
        case 'switch':
          return (
            <div className="flex items-center gap-3 py-1">
              <Switch
                checked={!!value}
                onCheckedChange={(checked) =>
                  setValues((v) => ({ ...v, [field.key]: checked }))
                }
              />
              <span className="text-sm text-muted-foreground">
                {value ? '已启用' : '已关闭'}
              </span>
            </div>
          );
        case 'models': {
          const candidateIds = new Set(upstreamModels.map((m) => m.id));
          const extras = selectableModels.filter((id) => !candidateIds.has(id));
          const upstreamRows = upstreamModels.map((m) => ({ id: m.id, label: m.name || m.id }));
          const extraRows = extras.map((id) => ({ id, label: id }));
          const rows = [...upstreamRows, ...extraRows];
          const addCustom = () => {
            const id = customModel.trim();
            if (!id) return;
            setCustomModel('');
            if (selectableModels.includes(id)) {
              toast.info('该模型已存在'); // (F6)
              return;
            }
            setSelectableModels((prev) => [...prev, id]);
          };
          return (
            <div className="space-y-2">
              <div className="rounded-md border divide-y">
                {rows.map((r) => {
                  const checked = selectableModels.includes(r.id);
                  return (
                    <div key={r.id} className="flex items-center justify-between gap-2 px-3 py-2">
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium">{r.label}</span>
                      </div>
                      <Switch
                        checked={checked}
                        onCheckedChange={(c) =>
                          setSelectableModels((prev) =>
                            c ? (prev.includes(r.id) ? prev : [...prev, r.id]) : prev.filter((x) => x !== r.id),
                          )
                        }
                      />
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="添加自定义模型 id（上游暂未返回的新模型）"
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addCustom();
                    }
                  }}
                />
                <Button type="button" variant="outline" size="sm" onClick={addCustom}>
                  添加
                </Button>
              </div>
              {upstreamModels.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  未拉到上游候选（可能尚无默认账号）；仍可手动添加模型 id。
                </p>
              )}
            </div>
          );
        }
        default:
          return (
            <Input
              placeholder={field.placeholder}
              disabled={field.readOnly}
              value={(value as string) ?? ''}
              onChange={(e) =>
                setValues((v) => ({ ...v, [field.key]: e.target.value }))
              }
            />
          );
      }
    })();

    return (
      <div key={field.key} className="grid gap-1.5">
        <Label>{labelEl}</Label>
        {control}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="size-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Banner */}
      <Card className="overflow-hidden border-none bg-gradient-to-br from-[#00b578] to-[#009a63] text-white shadow-sm">
        <CardContent className="flex items-center justify-between gap-4 py-5">
          <div>
            <div className="text-[13px] text-white/85">
              JoyCode API 代理服务 · 系统设置
            </div>
            <div className="mt-1 text-[22px] font-bold">代理配置管理</div>
          </div>
          <Button
            variant="ghost"
            onClick={refreshAll}
            className="text-white hover:bg-white/10 hover:text-white"
          >
            <RotateCcw className="size-4" />
            刷新
          </Button>
        </CardContent>
      </Card>

      {/* Field-group cards */}
      {FIELD_GROUPS.map((group) => (
        <Card key={group.title}>
          <CardHeader>
            <CardTitle className="text-[15px] font-semibold">
              {group.title}
            </CardTitle>
            <CardAction>
              <SettingsIcon className="size-5 text-[#00b578]" />
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {group.fields.map((field) => renderField(field))}
            </div>
          </CardContent>
        </Card>
      ))}

      {/* Security / password-change card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-[15px] font-semibold">安全设置</CardTitle>
          <CardAction>
            <SettingsIcon className="size-5 text-[#00b578]" />
          </CardAction>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="grid gap-1.5">
              <Label>当前密码</Label>
              <Input
                type="password"
                placeholder="输入当前密码"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>新密码</Label>
              <Input
                type="password"
                placeholder="输入新密码（至少 6 位）"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>确认新密码</Label>
              <Input
                type="password"
                placeholder="再次输入新密码"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
          </div>
          <div className="mt-4">
            <Button onClick={openChangePassword} disabled={changePwLoading}>
              {changePwLoading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Lock className="size-4" />
              )}
              修改密码
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Save / restore */}
      <div className="flex gap-3 pt-2">
        <Button size="lg" onClick={() => void handleSave()} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          保存设置
        </Button>
        <Button
          variant="outline"
          size="lg"
          onClick={refreshAll}
        >
          <RotateCcw className="size-4" />
          恢复当前值
        </Button>
      </div>

      {/* Change-password confirmation dialog (replaces AntD Modal.confirm) */}
      <AlertDialog
        open={confirmDialogOpen}
        onOpenChange={(open) => {
          setConfirmDialogOpen(open);
          if (!open) setChangePwLoading(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认修改密码</AlertDialogTitle>
            <AlertDialogDescription>
              修改密码后需要重新登录，确定要继续吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={changePwLoading}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={changePwLoading}
              onClick={(e) => {
                e.preventDefault();
                void doChangePassword();
              }}
            >
              {changePwLoading && <Loader2 className="size-4 animate-spin" />}
              确认修改
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default SettingsPage;
