import { afterEach, expect, it, vi } from "vitest";
import { bodyText, graphBody } from "./microsoft";
afterEach(()=>vi.restoreAllMocks());
it("parses bounded HTML as text, discarding script/style/template content without executing or fetching it",()=>{
 const html='<SCRIPT type="text/javascript">stealSecret()</SCRIPT><style>hidden()</style><template><div>private template</div></template><p>Company: <b>Synthetic &amp; Co</b></p><div>Role: Engineer</div><img src="https://evil.example/tracker"><p>Req: QA-1</p>';
 expect(bodyText(html,"HTML")).toBe("Company: Synthetic & Co\n\nRole: Engineer\n\nReq: QA-1");expect(bodyText(" x ","text")).toBe("x");expect(bodyText("x".repeat(10000),"text")).toHaveLength(6000);expect(bodyText("<p>"+"x".repeat(10000)+"</p>","html").length).toBeLessThanOrEqual(6000);
});
it("fetches only one encoded immutable message body with read-only preferences and validates it",async()=>{
 vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(Response.json({body:{content:"Company: SyntheticCo",contentType:"text"}})).mockResolvedValueOnce(Response.json({body:{content:123}}));
 expect(await graphBody("id/with?query","test-token")).toBe("Company: SyntheticCo");
 expect(fetch).toHaveBeenCalledWith("https://graph.microsoft.com/v1.0/me/messages/id%2Fwith%3Fquery?$select=body",expect.objectContaining({headers:expect.objectContaining({Prefer:'IdType="ImmutableId", outlook.body-content-type="text"'})}));
 await expect(graphBody("id","test-token")).rejects.toMatchObject({code:"invalid_message_body"});
});
