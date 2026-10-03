import { expect, it } from "vitest";
import { applicationSorts, eventTypes, isEventType } from "./intelligence";
it("recognizes only the complete event taxonomy",()=>{
 expect(eventTypes).toHaveLength(16);for(const type of eventTypes)expect(isEventType(type)).toBe(true);
 for(const value of [null,1,{},"unknown"])expect(isEventType(value)).toBe(false);
});
it("declares the allowlisted application sort keys",()=>expect(applicationSorts).toEqual(["applied_desc","applied_asc","company","status","updated"]));
