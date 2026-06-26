import { useEffect, useState, useRef, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  RefreshCw,
  CheckCircle2,
  XCircle,
  ExternalLink,
  AlertTriangle,
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
}

type Status = 'loading' | 'waiting' | 'confirmed' | 'expired' | 'error';

const QRLoginModal = ({ open, onClose, onSuccess }: QRLoginModalProps) => {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<Status>('loading');
  const [countdown, setCountdown] = useState(300);
  const [errorMsg, setErrorMsg] = useState('');
  const [pollTrigger, setPollTrigger] = useState(0);
  const sessionIdRef = useRef('');
  const pollTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onSuccessRef = useRef(onSuccess);
  const onCloseRef = useRef(onClose);

  onSuccessRef.current = onSuccess;
  onCloseRef.current = onClose;

  const initQR = useCallback(async () => {
    setStatus('loading');
    setCountdown(300);
    setErrorMsg('');
    try {
      const result = await api.qrLoginInit();
      setUrl(result.url);
      sessionIdRef.current = result.session_id;
      setStatus('waiting');
      setPollTrigger((c) => c + 1);
    } catch (e: unknown) {
      setStatus('error');
      const msg = e instanceof Error ? e.message : '生成登录会话失败';
      setErrorMsg(msg);
      toast.error(msg);
    }
  }, []);

  useEffect(() => {
    if (open) {
      initQR();
    } else {
      setUrl('');
      sessionIdRef.current = '';
      setStatus('loading');
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    }
  }, [open, initQR]);

  useEffect(() => {
    if (!open) return;
    if (status !== 'waiting') return;

    const poll = async () => {
      const sid = sessionIdRef.current;
      if (!sid) {
        pollTimerRef.current = setTimeout(poll, 1000);
        return;
      }
      try {
        const result = await api.qrLoginStatus(sid);
        if (result.status === 'success') {
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
        if (result.status === 'error') {
          setStatus('error');
          const m = result.message || '登录失败';
          setErrorMsg(m);
          toast.error(m);
          return;
        }
        // 'waiting' — keep polling.
      } catch {
        // Continue polling on network error.
      }
      pollTimerRef.current = setTimeout(poll, 3000);
    };

    pollTimerRef.current = setTimeout(poll, 2000);
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [open, pollTrigger, status]);

  useEffect(() => {
    if (!open || status === 'confirmed' || status === 'expired' || status === 'loading' || status === 'error') return;
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

  const fmtCountdown = `${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, '0')}`;

  const renderStatus = () => {
    switch (status) {
      case 'loading':
        return (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <Loader2 className="size-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">正在生成登录链接...</p>
          </div>
        );

      case 'waiting':
        return (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-3 text-sm">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="flex flex-col gap-1">
                <span>用京东 App 扫描上方二维码，或点下方按钮在浏览器登录</span>
                <span className="text-muted-foreground">{`登录链接有效期剩余 ${fmtCountdown}`}</span>
              </div>
            </div>
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
              登录链接已过期
            </div>
            <Button variant="outline" size="sm" onClick={initQR}>
              <RefreshCw className="size-4" />
              刷新链接
            </Button>
          </div>
        );

      case 'error':
        return (
          <div className="flex flex-col items-center gap-3">
            <div className="flex w-full items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <span className="font-medium text-destructive">{errorMsg || '登录失败'}</span>
            </div>
            <Button variant="outline" size="sm" onClick={initQR}>
              <RefreshCw className="size-4" />
              重试
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
            使用京东 App 扫描二维码，或在浏览器打开链接完成授权。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4">
          {url && status !== 'confirmed' && (
            <div className="flex flex-col items-center gap-2">
              <div className="rounded-lg border border-border bg-white p-3 shadow-sm">
                <QRCodeSVG value={url} size={192} />
              </div>
              {url && (
                <Button variant="ghost" size="sm" asChild className="text-xs">
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="size-3.5" />
                    在浏览器打开链接
                  </a>
                </Button>
              )}
            </div>
          )}
          {renderStatus()}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default QRLoginModal;
