import { humanize } from "./ui";
import { statusGroups } from "../lib/applications";

// Event types grouped by stage; a leading placeholder option is the caller's responsibility.
export function StatusOptions() {
  return <>{statusGroups.map((group) => <optgroup key={group.label} label={group.label}>
    {group.types.map((type) => <option key={type} value={type}>{humanize(type)}</option>)}
  </optgroup>)}</>;
}
