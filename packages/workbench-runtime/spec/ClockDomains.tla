------------------------- MODULE ClockDomains -------------------------
EXTENDS Integers
CONSTANTS WallAsBudget, ShiftDirection
VARIABLE s
vars == <<s>>
Budget == 2
Init == s = [elapsed |-> 0, wall |-> 0, checked |-> 0,
  remaining |-> Budget, deadline |-> Budget, shifted |-> FALSE, finished |-> FALSE]
Advance == /\ ~s.finished /\ s.elapsed < 3
  /\ s' = [s EXCEPT !.elapsed = @ + 1, !.wall = IF @ < 3 THEN @ + 1 ELSE @]
Shift == /\ ~s.finished /\ ~s.shifted
  /\ \E value \in (CASE ShiftDirection = "backward" -> {-3}
      [] ShiftDirection = "forward" -> {3} [] OTHER -> {-3, 3}) :
    s' = [s EXCEPT !.wall = value, !.shifted = TRUE]
\* Replacing an active preparation timer must keep its elapsed cap.
\* Explicit preparation completion returning to a shorter normal timeout is
\* outside this fixed-cap abstraction. Wall timestamps remain diagnostic.
Rearm == /\ ~s.finished
  /\ LET time == IF WallAsBudget THEN s.wall ELSE s.elapsed
         remaining == IF time < Budget THEN Budget - time ELSE 0
     IN s' = [s EXCEPT !.remaining = remaining, !.checked = s.elapsed,
       !.deadline = s.elapsed + remaining]
Timeout == /\ ~s.finished /\ s.elapsed >= s.deadline
  /\ s' = [s EXCEPT !.finished = TRUE]
Next == Advance \/ Shift \/ Rearm \/ Timeout
SafetySpec == Init /\ [][Next]_vars
FairSpec == SafetySpec /\ WF_vars(Advance) /\ WF_vars(Timeout)
TypeOK == /\ s.elapsed \in 0..3 /\ s.wall \in -3..3 /\ s.checked \in 0..3
  /\ s.remaining \in 0..5 /\ s.deadline \in 0..8
  /\ s.shifted \in BOOLEAN /\ s.finished \in BOOLEAN
NoExtension == s.checked < Budget => s.checked + s.remaining <= Budget
NoEarly == s.checked < Budget => s.checked + s.remaining >= Budget
ExpiredDue == s.checked >= Budget => s.remaining = 0
TimeoutNotEarly == s.finished => s.elapsed >= Budget
BudgetTermination == <>s.finished
=============================================================================
