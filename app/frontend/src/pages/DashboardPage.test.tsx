import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import axe from "axe-core";
import { DashboardPage } from "./DashboardPage";
import { intelligenceApi } from "../lib/api";
import type { ApplicationRecord, Dashboard } from "@job-search/shared";
vi.mock("../lib/api",async(importOriginal)=>({...await importOriginal<typeof import("../lib/api")>(),intelligenceApi:vi.fn()}));
const app:ApplicationRecord={id:"app1",company:"ExampleCo",role:"Engineer",requisition_id:"req1",application_url:null,applied_at:"2026-09-30",status:"application_submitted",source:"sheet",reconciliation:"sheet_only",excluded:0,updated_at:"2026-09-30"};
let view:Dashboard;
let review:unknown[];
beforeEach(()=>{
 view={applications:[app],total:1,metrics:{total:1,responsesRate:0.5},groups:{status:{submitted:1},source:{sheet:1},month:{"2026-09":1},company:{ExampleCo:1},role:{Engineer:1},reconciliation:{sheet_only:1},responseDays:{}},connections:{microsoft:true,localOutlook:false,sheets:true},runs:[1,2,3].map(id=>({id:String(id),status:"failed",started_at:"2026-10-01",finished_at:null,error_code:"provider_request_failed",counters:"{}"}))};
 review=[{id:"review1",source:"email",source_id:"source1",state:"needs_review",reason:"Ambiguous",subject:"Recruiter update",available:0}];
 vi.mocked(intelligenceApi).mockImplementation(async(path)=>{
  if(path==="/dashboard")return view;
  if(path==="/review")return review;
  if(path.startsWith("/applications?"))return {applications:[app,{...app,id:"app2",company:"AnotherCo"}],hasMore:!path.includes("page=1")};
  if(path==="/applications/app1")return {application:app,events:[{id:"event1",type:"application_confirmation",occurred_at:"2026-09-30",source:"email",web_link:"https://outlook.live.com/id/1",available:0,subject:"Evidence subject"},{id:"event2",type:"screening",occurred_at:"2026-10-01",source:"sheet",web_link:null,available:1,subject:null}],overrides:[{field:"status",created_at:"2026-10-01"}]};
  if(path==="/local-outlook/import")return {imported:1};
  return {saved:true};
 });
});
afterEach(()=>vi.resetAllMocks());
it("renders private analytics, source controls, review alerts, safe evidence and accessible forms",async()=>{
 const {container}=render(<DashboardPage/>);expect(screen.getByText("Loading private dashboard…")).toBeInTheDocument();await screen.findByRole("button",{name:"View ExampleCo"});
 expect(screen.getByText("50%")).toBeInTheDocument();expect(screen.getByRole("link",{name:"Export CSV"})).toHaveAttribute("href","/api/job-intelligence/export");expect(screen.getByRole("alert")).toHaveTextContent("last three syncs failed");
 await userEvent.click(screen.getByRole("button",{name:"View ExampleCo"}));expect(await screen.findByText("Evidence subject")).toBeInTheDocument();expect(screen.getByRole("link",{name:"Open Outlook evidence"})).toHaveAttribute("rel","noreferrer");
 expect((await axe.run(container,{rules:{"color-contrast":{enabled:false}}})).violations).toEqual([]);await userEvent.click(screen.getByRole("button",{name:"Close timeline"}));expect(screen.queryByText("Evidence subject")).not.toBeInTheDocument();
});
it("searches, filters, sorts, paginates and refreshes",async()=>{
 render(<DashboardPage/>);await screen.findByRole("button",{name:"View ExampleCo"});await userEvent.type(screen.getByLabelText("Search company or role"),"Co");await userEvent.selectOptions(screen.getAllByLabelText("Status",{selector:"select"})[0],"offer");await userEvent.selectOptions(screen.getByLabelText("Sort"),"company");
 await userEvent.click(screen.getByRole("button",{name:"Next"}));expect(await screen.findByText("Page 2")).toBeInTheDocument();await userEvent.click(screen.getByRole("button",{name:"Previous"}));await userEvent.click(screen.getByRole("button",{name:"Refresh"}));expect(intelligenceApi).toHaveBeenCalledWith(expect.stringContaining("sort=company"),"GET",undefined,expect.any(AbortSignal));
 await userEvent.selectOptions(screen.getByLabelText("Source"),"sheet");await userEvent.selectOptions(screen.getByLabelText("Reconciliation"),"sheet_only");fireEvent.change(screen.getByLabelText("Applied from"),{target:{value:"2026-09-30"}});fireEvent.change(screen.getByLabelText("Applied through"),{target:{value:"2026-10-01"}});
 await waitFor(()=>expect(intelligenceApi).toHaveBeenCalledWith(expect.stringContaining("source=sheet&reconciliation=sheet_only&from=2026-09-30&to=2026-10-01"),"GET",undefined,expect.any(AbortSignal)));
});
it("queues sync and changes provider connection states",async()=>{
 render(<DashboardPage/>);await screen.findByRole("button",{name:"View ExampleCo"});
 for(const name of ["Run sync","Pause tracker","Reprocess retained evidence"]){await userEvent.click(screen.getByRole("button",{name}));await waitFor(()=>expect(screen.getByRole("button",{name})).toBeEnabled());}
 expect(intelligenceApi).toHaveBeenCalledWith("/sync/run","POST",undefined);expect(screen.queryByRole("button",{name:/Outlook API/})).not.toBeInTheDocument();
});
it("imports a bounded local Outlook export in chunks and queues classification",async()=>{
 view.connections.microsoft=false;render(<DashboardPage/>);await screen.findByRole("button",{name:"View ExampleCo"});const message={immutableId:"a".repeat(64),folder:"inbox",subject:"Application",sender:"jobs@example.com",excerpt:"Thanks",occurredAt:"2026-10-01T00:00:00Z",conversationId:"c",internetMessageId:"m",revision:"r"};
 const file=new File([JSON.stringify({format:"job-search-intelligence.outlook-com.v1",accountId:"b".repeat(64),exportedAt:"2026-10-01T01:00:00Z",since:"2026-09-30T07:00:00Z",summary:{truncated:false},messages:Array(41).fill(message)})],"outlook.json",{type:"application/json"});
 await userEvent.upload(screen.getByLabelText("Import local Outlook JSON"),file);expect(await screen.findByText(/Imported 2 local Outlook messages/)).toBeInTheDocument();
 expect(vi.mocked(intelligenceApi).mock.calls.filter(call=>call[0]==="/local-outlook/import")).toHaveLength(2);expect(intelligenceApi).toHaveBeenCalledWith("/sync/run","POST");
});
it("blocks incomplete Outlook exports before uploading private data",async()=>{
 view.connections.microsoft=false;render(<DashboardPage/>);await screen.findByRole("button",{name:"View ExampleCo"});
 const file=new File([JSON.stringify({format:"job-search-intelligence.outlook-com.v1",accountId:"b".repeat(64),exportedAt:"2026-10-01T01:00:00Z",since:"2026-09-30T07:00:00Z",summary:{truncated:true},messages:[]})],"outlook.json",{type:"application/json"});
 await userEvent.upload(screen.getByLabelText("Import local Outlook JSON"),file);expect(await screen.findByText(/reached its message cap/)).toBeInTheDocument();expect(intelligenceApi).not.toHaveBeenCalledWith("/local-outlook/import",expect.anything(),expect.anything());
});
it("creates corrections, exclusions, review decisions and merges through audited endpoints",async()=>{
 render(<DashboardPage/>);await screen.findByRole("button",{name:"View ExampleCo"});
 const create=screen.getByRole("heading",{name:"Add reviewed application"}).closest("form")!;
 fireEvent.change(within(create).getByLabelText("Company"),{target:{value:"NewCo"}});fireEvent.change(within(create).getByLabelText("Role"),{target:{value:"NewRole"}});fireEvent.change(within(create).getByLabelText("Applied date"),{target:{value:"2026-09-30"}});fireEvent.submit(create);await screen.findByText(/Saved/);
 await userEvent.click(screen.getByRole("button",{name:"View ExampleCo"}));await screen.findByText("Evidence subject");const correct=screen.getByRole("heading",{name:"Correct application"}).closest("form")!;fireEvent.submit(correct);await waitFor(()=>expect(intelligenceApi).toHaveBeenCalledWith("/applications/app1","PATCH",expect.objectContaining({company:"ExampleCo"})));
 await userEvent.click(screen.getByRole("button",{name:"View ExampleCo"}));await screen.findByText("Evidence subject");await userEvent.selectOptions(screen.getByLabelText("Merge into"),"app2");await userEvent.selectOptions(screen.getByLabelText("Verified status after merge"),"rejection");await userEvent.click(screen.getByRole("button",{name:"Merge evidence"}));await waitFor(()=>expect(intelligenceApi).toHaveBeenCalledWith("/applications/app1/merge","POST",{targetId:"app2",status:"rejection"}));
 await userEvent.click(screen.getByRole("button",{name:"View ExampleCo"}));await screen.findByText("Evidence subject");await userEvent.click(screen.getByRole("button",{name:"Exclude application"}));await waitFor(()=>expect(intelligenceApi).toHaveBeenCalledWith("/applications/app1","PATCH",{excluded:true}));
 await userEvent.selectOptions(screen.getByLabelText("Canonical application"),"app1");await userEvent.selectOptions(screen.getByLabelText("Verified event"),"screening");await userEvent.click(screen.getByRole("button",{name:"Save decision"}));await waitFor(()=>expect(intelligenceApi).toHaveBeenCalledWith("/review/decision","POST",expect.objectContaining({applicationId:"app1",type:"screening"})));
 await userEvent.click(screen.getByRole("button",{name:"Exclude source"}));await waitFor(()=>expect(intelligenceApi).toHaveBeenCalledWith("/review/decision","POST",expect.objectContaining({exclude:true})));
});
it("requires typed deletion confirmation and submits the explicit destructive intent",async()=>{
 render(<DashboardPage/>);await screen.findByRole("button",{name:"View ExampleCo"});await userEvent.click(screen.getByText("Delete all job data"));await userEvent.type(screen.getByLabelText("Type DELETE ALL JOB DATA"),"DELETE ALL JOB DATA");await userEvent.click(screen.getByRole("button",{name:"Delete permanently"}));await waitFor(()=>expect(intelligenceApi).toHaveBeenCalledWith("/data","DELETE",{confirmation:"DELETE ALL JOB DATA"}));
});
it("shows disconnected and empty states and handles failed actions and connection setup",async()=>{
 view.connections={microsoft:false,localOutlook:false,sheets:false};view.runs=[];view.metrics={total:0};review=[];
 vi.mocked(intelligenceApi).mockImplementation(async(path)=>path==="/dashboard"?view:path==="/review"?[]:path.startsWith("/applications?")?{applications:[],hasMore:false}:Promise.reject(new Error("sheets setup required")));
 render(<DashboardPage/>);await screen.findByText("No outstanding source records.");expect(screen.getByText(/No applications match/)).toBeInTheDocument();await userEvent.click(screen.getByRole("button",{name:"Connect tracker"}));expect(await screen.findByRole("alert")).toHaveTextContent("sheets setup required");expect(screen.queryByRole("button",{name:"Connect Outlook API"})).not.toBeInTheDocument();
});
it("does not retain results after unmount and exposes connection errors without fake data",async()=>{
 let resolve:(value:unknown)=>void=()=>{};vi.mocked(intelligenceApi).mockImplementation(()=>new Promise(done=>{resolve=done;}));const {unmount}=render(<DashboardPage/>);unmount();await act(async()=>resolve(view));
 vi.mocked(intelligenceApi).mockRejectedValue(new Error("owner access required"));render(<DashboardPage/>);expect(await screen.findByRole("alert")).toHaveTextContent("owner access required");expect(screen.getByRole("link",{name:"Sign in to the private API"})).toBeInTheDocument();
});
it("reports a timeline failure and unknown action failures without throwing",async()=>{
 view.runs=[];render(<DashboardPage/>);await screen.findByRole("button",{name:"View ExampleCo"});vi.mocked(intelligenceApi).mockRejectedValue("failure");await userEvent.click(screen.getByRole("button",{name:"View ExampleCo"}));expect(await screen.findByRole("alert")).toHaveTextContent("Timeline unavailable");await userEvent.click(screen.getByRole("button",{name:"Run sync"}));await waitFor(()=>expect(screen.getByRole("alert")).toHaveTextContent("Request failed"));
});
it("shows follow-up recommendations and labels observed and superseded evidence dates",async()=>{
 view.followUps=[{application_id:"app1",company:"ExampleCo",role:"Engineer",due_at:"2026-10-07"}];
 const prior=vi.mocked(intelligenceApi).getMockImplementation()!;
 vi.mocked(intelligenceApi).mockImplementation(async(...args)=>args[0]==="/applications/app1"?{application:app,events:[{id:"old",type:"rejection",occurred_at:"2026-10-01",source:"sheet",date_known:0,superseded:1,web_link:null,available:1,subject:null}],overrides:[]}:prior(...args));
 render(<DashboardPage/>);await screen.findByText(/Due 2026-10-07/);await userEvent.click(screen.getByRole("button",{name:"Review evidence"}));
 expect(await screen.findByText(/observed; event date unknown/)).toHaveTextContent("Superseded");
});
