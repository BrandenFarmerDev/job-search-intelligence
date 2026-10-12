# Gmail routing and organization plan

Prepared October 11, 2026 by GPT-6.1 Sol high. **Owner design choices approved; configuration and provider acceptance pending.** Read with [the handoff](gmail-pivot-handoff.md), [ingestion plan](gmail-ingestion-plan.md), [agent protocol](agent-protocol.md) and existing release agreements. Mailbox operations, exact historical transfer actions, merge, deployment and scheduling retain their documented gates.

## Scope and established decisions

The application will read only `branden.farmer.dev@gmail.com`. Live (`branden_farmer@live.com`) will supply selected incoming job messages through server-side redirect. Existing D1 records, owner authorization, tracker credentials and private recovery evidence remain intact. The Windows uploader stays disabled with maintenance enabled; no COM, cleanup, PIM-profile continuation, Graph activation or second application mailbox reader is proposed. Paid AI remains $0 and application AI stays disabled.

Supported operating path: current Outlook.com and Gmail web interfaces for owner configuration; Gmail API in the existing Cloudflare Worker for ingestion. Provider/browser versions are rolling services, so acceptance records the actual interface/date. This plan introduces no supported Windows migration script. Synthetic test mail uses controlled accounts, inert attachments and unique identifiers, with no real application bodies committed or logged.

## Owner decisions approved October 11, 2026

The owner explicitly approved all six recommendations presented in chat: tagged Live redirect to `branden.farmer.dev+live-jobs@gmail.com` (subject to delivery proof), Gmail for future applications/replies, narrow initial sender/phrase rules, daily acceptance gap review then weekly review, historical gap-only transfer while preserving existing records, and mailbox-wide read-only OAuth with code restricted to labeled job mail. This approves the design choices; it does not establish Google consent, configured rules, an exact historical transfer manifest or release/provider acceptance. JS-03 broader recruiting rules remain disabled initially. Job alerts remain separately retained as already directed in the handoff.

| Decision | Accepted direction | Configuration or acceptance still needed |
| --- | --- | --- |
| Redirect recipient | `branden.farmer.dev+live-jobs@gmail.com`, an address variation of the same Gmail mailbox | Alias/header tests; base-address fallback requires an accepted boundary if tagging fails |
| Future job address and From | Base Gmail for future applications and replies | Signature and active-contact updates; optional `+jobs` use remains a later configuration choice |
| Selection privacy | Narrow exact sender rules plus explicit job phrases; unmatched ambiguous mail remains in Live for owner review | Exact private sender/exception inventory and filter previews; broader JS-03 remains disabled |
| Alerts | Retain in Gmail under Job alerts; exclude only unambiguous alert-only messages from application events | Controlled classification/overlap acceptance |
| Historical scope | Keep existing records; audit and transfer only missing relevant mail from the fixed floor through cutover | Exact end timestamp, source folders, candidate manifest and separately approved transfer method |
| Ongoing gap review | Owner accepted daily Live Inbox/Junk and Gmail Inbox/Spam review during acceptance, then at least weekly | Record actual review outcomes; keyword rules cannot guarantee unattended completeness |

No public document contains the owner's private sender list. Store the eventual exact configuration/export and acceptance manifest outside Git in protected owner storage; commit only rule structure and aggregate outcomes.

## Selective Live redirect

