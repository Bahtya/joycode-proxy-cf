import * as React from "react"

import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

interface StatisticCardProps {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  icon?: React.ReactNode
  className?: string
}

/**
 * Small presentational stat card: label / big value / optional sub text / optional icon.
 */
export function StatisticCard({
  label,
  value,
  sub,
  icon,
  className,
}: StatisticCardProps) {
  return (
    <Card className={cn("py-4", className)}>
      <CardContent className="flex flex-col gap-1 px-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{label}</span>
          {icon ? <span className="text-muted-foreground">{icon}</span> : null}
        </div>
        <div className="text-2xl font-semibold leading-tight tabular-nums">
          {value}
        </div>
        {sub != null ? (
          <div className="text-xs text-muted-foreground">{sub}</div>
        ) : null}
      </CardContent>
    </Card>
  )
}
