export interface SkeletonProps { variant?: "text" | "block"; width?: "short" | "medium" | "full"; lines?: number }

// Decorative placeholder; put aria-busy on the region that is loading.
export function Skeleton({ variant = "text", width = "full", lines = 1 }: SkeletonProps) {
  const bar = (key: number, size: SkeletonProps["width"]) => <div key={key} className="qe-skeleton" data-variant={variant} data-width={size} />;
  return lines > 1
    ? <div className="qe-stack" data-gap="2" aria-hidden="true">{Array.from({ length: lines }, (_, index) => bar(index, index === lines - 1 ? "medium" : width))}</div>
    : <div aria-hidden="true">{bar(0, width)}</div>;
}