Create rules in Outlook.com **Settings > Mail > Rules**, without starting desktop Outlook. First inspect existing rules and account-wide forwarding, capture their configuration privately, and identify rules that could move/delete/stop processing before the proposed redirects. Resolve each conflict explicitly rather than reordering or disabling unrelated owner rules wholesale. Microsoft documents redirect as retaining the apparent original sender and directing replies to that sender; ordinary forwarding changes that behavior. This does not guarantee unchanged MIME or Message-ID. [Microsoft redirect rules](https://support.microsoft.com/en-us/outlook/mail/use-rules-to-automatically-forward-messages).

Proposed positive rule groups, in this order:

1. **JS-01 known correspondence:** From is one of the individually approved recruiter/ATS addresses. Shared company domains and all of `gmail.com`, `outlook.com`, LinkedIn or other broad multi-purpose domains are not accepted sender allowlists.
2. **JS-02 explicit application/interview/outcome:** subject contains at least one of `application received`, `application submitted`, `thank you for applying`, `your application`, `interview`, `phone screen`, `screening call`, `offer of employment`, `job offer`, `not moving forward`, `not selected`, `position has been filled`.
3. **JS-03 recruiting context:** subject/body contains one of `recruiter`, `recruiting`, `talent acquisition`, `job opportunity`, `career opportunity`, `following up on your application`. This broader group is a privacy tradeoff and remains disabled until its synthetic unrelated-mail cases and owner review pass.
4. **JS-04 selected alerts:** exact approved alert sender plus subject containing one of `job alert`, `jobs for you`, `recommended jobs`, `new jobs`. Broad newsletter domains alone do not qualify. Keep alerts separate in Gmail.

Every positive rule has exactly **Redirect to the accepted Gmail recipient** and **Stop processing more rules**. It has no delete, move, mark-read or source-expiry action. Keep the original Live copy and prove this with a controlled delivered message. Give every redirect rule the same exceptions: exact owner-approved private non-job sender addresses and exact owner Gmail addresses that could create a loop. Do not use broad `password`, `bank`, `salary` or `unsubscribe` exceptions: these can suppress legitimate job correspondence. If the UI combines distinct conditions with AND, implement separate OR branches as separate rules; values within a condition must be tested for OR behavior. The first matching positive rule stops the remaining positive rules, so a message matching several groups is redirected once. Verify that this does not suppress a required existing owner rule. Microsoft's rule-order documentation confirms that Stop processing ignores later rules. [Outlook.com folder/rule behavior](https://support.microsoft.com/en-us/outlook/working-with-message-folders-in-outlook-com).

Do not use “Apply to all messages” or “Run rule now” for this setup. Incoming rules are not the historical migration. Route selection is a best-effort lexical boundary: an unknown recruiter writing only “Hello Branden” can be missed; an unrelated message mentioning an interview can be included. No finite narrow rule list simultaneously guarantees complete recruiter coverage and zero personal-mail transfer. Daily manual Live review, new Gmail use and exact sender additions are the proposed control. A plus tag is an organization marker, not sender authentication; anyone who knows it can mail it.

Before enabling a candidate rule, check both Microsoft mailbox and unified cloud storage headroom. Microsoft states exceeding either can stop incoming delivery; redirect cannot recover bounced mail. Do not clear capacity by deleting mail under this plan. [Outlook.com storage limits](https://support.microsoft.com/en-us/outlook/storage-limits-in-outlook-com).

## Gmail labels and precise filter proposal

Create root **`Job search`** and these exact children: **Application receipts**, **Recruiter follow ups**, **Interviews**, **Offers**, **Rejections**, **Job alerts**, **Review**. The full API names are `Job search/<child>`. Add the root label explicitly to every candidate message: a nested child name must not be assumed to add the parent label. Gmail labels are many-to-many, and thread labels can represent only some messages; subsequent replies do not inherit an earlier message's labels. [Gmail label semantics](https://developers.google.com/workspace/gmail/api/guides/labels) (page updated September 10, 2026).

Use the following logical predicates to generate reviewed Gmail search criteria. These are **specifications with named predicates, not literal paste-ready queries**. Expand every predicate into the actual query, replace private sender placeholders, preview each query, and verify each incoming-message filter with controlled delivery before saving. No filter depends on a previous filter having already applied a label. Gmail supports grouped OR, negation, quoted phrases and `deliveredto:` searches. [Gmail search operators](https://support.google.com/mail/answer/7190?hl=en).

| Predicate | Exact proposed content |
| --- | --- |
| `R` routed candidate | `deliveredto:branden.farmer.dev+live-jobs@gmail.com` after successful header/filter proof |
| `N` new job alias | `deliveredto:branden.farmer.dev+jobs@gmail.com` if owner accepts use and provider forms preserve it |
| `S` approved direct senders | OR of exact privately approved `from:address` values, initially empty |
| `K` direct candidate phrases | OR of the subject phrases in JS-02; optionally JS-03 phrases only after owner approval |
| `E` private exclusions | OR of exact approved non-job sender addresses, initially empty |
| `C` candidate | `(R OR N OR S OR K) AND NOT E`; base-address fallback replaces `R` with accepted evidence from live tests, never `deliveredto:base-Gmail` alone |
| `O` offers | `subject:("offer of employment" OR "job offer" OR "employment offer")` |
| `X` rejections | `subject:("not moving forward" OR "not selected" OR "position has been filled" OR "application unsuccessful")` |
| `I` interviews | `subject:("interview" OR "phone screen" OR "screening call")` |
| `A` application receipts | `subject:("application received" OR "application submitted" OR "thank you for applying")` |
| `F` recruiter follow ups | `subject:("following up on your application" OR "recruiter follow up" OR "recruiter follow-up")` |
| `J` alerts | `(approved exact alert sender) AND subject:("job alert" OR "jobs for you" OR "recommended jobs" OR "new jobs")`; sender set initially empty |

Filter actions only apply labels. One filter for `C` adds `Job search`. Category filters repeat the complete candidate expression, so they work independently. Review wins ambiguous overlaps, avoiding a fabricated lifecycle decision based on filter order:

| Filter match | Label action |
| --- | --- |
| `C AND O AND NOT (X OR I OR A OR F OR J)` | `Job search/Offers` |
| `C AND X AND NOT (O OR I OR A OR F OR J)` | `Job search/Rejections` |
| `C AND I AND NOT (O OR X OR A OR F OR J)` | `Job search/Interviews` |
| `C AND A AND NOT (O OR X OR I OR F OR J)` | `Job search/Application receipts` |
| `C AND F AND NOT (O OR X OR I OR A OR J)` | `Job search/Recruiter follow ups` |
| `C AND J AND NOT (O OR X OR I OR A OR F)` | `Job search/Job alerts` |
| `C AND none of O/X/I/A/F/J`, or `C AND any two or more of O/X/I/A/F/J` | `Job search/Review` |

The overlap expression expands into pairwise predicate intersections. Maintain these criteria together in a private reviewed filter export; this plan does not assume macros, regular expressions, UI rule priority or label-based chaining exist. If a generated expression exceeds accepted UI limits or fails previews, simplify to root plus Review first; defer category automation rather than silently broaden it. Contradictory category labels applied manually must also be treated as Review by the application. Gmail categories are advisory organization; backend evidence classification still determines events and ambiguity.

Unknown means **unknown within selected job candidates**, not every unknown sender in either mailbox. Direct Gmail mail with no accepted alias, sender or phrase is left unlabeled until owner review. Relevant messages found there are individually given both root and Review labels; adding the sender to future filters requires owner review. Gmail filters evaluate incoming replies against their criteria again; a changed subject or recipient may need manual labeling. [Gmail filter behavior](https://support.google.com/mail/answer/6579?hl=en).

Do not archive, delete, mark read, automatically bypass Spam, unsubscribe or forward from Gmail. Keep Inbox visibility during acceptance. A Job alerts label alone does not justify excluding a message that also carries actual application evidence or Review. The ingestion contract must exclude only accepted alert-only cases and retain ambiguous candidates for owner review. Read-only OAuth cannot add labels; labels and native filters are owner-configured in Gmail, and query/label constraints are application policy rather than OAuth permission limits.

## Spam, attachments, identity and outbound messages

Inspect Live Junk in the web interface separately; do not assume Inbox rules process junk or that moving a message to Inbox replays its redirect. Inspect Gmail Spam separately, including routed mail whose filters did not run. Owner-approved relevant recoveries receive root plus Review after individual inspection. The Worker must use an explicitly bounded Spam-inclusive candidate query and exclude Trash; a blanket Spam mailbox body scan is not authorized. `messages.list` supports `includeSpamTrash`, which includes both and therefore needs a separate Trash exclusion. [Gmail listing](https://developers.google.com/workspace/gmail/api/guides/list-messages). Microsoft notes Junk is separate from Inbox; its support pages give differing automatic removal periods, so review daily during cutover rather than depend on a retention promise. [Outlook.com missing-mail guidance](https://support.microsoft.com/en-us/outlook/email-is-missing-from-your-outlook-com-inbox).

Delivery acceptance compares original and redirected synthetic mail: envelope recipient, From, Reply-To, To/Cc, Subject, Date, Internet Message-ID, References/In-Reply-To, multipart bodies, Unicode and attachment count/filename/decoded SHA-256. Check an inert PDF, inline image and calendar invite without automatically accepting or creating an event. Protected mail, blocked attachments, links instead of files and oversized messages are explicit unsupported/incomplete cases requiring owner review; do not claim lossless redirect or download/open unknown content to compensate. Gmail IDs are provider-local; preserve existing canonical records and let the ingestion plan define collision-safe deduplication when redirect changes headers or dates.

Use Gmail's base address as future From and reply identity, and test recipient-side sender/reply routing. Incoming Live rules do not capture outgoing Live replies. During a short owner-selected transition, any necessary Live reply creates a known completeness gap unless separately transferred as approved historical evidence. Manually label each relevant Gmail Sent message with the root and a category/Review; do not assume a labeled thread makes new outgoing messages ingestible. Neither this application nor its OAuth token sends mail.

Do not build dependence on Gmail “Send as Live.” Google's current notice says third-party Send as ends **January 2027** and new configurations may be restricted during Q3–Q4 2026. Forwarded reception remains supported independently. [Google third-party account changes](https://support.google.com/mail/answer/17101213?hl=en) (checked October 11, 2026; notice supplies the rollout dates, not a completed rollout claim).

## Bounded historical transfer, separate from steady ingestion

Default: preserve the 492 stored messages and all associated records; do not recreate history merely to populate Gmail. Inventory source Inbox, Sent, Junk and approved job folders in Outlook.com web for relevant gaps from **`2026-09-30T07:00:00Z` inclusive** through a fixed cutover timestamp. Search one UTC day at a time and reconcile page totals/unique identities before proposing an exact private transfer manifest. Source search may use local dates; validate UTC boundaries against message timestamps rather than trust date-only searches. No source mail is moved/deleted, and older mail is not in scope for import or deletion.

For a small gap, prefer browser **Save as EML** of individually approved messages into protected private storage, preserving MIME, followed by a separately approved temporary migration tool with `gmail.insert` authorization calling `messages.import` into the same Gmail mailbox. The steady Worker token remains `gmail.readonly`; do not add import scope to it. Import is a mailbox write that requires explicit approval and synthetic date/identity/attachment proof first. Google's import endpoint accepts MIME without sending and supports `internalDateSource`; configure Date-header dating only for validated dates, disable calendar processing and retain normal spam handling. [Microsoft Save as EML](https://support.microsoft.com/en-us/outlook/mail/save-an-outlook-message-as-a-eml-file-a-pdf-file-or-as-a-draft), [Gmail message import](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/import).

Proposed transfer caps: pilot 5 synthetic messages, then at most 20 approved real candidates and 25 MiB per owner-run batch; stop on the first identity/date/attachment mismatch, unknown import outcome or missing manifest entry. Check destination identity before retrying a timed-out import. Record protected original hashes, UTC timestamps, Gmail IDs and reconciliation results; never log message text. Release the temporary write credential after accepted migration. Large messages or larger gaps need a new bounded plan, not silent cap increases.

The transfer manifest must also preserve original semantic direction (`received` or `sent`), original mailbox/folder and validated source timestamp, bound to the resulting Gmail message ID and original MIME hash. A Live Sent message retains `From: ...@live.com`; importing it into Gmail must **not** be assumed to produce Gmail's native `SENT` label. Historical Sent transfer remains blocked until the reader supports separately approved, validated direction provenance (for example an owner-reviewed manifest mapping, with its protected storage/import contract) and proves sent-time classification, deduplication and no fabricated received event. Do not rewrite From, Date or delivery state to manufacture Gmail SENT. This is additional migration implementation scope to settle with the ingestion plan, not a property of the read-only runtime token.

For a large gap, a separately approved copy-only OAuth IMAP migration client is a possible future option, but credentials, cross-provider support, stable identities and copy-not-move semantics are unverified; it is not an application fallback and is not selected here. Avoid Gmail POP/Gmailify as the migration design: Google's notice says no new POP users after Q1 2026 and existing support ends January 2027. One-time import remains documented, but other Google guidance says Outlook cannot be added on the computer because of modern authentication requirements; neither proves a bounded exact-item Outlook transfer. [POP/Gmailify transition](https://support.google.com/mail/answer/16604719?hl=en), [Google account/import limitations](https://support.google.com/mail/answer/21289?hl=en).

## Provider acceptance matrix

Every row is **unverified**. Record only redacted outcomes/aggregate counts in Git; private MIME/header comparisons and exact identities stay protected. Mock/coverage success does not complete these rows.

| Controlled case | Observable pass criterion |
| --- | --- |
| Known sender + each positive phrase group | One Gmail delivery, Live copy retained, expected root and category/Review labels |
| Unknown recruiter with job phrase; unknown with only “Hello” | First reaches Review; second is intentionally missed by narrow routing and recovered through documented owner review |
| Unrelated personal/security/financial mail with no positive predicate | Controlled negatives remain in Live and outside ingestion; unexpected matches are diagnosed before acceptance |
| Unrelated mail deliberately containing an accepted job phrase | Lexical collision is expected to route and may receive a suggested category; owner labels it Review, excludes any application candidate and refines future rules where possible, without claiming zero personal-mail transfer |
| Multiple Live positive groups | Exactly one redirect, no required existing owner rule suppressed |
| PC powered off, desktop Outlook closed | Controlled Live delivery reaches Gmail and labels within a proposed 15-minute observation window; timeout is a failure to diagnose, not proof it is lost |
| Direct Gmail, optional tagged address, Bcc/alias recipient | Accepted recipient/header boundary labels correctly; failure blocks reliance on that boundary |
| Gmail reply, changed subject and separate Sent message | Root inclusion checked per message; unrelated messages in same thread remain outside application reads |
| Alert only; alert plus actual outcome; two lifecycle predicates | Alert retained without application event; overlap reaches Review and is not blanket-excluded |
| Live Junk and Gmail Spam | Daily owner review finds controlled recoverable cases; bounded approved Gmail Spam query works; no blanket bypass; known coverage gaps recorded |
| MIME and attachment variants | Required fields, decoded attachment hashes and original sender/reply behavior verified; incomplete/protected cases explicitly held |
| Historical pilot and floor boundaries, including Live Sent | Pre-floor ignored, exact-floor included, fixed end respected; manifest-bound direction remains sent even without Gmail SENT; replay produces no duplicate application/event; originals unchanged |
| Wrong recipient, loop exception and disabled candidate rule | No loop or cross-account ingestion; disabling rule stops only future routing and retains originals |
| D1 baseline and replay | Existing records/associations/decisions preserved; expected additive changes reconciled; unchanged replay leaves counts and events unchanged |

Accept routing only after owner choices, controlled live matrix and ingestion/token/failure acceptance all pass. Enable the Gmail schedule only through the separate release checklist and authorization. After accepted Gmail cutover, retire legacy entry points/task credentials without removing unrelated Sheets access or encrypted recovery evidence. Until then, Windows remains paused and no dual-provider import runs.
