import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Plus,
  Trash2,
  Star,
  ShieldCheck,
  QrCode,
  RefreshCw,
  HelpCircle,
  Eraser,
  Pencil,
  CheckCircle2,
  XCircle,
  Clock,
  GripVertical,
  Download,
  Upload,
  MoreHorizontal,
  Loader2,
  KeyRound,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CopyableText } from '@/components/copyable-text';
import SvgClaudeCode from '@/components/ClaudeCodeIcon';
import SvgCodex from '@/components/CodexIcon';
import CommandTooltip from '@/components/CommandTooltip';
import QRLoginModal from '@/components/QRLoginModal';
import { useIsMobile } from '@/hooks/use-mobile';
import { api, accountDisplayName } from '@/api';
import type { Account } from '@/api';

const BUILTIN_MODELS = [
  { label: 'JoyAI-Code（推荐）', value: 'JoyAI-Code' },
  { label: 'Claude-Opus-4.7', value: 'Claude-Opus-4.7' },
  { label: 'GLM-5.1', value: 'GLM-5.1' },
  { label: 'GLM-5', value: 'GLM-5' },
  { label: 'GLM-4.7', value: 'GLM-4.7' },
  { label: 'Kimi-K2.6', value: 'Kimi-K2.6' },
  { label: 'Kimi-K2.5', value: 'Kimi-K2.5' },
  { label: 'MiniMax-M2.7', value: 'MiniMax-M2.7' },
  { label: 'Doubao-Seed-2.0-pro', value: 'Doubao-Seed-2.0-pro' },
];

const isClaudeModel = (model?: string) => model === 'Claude-Opus-4.7';

const claudeDockerHint = [
  `docker run -d \\`,
  `  --name joycode-proxy \\`,
  `  -p 34891:34891 \\`,
  `  -v "$HOME/.joycode-proxy:/root/.joycode-proxy" \\`,
  `  -v "$HOME/Library/Application Support/JoyCode/User/globalStorage/state.vscdb:/root/.joycode-ide/state.vscdb:ro" \\`,
  `  joycode-proxy --skip-validation serve`,
].join('\n');

const getBaseURL = () => `${window.location.protocol}//${window.location.host}`;

const maskUserId = (id: string): string => {
  if (!id) return '-';
  if (id.length <= 3) return id[0] + '***';
  return id.slice(0, 2) + '***' + id.slice(-2);
};

const fmtTokens = (n: number): string => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
};

