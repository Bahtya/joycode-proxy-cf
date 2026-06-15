import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface CopyableTextProps {
  value: string;
  className?: string;
}

export function CopyableText({ value, className }: CopyableTextProps) {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('已复制');
    } catch {
      toast.error('复制失败');
    }
  };

  return (
    <span className="inline-flex items-center gap-1">
      <code
        title={value}
        className={cn(
          'max-w-[12rem] truncate font-mono text-xs text-muted-foreground',
          className,
        )}
      >
        {value}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={handleCopy}
        aria-label="复制"
      >
        <Copy />
      </Button>
    </span>
  );
}

export default CopyableText;
