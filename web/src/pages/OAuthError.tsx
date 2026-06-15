import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { CircleX, LogIn, Home } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const OAuthErrorPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const error = searchParams.get("error") || "未知错误";

  return (
    <div className="min-h-screen grid place-items-center bg-gradient-to-br from-[#00b578] to-[#009a63] p-4">
      <Card className="w-full max-w-lg mx-4">
        <CardContent className="pt-0">
          <div className="text-center">
            <CircleX className="size-16 mx-auto text-destructive mb-4" />
            <h3 className="text-xl font-semibold tracking-tight">OAuth 授权失败</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              授权过程中发生错误，账号未能添加成功。
            </p>
          </div>

          <div className="mt-5 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-left">
            <p className="break-all text-[13px] text-destructive">{error}</p>
          </div>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <Button variant="outline" onClick={() => navigate("/accounts")}>
              <LogIn />
              返回账号管理
            </Button>
            <Button asChild>
              <Link to="/login">
                <Home />
                返回首页
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default OAuthErrorPage;
