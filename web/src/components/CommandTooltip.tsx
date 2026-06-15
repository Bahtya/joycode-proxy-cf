import type { ReactElement } from 'react';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';

interface CommandTooltipProps {
  command: string;
  label: string;
  children: ReactElement;
}

const CommandTooltip = ({ command, label, children }: CommandTooltipProps) => {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success('已复制');
    } catch {
      toast.error('复制失败');
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="left" align="center" className="w-72 max-w-[80vw] p-3">
        <div className="flex flex-col gap-2">
          <div className="text-xs text-muted-foreground">{label} 命令（点击复制）</div>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap break-all">
            {command}
          </pre>
          <Button variant="outline" size="sm" className="self-end" onClick={handleCopy}>
            <Copy className="size-3.5" />
            复制
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default CommandTooltip;
