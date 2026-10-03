import type { ReactNode, SVGProps } from "react";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: "lg" | "xl" };
const icon = (paths: ReactNode) => function Icon({ size, ...rest }: IconProps) {
  return <svg className="qe-icon" data-size={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>{paths}</svg>;
};

export const SearchIcon = icon(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>);
export const CloseIcon = icon(<path d="M6 6l12 12M18 6 6 18" />);
export const ChevronLeftIcon = icon(<path d="m15 18-6-6 6-6" />);
export const ChevronRightIcon = icon(<path d="m9 18 6-6-6-6" />);
export const ArrowUpIcon = icon(<path d="M12 19V5m-6 6 6-6 6 6" />);
export const ArrowDownIcon = icon(<path d="M12 5v14m-6-6 6 6 6-6" />);
export const SortIcon = icon(<path d="m8 9 4-4 4 4M8 15l4 4 4-4" />);
export const InfoIcon = icon(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8.5v.01" /></>);
export const CheckCircleIcon = icon(<><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.8 2.8L16 9.5" /></>);
export const AlertTriangleIcon = icon(<><path d="M12 4 3 20h18L12 4Z" /><path d="M12 10v4.5m0 2.5v.01" /></>);
export const AlertCircleIcon = icon(<><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5m0 3v.01" /></>);
export const MinusCircleIcon = icon(<><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></>);
export const InboxIcon = icon(<path d="M4 13V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7m-16 0v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5m-16 0h4l1.5 2.5h5L16 13h4" />);
export const FilterIcon = icon(<path d="M4 5h16l-6 7.5V19l-4-2v-4.5L4 5Z" />);
export const MenuIcon = icon(<path d="M4 7h16M4 12h16M4 17h16" />);
export const SunIcon = icon(<><circle cx="12" cy="12" r="4" /><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4m0-12.8L17 7M7 17l-1.4 1.4" /></>);
export const MoonIcon = icon(<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />);
export const MonitorIcon = icon(<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8m-4-4v4" /></>);
export const ExternalLinkIcon = icon(<path d="M14 4h6v6m0-6-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />);
