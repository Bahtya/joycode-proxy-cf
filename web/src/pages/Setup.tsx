import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Lock, Loader2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

import { authApi, setToken } from "@/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

const getPasswordStrength = (pw: string): number => {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 6) score += 25;
  if (pw.length >= 10) score += 25;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score += 25;
  if (/[0-9]/.test(pw) && /[^a-zA-Z0-9]/.test(pw)) score += 25;
  return score;
};

const setupSchema = z
  .object({
    password: z.string().min(6, "密码长度不能少于 6 位"),
    confirm: z.string().min(1, "请确认密码"),
  })
  .refine((data) => data.password === data.confirm, {
    message: "两次输入的密码不一致",
    path: ["confirm"],
  });

type SetupValues = z.infer<typeof setupSchema>;

const SetupPage = () => {
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const form = useForm<SetupValues>({
    resolver: zodResolver(setupSchema),
    defaultValues: { password: "", confirm: "" },
  });

  const password = form.watch("password");
  const strength = getPasswordStrength(password);
  const strengthColor =
    strength <= 25
      ? "bg-red-500"
      : strength <= 50
        ? "bg-yellow-500"
        : strength <= 75
          ? "bg-green-500"
          : "bg-[#00b578]";
  const strengthLabel =
    strength <= 25 ? "弱" : strength <= 50 ? "中" : strength <= 75 ? "强" : "很强";

  const onSubmit = async (values: SetupValues) => {
    setLoading(true);
    try {
      const result = await authApi.setup(values.password);
      setToken(result.token);
      toast.success("密码设置成功");
      navigate("/dashboard");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "设置失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen grid place-items-center bg-gradient-to-br from-[#00b578] to-[#009a63] p-4">
      <Card className="w-full max-w-md">
        <CardContent className="pt-0">
          <div className="text-center mb-6">
            <CheckCircle2 className="size-10 mx-auto text-[#00b578] mb-2" />
            <h3 className="text-xl font-semibold tracking-tight mb-1">
              初始化 JoyCode 代理
            </h3>
            <p className="text-sm text-muted-foreground">
              首次使用，请设置 root 管理员密码
            </p>
          </div>

          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-4"
              autoComplete="off"
            >
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>密码</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          type="password"
                          className="pl-9"
                          placeholder="设置密码（至少 6 位）"
                          autoFocus
                          autoComplete="new-password"
                          {...field}
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {password && (
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full transition-all ${strengthColor}`}
                      style={{ width: `${strength}%` }}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {strengthLabel}
                  </span>
                </div>
              )}

              <FormField
                control={form.control}
                name="confirm"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>确认密码</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          type="password"
                          className="pl-9"
                          placeholder="确认密码"
                          autoComplete="new-password"
                          {...field}
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button type="submit" className="w-full h-11" disabled={loading}>
                {loading && <Loader2 className="size-4 animate-spin" />}
                设置密码并登录
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
};

export default SetupPage;
