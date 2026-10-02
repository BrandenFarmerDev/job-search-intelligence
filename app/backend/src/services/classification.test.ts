import { afterEach, expect, it, vi } from "vitest";
import { classify, decide, extractFields, redact, validateAi } from "./classification";
import { fixture } from "../test/fixtures";
afterEach(()=>vi.restoreAllMocks());
it.each([
 ["Application received","application_confirmation"],["Submitted my application","application_submitted"],["Phone screening call for position","screening"],
 ["Complete your assessment for job","assessment_requested"],["Assessment completed","assessment_completed"],["Schedule an interview","interview_requested"],
 ["Interview scheduled","interview_scheduled"],["Thank you for the interview","interview_completed"],["Job offer","offer"],["Unfortunately your application was not selected","rejection"],
 ["Position has been closed","position_closed"],["Withdrawing my application","withdrawal"],["Recruiter with a role opportunity","recruiter_outreach"],
 ["Following up on my application","follow_up_received"]
])("classifies explicit %s",(subject,type)=>expect(classify(subject,"")).toMatchObject({type,needsReview:false}));
it("quarantines contradictory and unknown messages and excludes unrelated mail",()=>{
 expect(classify("Dinner plans","").type).toBeNull();expect(classify("Job newsletter","").needsReview).toBe(true);
 expect(classify("Application received but unfortunately not selected","").needsReview).toBe(true);
 expect(classify("Following up on my application","",true).type).toBe("follow_up_sent");
 expect(extractFields("Position: Engineer; Company: ExampleCo\nReq: 42","")).toEqual({company:"ExampleCo",role:"Engineer",requisitionId:"42"});
 expect(extractFields("Hello","")).toEqual({company:"",role:"",requisitionId:""});
 expect(redact("owner@example.com +1 (555) 555-1212 https://example.com/private")).not.toMatch(/owner|555|example.com/);
});
it("validates model schema and always requires review",()=>{
 for(const value of [null,{},"text",{type:"fake",confidence:1},{type:"offer",confidence:NaN},{type:"offer",confidence:-1},{type:"offer",confidence:2}])expect(validateAi(value)).toBeNull();
 expect(validateAi({type:"offer",confidence:0.99})).toMatchObject({needsReview:true,type:"offer"});
});
it("caches decisions, honors hard daily caps, and fails safely on invalid model output",async()=>{
 const {env,db,close}=fixture();env.AI_ENABLED="true";env.AI_DAILY_CALL_LIMIT="2";
 vi.mocked(env.AI.run).mockResolvedValue({response:'{"type":"offer","confidence":0.9}'});
 expect(await decide(env,"a","Job update","owner@example.com")).toMatchObject({type:"offer",needsReview:true});
 await decide(env,"a","Job update","owner@example.com");expect(env.AI.run).toHaveBeenCalledTimes(1);
 vi.mocked(env.AI.run).mockRejectedValue(new Error("provider private details"));expect(await decide(env,"b","Job status","")).toMatchObject({type:"other_job_related"});
 await decide(env,"c","Another job","");expect(env.AI.run).toHaveBeenCalledTimes(2);
 expect(await db.prepare("SELECT calls FROM ai_usage").first()).toMatchObject({calls:2});
 env.AI_DAILY_CALL_LIMIT="101";await decide(env,"d","Job unknown","");expect(env.AI.run).toHaveBeenCalledTimes(2);close();
});
it("ignores invalid structured model output",async()=>{
 const {env,close}=fixture();env.AI_ENABLED="true";env.AI_DAILY_CALL_LIMIT="5";vi.mocked(env.AI.run).mockResolvedValue({response:{type:"wrong"}});
 expect((await decide(env,"a","Job notice","")).reason).toBe("Uncertain event");close();
});
