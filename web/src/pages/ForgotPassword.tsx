import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Info, TriangleAlert } from "lucide-react";

import { authApi } from "@/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const ForgotPasswordPage = () => {
  const [exePath, setExePath] = useState("./joycode_proxy_bin");

  useEffect(() => {
    authApi
      .status()
      .then((res) => {
        if (res.exe_path) {
          setExePath(res.exe_path);
        }
      })
      .catch(() => {});
  }, []);

  return (
    <div className="min-h-screen grid place-items-center bg-gradient-to-br from-[#00b578] to-[#009a63] p-4">
      <Card className="w-full max-w-2xl mx-4">
        <CardContent className="pt-0">
          <h3 className="text-xl font-semibold tracking-tight mb-2">忘记密码</h3>
          <p className="text-sm text-muted-foreground mb-6">
            Dashboard 的 root 密码需要通过服务器命令行重置。
          </p>

          <div className="flex items-start gap-2 mb-2 rounded-md bg-primary/10 p-3 text-sm">
            <Info className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>在服务器终端执行以下命令</span>
          </div>

          <p className="font-semibold mt-5 mb-2">交互式重置（会提示你输入新密码）：</p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
            <code>{`$ ${exePath} reset-password`}</code>
          </pre>

          <p className="font-semibold mt-5 mb-2">直接指定新密码：</p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
            <code>{`$ ${exePath} reset-password -p 你的新密码`}</code>
          </pre>

          <div className="flex items-start gap-2 mt-6 rounded-md bg-yellow-500/10 p-3 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-yellow-600 dark:text-yellow-500" />
            <span>
              密码至少 <strong>6 位</strong>，以 bcrypt 哈希加密存储在 SQLite 数据库中。
              重置后所有已登录的会话需要重新登录。
            </span>
          </div>

          <div className="mt-6">
            <Button asChild variant="outline">
              <Link to="/login">
                <ArrowLeft />
                返回登录
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default ForgotPasswordPage;
