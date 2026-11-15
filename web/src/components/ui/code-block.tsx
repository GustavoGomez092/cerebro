// prompt-kit's code-block, without shiki: the registry version highlights with shiki and injects its HTML through
// dangerouslySetInnerHTML, and pulls several MB of grammars into the bundle. Cerebro's answers only need plain,
// escaped code, rendered by React.
import { cn } from "@/lib/utils"
import React from "react"

export type CodeBlockProps = {
  children?: React.ReactNode
  className?: string
} & React.HTMLProps<HTMLDivElement>

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  return (
    <div
      className={cn(
        "not-prose flex w-full flex-col overflow-clip border",
        "border-border bg-card text-card-foreground rounded-xl",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export type CodeBlockCodeProps = {
  code: string
  language?: string
  className?: string
} & React.HTMLProps<HTMLDivElement>

function CodeBlockCode({
  code,
  language = "plaintext",
  className,
  ...props
}: CodeBlockCodeProps) {
  return (
    <div
      className={cn("w-full overflow-x-auto text-[13px]", className)}
      data-language={language}
      {...props}
    >
      <pre className="m-0 px-4 py-3 font-mono">
        <code>{(code ?? "").replace(/\n$/, "")}</code>
      </pre>
    </div>
  )
}

export type CodeBlockGroupProps = React.HTMLAttributes<HTMLDivElement>

function CodeBlockGroup({
  children,
  className,
  ...props
}: CodeBlockGroupProps) {
  return (
    <div
      className={cn("flex items-center justify-between", className)}
      {...props}
    >
      {children}
    </div>
  )
}

export { CodeBlockGroup, CodeBlockCode, CodeBlock }
