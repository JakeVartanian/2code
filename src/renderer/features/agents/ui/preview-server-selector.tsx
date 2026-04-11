import { useState, useCallback } from "react"
import { Button } from "../../../components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../components/ui/popover"
import { cn } from "../../../lib/utils"

interface DetectedServer {
  port: number
  url: string
  framework: string | null
  status: string
}

interface PreviewServerSelectorProps {
  servers: DetectedServer[]
  selectedUrl: string | null
  onSelect: (url: string, port: number) => void
  className?: string
}

export function PreviewServerSelector({
  servers,
  selectedUrl,
  onSelect,
  className,
}: PreviewServerSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [manualPort, setManualPort] = useState("")

  const selectedServer = servers.find((s) => s.url === selectedUrl)
  const displayPort = selectedServer?.port ?? (selectedUrl ? new URL(selectedUrl).port : null)

  const handleManualPortSubmit = useCallback(() => {
    const port = parseInt(manualPort, 10)
    if (port >= 1 && port <= 65535) {
      onSelect(`http://localhost:${port}`, port)
      setManualPort("")
      setIsOpen(false)
    }
  }, [manualPort, onSelect])

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            "h-7 px-2 gap-1.5 rounded-md text-xs font-mono hover:bg-muted transition-[background-color,transform] duration-150 ease-out active:scale-[0.97]",
            className,
          )}
        >
          <span
            className={cn(
              "w-1.5 h-1.5 rounded-full flex-shrink-0",
              servers.length > 0 ? "bg-emerald-500" : "bg-muted-foreground/40",
            )}
          />
          <span className="text-muted-foreground">
            {displayPort ?? "—"}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        className="w-56 p-1"
      >
        {servers.length > 0 ? (
          <div className="space-y-0.5">
            {servers.map((server) => (
              <button
                key={server.port}
                onClick={() => {
                  onSelect(server.url, server.port)
                  setIsOpen(false)
                }}
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-md transition-colors",
                  server.url === selectedUrl
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-muted",
                )}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                <span className="font-mono">{server.port}</span>
                {server.framework && (
                  <span className="text-muted-foreground ml-auto capitalize">
                    {server.framework}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No servers detected
          </div>
        )}

        <div className="border-t mt-1 pt-1">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              handleManualPortSubmit()
            }}
            className="flex items-center gap-1 px-1"
          >
            <input
              type="number"
              min={1}
              max={65535}
              placeholder="Port..."
              value={manualPort}
              onChange={(e) => setManualPort(e.target.value)}
              className="flex-1 h-7 px-2 text-xs bg-transparent border rounded-md outline-none focus:ring-1 focus:ring-ring font-mono"
            />
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={!manualPort || parseInt(manualPort, 10) < 1}
            >
              Go
            </Button>
          </form>
        </div>
      </PopoverContent>
    </Popover>
  )
}
