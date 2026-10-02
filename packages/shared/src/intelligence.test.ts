import { expect, it } from "vitest";
import { eventTypes, isEventType } from "./intelligence";
it("recognizes only the complete event taxonomy",()=>{
 expect(eventTypes).toHaveLength(16);for(const type of eventTypes)expect(isEventType(type)).toBe(true);
 for(const value of [null,1,{},"unknown"])expect(isEventType(value)).toBe(false);
});
