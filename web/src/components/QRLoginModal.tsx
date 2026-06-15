import { useEffect, useState, useRef, useCallback } from 'react';
import {
  RefreshCw,
  CheckCircle2,
  XCircle,
  ShieldCheck,
  LogIn,
  Info,
  AlertTriangle,
  ShieldAlert,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api } from '../api';

interface QRLoginModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  onAutoLogin: () => void;
}

type Status =
  | 'loading'
  | 'waiting'
  | 'scanned'
  | 'confirmed'
  | 'expired'
  | 'error'
  | 'verification_required';

const QRLoginModal = ({ open, onClose, onSuccess, onAutoLogin }: QRLoginModalProps) => {
  const [qrImage, setQrImage] = useState('');
  const [status, setStatus] = useState<Status>('loading');
  const [countdown, setCountdown] = useState(180);
  const [errorMsg, setErrorMsg] = useState('');
  const [verifyURL, setVerifyURL] = useState('');
  const [pollTrigger, setPollTrigger] = useState(0);
  const sessionIdRef = useRef('');
  const pollTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onSuccessRef = useRef(onSuccess);
  const onCloseRef = useRef(onClose);
  const onAutoLoginRef = useRef(onAutoLogin);

  onSuccessRef.current = onSuccess;
  onCloseRef.current = onClose;
  onAutoLoginRef.current = onAutoLogin;

  const initQR = useCallback(async () => {
    setStatus('loading');
    setCountdown(180);
    setErrorMsg('');
    setVerifyURL('');
    try {
      const result = await api.qrLoginInit();
      setQrImage(result.qr_image);
      sessionIdRef.current = result.session_id;
      setStatus('waiting');
      setPollTrigger((c) => c + 1);
    } catch (e: unknown) {
      setStatus('error');
      const msg = e instanceof Error ? e.message : '生成二维码失败';
      setErrorMsg(msg);
      toast.error(msg);
    }
  }, []);

  useEffect(() => {
    if (open) {
      initQR();
    } else {
      setQrImage('');
      sessionIdRef.current = '';
      setStatus('loading');
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    }
  }, [open, initQR]);

  useEffect(() => {
    if (!open) return;
    if (status !== 'waiting' && status !== 'scanned') return;

    const poll = async () => {
      const sid = sessionIdRef.current;
      if (!sid) {
        pollTimerRef.current = setTimeout(poll, 1000);
        return;
      }
      try {
        const result = await api.qrLoginStatus(sid);
        if (result.status === 'confirmed') {
          setStatus('confirmed');
          toast.success('登录成功！账号已添加');
          setTimeout(() => {
            onSuccessRef.current();
            onCloseRef.current();
          }, 1500);
          return;
        }
        if (result.status === 'expired') {
          setStatus('expired');
          return;
        }
        if (result.status === 'verification_required') {
          setStatus('verification_required');
          setVerifyURL(result.verify_url || '');
          setErrorMsg(result.message || 'JD 风控验证');
          return;
        }
        if (result.status === 'error') {
          setStatus('error');
          const m = result.message || '登录失败';
          setErrorMsg(m);
          toast.error(m);
          return;
        }
        if (result.status === 'scanned') {
          setStatus('scanned');
        }
      } catch {
        // Continue polling on network error
      }
      pollTimerRef.current = setTimeout(poll, 3000);
    };

    pollTimerRef.current = setTimeout(poll, 2000);
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [open, pollTrigger]);

  useEffect(() => {
    if (!open || status === 'confirmed' || status === 'expired' || status === 'loading' || status === 'verification_required') return;
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          setStatus('expired');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [open, status]);

  const handleAutoLogin = () => {
    onCloseRef.current();
    onAutoLoginRef.current();
  };

  const fmtCountdown = `${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, '0')}`;

  const renderStatus = () => {
    switch (status) {
      case 'loading':
        return (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <Loader2 className="size-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">正在生成二维码...</p>
          </div>
        );

      case 'waiting':
        return (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-3 text-sm">
            <div className="flex items-start gap-2">
              <Info className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="flex flex-col gap-1">
                <span>请使用京东 APP 扫描上方二维码</span>
                <span className="text-muted-foreground">{`二维码有效期剩余 ${fmtCountdown}`}</span>
                <button
                  type="button"
                  onClick={handleAutoLogin}
                  className="inline-flex w-fit items-center gap-1 text-primary hover:underline"
                >
                  <LogIn className="size-3.5" />
                  推荐使用「一键登录」从本机 JoyCode 自动导入
                </button>
              </div>
            </div>
          </div>
        );

      case 'scanned':
        return (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-primary">
            <Loader2 className="size-4 shrink-0 animate-spin" />
            已扫描，请在手机上确认登录...
          </div>
        );

      case 'confirmed':
        return (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-primary">
            <CheckCircle2 className="size-4 shrink-0" />
            登录成功！账号已添加
          </div>
        );

      case 'expired':
        return (
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-amber-600">
              <XCircle className="size-4 shrink-0" />
              二维码已过期
            </div>
            <Button variant="outline" size="sm" onClick={initQR}>
              <RefreshCw className="size-4" />
              刷新二维码
            </Button>
          </div>
        );

      case 'verification_required':
        return (
          <div className="flex flex-col items-center gap-3">
            <div className="flex w-full items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <div className="flex flex-col gap-0.5">
                <span className="font-medium text-amber-700">京东安全验证</span>
                <span className="text-muted-foreground">{errorMsg || '京东检测到登录风险，需要完成安全验证。'}</span>
              </div>
            </div>
            {verifyURL && (
              <Button size="sm" asChild>
                <a href={verifyURL} target="_blank" rel="noopener noreferrer">
                  <ShieldCheck className="size-4" />
                  打开安全验证页面
                </a>
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={initQR}>
              <RefreshCw className="size-4" />
              重新扫码
            </Button>
          </div>
        );

      case 'error':
        return (
          <div className="flex flex-col items-center gap-3">
            <div className="flex w-full items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="flex flex-col gap-0.5">
                <span className="font-medium text-destructive">{errorMsg || '登录失败'}</span>
                {errorMsg?.includes('pt_key') && (
                  <span className="text-muted-foreground">
                    京东扫码登录接口已变更，请使用一键登录自动导入凭据。
                  </span>
                )}
              </div>
            </div>
            <Button size="sm" onClick={handleAutoLogin}>
              <LogIn className="size-4" />
              一键登录（推荐）
            </Button>
            <Button variant="outline" size="sm" onClick={initQR}>
              <RefreshCw className="size-4" />
              重试扫码
            </Button>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>扫码登录</DialogTitle>
          <DialogDescription>
            使用京东 APP 扫描二维码登录。如遇问题，推荐使用「一键登录」自动导入。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4">
          {qrImage && status !== 'confirmed' && (
            <div className="rounded-lg border border-border bg-white p-3 shadow-sm">
              <img src={qrImage} alt="QR Code" className="size-48" />
            </div>
          )}
          {renderStatus()}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default QRLoginModal;
