# Agent execution protocol

The owner updated this protocol on October 11, 2026. It applies to planning, implementation, QA and CI troubleshooting in this repository.

## Roles and evidence

- Planning and validating QA use GPT-6.1 Sol high or GPT-5.6 Sol high, with the same selected model for both roles in a task. GPT-6.1 Sol high is the default. QA reviews independently and reports concrete defects, reproduction evidence and unresolved acceptance limits.
- Implementation uses a faster, cost-effective capable model, normally GPT-6 Luna medium, to follow the approved plan and acceptance criteria. Escalate a difficult diagnosis to high-reasoning QA instead of repeating speculative implementations.
- Plans state the supported platforms/runtime versions, observable acceptance criteria, test matrix, privacy boundaries and release/owner-action gates. Preserve existing approved scope; do not restart planning for a routine correction.
- Synthetic behavior, native platform checks, hosted CI and real provider acceptance are distinct evidence. Reproduce the failing launch command and scope: direct PowerShell `-File` can behave differently from `-Command` or a wrapper invoking `&`. Changing an environment variable on Windows does not reproduce Linux or another PowerShell version. Failed or unmeasured checks remain explicit.

## Bounded implementation and validation

1. Agree ownership and the smallest relevant change. Capture a failing behavior before fixing it when feasible. Keep test data synthetic and isolated.
2. Run targeted checks on the changed behavior. For platform-sensitive changes, use the actual supported runtime/platform or capture a diagnostic from the actual CI runner. Preserve Windows-only security checks while injecting synthetic dependencies in portable fixtures.
3. Obtain independent high-reasoning QA on the patch and its evidence. Freeze source before the final gate. QA must not silently edit the implementation it is validating.
4. Run the required `npm run quality` gate and relevant native-platform checks, then verify hosted checks on the exact published commit. Keep every existing threshold; no broad harness skips, coverage exclusions or weaker assertions to turn a failure green.
5. Once relevant checks pass and QA findings are resolved, publish the concise handoff and stop repeating checks. Repeat only for a new change, a failure or a concrete unresolved concern. Documentation-only result recording does not require rerunning unrelated behavior suites.

## CI failure protocol

- On the first failure, record the exact commit/job link, failing command, error/call stack, runtime version and platform. Identify the owner of the failure and the specific boundary involved before making a patch.
- If the same failure recurs, stop speculative patches and full-gate reruns. Assign GPT-6.1 Sol high or GPT-5.6 Sol high QA to reproduce or diagnose it in the failing environment. Use one focused diagnostic run if the existing logs lack the required stack; diagnostics must not expose secrets or owner data.
- State the supported root cause and the minimal correction. Test that correction directly, then perform one final quality/coverage pass and exact-commit hosted verification. Another failure is new evidence requiring diagnosis, not permission to retry unchanged or lower a gate.
- Avoid overlapping full test runs and busy polling. Preserve failed logs outside Git. Do not treat exit zero, a passing mock or an earlier commit's CI as provider/release acceptance.

Merge, deployment, installed-client release and exact mailbox actions retain their documented authorization and acceptance gates. This protocol does not enable Graph, application AI or server cron.
