import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { authorize, base64url, boundedText, decrypt, digest, encrypt, providerJson, randomToken, readJson, safeLink, text } from "./security";
import { fixture } from "../test/fixtures";
afterEach(()=>vi.unstubAllGlobals());
describe("private boundary security",()=>{
  it("verifies signed owner tokens and rejects wrong owner/audience/issuer/expiry/algorithm",async()=>{
    const {env,close}=fixture();const {publicKey,privateKey}=await generateKeyPair("RS256");const jwk=await exportJWK(publicKey);jwk.kid="owner";
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({keys:[jwk]})));
    const token=async(overrides:Record<string,unknown>={})=>new SignJWT({email:env.OWNER_EMAIL,...overrides}).setSubject("owner-id").setIssuedAt().setExpirationTime("1h").setAudience(env.ACCESS_AUD).setIssuer(`https://${env.ACCESS_TEAM_DOMAIN}`).setProtectedHeader({alg:"RS256",kid:"owner"}).sign(privateKey);
    const request=(value:string)=>new Request("https://api.example.com",{headers:{"Cf-Access-Jwt-Assertion":value}});
    expect(await authorize(request(await token()),env)).toEqual({kind:"owner",id:"owner-id"});
    await expect(authorize(request(await token({email:"attacker@example.com"})),env)).rejects.toMatchObject({status:401});
    for(const bad of ["invalid",await new SignJWT({email:env.OWNER_EMAIL}).setSubject("x").setExpirationTime(1).setAudience("wrong").setIssuer("wrong").setProtectedHeader({alg:"RS256",kid:"owner"}).sign(privateKey)])await expect(authorize(request(bad),env)).rejects.toMatchObject({status:401});
    await expect(authorize(new Request("https://api.example.com"),env)).rejects.toMatchObject({status:401});
    await expect(authorize(request("x"),{...env,ACCESS_AUD:""})).rejects.toMatchObject({status:401});
    await expect(authorize(request("x"),{...env,ACCESS_TEAM_DOMAIN:"evil.example"})).rejects.toMatchObject({status:503});close();
  });
  it("accepts Access service tokens only for the configured automation client",async()=>{
    const {env:base,close}=fixture();const env={...base,ACCESS_TEAM_DOMAIN:"automation-test.cloudflareaccess.com"};// the JWKS cache is keyed by issuer
    const {publicKey,privateKey}=await generateKeyPair("RS256");const jwk=await exportJWK(publicKey);jwk.kid="k";
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({keys:[jwk]})));
    const sign=(claims:Record<string,unknown>,sub="")=>new SignJWT(claims).setSubject(sub).setIssuedAt().setExpirationTime("1h").setAudience(env.ACCESS_AUD).setIssuer(`https://${env.ACCESS_TEAM_DOMAIN}`).setProtectedHeader({alg:"RS256",kid:"k"}).sign(privateKey);
    const run=async(claims:Record<string,unknown>,sub?:string,configured="client-id")=>authorize(new Request("https://api.example.com",{headers:{"Cf-Access-Jwt-Assertion":await sign(claims,sub)}}),{...env,AUTOMATION_CLIENT_ID:configured});
    const service={common_name:"client-id",type:"app"};
    expect(await run(service)).toEqual({kind:"automation",id:"automation"});
    const rejected=[()=>run({...service,common_name:"other"}),()=>run(service,undefined,""),()=>run({...service,email:"anyone@example.com"}),()=>run({...service,email:env.OWNER_EMAIL}),()=>run(service,"user-id"),()=>run({...service,type:"user"}),()=>run({common_name:"client-id"}),()=>run({email:env.OWNER_EMAIL}),()=>run({email:"other@example.com"},"user-id"),()=>run({email:env.OWNER_EMAIL,common_name:"client-id"},"")];
    for(const attempt of rejected)await expect(attempt()).rejects.toMatchObject({status:401,code:"authentication_required"});
    await expect(authorize(new Request("https://api.example.com",{headers:{"Cf-Access-Jwt-Assertion":await sign(service)}}),env)).rejects.toMatchObject({status:401});close();
  });
  it("encrypts authenticated envelopes with a unique IV and context binding",async()=>{
    const {env,close}=fixture();const a=await encrypt("refresh-token",env.TOKEN_ENCRYPTION_KEY,"account:a");const b=await encrypt("refresh-token",env.TOKEN_ENCRYPTION_KEY,"account:a");
    expect(a).not.toContain("refresh-token");expect(a).not.toBe(b);expect(await decrypt(a,env.TOKEN_ENCRYPTION_KEY,"account:a")).toBe("refresh-token");
    await expect(decrypt(a,env.TOKEN_ENCRYPTION_KEY,"account:b")).rejects.toThrow();await expect(encrypt("x",btoa("short"),"x")).rejects.toMatchObject({status:503});close();
  });
  it("bounds streams and validates JSON content type and object shape",async()=>{
    expect(await boundedText(new Response(null))).toBe("");expect(await boundedText(new Response("hello"),5)).toBe("hello");await expect(boundedText(new Response("123456"),5)).rejects.toMatchObject({status:413});
    const request=(body:string,type="application/json")=>new Request("https://api.example",{method:"POST",body,headers:{"Content-Type":type}});
    expect(await readJson(request('{"hello":1}'))).toEqual({hello:1});
    for(const body of ["null","[]","bad","1"])await expect(readJson(request(body))).rejects.toMatchObject({status:400});
    await expect(readJson(request(" ".repeat(17000)))).rejects.toMatchObject({status:413,code:"payload_too_large"});
    await expect(readJson(request("{}","text/plain"))).rejects.toMatchObject({status:415});
  });
  it("rejects provider errors without storing provider body and enforces timeout/redirect behavior",async()=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json({value:1}));vi.stubGlobal("fetch",fetcher);expect(await providerJson("https://graph.microsoft.com/x")).toEqual({value:1});
    expect(fetcher.mock.calls[0][1]).toMatchObject({redirect:"manual",signal:expect.any(AbortSignal)});
    for(const [status,code] of [[302,"provider_request_failed"],[410,"provider_request_failed"],[429,"provider_rate_limited"],[503,"provider_request_failed"]] as const){fetcher.mockResolvedValue(new Response("private provider details",{status}));await expect(providerJson("https://provider.example")).rejects.toMatchObject({code});}
  });
  it("normalizes only safe links and handles bounded text and digests",async()=>{
    expect(await digest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(randomToken()).toMatch(/^[\w-]{43}$/);expect(base64url(new Uint8Array([255,254]))).toBe("__4");expect(text(1)).toBe("");expect(text(" hello ",3)).toBe("hel");
    for(const url of ["javascript:alert(1)","http://example.com","https://x:y@example.com","bad"])expect(safeLink(url)).toBe("");
    expect(safeLink("https://outlook.live.com/mail/0/id/1",true)).toContain("outlook.live.com");expect(safeLink("https://evil.example",true)).toBe("");expect(safeLink("https://jobs.example")).toBe("https://jobs.example/");
  });
});