const claudeCodeCmd = (apiKey: string, model = 'GLM-5.1') => [
  `API_TIMEOUT_MS=6000000 \\`,
  `CLAUDE_CODE_MAX_RETRIES=1000000 \\`,
  `NODE_TLS_REJECT_UNAUTHORIZED=0 \\`,
  `ANTHROPIC_BASE_URL=${getBaseURL()} \\`,
  `ANTHROPIC_API_KEY="${apiKey}" \\`,
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS=6553655 \\`,
  `ANTHROPIC_MODEL=${model} \\`,
  `claude --dangerously-skip-permissions`,
].join('\n');

const codexCmd = (apiKey: string, model = 'GLM-5.1') => [
  `OPENAI_BASE_URL=${getBaseURL()}/v1 \\`,
  `OPENAI_API_KEY="${apiKey}" \\`,
  `OPENAI_MODEL=${model} \\`,
  `codex`,
].join('\n');

const copyToClipboard = async (text: string, label: string) => {
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
    toast.success(`${label} 命令已复制`);
  } catch {
    toast.error('复制失败');
  }
};

const CredentialBadge = ({ record }: { record: Account }) => {
  const cv = record.credential_valid;
  if (cv === 1) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="secondary" className="gap-1 bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
              <CheckCircle2 className="size-3" />
              有效
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent>{`上次刷新：${record.credential_refreshed_at || record.credential_checked_at || '未知'}`}</TooltipContent>
      </Tooltip>
    );
  }
  if (cv === 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="destructive" className="gap-1">
              <XCircle className="size-3" />
              已过期
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent>{record.credential_error || '凭证已过期，请重新扫码登录获取凭证'}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Badge variant="secondary" className="gap-1 bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            <Clock className="size-3" />
            首次检测中
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent>keepalive 将在启动后 10 分钟内完成首次检测</TooltipContent>
    </Tooltip>
  );
};

const Accounts: React.FC = () => {
  const isMobile = useIsMobile();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({
    pt_key: '',
    user_id: '',
    default_model: '',
    is_default: false,
  });
  const [validating, setValidating] = useState<string | null>(null);
  const [autoLogging, setAutoLogging] = useState(false);
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<string>('');
  const [renameValue, setRenameValue] = useState('');
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  // AlertDialog confirm states
  const [clearSessionOpen, setClearSessionOpen] = useState(false);
  const [renewTarget, setRenewTarget] = useState<Account | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Account | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const fetchAccounts = async () => {
    setLoading(true);
    try {
      const data = await api.listAccounts();
      setAccounts(data);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '获取账号列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAccounts();
  }, []);

  const handleAdd = async () => {
    if (!form.pt_key) {
      toast.error('请输入 ptKey');
      return;
    }
    try {
      const res = await api.addAccount({
        pt_key: form.pt_key,
        user_id: form.user_id || undefined,
        is_default: form.is_default,
        default_model: form.default_model || undefined,
      });
      toast.success(`账号「${res.nickname || res.user_id}」添加成功`);
      setModalOpen(false);
      setForm({ pt_key: '', user_id: '', default_model: '', is_default: false });
      fetchAccounts();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '添加账号失败');
    }
  };

  const handleAutoLogin = async () => {
    setAutoLogging(true);
    try {
      const result = await api.autoLogin();
      toast.success(`一键登录成功！账号「${result.nickname || result.user_id}」已添加`);
      fetchAccounts();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '一键登录失败');
    } finally {
      setAutoLogging(false);
    }
  };

  const handleRemove = async (userId: string, displayName: string) => {
    try {
      await api.removeAccount(userId);
      toast.success(`账号「${displayName}」已删除`);
      fetchAccounts();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '删除账号失败');
    }
  };

  const handleSetDefault = async (userId: string, displayName: string) => {
    try {
      await api.setDefault(userId);
      toast.success(`已将「${displayName}」设为默认账号`);
      fetchAccounts();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '设置默认账号失败');
    }
  };

  const handleRenewToken = async (userId: string) => {
    try {
      await api.renewToken(userId);
      toast.success('API Token 已更新');
      fetchAccounts();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '更新 Token 失败');
    }
  };

  const handleValidate = async (userId: string, displayName: string) => {
    setValidating(userId);
    try {
      const result = await api.validateAccount(userId);
      if (result.valid) {
        toast.success(`账号「${displayName}」验证通过，凭证有效`);
      } else {
        toast.error(`账号「${displayName}」验证失败，凭证无效或已过期`);
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '验证请求失败');
    } finally {
      setValidating(null);
    }
  };

  const handleRename = async () => {
    const newName = renameValue.trim();
    if (!newName) {
      toast.error('请输入备注名');
      return;
    }
    try {
      await api.updateRemark(renameTarget, newName);
      toast.success(`账号备注已更新为「${newName}」`);
      setRenameModalOpen(false);
      fetchAccounts();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '更新备注失败');
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = accounts.findIndex((a) => a.user_id === active.id);
    const newIndex = accounts.findIndex((a) => a.user_id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const newAccounts = arrayMove(accounts, oldIndex, newIndex);
    setAccounts(newAccounts);

    try {
      await api.reorderAccounts(newAccounts.map((a) => a.user_id));
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '保存排序失败');
      fetchAccounts();
    }
  };

  const exportAccounts = async () => {
    try {
      const result = await api.exportAccounts();
      if (!result.accounts || result.accounts.length === 0) {
        toast.warning('没有可导出的账号');
        return;
      }
      const blob = new Blob([JSON.stringify(result.accounts, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `joycode-accounts-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`已导出 ${result.count} 个账号`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '导出失败');
    }
  };

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const imported = JSON.parse(text);
      if (!Array.isArray(imported) || imported.length === 0) {
        toast.error('文件格式错误：应为非空 JSON 数组');
        return;
      }
      const result = await api.importAccounts(imported);
      toast.success(`导入完成：新增 ${result.added} 个，更新 ${result.updated} 个`);
      fetchAccounts();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '导入失败');
    } finally {
      setImporting(false);
      e.target.value = '';
    }
  };

  const clearJoyCodeSession = async () => {
    try {
      const result = await api.clearJoyCodeSession();
      toast.success(result.message || 'JoyCode 本地会话已清除');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '清除会话失败');
    }
  };

  const openRename = (record: Account) => {
    setRenameTarget(record.user_id);
    setRenameValue(record.remark || accountDisplayName(record));
    setRenameModalOpen(true);
  };

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-semibold">账号管理</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={fetchAccounts}>
              <RefreshCw />
              刷新
            </Button>
            <Button variant="outline" size="sm" onClick={() => setQrModalOpen(true)}>
              <QrCode />
              扫码登录
            </Button>
            <Button size="sm" onClick={handleAutoLogin} disabled={autoLogging}>
              {autoLogging ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              一键导入本地JoyCode已登录账户
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setClearSessionOpen(true)}>
              <Eraser />
              清空本地JoyCode会话
            </Button>
            <Button variant="outline" size="sm" onClick={exportAccounts}>
              <Download />
              导出账号
            </Button>
            <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={importing}>
              {importing ? <Loader2 className="animate-spin" /> : <Upload />}
              导入账号
            </Button>
            <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={onImportFile} />
            <Button size="sm" onClick={() => setModalOpen(true)}>
              <Plus />
              手动添加
            </Button>
          </div>
        </div>

        <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm dark:border-blue-900 dark:bg-blue-950/40">
          <div className="font-medium text-blue-900 dark:text-blue-200">多账号路由说明</div>
          <div className="mt-1 text-blue-800 dark:text-blue-300">
            每个账号对应一个 JoyCode 后端凭证。客户端通过 API Token 来指定使用哪个账号。配置 Claude Code 时，将 API Token 填入 ANTHROPIC_API_KEY 环境变量即可。拖动行左侧手柄可调整排序。
          </div>
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={accounts.map((a) => a.user_id)} strategy={verticalListSortingStrategy}>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="hidden w-10 lg:table-cell" />
                    <TableHead className="min-w-[8rem]">账户名</TableHead>
                    <TableHead className="hidden lg:table-cell">API Token</TableHead>
                    <TableHead className="hidden lg:table-cell">用户 ID</TableHead>
                    <TableHead className="hidden lg:table-cell">活跃会话</TableHead>
                    <TableHead className="hidden md:table-cell">今日请求</TableHead>
                    <TableHead className="hidden lg:table-cell">今日 Token</TableHead>
                    <TableHead className="hidden md:table-cell">凭证状态</TableHead>
                    <TableHead className="hidden md:table-cell">状态</TableHead>
                    <TableHead className="hidden lg:table-cell">默认模型</TableHead>
                    <TableHead className="hidden lg:table-cell">快速启动</TableHead>
                    <TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.length === 0 && !loading && (
                    <TableRow>
                      <TableCell colSpan={12} className="h-24 text-center text-muted-foreground">
                        暂无账号，请点击「扫码登录」按钮配置您的第一个 JoyCode 账号
                      </TableCell>
                    </TableRow>
                  )}
                  {accounts.map((record) => (
                    <SortableRow
                      key={record.user_id}
                      record={record}
                      isMobile={isMobile}
                      validating={validating}
                      onRename={openRename}
                      onSetDefault={handleSetDefault}
                      onValidate={handleValidate}
                      onRequestRenew={setRenewTarget}
                      onRequestRemove={setRemoveTarget}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          </SortableContext>
        </DndContext>

        {/* 手动添加 */}
        <Dialog open={modalOpen} onOpenChange={(o) => { setModalOpen(o); if (!o) setForm({ pt_key: '', user_id: '', default_model: '', is_default: false }); }}>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>手动添加 JoyCode 账号</DialogTitle>
              <DialogDescription>
                普通模型使用网页 OAuth 登录得到的账号凭证。选择 Claude 模型时，服务端还需要读取本机 JoyCode IDE 登录状态中的短 ptKey。
              </DialogDescription>
            </DialogHeader>

            {isClaudeModel(form.default_model) && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
                <div className="font-medium text-amber-900 dark:text-amber-200">Claude 模型需要 JoyCode IDE 已登录</div>
                <div className="mt-1 text-amber-800 dark:text-amber-300">
                  请先在本机 JoyCode IDE 客户端完成登录。Docker 启动时还需要挂载 JoyCode IDE 的本地状态文件，代理会从该文件自动读取 Claude 所需的短 ptKey。
                </div>
                <pre className="mt-2 whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">{claudeDockerHint}</pre>
              </div>
            )}

            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label>
                  JoyCode ptKey 凭证
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      普通模型使用网页 OAuth 登录得到的长 ptKey。Claude 模型还会从本机 JoyCode IDE 状态文件读取短 ptKey，不会覆盖这里保存的普通账号凭证。
                    </TooltipContent>
                  </Tooltip>
                </Label>
                <Input
                  type="password"
                  placeholder="粘贴网页 OAuth 或 JoyCode 普通接口可用的 ptKey"
                  value={form.pt_key}
                  onChange={(e) => setForm((f) => ({ ...f, pt_key: e.target.value }))}
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label>
                  用户 ID（可选）
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      留空则用 ptKey 自动获取（推荐）。仅在你需要手动指定用户 ID 时填写。
                    </TooltipContent>
                  </Tooltip>
                </Label>
                <Input
                  placeholder="留空自动获取"
                  value={form.user_id}
                  onChange={(e) => setForm((f) => ({ ...f, user_id: e.target.value }))}
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label>
                  默认模型
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      选择 Claude-Opus-4.7 时，请确保本机 JoyCode IDE 已登录，并按提示挂载 state.vscdb。非 Claude 模型继续使用网页 OAuth 凭证。
                    </TooltipContent>
                  </Tooltip>
                </Label>
                <Select
                  value={form.default_model}
                  onValueChange={(v) => setForm((f) => ({ ...f, default_model: v }))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="留空使用系统默认模型" />
                  </SelectTrigger>
                  <SelectContent>
                    {BUILTIN_MODELS.map((m) => (
                      <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between">
                <Label>
                  设为默认账号
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      当客户端未提供路由密钥时，请求将自动路由到此默认账号。建议将最常用的账号设为默认
                    </TooltipContent>
                  </Tooltip>
                </Label>
                <Switch
                  checked={form.is_default}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, is_default: v }))}
                />
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => { setModalOpen(false); setForm({ pt_key: '', user_id: '', default_model: '', is_default: false }); }}>
                取消
              </Button>
              <Button onClick={handleAdd}>添加</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 修改备注 */}
        <Dialog open={renameModalOpen} onOpenChange={setRenameModalOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>修改账号备注</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rename-input">备注名</Label>
              <Input
                id="rename-input"
                placeholder="输入备注名，例如：我的主账号"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); }}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRenameModalOpen(false)}>取消</Button>
              <Button onClick={handleRename}>确认</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <QRLoginModal
          open={qrModalOpen}
          onClose={() => setQrModalOpen(false)}
          onSuccess={fetchAccounts}
          onAutoLogin={handleAutoLogin}
        />

        {/* 清空本地会话 */}
        <AlertDialog open={clearSessionOpen} onOpenChange={setClearSessionOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确定要清空本地 JoyCode IDE 的登录会话吗？</AlertDialogTitle>
              <AlertDialogDescription>
                清除后 JoyCode IDE 将需要重新登录，此操作不影响已导入的账号
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={clearJoyCodeSession}>确定</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* 重置 Token */}
        <AlertDialog open={!!renewTarget} onOpenChange={(o) => { if (!o) setRenewTarget(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确定要重置 API Token 吗？</AlertDialogTitle>
              <AlertDialogDescription>重置后旧 Token 将立即失效</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => { if (renewTarget) handleRenewToken(renewTarget.user_id); setRenewTarget(null); }}
              >
                重置
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* 删除账号 */}
        <AlertDialog open={!!removeTarget} onOpenChange={(o) => { if (!o) setRemoveTarget(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{`确定要删除账号「${removeTarget ? accountDisplayName(removeTarget) : ''}」吗？`}</AlertDialogTitle>
              <AlertDialogDescription>删除后使用该密钥的客户端将无法访问</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => { if (removeTarget) handleRemove(removeTarget.user_id, accountDisplayName(removeTarget)); setRemoveTarget(null); }}
              >
                删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
};

interface SortableRowProps {
  record: Account;
  isMobile: boolean;
  validating: string | null;
  onRename: (record: Account) => void;
  onSetDefault: (userId: string, displayName: string) => void;
  onValidate: (userId: string, displayName: string) => void;
  onRequestRenew: (record: Account) => void;
  onRequestRemove: (record: Account) => void;
}

const SortableRow: React.FC<SortableRowProps> = ({
  record,
  isMobile,
  validating,
  onRename,
  onSetDefault,
  onValidate,
  onRequestRenew,
  onRequestRemove,
}) => {
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: record.user_id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform && { ...transform, scaleY: 1 }),
    transition,
    ...(isDragging ? { position: 'relative', zIndex: 9999 } : {}),
  };

  const goDetail = () => navigate(`/accounts/${encodeURIComponent(record.user_id)}`);
  const displayName = accountDisplayName(record);
  const claudeCmd = claudeCodeCmd(record.api_token, record.default_model || undefined);
  const cxCmd = codexCmd(record.api_token, record.default_model || undefined);
  const isValidating = validating === record.user_id;

  const renderActions = () => {
    if (!isMobile) {
      return (
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="outline" size="xs" onClick={(e) => { e.stopPropagation(); onRename(record); }}>
            <Pencil /> 备注
          </Button>
          {!record.is_default && (
            <Button variant="outline" size="xs" onClick={(e) => { e.stopPropagation(); onSetDefault(record.user_id, displayName); }}>
              <Star /> 设为默认
            </Button>
          )}
          <Button variant="outline" size="xs" onClick={(e) => { e.stopPropagation(); onRequestRenew(record); }}>
            <KeyRound /> 重置 Token
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={isValidating}
            onClick={(e) => { e.stopPropagation(); onValidate(record.user_id, displayName); }}
          >
            {isValidating ? <Loader2 className="animate-spin" /> : <ShieldCheck />} 验证
          </Button>
          <Button variant="destructive" size="xs" onClick={(e) => { e.stopPropagation(); onRequestRemove(record); }}>
            <Trash2 /> 删除
          </Button>
        </div>
      );
    }
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" onClick={(e) => e.stopPropagation()} aria-label="更多操作">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem onSelect={() => onRename(record)}>
            <Pencil /> 备注
          </DropdownMenuItem>
          {!record.is_default && (
            <DropdownMenuItem onSelect={() => onSetDefault(record.user_id, displayName)}>
              <Star /> 设为默认
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => onValidate(record.user_id, displayName)}>
            <ShieldCheck /> 验证
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => onRequestRenew(record)}>
            <KeyRound /> 重置 Token
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => onRequestRemove(record)}>
            <Trash2 /> 删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  return (
    <TableRow
      ref={setNodeRef}
      style={{ ...style, cursor: 'pointer' }}
      onClick={goDetail}
      {...attributes}
    >
      <TableCell className="hidden w-10 text-center align-middle lg:table-cell">
        <button
          ref={setActivatorNodeRef}
          {...listeners}
          type="button"
          className="inline-flex cursor-grab items-center text-muted-foreground"
          onClick={(e) => e.stopPropagation()}
          aria-label="拖动排序"
        >
          <GripVertical className="size-4" />
        </button>
      </TableCell>

      <TableCell className="min-w-[8rem] max-w-[16rem]">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block truncate font-medium">{displayName}</span>
          </TooltipTrigger>
          <TooltipContent>{displayName}</TooltipContent>
        </Tooltip>
      </TableCell>

      <TableCell className="hidden lg:table-cell">
        <CopyableText value={record.api_token} />
      </TableCell>

      <TableCell className="hidden text-[13px] text-muted-foreground lg:table-cell">
        {maskUserId(record.user_id)}
      </TableCell>

      <TableCell className="hidden lg:table-cell">
        {record.active_sessions > 0 ? (
          <Badge variant="secondary" className="gap-1 bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            {record.active_sessions} 个活跃
          </Badge>
        ) : (
          <span className="text-sm text-muted-foreground">无</span>
        )}
      </TableCell>

      <TableCell className="hidden md:table-cell">
        <div className="leading-tight">
          <div className="text-[13px] font-semibold">{record.today_requests}</div>
          <div className="text-[11px] text-muted-foreground">累计 {record.total_requests}</div>
        </div>
      </TableCell>

      <TableCell className="hidden lg:table-cell">
        <div className="leading-tight">
          <div className="text-[13px] font-semibold">{fmtTokens(record.today_tokens)}</div>
          <div className="text-[11px] text-muted-foreground">累计 {fmtTokens(record.total_tokens)}</div>
        </div>
      </TableCell>

      <TableCell className="hidden md:table-cell">
        <CredentialBadge record={record} />
      </TableCell>

      <TableCell className="hidden md:table-cell">
        {record.is_default && (
          <Badge variant="secondary" className="gap-1 bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            <Star className="size-3" /> 默认账号
          </Badge>
        )}
      </TableCell>

      <TableCell className="hidden lg:table-cell">
        {record.default_model ? (
          <Badge variant="secondary" className="gap-1 bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
            {record.default_model}
          </Badge>
        ) : (
          <span className="text-sm text-muted-foreground">未设置</span>
        )}
      </TableCell>

      <TableCell className="hidden lg:table-cell">
        <div className="flex items-center gap-1">
          <CommandTooltip command={claudeCmd} label="Claude Code">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={(e) => { e.stopPropagation(); copyToClipboard(claudeCmd, 'Claude Code'); }}
            >
              <SvgClaudeCode />
            </Button>
          </CommandTooltip>
          <CommandTooltip command={cxCmd} label="Codex">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={(e) => { e.stopPropagation(); copyToClipboard(cxCmd, 'Codex'); }}
            >
              <SvgCodex />
            </Button>
          </CommandTooltip>
        </div>
      </TableCell>

      <TableCell onClick={(e) => e.stopPropagation()}>
        {renderActions()}
      </TableCell>
    </TableRow>
  );
};

export default Accounts;
