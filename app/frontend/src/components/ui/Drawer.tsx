import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { Button } from "./Button";
import { CloseIcon } from "./icons";

export interface DrawerProps {
  open: boolean; title: string; onClose: () => void; children: ReactNode;
  /** Receives focus on close when the element that opened the drawer is no longer in the page. */
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}

// Native <dialog> provides the modal focus trap, inert background and Escape handling.
export function Drawer({ open, title, onClose, children, fallbackFocusRef }: DrawerProps) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    const node = dialog.current;
    if (open && node && !node.open) { opener.current = document.activeElement; node.showModal(); }
    else if (!open && node?.open) node.close();
  }, [open]);
  function closed() {
    const from = opener.current;
    // A deep link opens with the body focused, which is not a meaningful place to return to.
    const target = from instanceof HTMLElement && from !== document.body && from.isConnected ? from : fallbackFocusRef?.current;
    opener.current = null; target?.focus(); if (open) onClose();
  }
  return <dialog ref={dialog} className="qe-drawer" aria-labelledby={titleId} onClose={closed}>
    {open && <>
      <header className="qe-drawer-header">
        <h2 className="qe-drawer-title" id={titleId}>{title}</h2>
        <Button variant="quiet" size="compact" onClick={() => dialog.current?.close()}><CloseIcon />Close</Button>
      </header>
      <div className="qe-drawer-body">{children}</div>
    </>}
  </dialog>;
}
