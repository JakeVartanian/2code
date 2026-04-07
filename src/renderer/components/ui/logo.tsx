import * as React from "react"
import { cn } from "../../lib/utils"
import logoImage from "../../assets/logo.png"

interface LogoProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  className?: string
  fill?: string
}

export function Logo({ fill, className, ...props }: LogoProps) {
  return (
    <img
      src={logoImage}
      alt="2Code logo"
      className={cn("w-full h-full object-contain", className)}
      draggable={false}
      {...props}
    />
  )
}
