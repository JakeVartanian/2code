"use client"

import { useState, useCallback, useMemo } from "react"
import { useAtom } from "jotai"
import { compareDevicesAtomFamily, type CompareDevice } from "../atoms"
import { DEVICE_PRESETS } from "../constants"
import { cn } from "../../../lib/utils"
import { Logo } from "../../../components/ui/logo"
import { ChevronDown } from "lucide-react"

interface PreviewCompareViewProps {
  chatId: string
  previewUrl: string
  reloadKey: number
}

function DevicePresetDropdown({
  device,
  onChange,
}: {
  device: CompareDevice
  onChange: (device: CompareDevice) => void
}) {
  const [isOpen, setIsOpen] = useState(false)

  const matchedPreset = DEVICE_PRESETS.find(
    (p) => p.width === device.width && p.height === device.height,
  )

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className="font-medium">{matchedPreset?.name ?? device.name}</span>
        <span className="opacity-60">
          {device.width} x {device.height}
        </span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute top-full left-0 mt-1 z-20 bg-popover border rounded-md shadow-md py-1 min-w-[160px]">
            {DEVICE_PRESETS.filter((p) => p.name !== "Custom").map((preset) => (
              <button
                key={preset.name}
                onClick={() => {
                  onChange({
                    name: preset.name,
                    width: preset.width,
                    height: preset.height,
                  })
                  setIsOpen(false)
                }}
                className={cn(
                  "flex items-center justify-between w-full px-3 py-1.5 text-xs hover:bg-muted transition-colors",
                  matchedPreset?.name === preset.name && "bg-muted font-medium",
                )}
              >
                <span>{preset.name}</span>
                <span className="text-muted-foreground ml-3">
                  {preset.width}x{preset.height}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function CompareFrame({
  device,
  previewUrl,
  reloadKey,
  containerWidth,
  onDeviceChange,
}: {
  device: CompareDevice
  previewUrl: string
  reloadKey: number
  containerWidth: number
  onDeviceChange: (device: CompareDevice) => void
}) {
  const [isLoaded, setIsLoaded] = useState(false)

  // Calculate scale to fit the device width within the allocated container width
  // Leave some padding (16px each side)
  const availableWidth = containerWidth - 32
  const scale = Math.min(1, availableWidth / device.width)
  const scaledWidth = device.width * scale
  const scaledHeight = device.height * scale

  return (
    <div className="flex-1 flex flex-col items-center gap-1.5 min-w-0">
      {/* Device label */}
      <DevicePresetDropdown device={device} onChange={onDeviceChange} />

      {/* Frame */}
      <div
        className="relative overflow-hidden bg-background border rounded-lg shadow-sm"
        style={{
          width: `${scaledWidth}px`,
          height: `${scaledHeight}px`,
        }}
      >
        <div
          style={{
            width: `${device.width}px`,
            height: `${device.height}px`,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        >
          <iframe
            key={reloadKey}
            src={previewUrl}
            width="100%"
            height="100%"
            style={{ border: "none" }}
            title={`Preview - ${device.name}`}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            onLoad={() => setIsLoaded(true)}
            tabIndex={-1}
          />
        </div>

        {/* Loading overlay */}
        {!isLoaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-background z-10">
            <Logo className="w-5 h-5 animate-pulse" />
          </div>
        )}
      </div>
    </div>
  )
}

export function PreviewCompareView({
  chatId,
  previewUrl,
  reloadKey,
}: PreviewCompareViewProps) {
  const [devices, setDevices] = useAtom(compareDevicesAtomFamily(chatId))
  const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null)

  const containerWidth = useMemo(() => {
    if (!containerRef) return 400
    return containerRef.offsetWidth
  }, [containerRef])

  // Each frame gets half the container width
  const frameWidth = Math.floor(containerWidth / devices.length)

  const handleDeviceChange = useCallback(
    (index: number, device: CompareDevice) => {
      const next = [...devices]
      next[index] = device
      setDevices(next)
    },
    [devices, setDevices],
  )

  return (
    <div
      ref={setContainerRef}
      className="flex-1 flex items-start justify-center gap-4 overflow-auto p-4"
    >
      {devices.map((device, i) => (
        <CompareFrame
          key={i}
          device={device}
          previewUrl={previewUrl}
          reloadKey={reloadKey}
          containerWidth={frameWidth}
          onDeviceChange={(d) => handleDeviceChange(i, d)}
        />
      ))}
    </div>
  )
}
