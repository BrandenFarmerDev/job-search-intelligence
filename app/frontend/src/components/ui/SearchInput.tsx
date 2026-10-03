import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Field } from "./Field";
import { CloseIcon, SearchIcon } from "./icons";

export interface SearchInputProps { label: string; value: string; onChange: (value: string) => void; placeholder?: string; delay?: number; help?: string }

// `value` is the committed query; typing updates the field at once and notifies the parent after `delay` ms.
export function SearchInput({ label, value, onChange, placeholder, delay = 300, help }: SearchInputProps) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  const [emitted, setEmitted] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // An external change (not an echo of what this field emitted) replaces whatever is typed.
  if (value !== seen) { setSeen(value); if (value !== emitted) { setDraft(value); setEmitted(value); } }
  useEffect(() => () => clearTimeout(timer.current), []);
  // An external reset must not be overwritten by a notification typed before it.
  useEffect(() => { clearTimeout(timer.current); }, [emitted]);
  function emit(next: string) { clearTimeout(timer.current); setEmitted(next); onChange(next); }
  function change(next: string) { setDraft(next); clearTimeout(timer.current); timer.current = setTimeout(() => emit(next), delay); }
  function clear() { setDraft(""); emit(""); }
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" && draft) { event.preventDefault(); clear(); }
    else if (event.key === "Enter") emit(draft);
  }
  return <Field label={label} help={help}>{(control) => <div className="qe-search">
    <SearchIcon className="qe-search-icon" />
    <input {...control} className="qe-input" type="search" value={draft} placeholder={placeholder} autoComplete="off" onChange={(event) => change(event.target.value)} onKeyDown={keyDown} />
    {draft && <button type="button" className="qe-search-clear" aria-label="Clear search" onClick={clear}><CloseIcon /></button>}
  </div>}</Field>;
}
