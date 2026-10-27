------------------------- MODULE SocketDisposal -------------------------
EXTENDS Naturals
CONSTANTS Path, InitialRaw, EventFailure, Reentry, Fault,
 FairLocal, FairRecovery, FairRetry
VARIABLE s
vars == <<s>>
InitiallyAccepted == (Path = "renewal") /\ (InitialRaw \in {"none", "hold"})
Init == s = [begun |-> FALSE, disposed |-> FALSE, localRetired |-> FALSE,
 rawRetired |-> Path = "renewal", rawAccepted |-> InitiallyAccepted,
 clientAccepted |-> InitiallyAccepted, owner |-> TRUE, stage |-> "idle",
 rawState |-> IF Path # "renewal" \/ InitialRaw = "before" THEN "open"
   ELSE IF InitialRaw = "hold" THEN "closing" ELSE "closed",
 rawAttempts |-> IF Path = "renewal" THEN 1 ELSE 0,
 rawSuccess |-> IF InitiallyAccepted THEN 1 ELSE 0,
 eventAccepted |-> FALSE, eventAttempts |-> 0, eventSuccess |-> 0,
 attempted |-> FALSE, skipped |-> FALSE, recovered |-> FALSE,
 retried |-> FALSE, firstReturned |-> FALSE, returned |-> FALSE,
 completed |-> FALSE, allocated |-> FALSE, reported |-> FALSE]
Begin == /\ ~s.begun
 /\ s' = [s EXCEPT !.begun = TRUE, !.rawRetired = TRUE,
   !.disposed = Path = "shutdown", !.localRetired = Fault # "event-first",
   !.stage = IF Fault = "event-first" THEN "event" ELSE "raw-enter"]
RawEnter == /\ s.stage = "raw-enter"
 /\ LET skip == (Fault = "skip-retry") /\ (s.retried \/ Path = "renewal") /\ ~s.rawAccepted
        attempt == (~s.rawAccepted \/ Fault = "repeat-success") /\ ~skip
     IN s' = [s EXCEPT !.attempted = attempt, !.skipped = skip,
       !.rawAttempts = IF attempt THEN @ + 1 ELSE @, !.stage = "callback"]
Callback == /\ s.stage = "callback"
 /\ LET dispose == s.attempted /\ Reentry = "dispose"
     IN s' = [s EXCEPT !.disposed = @ \/ dispose,
       !.localRetired = @ \/ dispose,
       !.owner = IF dispose /\ Fault = "early-parent" THEN FALSE ELSE @,
       !.stage = "raw-return"]
RawReturn == /\ s.stage = "raw-return"
 /\ LET failed == s.attempted /\ ~s.recovered /\ InitialRaw \in {"before", "after"}
        accepted == s.rawAccepted \/ (s.attempted /\ ~failed)
        exposed == accepted \/ s.skipped
     IN s' = [s EXCEPT !.rawAccepted = accepted, !.clientAccepted = exposed,
       !.rawSuccess = IF s.attempted /\ ~failed THEN @ + 1 ELSE @,
       !.rawState = IF ~s.attempted THEN @ ELSE IF InitialRaw = "hold" THEN "closing"
         ELSE IF failed /\ InitialRaw = "before" THEN "open" ELSE "closed",
       !.owner = IF exposed \/ Fault = "forget-failure" THEN FALSE ELSE @,
       !.stage = IF (Path = "shutdown" \/ s.disposed) /\ Fault # "skip-event" THEN "event"
         ELSE IF Path = "renewal" THEN "admit" ELSE "report"]
Event == /\ s.stage = "event"
 /\ LET attempt == ~s.eventAccepted \/ Fault = "repeat-success"
        failed == attempt /\ EventFailure /\ ~s.recovered
     IN s' = [s EXCEPT !.eventAttempts = IF attempt THEN @ + 1 ELSE @,
       !.eventSuccess = IF attempt /\ ~failed THEN @ + 1 ELSE @,
       !.eventAccepted = @ \/ (attempt /\ ~failed),
       !.stage = IF Path = "renewal" THEN "admit" ELSE "report"]
Admit == /\ s.stage = "admit"
 /\ s' = [s EXCEPT !.allocated = @ \/ ((~s.disposed /\ s.clientAccepted)
     \/ Fault = "bypass-barrier" \/ (s.clientAccepted /\ Fault = "skip-disposed")),
   !.stage = "report"]
Report == /\ s.stage = "report"
 /\ s' = [s EXCEPT !.firstReturned = TRUE, !.returned = TRUE, !.completed = TRUE,
   !.reported = (~s.rawAccepted \/ (s.disposed /\ ~s.eventAccepted)) /\ Fault # "swallow",
   !.stage = "idle"]
Heal == /\ s.begun /\ ~s.recovered /\ s' = [s EXCEPT !.recovered = TRUE]
Retry == /\ s.firstReturned /\ s.stage = "idle" /\ s.recovered /\ ~s.retried
 /\ s' = [s EXCEPT !.retried = TRUE, !.returned = FALSE,
   !.completed = FALSE, !.stage = "raw-enter"]
Next == Begin \/ RawEnter \/ Callback \/ RawReturn \/ Event \/ Admit \/ Report \/ Heal \/ Retry
Spec == Init /\ [][Next]_vars
 /\ (IF FairLocal THEN WF_vars(Begin) /\ WF_vars(RawEnter) /\ WF_vars(Callback)
      /\ WF_vars(RawReturn) /\ WF_vars(Event) /\ WF_vars(Admit) /\ WF_vars(Report) ELSE TRUE)
 /\ (IF FairRecovery THEN WF_vars(Heal) ELSE TRUE)
 /\ (IF FairRetry THEN WF_vars(Retry) ELSE TRUE)
TypeOK == /\ s.rawAttempts \in 0..3 /\ s.eventAttempts \in 0..2
 /\ s.rawState \in {"open", "closing", "closed"}
 /\ s.stage \in {"idle", "raw-enter", "callback", "raw-return", "event", "admit", "report"}
AcceptanceHonest == s.clientAccepted => s.rawAccepted
DebtConserved == (s.rawRetired /\ ~s.rawAccepted) => s.owner
LocalRetirement == s.disposed => s.localRetired
AllocationSafe == s.allocated => (s.rawAccepted /\ ~s.disposed)
SuccessOnce == s.rawSuccess <= 1 /\ s.eventSuccess <= 1
BothAttempted == (s.completed /\ s.disposed) => (s.rawAttempts >= 1 /\ s.eventAttempts >= 1)
HonestFailure == (s.completed /\ Path = "shutdown") => s.reported = (~s.rawAccepted \/ ~s.eventAccepted)
CallerProgress == (s.begun ~> s.firstReturned) /\ (s.retried ~> s.returned)
CleanupProgress == (s.begun /\ s.disposed) ~> (s.rawAccepted /\ s.eventAccepted)
FreshProgress == (s.begun /\ Path = "renewal") ~>
 (s.allocated \/ (s.disposed /\ s.rawAccepted /\ s.eventAccepted))
=============================================================================
